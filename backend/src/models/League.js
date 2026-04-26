const mongoose = require('mongoose');

// Cached Sleeper league + roster data
const rosterSchema = new mongoose.Schema({
  rosterId: Number,
  ownerId: String,           // Sleeper user ID
  ownerUsername: String,
  playerIds: [String],       // Sleeper player IDs
  taxiPlayerIds: [String],   // Sleeper taxi squad player IDs
  allPlayerIds: [String],    // Combined starters + taxi IDs for depth planning
  picks: mongoose.Schema.Types.Mixed,  // future picks from Sleeper
  // Computed win window
  rosterMaturityScore: Number,
  winWindowLabel: { type: String, enum: ['Rebuilding', 'Contending', 'Win Now', 'Transitioning'] },
  winWindowReason: String,
}, { _id: false });

const leagueSchema = new mongoose.Schema({
  sleeperId: { type: String, required: true, unique: true },
  name: String,
  season: String,
  sport: { type: String, default: 'nfl' },
  status: String,   // 'pre_draft', 'drafting', 'in_season', 'post_season', 'complete'

  // Settings
  totalRosters: Number,
  scoringSettings: mongoose.Schema.Types.Mixed,
  rosterPositions: [String],
  isSuperFlex: Boolean,
  isPpr: Boolean,

  // Draft
  draftId: String,
  draftStatus: String,   // 'pre_draft', 'drafting', 'complete'
  draftType: String,     // 'linear', 'snake', 'auction'
  draftOrder: [String],  // Sleeper user IDs in pick order

  // Rosters (cached)
  rosters: [rosterSchema],

  lastUpdated: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('League', leagueSchema);
