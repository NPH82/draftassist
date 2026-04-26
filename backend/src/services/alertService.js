/**
 * Alert Service
 * Generates faller alerts during drafts and buy/sell alerts in off-season.
 */

const RankingSnapshot = require('../models/RankingSnapshot');

const FALLER_THRESHOLD = 3;       // picks past projected = faller
const BUY_SELL_THRESHOLD = 0.15;  // 15% value change = alert

/**
 * Generate buy/sell alerts for a user's roster.
 * @param {object[]} rosterPlayerIds - Sleeper player IDs on the roster
 * @param {object} playerMap - { sleeperId -> player }
 * @param {number} lookbackDays - How many days to look back for trend
 */
async function generateBuySellAlerts(rosterPlayerIds, playerMap, lookbackDays = 30) {
  const alerts = [];
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  for (const playerId of rosterPlayerIds) {
    const player = playerMap[playerId];
    if (!player) continue;

    // Get KTC snapshots for this player
    const snapshots = await RankingSnapshot.find({
      playerId: { $in: [playerId, player.name] },
      source: 'ktc',
      snapshotDate: { $gte: cutoff },
    }).sort({ snapshotDate: 1 }).lean();

    if (snapshots.length < 2) continue;

    const oldest = snapshots[0].value;
    const newest = snapshots[snapshots.length - 1].value;
    if (!oldest || oldest === 0) continue;

    const changePct = (newest - oldest) / oldest;

    if (changePct >= BUY_SELL_THRESHOLD) {
      alerts.push({
        type: 'sell',
        player: { id: playerId, name: player.name, position: player.position },
        message: `Sell high: ${player.name}'s KTC value up ${Math.round(changePct * 100)}% in ${lookbackDays} days`,
        changePct,
        lookbackDays,
      });
    } else if (changePct <= -BUY_SELL_THRESHOLD) {
      alerts.push({
        type: 'buy',
        player: { id: playerId, name: player.name, position: player.position },
        message: `Buy low: ${player.name}'s KTC value down ${Math.round(Math.abs(changePct) * 100)}% in ${lookbackDays} days`,
        changePct,
        lookbackDays,
      });
    }
  }

  return alerts;
}

module.exports = { generateBuySellAlerts, FALLER_THRESHOLD };
