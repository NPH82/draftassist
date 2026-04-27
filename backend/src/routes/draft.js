/**
 * Draft routes
 * Live draft state, recommendations, queue, and trade suggestions during draft.
 */

const express = require('express');
const router = express.Router();

const sleeperService = require('../services/sleeperService');
const { requireAuth } = require('../middleware/auth');
const { detectValueGap, calcPersonalRankScore } = require('../services/scoringEngine');
const { predictAvailability, detectFallers } = require('../services/availabilityPredictor');
const { suggestTradeUp, suggestTradeDown, fpPickValue } = require('../services/tradeEngine');
const { enrichProfilesWithDraftClass } = require('../services/learningEngine');
const { analyzePositionalNeeds, buildRosterComposition, scoreDraftFit } = require('../services/winWindowService');
const Player = require('../models/Player');
const Draft = require('../models/Draft');
const League = require('../models/League');
const ManagerProfile = require('../models/ManagerProfile');

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function isRookieDraftContext(draftData = {}, league = {}) {
  const rounds = draftData.settings?.rounds || 0;
  const teams = draftData.settings?.teams || league.totalRosters || 12;
  if (rounds > 0 && rounds < teams) return true;

  const text = [draftData.metadata?.name, draftData.metadata?.description, league.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /rookie|devy/.test(text);
}

async function resolveDraftClassYear({ requestedYear, draftData, league }) {
  const currentYear = new Date().getFullYear();
  const explicit = toInt(requestedYear);
  if (explicit) return explicit;

  let season = toInt(draftData?.season) || toInt(league?.season) || currentYear;

  // Sleeper can still report previous season for offseason rookie drafts.
  if (season < currentYear) {
    const hasCurrentClass = await Player.exists({ nflDraftYear: currentYear });
    if (hasCurrentClass) season = currentYear;
  }

  return season;
}

function playerValueSignal(player) {
  if (player.ktcValue) return player.ktcValue;
  if (player.fantasyProsRank) return Math.max(0, 12000 - (player.fantasyProsRank * 120));
  return 0;
}

function buildTeamContext(players = []) {
  const ctx = {};

  for (const p of players) {
    if (!p.team || !p.position) continue;
    if (!ctx[p.team]) {
      ctx[p.team] = {
        rbValue: 0,
        wrTeValue: 0,
        totalSkillValue: 0,
        elitePassCatchers: 0,
      };
    }

    const value = playerValueSignal(p);
    if (p.position === 'RB') ctx[p.team].rbValue += value;
    if (p.position === 'WR' || p.position === 'TE') ctx[p.team].wrTeValue += value;
    if (['RB', 'WR', 'TE', 'QB'].includes(p.position)) ctx[p.team].totalSkillValue += value;

    const isElitePassCatcher = (p.position === 'WR' || p.position === 'TE') &&
      ((p.ktcValue || 0) >= 5000 || ((p.fantasyProsRank || 9999) <= 36));
    if (isElitePassCatcher) ctx[p.team].elitePassCatchers += 1;
  }

  for (const team of Object.keys(ctx)) {
    const t = ctx[team];
    t.passHeavy = t.wrTeValue > t.rbValue * 1.25;
    t.runHeavy = t.rbValue > t.wrTeValue * 1.1;
    if (t.totalSkillValue >= 24000) t.offenseTier = 'high';
    else if (t.totalSkillValue <= 9000) t.offenseTier = 'low';
    else t.offenseTier = 'neutral';
  }

  return ctx;
}

function marketRankSignal(player = {}, fallbackRank = 999) {
  const adp = Number(player.underdogAdp || 0);
  const fp = Number(player.fantasyProsRank || 0);
  if (adp > 0) return adp;
  // For devy/rookie players without ADP data, FP rank alone can be overoptimistic.
  // Use personal rank as a floor (pessimistic signal) — if user ranks a player later
  // than FP consensus, that's real signal that the player doesn't need to be reached for.
  if (fp > 0) {
    const personal = Number(player.personalRank || 0);
    return personal > fp ? Math.round((fp + personal) / 2) : fp;
  }
  return fallbackRank;
}

function estimateTradeTargetPick(player = {}, { myNextPickNumber, totalRosters = 12, isRookieDraft = false }) {
  const signals = [];
  const adp = Number(player.underdogAdp || 0);
  const fp = Number(player.fantasyProsRank || 0);
  const personal = Number(player.personalRank || 0);
  const ktc = Number(player.ktcRank || 0);

  if (adp > 0) signals.push(adp);
  if (fp > 0) signals.push(fp);
  if (personal > 0) signals.push(personal);
  if (ktc > 0) signals.push(ktc);

  // Rookie/devy boards often let "name" players slide later than pure FP rank,
  // especially when no Underdog ADP is available.
  if (isRookieDraft && adp <= 0 && fp > 0) {
    const drift = Math.max(3, Math.round(totalRosters * 0.35));
    signals.push(fp + drift);
  }

  if (!signals.length) return myNextPickNumber;
  const sorted = signals.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  return Math.max(1, Math.round(median));
}

function reachPenaltyFromMarket({ player, currentPick, needTier = 'low', availabilityProb = null, reachDiscipline = 1, fallbackRank = 999 }) {
  const marketRank = marketRankSignal(player, fallbackRank);
  const gap = marketRank - currentPick; // positive means likely available later
  // Top-6 picks: even 1 pick of gap is meaningful — that's real draft capital.
  // Picks 7-12: allow 2 pick buffer. Later: 4 pick buffer.
  const topPick = currentPick <= 6;
  const earlyPick = currentPick <= 12;
  const threshold = topPick ? 1 : earlyPick ? 2 : 4;
  if (gap <= threshold) return { penalty: 0, marketRank, gap };

  let penalty = Math.min(earlyPick ? 34 : 24, (gap - threshold) * (earlyPick ? 2.05 : 1.35));

  // Preserve need-based flexibility.
  if (needTier === 'high') penalty *= 0.55;
  else if (needTier === 'medium') penalty *= 0.8;

  // If model already thinks player survives, penalize reaches more.
  if (availabilityProb != null) {
    if (availabilityProb >= 0.72) penalty *= 1.22;
    else if (availabilityProb >= 0.55) penalty *= 1.08;
  }

  penalty *= Math.max(0.8, Math.min(1.6, reachDiscipline || 1));
  return { penalty: Math.round(penalty * 100) / 100, marketRank, gap };
}

/**
 * Find managers whose next pick falls in the "safe window" between the user's current pick
 * and the expected market pick number of the target player.  These managers can be traded
 * WITH (give them your earlier pick, receive their later pick + assets) so you still land
 * the target while gaining draft capital.
 *
 * @param {object[]} rosters        - All league rosters (excluding user's)
 * @param {object}   draftOrder     - Sleeper draft_order map { sleeperId -> slotNumber }
 * @param {number}   currentPick    - Current overall pick number
 * @param {number}   safeUntilPick  - Last pick number where target is still expected available
 * @param {number}   totalRosters   - Teams in the league
 * @returns {Array<{ownerId, username, nextPick}>}
 */
function findTradeBackPartners({ rosters, draftOrder, currentPick, safeUntilPick, totalRosters }) {
  // Invert draft_order: slotNumber -> sleeperId
  const slotToOwner = {};
  for (const [ownerId, slot] of Object.entries(draftOrder || {})) {
    slotToOwner[slot] = ownerId;
  }

  // Determine the slot that picks next after currentPick
  const currentSlot = ((currentPick - 1) % totalRosters) + 1;

  const partners = [];
  for (let pickNum = currentPick + 1; pickNum <= safeUntilPick; pickNum++) {
    const slot = ((pickNum - 1) % totalRosters) + 1;
    const ownerId = slotToOwner[slot];
    if (!ownerId) continue;
    const roster = rosters.find(r => r.ownerId === ownerId);
    if (!roster) continue;
    // Avoid duplicates (same manager can have multiple picks in range for multi-round drafts)
    if (partners.some(p => p.ownerId === ownerId)) continue;
    partners.push({
      ownerId,
      username: roster.ownerUsername || roster.ownerName || ownerId,
      nextPick: pickNum,
      picksBackFromUs: pickNum - currentPick,
    });
  }

  return partners;
}

async function estimateReachDiscipline(profile) {
  const feedback = Array.isArray(profile?.targetFeedback) ? profile.targetFeedback : [];
  const samples = feedback
    .filter(f => f && f.agreed === false && f.recommendedPlayerId && f.preferredPlayerId)
    .slice(-30);

  if (samples.length < 4) return 1;

  const ids = new Set();
  for (const s of samples) {
    ids.add(String(s.recommendedPlayerId));
    ids.add(String(s.preferredPlayerId));
  }

  const idList = [...ids];
  const objectIds = idList.filter(id => /^[a-f\d]{24}$/i.test(id));
  const playerDocs = await Player.find({
    $or: [
      { sleeperId: { $in: idList } },
      ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ],
  })
    .select('_id sleeperId underdogAdp fantasyProsRank dasScore')
    .lean();

  const byAnyId = {};
  for (const p of playerDocs) {
    byAnyId[String(p._id)] = p;
    if (p.sleeperId) byAnyId[String(p.sleeperId)] = p;
  }

  let preferenceForMarket = 0;
  let valid = 0;

  for (const s of samples) {
    const rec = byAnyId[String(s.recommendedPlayerId)];
    const pref = byAnyId[String(s.preferredPlayerId)];
    if (!rec || !pref) continue;
    const recRank = marketRankSignal(rec, rec.dasScore ? 200 - (rec.dasScore / 2) : 999);
    const prefRank = marketRankSignal(pref, pref.dasScore ? 200 - (pref.dasScore / 2) : 999);
    valid += 1;
    if (prefRank + 4 < recRank) preferenceForMarket += 1;
  }

  if (!valid) return 1;
  const ratio = preferenceForMarket / valid;
  return 1 + (ratio * 0.5); // 1.0 to 1.5
}

// GET /api/draft/active -- list active drafts for user, sorted by next pick time
router.get('/active', requireAuth, async (req, res) => {
  try {
    const { sleeperId } = req.user;

    // Get user's leagues
    const leagues = await League.find({ 'rosters.ownerId': sleeperId }).lean();
    const activeDrafts = [];

    for (const league of leagues) {
      if (!league.draftId) continue;
      // 32-team leagues: skip draft recommendations entirely
      if ((league.totalRosters || 0) >= 32) continue;
      try {
        const draftData = await sleeperService.getDraft(league.draftId);
        if (draftData.status !== 'drafting') continue;

        const myRoster = league.rosters.find(r => r.ownerId === sleeperId);
        const myPickSlot = draftData.draft_order?.[sleeperId];

        // Compute next pick for the user
        const picksMade = draftData.picks?.length || 0;
        const totalRosters = draftData.settings?.teams || 12;
        let nextPickNumber = null;

        if (myPickSlot) {
          // Linear draft: next pick = when it cycles back to my slot
          const currentSlot = (picksMade % totalRosters) + 1;
          const picksUntilMe = myPickSlot >= currentSlot
            ? myPickSlot - currentSlot
            : totalRosters - currentSlot + myPickSlot;
          nextPickNumber = picksMade + picksUntilMe + 1;
        }

        // Seconds per pick for eta
        const secondsPerPick = draftData.settings?.pick_timer || 60;
        const eta = nextPickNumber ? new Date(Date.now() + (nextPickNumber - picksMade - 1) * secondsPerPick * 1000) : null;

        activeDrafts.push({
          draftId: league.draftId,
          leagueId: league.sleeperId,
          leagueName: league.name,
          status: draftData.status,
          currentPick: picksMade + 1,
          myNextPick: nextPickNumber,
          etaMs: eta?.getTime() || null,
          totalRosters,
          rounds: draftData.settings?.rounds || 5,
          myPickSlot,
          onTheClock: (picksMade % totalRosters) + 1 === myPickSlot,
        });
      } catch { /* skip unavailable drafts */ }
    }

    // Sort: on-the-clock first, then by soonest ETA
    activeDrafts.sort((a, b) => {
      if (a.onTheClock && !b.onTheClock) return -1;
      if (!a.onTheClock && b.onTheClock) return 1;
      if (a.etaMs && b.etaMs) return a.etaMs - b.etaMs;
      return (a.leagueName || '').localeCompare(b.leagueName || '');
    });

    res.json({ drafts: activeDrafts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/draft/:draftId -- full live draft state with recommendations
router.get('/:draftId', requireAuth, async (req, res) => {
  try {
    const { draftId } = req.params;
    const { sleeperId } = req.user;
    const mode = req.query.mode || 'team_need'; // 'team_need' | 'bpa'

    // Get live picks from Sleeper
    const [draftData, picks, league] = await Promise.all([
      sleeperService.getDraft(draftId),
      sleeperService.getDraftPicks(draftId),
      League.findOne({ draftId }).lean(),
    ]);

    const draftedIds = new Set(picks.map(p => p.player_id).filter(Boolean));
    const totalRosters = draftData.settings?.teams || 12;

    // No recommendations for 32-team leagues — return board-only state
    if (totalRosters >= 32) {
      return res.json({
        draftId,
        status: draftData.status,
        totalRosters,
        noRecommendations: true,
        noRecommendationsReason: '32-team leagues are not supported for draft recommendations',
        picks: picks.slice(-20),
      });
    }

    const myPickSlot = draftData.draft_order?.[sleeperId];
    const picksMade = picks.length;
    const currentOverallPick = picksMade + 1;

    // My next pick
    const picksUntilMe = myPickSlot
      ? (() => {
          const currentSlot = (picksMade % totalRosters) + 1;
          return myPickSlot >= currentSlot
            ? myPickSlot - currentSlot
            : totalRosters - currentSlot + myPickSlot;
        })()
      : 999;
    const myNextPickNumber = picksMade + picksUntilMe + 1;

    // Load players — rookie/devy drafts should only show one class year.
    const isRookieDraft = isRookieDraftContext(draftData, league || {});
    const draftSeason = isRookieDraft
      ? await resolveDraftClassYear({ requestedYear: req.query.classYear, draftData, league: league || {} })
      : null;
    const playerFilter = isRookieDraft ? { nflDraftYear: draftSeason } : {};
    const allPlayers = await Player.find(playerFilter).sort({ personalRank: 1, dasScore: -1 }).lean();
    const teamContextPlayers = await Player.find({ position: { $in: ['QB', 'RB', 'WR', 'TE'] } })
      .select('team position ktcValue fantasyProsRank')
      .lean();
    const teamContext = buildTeamContext(teamContextPlayers);
    const availablePlayers = allPlayers
      .filter(p => !p.sleeperId || !draftedIds.has(p.sleeperId))
      .map((p, i) => ({ ...p, dasRank: i + 1, valueGap: detectValueGap(p) }));

    // Get my roster from league
    const myRoster = league?.rosters.find(r => r.ownerId === sleeperId);

    const rosterPoolIds = myRoster?.allPlayerIds || myRoster?.playerIds || [];

    const rosterPlayerDocs = await Player.find({ sleeperId: { $in: rosterPoolIds } })
      .select('sleeperId position age isPassCatcher depthChartPosition ktcValue fantasyProsRank nflDraftRound')
      .lean();
    const rosterPlayerMap = Object.fromEntries(rosterPlayerDocs.map(p => [p.sleeperId, p]));

    let sleeperPlayerMap = {};
    try {
      sleeperPlayerMap = await sleeperService.getAllPlayers('nfl');
    } catch (e) {
      console.warn('[Draft] Sleeper fallback map unavailable:', e.message);
    }
    for (const id of rosterPoolIds) {
      if (rosterPlayerMap[id]) continue;
      const sp = sleeperPlayerMap[id];
      if (!sp || !['QB', 'RB', 'WR', 'TE'].includes(sp.position)) continue;
      rosterPlayerMap[id] = {
        sleeperId: id,
        position: sp.position,
        age: sp.age || null,
      };
    }

    const rosterComposition = buildRosterComposition(
      rosterPoolIds,
      rosterPlayerMap,
      league?.rosterPositions || [],
      league?.scoringSettings || {}
    );
    const positionalNeeds = analyzePositionalNeeds(
      rosterPoolIds,
      rosterPlayerMap,
      league?.rosterPositions || [],
      league?.scoringSettings || {}
    );

    // Learn from past agree/disagree feedback to tune reach aversion.
    const myProfile = await ManagerProfile.findOne({ sleeperId }).lean();
    const reachDiscipline = await estimateReachDiscipline(myProfile);

    // Availability context used for reach-aware sorting.
    const remainingRosters = league?.rosters
      .filter(r => r.ownerId !== sleeperId)
      .map(r => ({ ...r, nextPickNumber: myNextPickNumber - picksUntilMe })) || [];

    const availabilitySeed = await predictAvailability(
      availablePlayers.slice(0, 120), myNextPickNumber, currentOverallPick, remainingRosters
    );
    const availabilityMap = Object.fromEntries(
      availabilitySeed.map(p => [String(p.sleeperId || p._id), p.availabilityProb])
    );

    // Sort by recommendation mode
    let recommended;
    if (mode === 'bpa') {
      recommended = availablePlayers.slice().map((p) => {
        const key = String(p.sleeperId || p._id);
        const availabilityProb = availabilityMap[key] ?? null;
        const fallbackRank = p.dasRank || 999;
        const { penalty, marketRank, gap } = reachPenaltyFromMarket({
          player: p,
          currentPick: currentOverallPick,
          needTier: positionalNeeds[p.position] || 'low',
          availabilityProb,
          reachDiscipline,
          fallbackRank,
        });
        const personal = calcPersonalRankScore(p.personalRank);
        const base = personal != null ? (p.dasScore || 0) * 0.4 + personal * 0.6 : (p.dasScore || 0);
        const fit = scoreDraftFit(p, rosterComposition, teamContext);
        const needBonus = (positionalNeeds[p.position] || 'low') === 'high'
          ? 12
          : (positionalNeeds[p.position] || 'low') === 'medium' ? 5 : 0;
        const recScore = base + fit + needBonus - penalty;
        // Gap threshold to flag trade-back: tighter at premium picks.
        const tbGapThreshold = currentOverallPick <= 6 ? 3 : currentOverallPick <= 12 ? 5 : 8;
        return {
          ...p,
          availabilityProb,
          marketRank,
          marketReachGap: gap,
          reachPenalty: penalty,
          recScore,
          tradeBackCandidate: gap >= tbGapThreshold && (availabilityProb == null || availabilityProb >= 0.5),
        };
      }).sort((a, b) => (b.recScore || 0) - (a.recScore || 0));
    } else {
      // Team need: sort by positional need, then DAS
      const needOrder = { high: 0, medium: 1, low: 2 };
      recommended = availablePlayers.slice().map((p) => {
        const needTier = positionalNeeds[p.position] || 'low';
        const key = String(p.sleeperId || p._id);
        const availabilityProb = availabilityMap[key] ?? null;
        const fallbackRank = p.dasRank || 999;
        const { penalty, marketRank, gap } = reachPenaltyFromMarket({
          player: p,
          currentPick: currentOverallPick,
          needTier,
          availabilityProb,
          reachDiscipline,
          fallbackRank,
        });
        const personal = calcPersonalRankScore(p.personalRank);
        const base = personal != null ? (p.dasScore || 0) * 0.4 + personal * 0.6 : (p.dasScore || 0);
        const fit = scoreDraftFit(p, rosterComposition, teamContext);
        const needBonus = needTier === 'high' ? 12 : needTier === 'medium' ? 5 : 0;
        const recScore = base + fit + needBonus - penalty;
        // Gap threshold to flag trade-back: tighter at premium picks.
        const tbGapThreshold = currentOverallPick <= 6 ? 3 : currentOverallPick <= 12 ? 5 : 8;
        return {
          ...p,
          availabilityProb,
          marketRank,
          marketReachGap: gap,
          reachPenalty: penalty,
          needTier,
          needOrder: needOrder[needTier],
          recScore,
          tradeBackCandidate: gap >= tbGapThreshold && (availabilityProb == null || availabilityProb >= 0.5),
        };
      }).sort((a, b) => (b.recScore || 0) - (a.recScore || 0));
    }

    // Availability predictions
    const withAvailability = await predictAvailability(
      recommended.slice(0, 50), myNextPickNumber, currentOverallPick, remainingRosters
    );

    // Faller alerts (from queue -- user's target list, placeholder: top 10)
    const targetIds = recommended.slice(0, 10).map(p => p.sleeperId).filter(Boolean);
    const fallers = detectFallers(availablePlayers, picks, targetIds);

    // Scan top-5 for trade-back signal — the reach player might not rank #1 after penalty
    // but could still be the consensus 'obvious' pick that the community will reach for.
    const top5 = withAvailability.slice(0, 5);
    const tradeBackRec = top5.find(p => p.tradeBackCandidate) || null;

    let strategyHint = null;
    if (tradeBackRec) {
      const safeUntil = Math.max(
        currentOverallPick + 1,
        Math.floor((tradeBackRec.marketRank || currentOverallPick) - 1)
      );

      // Find managers with picks in the gap — they're your trade-back partners.
      // Use myNextPickNumber as the base so we only include picks AFTER the user's own slot.
      const partners = findTradeBackPartners({
        rosters: league?.rosters.filter(r => r.ownerId !== sleeperId) || [],
        draftOrder: draftData.draft_order || {},
        currentPick: myNextPickNumber,
        safeUntilPick: safeUntil,
        totalRosters,
      });

      const betterNowOptions = top5
        .filter(p => !p.tradeBackCandidate)
        .slice(0, 2);

      // Compute expected return FP value when trading back to first partner
      const myPickFp = fpPickValue(myNextPickNumber);
      const firstPartnerFp = partners.length > 0 ? fpPickValue(partners[0].nextPick) : 0;
      const surplusFp = Math.max(0, myPickFp - firstPartnerFp);
      const returnFp = Math.round(surplusFp * 0.88 * 10) / 10;

      let message;
      if (partners.length > 0) {
        const partnerNames = partners.slice(0, 2).map(p =>
          `${p.username} (pick ${p.nextPick}, ${p.picksBackFromUs} back)`
        ).join(' or ');
        const returnNote = returnFp > 0
          ? ` Expect ~${returnFp} FP in return assets — see packages below.`
          : '';
        message = `${tradeBackRec.name} projects around pick ${Math.round(tradeBackRec.marketRank || myNextPickNumber)} — market says they'll fall. ` +
          `Trade back with ${partnerNames}: give them your pick ${myNextPickNumber}, drop ${partners[0].picksBackFromUs} spot${partners[0].picksBackFromUs !== 1 ? 's' : ''}, ` +
          `still land ${tradeBackRec.name} + gain draft capital.${returnNote}` +
          (betterNowOptions.length ? ` Or take better value now: ${betterNowOptions.map(p => p.name).join(', ')}.` : '');
      } else {
        message = `${tradeBackRec.name} projects around pick ${Math.round(tradeBackRec.marketRank || myNextPickNumber)} — no easy trade-back window found. ` +
          `Taking better value now is recommended` +
          (betterNowOptions.length ? `: ${betterNowOptions.map(p => p.name).join(', ')}.` : '.');
      }

      strategyHint = {
        type: 'trade_back_or_pivot',
        message,
        playerId: tradeBackRec.sleeperId || tradeBackRec._id,
        marketRank: Math.round(tradeBackRec.marketRank || myNextPickNumber),
        currentPick: myNextPickNumber,
        reachGap: Math.round(tradeBackRec.marketReachGap || 0),
        availabilityProb: tradeBackRec.availabilityProb,
        tradeBackPartners: partners,
        betterValueNow: betterNowOptions.map(p => ({
          name: p.name,
          id: p.sleeperId || String(p._id),
        })),
      };
    }

    res.json({
      draftId,
      leagueId: league?.sleeperId || null,
      leagueName: league?.name || draftData.metadata?.name || null,
      status: draftData.status,
      currentPick: currentOverallPick,
      myNextPick: myNextPickNumber,
      onTheClock: picksUntilMe === 0,
      mode,
      available: withAvailability.slice(0, 48),
      recommended: withAvailability.slice(0, 10),
      strategyHint,
      recentPicks: picks.slice(-5).reverse(),
      fallerAlerts: fallers,
      positionalNeeds,
      winWindow: myRoster ? { label: myRoster.winWindowLabel, reason: myRoster.winWindowReason } : null,
    });
  } catch (err) {
    console.error('[Draft]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/draft/:draftId/trades -- trade suggestions for current pick situation
router.get('/:draftId/trades', requireAuth, async (req, res) => {
  try {
    const { draftId } = req.params;
    const { sleeperId } = req.user;
    const targetPlayerId = req.query.player;

    const [draftData, picks] = await Promise.all([
      sleeperService.getDraft(draftId),
      sleeperService.getDraftPicks(draftId),
    ]);

    const totalRosters = draftData.settings?.teams || 12;
    const myPickSlot = draftData.draft_order?.[sleeperId];
    const picksMade = picks.length;
    const currentSlot = (picksMade % totalRosters) + 1;
    const picksUntilMe = myPickSlot >= currentSlot
      ? myPickSlot - currentSlot
      : totalRosters - currentSlot + myPickSlot;
    const myNextPickNumber = picksMade + picksUntilMe + 1;

    const allPlayers = await Player.find({}).lean();
    const playerMap = Object.fromEntries(allPlayers.map(p => [p.sleeperId, p]));

    const league = await League.findOne({ draftId }).lean();
    const nextPickForSlot = (slot) => {
      if (!slot) return null;
      const distance = slot >= currentSlot
        ? (slot - currentSlot)
        : (totalRosters - currentSlot + slot);
      return picksMade + distance + 1;
    };

    const allRosters = (league?.rosters || []).map(r => {
      const slot = draftData.draft_order?.[r.ownerId];
      return {
        ...r,
        nextPickNumber: nextPickForSlot(slot),
      };
    });

    // Build a list of the user's tradeable players for package generation
    const myRoster = allRosters.find(r => r.ownerId === sleeperId);
    const myPlayerIds = myRoster?.playerIds || myRoster?.allPlayerIds || [];
    const myTradablePlayers = myPlayerIds
      .map(id => playerMap[id])
      .filter(p => p && p.name && ((p.ktcValue || 0) > 0 || (p.fantasyProsValue || 0) > 0))
      // Sort by best available value: prefer FP consensus, fall back to KTC-normalized
      .sort((a, b) => {
        const aVal = (a.fantasyProsValue || 0) > 0 ? (a.fantasyProsValue || 0)
          : Math.round((a.ktcValue || 0) / 140);
        const bVal = (b.fantasyProsValue || 0) > 0 ? (b.fantasyProsValue || 0)
          : Math.round((b.ktcValue || 0) / 140);
        return bVal - aVal;
      });

    // Determine our own positional need (for trade-down returns)
    const { analyzePositionalNeeds, buildRosterComposition } = require('../services/winWindowService');
    const rosterPlayerMap = Object.fromEntries(myTradablePlayers.map(p => [p.sleeperId, p]));
    const positionalNeeds = analyzePositionalNeeds(
      myPlayerIds,
      rosterPlayerMap,
      league?.rosterPositions || [],
      league?.scoringSettings || {}
    );
    const ourPositionalNeed = positionalNeeds?.biggestNeed || 'WR';

    let tradeUp = [], tradeDown = [];
    let targetExpectedPick = null;

    if (targetPlayerId) {
      const targetPlayer = playerMap[targetPlayerId] || allPlayers.find(p => p._id.toString() === targetPlayerId);
      if (targetPlayer) {
        const isRookieDraft = isRookieDraftContext(draftData, league || {});
        const marketRank = estimateTradeTargetPick(targetPlayer, {
          myNextPickNumber,
          totalRosters,
          isRookieDraft,
        });
        targetExpectedPick = marketRank;

        // Always offer trade-up options for any manager who picks before us.
        // Also offer trade-down options when the player is expected to fall past our slot.
        const safeUntil = Math.max(myNextPickNumber + 1, Math.round(marketRank - 1));

        [tradeUp, tradeDown] = await Promise.all([
          suggestTradeUp({
            targetPlayer,
            ourPickNumber: myNextPickNumber,
            targetPicksAt: null,
            allRosters,
            playerMap,
            userId: sleeperId,
            ourPlayers: myTradablePlayers,
            teams: totalRosters,
          }),
          suggestTradeDown({
            targetPlayer,
            ourPickNumber: myNextPickNumber,
            availableUntilPick: safeUntil,
            allRosters,
            userId: sleeperId,
            ourPositionalNeed,
            teams: totalRosters,
          }),
        ]);
      }
    }

    res.json({
      tradeUp,
      tradeDown,
      context: {
        myNextPickNumber,
        myNextPickLabel: (() => {
          const round = Math.ceil(myNextPickNumber / totalRosters);
          const slot  = ((myNextPickNumber - 1) % totalRosters) + 1;
          return `${round}.${String(slot).padStart(2, '0')}`;
        })(),
        targetExpectedPick,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/draft/:draftId/scouting/:managerId -- scouting report for a manager
router.get('/:draftId/scouting/:managerId', requireAuth, async (req, res) => {
  try {
    const profile = await ManagerProfile.findOne({ sleeperId: req.params.managerId }).lean();
    if (!profile) return res.json({ noData: true, message: 'No draft history available yet for this manager' });

    const [enriched] = await enrichProfilesWithDraftClass([profile]);
    const result = {
      ...enriched,
      topColleges: Object.entries(enriched.collegeAffinities || {})
        .sort(([, a], [, b]) => b - a).slice(0, 3).map(([name, count]) => ({ name, count })),
      topNflTeams: Object.entries(enriched.nflTeamAffinities || {})
        .sort(([, a], [, b]) => b - a).slice(0, 3).map(([team, count]) => ({ team, count })),
    };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
