/**
 * Auth routes
 * Login via Sleeper username only (no password -- public Sleeper API).
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const sleeperService = require('../services/sleeperService');
const User = require('../models/User');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== 'string' || username.trim().length === 0) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const cleanUsername = username.trim().toLowerCase();

  // Validate against Sleeper API
  let sleeperUser;
  try {
    sleeperUser = await sleeperService.getUser(cleanUsername);
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Sleeper username not found' });
    }
    return res.status(502).json({ error: 'Failed to reach Sleeper API' });
  }

  if (!sleeperUser || !sleeperUser.user_id) {
    return res.status(404).json({ error: 'Sleeper username not found' });
  }

  // Upsert user in DB
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const user = await User.findOneAndUpdate(
    { sleeperId: sleeperUser.user_id },
    {
      sleeperUsername: cleanUsername,
      sleeperId: sleeperUser.user_id,
      displayName: sleeperUser.display_name,
      avatar: sleeperUser.avatar,
      sessionToken,
      sessionExpires,
      lastLogin: new Date(),
    },
    { upsert: true, new: true }
  );

  res.json({
    token: sessionToken,
    user: {
      sleeperId: user.sleeperId,
      username: user.sleeperUsername,
      displayName: user.displayName,
      avatar: user.avatar,
    },
  });
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    await User.findOneAndUpdate({ sessionToken: token }, { sessionToken: null }).catch(() => {});
  }
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const user = await User.findOne({ sessionToken: token, sessionExpires: { $gt: new Date() } }).lean();
  if (!user) return res.status(401).json({ error: 'Session expired' });

  res.json({
    sleeperId: user.sleeperId,
    username: user.sleeperUsername,
    displayName: user.displayName,
    avatar: user.avatar,
  });
});

module.exports = router;
