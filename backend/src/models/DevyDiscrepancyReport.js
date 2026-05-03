const mongoose = require('mongoose');

const devyDiscrepancyReportSchema = new mongoose.Schema({
  leagueId: { type: String, required: true, index: true },
  leagueName: String,
  reporterSleeperId: { type: String, required: true, index: true },
  reporterUsername: String,

  playerName: { type: String, required: true },
  playerSleeperId: { type: String, index: true },
  associatedPlayerId: String,
  associatedPlayerName: String,

  sourceTab: { type: String, enum: ['available', 'rostered', 'graduated', 'unknown', 'compare', 'other'], default: 'available' },
  note: String,
  suspectedMissReason: {
    type: String,
    enum: [
      'live_roster_sync_gap',
      'draft_pick_ingest_gap',
      'alias_name_match_miss',
      'stale_or_wrong_sleeper_id',
      'duplicate_source_merge',
      'other',
    ],
    default: 'other',
  },

  learningApplied: { type: Boolean, default: false },
  learningNote: String,
  emailSent: { type: Boolean, default: false },
  emailError: String,
  status: { type: String, enum: ['open', 'resolved'], default: 'open' },
}, { timestamps: true });

devyDiscrepancyReportSchema.index({ leagueId: 1, createdAt: -1 });
devyDiscrepancyReportSchema.index({ reporterSleeperId: 1, createdAt: -1 });

module.exports = mongoose.model('DevyDiscrepancyReport', devyDiscrepancyReportSchema);
