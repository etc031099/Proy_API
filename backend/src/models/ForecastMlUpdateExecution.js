'use strict';

const mongoose = require('mongoose');
const domain = require('../services/forecastMlUpdateExecutionDomain');
const options = { _id: false, strict: 'throw' };
const integer = { type: Number, validate: value => value == null || Number.isSafeInteger(value) };
const optionalVersion = { ...integer, min: 1, default: null };
const opaqueKey = { type: String, match: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/ };
const revision = { type: String, default: null,
  set(value) { if (value != null && !domain.validRevision(value)) throw new Error('INVALID_EXECUTION_REVISION'); return value; },
  validate: value => value == null || domain.validRevision(value) };
const reason = { type: String, default: null, enum: [...Object.keys(domain.REASONS), null] };
const horizonSchema = new mongoose.Schema({
  horizonDays: { type: Number, required: true, enum: [7, 14] },
  activeVersionBefore: optionalVersion, activeVersionAfter: optionalVersion,
  candidateVersion: optionalVersion,
  candidateStatus: { type: String, default: null, enum: ['CANDIDATE', 'ACTIVE', 'SUPERSEDED', 'REJECTED', 'FAILED', null] },
  trainingJobReference: { ...opaqueKey, default: null }, trainedDataVersion: revision,
  dataVersionEvaluated: revision,
  observationsClosedThrough: { type: String, default: null, validate: value => value == null || domain.validDay(value) },
  promotionDecision: { type: String, default: null, enum: ['PROMOTED', 'NOT_PROMOTED', 'NOT_EVALUATED', null] },
  promotionReason: reason,
  policyVersion: { type: String, default: null, enum: [domain.POLICY_VERSION, null] },
  resultStatus: { type: String, required: true, enum: domain.STATUSES.filter(value => value !== 'PARTIAL') },
  availableOrigins: { ...integer, min: 0, default: null },
  requiredOrigins: { type: Number, default: domain.REQUIRED_ORIGINS, enum: [domain.REQUIRED_ORIGINS] },
  eligibility: reason,
  activeChangeSource: { type: String, default: 'UNKNOWN', enum: ['UNKNOWN', 'NONE', 'EXECUTION', 'EXTERNAL'] },
}, options);
const pair = { type: [horizonSchema], default: () => [7, 14].map(horizonDays => ({ horizonDays, resultStatus: 'REQUESTED' })),
  validate: rows => rows.length === 2 && new Set(rows.map(row => row.horizonDays)).size === 2 };
const impactSchema = new mongoose.Schema({ status: { type: String, required: true, enum: domain.IMPACT_STATUSES },
  reasonCode: reason }, options);
const attemptSchema = new mongoose.Schema({
  runAttempt: { ...integer, required: true, min: 1 },
  startedAt: { type: Date, default: null }, finishedAt: { type: Date, default: null },
  status: { type: String, required: true, enum: domain.STATUSES }, reasonCode: reason,
  // A retry must not erase the earlier attempt's horizon outcome.
  perHorizon: { type: [horizonSchema], default: undefined },
  dataVersionEvaluated: revision,
  observationsClosedThrough: { type: String, default: null, validate: value => value == null || domain.validDay(value) },
  impact: { type: impactSchema, default: undefined },
}, options);
const schema = new mongoose.Schema({
  executionId: { type: String, required: true, immutable: true,
    match: /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/ },
  businessId: { ...opaqueKey, required: true, immutable: true },
  scenarioId: { ...opaqueKey, required: true, immutable: true },
  triggerSource: { type: String, required: true, enum: ['MANUAL', 'SCHEDULED', 'CLI'] },
  requestSource: { type: String, default: null, immutable: true, enum: ['MANUAL', 'SCHEDULED', 'CLI', null] },
  manualRequestKey: { ...opaqueKey, immutable: true },
  cliInvocationKey: opaqueKey,
  github: { type: new mongoose.Schema({
    repository: { type: String, required: true, match: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ },
    runId: { type: String, required: true, match: /^[1-9]\d{0,24}$/ },
    runAttempt: { ...integer, required: true, min: 1 },
  }, options), default: undefined },
  requestedAt: { type: Date, required: true }, startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  dataVersionBefore: revision, dataVersionEvaluated: revision,
  observationsClosedThrough: { type: String, default: null, validate: value => value == null || domain.validDay(value) },
  pendingBefore: { type: Boolean, default: null }, pendingAfter: { type: Boolean, default: null },
  signalTypes: { type: [{ type: String, enum: ['SALE_COMPLETED', 'SALE_CANCELLED', 'PRODUCT_UPDATED'] }], default: [],
    validate: values => values.length <= 3 && new Set(values).size === values.length },
  availableOrigins: { ...integer, min: 0, default: null },
  requiredOrigins: { type: Number, default: domain.REQUIRED_ORIGINS, enum: [domain.REQUIRED_ORIGINS] },
  status: { type: String, required: true, enum: domain.STATUSES },
  stage: { type: String, required: true, enum: domain.STAGES }, reasonCode: reason,
  message: { type: String, default: null, maxlength: 180,
    validate: value => value == null || Object.values(domain.REASONS).includes(value) },
  eligibility: reason,
  perHorizon: pair,
  impact: { type: impactSchema, required: true },
  attempts: { type: [attemptSchema], default: [], validate: rows => rows.length <= domain.MAX_ATTEMPTS
    && new Set(rows.map(row => row.runAttempt)).size === rows.length },
  writeVersion: { ...integer, required: true, min: 0, default: 0 },
}, { strict: 'throw', versionKey: false, timestamps: true, minimize: false,
  // This collection is provisioned explicitly after backend startup checks;
  // do not let Mongoose create it or build indexes implicitly on connect.
  autoCreate: false, autoIndex: false });

schema.pre('validate', function validateIdentity(next) {
  if ((this.triggerSource === 'MANUAL' && !this.manualRequestKey)
      || (this.triggerSource === 'SCHEDULED' && !this.github)
      || (this.triggerSource === 'CLI' && !this.cliInvocationKey)) this.invalidate('triggerSource', 'Execution identity is required.');
  next();
});
schema.index({ executionId: 1 }, { unique: true, name: 'forecast_ml_execution_public_id_uq' });
schema.index({ businessId: 1, scenarioId: 1, manualRequestKey: 1 }, { unique: true,
  partialFilterExpression: { manualRequestKey: { $type: 'string' } }, name: 'forecast_ml_execution_manual_uq' });
schema.index({ businessId: 1, scenarioId: 1, 'github.repository': 1, 'github.runId': 1 }, { unique: true,
  partialFilterExpression: { 'github.repository': { $type: 'string' }, 'github.runId': { $type: 'string' } },
  name: 'forecast_ml_execution_github_uq' });
schema.index({ businessId: 1, scenarioId: 1, cliInvocationKey: 1 }, { unique: true,
  partialFilterExpression: { cliInvocationKey: { $type: 'string' } }, name: 'forecast_ml_execution_cli_uq' });
schema.index({ businessId: 1, scenarioId: 1, requestedAt: -1, executionId: -1 }, { name: 'forecast_ml_execution_history' });

module.exports = mongoose.models.ForecastMlUpdateExecution || mongoose.model('ForecastMlUpdateExecution', schema);
