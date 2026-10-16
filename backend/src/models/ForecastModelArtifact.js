'use strict';

const mongoose = require('mongoose');

const sha256Pattern = /^[a-f0-9]{64}$/;
const finiteMetric = value => typeof value === 'number' && Number.isFinite(value);
const immutableFiniteMetric = { type: Number, required: true, immutable: true, validate: finiteMetric };
const immutableHash = { type: String, required: true, immutable: true, match: sha256Pattern };

const schema = new mongoose.Schema({
  businessId: { type: String, required: true, trim: true, immutable: true },
  scenarioId: { type: String, required: true, trim: true, immutable: true },
  horizonDays: { type: Number, required: true, enum: [7, 14], immutable: true },
  modelFamily: { type: String, required: true, trim: true, immutable: true },
  recipeId: { type: String, required: true, trim: true, immutable: true },
  modelVersion: { type: Number, required: true, min: 1, validate: Number.isSafeInteger, immutable: true },
  status: { type: String, required: true, enum: ['CANDIDATE', 'ACTIVE', 'REJECTED', 'SUPERSEDED', 'FAILED'] },
  trainedAt: { type: Date, required: true, immutable: true },
  trainedDataVersion: { type: String, required: true, immutable: true, match: /^(0|[1-9]\d*)$/ },
  dataCutoff: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  trainingWindow: {
    startDate: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ }
  },
  labelClosedThrough: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  featureVersion: { type: String, required: true, trim: true, immutable: true },
  featureHash: immutableHash,
  promotionPolicyVersion: { type: String, required: true, immutable: true },
  promotionPolicyHash: immutableHash,
  globalWape: { type: Number, immutable: true, min: 0, validate: value => value === null || finiteMetric(value) },
  globalMae: { ...immutableFiniteMetric, min: 0 },
  globalBias: { type: Number, immutable: true, validate: value => value === null || finiteMetric(value) },
  checks: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  triggerReason: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
  artifactHash: immutableHash,
  artifactLocation: { type: String, required: true, immutable: true, trim: true },
  artifactBytes: { type: Number, required: true, min: 0, max: 5 * 1024 * 1024, validate: Number.isSafeInteger, immutable: true },
  artifactData: { type: Buffer, select: false, immutable: true },
  sourceDatasetHash: immutableHash,
  lineage: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  idempotencyKey: { type: String, trim: true, maxlength: 160, immutable: true },
  idempotencyFingerprint: { type: String, immutable: true, match: sha256Pattern },
  failureCode: { type: String, trim: true, maxlength: 80, default: null }
}, { timestamps: true, strict: 'throw', minimize: false });

schema.index({ businessId: 1, scenarioId: 1, horizonDays: 1, modelVersion: 1 },
  { unique: true, name: 'forecast_model_artifact_version_uq' });
schema.index({ businessId: 1, scenarioId: 1, horizonDays: 1, status: 1, modelVersion: -1 },
  { name: 'forecast_model_artifact_status_versions' });
schema.index({ businessId: 1, scenarioId: 1, horizonDays: 1 }, {
  unique: true, name: 'forecast_model_one_active_per_horizon_uq',
  partialFilterExpression: { status: 'ACTIVE' }
});
schema.index({ businessId: 1, scenarioId: 1, horizonDays: 1, idempotencyKey: 1 }, {
  unique: true, name: 'forecast_model_artifact_idempotency_uq',
  partialFilterExpression: { idempotencyKey: { $type: 'string' } }
});

schema.pre('validate', function validateArtifactBytes() {
  if (!Buffer.isBuffer(this.artifactData)) {
    this.invalidate('artifactData', 'Artifact bytes must be stored as a BSON buffer, including an explicit empty buffer for placeholders.');
    return;
  }
  if (this.artifactBytes !== this.artifactData.length) {
    this.invalidate('artifactBytes', 'artifactBytes must match the persisted buffer length.');
  }
});

module.exports = mongoose.models.ForecastModelArtifact
  || mongoose.model('ForecastModelArtifact', schema);
