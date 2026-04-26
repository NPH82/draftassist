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
 * @param {object} params.targetPlayer - Player we want
 * @param {number} params.ourPickNumber - Our next pick's overall number
 * @param {number} params.targetPicksAt - Pick number we need to jump to
 * @param {object[]} params.allRosters - All roster objects { rosterId, ownerId, playerIds, picks }
 * @param {object} params.playerMap - { sleeperId -> player data }
 * @param {string} params.userId - Our Sleeper user ID
 * @returns {object[]} array of trade suggestions sorted by acceptance probability
 */
async function suggestTradeUp({ targetPlayer, ourPickNumber, targetPicksAt, allRosters, playerMap, userId }) {
  const suggestions = [];

  // Find rosters picking between targetPicksAt and ourPickNumber
  for (const roster of allRosters) {
    if (roster.ownerId === userId) continue;
    const theirNextPick = roster.nextPickNumber;
    if (!theirNextPick || theirNextPick >= ourPickNumber) continue;

    // Load tendency profile
    const profile = await ManagerProfile.findOne({ sleeperId: roster.ownerId }).lean();
    const posNeed = estimatePositionalNeed(roster, playerMap);

    // Build a fair package: our later picks + depth player
    const package_ = buildTradePackage({
      ourRoster: null,
      theirNeed: posNeed,
      valueNeeded: targetPlayer.ktcValue || 3000,
      givePickNumber: ourPickNumber,
    });

    const fairness = assessTradeFairness(
      package_.giving,
      [{ ktcValue: theirNextPick ? estimatePickValue(theirNextPick) : 1500 }]
    );

    suggestions.push({
      type: 'trade-up',
      targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername },
      targetPlayer,
      package: package_,
      fairness,
      reason: `Move up from pick ${ourPickNumber} to pick ${theirNextPick} to secure ${targetPlayer.name}`,
    });
  }

  return suggestions.sort((a, b) => (a.fairness.isFair ? -1 : 1));
}

/**
 * Generate trade-down suggestions: find managers with picks between our pick and the
 * last safe pick for the target player.  Trading back with them lets us drop a few spots,
 * still land the target at their natural draft position, and keep extra capital.
 * We never recommend trading up — moving up costs assets without adding value.
 */
async function suggestTradeDown({ targetPlayer, ourPickNumber, availableUntilPick, allRosters, userId }) {
  const suggestions = [];

  for (const roster of allRosters) {
    if (roster.ownerId === userId) continue;
    const theirNextPick = roster.nextPickNumber;
    if (!theirNextPick || theirNextPick <= ourPickNumber || theirNextPick > availableUntilPick) continue;

    const ourPickValue  = estimatePickValue(ourPickNumber);
    const theirPickValue = estimatePickValue(theirNextPick);
    const capitalGained = ourPickValue - theirPickValue; // extra value we capture by dropping back

    const picksBack = theirNextPick - ourPickNumber;
    const targetMarketPick = targetPlayer.underdogAdp || targetPlayer.fantasyProsRank || availableUntilPick;

    suggestions.push({
      type: 'trade-down',
      targetManager: { sleeperId: roster.ownerId, username: roster.ownerUsername || roster.ownerName },
      targetPlayer,
      swapOurPick: ourPickNumber,
      receiveTheirPick: theirNextPick,
      picksBack,
      capitalGained,
      targetExpectedPick: Math.round(targetMarketPick),
      safeZone: theirNextPick < targetMarketPick,
      reason: `Trade pick ${ourPickNumber} to ${roster.ownerUsername || 'this manager'} — drop ${picksBack} spot${picksBack !== 1 ? 's' : ''} to pick ${theirNextPick}, still land ${targetPlayer.name} (expected ~${Math.round(targetMarketPick)}) + gain ${Math.round(capitalGained)} KTC.`,
    });
  }

  // Sort: safest (most capital gained while still before target falls) first
  return suggestions.sort((a, b) => (b.safeZone ? 1 : 0) - (a.safeZone ? 1 : 0) || b.capitalGained - a.capitalGained);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Rough pick value curve (KTC-like)
function estimatePickValue(overallPick) {
  if (overallPick <= 3) return 8000;
  if (overallPick <= 6) return 6500;
  if (overallPick <= 12) return 5000;
  if (overallPick <= 24) return 3500;
  if (overallPick <= 36) return 2500;
  if (overallPick <= 48) return 1800;
  if (overallPick <= 72) return 1200;
  return 600;
}

function estimatePositionalNeed(roster, playerMap) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const id of (roster.playerIds || [])) {
    const p = playerMap[id];
    if (p && counts[p.position] !== undefined) counts[p.position]++;
  }
  // Return the most-needed position
  const targets = { QB: 2, RB: 5, WR: 6, TE: 2 };
  let mostNeeded = 'WR';
  let worstRatio = 1;
  for (const [pos, target] of Object.entries(targets)) {
    const ratio = (counts[pos] || 0) / target;
    if (ratio < worstRatio) { worstRatio = ratio; mostNeeded = pos; }
  }
  return mostNeeded;
}

function buildTradePackage({ valueNeeded, givePickNumber }) {
  return {
    giving: [
      { type: 'pick', label: `Pick ${givePickNumber}`, ktcValue: estimatePickValue(givePickNumber) },
    ],
    receiving: [
      { type: 'pick', label: 'Earlier pick', ktcValue: valueNeeded },
    ],
  };
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
