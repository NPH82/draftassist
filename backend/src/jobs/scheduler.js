/**
 * Scheduled jobs
 * Uses node-cron for periodic data refresh.
 */

const cron = require('node-cron');
const { refreshDailyRankings, refreshDepthCharts, loadPlayerData } = require('../scrapers');

function startScheduler() {
  // Daily: 3am -- refresh FantasyPros, KTC, Underdog ADP
  cron.schedule('0 3 * * *', async () => {
    console.log('[Scheduler] Starting daily rankings refresh...');
    try {
      const result = await refreshDailyRankings();
      console.log('[Scheduler] Daily rankings done:', result);
    } catch (err) {
      console.error('[Scheduler] Daily rankings failed:', err.message);
    }
  });

  // Weekly: Monday 4am -- refresh OurLads depth charts
  cron.schedule('0 4 * * 1', async () => {
    console.log('[Scheduler] Starting weekly depth chart refresh...');
    try {
      const result = await refreshDepthCharts();
      console.log('[Scheduler] Depth charts done:', result);
    } catch (err) {
      console.error('[Scheduler] Depth charts failed:', err.message);
    }
  });

  console.log('[Scheduler] Jobs registered: daily rankings (3am), weekly depth charts (Mon 4am)');
}

module.exports = { startScheduler };
