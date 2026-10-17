'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Binary } = require('mongoose').mongo;
const config = require('../src/config/v3Operational');
const registry = require('../src/services/forecastModelRegistryService');
const { createForecastRidgeAuditModels } = require('../src/services/forecastRidgeAuditModels');
const id = '11111111-1111-4111-8111-111111111111';
const scope = { businessId: config.businessId, scenarioId: config.scenarioId, executionId: id };
function fixture() {
  const execution = { ...scope, status: 'PROMOTED', perHorizon: [7, 14].map(horizonDays => ({ horizonDays,
    resultStatus: 'PROMOTED', promotionDecision: 'PROMOTED', activeChangeSource: 'EXECUTION',
    activeVersionBefore: 2, activeVersionAfter: 4, candidateVersion: 4,
    trainingJobReference: 'job-reference', trainedDataVersion: '83' })) };
  const rows = [7, 14].flatMap(horizonDays => [2, 4, 99].map(modelVersion => {
    const artifactData = Buffer.from(`offline-artifact-${horizonDays}-${modelVersion}`);
    const _id = `${horizonDays}-${modelVersion}`;
    return { _id, businessId: scope.businessId, scenarioId: scope.scenarioId, horizonDays, modelVersion,
      status: 'SUPERSEDED', modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27',
      featureVersion: 'RIDGE_CAUSAL27_V1', featureHash: 'a'.repeat(64),
      promotionPolicyVersion: registry.PROMOTION_POLICY_VERSION, promotionPolicyHash: registry.PROMOTION_POLICY_HASH,
      sourceDatasetHash: 'b'.repeat(64), trainedDataVersion: '83', dataCutoff: '2026-10-15',
      labelClosedThrough: '2026-10-15', lineage: { historicalDatasetSha256: config.sourceSha256,
        sourceDatasetHash: 'b'.repeat(64) }, artifactData, artifactBytes: artifactData.length,
      artifactHash: createHash('sha256').update(artifactData).digest('hex'), artifactLocation: `mongodb:artifacts/${_id}` };
  }));
  const calls = [];
  const query = value => ({ select() { return this; }, lean() { return this; }, maxTimeMS: async () => value });
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
  const api = createForecastRidgeAuditModels({ executionModel: {
    findOne: filter => { calls.push({ execution: filter }); return query(matches(execution, filter) ? execution : null); } },
    artifactModel: { collection: { name: 'artifacts' },
      findOne: filter => { calls.push({ artifact: filter }); return query(rows.find(row => matches(row, filter)) || null); } } });
  return { api, execution, rows, calls };
}
test('audit uses only exact captured versions, including SUPERSEDED old and new; never max version', async () => {
  const f = fixture(), result = await f.api.loadForExecution(scope);
  assert.deepEqual(f.calls.filter(row => row.artifact).map(row => row.artifact.modelVersion), [2, 4, 2, 4]);
  assert.ok(result.horizons.every(row => row.comparable && row.before.metadata.status === 'SUPERSEDED'));
  assert.equal(result.horizons[0].after.metadata.modelVersion, 4);
  assert.equal(result.horizons[0].before.artifactBase64, f.rows[0].artifactData.toString('base64'));
  assert.equal(f.execution.status, 'PROMOTED');
});
test('missing before version is not inferred; mixed horizon returns explicit incomparability', async () => {
  const f = fixture(); f.execution.perHorizon[0].activeVersionBefore = null;
  f.execution.perHorizon[1].resultStatus = 'EVALUATED_NO_PROMOTION';
  const result = await f.api.loadForExecution(scope);
  assert.deepEqual(result.horizons.map(row => row.reasonCode),
    ['EXACT_MODEL_VERSIONS_MISSING', 'NO_CONFIRMED_MODEL_PROMOTION']);
  assert.equal(f.calls.filter(row => row.artifact).length, 0);
});
test('mixed promotion reuses unchanged companion only when exact equality was captured', async () => {
  const f = fixture(), companion = f.execution.perHorizon[1]; f.execution.status = 'PARTIAL';
  Object.assign(companion, { resultStatus: 'EVALUATED_NO_PROMOTION', promotionDecision: 'NOT_PROMOTED',
    activeChangeSource: 'NONE', activeVersionAfter: 2 });
  const result = await f.api.loadForExecution(scope);
  assert.deepEqual(result.horizons.map(row => row.promoted), [true, false]);
  assert.equal(result.horizons[1].before, result.horizons[1].after);
  assert.deepEqual(f.calls.filter(row => row.artifact).map(row => row.artifact.modelVersion), [2, 4, 2]);
});
test('tenant and scenario isolation prevent foreign execution/artifact loading', async () => {
  const f = fixture();
  await assert.rejects(f.api.loadForExecution({ ...scope, businessId: 'OTHER' }), { code: 'AUDIT_EXECUTION_NOT_FOUND' });
  await assert.rejects(f.api.loadForExecution({ ...scope, scenarioId: 'OTHER' }), { code: 'AUDIT_SCOPE_INVALID' });
  f.rows[0].businessId = 'OTHER';
  await assert.rejects(f.api.loadForExecution(scope), { code: 'AUDIT_ARTIFACT_NOT_FOUND' });
});
for (const [field, invalid, code] of [
  ['artifactHash', '0'.repeat(64), 'ARTIFACT_HASH_MISMATCH'], ['artifactBytes', 0, 'ARTIFACT_HASH_MISMATCH'],
  ['status', 'CANDIDATE', 'AUDIT_ARTIFACT_SCOPE_OR_STATUS_INVALID'],
  ['artifactLocation', 'mongodb:other/record', 'AUDIT_ARTIFACT_PROVENANCE_INVALID'],
  ['sourceDatasetHash', 'c'.repeat(64), 'AUDIT_ARTIFACT_PROVENANCE_INVALID'],
  ['recipeId', 'OTHER', 'AUDIT_ARTIFACT_PROVENANCE_INVALID'],
]) test(`audit rejects invalid ${field} without changing promotion`, async () => {
  const f = fixture(); f.rows[0][field] = invalid;
  await assert.rejects(f.api.loadForExecution(scope), { code });
  assert.equal(f.execution.status, 'PROMOTED');
});
test('BSON Binary and Uint8Array use real bytes; only metadata allowlist leaves loader', async () => {
  const f = fixture(); f.rows[0].artifactData = new Binary(f.rows[0].artifactData);
  f.rows[1].artifactData = new Uint8Array(f.rows[1].artifactData);
  f.rows[0].privateSecret = 'never-return';
  const result = await f.api.loadForExecution(scope);
  assert.equal(result.horizons[0].comparable, true);
  assert.ok(!JSON.stringify(result).includes('never-return'));
  assert.ok(!Object.hasOwn(result.horizons[0].before.metadata, 'lineage'));
});
test('unconfirmed/no promotion is never audited and has no artifact reads', async () => {
  const f = fixture(); f.execution.status = 'EVALUATED_NO_PROMOTION';
  await assert.rejects(f.api.loadForExecution(scope), { code: 'AUDIT_EXECUTION_NOT_FINAL' });
  assert.equal(f.calls.filter(row => row.artifact).length, 0);
});
