/**
 * Leagues routes
 * Fetches and caches Sleeper league + roster data.
 */

const express = require('express');
const router = express.Router();

const sleeperService = require('../services/sleeperService');
const { requireAuth } = require('../middleware/auth');
const { computeRosterMaturity, analyzePositionalNeeds } = require('../services/winWindowService');
const { generateBuySellAlerts } = require('../services/alertService');
const League = require('../models/League');
const Player = require('../models/Player');
const ManagerProfile = require('../models/ManagerProfile');

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

      const processedRosters = rosters.map(r => {
        const playerIds = r.players || [];
        const futurePicks = r.picks || [];
        const maturity = computeRosterMaturity(playerIds, playerMap, futurePicks);
        const needs = analyzePositionalNeeds(playerIds, playerMap, sl.roster_positions);
        return {
          rosterId: r.roster_id,
          ownerId: r.owner_id,
          ownerUsername: users[r.owner_id]?.username || 'Unknown',
          playerIds,
          picks: r.picks,
          rosterMaturityScore: maturity.score,
          winWindowLabel: maturity.label,
          winWindowReason: maturity.reason,
          positionalNeeds: needs,
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
    const picksMade = picks.length;

    // All players sorted by DAS score — rookie drafts show only current season's draft class
    const draftSeason = parseInt(draftData.season) || new Date().getFullYear();
    const isRookieDraft = rounds < totalTeams;
    const playerFilter = isRookieDraft ? { nflDraftYear: draftSeason } : {};
    const allPlayers = await Player.find(playerFilter).sort({ dasScore: -1 }).lean();

    // Assign an ADP rank to each player (lower = more in-demand)
    const sortedByDemand = allPlayers.slice().sort((a, b) => {
      const aAdp = a.underdogAdp || a.fantasyProsRank || 9999;
      const bAdp = b.underdogAdp || b.fantasyProsRank || 9999;
      return aAdp - bAdp;
    });
    const adpRankMap = new Map(sortedByDemand.map((p, i) => [String(p._id), i + 1]));

    // Positional needs for the user's roster
    const myRoster = league.rosters.find(r => r.ownerId === sleeperId);
    const positionalNeeds = myRoster?.positionalNeeds || {};
    const needOrder = { high: 0, medium: 1, low: 2 };

    // Load any existing feedback
    const profile = await ManagerProfile.findOne({ sleeperId }).lean();
    const feedbackMap = {};
    for (const fb of (profile?.targetFeedback || [])) {
      if (fb.leagueId === leagueId) feedbackMap[fb.pickNumber] = fb;
    }

    const myPicks = [];
    for (const { pickNumber, round, slotInRound } of myPickNumbers) {
      // Skip picks that have already been made
      if (pickNumber <= picksMade) continue;

      // Players available at this pick: not yet drafted + ADP rank >= pickNumber
      // (i.e., we expect players ranked higher by ADP to be gone)
      const available = allPlayers.filter(p => {
        if (p.sleeperId && draftedIds.has(p.sleeperId)) return false;
        const adpRank = adpRankMap.get(String(p._id)) || 9999;
        return adpRank >= pickNumber;
      });

      // Primary sort: positional need then DAS (team need mode)
      const byTeamNeed = available.slice().sort((a, b) => {
        const aNeed = needOrder[positionalNeeds[a.position] || 'low'];
        const bNeed = needOrder[positionalNeeds[b.position] || 'low'];
        if (aNeed !== bNeed) return aNeed - bNeed;
        return (b.dasScore || 0) - (a.dasScore || 0);
      });

      // BPA sort for alternatives
      const byDas = available.slice().sort((a, b) => (b.dasScore || 0) - (a.dasScore || 0));

      const recommendation = byTeamNeed[0] || null;
      const recId = recommendation ? String(recommendation._id) : null;
      const alternatives = byDas.filter(p => String(p._id) !== recId).slice(0, 4);

      myPicks.push({
        pickNumber,
        round,
        pickInRound: slotInRound,
        recommendation: recommendation ? slimPlayer(recommendation) : null,
        alternatives: alternatives.map(slimPlayer),
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

module.exports = router;
