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

function countSkillPlayers(rosterPlayerIds, playerMap) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const id of rosterPlayerIds || []) {
    const p = playerMap[id];
    if (p && counts[p.position] !== undefined) counts[p.position]++;
  }
  return counts;
}

function detectTePremium(scoringSettings = {}) {
  const teRec = Number(scoringSettings.rec_te || 0);
  const rec = Number(scoringSettings.rec || 0);
  const teBonus = Number(scoringSettings.bonus_rec_te || 0);
  return teRec > rec || teBonus > 0;
}

function getStarterSpots(rosterPositions = []) {
  const starters = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const positions = Array.isArray(rosterPositions) ? rosterPositions : [];

  for (const slot of positions) {
    const pos = String(slot || '').toUpperCase();
    if (pos === 'QB') starters.QB += 1;
    else if (pos === 'RB') starters.RB += 1;
    else if (pos === 'WR') starters.WR += 1;
    else if (pos === 'TE') starters.TE += 1;
    else if (pos === 'SUPER_FLEX') {
      starters.QB += 1;
      starters.RB += 0.25;
      starters.WR += 0.25;
      starters.TE += 0.1;
    } else if (pos.includes('FLEX')) {
      // FLEX slots can usually be filled by RB/WR/TE (or variants like WRRB_FLEX)
      if (pos === 'FLEX' || pos.includes('RB')) starters.RB += 0.5;
      if (pos === 'FLEX' || pos.includes('WR')) starters.WR += 0.5;
      if (pos === 'FLEX' || pos.includes('TE')) starters.TE += 0.3;
      if (pos.includes('QB')) starters.QB += 0.35;
    }
  }

  return starters;
}

function buildRosterComposition(rosterPlayerIds, playerMap, rosterPositions = [], scoringSettings = {}) {
  const counts = countSkillPlayers(rosterPlayerIds, playerMap);
  const starterSpots = getStarterSpots(rosterPositions);

  const isSuperFlex = Array.isArray(rosterPositions) &&
    rosterPositions.some(pos => typeof pos === 'string' && pos.toUpperCase() === 'SUPER_FLEX');
  const isTePremium = detectTePremium(scoringSettings);

  // Depth bands for recommendation logic.
  // QB: must start 2 in SF, 3-4 rostered is sufficient; non-SF 2-3 is fine.
  const qbStarterFloor = Math.max(1, Math.round(starterSpots.QB || 1));
  const qbMin = isSuperFlex ? Math.max(2, qbStarterFloor) : qbStarterFloor;
  const qbIdealLow = isSuperFlex ? 3 : 2;
  const qbIdealHigh = isSuperFlex ? 4 : 3;

  // RB/WR depth scales with starter spots (e.g., 2 RB starters => ideal 4-6).
  const rbStarters = Math.max(1, Math.round(starterSpots.RB || 2));
  const wrStarters = Math.max(1, Math.round(starterSpots.WR || 2));

  const rbIdealLow = Math.max(4, rbStarters * 2);
  const rbIdealHigh = Math.max(rbIdealLow + 1, rbStarters * 3);
  const wrIdealLow = Math.max(5, wrStarters * 2);
  const wrIdealHigh = Math.max(wrIdealLow + 1, wrStarters * 3);

  // TE less important unless TE premium.
  const teIdealLow = isTePremium ? 2 : 1;
  const teIdealHigh = isTePremium ? 3 : 2;

  return {
    counts,
    starterSpots,
    isSuperFlex,
    isTePremium,
    targets: {
      QB: { min: qbMin, idealLow: qbIdealLow, idealHigh: qbIdealHigh, maxUseful: qbIdealHigh + 1 },
      RB: { min: rbIdealLow, idealLow: rbIdealLow, idealHigh: rbIdealHigh, maxUseful: rbIdealHigh + 2 },
      WR: { min: wrIdealLow, idealLow: wrIdealLow, idealHigh: wrIdealHigh, maxUseful: wrIdealHigh + 2 },
      TE: { min: teIdealLow, idealLow: teIdealLow, idealHigh: teIdealHigh, maxUseful: teIdealHigh + 1 },
    },
  };
}

function scoreDraftFit(player, composition, teamContext = {}) {
  if (!player || !player.position || !composition?.targets?.[player.position]) return 0;

  const pos = player.position;
  const count = composition.counts?.[pos] || 0;
  const target = composition.targets[pos];
  let score = 0;

  // Roster depth fit for this position.
  if (count < target.min) score += 30;
  else if (count < target.idealLow) score += 15;
  else if (count <= target.idealHigh) score += 6;
  else if (count > target.maxUseful) score -= 14;
  else score -= 5;

  // Starter opportunity now vs wait-to-contribute.
  const depth = player.depthChartPosition || 2;
  if (depth === 1) score += 10;
  else if (depth === 2) score += 4;
  else if (depth >= 4) score -= 6;

  // Dynasty runway / longer-starting-window proxy.
  if (player.age) {
    if (player.age <= 23) score += 5;
    else if (player.age >= 29) score -= 4;
  }

  // TE boost in TE premium leagues.
  if (pos === 'TE' && composition.isTePremium && player.isPassCatcher) {
    score += 6;
  }

  // Team-context proxies: WR/TE target competition, QB supporting cast,
  // and rough offense environment from available value signals.
  const team = player.team;
  const ctx = (team && teamContext[team]) ? teamContext[team] : null;
  if (ctx) {
    const elitePassCatchers = ctx.elitePassCatchers || 0;
    const offenseTier = ctx.offenseTier || 'neutral';

    if (pos === 'QB') {
      score += Math.min(8, elitePassCatchers * 3);
    }

    if (pos === 'WR' || pos === 'TE') {
      if (elitePassCatchers >= 3) score -= 5;
      else if (elitePassCatchers === 2) score -= 3;
      if (ctx.passHeavy) score += 2;
    }

    if (pos === 'RB' && ctx.runHeavy) {
      score += 3;
    }

    if (offenseTier === 'high') score += 2;
    else if (offenseTier === 'low') score -= 2;
  }

  return score;
}

/**
 * Returns a positional need map: { QB: 'low'|'medium'|'high', WR: ..., ... }
 * based on how thin the roster is at each position.
 */
function analyzePositionalNeeds(rosterPlayerIds, playerMap, rosterPositions = [], scoringSettings = {}) {
  const composition = buildRosterComposition(rosterPlayerIds, playerMap, rosterPositions, scoringSettings);
  const needs = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const count = composition.counts[pos] || 0;
    const target = composition.targets[pos];
    if (count < target.min) needs[pos] = 'high';
    else if (count < target.idealLow) needs[pos] = 'medium';
    else needs[pos] = 'low';
  }

  return needs;
}

module.exports = {
  computeRosterMaturity,
  analyzePositionalNeeds,
  buildRosterComposition,
  scoreDraftFit,
};
