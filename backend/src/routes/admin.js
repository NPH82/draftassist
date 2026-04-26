/**
 * Admin routes -- manual scraper triggers and data management
 * Protected by requireAuth.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { refreshDailyRankings, refreshDepthCharts } = require('../scrapers/index');
const { learnFromUserLeagues } = require('../services/learningEngine');
const Player = require('../models/Player');
const ManagerProfile = require('../models/ManagerProfile');
const sleeperService = require('../services/sleeperService');

// POST /api/admin/refresh/rankings -- trigger daily rankings scrape now
router.post('/refresh/rankings', requireAuth, async (req, res) => {
  try {
    console.log('[Admin] Manual rankings refresh triggered');
    // Run async, respond immediately so the HTTP request doesn't time out
    refreshDailyRankings()
      .then(results => console.log('[Admin] Rankings refresh complete', results))
      .catch(err => console.error('[Admin] Rankings refresh error', err));
    res.json({ ok: true, message: 'Rankings refresh started -- data will update within ~60 seconds' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/refresh/depth-charts -- trigger weekly depth chart scrape now
router.post('/refresh/depth-charts', requireAuth, async (req, res) => {
  try {
    console.log('[Admin] Manual depth chart refresh triggered');
    refreshDepthCharts()
      .then(() => console.log('[Admin] Depth charts refresh complete'))
      .catch(err => console.error('[Admin] Depth charts error', err));
    res.json({ ok: true, message: 'Depth chart refresh started -- data will update within ~60 seconds' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/data-status -- shows last updated timestamps per source
router.get('/data-status', requireAuth, async (req, res) => {
  try {
    const RankingSnapshot = require('../models/RankingSnapshot');
    const [latestFp, latestKtc, latestUdg, playerCount, playersWithFp, playersWithKtc] = await Promise.all([
      RankingSnapshot.findOne({ source: 'fantasypros' }).sort({ snapshotDate: -1 }).lean(),
      RankingSnapshot.findOne({ source: 'ktc' }).sort({ snapshotDate: -1 }).lean(),
      RankingSnapshot.findOne({ source: 'underdog' }).sort({ snapshotDate: -1 }).lean(),
      Player.countDocuments(),
      Player.countDocuments({ fantasyProsRank: { $exists: true, $ne: null } }),
      Player.countDocuments({ ktcValue: { $exists: true, $ne: null } }),
    ]);
    res.json({
      playerCount,
      sources: {
        fantasyPros: { lastUpdated: latestFp?.snapshotDate || null, playersWithData: playersWithFp },
        ktc:         { lastUpdated: latestKtc?.snapshotDate || null, playersWithData: playersWithKtc },
        underdog:    { lastUpdated: latestUdg?.snapshotDate || null },
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/learn -- scan all user leagues + leaguemate leagues for completed drafts
// Skips any draft already processed. Runs async; returns immediately with job status.
router.post('/learn', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sleeperId;
    const leagues = await sleeperService.getUserLeagues(userId).catch(() => []);
    const leagueIds = leagues.map(l => l.league_id).filter(Boolean);

    if (leagueIds.length === 0) {
      return res.json({ ok: false, message: 'No leagues found for this user' });
    }

    // Run async -- respond immediately so Render doesn't time out
    learnFromUserLeagues(userId, leagueIds)
      .then(summary => console.log('[Admin] Learn complete:', summary))
      .catch(err => console.error('[Admin] Learn error:', err));

    res.json({
      ok: true,
      message: `Scanning ${leagueIds.length} leagues + leaguemate leagues for completed drafts. Manager profiles will update within ~2 minutes.`,
      leagueCount: leagueIds.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/manager-profiles -- scouting summaries for all leaguemates
router.get('/manager-profiles', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sleeperId;
    const leagues = await sleeperService.getUserLeagues(userId).catch(() => []);

    // Collect all leaguemate Sleeper user IDs across all leagues
    const leaguemateIds = new Set();
    for (const league of leagues) {
      try {
        const rosters = await sleeperService.getRosters(league.league_id);
        for (const r of rosters) {
          if (r.owner_id && r.owner_id !== userId) leaguemateIds.add(r.owner_id);
        }
      } catch { /* skip */ }
    }

    const profiles = await ManagerProfile.find({
      sleeperId: { $in: [...leaguemateIds] },
    }).lean();

    const enriched = profiles.map(p => ({
      sleeperId: p.sleeperId,
      username: p.username,
      scoutingNotes: p.scoutingNotes || [],
      positionWeights: p.positionWeights,
      earlyRoundPositionWeights: p.earlyRoundPositionWeights,
      topColleges: Object.entries(p.collegeAffinities || {})
        .sort(([, a], [, b]) => b - a).slice(0, 3).map(([name, count]) => ({ name, count })),
      topNflTeams: Object.entries(p.nflTeamAffinities || {})
        .sort(([, a], [, b]) => b - a).slice(0, 3).map(([team, count]) => ({ team, count })),
      totalPicksObserved: p.totalPicksObserved,
      draftsObserved: p.draftsObserved?.length || 0,
      lastUpdated: p.lastUpdated,
    }));

    const totalProfiled = enriched.filter(p => p.totalPicksObserved > 0).length;

    res.json({
      profiles: enriched,
      totalLeaguemates: leaguemateIds.size,
      totalProfiled,
      unprofiled: leaguemateIds.size - totalProfiled,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
