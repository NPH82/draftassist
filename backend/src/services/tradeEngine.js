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

    suggestions.push({
      type: 'trade-up',
      targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername },
      targetPlayer,
      packages,
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
async function suggestTradeDown({ targetPlayer, ourPickNumber, availableUntilPick, allRosters, userId, ourPositionalNeed = 'WR', teams = 12 }) {
  const suggestions = [];

  for (const roster of allRosters) {
    if (roster.ownerId === userId) continue;
    const theirNextPick = roster.nextPickNumber;
    if (!theirNextPick || theirNextPick <= ourPickNumber || theirNextPick > availableUntilPick) continue;

    const picksBack = theirNextPick - ourPickNumber;
    const targetMarketPick = targetPlayer.underdogAdp || targetPlayer.fantasyProsRank || availableUntilPick;

    const { packages, ourPickValue, theirPickValue, rawSurplus, requestBack } = buildTradeDownPackages({
      ourPickNumber,
      theirPickNumber: theirNextPick,
      ourPositionalNeed,
      teams,
    });

    suggestions.push({
      type: 'trade-down',
      targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername || roster.ownerName },
      targetPlayer,
      packages,
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

      const { packages, ourPickValue, theirPickValue, rawSurplus, requestBack } = buildTradeDownPackages({
        ourPickNumber,
        theirPickNumber: theirNextPick,
        ourPositionalNeed,
        teams,
      });

      suggestions.push({
        type: 'trade-down',
        targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername || roster.ownerName },
        targetPlayer,
        packages,
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

/**
 * Build concrete package options to trade UP from ourPickNumber → theirPickNumber.
 *
 * Strategy:
 *  - Applies a 10% overpay premium (moving up costs slightly more than fair value)
 *  - Max 2 assets given per package (pick + 1 player or future pick)
 *  - Player candidates must be proportionate: value within [60%, 150%] of the gap
 *    to avoid suggesting a 30 FP player when you only need to add 11 FP
 *  - Up to 3 packages: positional-fit player, best-fit-value player, future pick
 *
 * All values are in FP scale (e.g. 1.01 = 68, Braelon Allen ≈ 21).
 */
function buildTradeUpPackages({ ourPickNumber, theirPickNumber, ourPlayers = [], theirPositionalNeed, teams = 12 }) {
  const OVERPAY = 1.10;   // 10% — enough to make it attractive, not egregious
  const ourFp   = fpPickValue(ourPickNumber);
  const theirFp = fpPickValue(theirPickNumber);
  const rawGap      = theirFp - ourFp;        // positive = their pick is more valuable
  const neededToAdd = Math.max(0, rawGap * OVERPAY);

  const packages = [];

  // Near-even: gap <= 5 FP (~1 pick spot) — straight swap is the right offer
  if (rawGap <= 5) {
    packages.push({
      label: 'Straight Swap',
      giving:    [{ type: 'pick', label: formatPick(ourPickNumber, teams), fpValue: ourFp, ktcValue: pickKtcValue(ourPickNumber) }],
      receiving: [{ type: 'pick', label: formatPick(theirPickNumber, teams), fpValue: theirFp, ktcValue: pickKtcValue(theirPickNumber) }],
      giveTotal:    ourFp,
      receiveTotal: theirFp,
      rawGap,
      neededToAdd: 0,
      positionalFit: false,
      fairness: 'slight-favour-them',
      notes: `Only a ${rawGap.toFixed(1)} FP gap — a straight swap is a reasonable starting offer.`,
    });
    return { packages, ourPickValue: ourFp, theirPickValue: theirFp, rawGap, neededToAdd };
  }

  // Build list of tradeable players.
  // KEY: only include players whose value is within [60%, 150%] of neededToAdd.
  // This prevents suggesting a 25 FP star to bridge a 10 FP gap.
  const lo = neededToAdd * 0.60;
  const hi = neededToAdd * 1.50;

  const tradeable = ourPlayers
    .map(p => ({ ...p, fpVal: playerFpValue(p) }))
    .filter(p => p.fpVal >= lo && p.fpVal <= hi)  // proportionate range only
    .sort((a, b) => {
      const aPosMatch = a.position === theirPositionalNeed ? 1 : 0;
      const bPosMatch = b.position === theirPositionalNeed ? 1 : 0;
      if (bPosMatch !== aPosMatch) return bPosMatch - aPosMatch;
      // prefer player closest to neededToAdd
      return Math.abs(a.fpVal - neededToAdd) - Math.abs(b.fpVal - neededToAdd);
    });

  const seenPlayers = new Set();

  // Option A: Player that fills their positional need (or closest available)
  const posMatch = tradeable.find(p => p.position === theirPositionalNeed);
  const bestAny  = tradeable[0]; // overall best fit to gap (already range-filtered)

  for (const candidate of [posMatch, bestAny].filter(Boolean)) {
    if (seenPlayers.has(candidate.name)) continue;
    seenPlayers.add(candidate.name);
    const tv = playerTradeValues(candidate);
    const giveTotal   = ourFp + candidate.fpVal;
    const overpayPct  = giveTotal > 0 ? Math.round(((giveTotal - theirFp) / theirFp) * 100) : 0;
    const isPosFit    = candidate.position === theirPositionalNeed;
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
      overpayPct,
      fairness: overpayPct <= 5 ? 'fair' : overpayPct <= 15 ? 'slight-favour-them' : 'aggressive',
      notes: isPosFit
        ? `${candidate.name} fills their ${theirPositionalNeed} need — highest acceptance chance. You give ~${overpayPct}% more than fair value.`
        : `Bridges the ${rawGap.toFixed(1)} FP gap. Not their biggest need but adds solid value (~${overpayPct}% over fair).`,
    });
    if (packages.length >= 2) break;
  }

  // Option C (always): Future pick — keeps roster intact
  const futurePick = futurePickForGap(neededToAdd);
  const futureGiveTotal  = ourFp + futurePick.fpValue;
  const futureOverpayPct = futureGiveTotal > 0 ? Math.round(((futureGiveTotal - theirFp) / theirFp) * 100) : 0;
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
    overpayPct: futureOverpayPct,
    fairness: futureOverpayPct <= 5 ? 'fair' : futureOverpayPct <= 15 ? 'slight-favour-them' : 'aggressive',
    notes: `Capital-only offer — no roster disruption. You give ~${futureOverpayPct}% over fair value.`,
  });

  return { packages, ourPickValue: ourFp, theirPickValue: theirFp, rawGap, neededToAdd };
}

/**
 * Build package options to trade DOWN from ourPickNumber → theirPickNumber.
 * We request back ~88% of the surplus (sweetens the deal for the other manager).
 * Max complexity: their pick + 1 future pick returned to us.
 */
function buildTradeDownPackages({ ourPickNumber, theirPickNumber, ourPositionalNeed, teams = 12 }) {
  const UNDERPAY = 0.88;
  const ourFp    = fpPickValue(ourPickNumber);
  const theirFp  = fpPickValue(theirPickNumber);
  const rawSurplus  = ourFp - theirFp;
  const requestBack = Math.max(0, rawSurplus * UNDERPAY);

  const packages = [];

  // Option A: Swap + a future pick returned to us
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
    notes: `Gain a ${returnPick.label} (~${returnPick.fpValue} FP / ~${Math.round(returnPick.fpValue * FP_TO_KTC).toLocaleString()} KTC) while still landing your target.`,
  });

  // Option B: Near-even straight swap (only when surplus is small — ≤6 FP, ~1-2 pick spots)
  if (rawSurplus <= 6) {
    packages.push({
      label: `${formatPick(ourPickNumber, teams)} → ${formatPick(theirPickNumber, teams)} (straight swap)`,
      giving:    [{ type: 'pick', label: formatPick(ourPickNumber, teams), fpValue: ourFp, ktcValue: pickKtcValue(ourPickNumber) }],
      receiving: [{ type: 'pick', label: formatPick(theirPickNumber, teams), fpValue: theirFp, ktcValue: pickKtcValue(theirPickNumber) }],
      giveTotal:    ourFp,
      receiveTotal: theirFp,
      rawSurplus,
      requestBack: 0,
      capitalGained: 0,
      fairness: 'slight-favour-them',
      notes: `Small drop (${rawSurplus.toFixed(1)} FP) — a straight swap is a reasonable starting point.`,
    });
  }

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
  for (const id of (roster.playerIds || [])) {
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
