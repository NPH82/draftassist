require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const DevyDiscrepancyReport = require('../src/models/DevyDiscrepancyReport');
const Player = require('../src/models/Player');

(async () => {
  await connectDB();
  const currentYear = new Date().getFullYear();

  // ── Step 1: Show what's being graduated ───────────────────────────────────
  const toGraduate = await Player.find({
    isDevy: true,
    $or: [
      { devyClass: { $lte: currentYear } },
      { nflDraftYear: { $lte: currentYear } },
    ],
  }).select('name sleeperId position devyClass nflDraftYear team').lean();

  console.log(`\n=== DEVY PLAYERS TO GRADUATE (devyClass or nflDraftYear <= ${currentYear}) ===`);
  for (const p of toGraduate) {
    console.log(`  "${p.name}" pos=${p.position} devyClass=${p.devyClass} nflDraftYear=${p.nflDraftYear} sleeperId=${p.sleeperId}`);
  }
  console.log(`  Total to graduate: ${toGraduate.length}`);

  // ── Step 2: Apply fix-devy-flags by devyClass (no Sleeper needed) ─────────
  const fixResult = await Player.updateMany(
    {
      isDevy: true,
      $or: [
        { devyClass: { $lte: currentYear } },
        { nflDraftYear: { $lte: currentYear } },
      ],
    },
    { $set: { isDevy: false, lastUpdated: new Date() } }
  );
  console.log(`\n=== GRADUATION FIX APPLIED ===`);
  console.log(`  Cleared isDevy from ${fixResult.modifiedCount} players`);

  // ── Step 3: Open discrepancy reports — mark resolved if player is now gone ─
  const reports = await DevyDiscrepancyReport.find({ status: 'open' })
    .select('playerName playerSleeperId leagueId')
    .lean();
  console.log(`\n=== OPEN DISCREPANCY REPORTS (${reports.length}) ===`);
  for (const r of reports) {
    console.log(`  "${r.playerName}" sleeperId=${r.playerSleeperId} league=${r.leagueId}`);
  }

  // ── Step 4: Summary ───────────────────────────────────────────────────────
  const remaining = await Player.countDocuments({ isDevy: true });
  const noClass = await Player.countDocuments({ isDevy: true, devyClass: null, nflDraftYear: null });
  console.log(`\n=== AFTER FIX ===`);
  console.log(`  Remaining isDevy players: ${remaining}`);
  console.log(`  isDevy with no class/year (scraper-sourced orphans): ${noClass}`);

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
