const mongoose = require('mongoose');

// Cross-league cache of devy ownership signals discovered from rosters and notes.
const devyOwnershipSnapshotSchema = new mongoose.Schema({
  normalizedDevyName: { type: String, required: true, index: true },
  devyName: { type: String, required: true },
  devySleeperId: { type: String, default: null, index: true },
  devyPlayerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', default: null, index: true },
  position: { type: String, default: null },
  college: { type: String, default: null },
  devyClass: { type: Number, default: null },
  sourceType: { type: String, enum: ['roster', 'note'], required: true },

  managerSleeperId: { type: String, required: true, index: true },
  managerUsername: { type: String, default: null },
  managerTeamName: { type: String, default: null },

  sourceLeagueId: { type: String, required: true, index: true },
  associatedPlayerId: { type: String, default: null },
  associatedPlayerName: { type: String, default: null },
  rawAlias: { type: String, default: null },
  onTaxi: { type: Boolean, default: false },

  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

devyOwnershipSnapshotSchema.index(
  { sourceLeagueId: 1, managerSleeperId: 1, associatedPlayerId: 1, normalizedDevyName: 1 },
  { unique: true, name: 'uniq_devy_snapshot_scope' }
);

module.exports = mongoose.model('DevyOwnershipSnapshot', devyOwnershipSnapshotSchema);
