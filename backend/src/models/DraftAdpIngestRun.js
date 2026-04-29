const mongoose = require('mongoose');

const draftAdpIngestRunSchema = new mongoose.Schema({
  draftId: { type: String, required: true, unique: true, index: true },
  leagueId: { type: String, index: true },
  season: Number,
  status: { type: String, enum: ['processed', 'skipped', 'failed'], required: true },
  reason: String,
  pickCount: { type: Number, default: 0 },
  processedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('DraftAdpIngestRun', draftAdpIngestRunSchema);
