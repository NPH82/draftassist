require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const { startScheduler } = require('./jobs/scheduler');
const { loadPlayerData } = require('./scrapers');

const PORT = process.env.PORT || 4000;

async function start() {
  await connectDB();

  // Seed player data on first start if DB is empty
  const Player = require('./models/Player');
  const count = await Player.countDocuments();
  if (count === 0) {
    console.log('[Server] No players in DB -- seeding from seed data...');
    try {
      const seed = require('../data/rookieSeed.json');
      const { calculateDAS } = require('./services/scoringEngine');
      for (const p of seed) {
        const { score, breakdown } = calculateDAS(p);
        await Player.findOneAndUpdate(
          { name: p.name, position: p.position },
          { ...p, dasScore: score, dasBreakdown: breakdown, dataSource: 'seed' },
          { upsert: true }
        );
      }
      console.log(`[Server] Seeded ${seed.length} players`);
    } catch (err) {
      console.warn('[Server] Seed file not found or failed:', err.message);
    }
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
