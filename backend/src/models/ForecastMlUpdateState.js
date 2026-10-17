'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  businessId: { type: String, required: true },
  scenarioId: { type: String, required: true },
  horizonDays: { type: Number, required: true, enum: [7, 14] },
  status: { type: String, required: true, enum: ['IDLE', 'PENDING', 'READY', 'CLAIMED'], default: 'PENDING' },
  pendingSince: { type: Date, required: true },
  latestDataVersion: { type: mongoose.Schema.Types.BigInt, required: true },
  eventCount: { type: Number, required: true, default: 0 },
  lastDirtyAt: { type: Date, required: true },
  observationsClosedThrough: { type: String, required: true },
  initialMatureOrigin: { type: String, required: true },
  latestMatureOrigin: { type: String, required: true },
  lastTrainedMatureOrigin: { type: String, default: null },
  lastProcessedDataVersion: { type: mongoose.Schema.Types.BigInt, default: null },
  historicalCorrectionVersion: { type: mongoose.Schema.Types.BigInt, default: null },
  affectedLocalDate: { type: String, default: null },
  nextEligibleAt: { type: Date, required: true },
  triggerReason: { type: String, required: true },
  lastTriggerSource: { type: String, enum: ['AUTO', 'MANUAL'], default: 'AUTO' },
  manualPending: { type: Boolean, default: false },
  manualRequestKey: { type: String, default: null },
  lastManualRequestAt: { type: Date, default: null },
  lastManualDispatchAt: { type: Date, default: null },
  manualDispatchStatus: { type: String, enum: ['RESERVED', 'DISPATCHED', 'DEFERRED', null], default: null },
  lastManualEvaluatedAt: { type: Date, default: null },
  lastManualResult: { type: String, enum: ['NO_PENDING_WORK', 'DEBOUNCE_NOT_ELAPSED', 'NOT_MATURE',
    'COOLDOWN_ACTIVE', 'PREVIOUS_FAILURE_NOT_RETRYABLE', 'NO_PROMOTION_INSUFFICIENT_HISTORY',
    'PROMOTED', 'REJECTED', 'FAILED', null], default: null },
  leaseOwner: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  fencingToken: { type: Number, required: true, default: 0 },
  claimedDataVersion: { type: mongoose.Schema.Types.BigInt, default: null },
  claimedMatureOrigin: { type: String, default: null },
  claimedObservationsClosedThrough: { type: String, default: null },
  claimedCorrectionVersion: { type: mongoose.Schema.Types.BigInt, default: null },
  claimedManualRequestKey: { type: String, default: null },
  lastAttemptAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastFailureAt: { type: Date, default: null },
  lastFailureCode: { type: String, default: null },
  lastFailureRetryable: { type: Boolean, default: null },
  lastFailedDataVersion: { type: mongoose.Schema.Types.BigInt, default: null },
  lastFailedMatureOrigin: { type: String, default: null },
  lastOutcome: { type: String, enum: ['PROMOTED', 'REJECTED', 'NO_PROMOTION_INSUFFICIENT_HISTORY', null], default: null },
  lastModelVersion: { type: Number, default: null },
  lastAckFencingToken: { type: Number, default: null },
  lastAckJobKey: { type: String, default: null }
}, { timestamps: true, versionKey: false, strict: 'throw' });

schema.index({ businessId: 1, scenarioId: 1, horizonDays: 1 },
  { unique: true, name: 'forecast_ml_update_scope_uq' });
schema.index({ status: 1, nextEligibleAt: 1, leaseUntil: 1 }, { name: 'forecast_ml_update_claim' });

module.exports = mongoose.models.ForecastMlUpdateState || mongoose.model('ForecastMlUpdateState', schema);
