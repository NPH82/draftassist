/**
 * Admin routes -- manual scraper triggers and data management
 * Protected by requireAuth.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { refreshDailyRankings, refreshDepthCharts, loadPlayerData } = require('../scrapers/index');
const { learnFromUserLeagues, enrichProfilesWithDraftClass } = require('../services/learningEngine');
const Player = require('../models/Player');
const ManagerProfile = require('../models/ManagerProfile');
const sleeperService = require('../services/sleeperService');
const { importSleeperPlayers, syncSleeperIds: runSyncSleeperIds } = require('../services/sleeperSync');

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

// POST /api/admin/load-player-data -- one-time deep load: PFR combine stats, ESPN draft results, RotoWire college injuries
router.post('/load-player-data', requireAuth, async (req, res) => {
  try {
    console.log('[Admin] Manual player data load triggered');
    loadPlayerData()
      .then(r => console.log('[Admin] Player data load complete', r))
      .catch(err => console.error('[Admin] Player data load error', err));
    res.json({ ok: true, message: 'Player data load started (PFR + ESPN + RotoWire) -- data will update within ~2 minutes' });
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
// Optional query param ?leagueId=XXX narrows to a single league and adds win-window data.
router.get('/manager-profiles', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sleeperId;
    const { leagueId } = req.query;
    const League = require('../models/League');

    if (leagueId) {
      // ── League-scoped view ────────────────────────────────────────────────
      const [rosters, leagueDoc, usersMap] = await Promise.all([
        sleeperService.getRosters(leagueId).catch(() => []),
        League.findOne({ sleeperId: leagueId }).lean().catch(() => null),
        sleeperService.buildUserMap(leagueId).catch(() => ({})),
      ]);

      // Build a rosterMap keyed by ownerId so we can attach win-window data
      const cachedRosterByOwner = {};
      for (const r of (leagueDoc?.rosters || [])) {
        if (r.ownerId) cachedRosterByOwner[r.ownerId] = r;
      }

      const ownerIds = rosters.map(r => r.owner_id).filter(Boolean);
      const profiles = await ManagerProfile.find({ sleeperId: { $in: ownerIds } }).lean();
      const profileMap = Object.fromEntries(profiles.map(p => [p.sleeperId, p]));

      const baseEnriched = rosters.map((roster) => {
        const ownerId = roster.owner_id;
        const fallbackSleeperId = ownerId || `orphan-${roster.roster_id}`;
        const p = profileMap[ownerId];
        const cached = cachedRosterByOwner[ownerId] || {};
        const user = usersMap[ownerId] || {};
        return {
          sleeperId: fallbackSleeperId,
          username: p?.username || user.username || cached.ownerUsername || ownerId || 'Unassigned Team',
          teamName: user.teamName || cached.ownerTeamName || null,
          scoutingNotes: p?.scoutingNotes || [],
          positionWeights: p?.positionWeights,
          earlyRoundPositionWeights: p?.earlyRoundPositionWeights,
          topColleges: Object.entries(p?.collegeAffinities || {})
            .sort(([, a], [, b]) => b - a).slice(0, 3).map(([name, count]) => ({ name, count })),
          topNflTeams: Object.entries(p?.nflTeamAffinities || {})
            .sort(([, a], [, b]) => b - a).slice(0, 3).map(([team, count]) => ({ team, count })),
          playerPickCounts: p?.playerPickCounts,
          totalPicksObserved: p?.totalPicksObserved || 0,
          draftsObserved: p?.draftsObserved?.length || 0,
          lastUpdated: p?.lastUpdated,
          // Win-window from cached league roster (league-specific context)
          winWindowLabel: cached.winWindowLabel || null,
          winWindowReason: cached.winWindowReason || null,
          positionalNeeds: cached.positionalNeeds || null,
          isCurrentUser: ownerId === userId,
        };
      });

      const enriched = await enrichProfilesWithDraftClass(baseEnriched);
      return res.json({ profiles: enriched, leagueId, totalLeaguemates: ownerIds.length - 1 });
    }

    // ── Default: all leaguemates across all leagues ───────────────────────
    const leagues = await sleeperService.getUserLeagues(userId).catch(() => []);

    // Collect all leaguemate Sleeper user IDs across all leagues
    const leaguemateIds = new Set();
    const userNameMap = {};
    for (const league of leagues) {
      try {
        const rosters = await sleeperService.getRosters(league.league_id);
        const usersMap = await sleeperService.buildUserMap(league.league_id).catch(() => ({}));
        for (const r of rosters) {
          if (r.owner_id && r.owner_id !== userId) {
            leaguemateIds.add(r.owner_id);
            if (usersMap[r.owner_id]) userNameMap[r.owner_id] = usersMap[r.owner_id];
          }
        }
      } catch { /* skip */ }
    }

    const profiles = await ManagerProfile.find({
      sleeperId: { $in: [...leaguemateIds] },
    }).lean();

    const profileMap = Object.fromEntries(profiles.map(p => [p.sleeperId, p]));
    const baseEnriched = [...leaguemateIds].map((sid) => {
      const p = profileMap[sid];
      const u = userNameMap[sid] || {};
      return {
        sleeperId: sid,
        username: p?.username || u.username || sid,
        teamName: u.teamName || null,
        scoutingNotes: p?.scoutingNotes || [],
        positionWeights: p?.positionWeights,
        earlyRoundPositionWeights: p?.earlyRoundPositionWeights,
        topColleges: Object.entries(p?.collegeAffinities || {})
          .sort(([, a], [, b]) => b - a).slice(0, 3).map(([name, count]) => ({ name, count })),
        topNflTeams: Object.entries(p?.nflTeamAffinities || {})
          .sort(([, a], [, b]) => b - a).slice(0, 3).map(([team, count]) => ({ team, count })),
        playerPickCounts: p?.playerPickCounts,
        totalPicksObserved: p?.totalPicksObserved || 0,
        draftsObserved: p?.draftsObserved?.length || 0,
        lastUpdated: p?.lastUpdated,
      };
    });

    const enriched = await enrichProfilesWithDraftClass(baseEnriched);
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

// GET /api/admin/manager-search?q=TEXT -- search any manager by username (not limited to leaguemates)
router.get('/manager-search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ profiles: [] });

    const profiles = await ManagerProfile.find({
      $or: [
        { username: { $regex: q, $options: 'i' } },
        { sleeperId: { $regex: q, $options: 'i' } },
      ],
    }).limit(20).lean();

    const baseEnriched = profiles.map(p => ({
      sleeperId: p.sleeperId,
      username: p.username,
      scoutingNotes: p.scoutingNotes || [],
      positionWeights: p.positionWeights,
      earlyRoundPositionWeights: p.earlyRoundPositionWeights,
      topColleges: Object.entries(p.collegeAffinities || {})
        .sort(([, a], [, b]) => b - a).slice(0, 3).map(([name, count]) => ({ name, count })),
      topNflTeams: Object.entries(p.nflTeamAffinities || {})
        .sort(([, a], [, b]) => b - a).slice(0, 3).map(([team, count]) => ({ team, count })),
      playerPickCounts: p.playerPickCounts,
      totalPicksObserved: p.totalPicksObserved || 0,
      draftsObserved: p.draftsObserved?.length || 0,
      lastUpdated: p.lastUpdated,
    }));

    const enriched = await enrichProfilesWithDraftClass(baseEnriched);
    res.json({ profiles: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/seed-rookies/:year -- seed a draft class if not already in DB
router.post('/seed-rookies/:year', requireAuth, async (req, res) => {
  const year = parseInt(req.params.year, 10);
  if (isNaN(year) || year < 2020 || year > 2030) {
    return res.status(400).json({ error: 'Invalid year' });
  }
  try {
    const existing = await Player.countDocuments({ nflDraftYear: year });
    if (existing > 0) {
      return res.json({ message: `${year} class already seeded (${existing} players found)`, seeded: 0 });
    }
    const { calculateDAS } = require('../services/scoringEngine');
    const seed = require(`../../data/rookieSeed${year}.json`);
    let count = 0;
    for (const p of seed) {
      const { score, breakdown } = calculateDAS(p);
      await Player.findOneAndUpdate(
        { name: p.name, position: p.position },
        { ...p, dasScore: score, dasBreakdown: breakdown, dataSource: 'seed' },
        { upsert: true }
      );
      count++;
    }
    res.json({ message: `Seeded ${count} players from ${year} class`, seeded: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/sync-sleeper-ids -- back-fill sleeperId on players missing one
router.post('/sync-sleeper-ids', requireAuth, async (req, res) => {
  try {
    const result = await runSyncSleeperIds();
    res.json({
      message: `Synced Sleeper IDs: ${result.updated} updated, ${result.notFound} not matched`,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/import-sleeper-players
// Upserts all skill-position players from Sleeper's /players/nfl into our DB.
router.post('/import-sleeper-players', requireAuth, async (req, res) => {
  try {
    const result = await importSleeperPlayers();
    res.json({
      message: `Import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped (non-skill pos)`,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
