/**
 * Draft routes
 * Live draft state, recommendations, queue, and trade suggestions during draft.
 */

const express = require('express');
const router = express.Router();

const sleeperService = require('../services/sleeperService');
const { requireAuth } = require('../middleware/auth');
const { detectValueGap } = require('../services/scoringEngine');
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

// GET /api/draft/active -- list active drafts for user, sorted by next pick time
router.get('/active', requireAuth, async (req, res) => {
  try {
    const { sleeperId } = req.user;

    // Get user's leagues
    const leagues = await League.find({ 'rosters.ownerId': sleeperId }).lean();
    const activeDrafts = [];

    for (const league of leagues) {
      if (!league.draftId) continue;
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
    const allPlayers = await Player.find(playerFilter).sort({ dasScore: -1 }).lean();
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

    // Sort by recommendation mode
    let recommended;
    if (mode === 'bpa') {
      recommended = availablePlayers.slice();
    } else {
      // Team need: sort by positional need, then DAS
      const needOrder = { high: 0, medium: 1, low: 2 };
      recommended = availablePlayers.slice().sort((a, b) => {
        const aNeed = needOrder[positionalNeeds[a.position] || 'low'];
        const bNeed = needOrder[positionalNeeds[b.position] || 'low'];
        if (aNeed !== bNeed) return aNeed - bNeed;

        const aScore = (a.dasScore || 0) + scoreDraftFit(a, rosterComposition, teamContext);
        const bScore = (b.dasScore || 0) + scoreDraftFit(b, rosterComposition, teamContext);
        return bScore - aScore;
      });
    }

    // Availability predictions
    const remainingRosters = league?.rosters
      .filter(r => r.ownerId !== sleeperId)
      .map(r => ({ ...r, nextPickNumber: myNextPickNumber - picksUntilMe })) || [];

    const withAvailability = await predictAvailability(
      recommended.slice(0, 50), myNextPickNumber, currentOverallPick, remainingRosters
    );

    // Faller alerts (from queue -- user's target list, placeholder: top 10)
    const targetIds = recommended.slice(0, 10).map(p => p.sleeperId).filter(Boolean);
    const fallers = detectFallers(availablePlayers, picks, targetIds);

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
