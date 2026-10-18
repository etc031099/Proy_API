'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  businessId: { type: String, required: true, immutable: true },
  scenarioId: { type: String, required: true, immutable: true },
  horizonDays: { type: Number, required: true, enum: [7, 14], immutable: true },
  trainingKey: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  inputDataVersion: { type: String, required: true, match: /^(0|[1-9]\d*)$/, immutable: true },
  matureOrigin: { type: String, required: true, immutable: true },
  sourceDatasetHash: { type: String, default: null, match: /^[a-f0-9]{64}$/ },
  observationsClosedThrough: { type: String, default: null },
  expectedGeneration: { type: Number, default: 0 },
  activeVersionBefore: { type: Number, default: null, min: 1, validate: value => value == null || Number.isSafeInteger(value) },
  mode: { type: String, enum: ['bootstrap', 'automatic'], default: 'automatic' },
  fencingToken: { type: Number, default: null },
  status: { type: String, required: true, enum: ['CLAIMED', 'TRAINING', 'EVALUATING', 'PERSISTING', 'PROMOTED', 'REJECTED', 'FAILED'] },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  candidateModelVersion: { type: Number, default: null },
  failureCode: { type: String, default: null, maxlength: 80 },
  metricsSummary: { type: mongoose.Schema.Types.Mixed, default: null },
  evaluation: { type: mongoose.Schema.Types.Mixed, default: null },
  preparedCandidate: { type: mongoose.Schema.Types.Mixed, default: null, select: false },
  outcome: { type: String, enum: ['PROMOTED', 'REJECTED', 'NO_PROMOTION_INSUFFICIENT_HISTORY', null], default: null },
  retryable: { type: Boolean, default: null },
  ackedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false, strict: 'throw' });

schema.index({ businessId: 1, scenarioId: 1, horizonDays: 1, trainingKey: 1 },
  { unique: true, name: 'forecast_training_job_key_uq' });

schema.plugin(require('../services/mlTestFence').modelPlugin);
module.exports = mongoose.models.ForecastTrainingJob || mongoose.model('ForecastTrainingJob', schema);
