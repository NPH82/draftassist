const mongoose = require('mongoose');

// Point-in-time snapshots of external ranking data for trend analysis
const rankingSnapshotSchema = new mongoose.Schema({
  playerId: { type: String, required: true, index: true },  // Sleeper player ID or our Player._id
  playerName: String,
  source: { type: String, enum: ['ktc', 'fantasypros', 'underdog'], required: true },
  value: Number,
  rank: Number,
  snapshotDate: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

rankingSnapshotSchema.index({ playerId: 1, source: 1, snapshotDate: -1 });

module.exports = mongoose.model('RankingSnapshot', rankingSnapshotSchema);
