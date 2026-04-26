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
const Player = require('../models/Player');
const Draft = require('../models/Draft');
const League = require('../models/League');
const ManagerProfile = require('../models/ManagerProfile');

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
    const [draftData, picks] = await Promise.all([
      sleeperService.getDraft(draftId),
      sleeperService.getDraftPicks(draftId),
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

    // Load all players
    const allPlayers = await Player.find({}).sort({ dasScore: -1 }).lean();
    const availablePlayers = allPlayers
      .filter(p => !p.sleeperId || !draftedIds.has(p.sleeperId))
      .map((p, i) => ({ ...p, dasRank: i + 1, valueGap: detectValueGap(p) }));

    // Get my roster from league
    const league = await League.findOne({ draftId }).lean();
    const myRoster = league?.rosters.find(r => r.ownerId === sleeperId);
    const positionalNeeds = myRoster?.positionalNeeds || {};

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
        return (b.dasScore || 0) - (a.dasScore || 0);
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
