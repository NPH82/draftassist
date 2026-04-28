const mongoose = require('mongoose');

// Combine / athletic data
const athleticsSchema = new mongoose.Schema({
  fortyTime: Number,      // 40-yard dash
  verticalJump: Number,   // inches
  ras: Number,            // Relative Athletic Score (0-10)
  sparq: Number,
}, { _id: false });

// Position-specific stats stored as flexible key/value
const playerSchema = new mongoose.Schema({
  // Identity
  sleeperId: { type: String, index: true },          // Sleeper player ID
  name: { type: String, required: true, index: true },
  position: { type: String, enum: ['QB', 'RB', 'WR', 'TE'], required: true },
  team: String,                                       // NFL team abbreviation
  age: Number,
  birthdate: Date,
  college: String,
  conferenceStrength: { type: String, enum: ['Power5', 'CFP', 'MidMajor', 'Unknown'], default: 'Unknown' },

  // NFL Draft info (2026 draft)
  nflDraftYear: Number,
  nflDraftRound: Number,
  nflDraftPick: Number,   // overall pick number

  // Depth chart
  depthChartPosition: Number,   // 1 = starter, 2 = backup, etc.
  isPassCatcher: Boolean,       // TE-specific

  // Athletic testing
  athletics: athleticsSchema,

  // Injury history
  collegeInjuryHistory: [{ season: Number, description: String, games: Number }],
  nflInjuryHistory: [{ season: Number, description: String, games: Number, type: String }],
  currentInjuryStatus: { type: String, default: 'Active' },  // from Sleeper

  // Production stats (position-specific)
  yprr: Number,               // WR: NFL yards per route run (veterans)
  collegeYprr: Number,        // WR/TE: college yards per route run (PFF college; primary for rookies)
  collegeYardsPerRec: Number, // WR/TE: college yards per reception (proxy when YPRR unavailable)
  collegeReceptions: Number,  // RB: career single-season max receptions
  collegeRushYpc: Number,     // RB: college yards per carry
  collegeTDs: Number,         // all: career college touchdowns
  targetShare: Number,        // RB/TE: NFL target share percentage (veterans)

  // External rankings/values
  fantasyProsValue: Number,
  fantasyProsRank: Number,
  ktcValue: Number,
  ktcRank: Number,
  underdogAdp: Number,

  // Manager's personal ranking (1 = top pick). Overrides algorithmic sort when set.
  personalRank: { type: Number, default: null },

  // Draft Assistant Score
  dasScore: Number,
  dasBreakdown: {
    draftCapital: Number,
    injuryPenalty: Number,
    athletics: Number,
    ageRunway: Number,
    positionSpecific: Number,
  },

  // Devy (college prospect) flags — set for players not yet in the NFL
  isDevy: { type: Boolean, default: false },
  devyClass: Number,          // expected NFL draft year (e.g. 2027, 2028)
  devyKtcValue: Number,       // KTC's separate devy dynasty value scale
  devyFpRank: Number,         // FantasyPros devy-specific rank
  bigBoardRank: Number,       // NFLMDB consensus big board rank for the prospect's class year

  // Metadata
  dataSource: { type: String, default: 'seed' },
  lastUpdated: { type: Date, default: Date.now },
  isRookie: { type: Boolean, default: true },
}, { timestamps: true });

playerSchema.index({ position: 1, dasScore: -1 });
playerSchema.index({ fantasyProsRank: 1 });

module.exports = mongoose.model('Player', playerSchema);
