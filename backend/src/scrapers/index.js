/**
 * Scraper orchestrator
 * Runs all scrapers and stores results in MongoDB with fallback on failure.
 */

const fantasyProsScraper = require('./fantasyProsScraper');
const googleSheetDevyScraper = require('./googleSheetDevyScraper');
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

function sanitizeDevyName(name) {
  return String(name || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    // Remove trailing trend artifacts like "+754" / "-120"
    .replace(/\s+[+-]\d+\s*$/g, '')
    .trim();
}

function scoreDevyRecord(record = {}) {
  return (
    (record.sheetRank ? 100000 - record.sheetRank : 0) +
    (record.devyKtcRank ? 50000 - record.devyKtcRank : 0) +
    Number(record.devyKtcValue || 0) +
    (record.bigBoardRank ? 5000 - record.bigBoardRank : 0) +
    (record.sleeperId ? 250 : 0) +
    (record.college ? 25 : 0)
  );
}

async function dedupeDevyPlayers() {
  const records = await Player.find({ isDevy: true })
    .select('_id name position college devyClass devyKtcValue devyKtcRank devyFpRank bigBoardRank sheetRank sheetRating sheetAvgOvrRank sleeperId athletics dataSource')
    .lean();

  const groups = new Map();
  for (const record of records) {
    const key = devyNorm(record.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  let deduped = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const ordered = group.slice().sort((a, b) => scoreDevyRecord(b) - scoreDevyRecord(a));
    const primary = ordered[0];
    const secondary = ordered.slice(1);
    const merged = {
      name: sanitizeDevyName(primary.name),
      position: primary.position,
      college: primary.college || null,
      devyClass: primary.devyClass || null,
      devyKtcValue: primary.devyKtcValue || null,
      devyKtcRank: primary.devyKtcRank || null,
      devyFpRank: primary.devyFpRank || null,
      bigBoardRank: primary.bigBoardRank || null,
      sheetRank: primary.sheetRank || null,
      sheetRating: primary.sheetRating || null,
      sheetAvgOvrRank: primary.sheetAvgOvrRank || null,
      sleeperId: primary.sleeperId || null,
      athletics: primary.athletics || undefined,
      isDevy: true,
      isRookie: false,
      dataSource: primary.dataSource || 'devy-scrape',
      lastUpdated: new Date(),
    };

    for (const record of secondary) {
      if (!merged.sheetRank && record.sheetRank) merged.sheetRank = record.sheetRank;
      if (!merged.sheetRating && record.sheetRating) merged.sheetRating = record.sheetRating;
      if (!merged.sheetAvgOvrRank && record.sheetAvgOvrRank) merged.sheetAvgOvrRank = record.sheetAvgOvrRank;
      if (!merged.devyKtcRank && record.devyKtcRank) merged.devyKtcRank = record.devyKtcRank;
      if (!merged.devyKtcValue && record.devyKtcValue) merged.devyKtcValue = record.devyKtcValue;
      if (!merged.bigBoardRank && record.bigBoardRank) merged.bigBoardRank = record.bigBoardRank;
      if (!merged.devyFpRank && record.devyFpRank) merged.devyFpRank = record.devyFpRank;
      if (!merged.college && record.college) merged.college = record.college;
      if (!merged.devyClass && record.devyClass) merged.devyClass = record.devyClass;
      if (!merged.sleeperId && record.sleeperId) merged.sleeperId = record.sleeperId;
      if (!merged.athletics?.fortyTime && record.athletics?.fortyTime) merged.athletics = record.athletics;
    }

    await Player.updateOne({ _id: primary._id }, { $set: merged }).catch(() => {});
    await Player.deleteMany({ _id: { $in: secondary.map((record) => record._id) } }).catch(() => {});
    deduped += secondary.length;
  }

  return deduped;
}

/**
 * Refresh devy (college prospect) rankings from four sources:
 *   1. KeepTradeCut API  — value/rank comparison for fantasy-relevant devy assets
 *   2. NFL Mock Draft DB  — draft projection and college metadata
 *   3. FantasyPros       — supplementary devy rank
 *   4. Google Sheet      — source of truth for ranking order and all-position inclusion
 *
 * Unlike the old version this function UPSERTS new records so the devy pool
 * is seeded from real rankings data rather than relying on Sleeper alone.
 * Existing non-devy players (e.g. veterans) are never overwritten with isDevy.
 */
async function refreshDevyRankings() {
  const devyYear = new Date().getFullYear() + 1; // default to next draft class (2027)

  // Clean malformed names created by older HTML parsing logic.
  const possiblyNoisy = await Player.find({ isDevy: true, dataSource: 'devy-scrape' })
    .select('_id name')
    .lean();
  for (const p of possiblyNoisy) {
    const cleaned = sanitizeDevyName(p.name);
    if (cleaned && cleaned !== p.name) {
      await Player.updateOne({ _id: p._id }, { $set: { name: cleaned } }).catch(() => {});
    }
  }

  // Fetch all sources in parallel; failures are non-fatal
  const [ktcResult, nflmdbResult, fpResult, sheetResult] = await Promise.all([
    runScraper('KTC-Devy', keepTradeCutScraper.fetchDevyValues),
    runScraper('NFLMDB-BigBoard', () => nflMockDraftScraper.fetchBigBoard(devyYear)),
    runScraper('FP-Devy', fantasyProsScraper.fetchDevyRankings),
    runScraper('GoogleSheet-Devy', googleSheetDevyScraper.fetchDevyRankingsSheet),
  ]);

  if (!ktcResult.ok && !nflmdbResult.ok && !sheetResult.ok) {
    return { ok: false, error: 'KTC, NFLMDB, and GoogleSheet all failed — no devy data available' };
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

  const sheetMap = {};
  for (const p of (sheetResult.data || [])) {
    sheetMap[devyNorm(p.name)] = p;
  }

  let created = 0;
  let updated = 0;

  // ── Pass 1: KTC is primary ──────────────────────────────────────────────
  for (const p of (ktcResult.data || [])) {
    if (!p.name || !DEVY_SKILL_POSITIONS.has(p.position)) continue;

    const cleanName = sanitizeDevyName(p.name);

    const key = devyNorm(cleanName);
    const nflmdb = nflmdbMap[key] || {};
    const fp = fpMap[key] || {};

    const escapedName = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        name: cleanName,
        position: p.position,
        devyKtcValue: p.value,
        devyKtcRank: p.rank || null,
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
          name: cleanName,
          position: p.position,
          team: null,
          college: college || null,
          devyKtcValue: p.value,
          devyKtcRank: p.rank || null,
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

  // ── Pass 2: NFLMDB — augment existing devy players OR create when KTC missed them ─
  for (const p of (nflmdbResult.data || [])) {
    if (!p.name || !DEVY_SKILL_POSITIONS.has(p.position)) continue;

    const cleanName = sanitizeDevyName(p.name);

    const key = devyNorm(cleanName);
    const fp = fpMap[key] || {};
    const escapedName = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await Player.findOne({
      name: { $regex: new RegExp(`^${escapedName}$`, 'i') },
    }).lean();

    if (existing) {
      // Never promote a known active veteran to isDevy
      if (existing.isDevy === false && existing.team) continue;
      await Player.updateOne(
        { _id: existing._id },
        {
          $set: {
            name: cleanName,
            position: p.position,
            isDevy: true,
            bigBoardRank: p.bigBoardRank,
            ...(p.college   ? { college: p.college }     : {}),
            ...(p.devyClass ? { devyClass: p.devyClass } : {}),
            ...(fp.rank     ? { devyFpRank: fp.rank }    : {}),
            lastUpdated: new Date(),
          },
        }
      ).catch(() => {});
      // Only count as updated if KTC didn't already handle it
      if (!ktcResult.ok) updated++;
    } else {
      // KTC failed or didn't have this player — create from NFLMDB
      try {
        await Player.create({
          name: cleanName,
          position: p.position,
          team: null,
          college: p.college || null,
          bigBoardRank: p.bigBoardRank || null,
          devyClass: p.devyClass || null,
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

  // ── Pass 3: Google Sheet — source of truth for rank order and all-position coverage ─
  for (const p of (sheetResult.data || [])) {
    if (!p.name || !p.position) continue;

    const cleanName = sanitizeDevyName(p.name);
    const key = devyNorm(cleanName);
    const nflmdb = nflmdbMap[key] || {};
    const fp = fpMap[key] || {};
    const escapedName = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await Player.findOne({
      name: { $regex: new RegExp(`^${escapedName}$`, 'i') },
    }).lean();

    const setFields = {
      name: cleanName,
      position: p.position,
      isDevy: true,
      sheetRank: p.sheetRank,
      lastUpdated: new Date(),
    };
    if (p.rating !== null)     setFields.sheetRating   = p.rating;
    if (p.avgOvrRank !== null) setFields.sheetAvgOvrRank = p.avgOvrRank;
    if (p.fortyTime !== null)  setFields['athletics.fortyTime'] = p.fortyTime;
    if (fp.rank)               setFields.devyFpRank     = fp.rank;
    if (nflmdb.bigBoardRank)   setFields.bigBoardRank   = nflmdb.bigBoardRank;
    if (nflmdb.college)        setFields.college        = nflmdb.college;
    if (nflmdb.devyClass)      setFields.devyClass      = nflmdb.devyClass;

    if (existing) {
      if (existing.isDevy === false && existing.team) continue;
      await Player.updateOne({ _id: existing._id }, { $set: setFields }).catch(() => {});
      updated++;
    } else {
      try {
        await Player.create({
          name: cleanName,
          position: p.position,
          team: null,
          college: nflmdb.college || null,
          sheetRank: p.sheetRank,
          sheetRating: p.rating || null,
          sheetAvgOvrRank: p.avgOvrRank || null,
          athletics: p.fortyTime !== null ? { fortyTime: p.fortyTime } : undefined,
          devyClass: nflmdb.devyClass || null,
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

  const deduped = await dedupeDevyPlayers();

  // Sweep out any devy players whose draft class has already passed.
  // Scraper-sourced records use devyClass (not nflDraftYear), so this is the
  // authoritative graduation check for the available pool.
  const graduationYear = new Date().getFullYear();
  const graduationResult = await Player.updateMany(
    {
      isDevy: true,
      devyClass: { $lte: graduationYear },
    },
    { $set: { isDevy: false, lastUpdated: new Date() } }
  ).catch((e) => {
    console.warn('[Scraper] refreshDevyRankings: graduation sweep failed:', e.message);
    return { modifiedCount: 0 };
  });
  const graduated = graduationResult.modifiedCount || 0;
  if (graduated > 0) {
    console.log(`[Scraper] refreshDevyRankings: cleared isDevy from ${graduated} graduated players (devyClass <= ${graduationYear})`);
  }

  console.log(
    `[Scraper] refreshDevyRankings: ${created} created, ${updated} updated, ${deduped} deduped, ${graduated} graduated ` +
    `| KTC: ${ktcResult.data?.length ?? 0} | NFLMDB: ${nflmdbResult.data?.length ?? 0}` +
    ` | FP: ${fpResult.data?.length ?? 0} | Sheet: ${sheetResult.data?.length ?? 0}`
  );
  return {
    ok: true,
    created,
    updated,
    deduped,
    graduated,
    sources: {
      ktc:    { ok: ktcResult.ok,    count: ktcResult.data?.length ?? 0 },
      nflmdb: { ok: nflmdbResult.ok, count: nflmdbResult.data?.length ?? 0 },
      fp:     { ok: fpResult.ok,     count: fpResult.data?.length ?? 0 },
      sheet:  { ok: sheetResult.ok,  count: sheetResult.data?.length ?? 0 },
    },
  };
}

module.exports = { refreshDailyRankings, refreshDepthCharts, loadPlayerData, refreshDevyRankings };
