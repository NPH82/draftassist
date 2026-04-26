/**
 * Win Window Service
 * Computes Roster Maturity Score and win window label from a roster.
 */

const OUTLOOK_LABELS = {
  rebuilding: 'Rebuilding',
  retooling: 'Re-Tooling',
  contending: 'Contending',
  sustainableContender: 'Sustainable Contender',
  builtToWin: 'Built To Win',
  agingContender: 'Aging Contender',
};

function estimatedValueFromProfile(player = {}) {
  if (player.ktcValue || player.fantasyProsValue) return player.ktcValue || player.fantasyProsValue || 0;

  const posBase = { QB: 5200, RB: 3600, WR: 3900, TE: 2800 };
  const base = posBase[player.position] || 3000;
  const age = player.age || 26;

  // Age-adjusted baseline so unknown-value veterans aren't treated as zero-value assets.
  if (age <= 23) return Math.round(base * 1.1);
  if (age <= 27) return base;
  if (age <= 30) return Math.round(base * 0.82);
  return Math.round(base * 0.65);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * playerMap: { sleeperId -> { age, ktcValue, fantasyProsValue, position } }
 * picks: array of future pick objects from Sleeper
 * rosterPlayerIds: array of Sleeper player IDs on the roster
 */
function computeRosterMaturity(rosterPlayerIds, playerMap, futurePicks = []) {
  if (!rosterPlayerIds || rosterPlayerIds.length === 0) {
    return {
      score: 40,
      label: OUTLOOK_LABELS.retooling,
      reason: 'Insufficient roster data to project competitive outlook',
      metrics: {
        playersCount: 0,
        avgAge: 25,
        avgValue: 0,
        primePct: 0,
        youngPct: 0,
        agingPct: 0,
        topMetricCount: 0,
        eliteCount: 0,
        futureFirsts: 0,
      },
    };
  }

  const skillPositions = ['QB', 'RB', 'WR', 'TE'];
  const players = rosterPlayerIds
    .map(id => playerMap[id])
    .filter(p => p && skillPositions.includes(p.position));

  if (players.length === 0) {
    return {
      score: 40,
      label: OUTLOOK_LABELS.retooling,
      reason: 'No mapped QB/RB/WR/TE players available for outlook modeling',
      metrics: {
        playersCount: 0,
        avgAge: 25,
        avgValue: 0,
        primePct: 0,
        youngPct: 0,
        agingPct: 0,
        topMetricCount: 0,
        eliteCount: 0,
        futureFirsts: 0,
      },
    };
  }

  // 1. Average age of skill players (younger = more rebuilding)
  const ages = players.map(p => p.age).filter(Boolean);
  const avgAge = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : 25;

  // 2. Total market value (with age/position proxy fallback when market values are missing)
  const totalValue = players.reduce((sum, p) => sum + estimatedValueFromProfile(p), 0);
  const avgValue = players.length ? totalValue / players.length : 0;

  const primeCount = players.filter(p => (p.age || 0) >= 24 && (p.age || 0) <= 28).length;
  const youngCount = players.filter(p => (p.age || 0) <= 23).length;
  const agingCount = players.filter(p => (p.age || 0) >= 29).length;

  // Top market metric players (KTC / FP-rank signals)
  const topMetricCount = players.filter(p => ((p.ktcValue || 0) >= 6000) || ((p.fantasyProsRank || 9999) <= 24)).length;
  const eliteCount = players.filter(p => ((p.ktcValue || 0) >= 7500) || ((p.fantasyProsRank || 9999) <= 12)).length;

  // Starter/proven quality depth across positions
  const incumbents = buildIncumbentProfiles(rosterPlayerIds, playerMap);
  const starterQualityCount = Object.values(incumbents).reduce((sum, p) => sum + (p.starters || 0), 0);
  const provenQualityCount = Object.values(incumbents).reduce((sum, p) => sum + (p.proven || 0), 0);

  // 4. Future first-round picks (supports sustainability / re-tool flexibility)
  const firstRoundPicks = futurePicks.filter(p => p.round === 1 && p.season > new Date().getFullYear());
  const futureFirsts = firstRoundPicks.length;

  // ── Compute composite score (0-100; higher = stronger current contender profile) ──
  let score = 0;

  // Market value strength
  score += clamp((avgValue / 7000) * 35, 0, 35);

  // Prime-window concentration
  score += (primeCount / players.length) * 18;

  // Top-end fantasy metric presence
  score += (topMetricCount / players.length) * 20;
  score += Math.min(12, eliteCount * 3);

  // Depth quality and proven contributors
  score += Math.min(9, starterQualityCount * 1.2);
  score += Math.min(6, provenQualityCount * 1.5);

  // Aging-out risk and youth-heavy volatility
  score -= (agingCount / players.length) * 16;
  score -= (youngCount / players.length) * 6;

  // Holding many future firsts usually implies less all-in posture now
  score -= Math.min(6, futureFirsts * 2);

  score = clamp(score, 0, 100);

  // ── Baseline label (league-relative adjustment happens separately) ───────
  let label, reason;
  if (score >= 78) {
    label = OUTLOOK_LABELS.builtToWin;
    reason = `Built to win now: ${topMetricCount} top-metric assets and strong starter quality depth`;
  } else if (score >= 66) {
    label = OUTLOOK_LABELS.contending;
    reason = `Contending profile with a prime-core concentration (${Math.round((primeCount / players.length) * 100)}%)`;
  } else if (score >= 46) {
    label = OUTLOOK_LABELS.retooling;
    reason = `Re-tooling profile: mixed core with uneven impact concentration across positions`;
  } else {
    label = OUTLOOK_LABELS.rebuilding;
    reason = `Rebuilding profile with limited top-end production concentration`;
  }

  return {
    score: Math.round(score),
    label,
    reason,
    metrics: {
      playersCount: players.length,
      avgAge,
      avgValue,
      primePct: players.length ? (primeCount / players.length) : 0,
      youngPct: players.length ? (youngCount / players.length) : 0,
      agingPct: players.length ? (agingCount / players.length) : 0,
      topMetricCount,
      eliteCount,
      futureFirsts,
      starterQualityCount,
      provenQualityCount,
    },
  };
}

function classifyLeagueOutlook(entry, teamCount) {
  const scoreRank = entry.scoreRank || teamCount;
  const standingRank = entry.standingRank || null;
  const percentile = teamCount <= 1 ? 1 : (teamCount - scoreRank) / (teamCount - 1);
  const m = entry.metrics || {};

  const topTier = scoreRank <= Math.max(2, Math.ceil(teamCount * 0.2));
  const playoffTier = scoreRank <= Math.max(4, Math.ceil(teamCount * 0.45));
  const lowerTier = scoreRank > Math.floor(teamCount * 0.65);
  const finishedStrong = standingRank && standingRank <= Math.max(3, Math.ceil(teamCount * 0.25));
  const finishedWeak = standingRank && standingRank >= Math.floor(teamCount * 0.75);

  const agingHeavy = (m.agingPct || 0) >= 0.36;
  const primeHeavy = (m.primePct || 0) >= 0.44;
  const hasEliteCore = (m.eliteCount || 0) >= 3 || (m.topMetricCount || 0) >= 5;
  const hasFutureFlex = (m.futureFirsts || 0) >= 2;

  if (topTier && (finishedStrong || percentile >= 0.82) && hasEliteCore) {
    if (agingHeavy && !hasFutureFlex) return OUTLOOK_LABELS.agingContender;
    if (primeHeavy && hasFutureFlex) return OUTLOOK_LABELS.sustainableContender;
    return OUTLOOK_LABELS.builtToWin;
  }

  if (playoffTier || percentile >= 0.62) {
    if (agingHeavy && !hasFutureFlex) return OUTLOOK_LABELS.agingContender;
    if (primeHeavy && hasFutureFlex) return OUTLOOK_LABELS.sustainableContender;
    return OUTLOOK_LABELS.contending;
  }

  if (lowerTier || finishedWeak) {
    if ((m.youngPct || 0) >= 0.34 || hasFutureFlex) return OUTLOOK_LABELS.rebuilding;
    return OUTLOOK_LABELS.retooling;
  }

  return OUTLOOK_LABELS.retooling;
}

function buildLeagueOutlookReason(entry, teamCount) {
  const m = entry.metrics || {};
  const reasons = [];
  const scoreRank = entry.scoreRank || teamCount;
  const standingRank = entry.standingRank || null;
  const wins = entry.wins || 0;
  const losses = entry.losses || 0;

  reasons.push(`Roster profile ranks #${scoreRank} of ${teamCount} in this league`);

  if (standingRank) {
    reasons.push(`Last-season finish: #${standingRank} (${wins}-${losses}${entry.ties ? `-${entry.ties}` : ''})`);
  }

  reasons.push(`Prime-window share ${Math.round((m.primePct || 0) * 100)}%`);

  if ((m.agingPct || 0) >= 0.36) {
    reasons.push(`Aging-out risk: ${Math.round((m.agingPct || 0) * 100)}% age 29+`);
  }

  if ((m.topMetricCount || 0) > 0) {
    reasons.push(`${m.topMetricCount} players rate in top fantasy market signals`);
  }

  const needs = entry.positionalNeeds || {};
  const needsText = Object.entries(needs)
    .filter(([, need]) => need === 'high' || need === 'medium')
    .map(([pos, need]) => `${pos} (${need})`)
    .join(', ');

  if (needsText) {
    reasons.push(`Needs attention: ${needsText}`);
  }

  return reasons.join('. ');
}

function computeLeagueOutlooks(rosters = [], playerMap, rosterPositions = [], scoringSettings = {}) {
  const enriched = (rosters || []).map((roster) => {
    const playerIds = roster.playerIds || [];
    const allPlayerIds = roster.allPlayerIds || playerIds;
    const maturity = computeRosterMaturity(playerIds, playerMap, roster.picks || []);
    const positionalNeeds = analyzePositionalNeeds(allPlayerIds, playerMap, rosterPositions, scoringSettings);

    const wins = Number(roster.wins || 0);
    const losses = Number(roster.losses || 0);
    const ties = Number(roster.ties || 0);
    const pointsFor = Number(roster.pointsFor || 0);

    return {
      ...roster,
      maturity,
      positionalNeeds,
      wins,
      losses,
      ties,
      pointsFor,
    };
  });

  const teamCount = enriched.length || 1;

  const byScore = [...enriched].sort((a, b) => (b.maturity.score || 0) - (a.maturity.score || 0));
  const scoreRankMap = new Map(byScore.map((r, i) => [r.rosterId, i + 1]));

  const hasStandingsData = enriched.some(r => (r.wins + r.losses + r.ties) > 0 || r.pointsFor > 0);
  const standingsRankMap = new Map();
  if (hasStandingsData) {
    const byStandings = [...enriched].sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.pointsFor - a.pointsFor;
    });
    byStandings.forEach((r, i) => standingsRankMap.set(r.rosterId, i + 1));
  }

  return enriched.map((entry) => {
    const scoreRank = scoreRankMap.get(entry.rosterId) || teamCount;
    const standingRank = standingsRankMap.get(entry.rosterId) || null;
    const outlookEntry = {
      ...entry,
      scoreRank,
      standingRank,
      metrics: entry.maturity.metrics,
    };

    const winWindowLabel = classifyLeagueOutlook(outlookEntry, teamCount);
    const winWindowReason = buildLeagueOutlookReason({ ...outlookEntry, positionalNeeds: entry.positionalNeeds }, teamCount);

    return {
      rosterId: entry.rosterId,
      rosterMaturityScore: entry.maturity.score,
      winWindowLabel,
      winWindowReason,
      positionalNeeds: entry.positionalNeeds,
      outlookMeta: {
        scoreRank,
        standingRank,
        wins: entry.wins,
        losses: entry.losses,
        ties: entry.ties,
        pointsFor: entry.pointsFor,
        metrics: entry.maturity.metrics,
      },
    };
  });
}

function countSkillPlayers(rosterPlayerIds, playerMap) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const id of rosterPlayerIds || []) {
    const p = playerMap[id];
    if (p && counts[p.position] !== undefined) counts[p.position]++;
  }
  return counts;
}

function rankThresholdByPosition(position) {
  if (position === 'QB') return 18;
  if (position === 'RB') return 28;
  if (position === 'WR') return 32;
  if (position === 'TE') return 14;
  return 30;
}

function isStarterProfile(player = {}) {
  if ((player.depthChartPosition || 0) === 1) return true;
  const rankCut = rankThresholdByPosition(player.position);
  if ((player.fantasyProsRank || 9999) <= rankCut) return true;
  if ((player.ktcValue || 0) >= 5500) return true;
  return false;
}

function isProvenProfile(player = {}) {
  const rankCut = Math.max(10, Math.floor(rankThresholdByPosition(player.position) * 0.65));
  if ((player.fantasyProsRank || 9999) <= rankCut) return true;
  if ((player.ktcValue || 0) >= 6200) return true;
  return false;
}

function buildIncumbentProfiles(rosterPlayerIds, playerMap) {
  const incumbents = {
    QB: { starters: 0, proven: 0 },
    RB: { starters: 0, proven: 0 },
    WR: { starters: 0, proven: 0 },
    TE: { starters: 0, proven: 0 },
  };

  for (const id of rosterPlayerIds || []) {
    const p = playerMap[id];
    if (!p || !incumbents[p.position]) continue;
    if (isStarterProfile(p)) incumbents[p.position].starters += 1;
    if (isProvenProfile(p)) incumbents[p.position].proven += 1;
  }

  return incumbents;
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
  const incumbents = buildIncumbentProfiles(rosterPlayerIds, playerMap);
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
    incumbents,
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
  const incumbent = composition.incumbents?.[pos] || { starters: 0, proven: 0 };
  const target = composition.targets[pos];
  let score = 0;

  // Roster depth fit for this position.
  if (count < target.min) score += 30;
  else if (count < target.idealLow) score += 15;
  else if (count < target.idealHigh) score += 4;
  else if (count === target.idealHigh) score += (pos === 'QB' ? -4 : 0);
  else if (count > target.maxUseful) score -= 14;
  else score -= 5;

  // In SF/2QB builds, once you already have enough QBs, prioritize other scarce starter slots.
  if (pos === 'QB' && count >= target.idealHigh) {
    score -= 6;
  }

  // Explicitly suppress QB recommendations when starter-quality depth is already strong.
  if (pos === 'QB') {
    if (incumbent.starters >= 4) score -= 22;
    else if (incumbent.starters === 3) score -= 12;
    if (incumbent.proven >= 2) score -= 8;
  }

  // RB recommendation balance: respect proven starters, but keep youth replenishment alive.
  if (pos === 'RB') {
    if (incumbent.starters >= 2 && incumbent.proven >= 2) score -= 8;
    if ((player.age || 24) <= 23) score += 5;
    if ((player.age || 24) <= 22 && (player.nflDraftRound || 9) <= 2) score += 3;
  }

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

  const downgradeOne = (need) => {
    if (need === 'high') return 'medium';
    if (need === 'medium') return 'low';
    return 'low';
  };

  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const count = composition.counts[pos] || 0;
    const incumbent = composition.incumbents[pos] || { starters: 0, proven: 0 };
    const target = composition.targets[pos];

    let need = 'low';
    if (count < target.min) need = 'high';
    else if (count < target.idealLow) need = 'medium';

    // If a position already has enough starter/proven quality, soften the need flag.
    const requiredStarters = Math.max(1, Math.round(composition.starterSpots[pos] || 1));
    if (incumbent.starters >= requiredStarters || incumbent.proven >= requiredStarters) {
      need = downgradeOne(need);
    }

    needs[pos] = need;
  }

  return needs;
}

module.exports = {
  computeRosterMaturity,
  computeLeagueOutlooks,
  analyzePositionalNeeds,
  buildRosterComposition,
  scoreDraftFit,
};
