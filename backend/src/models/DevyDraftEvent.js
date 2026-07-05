const mongoose = require('mongoose');

// Immutable league-scoped ledger of observed devy ownership state changes.
const devyDraftEventSchema = new mongoose.Schema({
  sourceLeagueId: { type: String, required: true, index: true },
  eventType: { type: String, enum: ['drafted', 'removed', 'owner_changed'], required: true, index: true },
  eventAt: { type: Date, default: Date.now, index: true },

  managerSleeperId: { type: String, required: true, index: true },
  managerUsername: { type: String, default: null },
  managerTeamName: { type: String, default: null },

  previousManagerSleeperId: { type: String, default: null, index: true },
  previousManagerUsername: { type: String, default: null },
  previousManagerTeamName: { type: String, default: null },

  associatedPlayerId: { type: String, default: null, index: true },
  associatedPlayerName: { type: String, default: null },

  normalizedDevyName: { type: String, required: true, index: true },
  devyName: { type: String, required: true },
  devySleeperId: { type: String, default: null, index: true },
  devyPlayerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', default: null, index: true },

  position: { type: String, default: null },
  college: { type: String, default: null },
  devyClass: { type: Number, default: null },
  sourceType: { type: String, enum: ['roster', 'note'], default: 'roster' },
  onTaxi: { type: Boolean, default: false },
  isBootstrap: { type: Boolean, default: false, index: true },
}, { timestamps: true });

devyDraftEventSchema.index({ sourceLeagueId: 1, eventAt: -1, createdAt: -1 }, { name: 'idx_devy_event_feed' });
devyDraftEventSchema.index({ sourceLeagueId: 1, normalizedDevyName: 1, eventAt: -1 }, { name: 'idx_devy_event_name' });

module.exports = mongoose.model('DevyDraftEvent', devyDraftEventSchema);
