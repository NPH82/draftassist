/**
 * Scraper orchestrator
 * Runs all scrapers and stores results in MongoDB with fallback on failure.
 */

const fantasyProsScraper = require('./fantasyProsScraper');
const keepTradeCutScraper = require('./keepTradeCutScraper');
const nflMockDraftScraper = require('./nflMockDraftScraper');
const ourLadsScraper = require('./ourLadsScraper');
const pfrScraper = require('./pfrScraper');
const espnScraper = require('./espnScraper');
const rotowireScraper = require('./rotowireScraper');
const underdogScraper = require('./underdogScraper');
const Player = require('../models/Player');
const RankingSnapshot = require('../models/RankingSnapshot');

async function runScraper(name, fn) {
  try {
    const result = await fn();
    console.log(`[Scraper] ${name} -- OK (${Array.isArray(result) ? result.length : Object.keys(result || {}).length} records)`);
    return { ok: true, data: result };
  } catch (err) {
    console.warn(`[Scraper] ${name} -- FAILED: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Daily rankings refresh (FantasyPros, KTC, Underdog ADP)
async function refreshDailyRankings() {
  const [fp, ktc, udg] = await Promise.all([
    runScraper('FantasyPros', fantasyProsScraper.fetchDynastyRankings),
    runScraper('KTC', keepTradeCutScraper.fetchDynastyValues),
    runScraper('Underdog', underdogScraper.fetchAdp),
  ]);

  // Persist FP rankings
  if (fp.ok && fp.data.length > 0) {
    const snapshots = fp.data.map(p => ({
      playerId: p.sleeperId || p.name,
      playerName: p.name,
      source: 'fantasypros',
      value: p.value,
      rank: p.rank,
    }));
    await RankingSnapshot.insertMany(snapshots, { ordered: false }).catch(() => {});
    for (const p of fp.data) {
      await Player.findOneAndUpdate(
        { name: { $regex: new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
        { fantasyProsValue: p.value, fantasyProsRank: p.rank, 'lastUpdated': new Date() },
        { upsert: false }
      ).catch(() => {});
    }
  }

  // Persist KTC values
  if (ktc.ok && ktc.data.length > 0) {
    const snapshots = ktc.data.map(p => ({
      playerId: p.sleeperId || p.name,
      playerName: p.name,
      source: 'ktc',
      value: p.value,
      rank: p.rank,
    }));
    await RankingSnapshot.insertMany(snapshots, { ordered: false }).catch(() => {});
    for (const p of ktc.data) {
      await Player.findOneAndUpdate(
        { name: { $regex: new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
        { ktcValue: p.value, ktcRank: p.rank, lastUpdated: new Date() },
        { upsert: false }
      ).catch(() => {});
    }
  }

  // Persist Underdog ADP
  if (udg.ok && udg.data.length > 0) {
    for (const p of udg.data) {
      await Player.findOneAndUpdate(
        { name: { $regex: new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
        { underdogAdp: p.adp, lastUpdated: new Date() },
        { upsert: false }
      ).catch(() => {});
    }
  }

  return { fp: fp.ok, ktc: ktc.ok, udg: udg.ok };
}

// Weekly depth chart refresh (OurLads)
async function refreshDepthCharts() {
  const result = await runScraper('OurLads', ourLadsScraper.fetchDepthCharts);
  if (!result.ok) return { ok: false };

  for (const entry of result.data) {
    await Player.findOneAndUpdate(
      { sleeperId: entry.sleeperId },
      { depthChartPosition: entry.depthRank, lastUpdated: new Date() },
      { upsert: false }
    ).catch(() => {});
  }
  return { ok: true, count: result.data.length };
}

// One-time player data load (PFR + RotoWire + ESPN draft results)
async function loadPlayerData() {
  // Fetch all data
  const [combine, receiving, rushing, espn, roto] = await Promise.all([
    runScraper('Combine', () => pfrScraper.fetchCombineData()),
    runScraper('CollegeReceiving', () => pfrScraper.fetchCollegeReceivingStats()),
    runScraper('CollegeRushing', () => pfrScraper.fetchCollegeRushingStats()),
    runScraper('ESPN', espnScraper.fetchDraftResults),
    runScraper('RotoWire', rotowireScraper.fetchCollegeInjuries),
  ]);

  // Index by name for matching
  const combineMap = Object.fromEntries((combine.data || []).map(p => [p.name.toLowerCase(), p]));
  const recMap = Object.fromEntries((receiving.data || []).map(p => [p.name.toLowerCase(), p]));
  const rushMap = Object.fromEntries((rushing.data || []).map(p => [p.name.toLowerCase(), p]));

  // Update all rookies in DB with new data
  const rookies = await Player.find({ nflDraftYear: { $gte: 2025 } });
  for (const player of rookies) {
    const nameKey = player.name.toLowerCase();
    const combine = combineMap[nameKey];
    const rec = recMap[nameKey];
    const rush = rushMap[nameKey];

    const update = {};
    if (combine) {
      update["athletics.fortyTime"] = combine.fortyTime;
      update["athletics.verticalJump"] = combine.verticalJump;
      // broadJump could be added if modeled
    }
    if (rec) {
      update.collegeYardsPerRec = rec.collegeYardsPerRec;
      update.collegeTDs = rec.collegeTDs;
      update.collegeReceptions = rec.rec;
    }
    if (rush) {
      update.collegeRushYpc = rush.collegeRushYpc;
    }
    if (Object.keys(update).length > 0) {
      await Player.updateOne({ _id: player._id }, { $set: update });
    }
  }

  return { combine: combine.ok, receiving: receiving.ok, rushing: rushing.ok, espn: espn.ok, roto: roto.ok };
}

const DEVY_SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

// Normalise for fuzzy name matching
function devyNorm(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Refresh devy (college prospect) rankings from three sources:
 *   1. KeepTradeCut API  — primary: fantasy values, draft-class year
 *   2. NFL Mock Draft DB  — secondary: NFL draft projection, full college name
 *   3. FantasyPros       — supplementary: devyFpRank
 *
 * Unlike the old version this function UPSERTS new records so the devy pool
 * is seeded from real rankings data rather than relying on Sleeper alone.
 * Existing non-devy players (e.g. veterans) are never overwritten with isDevy.
 */
async function refreshDevyRankings() {
  const devyYear = new Date().getFullYear() + 1; // default to next draft class (2027)

  // Fetch all sources in parallel; failures are non-fatal
  const [ktcResult, nflmdbResult, fpResult] = await Promise.all([
    runScraper('KTC-Devy', keepTradeCutScraper.fetchDevyValues),
    runScraper('NFLMDB-BigBoard', () => nflMockDraftScraper.fetchBigBoard(devyYear)),
    runScraper('FP-Devy', fantasyProsScraper.fetchDevyRankings),
  ]);

  if (!ktcResult.ok && !nflmdbResult.ok) {
    return { ok: false, error: 'KTC and NFLMDB both failed — no devy data available' };
  }

  // Build lookup maps keyed by normalised name
  const nflmdbMap = {};
  for (const p of (nflmdbResult.data || [])) {
    nflmdbMap[devyNorm(p.name)] = p;
  }

  const fpMap = {};
  for (const p of (fpResult.data || [])) {
    fpMap[devyNorm(p.name)] = p;
  }

  let created = 0;
  let updated = 0;

  // ── Pass 1: KTC is primary ──────────────────────────────────────────────
  for (const p of (ktcResult.data || [])) {
    if (!p.name || !DEVY_SKILL_POSITIONS.has(p.position)) continue;

    const key = devyNorm(p.name);
    const nflmdb = nflmdbMap[key] || {};
    const fp = fpMap[key] || {};

    const escapedName = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await Player.findOne({
      name: { $regex: new RegExp(`^${escapedName}$`, 'i') },
    }).lean();

    const devyClass = p.devyClass || nflmdb.devyClass || null;
    const college   = nflmdb.college || p.college || null;

    if (existing) {
      // Never promote a known veteran (years_exp > 0) to isDevy
      if (existing.isDevy === false && existing.team) {
        // Active NFL player — skip
        continue;
      }
      const setFields = {
        devyKtcValue: p.value,
        isDevy: true,
        isRookie: false,
        lastUpdated: new Date(),
      };
      if (devyClass)              setFields.devyClass    = devyClass;
      if (college)                setFields.college      = college;
      if (nflmdb.bigBoardRank)    setFields.bigBoardRank = nflmdb.bigBoardRank;
      if (fp.rank)                setFields.devyFpRank   = fp.rank;
      await Player.updateOne({ _id: existing._id }, { $set: setFields });
      updated++;
    } else {
      // Brand-new devy prospect — create record
      try {
        await Player.create({
          name: p.name,
          position: p.position,
          team: null,
          college: college || null,
          devyKtcValue: p.value,
          devyClass: devyClass || null,
          bigBoardRank: nflmdb.bigBoardRank || null,
          devyFpRank: fp.rank || null,
          isDevy: true,
          isRookie: false,
          ktcValue: 0,
          fantasyProsValue: 0,
          dataSource: 'devy-scrape',
        });
        created++;
      } catch (e) {
        // duplicate key or validation error — skip silently
      }
    }
  }

  // ── Pass 2: Augment from NFLMDB for any devy player KTC may have missed ─
  for (const p of (nflmdbResult.data || [])) {
    const key = devyNorm(p.name);
    const escapedName = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await Player.updateOne(
      { name: { $regex: new RegExp(`^${escapedName}$`, 'i') }, isDevy: true },
      {
        $set: {
          bigBoardRank: p.bigBoardRank,
          ...(p.college    ? { college: p.college }       : {}),
          ...(p.devyClass  ? { devyClass: p.devyClass }   : {}),
          lastUpdated: new Date(),
        },
      },
      { upsert: false }
    ).catch(() => {});
  }

  console.log(
    `[Scraper] refreshDevyRankings: ${created} created, ${updated} updated ` +
    `| KTC: ${ktcResult.data?.length ?? 0} | NFLMDB: ${nflmdbResult.data?.length ?? 0} | FP: ${fpResult.data?.length ?? 0}`
  );
  return {
    ok: true,
    created,
    updated,
    sources: {
      ktc:    { ok: ktcResult.ok,    count: ktcResult.data?.length ?? 0 },
      nflmdb: { ok: nflmdbResult.ok, count: nflmdbResult.data?.length ?? 0 },
      fp:     { ok: fpResult.ok,     count: fpResult.data?.length ?? 0 },
    },
  };
}

module.exports = { refreshDailyRankings, refreshDepthCharts, loadPlayerData, refreshDevyRankings };
