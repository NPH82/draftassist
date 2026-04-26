/**
 * Win Window Service
 * Computes Roster Maturity Score and win window label from a roster.
 */

const REBUILD_LABELS = {
  rebuilding: 'Rebuilding',
  transitioning: 'Transitioning',
  contending: 'Contending',
  winNow: 'Win Now',
};

/**
 * playerMap: { sleeperId -> { age, ktcValue, fantasyProsValue, position } }
 * picks: array of future pick objects from Sleeper
 * rosterPlayerIds: array of Sleeper player IDs on the roster
 */
function computeRosterMaturity(rosterPlayerIds, playerMap, futurePicks = []) {
  if (!rosterPlayerIds || rosterPlayerIds.length === 0) {
    return { score: 50, label: REBUILD_LABELS.transitioning, reason: 'No roster data available' };
  }

  const skillPositions = ['QB', 'RB', 'WR', 'TE'];
  const players = rosterPlayerIds
    .map(id => playerMap[id])
    .filter(p => p && skillPositions.includes(p.position));

  if (players.length === 0) {
    return { score: 50, label: REBUILD_LABELS.transitioning, reason: 'No mapped skill players' };
  }

  // 1. Average age of skill players (younger = more rebuilding)
  const ages = players.map(p => p.age).filter(Boolean);
  const avgAge = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : 25;

  // 2. Total KTC/FP value
  const totalValue = players.reduce((sum, p) => sum + (p.ktcValue || p.fantasyProsValue || 0), 0);
  const avgValue = players.length ? totalValue / players.length : 0;

  // 3. Ratio of established starters (age >= 24 and value >= 3000)
  const established = players.filter(p => p.age >= 24 && (p.ktcValue || 0) >= 3000);
  const establishedRatio = established.length / players.length;

  // 4. Future first-round picks (rebuild indicator if holding many)
  const firstRoundPicks = futurePicks.filter(p => p.round === 1 && p.season > new Date().getFullYear());
  const hasManyFuturePicks = firstRoundPicks.length >= 2;

  // ── Compute composite score (0-100; higher = more "win now") ──────────────
  let score = 0;

  // Age factor (0-30 pts): older average = more "win now"
  // Scale: age 22 = 0, age 30 = 30
  score += Math.min(30, Math.max(0, (avgAge - 22) / 8 * 30));

  // Value factor (0-30 pts)
  score += Math.min(30, avgValue / 10000 * 30);

  // Established ratio (0-30 pts)
  score += establishedRatio * 30;

  // Future picks penalty (rebuilding signal)
  if (hasManyFuturePicks) score -= 15;

  score = Math.max(0, Math.min(100, score));

  // ── Label ─────────────────────────────────────────────────────────────────
  let label, reason;
  if (score < 25) {
    label = REBUILD_LABELS.rebuilding;
    reason = `Rebuilding -- young roster (avg age ${avgAge.toFixed(1)}) with limited established starters`;
  } else if (score < 50) {
    label = REBUILD_LABELS.transitioning;
    reason = `Transitioning -- mix of young and established players`;
  } else if (score < 75) {
    label = REBUILD_LABELS.contending;
    reason = `Contending -- strong established core with upside`;
  } else {
    label = REBUILD_LABELS.winNow;
    reason = `Win Now -- veteran-heavy roster with high trade value`;
  }

  return { score: Math.round(score), label, reason };
}

/**
 * Returns a positional need map: { QB: 'low'|'medium'|'high', WR: ..., ... }
 * based on how thin the roster is at each position.
 */
function analyzePositionalNeeds(rosterPlayerIds, playerMap, rosterPositions = []) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const id of rosterPlayerIds) {
    const p = playerMap[id];
    if (p && counts[p.position] !== undefined) counts[p.position]++;
  }

  // In SuperFlex leagues (SUPER_FLEX slot present) QBs are started 2x so target 2;
  // in standard leagues only 1 QB is started so 1 rostered is sufficient.
  const isSuperFlex = Array.isArray(rosterPositions) &&
    rosterPositions.some(pos => typeof pos === 'string' && pos.toUpperCase() === 'SUPER_FLEX');
  const targets = { QB: isSuperFlex ? 2 : 1, RB: 5, WR: 6, TE: 2 };
  const needs = {};
  for (const pos of Object.keys(targets)) {
    const ratio = counts[pos] / targets[pos];
    if (ratio < 0.5) needs[pos] = 'high';
    else if (ratio < 0.8) needs[pos] = 'medium';
    else needs[pos] = 'low';
  }

  return needs;
}

module.exports = { computeRosterMaturity, analyzePositionalNeeds };
