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

// GET /api/leagues -- all leagues for logged-in user
router.get('/', requireAuth, async (req, res) => {
  try {
    const { sleeperId } = req.user;
    const year = req.query.year || '2026';

    // Fetch fresh from Sleeper
    const sleeperLeagues = await sleeperService.getUserLeagues(sleeperId, 'nfl', year);

    // Build player map for win window calculations
    const allPlayers = await Player.find({}).lean();
    const playerMap = Object.fromEntries(allPlayers.map(p => [p.sleeperId, p]));

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
        { upsert: true, new: true }
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
    const playerMap = Object.fromEntries(allPlayers.map(p => [p.sleeperId, p]));

    const lookback = parseInt(req.query.days) || 30;
    const alerts = await generateBuySellAlerts(myRoster.playerIds, playerMap, lookback);
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
