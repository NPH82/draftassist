/**
 * Trade Hub routes (off-season mode)
 */

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const League = require('../models/League');
const Player = require('../models/Player');

const POSITION_TARGETS = { QB: 2, RB: 5, WR: 6, TE: 2 };

function playerValue(p) {
  if (!p) return 0;
  if ((p.fantasyProsValue || 0) > 0) return p.fantasyProsValue;
  if ((p.ktcValue || 0) > 0) return Math.round(p.ktcValue / 140);
  return 0;
}

function countPositions(players = []) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const p of players) {
    if (counts[p.position] !== undefined) counts[p.position] += 1;
  }
  return counts;
}

function rankNeeds(players = []) {
  const counts = countPositions(players);
  return Object.keys(POSITION_TARGETS)
    .map(pos => ({ pos, deficit: Math.max(0, POSITION_TARGETS[pos] - (counts[pos] || 0)) }))
    .sort((a, b) => b.deficit - a.deficit);
}

function fairnessFromValues(give, receive) {
  const giveTotal = give.reduce((s, a) => s + (a.fpValue || 0), 0);
  const receiveTotal = receive.reduce((s, a) => s + (a.fpValue || 0), 0);
  if (giveTotal === 0 && receiveTotal === 0) {
    return { isFair: true, deltaPercent: 0, givingValue: 0, receivingValue: 0 };
  }
  const delta = Math.abs(giveTotal - receiveTotal);
  const base = Math.max(giveTotal, receiveTotal, 1);
  const deltaPercent = Math.round((delta / base) * 100);
  return {
    isFair: deltaPercent <= 18,
    deltaPercent,
    givingValue: Math.round(giveTotal * 10) / 10,
    receivingValue: Math.round(receiveTotal * 10) / 10,
  };
}

function pickSweetenerAsset(targetFp) {
  if (targetFp >= 25) return { type: 'pick', label: '2027 1st (est.)', fpValue: 26 };
  if (targetFp >= 18) return { type: 'pick', label: '2027 2nd (est.)', fpValue: 16 };
  return { type: 'pick', label: '2027 3rd (est.)', fpValue: 9 };
}

// GET /api/tradehub -- trade suggestions across all leagues
router.get('/', requireAuth, async (req, res) => {
  try {
    const { sleeperId } = req.user;

    const allMyLeagues = await League.find({ 'rosters.ownerId': sleeperId }).lean();
    const allPlayers = await Player.find({}).lean();
    const playerMap = Object.fromEntries(allPlayers.map(p => [p.sleeperId, p]));

    const byLeague = allMyLeagues.map((league) => {
      const myRoster = (league.rosters || []).find(r => r.ownerId === sleeperId);
      if (!myRoster) {
        return { leagueId: league.sleeperId, leagueName: league.name, trades: [] };
      }

      // Build an exact id→ownerId map for this league so each player ID maps to one owner only.
      // This prevents players appearing under the wrong manager when sleeperId field lookups overlap.
      const idToOwner = new Map();
      for (const roster of (league.rosters || [])) {
        const ids = [...(roster.allPlayerIds || []), ...(roster.playerIds || [])];
        for (const id of ids) {
          if (!idToOwner.has(id)) idToOwner.set(id, roster.ownerId);
        }
      }

      const myIds = new Set([...(myRoster.allPlayerIds || []), ...(myRoster.playerIds || [])]);
      const myPlayers = [...myIds]
        .filter(id => idToOwner.get(id) === sleeperId)
        .map(id => playerMap[id])
        .filter(Boolean);
      const rankedNeeds = rankNeeds(myPlayers);
      const strictNeeds = rankedNeeds.filter(n => n.deficit > 0);
      const myNeeds = strictNeeds.length > 0 ? strictNeeds : rankedNeeds.slice(0, 2);

      const myCounts = countPositions(myPlayers);
      const surplusPositions = Object.keys(POSITION_TARGETS)
        .filter(pos => (myCounts[pos] || 0) > POSITION_TARGETS[pos]);

      const partnerRosters = (league.rosters || []).filter(r => r.ownerId !== sleeperId);
      const trades = [];
      const seenTargetIds = new Set();

      for (const need of myNeeds.slice(0, 2)) {
        for (const partner of partnerRosters) {
          if (trades.length >= 6) break;

          // Only include IDs that the idToOwner map confirms belong to this partner.
          const partnerIds = [...new Set([...(partner.allPlayerIds || []), ...(partner.playerIds || [])])]
            .filter(id => idToOwner.get(id) === partner.ownerId);
          const partnerPlayers = partnerIds
            .map(id => playerMap[id])
            .filter(Boolean);

          const candidate = partnerPlayers
            .filter(p => p.position === need.pos && playerValue(p) > 0)
            .sort((a, b) => playerValue(b) - playerValue(a))[0];

          if (!candidate) continue;
          if (seenTargetIds.has(String(candidate.sleeperId || candidate._id))) continue;

          const candidateFp = playerValue(candidate);

          let offer = myPlayers
            .filter(p => p.position !== need.pos && playerValue(p) > 0)
            .filter(p => surplusPositions.length === 0 || surplusPositions.includes(p.position))
            .sort((a, b) => Math.abs(playerValue(a) - candidateFp) - Math.abs(playerValue(b) - candidateFp))[0];

          if (!offer) {
            offer = myPlayers
              .filter(p => playerValue(p) > 0)
              .sort((a, b) => Math.abs(playerValue(a) - candidateFp) - Math.abs(playerValue(b) - candidateFp))[0];
          }

          const targetAssets = [
            {
              type: 'player',
              label: `${candidate.name} (${candidate.position})`,
              fpValue: candidateFp,
            },
          ];

          let yourAssets;
          if (offer) {
            yourAssets = [
              {
                type: 'player',
                label: `${offer.name} (${offer.position})`,
                fpValue: playerValue(offer),
              },
            ];
          } else {
            yourAssets = [pickSweetenerAsset(candidateFp)];
          }

          const fairness = fairnessFromValues(yourAssets, targetAssets);

          trades.push({
            type: 'buy',
            summary: `Acquire ${candidate.name} for ${need.pos} depth`,
            reason: `You need ${need.pos}. ${partner.ownerUsername || partner.ownerName || 'This manager'} has ${candidate.name} available at a reasonable value band.`,
            targetManager: {
              rosterId: partner.rosterId,
              username: partner.ownerUsername || partner.ownerName || partner.ownerId,
            },
            targetAssets,
            yourAssets,
            fairness,
          });

          seenTargetIds.add(String(candidate.sleeperId || candidate._id));
        }
      }

      return {
        leagueId: league.sleeperId,
        leagueName: league.name,
        trades,
      };
    });

    res.json({ byLeague });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
