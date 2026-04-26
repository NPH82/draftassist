const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  sleeperUsername: { type: String, required: true, unique: true, lowercase: true, trim: true },
  sleeperId: { type: String, unique: true, sparse: true },
  displayName: String,
  avatar: String,

  // Leagues this user is in (Sleeper league IDs)
  leagueIds: [String],

  // Session token (simple random string -- not a JWT, since no password auth)
  sessionToken: String,
  sessionExpires: Date,

  lastLogin: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
