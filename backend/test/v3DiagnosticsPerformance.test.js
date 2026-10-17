'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { V3, createV3IntelligenceService } = require('../src/services/v3IntelligenceService');
const { createV3BusinessIntelligenceDashboard } = require('../src/services/v3BusinessIntelligenceDashboard');

const req = (query = {}) => ({ user: { businessId: V3.businessId }, query });
const query = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; },
  read() { return this; }, readConcern() { return this; }, setOptions() { return this; }, lean() { return this; },
  maxTimeMS: async () => value });

function fixture(options = {}) {
  const counts = { pointers: 0, artifacts: 0, revisions: 0, products: 0, snapshots: 0, registryLoads: 0, peakRuntime: 0 };
  const calls = [], versions = { 7: 2, 14: 3 };
  let running = 0;
  const artifact = (horizon, version = versions[horizon]) => {
    const bytes = Buffer.from(`offline-active-${horizon}-${version}`);
    return { businessId: V3.businessId, scenarioId: options.foreignScenario === horizon ? 'OTHER' : V3.scenarioId,
      horizonDays: horizon, modelVersion: version, status: 'ACTIVE', modelFamily: 'RIDGE_REGRESSION',
      recipeId: 'RIDGE-CAUSAL27', trainedAt: new Date('2026-10-15T00:00:00Z'), trainedDataVersion: '83',
      dataCutoff: '2026-10-14', featureVersion: 'RIDGE_CAUSAL27_V1',
      featureHash: '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5',
      promotionPolicyVersion: 'M6.10A22-PROMOTION-v1', promotionPolicyHash: 'c'.repeat(64),
      artifactData: bytes, artifactBytes: bytes.length,
      artifactHash: options.badHash === horizon ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') };
  };
  const models = {
    HistoricalScenario: { findOne: () => query({ businessId: V3.businessId, scenarioId: V3.scenarioId,
      status: 'completed', sourceSha256: V3.datasetSha256, metadata: { datasetVersion: V3.datasetVersion,
        referenceDate: V3.referenceDate, timezone: V3.timezone } }) },
    V3OperationalRevision: { findById: business => {
      counts.revisions++; assert.equal(business, V3.businessId);
      return query({ revision: 83n, bootstrapStatus: 'VERIFIED', historicalDatasetVersion: V3.datasetVersion,
        historicalDatasetSha256: V3.datasetSha256 });
    } },
    ForecastModelRegistry: { findOne: scope => {
      counts.pointers++;
      assert.equal(scope.businessId, V3.businessId); assert.equal(scope.scenarioId, V3.scenarioId);
      assert.ok([7, 14].includes(scope.horizonDays));
      return query(options.missing === scope.horizonDays ? null : {
        activeArtifactId: `pointer-${scope.horizonDays}-v${versions[scope.horizonDays]}`,
        activeModelVersion: versions[scope.horizonDays], nextModelVersion: 100 });
    } },
    ForecastModelArtifact: { findOne: filter => {
      counts.artifacts++;
      assert.equal(filter.businessId, V3.businessId); assert.equal(filter.scenarioId, V3.scenarioId);
      const horizon = filter.horizonDays ?? Number(filter._id.split('-')[1]);
      assert.equal(filter._id, `pointer-${horizon}-v${filter.modelVersion}`);
      return query(artifact(horizon, filter.modelVersion));
    } },
    Product: {
      findOne: scope => { counts.products++; assert.equal(scope.businessId, V3.businessId); return query({ sku: 'SKU-1' }); },
      find: scope => { assert.equal(scope.scenarioId, V3.scenarioId); return query([{ sku: 'SKU-1', name: 'Fixture' }]); },
    },
  };
  const registry = { getActiveModelArtifact: async scope => {
    counts.registryLoads++;
    const pointer = await models.ForecastModelRegistry.findOne(scope).maxTimeMS();
    if (!pointer) return null;
    const row = await models.ForecastModelArtifact.findOne({ ...scope, _id: pointer.activeArtifactId,
      modelVersion: pointer.activeModelVersion }).maxTimeMS();
    return { metadata: row, artifactData: row.artifactData };
  } };
  const intelligenceService = createV3IntelligenceService({ models, clock: () => new Date('2026-10-17T18:00:00Z'),
    snapshotBuilder: async input => {
      counts.snapshots++;
      return { mode: 'LIVE', dataVersion: '84', snapshot: { metadata: { businessId: input.businessId,
        scenarioId: V3.scenarioId, snapshotVersion: 'v3-operational-snapshot-v2', dataVersion: '84',
        asOfDate: input.asOfDate, observationsClosedThrough: '2026-10-16', snapshotHash: 'a'.repeat(64) } } };
    },
    mlClient: { intelligence: async (domain, payload) => {
      calls.push({ domain, payload });
      running++; counts.peakRuntime = Math.max(counts.peakRuntime, running);
      if (options.promoteDuringScoring && calls.length === 1) versions[14]++;
      await new Promise(resolve => setImmediate(resolve));
      running--;
      const meta = payload.operationalSnapshot.metadata;
      let data;
      if (domain === 'forecast') {
        const failed = options.failedHorizon === payload.horizonDays;
        data = { items: [{ sku: 'SKU-1', status: failed ? 'FEATURE_UNAVAILABLE' : 'READY',
          reasonCode: failed ? 'FEATURE_UNAVAILABLE' : null, predictionUnits: failed ? null : payload.horizonDays,
          activeModelStatus: 'ACTIVE', modelVersion: payload.activeRidgeModel.metadata.modelVersion,
          dataVersion: options.mixedRevision === payload.horizonDays ? '85' : meta.dataVersion,
          snapshotHash: meta.snapshotHash, observationsThrough: meta.observationsClosedThrough }] };
      } else {
        assert.equal(domain, 'health');
        const section = status => ({ status, freshness: { mode: 'LIVE' }, alerts: [] });
        data = { availabilityStatus: options.partialHealth ? 'PARTIAL' : 'AVAILABLE', healthScore: null,
          healthCompletenessPolicyVersion: 'm6.10a36113-abc-informational-v1',
          blockingReasons: options.partialHealth ? ['CUSTOMER_ANALYTICS_PARTIAL'] : [],
          customerDiagnostics: [{ code: 'CUSTOMER_HISTORICAL_COST_COVERAGE_INCOMPLETE', affectedCustomerCount: 6,
            unknownSaleLineCount: 27 }], businessHealth: { forecast: section('AVAILABLE'), inventory: section('AVAILABLE'),
            suppliers: section('AVAILABLE'), customers: section(options.partialHealth ? 'PARTIAL' : 'AVAILABLE') }, alerts: [] };
      }
      return { requestId: payload.requestId, status: options.partialHealth ? 'PARTIAL' : 'OK', data,
        metadata: { ...payload.context, dataVersion: meta.dataVersion, snapshotHash: meta.snapshotHash,
          source: 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT', contractVersion: 'm6.9f4-live-intelligence-v1' } };
    } },
  });
  const dashboard = createV3BusinessIntelligenceDashboard({ models, intelligenceService, forecastRegistryService: registry });
  return { dashboard, calls, counts, versions };
}

test('ACTIVE pins two exact pointers once and checks 7/14 concurrently on one request snapshot', async () => {
  const f = fixture();
  const result = await f.dashboard.activeForecastModels(req());
  assert.ok(result.data, JSON.stringify(result.error));
  assert.ok(result.data.models.slice(1).every(row => row.status === 'ACTIVE'), JSON.stringify(result.data.models));
  assert.deepEqual(result.data.models.map(row => [row.horizonDays, row.status, row.modelVersion ?? null]),
    [[1, 'MODEL_NOT_APPROVED', null], [7, 'ACTIVE', 2], [14, 'ACTIVE', 3]]);
  assert.equal(result.data.models[0].reasonCode, 'PROMOTION_POLICY_FAILED');
  assert.equal(result.data.forecastServing.dataVersion, '84');
  assert.equal(result.data.forecastServing.observationsClosedThrough, '2026-10-16');
  assert.equal(f.counts.pointers, 2); assert.equal(f.counts.artifacts, 2); assert.equal(f.counts.registryLoads, 0);
  assert.equal(f.counts.revisions, 1); assert.equal(f.counts.products, 1); assert.equal(f.counts.snapshots, 1);
  assert.equal(f.counts.peakRuntime, 2); assert.equal(f.calls.length, 2);
  assert.equal(new Set(f.calls.map(row => row.payload.requestId)).size, 1);
  assert.ok(f.calls.every(row => row.payload.context.asOfDate === '2026-10-17'));
  assert.doesNotMatch(JSON.stringify(result), /"artifactData"|"artifactHash"|offline-active|"promotionPolicyHash"/);
});

test('ACTIVE retains the requested asOf in both serving checks', async () => {
  const f = fixture();
  const result = await f.dashboard.activeForecastModels(req({ asOf: '2026-10-16' }));
  assert.equal(result.data.forecastServing.asOf, '2026-10-16');
  assert.ok(f.calls.every(row => row.payload.context.asOfDate === '2026-10-16'));
  assert.equal(f.counts.snapshots, 1);
});

test('a promotion during scoring cannot replace the pinned model; the next request reads fresh pointers', async () => {
  const f = fixture({ promoteDuringScoring: true });
  const first = await f.dashboard.activeForecastModels(req());
  assert.equal(first.data.models[2].modelVersion, 3);
  assert.equal(f.calls[1].payload.activeRidgeModel.metadata.modelVersion, 3);
  const second = await f.dashboard.activeForecastModels(req());
  assert.equal(second.data.models[2].modelVersion, 4);
  assert.equal(f.counts.pointers, 4); assert.equal(f.counts.artifacts, 4); assert.equal(f.counts.snapshots, 2);
});

for (const horizon of [7, 14]) {
  test(`failure/integrity of ${horizon}d remains attributable and does not suppress the other horizon`, async () => {
    for (const options of [{ failedHorizon: horizon }, { badHash: horizon }, { missing: horizon }, { foreignScenario: horizon }]) {
      const f = fixture(options);
      const { data } = await f.dashboard.activeForecastModels(req());
      const row = data.models.find(model => model.horizonDays === horizon);
      assert.equal(row.status, 'MODEL_UNAVAILABLE');
      assert.equal(data.models.find(model => model.horizonDays === (horizon === 7 ? 14 : 7)).status, 'ACTIVE');
      if (options.badHash) assert.equal(row.reasonCode, 'ARTIFACT_HASH_MISMATCH');
      if (options.missing) assert.equal(row.reasonCode, 'REGISTRY_NOT_FOUND');
      if (options.foreignScenario) assert.equal(row.reasonCode, 'SCENARIO_SCOPE_MISMATCH');
      if (!options.failedHorizon) assert.equal(f.calls.length, 1);
    }
  });
}

test('ACTIVE rejects mixed per-horizon revision evidence instead of combining it', async () => {
  const f = fixture({ mixedRevision: 14 });
  const { data } = await f.dashboard.activeForecastModels(req());
  assert.equal(data.models[1].status, 'ACTIVE');
  assert.equal(data.models[2].status, 'MODEL_UNAVAILABLE');
  assert.equal(data.models[2].reasonCode, 'SNAPSHOT_UNAVAILABLE');
  assert.equal(data.forecastServing.dataVersion, '84');
  assert.equal(data.forecastServing.snapshotStatus, 'UNAVAILABLE');
});

test('tenant denial precedes all diagnostic Registry/runtime reads', async () => {
  const f = fixture();
  const result = await f.dashboard.activeForecastModels({ ...req(), businessId: 'OTHER' });
  assert.equal(result.error.httpStatus, 403);
  assert.equal(f.counts.pointers, 0); assert.equal(f.calls.length, 0);
});

test('Health diagnostic uses one runtime call, one snapshot and one exact Ridge pair with unchanged status mapping', async () => {
  for (const partialHealth of [false, true]) {
    const f = fixture({ partialHealth });
    const { data } = await f.dashboard.healthDiagnostic(req());
    assert.equal(data.httpStatus, 200);
    assert.deepEqual(data.dependencyStatus, { inventory: 'READY', forecast: 'READY', supplier: 'READY',
      healthAssembly: partialHealth ? 'PARTIAL' : 'READY' });
    assert.deepEqual(data.blockingReasons, partialHealth ? ['CUSTOMER_ANALYTICS_PARTIAL'] : []);
    assert.equal(data.healthCompletenessPolicyVersion, 'm6.10a36113-abc-informational-v1');
    assert.equal(data.reasonCode, null);
    assert.equal(data.customerDiagnostics[0].unknownSaleLineCount, 27);
    assert.equal(f.calls.length, 1); assert.equal(f.counts.registryLoads, 2);
    assert.equal(f.counts.pointers, 2); assert.equal(f.counts.artifacts, 2); assert.equal(f.counts.snapshots, 1);
    assert.deepEqual(f.calls[0].payload.activeRidgeModels.map(model => model.metadata.horizonDays), [7, 14]);
  }
});
