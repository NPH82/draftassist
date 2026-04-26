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

// POST /api/admin/sync-sleeper-ids -- fetch Sleeper player DB and back-fill sleeperId on our players
router.post('/sync-sleeper-ids', requireAuth, async (req, res) => {
  try {
    const { getAllPlayers } = require('../services/sleeperService');
    // Fetch all ~8000 NFL players from Sleeper (large payload -- ~2 MB)
    const sleeperMap = await getAllPlayers('nfl');

    // Build lookup: normalised "full_name|POSITION" -> sleeperId
    const lookup = {};
    for (const [id, p] of Object.entries(sleeperMap)) {
      if (!p.full_name || !p.position) continue;
      const key = `${p.full_name.toLowerCase().trim()}|${p.position.toUpperCase()}`;
      lookup[key] = id;
      // Also index first_last without suffix (handles "Jr." mismatches)
      const bare = p.full_name.toLowerCase().replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '').trim();
      if (bare !== p.full_name.toLowerCase().trim()) {
        lookup[`${bare}|${p.position.toUpperCase()}`] = id;
      }
    }

    // Find players in our DB that are missing a sleeperId
    const players = await Player.find({ $or: [{ sleeperId: null }, { sleeperId: '' }, { sleeperId: { $exists: false } }] }).lean();

    let updated = 0;
    let notFound = 0;
    const missed = [];

    for (const player of players) {
      const key = `${player.name.toLowerCase().trim()}|${player.position.toUpperCase()}`;
      const bare = player.name.toLowerCase().replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '').trim() + `|${player.position.toUpperCase()}`;
      const sid = lookup[key] || lookup[bare];
      if (sid) {
        await Player.updateOne({ _id: player._id }, { sleeperId: sid });
        updated++;
      } else {
        notFound++;
        missed.push(`${player.name} (${player.position})`);
      }
    }

    res.json({
      message: `Synced Sleeper IDs: ${updated} updated, ${notFound} not matched`,
      updated,
      notFound,
      unmatched: missed.slice(0, 20), // first 20 for debug
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/import-sleeper-players
// Upserts all skill-position players from Sleeper's /players/nfl into our DB.
// Safe to re-run: only overwrites team/age/injuryStatus, never touches
// ktcValue/fantasyProsValue/dasScore that scrapers have already set.
router.post('/import-sleeper-players', requireAuth, async (req, res) => {
  const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
  try {
    const { getAllPlayers } = require('../services/sleeperService');
    const sleeperMap = await getAllPlayers('nfl');

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const [id, sp] of Object.entries(sleeperMap)) {
      if (!sp.position || !SKILL_POSITIONS.has(sp.position)) { skipped++; continue; }
      const fullName = (sp.full_name || `${sp.first_name || ''} ${sp.last_name || ''}`).trim();
      if (!fullName) { skipped++; continue; }

      const result = await Player.findOneAndUpdate(
        { sleeperId: id },
        {
          // Always refresh these -- they change during the season
          $set: {
            team: sp.team || null,
            age: sp.age || null,
            currentInjuryStatus: sp.injury_status || 'Active',
          },
          // Only set on first insert -- don't overwrite scraped values
          $setOnInsert: {
            sleeperId: id,
            name: fullName,
            position: sp.position,
            ktcValue: 0,
            fantasyProsValue: 0,
          },
        },
        { upsert: true, returnDocument: 'after' }
      );

      if (result.ktcValue === 0 && result.fantasyProsValue === 0) {
        created++;
      } else {
        updated++;
      }
    }

    res.json({
      message: `Import complete: ${created} created, ${updated} updated, ${skipped} skipped (non-skill pos)`,
      created,
      updated,
      skipped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
