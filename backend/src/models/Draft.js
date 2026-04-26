const mongoose = require('mongoose');

const pickSchema = new mongoose.Schema({
  pickNumber: Number,        // overall pick number
  round: Number,
  pickInRound: Number,
  rosterId: Number,          // Sleeper roster ID who made the pick
  playerId: String,          // Sleeper player ID
  playerName: String,
  pickedAt: Date,
  metadata: mongoose.Schema.Types.Mixed,
}, { _id: false });

const draftSchema = new mongoose.Schema({
  sleeperId: { type: String, required: true, unique: true },
  leagueId: String,          // Sleeper league ID
  type: { type: String, default: 'linear' },
  status: { type: String, enum: ['pre_draft', 'drafting', 'complete'], default: 'pre_draft' },
  season: String,
  rounds: Number,
  totalTeams: Number,

  // Pick slot mapping: rosterId -> pick slots
  slotToRoster: mongoose.Schema.Types.Mixed,

  // Picks made so far
  picks: [pickSchema],
  totalPicksMade: { type: Number, default: 0 },

  // Timing
  startTime: Date,
  lastPickAt: Date,
  secondsPerPick: Number,

  // Projected next-pick times per roster (computed)
  nextPickTimes: mongoose.Schema.Types.Mixed,

  lastUpdated: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('Draft', draftSchema);
