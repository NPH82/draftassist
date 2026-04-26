/**
 * Draft Assistant Score (DAS) Engine
 *
 * Produces a 0-100 numeric score for each player based on position-specific
 * weighted inputs. Weights are fixed per the spec.
 *
 * Score breakdown (all positions share a 40-pt universal bucket + 60-pt position-specific bucket)
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();

// NFL round -> capital score (out of 25)
const DRAFT_CAPITAL_BY_ROUND = { 1: 25, 2: 18, 3: 12, 4: 7, 5: 4, 6: 2, 7: 1 };

// Age thresholds for dynasty runway penalty
const AGE_THRESHOLDS = {
  QB: { peak: 27, cliff: 35, weight: 0.5 },
  WR: { peak: 23, cliff: 29, weight: 1.0 },
  RB: { peak: 23, cliff: 27, weight: 2.0 }, // most aggressive
  TE: { peak: 25, cliff: 30, weight: 0.7 },
};

// ── Shared helpers ────────────────────────────────────────────────────────────

function draftCapitalScore(round, pick) {
  const roundScore = DRAFT_CAPITAL_BY_ROUND[round] ?? 0;
  // Penalize later picks within the round (up to -3 pts for the last pick of a round)
  const pickPenalty = round ? Math.min(3, (pick % 32) / 32 * 3) : 0;
  return Math.max(0, roundScore - pickPenalty);
}

function injuryPenalty(collegeInjuries = [], nflInjuries = [], currentStatus = 'Active') {
  let penalty = 0;
  // College injuries: -1 per significant missed game block
  for (const inj of collegeInjuries) {
    if (inj.games > 4) penalty += 3;
    else if (inj.games > 1) penalty += 1.5;
    else penalty += 0.5;
  }
  // NFL injuries (historical)
  for (const inj of nflInjuries) {
    if (inj.games > 4) penalty += 4;
    else if (inj.games > 1) penalty += 2;
    else penalty += 1;
  }
  // Current status
  if (currentStatus === 'IR') penalty += 5;
  else if (currentStatus === 'Out') penalty += 3;
  else if (currentStatus === 'Doubtful') penalty += 2;
  else if (currentStatus === 'Questionable') penalty += 1;

  return Math.min(20, penalty); // cap at -20 pts
}

function athleticsScore(fortyTime, verticalJump, ras) {
  let score = 0;
  // 40 time: sub-4.4 = elite (10 pts), sub-4.5 = good (7), sub-4.6 = average (4)
  if (fortyTime) {
    if (fortyTime < 4.35) score += 10;
    else if (fortyTime < 4.45) score += 8;
    else if (fortyTime < 4.55) score += 6;
    else if (fortyTime < 4.65) score += 3;
    else score += 1;
  }
  // Vertical: 40+ = elite (5 pts), 35+ = good (3)
  if (verticalJump) {
    if (verticalJump >= 40) score += 5;
    else if (verticalJump >= 37) score += 3;
    else if (verticalJump >= 33) score += 1;
  }
  // RAS: 0-10 scale (up to 5 pts)
  if (ras != null) score += (ras / 10) * 5;

  return Math.min(15, score);
}

function ageRunwayScore(age, position) {
  const { peak, cliff, weight } = AGE_THRESHOLDS[position] || AGE_THRESHOLDS.WR;
  if (!age) return 5; // unknown age -- neutral
  if (age <= peak) return 10;
  // Linear decay from peak to cliff
  const decay = Math.max(0, (age - peak) / (cliff - peak));
  return Math.max(0, 10 - decay * 10 * weight);
}

// ── Position-specific score buckets (0-60) ────────────────────────────────────

function wrScore(player) {
  let score = 0;
  // YPRR (primary -- up to 30 pts)
  const yprr = player.yprr;
  if (yprr >= 3.0) score += 30;
  else if (yprr >= 2.5) score += 24;
  else if (yprr >= 2.0) score += 18;
  else if (yprr >= 1.5) score += 12;
  else if (yprr) score += 6;
  else score += 10; // unknown (rookie, no NFL data yet)

  // Target competition (up to 15 pts) -- lower is better; inverse scale
  // depthChartPosition: 1=starter, 2=No2 WR, etc.
  const depth = player.depthChartPosition || 2;
  score += Math.max(0, 15 - (depth - 1) * 5);

  // Draft capital already in universal bucket, but WR gets an extra 15 pts for round 1
  if (player.nflDraftRound === 1) score += 15;
  else if (player.nflDraftRound === 2) score += 10;
  else if (player.nflDraftRound === 3) score += 6;
  else score += 2;

  return Math.min(60, score);
}

function rbScore(player) {
  let score = 0;
  // Pass-catching role (up to 25 pts)
  const rec = player.collegeReceptions || 0;
  if (rec >= 30) score += 25;
  else if (rec >= 20) score += 18;
  else if (rec >= 10) score += 10;
  else score += 3;

  // Target share / usage (up to 15 pts)
  const ts = player.targetShare || 0;
  score += Math.min(15, ts * 100);

  // Age (extra penalty on top of universal -- RBs most penalized)
  const age = player.age || 22;
  if (age <= 22) score += 20;
  else if (age <= 23) score += 16;
  else if (age <= 24) score += 12;
  else if (age <= 25) score += 8;
  else if (age <= 26) score += 4;
  else score += 0;

  return Math.min(60, score);
}

function qbScore(player) {
  let score = 0;
  // Draft capital (primary for QB -- up to 30 pts)
  const round = player.nflDraftRound || 7;
  if (round === 1) score += 30;
  else if (round === 2) score += 18;
  else if (round === 3) score += 10;
  else score += 3;

  // College competition level (up to 20 pts)
  const conf = player.conferenceStrength;
  if (conf === 'CFP' || conf === 'Power5') score += 20;
  else if (conf === 'MidMajor') score += 10;
  else score += 5;

  // Depth chart / starting role (up to 10 pts)
  const depth = player.depthChartPosition || 2;
  score += Math.max(0, 10 - (depth - 1) * 5);

  return Math.min(60, score);
}

function teScore(player) {
  let score = 0;
  // Pass-catcher classification (up to 30 pts)
  score += player.isPassCatcher ? 30 : 10;

  // Draft capital (up to 20 pts)
  const round = player.nflDraftRound || 7;
  if (round === 1) score += 20;
  else if (round === 2) score += 14;
  else if (round === 3) score += 8;
  else score += 2;

  // Depth chart (up to 10 pts)
  const depth = player.depthChartPosition || 2;
  score += Math.max(0, 10 - (depth - 1) * 4);

  return Math.min(60, score);
}

// ── Main scoring function ─────────────────────────────────────────────────────

function calculateDAS(player) {
  const pos = player.position;

  // Universal bucket (40 pts max)
  const capital = draftCapitalScore(player.nflDraftRound, player.nflDraftPick);
  const injury = injuryPenalty(player.collegeInjuryHistory, player.nflInjuryHistory, player.currentInjuryStatus);
  const athletics = athleticsScore(
    player.athletics?.fortyTime,
    player.athletics?.verticalJump,
    player.athletics?.ras
  );
  const ageRunway = ageRunwayScore(player.age, pos);

  const universalRaw = capital + athletics + ageRunway - injury;
  const universalScore = Math.max(0, Math.min(40, universalRaw));

  // Position-specific bucket (60 pts max)
  let posScore = 0;
  if (pos === 'WR') posScore = wrScore(player);
  else if (pos === 'RB') posScore = rbScore(player);
  else if (pos === 'QB') posScore = qbScore(player);
  else if (pos === 'TE') posScore = teScore(player);

  const total = Math.round(universalScore + posScore);

  return {
    score: Math.min(100, total),
    breakdown: {
      draftCapital: Math.round(capital),
      injuryPenalty: Math.round(injury),
      athletics: Math.round(athletics),
      ageRunway: Math.round(ageRunway),
      positionSpecific: Math.round(posScore),
    },
  };
}

// ── Value gap detection ───────────────────────────────────────────────────────

const VALUE_GAP_THRESHOLD = 5; // rank positions difference

function detectValueGap(player) {
  const fpRank = player.fantasyProsRank;
  const ktcRank = player.ktcRank;
  if (!fpRank || !ktcRank) return null;

  const diff = fpRank - ktcRank; // positive = KTC ranks higher, negative = FP ranks higher
  if (Math.abs(diff) < VALUE_GAP_THRESHOLD) return null;

  return {
    isGap: true,
    favors: diff > 0 ? 'KTC' : 'FantasyPros',
    rankDiff: Math.abs(diff),
  };
}

module.exports = { calculateDAS, detectValueGap };
