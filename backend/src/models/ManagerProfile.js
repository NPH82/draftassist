const mongoose = require('mongoose');

// Tracks tendencies for a single Sleeper user across all observed drafts
const managerProfileSchema = new mongoose.Schema({
  sleeperId: { type: String, required: true, unique: true },
  username: String,

  // Positional preferences: { QB: 0.3, WR: 0.5, RB: 0.15, TE: 0.05 }
  positionWeights: {
    QB: { type: Number, default: 0.25 },
    RB: { type: Number, default: 0.25 },
    WR: { type: Number, default: 0.25 },
    TE: { type: Number, default: 0.25 },
  },

  // Early-round position tendencies (rounds 1-2)
  earlyRoundPositionWeights: {
    QB: { type: Number, default: 0.25 },
    RB: { type: Number, default: 0.25 },
    WR: { type: Number, default: 0.25 },
    TE: { type: Number, default: 0.25 },
  },

  // Favorite colleges (school name -> frequency count)
  collegeAffinities: { type: Map, of: Number, default: {} },

  // Favorite NFL teams (team abbreviation -> frequency count)
  nflTeamAffinities: { type: Map, of: Number, default: {} },

  // Player pick counts: sleeperId -> total times drafted across all observed drafts
  // Used to surface favorite players from the current draft class
  playerPickCounts: { type: Map, of: Number, default: {} },

  // ADP deviation: how early/late they draft relative to board (negative = early, positive = late)
  avgAdpDeviation: { type: Number, default: 0 },

  // Draft quality tracking across observed completed drafts
  // valueOverExpected: positive means they draft better value than slot expectation.
  draftQualityScore: { type: Number, default: 50 }, // 0-100
  draftValueOverExpected: { type: Number, default: 0 },
  draftHitRate: { type: Number, default: 0 }, // share of picks with positive value-over-expected
  draftQualityTier: {
    type: String,
    enum: ['elite', 'strong', 'average', 'weak', 'unknown'],
    default: 'unknown',
  },

  // Draft history references
  draftsObserved: [String],  // Sleeper draft IDs
  seasonsObserved: [Number], // NFL seasons where draft behavior was observed
  leaguesObserved: [String], // Sleeper league IDs used for learning
  totalPicksObserved: { type: Number, default: 0 },

  // Human-readable scouting note (generated)
  scoutingNotes: [String],

  // Pre-draft target feedback: agree/disagree on recommended targets per pick
  targetFeedback: [{
    leagueId: String,
    pickNumber: Number,
    recommendedPlayerId: String,
    agreed: Boolean,
    preferredPlayerId: String,  // set when disagreed and user chose alternate
    createdAt: { type: Date, default: Date.now },
  }],

  // User-reported devy pool misses to improve future filtering heuristics.
  devyDiscrepancyReportCount: { type: Number, default: 0 },
  devyMissReasonCounts: { type: Map, of: Number, default: {} },
  devyDiscrepancyReports: [{
    reportId: String,
    leagueId: String,
    playerName: String,
    playerSleeperId: String,
    sourceTab: String,
    suspectedMissReason: String,
    note: String,
    createdAt: { type: Date, default: Date.now },
  }],

  lastUpdated: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('ManagerProfile', managerProfileSchema);
