/**
 * Trade Hub routes (off-season mode)
 */

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { generateTradeHubSuggestions } = require('../services/tradeEngine');
const League = require('../models/League');
const Player = require('../models/Player');

// GET /api/tradehub -- trade suggestions across all leagues
router.get('/', requireAuth, async (req, res) => {
  try {
    const { sleeperId } = req.user;

    const allMyLeagues = await League.find({ 'rosters.ownerId': sleeperId }).lean();
    const allPlayers = await Player.find({}).lean();
    const playerMap = Object.fromEntries(allPlayers.map(p => [p.sleeperId, p]));

    const userRosters = allMyLeagues.map(lg => {
      const myRoster = lg.rosters.find(r => r.ownerId === sleeperId);
      return myRoster ? { ...myRoster, leagueId: lg.sleeperId, leagueName: lg.name } : null;
    }).filter(Boolean);

    const allLeagueRosters = allMyLeagues.flatMap(lg =>
      lg.rosters.map(r => ({ ...r, leagueId: lg.sleeperId }))
    );

    const suggestions = generateTradeHubSuggestions(userRosters, allLeagueRosters, playerMap);

    // Enrich with target manager full roster
    const enriched = suggestions.map(s => {
      const league = allMyLeagues.find(lg => lg.sleeperId === s.leagueId);
      const theirRoster = league?.rosters.find(r => r.rosterId === s.targetManager.rosterId);
      const theirPlayers = (theirRoster?.playerIds || []).map(id => playerMap[id]).filter(Boolean);
      return { ...s, targetManagerRoster: theirPlayers };
    });

    res.json({ suggestions: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
