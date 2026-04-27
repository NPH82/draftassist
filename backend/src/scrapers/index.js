/**
 * Scraper orchestrator
 * Runs all scrapers and stores results in MongoDB with fallback on failure.
 */

const fantasyProsScraper = require('./fantasyProsScraper');
const keepTradeCutScraper = require('./keepTradeCutScraper');
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

/**
 * Refresh devy (college prospect) KTC values.
 * Called on-demand from admin; devy rankings change less frequently than dynasty.
 */
async function refreshDevyRankings() {
  const result = await runScraper('KTC-Devy', keepTradeCutScraper.fetchDevyValues);
  if (!result.ok || !result.data.length) return { ok: false, error: result.error };

  let matched = 0;
  for (const p of result.data) {
    const escapedName = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const res = await Player.findOneAndUpdate(
      {
        name: { $regex: new RegExp(`^${escapedName}$`, 'i') },
        isDevy: true,
      },
      {
        devyKtcValue: p.value,
        ...(p.college ? { college: p.college } : {}),
        ...(p.devyClass ? { devyClass: p.devyClass } : {}),
        lastUpdated: new Date(),
      },
      { upsert: false }
    ).catch(() => null);
    if (res) matched++;
  }

  console.log(`[Scraper] KTC-Devy: ${result.data.length} fetched, ${matched} matched to DB players`);
  return { ok: true, fetched: result.data.length, matched };
}

module.exports = { refreshDailyRankings, refreshDepthCharts, loadPlayerData, refreshDevyRankings };
