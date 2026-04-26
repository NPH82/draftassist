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
async function suggestTradeUp({ targetPlayer, ourPickNumber, targetPicksAt, allRosters, playerMap, userId, ourPlayers = [] }) {
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
    });

    suggestions.push({
      type: 'trade-up',
      targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername },
      targetPlayer,
      packages,
      pickComparison: {
        ourPick:    { overall: ourPickNumber,  label: formatPick(ourPickNumber),  ktcValue: ourPickValue },
        theirPick:  { overall: theirNextPick,  label: formatPick(theirNextPick),  ktcValue: theirPickValue },
        rawGap,
        neededToAdd,
        theirPositionalNeed: posNeed,
      },
      reason: `Move up from ${formatPick(ourPickNumber)} to ${formatPick(theirNextPick)} to secure ${targetPlayer.name}. Need to add ~${Math.round(neededToAdd).toLocaleString()} KTC.`,
    });
  }

  // Sort: fewest packages-needed (smallest gap) first
  return suggestions.sort((a, b) => a.pickComparison.rawGap - b.pickComparison.rawGap);
}

/**
 * Generate trade-down suggestions: find managers with picks between our pick and the
 * last safe pick for the target player.  Trading back lets us drop a few spots,
 * still land the target, and keep extra capital.
 */
async function suggestTradeDown({ targetPlayer, ourPickNumber, availableUntilPick, allRosters, userId, ourPositionalNeed = 'WR' }) {
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
    });

    suggestions.push({
      type: 'trade-down',
      targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername || roster.ownerName },
      targetPlayer,
      packages,
      pickComparison: {
        ourPick:   { overall: ourPickNumber,  label: formatPick(ourPickNumber),  ktcValue: ourPickValue },
        theirPick: { overall: theirNextPick,  label: formatPick(theirNextPick),  ktcValue: theirPickValue },
        rawSurplus,
        requestBack,
      },
      swapOurPick:        ourPickNumber,
      receiveTheirPick:   theirNextPick,
      picksBack,
      capitalGained:      rawSurplus,
      targetExpectedPick: Math.round(targetMarketPick),
      safeZone:           theirNextPick < targetMarketPick,
      reason: `Drop ${picksBack} spot${picksBack !== 1 ? 's' : ''} to ${formatPick(theirNextPick)} — ${targetPlayer.name} expected ~${Math.round(targetMarketPick)}, gain back ~${Math.round(requestBack).toLocaleString()} KTC.`,
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
      });

      suggestions.push({
        type: 'trade-down',
        targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername || roster.ownerName },
        targetPlayer,
        packages,
        pickComparison: {
          ourPick:   { overall: ourPickNumber,  label: formatPick(ourPickNumber),  ktcValue: ourPickValue },
          theirPick: { overall: theirNextPick,  label: formatPick(theirNextPick),  ktcValue: theirPickValue },
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
        reason: `Exploratory: drop to ${formatPick(theirNextPick)} — ${targetPlayer.name} may still fall (~${Math.round(targetMarketPick)}), carries more risk.`,
      });
    }
  }

  return suggestions.sort((a, b) => (b.safeZone ? 1 : 0) - (a.safeZone ? 1 : 0) || b.capitalGained - a.capitalGained);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Granular pick value curve (KTC-calibrated for a 12-team rookie draft)
function estimatePickValue(overallPick) {
  // Per-pick values for picks 1-24
  const perPick = [
    9500, 8800, 8000, 7200, 6500, 5900,  // 1-6
    5400, 4900, 4500, 4100, 3800, 3500,  // 7-12
    3200, 3000, 2800, 2600, 2400, 2200,  // 13-18
    2000, 1850, 1700, 1600, 1500, 1400,  // 19-24
  ];
  if (overallPick >= 1 && overallPick <= perPick.length) return perPick[overallPick - 1];
  if (overallPick <= 36) return 1100;
  if (overallPick <= 48) return 800;
  if (overallPick <= 72) return 550;
  return 300;
}

// Suggest a future draft pick asset whose value approximates targetValue
function suggestFuturePickForValue(targetValue) {
  if (targetValue >= 7000) return { label: '2027 1st (Early)', ktcValue: 7200 };
  if (targetValue >= 5500) return { label: '2027 1st (Mid)', ktcValue: 5900 };
  if (targetValue >= 4000) return { label: '2027 1st (Late)', ktcValue: 4400 };
  if (targetValue >= 2500) return { label: '2027 2nd (Early)', ktcValue: 2700 };
  if (targetValue >= 1800) return { label: '2027 2nd (Mid)', ktcValue: 2000 };
  if (targetValue >= 1200) return { label: '2027 2nd (Late)', ktcValue: 1400 };
  if (targetValue >= 800)  return { label: '2027 3rd Round', ktcValue: 900 };
  if (targetValue >= 400)  return { label: '2027 4th Round', ktcValue: 500 };
  return null;
}

/**
 * Build 2-3 concrete package options to trade UP from ourPickNumber to theirPickNumber.
 * Applies a 12% overpay premium (moving up costs extra).
 *
 * @param {number} ourPickNumber   - Our current pick slot (e.g. 3)
 * @param {number} theirPickNumber - Their pick slot we want (e.g. 1)
 * @param {object[]} ourPlayers    - Tradeable players on our roster [{name, position, ktcValue}]
 * @param {string} theirPositionalNeed - Position the target manager most needs
 * @returns {{ packages, ourPickValue, theirPickValue, rawGap, neededToAdd }}
 */
function buildTradeUpPackages({ ourPickNumber, theirPickNumber, ourPlayers = [], theirPositionalNeed }) {
  const OVERPAY = 1.12;
  const ourValue   = estimatePickValue(ourPickNumber);
  const theirValue = estimatePickValue(theirPickNumber);
  const rawGap     = theirValue - ourValue; // positive = their pick is more valuable
  const neededToAdd = Math.max(0, rawGap * OVERPAY);

  const packages = [];

  if (neededToAdd < 150) {
    // Near-even swap — mention small premium just to incentivise acceptance
    packages.push({
      label: 'Near-Even Swap',
      giving: [{ type: 'pick', label: formatPick(ourPickNumber), ktcValue: ourValue }],
      receiving: [{ type: 'pick', label: formatPick(theirPickNumber), ktcValue: theirValue }],
      giveTotal: ourValue,
      receiveTotal: theirValue,
      neededToAdd: 0,
      valueGap: rawGap,
      positionalFit: false,
      notes: 'Essentially a straight swap — small gap is acceptable.',
    });
    return { packages, ourPickValue: ourValue, theirPickValue: theirValue, rawGap, neededToAdd };
  }

  const tradeable = ourPlayers
    .filter(p => (p.ktcValue || 0) > 0)
    .sort((a, b) => (b.ktcValue || 0) - (a.ktcValue || 0));

  // Option A: Player that matches their positional need
  const posMatches = tradeable.filter(p => p.position === theirPositionalNeed);
  const bestPosMatch = posMatches.find(p => (p.ktcValue || 0) >= neededToAdd * 0.8) || posMatches[0];
  if (bestPosMatch) {
    const giveTotal = ourValue + (bestPosMatch.ktcValue || 0);
    packages.push({
      label: `${formatPick(ourPickNumber)} + ${bestPosMatch.name}`,
      giving: [
        { type: 'pick',   label: formatPick(ourPickNumber), ktcValue: ourValue },
        { type: 'player', label: bestPosMatch.name, position: bestPosMatch.position, ktcValue: bestPosMatch.ktcValue || 0 },
      ],
      receiving: [{ type: 'pick', label: formatPick(theirPickNumber), ktcValue: theirValue }],
      giveTotal,
      receiveTotal: theirValue,
      neededToAdd,
      valueGap: rawGap,
      positionalFit: true,
      notes: `${bestPosMatch.name} fills their ${theirPositionalNeed} need — highest acceptance chance.`,
    });
  }

  // Option B: Best available player regardless of position (closest value)
  const bestValue = tradeable.find(p => (p.ktcValue || 0) >= neededToAdd * 0.75 && p !== bestPosMatch);
  if (bestValue) {
    const giveTotal = ourValue + (bestValue.ktcValue || 0);
    packages.push({
      label: `${formatPick(ourPickNumber)} + ${bestValue.name}`,
      giving: [
        { type: 'pick',   label: formatPick(ourPickNumber), ktcValue: ourValue },
        { type: 'player', label: bestValue.name, position: bestValue.position, ktcValue: bestValue.ktcValue || 0 },
      ],
      receiving: [{ type: 'pick', label: formatPick(theirPickNumber), ktcValue: theirValue }],
      giveTotal,
      receiveTotal: theirValue,
      neededToAdd,
      valueGap: rawGap,
      positionalFit: bestValue.position === theirPositionalNeed,
      notes: `Bridges the value gap. ${bestValue.position === theirPositionalNeed ? 'Fits their positional need.' : 'Consider if they prefer this position.'}`,
    });
  }

  // Option C: Add a future draft pick to bridge the gap (capital-only)
  const futurePick = suggestFuturePickForValue(neededToAdd);
  if (futurePick) {
    const giveTotal = ourValue + futurePick.ktcValue;
    packages.push({
      label: `${formatPick(ourPickNumber)} + ${futurePick.label}`,
      giving: [
        { type: 'pick', label: formatPick(ourPickNumber), ktcValue: ourValue },
        { type: 'pick', label: futurePick.label, ktcValue: futurePick.ktcValue },
      ],
      receiving: [{ type: 'pick', label: formatPick(theirPickNumber), ktcValue: theirValue }],
      giveTotal,
      receiveTotal: theirValue,
      neededToAdd,
      valueGap: rawGap,
      positionalFit: false,
      notes: 'Capital-only offer — keeps your roster intact.',
    });
  }

  return { packages, ourPickValue: ourValue, theirPickValue: theirValue, rawGap, neededToAdd };
}

/**
 * Build package options to trade DOWN from ourPickNumber to theirPickNumber.
 * Applies an 8% discount (we request slightly less than full fair value).
 *
 * @param {number} ourPickNumber   - Our current pick slot
 * @param {number} theirPickNumber - Their later pick we'd swap into
 * @param {string} ourPositionalNeed - Position we most need back
 * @returns {{ packages, ourPickValue, theirPickValue, rawSurplus, requestBack }}
 */
function buildTradeDownPackages({ ourPickNumber, theirPickNumber, ourPositionalNeed }) {
  const UNDERPAY = 0.88; // we accept ~88% of fair value — sweetens the deal
  const ourValue    = estimatePickValue(ourPickNumber);
  const theirValue  = estimatePickValue(theirPickNumber);
  const rawSurplus  = ourValue - theirValue;
  const requestBack = Math.max(0, rawSurplus * UNDERPAY);

  const packages = [];

  // Option A: Swap + future pick back
  const returnPick = suggestFuturePickForValue(requestBack);
  if (returnPick) {
    packages.push({
      label: `${formatPick(ourPickNumber)} → ${formatPick(theirPickNumber)} + ${returnPick.label}`,
      giving:    [{ type: 'pick', label: formatPick(ourPickNumber), ktcValue: ourValue }],
      receiving: [
        { type: 'pick', label: formatPick(theirPickNumber), ktcValue: theirValue },
        { type: 'pick', label: returnPick.label, ktcValue: returnPick.ktcValue },
      ],
      giveTotal:    ourValue,
      receiveTotal: theirValue + returnPick.ktcValue,
      rawSurplus,
      requestBack,
      capitalGained: returnPick.ktcValue,
      notes: `Capture ~${Math.round(returnPick.ktcValue).toLocaleString()} KTC in extra capital while still landing your target.`,
    });
  }

  // Option B: Swap only (near-even) — mention slight discount
  if (rawSurplus < 600) {
    packages.push({
      label: `${formatPick(ourPickNumber)} → ${formatPick(theirPickNumber)} (swap)`,
      giving:    [{ type: 'pick', label: formatPick(ourPickNumber), ktcValue: ourValue }],
      receiving: [{ type: 'pick', label: formatPick(theirPickNumber), ktcValue: theirValue }],
      giveTotal:    ourValue,
      receiveTotal: theirValue,
      rawSurplus,
      requestBack: 0,
      capitalGained: 0,
      notes: 'Low-cost drop. Slight value left on the table but keeps negotiations simple.',
    });
  }

  return { packages, ourPickValue: ourValue, theirPickValue: theirValue, rawSurplus, requestBack };
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

module.exports = { suggestTradeUp, suggestTradeDown, assessTradeFairness, generateTradeHubSuggestions, estimatePickValue };
