/**
 * Players routes
 * Full player board with DAS scores, value gaps, rankings.
 */

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { calculateDAS, detectValueGap } = require('../services/scoringEngine');
const Player = require('../models/Player');

// GET /api/players -- full player board
router.get('/', requireAuth, async (req, res) => {
  try {
    const { position, available, minScore } = req.query;
    const query = {};
    if (position) query.position = position.toUpperCase();
    if (minScore) query.dasScore = { $gte: parseFloat(minScore) };

    const players = await Player.find(query).sort({ dasScore: -1 }).lean();

    const board = players.map((p, i) => ({
      ...p,
      dasRank: i + 1,
      valueGap: detectValueGap(p),
    }));

    res.json({ players: board, count: board.length, lastUpdated: board[0]?.lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/players/:id -- single player
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id).lean();
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const valueGap = detectValueGap(player);
    res.json({ ...player, valueGap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/players/recalculate-scores -- admin: recompute all DAS scores
router.post('/recalculate-scores', requireAuth, async (req, res) => {
  try {
    const players = await Player.find({});
    let updated = 0;
    for (const player of players) {
      const { score, breakdown } = calculateDAS(player);
      player.dasScore = score;
      player.dasBreakdown = breakdown;
      await player.save();
      updated++;
    }
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/players/import -- manual CSV/JSON import fallback
router.post('/import', requireAuth, async (req, res) => {
  try {
    const { players: incoming } = req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'players array required' });

    let upserted = 0;
    for (const p of incoming) {
      if (!p.name || !p.position) continue;
      const { score, breakdown } = calculateDAS(p);
      await Player.findOneAndUpdate(
        { name: p.name, position: p.position.toUpperCase() },
        { ...p, dasScore: score, dasBreakdown: breakdown, dataSource: 'import', lastUpdated: new Date() },
        { upsert: true }
      );
      upserted++;
    }

    res.json({ upserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
