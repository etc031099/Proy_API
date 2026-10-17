'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createV3BusinessIntelligenceDashboard } = require('../src/services/v3BusinessIntelligenceDashboard');
const { createV3IntelligenceService, V3 } = require('../src/services/v3IntelligenceService');

const request = (query = {}) => ({ user: { businessId: V3.businessId }, query });
const queryResult = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; },
  lean() { return this; }, maxTimeMS: async () => value });

function fixture() {
  const state = { revision: '83', version: 1, partial: false, omitSummary: false, failure: null, foreignScenario: false };
  const calls = [], snapshots = [], registryReads = [];
  const models = {
    HistoricalScenario: { findOne: () => queryResult({ businessId: V3.businessId, scenarioId: V3.scenarioId,
      status: 'completed', sourceSha256: V3.datasetSha256, metadata: { datasetVersion: V3.datasetVersion,
        referenceDate: V3.referenceDate, timezone: V3.timezone } }) },
    Product: { find: filter => {
      assert.equal(filter.businessId, V3.businessId);
      assert.equal(filter.scenarioId, V3.scenarioId);
      return queryResult([{ sku: 'SKU-1', name: 'Producto uno' }]);
    } },
  };
  const intelligenceService = createV3IntelligenceService({ models, clock: () => new Date('2026-10-17T18:00:00Z'),
    snapshotBuilder: async input => {
      snapshots.push(input);
      return { mode: 'LIVE', dataVersion: state.revision, snapshot: { metadata: {
        snapshotVersion: 'v3-operational-snapshot-v2', businessId: input.businessId, scenarioId: V3.scenarioId,
        asOfDate: input.asOfDate, dataVersion: state.revision, snapshotHash: state.revision.padStart(64, '0'),
        observationsClosedThrough: '2026-10-16', capturedAtUtc: '2026-10-17T18:00:00Z', dataThroughUtc: '2026-10-16T23:59:59Z',
      } } };
    },
    mlClient: { intelligence: async (domain, payload) => {
      calls.push(payload);
      assert.equal(domain, 'inventory');
      if (state.failure) throw Object.assign(new Error('private upstream details'), { functionalCode: state.failure });
      const live = payload.dataMode === 'LIVE';
      const activeModels = payload.activeRidgeModels || [];
      const partial = state.partial || live && !activeModels.length;
      const availabilityStatus = partial ? 'PARTIAL' : 'AVAILABLE';
      const inventorySummary = { availabilityStatus, unavailableCount: 0,
        reasonCode: partial ? 'FORECAST_HORIZON_UNAVAILABLE' : null,
        fieldAvailability: { risk: availabilityStatus, reorder: availabilityStatus },
        summary: { products: 1, critical: partial ? null : 1, high: partial ? null : 0, medium: partial ? null : 0,
          low: partial ? null : 0, shouldReorder: partial ? null : 0, lowStock: 1, overstock: partial ? null : 0,
          riskUnavailableCount: partial ? 1 : 0, recommendationUnavailableCount: partial ? 1 : 0,
          modelVersion7: activeModels.find(row => row.metadata.horizonDays === 7)?.metadata.modelVersion ?? null,
          modelVersion14: activeModels.find(row => row.metadata.horizonDays === 14)?.metadata.modelVersion ?? null },
        abcCounts: { A: 0, B: 0, C: 0, UNCLASSIFIED: 1 }, xyzCounts: { X: 1, Y: 0, Z: 0, UNCLASSIFIED: 0 } };
      if (!live) {
        delete inventorySummary.availabilityStatus;
        delete inventorySummary.unavailableCount;
        delete inventorySummary.reasonCode;
        delete inventorySummary.fieldAvailability;
      }
      const row = { sku: 'SKU-1', stock: { onHand: 8 }, risk: { level: partial ? null : 'CRITICAL' },
        coverage: { daysCover: partial ? null : 4 },
        recommendation: partial ? { recommendedQty: null, shouldReorder: null, status: 'PARTIAL', availabilityStatus: 'PARTIAL',
          reasonCode: 'FORECAST_HORIZON_UNAVAILABLE' } : { recommendedQty: 12, shouldReorder: false } };
      const items = partial && payload.mode === 'rank' ? [] : [row];
      const data = { availabilityStatus, total: items.length, items,
        ...(payload.includeSummary && !state.omitSummary ? { inventorySummary } : {}) };
      return { requestId: payload.requestId, status: partial ? 'PARTIAL' : 'OK', data,
        metadata: { ...payload.context,
          ...(live ? { dataVersion: payload.operationalSnapshot.metadata.dataVersion,
            snapshotHash: payload.operationalSnapshot.metadata.snapshotHash } : {}),
          source: live ? 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT' : 'CANONICAL_V3_BUNDLE',
          contractVersion: live ? 'm6.9f4-live-intelligence-v1' : 'm6.9b-v3-intelligence-v1' } };
    } },
  });
  const dashboard = createV3BusinessIntelligenceDashboard({ models, intelligenceService,
    forecastRegistryService: { getActiveModelArtifact: async scope => {
      registryReads.push(scope);
      return { artifactData: Buffer.from('fixture'), metadata: { ...scope, status: 'ACTIVE', modelVersion: state.version,
        scenarioId: state.foreignScenario ? 'FOREIGN' : scope.scenarioId, trainedDataVersion: '83',
        modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', trainedAt: '2026-10-15T00:00:00Z',
        dataCutoff: '2026-10-14', featureVersion: 'RIDGE_CAUSAL27_V1', featureHash: 'a'.repeat(64),
        promotionPolicyVersion: 'M6.10A22-PROMOTION-v1', promotionPolicyHash: 'b'.repeat(64),
        artifactHash: 'c'.repeat(64), artifactBytes: 7 } };
    } } });
  return { dashboard, intelligenceService, state, calls, snapshots, registryReads };
}

test('one Inventory request uses one runtime evaluation, one snapshot, and one ACTIVE 7/14 pair', async () => {
  const f = fixture();
  const result = await f.dashboard.inventory(request({ limit: '5' }));
  assert.ok(result.data, JSON.stringify(result.error));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].includeSummary, true);
  assert.equal(f.snapshots.length, 1);
  assert.deepEqual(f.registryReads.map(row => row.horizonDays).sort((a, b) => a - b), [7, 14]);
  assert.deepEqual(f.calls[0].activeRidgeModels.map(row => row.metadata.horizonDays), [7, 14]);
  assert.equal(result.data.dataVersion, '83');
  assert.equal(result.data.freshness.dataVersion, '83');
  assert.equal(result.data.summary.totalProducts, 1);
  assert.deepEqual(result.data.summary.riskCounts, { critical: 1, high: 0, medium: 0, low: 0 });
  assert.equal(Object.values(result.data.summary.abcCounts).reduce((a, b) => a + b, 0), 1);
  assert.equal(Object.values(result.data.summary.xyzCounts).reduce((a, b) => a + b, 0), 1);
  assert.equal(result.data.items[0].recommendedQty, 12);
  assert.equal(result.data.items[0].reorderNow, false);
  assert.equal(result.data.availabilityStatus, 'AVAILABLE');
});

test('filtered Inventory preserves null risk/recommendation and independent global unavailable counts', async () => {
  const f = fixture(); f.state.partial = true;
  const result = await f.dashboard.inventory(request({ flag: 'low_stock' }));
  assert.ok(result.data, JSON.stringify(result.error));
  assert.equal(f.calls.length, 1);
  assert.equal(result.data.items[0].risk, null);
  assert.equal(result.data.items[0].recommendedQty, null);
  assert.equal(result.data.items[0].reorderNow, null);
  assert.equal(result.data.summary.riskCounts.low, null);
  assert.equal(result.data.summary.riskUnavailableCount, 1);
  assert.equal(result.data.unavailableCount, 0);
  assert.equal(result.data.availabilityStatus, 'PARTIAL');
});

test('historical Inventory also uses a single projection without LIVE snapshot or Ridge loads', async () => {
  const f = fixture();
  const result = await f.dashboard.inventory(request({ asOf: V3.historicalCutoff }));
  assert.ok(result.data, JSON.stringify(result.error));
  assert.equal(result.data.mode, 'HISTORICAL');
  assert.equal(result.data.availabilityStatus, 'READY');
  assert.equal(result.data.summary.totalProducts, 1);
  assert.equal(result.data.items[0].recommendedQty, 12);
  assert.equal(f.calls.length, 1);
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.registryReads.length, 0);
  assert.equal(f.calls[0].activeRidgeModels, undefined);
});

test('new revision/asOf and new ACTIVE versions always read fresh scope without cross-request reuse', async () => {
  const f = fixture();
  const first = await f.dashboard.inventory(request());
  f.state.revision = '84';
  const second = await f.dashboard.inventory(request({ asOf: '2026-10-16' }));
  f.state.version = 2;
  const third = await f.dashboard.inventory(request());
  assert.equal(first.data.dataVersion, '83'); assert.equal(second.data.dataVersion, '84');
  assert.equal(second.data.asOf, '2026-10-16');
  assert.equal(first.data.summary.modelVersion7, 1); assert.equal(third.data.summary.modelVersion7, 2);
  assert.equal(third.data.summary.modelVersion14, 2);
  assert.equal(f.calls.length, 3); assert.equal(f.snapshots.length, 3); assert.equal(f.registryReads.length, 6);
  assert.equal(new Set(f.calls.map(row => row.requestId)).size, 3);
  assert.ok(f.registryReads.every(scope => scope.businessId === V3.businessId && scope.scenarioId === V3.scenarioId));
});

test('tenant and scenario mismatches cannot reuse a previous Inventory result or foreign models', async () => {
  const f = fixture();
  await f.dashboard.inventory(request());
  const rejected = await f.dashboard.inventory({ ...request(), businessId: 'OTHER' });
  assert.equal(rejected.error.httpStatus, 403); assert.equal(f.calls.length, 1);
  f.state.foreignScenario = true;
  const partial = await f.dashboard.inventory(request());
  assert.deepEqual(f.calls[1].activeRidgeModels, []);
  assert.equal(partial.data.availabilityStatus, 'PARTIAL');
  assert.equal(partial.data.summary.modelVersion7, null);
});

test('missing combined projection and upstream errors fail safely without a second evaluation', async () => {
  const f = fixture(); f.state.omitSummary = true;
  const invalid = await f.dashboard.inventory(request());
  assert.equal(invalid.error.code, 'INVENTORY_RESPONSE_INVALID'); assert.equal(f.calls.length, 1);
  f.state.failure = 'LIVE_SNAPSHOT_UNAVAILABLE';
  const failed = await f.dashboard.inventory(request());
  assert.equal(failed.error.code, 'LIVE_SNAPSHOT_UNAVAILABLE'); assert.equal(f.calls.length, 2);
  assert.doesNotMatch(failed.error.message, /private|upstream/);
});

test('combined projection is internal opt-in; skill args cannot enable it and other domains reject it', async () => {
  const f = fixture();
  const invocation = { context: { businessId: V3.businessId, requestId: 'legacy-request' },
    skill: { id: 'get_inventory_intelligence', maxRecords: 20 },
    args: { mode: 'rank', metric: 'stockout_risk', includeSummary: true }, signal: new AbortController().signal };
  const legacy = await f.intelligenceService.execute(invocation);
  assert.equal(f.calls[0].includeSummary, undefined);
  assert.equal(legacy.data.inventorySummary, undefined);
  await assert.rejects(f.intelligenceService.execute({ ...invocation, includeInventorySummary: true,
    skill: { id: 'get_product_forecast', maxRecords: 20 } }), { code: 'AGENT_INVALID_SKILL_ARGS' });
  await assert.rejects(f.intelligenceService.execute({ ...invocation, includeInventorySummary: 'true' }),
    { code: 'AGENT_INVALID_SKILL_ARGS' });
  assert.equal(f.calls.length, 1);
});
