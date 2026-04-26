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
const { suggestTradeUp, suggestTradeDown } = require('../services/tradeEngine');
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
  if (fp > 0) return fp;
  return fallbackRank;
}

function reachPenaltyFromMarket({ player, currentPick, needTier = 'low', availabilityProb = null, reachDiscipline = 1, fallbackRank = 999 }) {
  const marketRank = marketRankSignal(player, fallbackRank);
  const gap = marketRank - currentPick; // positive means likely available later
  const earlyPick = currentPick <= 12;
  const threshold = earlyPick ? 2 : 4;
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
        return {
          ...p,
          availabilityProb,
          marketRank,
          marketReachGap: gap,
          reachPenalty: penalty,
          recScore,
          tradeBackCandidate: gap >= 8 && (availabilityProb == null || availabilityProb >= 0.6),
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
        return {
          ...p,
          availabilityProb,
          marketRank,
          marketReachGap: gap,
          reachPenalty: penalty,
          needTier,
          needOrder: needOrder[needTier],
          recScore,
          tradeBackCandidate: gap >= 8 && (availabilityProb == null || availabilityProb >= 0.6),
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

    const topRec = withAvailability[0] || null;
    const strategyHint = topRec && topRec.tradeBackCandidate
      ? {
          type: 'trade_back_or_pivot',
          message: `${topRec.name} projects later than current pick (${Math.round(topRec.marketRank || currentOverallPick)} vs ${currentOverallPick}). Consider trade-back or pivot BPA.`,
          playerId: topRec.sleeperId || topRec._id,
          marketRank: Math.round(topRec.marketRank || currentOverallPick),
          currentPick: currentOverallPick,
          reachGap: Math.round(topRec.marketReachGap || 0),
          availabilityProb: topRec.availabilityProb,
        }
      : null;

    res.json({
      draftId,
      leagueId: league?.sleeperId || null,
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
    const allRosters = (league?.rosters || []).map(r => ({
      ...r,
      nextPickNumber: myNextPickNumber - picksUntilMe + 1,
    }));

    let tradeUp = [], tradeDown = [];

    if (targetPlayerId) {
      const targetPlayer = playerMap[targetPlayerId] || allPlayers.find(p => p._id.toString() === targetPlayerId);
      if (targetPlayer) {
        const targetAdp = targetPlayer.underdogAdp || targetPlayer.fantasyProsRank || myNextPickNumber - 3;
        const availUntil = targetPlayer.underdogAdp ? Math.round(targetPlayer.underdogAdp + 5) : myNextPickNumber + 5;

        [tradeUp, tradeDown] = await Promise.all([
          suggestTradeUp({ targetPlayer, ourPickNumber: myNextPickNumber, targetPicksAt: Math.round(targetAdp), allRosters, playerMap, userId: sleeperId }),
          suggestTradeDown({ targetPlayer, ourPickNumber: myNextPickNumber, availableUntilPick: availUntil, allRosters, userId: sleeperId }),
        ]);
      }
    }

    res.json({ tradeUp, tradeDown });
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
