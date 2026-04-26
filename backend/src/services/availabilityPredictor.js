/**
 * Availability Predictor
 * Estimates the probability that a player is still available at a given pick number,
 * based on their draft board position, ADP, and manager tendency profiles.
 */

const ManagerProfile = require('../models/ManagerProfile');

/**
 * Predict availability probability for each player at the user's next pick.
 *
 * @param {object[]} availablePlayers - Players not yet drafted, sorted by DAS score
 * @param {number} ourNextPick - Our next overall pick number
 * @param {number} currentPick - Current overall pick number being made
 * @param {object[]} remainingRosters - Rosters picking before us, with nextPickNumber
 * @param {object} playerMap - { sleeperId -> player }
 * @returns {object[]} availablePlayers with .availabilityProb added
 */
async function predictAvailability(availablePlayers, ourNextPick, currentPick, remainingRosters) {
  const picksBeforeUs = ourNextPick - currentPick - 1;
  if (picksBeforeUs <= 0) {
    return availablePlayers.map(p => ({ ...p, availabilityProb: 0.99 }));
  }

  // Load all manager profiles for the rosters picking before us
  const profileIds = remainingRosters.map(r => r.ownerId).filter(Boolean);
  const profiles = await ManagerProfile.find({ sleeperId: { $in: profileIds } }).lean();
  const profileMap = Object.fromEntries(profiles.map(p => [p.sleeperId, p]));

  return availablePlayers.map(player => {
    const prob = computeAvailability(player, picksBeforeUs, remainingRosters, profileMap);
    return { ...player, availabilityProb: prob };
  });
}

function computeAvailability(player, picksBeforeUs, remainingRosters, profileMap) {
  // Base probability: how likely is any single manager to target this player?
  // Driven by player's ADP vs board rank

  const adp = player.underdogAdp || player.fantasyProsRank || 999;
  const boardRank = player.dasRank || player.fantasyProsRank || 999;

  // "Heat" = how in-demand is this player?
  // If ADP < board rank, player is going earlier than expected (high heat)
  const adpHeat = Math.max(0, 1 - (adp - boardRank) / 20);

  // Base single-pick take probability
  const baseTakeProb = 0.05 + adpHeat * 0.2;

  // Adjust for each manager's positional affinity
  let adjustedTakeProb = baseTakeProb;
  for (const roster of remainingRosters) {
    const profile = profileMap[roster.ownerId];
    if (profile && player.position) {
      const posWeight = profile.positionWeights?.[player.position] || 0.25;
      // Managers who favor this position are 50% more likely to take this player
      adjustedTakeProb *= (1 + (posWeight - 0.25) * 0.5);
    }
  }

  // Survival probability: all picksBeforeUs managers pass on this player
  const survivalProb = Math.pow(1 - Math.min(0.8, adjustedTakeProb), picksBeforeUs);
  return Math.round(survivalProb * 100) / 100;
}

/**
 * Detect "faller" alert: a target player has fallen 3+ picks past their projected position.
 * Returns array of { player, actualPick, projectedPick, fallAmount }
 */
function detectFallers(boardPlayers, picksMade, targetPlayerIds) {
  const fallers = [];

  for (const playerId of targetPlayerIds) {
    const player = boardPlayers.find(p => p.sleeperId === playerId);
    if (!player) continue; // already drafted (not available -- handled elsewhere)
    if (!player.underdogAdp && !player.fantasyProsRank) continue;

    const projectedPick = Math.round(player.underdogAdp || player.fantasyProsRank);
    const currentPickNumber = picksMade.length + 1;

    // Player hasn't been taken yet but projected pick has passed
    const fallAmount = currentPickNumber - projectedPick;
    if (fallAmount >= 3) {
      fallers.push({ player, projectedPick, actualCurrentPick: currentPickNumber, fallAmount });
    }
  }

  return fallers;
}

module.exports = { predictAvailability, detectFallers };
