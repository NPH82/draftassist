/**
 * Auth middleware -- attaches user to req.user
 */

const User = require('../models/User');

function parseAdminSleeperIds(raw) {
  return String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const user = await User.findOne({ sessionToken: token, sessionExpires: { $gt: new Date() } }).lean();
  if (!user) return res.status(401).json({ error: 'Session expired or invalid' });

  req.user = user;
  next();
}

function requireAdminAllowlist(req, res, next) {
  const adminIds = parseAdminSleeperIds(process.env.ADMIN_SLEEPER_IDS);
  const currentUserSleeperId = String(req.user?.sleeperId || '').trim();

  // Fail safe: if no allowlist is configured, deny admin-only routes.
  if (adminIds.length === 0) {
    return res.status(403).json({ error: 'Admin endpoint only' });
  }

  if (!currentUserSleeperId || !adminIds.includes(currentUserSleeperId)) {
    return res.status(403).json({ error: 'Admin endpoint only' });
  }

  next();
}

module.exports = { requireAuth, requireAdminAllowlist, parseAdminSleeperIds };
