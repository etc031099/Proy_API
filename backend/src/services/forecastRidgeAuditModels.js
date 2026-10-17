'use strict';

// Internal, read-only loader. No route exports it and no ACTIVE pointer lookup.
const config = require('../config/v3Operational');
const { artifactBytes, verifyArtifact, PROMOTION_POLICY_VERSION, PROMOTION_POLICY_HASH } =
  require('./forecastModelRegistryService');
const { validDay, validRevision } = require('./forecastMlUpdateExecutionDomain');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const version = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const FIELDS = ['businessId', 'scenarioId', 'horizonDays', 'modelVersion', 'status', 'modelFamily', 'recipeId',
  'featureVersion', 'featureHash', 'promotionPolicyVersion', 'promotionPolicyHash', 'artifactBytes',
  'artifactHash', 'sourceDatasetHash', 'trainedDataVersion', 'dataCutoff', 'labelClosedThrough'];

function createForecastRidgeAuditModels({ executionModel, artifactModel } = {}) {
  const executions = executionModel || require('../models/ForecastMlUpdateExecution');
  const artifacts = artifactModel || require('../models/ForecastModelArtifact');

  async function exactArtifact(scope, modelVersion) {
    const row = await artifacts.findOne({ ...scope, modelVersion }).select('+artifactData').lean().maxTimeMS(5000);
    if (!row) fail('AUDIT_ARTIFACT_NOT_FOUND');
    if (Object.entries({ ...scope, modelVersion }).some(([key, value]) => row[key] !== value)
        || !['ACTIVE', 'SUPERSEDED'].includes(row.status)) fail('AUDIT_ARTIFACT_SCOPE_OR_STATUS_INVALID');
    verifyArtifact(row); // Includes BSON Binary conversion and real-byte SHA256.
    if (row.modelFamily !== 'RIDGE_REGRESSION' || row.recipeId !== 'RIDGE-CAUSAL27'
        || row.featureVersion !== 'RIDGE_CAUSAL27_V1' || !hash(row.featureHash)
        || row.promotionPolicyVersion !== PROMOTION_POLICY_VERSION
        || row.promotionPolicyHash !== PROMOTION_POLICY_HASH
        || !validRevision(row.trainedDataVersion) || !validDay(row.dataCutoff)
        || !validDay(row.labelClosedThrough) || !hash(row.sourceDatasetHash)
        || row.lineage?.sourceDatasetHash !== row.sourceDatasetHash
        || row.lineage?.historicalDatasetSha256 !== config.sourceSha256
        || !row._id || row.artifactLocation !== `mongodb:${artifacts.collection.name}/${row._id}`) {
      fail('AUDIT_ARTIFACT_PROVENANCE_INVALID');
    }
    return { metadata: Object.fromEntries(FIELDS.map(key => [key, row[key]])),
      artifactBase64: Buffer.from(artifactBytes(row.artifactData)).toString('base64') };
  }

  async function loadForExecution({ businessId, scenarioId, executionId, tolerateUnavailable = false }) {
    if (typeof businessId !== 'string' || !businessId || businessId.length > 160
        || scenarioId !== config.scenarioId || typeof executionId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(executionId)) {
      fail('AUDIT_SCOPE_INVALID');
    }
    const row = await executions.findOne({ businessId, scenarioId, executionId }).lean().maxTimeMS(5000);
    if (!row || row.businessId !== businessId || row.scenarioId !== scenarioId || row.executionId !== executionId) {
      fail('AUDIT_EXECUTION_NOT_FOUND');
    }
    if (!['PROMOTED', 'PARTIAL', 'INTERRUPTED'].includes(row.status)
        || !Array.isArray(row.perHorizon) || row.perHorizon.length !== 2
        || [7, 14].some(h => row.perHorizon.filter(item => item.horizonDays === h).length !== 1)) {
      fail('AUDIT_EXECUTION_NOT_FINAL');
    }
    if (!row.perHorizon.some(item => item.resultStatus === 'PROMOTED'
        && item.promotionDecision === 'PROMOTED' && item.activeChangeSource === 'EXECUTION'
        && item.candidateVersion === item.activeVersionAfter && item.trainingJobReference)) {
      fail('AUDIT_NO_CONFIRMED_PROMOTION');
    }
    const horizons = [];
    for (const horizonDays of [7, 14]) {
      const item = row.perHorizon.find(value => value.horizonDays === horizonDays);
      const base = { horizonDays, beforeVersion: item.activeVersionBefore ?? null,
        afterVersion: item.activeVersionAfter ?? null };
      const promoted = item.resultStatus === 'PROMOTED' && item.promotionDecision === 'PROMOTED'
        && item.activeChangeSource === 'EXECUTION' && item.candidateVersion === item.activeVersionAfter
        && Boolean(item.trainingJobReference);
      const unchanged = item.resultStatus !== 'PROMOTED'
        && ['NOT_PROMOTED', 'NOT_EVALUATED'].includes(item.promotionDecision)
        && item.activeChangeSource === 'NONE' && version(base.beforeVersion)
        && base.beforeVersion === base.afterVersion;
      if (!promoted && !unchanged) {
        horizons.push({ ...base, comparable: false, reasonCode: 'NO_CONFIRMED_MODEL_PROMOTION' }); continue;
      }
      if (!version(base.beforeVersion) || !version(base.afterVersion) || (promoted && base.beforeVersion === base.afterVersion)) {
        horizons.push({ ...base, comparable: false, reasonCode: 'EXACT_MODEL_VERSIONS_MISSING' }); continue;
      }
      const scope = { businessId, scenarioId, horizonDays };
      let side = 'BEFORE';
      try {
        const before = await exactArtifact(scope, base.beforeVersion);
        side = 'AFTER';
        const after = unchanged ? before : await exactArtifact(scope, base.afterVersion);
        if (promoted && (!validRevision(item.trainedDataVersion)
            || after.metadata.trainedDataVersion !== item.trainedDataVersion)) fail('AUDIT_ARTIFACT_PROVENANCE_INVALID');
        horizons.push({ ...base, promoted, comparable: true, reasonCode: null, before, after });
      } catch (error) {
        if (!tolerateUnavailable) throw error;
        horizons.push({ ...base, promoted, comparable: false,
          reasonCode: error.code === 'AUDIT_ARTIFACT_NOT_FOUND' ? `${side}_MODEL_NOT_AVAILABLE` : 'ARTIFACT_INTEGRITY_FAILED' });
      }
    }
    return { executionId, businessId, scenarioId, horizons };
  }
  return Object.freeze({ loadForExecution });
}

module.exports = { createForecastRidgeAuditModels };
