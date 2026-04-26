/**
 * Scheduled jobs
 * Uses node-cron for periodic data refresh.
 */

const cron = require('node-cron');
const { refreshDailyRankings, refreshDepthCharts } = require('../scrapers');
const { importSleeperPlayers, syncSleeperIds } = require('../services/sleeperSync');

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

  // Weekly: Sunday 2am -- re-import Sleeper player list to keep team/age/injury current
  // and back-fill any sleeperId gaps (e.g. newly added rookies after a draft).
  cron.schedule('0 2 * * 0', async () => {
    console.log('[Scheduler] Starting weekly Sleeper player sync...');
    try {
      const importResult = await importSleeperPlayers();
      console.log(`[Scheduler] Sleeper import done: ${importResult.created} created, ${importResult.updated} updated`);
      const syncResult = await syncSleeperIds();
      console.log(`[Scheduler] Sleeper ID sync done: ${syncResult.updated} matched`);
    } catch (err) {
      console.error('[Scheduler] Sleeper sync failed:', err.message);
    }
  });

  console.log('[Scheduler] Jobs registered: daily rankings (3am), weekly depth charts (Mon 4am), weekly Sleeper sync (Sun 2am)');
}

module.exports = { startScheduler };
