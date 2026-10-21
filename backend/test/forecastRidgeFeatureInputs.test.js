'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORICAL, NUMERIC, FEATURE_HASH, FEATURE_VERSION, projectRidgeFeatureInputs } = require('../src/services/forecastRidgeFeatureInputs');
const { createV3IntelligenceService, V3 } = require('../src/services/v3IntelligenceService');
const { createV3BusinessIntelligenceDashboard } = require('../src/services/v3BusinessIntelligenceDashboard');

const query = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean() { return this; }, maxTimeMS: async () => value });
function fixture(corrupt = () => {}) {
  let calls = 0;
  const models = { HistoricalScenario: { findOne: filter => query({ ...filter, status: 'completed', sourceSha256: V3.datasetSha256,
    metadata: { datasetVersion: V3.datasetVersion, referenceDate: V3.referenceDate, timezone: V3.timezone } }) },
  Product: { find: () => query([{ _id: 'product', sku: 'SKU-1', name: 'Producto' }]),
    findOne: () => query({ sku: 'SKU-1', name: 'Producto' }) } };
  const artifactHash = 'b'.repeat(64);
  const sm = { businessId: V3.businessId, scenarioId: V3.scenarioId, asOfDate: '2026-10-20',
    dataVersion: '193', snapshotVersion: 'v3-operational-snapshot-v2', snapshotHash: 'a'.repeat(64),
    observationsClosedThrough: '2026-10-19', capturedAtUtc: '2026-10-20T15:00:00.000Z' };
  const service = createV3IntelligenceService({ models, clock: () => new Date(sm.capturedAtUtc),
    snapshotBuilder: async () => ({ mode: 'LIVE', dataVersion: sm.dataVersion, snapshot: { metadata: sm } }),
    mlClient: { intelligence: async (_domain, request) => {
      calls++;
      const row = { sku: 'SKU-1', horizonDays: request.horizonDays, status: 'READY',
        predictionUnits: request.horizonDays + .65, activeModelStatus: 'ACTIVE', modelVersion: 1,
        modelFamily: 'RIDGE_REGRESSION', featureVersion: FEATURE_VERSION, featureHash: FEATURE_HASH,
        artifactHash, dataVersion: sm.dataVersion, snapshotHash: sm.snapshotHash,
        observationsThrough: sm.observationsClosedThrough, dataCutoff: '2026-10-15', trainedDataVersion: '83',
        featureInputs: { ...Object.fromEntries(CATEGORICAL.map(name => [name, name === 'sku' ? 'SKU-1' : 'descriptor'])),
          ...Object.fromEntries(NUMERIC.map(name => [name, request.horizonDays])), secret: 'never-project', coefficients: [1, 2] } };
      corrupt(row);
      return { requestId: request.requestId, status: 'OK', metadata: { ...request.context,
        source: 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT', contractVersion: 'm6.9f4-live-intelligence-v1',
        dataVersion: sm.dataVersion, snapshotHash: sm.snapshotHash }, data: { items: [row] } };
    } } });
  const registry = { getActiveModelArtifact: async scope => ({ metadata: { ...scope, status: 'ACTIVE', modelVersion: 1,
    modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', featureVersion: FEATURE_VERSION,
    featureHash: FEATURE_HASH, promotionPolicyVersion: 'M6.10A22-PROMOTION-v1',
    promotionPolicyHash: '522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3',
    artifactHash, artifactBytes: 1 }, artifactData: Buffer.from('x') }) };
  return { dashboard: createV3BusinessIntelligenceDashboard({ models, intelligenceService: service, forecastRegistryService: registry }), calls: () => calls };
}
const request = days => ({ user: { businessId: V3.businessId, _id: 'user' }, businessId: V3.businessId,
  params: { sku: 'SKU-1' }, query: { horizonDays: String(days) } });

test('same inference preserves per-horizon features and metadata with no extra ML calls or internals', async () => {
  const { dashboard, calls } = fixture();
  for (const days of [7, 14]) {
    const response = await dashboard.forecast(request(days));
    assert.ok(!response.error, JSON.stringify(response));
    const row = response.data;
    assert.equal(row.predictionUnits, days + .65);
    assert.equal(row.dataVersion, '193'); assert.equal(row.observationsThrough, '2026-10-19');
    assert.equal(row.dataCutoff, '2026-10-15'); assert.equal(row.trainedDataVersion, '83');
    assert.equal(row.snapshotHash, 'a'.repeat(64)); assert.equal(row.artifactHash, 'b'.repeat(64));
    assert.equal(row.featureVersion, FEATURE_VERSION); assert.equal(row.featureHash, FEATURE_HASH);
    assert.deepEqual(Object.keys(row.featureInputs), [...CATEGORICAL, ...NUMERIC]);
    assert.equal(row.featureInputs.currentUnits, days);
    assert.ok(!JSON.stringify(row).includes('never-project'));
    assert.equal(row.featureInputs.coefficients, undefined);
  }
  assert.equal(calls(), 2);
});

test('foreign inference revision, horizon, cutoff, snapshot or artifact cannot be attached to a prediction', async () => {
  for (const [field, value] of [['dataVersion', '999'], ['horizonDays', 14], ['observationsThrough', '2026-10-18'],
    ['snapshotHash', 'f'.repeat(64)], ['artifactHash', 'e'.repeat(64)], ['featureVersion', 'OTHER']]) {
    const { dashboard } = fixture(row => { row[field] = value; });
    assert.equal((await dashboard.forecast(request(7))).error.httpStatus, 503, field);
  }
});

test('missing or invalid feature values stay unavailable rather than becoming zero', () => {
  assert.equal(projectRidgeFeatureInputs({ status: 'READY', featureVersion: FEATURE_VERSION, featureHash: FEATURE_HASH, featureInputs: {} }), null);
  assert.equal(projectRidgeFeatureInputs({ status: 'MODEL_UNAVAILABLE' }), null);
});
