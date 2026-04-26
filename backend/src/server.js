require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const { startScheduler } = require('./jobs/scheduler');
const { importSleeperPlayers, syncSleeperIds } = require('./services/sleeperSync');

const PORT = process.env.PORT || 4000;

async function start() {
  await connectDB();

  // Seed player data on first start if DB is empty
  const Player = require('./models/Player');
  const { calculateDAS } = require('./services/scoringEngine');

  const seedFile = async (filename, label) => {
    try {
      const seed = require(`../data/${filename}`);
      for (const p of seed) {
        const { score, breakdown } = calculateDAS(p);
        await Player.findOneAndUpdate(
          { name: p.name, position: p.position },
          { ...p, dasScore: score, dasBreakdown: breakdown, dataSource: 'seed' },
          { upsert: true }
        );
      }
      console.log(`[Server] Seeded ${seed.length} ${label} players`);
    } catch (err) {
      console.warn(`[Server] Seed file ${filename} failed:`, err.message);
    }
  };

  const count = await Player.countDocuments();
  if (count === 0) {
    console.log('[Server] No players in DB -- seeding 2025 class...');
    await seedFile('rookieSeed.json', '2025');
  }

  const count2026 = await Player.countDocuments({ nflDraftYear: 2026 });
  if (count2026 === 0) {
    console.log('[Server] No 2026 players found -- seeding 2026 class...');
    await seedFile('rookieSeed2026.json', '2026');
  }

  // Import all skill-position veterans from Sleeper if the DB is sparse.
  // Threshold: if fewer than 500 players, the veteran import hasn't run yet.
  // importSleeperPlayers is safe to call repeatedly -- it only refreshes
  // team/age/injuryStatus on existing records and won't touch scraped values.
  const totalPlayers = await Player.countDocuments();
  if (totalPlayers < 500) {
    console.log(`[Server] Only ${totalPlayers} players in DB -- running Sleeper import...`);
    try {
      const importResult = await importSleeperPlayers();
      console.log(`[Server] Sleeper import done: ${importResult.created} created, ${importResult.updated} updated`);
    } catch (err) {
      console.warn('[Server] Sleeper import failed (non-fatal):', err.message);
    }
  }

  // Back-fill sleeperId for any seeded players that are still missing one.
  // Runs every startup -- it's a no-op when all IDs are already set.
  try {
    const syncResult = await syncSleeperIds();
    if (syncResult.updated > 0) {
      console.log(`[Server] Sleeper ID sync: ${syncResult.updated} matched`);
    }
  } catch (err) {
    console.warn('[Server] Sleeper ID sync failed (non-fatal):', err.message);
  }

  startScheduler();

  app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
