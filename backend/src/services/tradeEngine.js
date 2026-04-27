/**
 * Trade Engine
 * Suggests trade-up and trade-down opportunities during a live draft,
 * and generates fair trade packages using KTC + FantasyPros values.
 */

const ManagerProfile = require('../models/ManagerProfile');

const VALUE_GAP_THRESHOLD = 500; // KTC points gap to flag an opportunity

/**
 * Evaluate a trade offer for fairness (both sides).
 * Returns { isFair, givingValue, receivingValue, deltaPercent }
 */
function assessTradeFairness(giving, receiving) {
  const giveTotal = giving.reduce((s, a) => s + (a.ktcValue || a.fpValue || 0), 0);
  const receiveTotal = receiving.reduce((s, a) => s + (a.ktcValue || a.fpValue || 0), 0);
  if (giveTotal === 0 && receiveTotal === 0) return { isFair: true, givingValue: 0, receivingValue: 0, deltaPercent: 0 };

  const delta = Math.abs(giveTotal - receiveTotal);
  const baseValue = Math.max(giveTotal, receiveTotal);
  const deltaPercent = baseValue > 0 ? (delta / baseValue) * 100 : 0;

  return {
    isFair: deltaPercent <= 15, // within 15% = "fair"
    givingValue: giveTotal,
    receivingValue: receiveTotal,
    deltaPercent: Math.round(deltaPercent),
  };
}

/**
 * Generate trade-up suggestion when a target player is at risk of being taken.
 *
 * @param {object} params
 * @param {object} params.targetPlayer   - Player we want
 * @param {number} params.ourPickNumber  - Our next pick's overall number
 * @param {number} params.targetPicksAt  - Pick number we need to jump to
 * @param {object[]} params.allRosters   - All roster objects { rosterId, ownerId, playerIds, picks }
 * @param {object}   params.playerMap    - { sleeperId -> player data }
 * @param {string}   params.userId       - Our Sleeper user ID
 * @param {object[]} params.ourPlayers   - Players on our roster (for package building)
 * @returns {object[]} array of trade suggestions sorted by acceptance probability
 */
async function suggestTradeUp({ targetPlayer, ourPickNumber, targetPicksAt, allRosters, playerMap, userId, ourPlayers = [], teams = 12 }) {
  const suggestions = [];

  for (const roster of allRosters) {
    if (roster.ownerId === userId) continue;
    const theirNextPick = roster.nextPickNumber;
    if (!theirNextPick || theirNextPick >= ourPickNumber) continue;
    if (targetPicksAt && theirNextPick < targetPicksAt) continue;

    const posNeed = estimatePositionalNeed(roster, playerMap);

    const { packages, ourPickValue, theirPickValue, rawGap, neededToAdd } = buildTradeUpPackages({
      ourPickNumber,
      theirPickNumber: theirNextPick,
      ourPlayers,
      theirPositionalNeed: posNeed,
      teams,
    });

    const ensuredPackages = (packages && packages.length > 0)
      ? packages
      : [fallbackTradeUpPackage({ ourPickNumber, theirPickNumber: theirNextPick, teams })];

    suggestions.push({
      type: 'trade-up',
      targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername || roster.ownerName || roster.ownerId },
      targetPlayer,
      packages: ensuredPackages,
      pickComparison: {
        ourPick:    { overall: ourPickNumber,  label: formatPick(ourPickNumber, teams),  fpValue: ourPickValue,  ktcValue: pickKtcValue(ourPickNumber) },
        theirPick:  { overall: theirNextPick,  label: formatPick(theirNextPick, teams),  fpValue: theirPickValue, ktcValue: pickKtcValue(theirNextPick) },
        rawGap,
        neededToAdd,
        theirPositionalNeed: posNeed,
      },
      reason: `Move up from ${formatPick(ourPickNumber, teams)} to ${formatPick(theirNextPick, teams)} to secure ${targetPlayer.name}. Gap: ${rawGap} FP pts — need to add ~${neededToAdd.toFixed(1)} FP pts.`,
    });
  }

  return suggestions.sort((a, b) => a.pickComparison.rawGap - b.pickComparison.rawGap);
}

/**
 * Generate trade-down suggestions: find managers with picks between our pick and the
 * last safe pick for the target player.  Trading back lets us drop a few spots,
 * still land the target, and keep extra capital.
 */
async function suggestTradeDown({ targetPlayer, ourPickNumber, availableUntilPick, allRosters, userId, playerMap = {}, ourPositionalNeed = 'WR', teams = 12 }) {
  const suggestions = [];

  // Build a single id→ownerId map for this roster set so each player ID is
  // pinned to exactly one manager — prevents cross-roster attribution on stale sync data.
  const idToOwner = new Map();
  for (const roster of allRosters) {
    const ids = [...(roster.allPlayerIds || []), ...(roster.playerIds || [])];
    for (const id of ids) {
      if (!idToOwner.has(id)) idToOwner.set(id, roster.ownerId);
    }
  }

  for (const roster of allRosters) {
    if (roster.ownerId === userId) continue;
    const theirNextPick = roster.nextPickNumber;
    if (!theirNextPick || theirNextPick <= ourPickNumber || theirNextPick > availableUntilPick) continue;

    const picksBack = theirNextPick - ourPickNumber;
    const targetMarketPick = targetPlayer.underdogAdp || targetPlayer.fantasyProsRank || availableUntilPick;

    const theirTradablePlayers = [...new Set([...(roster.allPlayerIds || []), ...(roster.playerIds || [])])]
      .filter(id => idToOwner.get(id) === roster.ownerId)
      .map(id => playerMap[id])
      .filter(p => p && p.name && ((p.ktcValue || 0) > 0 || (p.fantasyProsValue || 0) > 0));

    const { packages, ourPickValue, theirPickValue, rawSurplus, requestBack } = buildTradeDownPackages({
      ourPickNumber,
      theirPickNumber: theirNextPick,
      ourPositionalNeed,
      theirPlayers: theirTradablePlayers,
      teams,
    });

    const ensuredPackages = (packages && packages.length > 0)
      ? packages
      : [fallbackTradeDownPackage({ ourPickNumber, theirPickNumber: theirNextPick, teams })];

    suggestions.push({
      type: 'trade-down',
      targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername || roster.ownerName },
      targetPlayer,
      packages: ensuredPackages,
      pickComparison: {
        ourPick:   { overall: ourPickNumber,  label: formatPick(ourPickNumber, teams),  fpValue: ourPickValue,  ktcValue: pickKtcValue(ourPickNumber) },
        theirPick: { overall: theirNextPick,  label: formatPick(theirNextPick, teams),  fpValue: theirPickValue, ktcValue: pickKtcValue(theirNextPick) },
        rawSurplus,
        requestBack,
      },
      swapOurPick:        ourPickNumber,
      receiveTheirPick:   theirNextPick,
      picksBack,
      capitalGained:      rawSurplus,
      targetExpectedPick: Math.round(targetMarketPick),
      safeZone:           theirNextPick < targetMarketPick,
      reason: `Drop ${picksBack} spot${picksBack !== 1 ? 's' : ''} to ${formatPick(theirNextPick, teams)} — ${targetPlayer.name} expected ~pick ${Math.round(targetMarketPick)}, gain back ~${requestBack.toFixed(1)} FP pts.`,
    });
  }

  // Fallback: small exploratory window if no in-zone partners
  if (suggestions.length === 0) {
    const exploratoryUntil = availableUntilPick + 3;
    for (const roster of allRosters) {
      if (roster.ownerId === userId) continue;
      const theirNextPick = roster.nextPickNumber;
      if (!theirNextPick || theirNextPick <= ourPickNumber || theirNextPick > exploratoryUntil) continue;

      const picksBack = theirNextPick - ourPickNumber;
      const targetMarketPick = targetPlayer.underdogAdp || targetPlayer.fantasyProsRank || availableUntilPick;

      const theirTradablePlayers = [...new Set([...(roster.allPlayerIds || []), ...(roster.playerIds || [])])]
        .filter(id => idToOwner.get(id) === roster.ownerId)
        .map(id => playerMap[id])
        .filter(p => p && p.name && ((p.ktcValue || 0) > 0 || (p.fantasyProsValue || 0) > 0));

      const { packages, ourPickValue, theirPickValue, rawSurplus, requestBack } = buildTradeDownPackages({
        ourPickNumber,
        theirPickNumber: theirNextPick,
        ourPositionalNeed,
        theirPlayers: theirTradablePlayers,
        teams,
      });

      const ensuredPackages = (packages && packages.length > 0)
        ? packages
        : [fallbackTradeDownPackage({ ourPickNumber, theirPickNumber: theirNextPick, teams })];

      suggestions.push({
        type: 'trade-down',
        targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername || roster.ownerName },
        targetPlayer,
        packages: ensuredPackages,
        pickComparison: {
          ourPick:   { overall: ourPickNumber,  label: formatPick(ourPickNumber, teams),  fpValue: ourPickValue,  ktcValue: pickKtcValue(ourPickNumber) },
          theirPick: { overall: theirNextPick,  label: formatPick(theirNextPick, teams),  fpValue: theirPickValue, ktcValue: pickKtcValue(theirNextPick) },
          rawSurplus,
          requestBack,
        },
        swapOurPick:        ourPickNumber,
        receiveTheirPick:   theirNextPick,
        picksBack,
        capitalGained:      rawSurplus,
        targetExpectedPick: Math.round(targetMarketPick),
        safeZone:           false,
        exploratory:        true,
        reason: `Exploratory: drop to ${formatPick(theirNextPick, teams)} — ${targetPlayer.name} may still fall (~pick ${Math.round(targetMarketPick)}), carries more risk.`,
      });
    }
  }

  return suggestions.sort((a, b) => (b.safeZone ? 1 : 0) - (a.safeZone ? 1 : 0) || b.capitalGained - a.capitalGained);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * FantasyPros-calibrated pick value curve.
 * Anchored to the April 2026 FP Dynasty Trade Value Chart:
 *   1.01 = 68,  1.03 = 58  (user-confirmed)
 * All packages use this scale so player FP values (e.g. Braelon Allen = 21)
 * are directly comparable.
 */
function fpPickValue(overallPick) {
  const perPick = [
    68, 63, 58, 54, 50, 46,  // 1.01 – 1.06
    42, 39, 36, 33, 30, 28,  // 1.07 – 1.12
    25, 23, 21, 19, 17, 16,  // 2.01 – 2.06
    14, 13, 12, 11, 10,  9,  // 2.07 – 2.12
  ];
  if (overallPick >= 1 && overallPick <= perPick.length) return perPick[overallPick - 1];
  if (overallPick <= 36) return 7;
  if (overallPick <= 48) return 5;
  if (overallPick <= 72) return 3;
  return 2;
}

// Keep KTC-scale alias for any callers that still reference it (scoring engine, availability predictor)
function estimatePickValue(overallPick) {
  // Normalize to KTC scale: FP ÷ 68 × 9500
  return Math.round(fpPickValue(overallPick) / 68 * 9500);
}

// Conversion constants between scales (anchored: 1.01 = 68 FP = 9500 KTC)
const KTC_TO_FP = 68 / 9500;  // multiply KTC to get FP scale
const FP_TO_KTC = 9500 / 68;  // multiply FP to get KTC scale

/**
 * Returns a composite trade value object for a player using both FP and KTC data.
 * { fpValue, ktcValue, consensus } — all on their native scales.
 * consensus is FP-scale; used for package matching logic.
 *
 * When both sources are present, consensus = weighted average (FP 55%, KTC→FP 45%).
 * When only one is present, that source is used directly.
 */
function playerTradeValues(player) {
  if (!player) return { fpValue: 0, ktcValue: 0, consensus: 0 };
  const fp  = Number(player.fantasyProsValue || 0);
  const ktc = Number(player.ktcValue || 0);
  const ktcAsFp = ktc > 0 ? Math.max(1, Math.round(ktc * KTC_TO_FP)) : 0;

  let consensus = 0;
  if (fp > 0 && ktcAsFp > 0) {
    consensus = Math.round(fp * 0.55 + ktcAsFp * 0.45);
  } else if (fp > 0) {
    consensus = fp;
  } else if (ktcAsFp > 0) {
    consensus = ktcAsFp;
  }

  return {
    fpValue:  fp,
    ktcValue: ktc,
    fpFromKtc: ktcAsFp,
    consensus,
  };
}

// Convenience: just the consensus FP-scale value (used for sorting/thresholds)
function playerFpValue(player) {
  return playerTradeValues(player).consensus;
}

// Convenience: pick value also expressed in KTC scale for display
function pickKtcValue(overallPick) {
  return Math.round(fpPickValue(overallPick) * FP_TO_KTC);
}

/**
 * Pick the best future pick asset to bridge a gap of `targetFpValue` FP points.
 * Returns { label, fpValue }.
 */
function futurePickForGap(targetFpValue) {
  if (targetFpValue >= 55) return { label: '2027 1st (Top-3)', fpValue: 58 };
  if (targetFpValue >= 42) return { label: '2027 1st (Early)', fpValue: 46 };
  if (targetFpValue >= 28) return { label: '2027 1st (Mid)',   fpValue: 33 };
  if (targetFpValue >= 20) return { label: '2027 1st (Late)',  fpValue: 23 };
  if (targetFpValue >= 14) return { label: '2027 2nd (Early)', fpValue: 16 };
  if (targetFpValue >= 10) return { label: '2027 2nd (Mid)',   fpValue: 12 };
  if (targetFpValue >=  7) return { label: '2027 2nd (Late)',  fpValue:  9 };
  if (targetFpValue >=  4) return { label: '2027 3rd Round',   fpValue:  5 };
  return                          { label: '2027 4th Round',   fpValue:  3 };
}

function fallbackTradeUpPackage({ ourPickNumber, theirPickNumber, teams = 12 }) {
  const ourFp = fpPickValue(ourPickNumber);
  const theirFp = fpPickValue(theirPickNumber);
  return {
    label: `${formatPick(ourPickNumber, teams)} + 2027 2nd (Mid)`,
    giving: [
      { type: 'pick', label: formatPick(ourPickNumber, teams), fpValue: ourFp, ktcValue: pickKtcValue(ourPickNumber) },
      { type: 'pick', label: '2027 2nd (Mid)', fpValue: 12, ktcValue: Math.round(12 * FP_TO_KTC) },
    ],
    receiving: [
      { type: 'pick', label: formatPick(theirPickNumber, teams), fpValue: theirFp, ktcValue: pickKtcValue(theirPickNumber) },
    ],
    giveTotal: ourFp + 12,
    receiveTotal: theirFp,
    fallback: true,
    notes: 'Fallback package: pick swap plus a future 2nd when no custom package could be generated.',
  };
}

function fallbackTradeDownPackage({ ourPickNumber, theirPickNumber, teams = 12 }) {
  const ourFp = fpPickValue(ourPickNumber);
  const theirFp = fpPickValue(theirPickNumber);
  return {
    label: `${formatPick(ourPickNumber, teams)} -> ${formatPick(theirPickNumber, teams)} + 2027 3rd Round`,
    giving: [
      { type: 'pick', label: formatPick(ourPickNumber, teams), fpValue: ourFp, ktcValue: pickKtcValue(ourPickNumber) },
    ],
    receiving: [
      { type: 'pick', label: formatPick(theirPickNumber, teams), fpValue: theirFp, ktcValue: pickKtcValue(theirPickNumber) },
      { type: 'pick', label: '2027 3rd Round', fpValue: 5, ktcValue: Math.round(5 * FP_TO_KTC) },
    ],
    giveTotal: ourFp,
    receiveTotal: theirFp + 5,
    fallback: true,
    notes: 'Fallback package: small capital return when no custom package could be generated.',
  };
}

/**
 * Build concrete package options to trade UP from ourPickNumber → theirPickNumber.
 *
 * Moving up ALWAYS requires adding something — there are no straight swaps here.
 * Player candidates are sorted by positional fit first, then closest value to the gap.
 * All values are in FP scale (e.g. 1.01 = 68 FP).
 */
function buildTradeUpPackages({ ourPickNumber, theirPickNumber, ourPlayers = [], theirPositionalNeed, teams = 12 }) {
  const OVERPAY = 1.10;  // 10% premium to make the offer attractive
  const ourFp   = fpPickValue(ourPickNumber);
  const theirFp = fpPickValue(theirPickNumber);
  const rawGap      = theirFp - ourFp;  // positive = their pick is more valuable
  // Always require adding something — even near-even swaps need a sweetener when moving up.
  const neededToAdd = Math.max(rawGap * OVERPAY, ourFp * 0.08);

  const packages = [];

  // Rank tradeable players: positional fit first, then closest value to neededToAdd.
  // No strict range filter — we want real players to always appear.
  const withValues = ourPlayers
    .map(p => ({ ...p, fpVal: playerFpValue(p) }))
    .filter(p => p.fpVal > 0)
    .sort((a, b) => {
      const aPosMatch = a.position === theirPositionalNeed ? 1 : 0;
      const bPosMatch = b.position === theirPositionalNeed ? 1 : 0;
      if (bPosMatch !== aPosMatch) return bPosMatch - aPosMatch;
      // Among same positional-fit tier, prefer value closest to neededToAdd (slightly over preferred)
      const aOver = a.fpVal - neededToAdd;
      const bOver = b.fpVal - neededToAdd;
      if (aOver >= 0 && bOver >= 0) return aOver - bOver;  // both over: pick the smaller overpay
      if (aOver < 0 && bOver < 0)  return bOver - aOver;   // both under: pick the larger value
      return aOver >= 0 ? -1 : 1;                          // slightly over is better than slightly under
    });

  const seenPlayers = new Set();

  // Option A/B: Best positional-fit player, then best overall value player
  for (const candidate of withValues.slice(0, 4)) {
    if (seenPlayers.has(candidate.name)) continue;
    if (packages.length >= 2) break;
    seenPlayers.add(candidate.name);
    const tv = playerTradeValues(candidate);
    const giveTotal  = ourFp + candidate.fpVal;
    const overpayPct = theirFp > 0 ? Math.round(((giveTotal - theirFp) / theirFp) * 100) : 0;
    const isPosFit   = candidate.position === theirPositionalNeed;
    packages.push({
      label: `${formatPick(ourPickNumber, teams)} + ${candidate.name}`,
      giving: [
        { type: 'pick',   label: formatPick(ourPickNumber, teams), fpValue: ourFp, ktcValue: pickKtcValue(ourPickNumber) },
        { type: 'player', label: candidate.name, position: candidate.position,
          fpValue: tv.fpValue, ktcValue: tv.ktcValue, fpFromKtc: tv.fpFromKtc, consensus: tv.consensus },
      ],
      receiving: [{ type: 'pick', label: formatPick(theirPickNumber, teams), fpValue: theirFp, ktcValue: pickKtcValue(theirPickNumber) }],
      giveTotal,
      receiveTotal: theirFp,
      rawGap,
      neededToAdd,
      positionalFit: isPosFit,
      overpayPct: Math.abs(overpayPct),
      fairness: Math.abs(overpayPct) <= 8 ? 'fair' : Math.abs(overpayPct) <= 20 ? 'slight-favour-them' : 'aggressive',
      notes: isPosFit
        ? `${candidate.name} fills their ${theirPositionalNeed} need — highest acceptance chance. ~${Math.abs(overpayPct)}% over fair.`
        : `Adds value to bridge the gap. ~${Math.abs(overpayPct)}% ${overpayPct >= 0 ? 'over' : 'under'} fair value.`,
    });
  }

  // Always add future-pick option (capital-only, no roster disruption)
  const futurePick = futurePickForGap(neededToAdd);
  const futureGiveTotal  = ourFp + futurePick.fpValue;
  const futureOverpayPct = theirFp > 0 ? Math.round(((futureGiveTotal - theirFp) / theirFp) * 100) : 0;
  packages.push({
    label: `${formatPick(ourPickNumber, teams)} + ${futurePick.label}`,
    giving: [
      { type: 'pick', label: formatPick(ourPickNumber, teams), fpValue: ourFp, ktcValue: pickKtcValue(ourPickNumber) },
      { type: 'pick', label: futurePick.label, fpValue: futurePick.fpValue, ktcValue: Math.round(futurePick.fpValue * FP_TO_KTC) },
    ],
    receiving: [{ type: 'pick', label: formatPick(theirPickNumber, teams), fpValue: theirFp, ktcValue: pickKtcValue(theirPickNumber) }],
    giveTotal:    futureGiveTotal,
    receiveTotal: theirFp,
    rawGap,
    neededToAdd,
    positionalFit: false,
    overpayPct: Math.abs(futureOverpayPct),
    fairness: Math.abs(futureOverpayPct) <= 8 ? 'fair' : Math.abs(futureOverpayPct) <= 15 ? 'slight-favour-them' : 'aggressive',
    notes: `Capital-only offer — no roster disruption. ~${Math.abs(futureOverpayPct)}% over fair value.`,
  });

  return { packages, ourPickValue: ourFp, theirPickValue: theirFp, rawGap, neededToAdd };
}

/**
 * Build package options to trade DOWN from ourPickNumber → theirPickNumber.
 * We give our earlier pick; we receive their later pick + a player or future pick back.
 * Straight swaps are never offered here — when trading down you always gain something.
 *
 * @param {object[]} theirPlayers - The partner manager's tradeable players (for player-return option)
 */
function buildTradeDownPackages({ ourPickNumber, theirPickNumber, ourPositionalNeed, theirPlayers = [], teams = 12 }) {
  const UNDERPAY = 0.88;
  const ourFp    = fpPickValue(ourPickNumber);
  const theirFp  = fpPickValue(theirPickNumber);
  const rawSurplus  = ourFp - theirFp;
  const requestBack = Math.max(0, rawSurplus * UNDERPAY);

  const packages = [];

  // Option A: Their pick + a player from their roster that fills our need (best fit)
  const theirTradeable = theirPlayers
    .map(p => ({ ...p, fpVal: playerFpValue(p) }))
    .filter(p => p.fpVal > 0)
    .sort((a, b) => {
      const aFit = a.position === ourPositionalNeed ? 1 : 0;
      const bFit = b.position === ourPositionalNeed ? 1 : 0;
      if (bFit !== aFit) return bFit - aFit;
      // Prefer value closest to requestBack (slightly over preferred)
      const aOver = a.fpVal - requestBack;
      const bOver = b.fpVal - requestBack;
      if (aOver >= 0 && bOver >= 0) return aOver - bOver;
      if (aOver < 0 && bOver < 0)  return bOver - aOver;
      return aOver >= 0 ? -1 : 1;
    });

  if (theirTradeable.length > 0) {
    const candidate = theirTradeable[0];
    const tv = playerTradeValues(candidate);
    const receiveTotal = theirFp + candidate.fpVal;
    const isPosFit = candidate.position === ourPositionalNeed;
    packages.push({
      label: `${formatPick(ourPickNumber, teams)} → ${formatPick(theirPickNumber, teams)} + ${candidate.name}`,
      giving:    [{ type: 'pick', label: formatPick(ourPickNumber, teams), fpValue: ourFp, ktcValue: pickKtcValue(ourPickNumber) }],
      receiving: [
        { type: 'pick',   label: formatPick(theirPickNumber, teams), fpValue: theirFp, ktcValue: pickKtcValue(theirPickNumber) },
        { type: 'player', label: candidate.name, position: candidate.position,
          fpValue: tv.fpValue, ktcValue: tv.ktcValue, fpFromKtc: tv.fpFromKtc, consensus: tv.consensus },
      ],
      giveTotal:    ourFp,
      receiveTotal,
      rawSurplus,
      requestBack,
      capitalGained: candidate.fpVal,
      positionalFit: isPosFit,
      notes: isPosFit
        ? `${candidate.name} fills your ${ourPositionalNeed} need — drop a spot and add positional value.`
        : `${candidate.name} returns fair value for the spot you're dropping.`,
    });
  }

  // Always add future-pick return option
  const returnPick = futurePickForGap(requestBack);
  packages.push({
    label: `${formatPick(ourPickNumber, teams)} → ${formatPick(theirPickNumber, teams)} + ${returnPick.label}`,
    giving:    [{ type: 'pick', label: formatPick(ourPickNumber, teams), fpValue: ourFp, ktcValue: pickKtcValue(ourPickNumber) }],
    receiving: [
      { type: 'pick', label: formatPick(theirPickNumber, teams), fpValue: theirFp, ktcValue: pickKtcValue(theirPickNumber) },
      { type: 'pick', label: returnPick.label, fpValue: returnPick.fpValue, ktcValue: Math.round(returnPick.fpValue * FP_TO_KTC) },
    ],
    giveTotal:    ourFp,
    receiveTotal: theirFp + returnPick.fpValue,
    rawSurplus,
    requestBack,
    capitalGained: returnPick.fpValue,
    notes: `Gain a ${returnPick.label} (~${returnPick.fpValue} FP) while still landing your target.`,
  });

  return { packages, ourPickValue: ourFp, theirPickValue: theirFp, rawSurplus, requestBack };
}

// Format an overall pick number as "Round.Pick" (e.g. 3 → "1.03", 15 → "2.03")
function formatPick(overall, teams = 12) {
  if (!overall) return `Pick ${overall}`;
  const round = Math.ceil(overall / teams);
  const slot  = ((overall - 1) % teams) + 1;
  return `${round}.${String(slot).padStart(2, '0')}`;
}

function estimatePositionalNeed(roster, playerMap) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const allIds = [...new Set([...(roster.allPlayerIds || []), ...(roster.playerIds || [])])];
  for (const id of allIds) {
    const p = playerMap[id];
    if (p && counts[p.position] !== undefined) counts[p.position]++;
  }
  const targets = { QB: 2, RB: 5, WR: 6, TE: 2 };
  let mostNeeded = 'WR';
  let worstRatio = 1;
  for (const [pos, target] of Object.entries(targets)) {
    const ratio = (counts[pos] || 0) / target;
    if (ratio < worstRatio) { worstRatio = ratio; mostNeeded = pos; }
  }
  return mostNeeded;
}

/**
 * Generate off-season trade suggestions for the Trade Hub.
 * For each player on their roster that has a sell signal, find a buyer.
 *
 * @param {object[]} userRosters - Array of the user's roster objects (one per league)
 * @param {object[]} allLeagueRosters - All rosters in the user's leagues
 * @param {object} playerMap
 * @returns {object[]} trade suggestions
 */
function generateTradeHubSuggestions(userRosters, allLeagueRosters, playerMap) {
  const suggestions = [];

  for (const myRoster of userRosters) {
    const leagueRosters = allLeagueRosters.filter(r => r.leagueId === myRoster.leagueId && r.rosterId !== myRoster.rosterId);

    for (const myPlayerId of (myRoster.playerIds || [])) {
      const myPlayer = playerMap[myPlayerId];
      if (!myPlayer) continue;

      // Look for value gap (FP vs KTC)
      const fpVal = myPlayer.fantasyProsValue || 0;
      const ktcVal = myPlayer.ktcValue || 0;
      const gap = Math.abs(fpVal - ktcVal);
      if (gap < VALUE_GAP_THRESHOLD) continue;

      const sellHigh = fpVal > ktcVal; // FP ranks higher = sell on FP hype

      for (const theirRoster of leagueRosters) {
        // Check if they need this position
        const theirCounts = {};
        for (const id of theirRoster.playerIds || []) {
          const p = playerMap[id];
          if (p) theirCounts[p.position] = (theirCounts[p.position] || 0) + 1;
        }
        const targets = { QB: 2, RB: 5, WR: 6, TE: 2 };
        const theyNeedPos = (theirCounts[myPlayer.position] || 0) < (targets[myPlayer.position] || 3);

        if (theyNeedPos && sellHigh) {
          suggestions.push({
            type: sellHigh ? 'sell' : 'buy',
            player: myPlayer,
            targetManager: { rosterId: theirRoster.rosterId, username: theirRoster.ownerUsername },
            reason: `Sell high -- FP values ${myPlayer.name} ${Math.round(gap)} pts above KTC`,
            leagueId: myRoster.leagueId,
          });
        }
      }
    }
  }

  return suggestions;
}

module.exports = { suggestTradeUp, suggestTradeDown, assessTradeFairness, generateTradeHubSuggestions, estimatePickValue, fpPickValue };
