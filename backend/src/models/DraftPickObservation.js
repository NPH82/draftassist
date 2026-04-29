const mongoose = require('mongoose');

const draftPickObservationSchema = new mongoose.Schema({
  draftId: { type: String, required: true, index: true },
  leagueId: { type: String, index: true },
  season: Number,
  pickNo: { type: Number, required: true },
  round: Number,
  rosterId: Number,
  managerSleeperId: { type: String, index: true },
  playerSleeperId: { type: String, required: true, index: true },
  playerName: String,
  position: String,
  isRookie: { type: Boolean, default: false },
  observedAt: { type: Date, default: Date.now },
}, { timestamps: true });

draftPickObservationSchema.index({ draftId: 1, pickNo: 1 }, { unique: true });
draftPickObservationSchema.index({ playerSleeperId: 1, season: 1 });

module.exports = mongoose.model('DraftPickObservation', draftPickObservationSchema);
