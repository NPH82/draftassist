/**
 * Auth middleware -- attaches user to req.user
 */

const User = require('../models/User');

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const user = await User.findOne({ sessionToken: token, sessionExpires: { $gt: new Date() } }).lean();
  if (!user) return res.status(401).json({ error: 'Session expired or invalid' });

  req.user = user;
  next();
}

module.exports = { requireAuth };
