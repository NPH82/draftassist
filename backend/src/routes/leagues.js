/**
 * Leagues routes
 * Fetches and caches Sleeper league + roster data.
 */

const express = require('express');
const router = express.Router();

const sleeperService = require('../services/sleeperService');
const { requireAuth } = require('../middleware/auth');
const {
  computeLeagueOutlooks,
  analyzePositionalNeeds,
  buildRosterComposition,
  scoreDraftFit,
} = require('../services/winWindowService');
const { generateBuySellAlerts } = require('../services/alertService');
const { calcPersonalRankScore } = require('../services/scoringEngine');
const League = require('../models/League');
const Player = require('../models/Player');
const ManagerProfile = require('../models/ManagerProfile');

const KTC_TO_FP = 68 / 9500;

function fpEquivalentValue(player = {}, isDevy = false) {
  const fp = Number(player.fantasyProsValue || 0);
  const ktcRaw = isDevy ? Number(player.devyKtcValue || player.ktcValue || 0) : Number(player.ktcValue || 0);
  const ktcFp = ktcRaw > 0 ? ktcRaw * KTC_TO_FP : 0;

  if (fp > 0 && ktcFp > 0) return Math.round(((fp * 0.55) + (ktcFp * 0.45)) * 10) / 10;
  if (fp > 0) return Math.round(fp * 10) / 10;
  if (ktcFp > 0) return Math.round(ktcFp * 10) / 10;
  return 0;
}

function parseYearsExp(player = {}) {
  const value = Number(player.years_exp);
  return Number.isFinite(value) ? value : null;
}

function isSleeperDevyPlayer(sp = {}) {
  const yearsExp = parseYearsExp(sp);
  if (yearsExp === -1) return true;
  // Sleeper fallback: treat no-team college players with <=0 experience as devy-like.
  return yearsExp !== null && yearsExp <= 0 && !sp.team && !!sp.college;
}

function getPlayerAliasFromMetadata(metadata = {}, playerId) {
  if (!metadata || !playerId) return null;

  const possibleMaps = [
    metadata.player_nicknames,
    metadata.player_notes,
    metadata.player_nickname,
    metadata.player_note,
  ].filter(Boolean);

  for (const map of possibleMaps) {
    if (map && typeof map === 'object' && !Array.isArray(map) && map[playerId]) {
      return String(map[playerId]).trim();
    }
  }

  return null;
}

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

function reachPenaltyFromMarket({ player, currentPick, needTier = 'low', reachDiscipline = 1, fallbackRank = 999 }) {
  const marketRank = marketRankSignal(player, fallbackRank);
  const gap = marketRank - currentPick; // positive means likely available after current slot
  const earlyPick = currentPick <= 12;
  const threshold = earlyPick ? 2 : 4;
  if (gap <= threshold) return { penalty: 0, marketRank, gap };

  let penalty = Math.min(earlyPick ? 34 : 24, (gap - threshold) * (earlyPick ? 2.05 : 1.35));

  // Preserve need-based flexibility.
  if (needTier === 'high') penalty *= 0.55;
  else if (needTier === 'medium') penalty *= 0.8;

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

// GET /api/leagues -- all leagues for logged-in user
router.get('/', requireAuth, async (req, res) => {
  try {
    const { sleeperId } = req.user;
    const year = req.query.year || '2026';

    // Fetch fresh from Sleeper
    const sleeperLeagues = await sleeperService.getUserLeagues(sleeperId, 'nfl', year);

    // Build player map for win window calculations.
    // Primary: our DB (has DAS scores, KTC/FP values, etc.), keyed by sleeperId.
    // Fallback: Sleeper's full player list for any roster player IDs not in our DB.
    const allPlayers = await Player.find({}).lean();
    const playerMap = Object.fromEntries(
      allPlayers.filter(p => p.sleeperId).map(p => [p.sleeperId, p])
    );

    // Augment with Sleeper's own player data so veterans on the roster
    // are recognised even before our scraper / sync has run.
    let sleeperPlayerMap = {};
    try {
      sleeperPlayerMap = await sleeperService.getAllPlayers('nfl');
    } catch (e) {
      console.warn('[Leagues] Could not fetch Sleeper player map:', e.message);
    }
    // For each Sleeper player not already in our map, add a minimal entry
    // so win-window age/position maths work for established veterans.
    for (const [id, sp] of Object.entries(sleeperPlayerMap)) {
      if (!playerMap[id] && sp.position && ['QB', 'RB', 'WR', 'TE'].includes(sp.position)) {
        playerMap[id] = {
          sleeperId: id,
          name: sp.full_name || sp.first_name + ' ' + sp.last_name,
          position: sp.position,
          team: sp.team,
          age: sp.age || null,
          ktcValue: 0,
          fantasyProsValue: 0,
        };
      }
    }

    const leagueData = await Promise.all(sleeperLeagues.map(async (sl) => {
      const rosters = await sleeperService.getRosters(sl.league_id);
      const users = await sleeperService.buildUserMap(sl.league_id);

      const baseRosters = rosters.map(r => {
        const playerIds = r.players || [];
        const taxiPlayerIds = r.taxi || [];
        const allPlayerIds = [...new Set([...playerIds, ...taxiPlayerIds])];
        const settings = r.settings || {};
        const pointsFor = Number(settings.fpts || 0) + (Number(settings.fpts_decimal || 0) / 100);
        return {
          rosterId: r.roster_id,
          ownerId: r.owner_id,
          ownerUsername: users[r.owner_id]?.username || 'Unknown',
          ownerTeamName: users[r.owner_id]?.teamName || null,
          playerIds,
          taxiPlayerIds,
          allPlayerIds,
          picks: r.picks,
          wins: Number(settings.wins || 0),
          losses: Number(settings.losses || 0),
          ties: Number(settings.ties || 0),
          pointsFor,
        };
      });

      const leagueOutlooks = computeLeagueOutlooks(baseRosters, playerMap, sl.roster_positions, sl.scoring_settings);
      const outlookByRosterId = Object.fromEntries(
        leagueOutlooks.map(o => [o.rosterId, o])
      );

      const processedRosters = baseRosters.map((r) => {
        const outlook = outlookByRosterId[r.rosterId] || {};
        return {
          ...r,
          rosterMaturityScore: outlook.rosterMaturityScore,
          winWindowLabel: outlook.winWindowLabel,
          winWindowReason: outlook.winWindowReason,
          positionalNeeds: outlook.positionalNeeds || analyzePositionalNeeds(r.allPlayerIds, playerMap, sl.roster_positions, sl.scoring_settings),
          standingRank: outlook.outlookMeta?.standingRank || null,
          scoreRank: outlook.outlookMeta?.scoreRank || null,
          outlookMeta: outlook.outlookMeta || null,
        };
      });

      // Cache in DB
      await League.findOneAndUpdate(
        { sleeperId: sl.league_id },
        {
          sleeperId: sl.league_id,
          name: sl.name,
          season: sl.season,
          status: sl.status,
          totalRosters: sl.total_rosters,
          scoringSettings: sl.scoring_settings,
          rosterPositions: sl.roster_positions,
          isSuperFlex: sleeperService.detectSuperFlex(sl.roster_positions),
          isPpr: sleeperService.detectPpr(sl.scoring_settings),
          draftId: sl.draft_id,
          rosters: processedRosters,
          lastUpdated: new Date(),
        },
        { upsert: true, returnDocument: 'after' }
      );

      return {
        leagueId: sl.league_id,
        name: sl.name,
        season: sl.season,
        status: sl.status,
        isSuperFlex: sleeperService.detectSuperFlex(sl.roster_positions),
        isPpr: sleeperService.detectPpr(sl.scoring_settings),
        draftId: sl.draft_id,
        draftStatus: sl.status,
        totalRosters: sl.total_rosters,
        myRoster: processedRosters.find(r => r.ownerId === sleeperId) || null,
        rosters: processedRosters,
      };
    }));

    res.json({ leagues: leagueData });
  } catch (err) {
    console.error('[Leagues]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leagues/:leagueId -- single league detail
router.get('/:leagueId', requireAuth, async (req, res) => {
  try {
    const cached = await League.findOne({ sleeperId: req.params.leagueId }).lean();
    if (!cached) return res.status(404).json({ error: 'League not found' });
    res.json(cached);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leagues/:leagueId/alerts -- buy/sell alerts for user's roster in this league
router.get('/:leagueId/alerts', requireAuth, async (req, res) => {
  try {
    const league = await League.findOne({ sleeperId: req.params.leagueId }).lean();
    if (!league) return res.status(404).json({ error: 'League not found' });

    const myRoster = league.rosters.find(r => r.ownerId === req.user.sleeperId);
    if (!myRoster) return res.json({ alerts: [] });

    const allPlayers = await Player.find({}).lean();
    const playerMap = Object.fromEntries(
      allPlayers.filter(p => p.sleeperId).map(p => [p.sleeperId, p])
    );

    const lookback = parseInt(req.query.days) || 30;
    const alerts = await generateBuySellAlerts(myRoster.playerIds, playerMap, lookback);
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── helpers ────────────────────────────────────────────────────────────────────
function slimPlayer(p) {
  return {
    _id: p._id,
    sleeperId: p.sleeperId,
    name: p.name,
    position: p.position,
    team: p.team,
    age: p.age,
    dasScore: p.dasScore,
    ktcValue: p.ktcValue,
    fantasyProsRank: p.fantasyProsRank,
    underdogAdp: p.underdogAdp,
    nflDraftRound: p.nflDraftRound,
    nflDraftPick: p.nflDraftPick,
    college: p.college,
  };
}

// GET /api/leagues/:leagueId/draft-targets
// Returns per-pick target recommendations for the user's upcoming picks in this league's draft.
router.get('/:leagueId/draft-targets', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { sleeperId } = req.user;

    const league = await League.findOne({ sleeperId: leagueId }).lean();
    if (!league) return res.status(404).json({ error: 'League not found' });
    if (!league.draftId) return res.status(404).json({ error: 'No draft found for this league' });
    if ((league.totalRosters || 0) >= 32) {
      return res.json({ leagueId, draftId: league.draftId, noRecommendations: true, picks: [] });
    }

    const [draftData, picks] = await Promise.all([
      sleeperService.getDraft(league.draftId),
      sleeperService.getDraftPicks(league.draftId),
    ]);

    const totalTeams = draftData.settings?.teams || league.totalRosters || 12;
    const rounds = draftData.settings?.rounds || 5;
    const draftType = draftData.type || 'linear';
    const mySlot = draftData.draft_order?.[sleeperId];

    if (!mySlot) return res.status(400).json({ error: 'User not found in draft order' });

    // Calculate all of user's pick numbers
    const myPickNumbers = [];
    for (let round = 1; round <= rounds; round++) {
      let slotInRound;
      if (draftType === 'snake' && round % 2 === 0) {
        slotInRound = totalTeams - mySlot + 1;
      } else {
        slotInRound = mySlot;
      }
      const pickNumber = (round - 1) * totalTeams + slotInRound;
      myPickNumbers.push({ pickNumber, round, slotInRound });
    }

    // Players already drafted in this draft
    const draftedIds = new Set(picks.map(p => p.player_id).filter(Boolean));
    // Players already on any roster in this league (covers carried devy/rookie players)
    const rosteredIds = new Set(
      (league.rosters || []).flatMap(r => [...(r.allPlayerIds || []), ...(r.playerIds || [])])
    );
    const picksMade = picks.length;

    // All players sorted by DAS score — rookie/devy drafts should only show a single class year.
    const isRookieDraft = isRookieDraftContext(draftData, league);
    const draftSeason = isRookieDraft
      ? await resolveDraftClassYear({ requestedYear: req.query.classYear, draftData, league })
      : null;
    const playerFilter = isRookieDraft ? { nflDraftYear: draftSeason } : {};
    const allPlayers = await Player.find(playerFilter).sort({ personalRank: 1, dasScore: -1 }).lean();
    const teamContextPlayers = await Player.find({ position: { $in: ['QB', 'RB', 'WR', 'TE'] } })
      .select('team position ktcValue fantasyProsRank')
      .lean();
    const teamContext = buildTeamContext(teamContextPlayers);

    // Assign an ADP rank to each player (lower = more in-demand)
    const sortedByDemand = allPlayers.slice().sort((a, b) => {
      const aAdp = a.underdogAdp || a.fantasyProsRank || 9999;
      const bAdp = b.underdogAdp || b.fantasyProsRank || 9999;
      return aAdp - bAdp;
    });
    const adpRankMap = new Map(sortedByDemand.map((p, i) => [String(p._id), i + 1]));

    // Positional needs for the user's roster
    const myRoster = league.rosters.find(r => r.ownerId === sleeperId);

    const rosterPoolIds = myRoster?.allPlayerIds || myRoster?.playerIds || [];

    const rosterPlayerDocs = await Player.find({ sleeperId: { $in: rosterPoolIds } })
      .select('sleeperId position age isPassCatcher depthChartPosition ktcValue fantasyProsRank nflDraftRound')
      .lean();
    const rosterPlayerMap = Object.fromEntries(rosterPlayerDocs.map(p => [p.sleeperId, p]));

    let sleeperPlayerMap = {};
    try {
      sleeperPlayerMap = await sleeperService.getAllPlayers('nfl');
    } catch (e) {
      console.warn('[Draft Targets] Sleeper fallback map unavailable:', e.message);
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
      league.rosterPositions || [],
      league.scoringSettings || {}
    );
    const positionalNeeds = analyzePositionalNeeds(
      rosterPoolIds,
      rosterPlayerMap,
      league.rosterPositions || [],
      league.scoringSettings || {}
    );
    const needOrder = { high: 0, medium: 1, low: 2 };

    // Load any existing feedback
    const profile = await ManagerProfile.findOne({ sleeperId }).lean();
    const feedbackMap = {};
    for (const fb of (profile?.targetFeedback || [])) {
      if (fb.leagueId === leagueId) feedbackMap[fb.pickNumber] = fb;
    }
    const reachDiscipline = await estimateReachDiscipline(profile);

    const myPicks = [];
    for (const { pickNumber, round, slotInRound } of myPickNumbers) {
      // Skip picks that have already been made
      if (pickNumber <= picksMade) continue;

      // Players available at this pick: not yet drafted + ADP rank >= pickNumber
      // (i.e., we expect players ranked higher by ADP to be gone)
      const available = allPlayers.filter(p => {
          if (p.sleeperId && (draftedIds.has(p.sleeperId) || rosteredIds.has(p.sleeperId))) return false;
        const adpRank = adpRankMap.get(String(p._id)) || 9999;
        return adpRank >= pickNumber;
      });

      const scored = available.map((p) => {
        const needTier = positionalNeeds[p.position] || 'low';
        const needValue = needOrder[needTier];
        const fallbackRank = adpRankMap.get(String(p._id)) || 999;
        const { penalty, marketRank, gap } = reachPenaltyFromMarket({
          player: p,
          currentPick: pickNumber,
          needTier,
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
          needTier,
          needValue,
          marketRank,
          marketReachGap: gap,
          reachPenalty: penalty,
          recScore,
          tradeBackCandidate: gap >= 8 && needTier !== 'high',
        };
      });

      // Primary sort: blended score (need bonus included) so severe reaches can still be faded.
      const byTeamNeed = scored.slice().sort((a, b) => {
        return (b.recScore || 0) - (a.recScore || 0);
      });

      // BPA alternatives use same reach-aware score to avoid obvious reaches.
      const byDas = scored.slice().sort((a, b) => (b.recScore || 0) - (a.recScore || 0));

      const recommendation = byTeamNeed[0] || null;
      const recId = recommendation ? String(recommendation._id) : null;
      const alternatives = byDas.filter(p => String(p._id) !== recId).slice(0, 4);
      const strategyHint = recommendation?.tradeBackCandidate
        ? {
            type: 'trade_back_or_pivot',
            message: `${recommendation.name} projects later than pick ${pickNumber}. Trade back or pivot BPA.`,
            marketRank: Math.round(recommendation.marketRank || pickNumber),
            reachGap: Math.round(recommendation.marketReachGap || 0),
          }
        : null;

      myPicks.push({
        pickNumber,
        round,
        pickInRound: slotInRound,
        recommendation: recommendation ? slimPlayer(recommendation) : null,
        alternatives: alternatives.map(slimPlayer),
        strategyHint,
        feedback: feedbackMap[pickNumber] || null,
      });
    }

    res.json({
      leagueId,
      draftId: league.draftId,
      draftStatus: draftData.status,
      myPickSlot: mySlot,
      totalTeams,
      rounds,
      myPicks,
    });
  } catch (err) {
    console.error('[Draft Targets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leagues/:leagueId/draft-feedback
// Records agree/disagree feedback for a recommended target. Feeds into learning engine.
router.post('/:leagueId/draft-feedback', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { sleeperId } = req.user;
    const { pickNumber, recommendedPlayerId, agreed, preferredPlayerId } = req.body;

    if (pickNumber == null || agreed == null) {
      return res.status(400).json({ error: 'pickNumber and agreed are required' });
    }

    let profile = await ManagerProfile.findOne({ sleeperId });
    if (!profile) {
      profile = new ManagerProfile({ sleeperId });
    }
    if (!profile.targetFeedback) profile.targetFeedback = [];

    // Upsert feedback entry for this league+pick
    const idx = profile.targetFeedback.findIndex(
      f => f.leagueId === leagueId && f.pickNumber === pickNumber
    );
    const entry = {
      leagueId,
      pickNumber,
      recommendedPlayerId: recommendedPlayerId || null,
      agreed: Boolean(agreed),
      preferredPlayerId: preferredPlayerId || null,
      createdAt: new Date(),
    };
    if (idx >= 0) {
      profile.targetFeedback[idx] = entry;
    } else {
      profile.targetFeedback.push(entry);
    }

    // Learning: nudge position weights when user disagrees and picks a different player
    if (!agreed && preferredPlayerId) {
      const preferredPlayer = await Player.findOne({
        $or: [
          { _id: preferredPlayerId.match(/^[a-f\d]{24}$/i) ? preferredPlayerId : null },
          { sleeperId: preferredPlayerId },
        ],
      }).lean();

      if (preferredPlayer?.position && ['QB', 'RB', 'WR', 'TE'].includes(preferredPlayer.position)) {
        const pos = preferredPlayer.position;
        const weights = { ...profile.positionWeights?.toObject?.() || profile.positionWeights || {} };
        const positions = ['QB', 'RB', 'WR', 'TE'];
        // Nudge +5% toward chosen position, spread the loss across others
        for (const p of positions) {
          const cur = weights[p] ?? 0.25;
          weights[p] = p === pos
            ? Math.min(0.7, cur + 0.05)
            : Math.max(0.05, cur - 0.017);
        }
        profile.set('positionWeights', weights);
      }
    }

    profile.lastUpdated = new Date();
    await profile.save();

    res.json({ ok: true });
  } catch (err) {
    console.error('[Draft Feedback]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leagues/:leagueId/devy-pool
// Returns the available devy prospect pool and per-manager rostered devy players.
// Only meaningful for devy leagues (name contains "devy" or has devy roster slots).
router.get('/:leagueId/devy-pool', requireAuth, async (req, res) => {
  try {
    const { leagueId } = req.params;
    const league = await League.findOne({ sleeperId: leagueId }).lean();
    if (!league) return res.status(404).json({ error: 'League not found' });

    // Fetch Sleeper player map so we can identify devy players by years_exp
    let sleeperPlayerMap = {};
    try {
      sleeperPlayerMap = await sleeperService.getAllPlayers('nfl');
    } catch (e) {
      console.warn('[DevyPool] Sleeper player map unavailable:', e.message);
    }

    // Pull user metadata so we can honor player-level notes/nicknames used by
    // many devy leagues to store the real devy prospect attached to an NFL ID.
    let userMetaById = {};
    try {
      const users = await sleeperService.getLeagueUsers(leagueId);
      userMetaById = Object.fromEntries((users || []).map(u => [u.user_id, u.metadata || {}]));
    } catch (e) {
      console.warn('[DevyPool] League user metadata unavailable:', e.message);
    }

    // Collect every player ID across all rosters (active + taxi)
    const allRosterIds = new Set();
    const idToRoster = {};  // sleeperId -> { ownerId, username, onTaxi }
    for (const roster of league.rosters || []) {
      const active = roster.playerIds || [];
      const taxi = roster.taxiPlayerIds || [];
      const ownerMeta = userMetaById[roster.ownerId] || {};
      for (const id of active) {
        allRosterIds.add(id);
        const alias = getPlayerAliasFromMetadata(ownerMeta, id);
        if (!idToRoster[id]) {
          idToRoster[id] = { ownerId: roster.ownerId, username: roster.ownerUsername, onTaxi: false, devyAlias: alias || null };
        } else if (!idToRoster[id].devyAlias && alias) {
          idToRoster[id].devyAlias = alias;
        }
      }
      for (const id of taxi) {
        allRosterIds.add(id);
        const alias = getPlayerAliasFromMetadata(ownerMeta, id);
        if (!idToRoster[id]) {
          idToRoster[id] = { ownerId: roster.ownerId, username: roster.ownerUsername, onTaxi: true, devyAlias: alias || null };
        } else if (!idToRoster[id].devyAlias && alias) {
          idToRoster[id].devyAlias = alias;
        }
      }
    }

    // Identify which roster IDs are devy players (years_exp === -1 in Sleeper)
    // Also track players who were devy but just got drafted to an NFL team ("graduated")
    const devyRosteredIds = new Set();
    const graduatedIds = new Set();  // had/have NFL team — recently drafted from devy pool

    for (const id of allRosterIds) {
      const sp = sleeperPlayerMap[id];
      const owner = idToRoster[id] || {};
      const yearsExp = parseYearsExp(sp || {});
      const officialName = sp
        ? (sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`.trim())
        : '';
      const alias = owner.devyAlias ? String(owner.devyAlias).trim() : null;
      const hasDistinctAlias = !!(alias && (!officialName || alias.toLowerCase() !== officialName.toLowerCase()));

      if (isSleeperDevyPlayer(sp) || hasDistinctAlias) {
        devyRosteredIds.add(id);
      } else if (yearsExp === 0 && sp && sp.team) {
        // years_exp: 0 + has a team = just drafted into NFL this year
        graduatedIds.add(id);
      }
    }

    // Load devy players from our DB
    const devyDbPlayers = await Player.find({ isDevy: true })
      .select('sleeperId name position college devyClass devyKtcValue ktcValue fantasyProsValue fantasyProsRank underdogAdp dasScore age')
      .lean();

    const devyBySleeperID = Object.fromEntries(devyDbPlayers.map(p => [p.sleeperId, p]));

    // Build rostered devy list: DB record + owner info + Sleeper data
    const rosterList = [];
    for (const id of devyRosteredIds) {
      const sp = sleeperPlayerMap[id] || {};
      const db = devyBySleeperID[id];
      const owner = idToRoster[id] || {};

      const officialName = db?.name || sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`.trim() || id;
      const alias = owner.devyAlias ? String(owner.devyAlias).trim() : null;
      const isAliasName = !!(alias && alias.toLowerCase() !== officialName.toLowerCase());
      const name = isAliasName ? alias : officialName;
      const position = db?.position || sp.position || '?';
      const college = db?.college || sp.college || null;

      rosterList.push({
        sleeperId: id,
        name,
        associatedPlayerName: isAliasName ? officialName : null,
        fromPlayerNote: isAliasName,
        position,
        college,
        devyClass: db?.devyClass || null,
        devyKtcValue: db?.devyKtcValue || 0,
        ktcValue: db?.ktcValue || 0,
        fantasyProsValue: db?.fantasyProsValue || 0,
        fantasyProsRank: db?.fantasyProsRank || null,
        dasScore: db?.dasScore || null,
        ownerId: owner.ownerId || null,
        ownerUsername: owner.username || null,
        onTaxi: !!owner.onTaxi,
        inOurDb: !!db,
      });
    }

    // Build graduated list — devy players who are now on NFL rosters
    const graduatedList = [];
    for (const id of graduatedIds) {
      const sp = sleeperPlayerMap[id] || {};
      const name = sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`.trim() || id;
      const owner = idToRoster[id];
      graduatedList.push({
        sleeperId: id,
        name,
        position: sp.position || '?',
        team: sp.team || null,  // now has an NFL team
        college: sp.college || null,
        ownerId: owner?.ownerId,
        ownerUsername: owner?.username,
        onTaxi: owner?.onTaxi,
      });
    }

    // Build available pool: all devy players in our DB NOT on any roster in this league
    const availablePool = devyDbPlayers
      .filter(p => p.sleeperId && !devyRosteredIds.has(p.sleeperId))
      .map(p => {
        const sp = sleeperPlayerMap[p.sleeperId] || {};
        // Skip players who have now graduated to the NFL (years_exp !== -1)
        const yearsExp = parseYearsExp(sp);
        if (yearsExp !== null && !isSleeperDevyPlayer(sp)) return null;
        return {
          sleeperId: p.sleeperId,
          name: p.name,
          position: p.position,
          college: p.college || sp.college || null,
          devyClass: p.devyClass || null,
          devyKtcValue: p.devyKtcValue || 0,
          ktcValue: p.ktcValue || 0,
          fantasyProsValue: p.fantasyProsValue || 0,
          fantasyProsRank: p.fantasyProsRank || null,
          dasScore: p.dasScore || null,
          fpEquivalent: fpEquivalentValue(p, true),
        };
      })
      .filter(Boolean)
      // Sort: devyKtcValue desc, then ktcValue, then fantasyProsValue
      .sort((a, b) => {
        const aVal = a.devyKtcValue || a.ktcValue || 0;
        const bVal = b.devyKtcValue || b.ktcValue || 0;
        return bVal - aVal;
      });

    // Build current rookie availability pool in this league (non-devy rookies not rostered).
    const currentYear = new Date().getFullYear();
    const rookieDbPlayers = await Player.find({
      isDevy: { $ne: true },
      $or: [
        { isRookie: true },
        { nflDraftYear: currentYear },
      ],
    })
      .select('sleeperId name position team college nflDraftYear fantasyProsValue fantasyProsRank ktcValue ktcRank underdogAdp dasScore isRookie')
      .lean();

    const availableRookies = rookieDbPlayers
      .filter((p) => {
        // If tied to a Sleeper ID and already rostered/taxi, it's not available in this league.
        if (p.sleeperId && allRosterIds.has(p.sleeperId)) return false;

        const sp = p.sleeperId ? sleeperPlayerMap[p.sleeperId] : null;
        const yearsExp = parseYearsExp(sp || {});
        // Exclude players that are still devy in Sleeper data.
        if (isSleeperDevyPlayer(sp || {})) return false;
        // Rookie pool should focus on current incoming/first-year NFL players.
        if (yearsExp !== null && yearsExp > 0) return false;

        return true;
      })
      .map((p) => ({
        sleeperId: p.sleeperId || null,
        name: p.name,
        position: p.position,
        team: p.team || null,
        college: p.college || null,
        nflDraftYear: p.nflDraftYear || null,
        fantasyProsValue: p.fantasyProsValue || 0,
        fantasyProsRank: p.fantasyProsRank || null,
        ktcValue: p.ktcValue || 0,
        ktcRank: p.ktcRank || null,
        underdogAdp: p.underdogAdp || null,
        dasScore: p.dasScore || null,
        fpEquivalent: fpEquivalentValue(p, false),
      }))
      .sort((a, b) => {
        if (b.fpEquivalent !== a.fpEquivalent) return b.fpEquivalent - a.fpEquivalent;
        const aVal = a.ktcValue || 0;
        const bVal = b.ktcValue || 0;
        return bVal - aVal;
      });

    const comparisonRows = availablePool.slice(0, 15).map((devy, idx) => {
      const rookie = availableRookies[idx] || null;
      return {
        devy,
        rookie,
        fpGap: rookie ? Math.round((devy.fpEquivalent - rookie.fpEquivalent) * 10) / 10 : null,
      };
    });

    // Augment: for any rostered devy IDs not yet in our DB, pull from Sleeper map only
    const unknownIds = [...devyRosteredIds].filter(id => !devyBySleeperID[id]);
    const unknownPlayers = unknownIds.map(id => {
      const sp = sleeperPlayerMap[id] || {};
      const owner = idToRoster[id] || {};
      const name = sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`.trim() || id;
      return {
        sleeperId: id,
        name,
        position: sp.position || '?',
        college: sp.college || null,
        devyClass: null,
        devyKtcValue: 0,
        ktcValue: 0,
        fantasyProsValue: 0,
        fantasyProsRank: null,
        dasScore: null,
        ownerId: owner.ownerId || null,
        ownerUsername: owner.username || null,
        onTaxi: !!owner.onTaxi,
        inOurDb: false,
      };
    });

    res.json({
      leagueId,
      leagueName: league.name,
      isDevyLeague: /devy/i.test(league.name || ''),
      rostered: rosterList,
      unknown: unknownPlayers,   // devy players Sleeper knows about but we haven't imported yet
      graduated: graduatedList,  // recently NFL-drafted — were in devy pool
      available: availablePool,
      availableRookies,
      comparisonRows,
      counts: {
        rostered: rosterList.length,
        unknown: unknownPlayers.length,
        graduated: graduatedList.length,
        available: availablePool.length,
        availableRookies: availableRookies.length,
      },
    });
  } catch (err) {
    console.error('[DevyPool]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
