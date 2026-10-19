'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  businessId: { type: String, required: true, immutable: true },
  activeCheckpointId: { type: String, default: null },
  testCycleId: { type: String, default: null },
  state: { type: String, required: true, enum: ['NO_TEST', 'CHECKPOINT_CREATING', 'TEST_ACTIVE', 'RESTORING', 'FAILED'] },
  resetEpoch: { type: mongoose.Schema.Types.BigInt, required: true, min: 0n },
  restoreId: { type: String, default: null },
  restoreCompletedAt: { type: Date, default: null },
  restoreFinish: { type: Boolean, default: false },
  lastCheckpointId: { type: String, default: null },
  lastAbortedCheckpointId: { type: String, default: null },
  lastAbortedAt: { type: Date, default: null },
  lastAbortedEpoch: { type: String, default: null },
  lastAbortedTestCycleId: { type: String, default: null },
  epochChangedAt: { type: Date, default: null },
  finalizedAt: { type: Date, default: null },
  writeFenceNonce: { type: String, default: null },
  activeWriterIds: { type: [String], default: [] },
  restoreHeartbeatNonce: { type: String, default: null },
  restoreOwnerNonce: { type: String, default: null },
  restoreLeaseUntil: { type: Date, default: null },
  failureCode: { type: String, default: null }
}, { collection: 'mltestcontrols', timestamps: true, strict: 'throw', autoCreate: false, autoIndex: false });
schema.index({ businessId: 1 }, { unique: true, name: 'ml_test_control_business_uq' });
module.exports = mongoose.models.MlTestControl || mongoose.model('MlTestControl', schema);
