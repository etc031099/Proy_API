'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createV3BusinessIntelligenceDashboard, safeError } = require('../src/services/v3BusinessIntelligenceDashboard');
const { createBusinessIntelligenceDashboardRoutes } = require('../src/routes/businessIntelligenceDashboard');
const { V3 } = require('../src/services/v3IntelligenceService');
const { authenticate } = require('../src/middleware/auth');

const user = { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, isActive: true, role: 'user' };
const request = (query = {}, params = {}) => ({ user, businessId: user.businessId, query, params });

test('revision read is primary/majority, verified, lossless and tenant-bound without ML or snapshots', async () => {
  const reads = [];
  let row = { revision: 9007199254740993n, bootstrapStatus: 'VERIFIED', historicalDatasetVersion: V3.datasetVersion, historicalDatasetSha256: V3.datasetSha256 };
  const chain = { select() { return this; }, read(value) { reads.push(value); return this; }, readConcern(value) { reads.push(value); return this; },
    setOptions() { return this; }, lean() { return this; }, maxTimeMS: async () => row };
  const service = createV3BusinessIntelligenceDashboard({ models: { V3OperationalRevision: { findById(id) { reads.push(id); return chain; } } },
    intelligenceService: { resolveContext: async context => context.businessId === V3.businessId ? { operationalDate: '2026-10-14' } : null,
      execute() { assert.fail('Revision must not invoke analytics'); } } });
  const result = await service.revision(request({ businessId: 'OTHER' }));
  assert.equal(result.data.dataVersion, '9007199254740993'); assert.equal(result.data.businessId, V3.businessId);
  assert.deepEqual(reads, [V3.businessId, 'primary', 'majority']);
  row = { ...row, revision: 0n }; assert.equal((await service.revision(request())).data.dataVersion, '0');
  row = { ...row, bootstrapStatus: 'UNVERIFIED' }; assert.equal((await service.revision(request())).error.code, 'SNAPSHOT_BOOTSTRAP_REQUIRED');
  row = null; assert.equal((await service.revision(request())).error.httpStatus, 503);
  const foreign = await service.revision({ user: { ...user, businessId: 'OTHER' }, businessId: 'OTHER', query: {} });
  assert.equal(foreign.error.httpStatus, 403);
});

test('sales parallel reads stay bounded, ordered and share one request context', async () => {
  let active = 0, peak = 0;
  const requestIds = new Set();
  const service = createV3BusinessIntelligenceDashboard({ intelligenceService: {
    resolveContext: async () => ({ operationalDate: '2026-10-14' }),
    execute: async invocation => {
      requestIds.add(invocation.context.requestId); active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return { status: 'READY', metadata: { dataMode: 'LIVE' }, data: { kpis: { revenueCents: 1200, unitsSold: 2, ticketCount: 1 }, items: [] } };
    }
  } });
  const result = await service.sales(request({ period: 'LAST_7_DAYS', includeSeries: 'true' }));
  assert.ok(result.data, JSON.stringify(result.error));
  assert.equal(result.data.series.length, 7); assert.equal(peak, 4); assert.equal(requestIds.size, 1);
  assert.deepEqual(result.data.series.map(row => row.date), ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
  assert.ok(result.data.series.every(row => row.revenue.value === 12 && row.units === 2));
});
const makeDashboard = ({ fail, partial = false, productPresent = true, supplierNoHistory = false, activeModelMissing = false, forecastFeatureUnavailable = false,
  crossSellItems = [{ antecedentSkus: ['SKU-1'], consequentSkus: ['SKU-2'], recommendedSku: 'SKU-2',
    recommendedProduct: 'Producto dos', ticketCount: 32,
    support: .003, confidence: .4, lift: 1.8, stability: { status: 'STABLE' } }] } = {}) => {
  const calls = [];
  const registryCalls = [];
  const forecastRegistryService = {
    async getActiveModelMetadata(scope) { registryCalls.push({ kind: 'metadata', ...scope });
      return activeModelMissing ? null : modelMetadata(scope.horizonDays); },
    async getActiveModelArtifact(scope) { registryCalls.push({ kind: 'artifact', ...scope });
      return activeModelMissing ? null : { metadata: modelMetadata(scope.horizonDays), artifactData: Buffer.from('ridge-fixture') }; }
  };
  const intelligenceService = {
    async resolveContext(context) { calls.push({ kind: 'context', businessId: context.businessId });
      return { businessId: V3.businessId, operationalDate: '2026-10-14' }; },
    async execute(invocation) {
      calls.push({ kind: invocation.skill.id, context: invocation.context, args: invocation.args,
        useLiveRidge: invocation.useLiveRidge, trustedForecastModelEnvelope: invocation.trustedForecastModelEnvelope,
        trustedInventoryRidgeModels: invocation.trustedInventoryRidgeModels });
      if (fail) { const error = new Error('private upstream error'); error.functionalCode = fail; throw error; }
      const metadata = { dataMode: 'LIVE', updatedAt: '2026-10-14T18:00:00.000Z', dataThrough: '2026-10-14T17:55:00.000Z' };
      switch (invocation.skill.id) {
        case 'get_business_analytics': return { status: partial ? 'PARTIAL' : 'READY', metadata,
          data: invocation.args.mode === 'rank' ? { metric: invocation.args.entityType === 'category' ? 'revenueCents' : 'revenue', total: 1,
            items: [invocation.args.entityType === 'category' ? { categoryCode: 'FOODS_1', name: 'Alimentos', revenueCents: 1200, units: 4, ticketCount: 2 }
              : { sku: 'SKU-1', name: 'Producto uno', metric: 1200, metricName: 'revenue' }] }
            : { kpis: { revenueCents: 0, unitsSold: 0, ticketCount: 0, averageTicket: 0, grossMarginCents: null, grossMarginPct: null },
              previousPeriod: { startDate: '2026-10-07', endDate: '2026-10-13' },
              trends: { revenue: { percentChange: null, absoluteChange: null }, units: { percentChange: 5 } } } };
        case 'get_inventory_intelligence': {
          const inventorySummary = { summary: {
          products: 80, critical: 2, high: 3, medium: 10, low: 65, shouldReorder: 5, lowStock: 8, overstock: 4,
          slowMoving: 6, deadStock: 0, incomingUnits: 10 }, abcCounts: { A: 40, B: 24, C: 16 },
          xyzCounts: { X: 55, Y: 22, Z: 3 }, abcXyzCounts: { AX: 20 } };
          if (invocation.args.mode === 'summary' && !invocation.args.flag) return { status: 'READY', metadata, data: inventorySummary };
          const result = metadata.dataMode === 'LIVE' && !invocation.trustedInventoryRidgeModels?.length
            ? { status: 'PARTIAL', metadata, data: { availabilityStatus: 'PARTIAL', total: 1, items: [{ sku: 'SKU-1', productName: 'Producto uno',
              stock: { onHand: 1, incoming: 2, inventoryPosition: 3 }, coverage: { daysCover: null, status: 'PARTIAL', reasonCode: 'FORECAST_UNAVAILABLE' },
              demand: { expectedDaily: null, expectedUnitsNext1d: null, expectedUnitsNext7d: null, expectedUnitsNext14d: null },
              inventoryPolicy: { safetyStock: null, reorderPoint: null, status: 'PARTIAL', reasonCode: 'FORECAST_UNAVAILABLE' },
              recommendation: { shouldReorder: null, recommendedQty: null, status: 'PARTIAL', reasonCode: 'FORECAST_UNAVAILABLE' },
              risk: { level: null, lowStock: true, reasonCodes: [], status: 'PARTIAL', reasonCode: 'FORECAST_UNAVAILABLE' }, classification: { abc: 'A', xyz: 'X' } }] } }
            : { status: 'READY', metadata, data: { total: 1, items: [{ sku: 'SKU-1', productName: 'Producto uno',
            stock: { onHand: 1, incoming: 2, inventoryPosition: 3 }, coverage: { daysCover: 1.5, status: 'AVAILABLE' },
            demand: { expectedDaily: 2, expectedUnitsNext1d: null, expectedUnitsNext7d: 14, expectedUnitsNext14d: 28 },
            inventoryPolicy: { safetyStock: 3, reorderPoint: 5 }, recommendation: { shouldReorder: true, recommendedQty: 4 },
            risk: { level: 'HIGH', lowStock: false, reasonCodes: ['LOW_COVERAGE'] }, classification: { abc: 'A', xyz: 'X' } }] } };
          return { ...result, data: { ...result.data, inventorySummary } };
        }
        case 'get_supplier_intelligence': {
          const row = { supplierCode: invocation.args.supplierRef || 'SUP-05', displayName: 'Proveedor cinco', purchaseOrderCount: 22,
            receivedOrderCount: 18, pendingOrderCount: 4, receivedSpendCents: 67890, exclusiveOfferedSkuCount: 2, offeredSkuCount: 16,
            purchaseSpendSharePct: 12, leadTime: supplierNoHistory ? null : { averageDays: 4, sampleSize: 18 }, punctuality: { onTimeRatePct: 80 },
            productsSupplied: [{ sku: 'SKU-1', name: 'Producto uno' }] };
          return { status: 'READY', metadata, data: { total: invocation.args.supplierRef ? 1 : 10,
            items: invocation.args.supplierRef ? [row] : [row, { ...row, supplierCode: 'SUP-01', pendingOrderCount: 3 }],
            summary: { suppliers: 10, pendingOrders: 29, receivedOrders: 2126, receivedSpendCents: 100000 },
            ...(invocation.args.mode === 'detail' ? { costTrends: [{ sku: 'SKU-1', latestPurchaseCostCents: 1700, recentChangePct: 2 }] } : {}) } };
        }
        case 'get_customer_intelligence': {
          const row = { customerCode: invocation.args.customerRef || 'CLI-001', displayName: 'Cliente uno', segment: 'AT_RISK', recencyDays: 5,
            ticketCount: 10, totalSpentCents: 12345, averageTicketCents: 1234.5, lastPurchaseDate: '2026-10-09',
            reasonCodes: ['RECENT_TREND_DECLINING'], preferences: { favoriteCategoryCode: 'FOODS' }, trends30d: { status: 'DECLINING' }, windows: {},
            rfm90d: { raw: { recencyDays: 5, frequency90d: 3, monetary90dCents: 6789 } } };
          return { status: 'READY', metadata, data: { total: invocation.args.customerRef ? 1 : 40, items: [row],
            ...(invocation.args.mode === 'summary' ? { segmentDistribution: { AT_RISK: 4, INACTIVE: 6, NEW: 5, LOYAL: 10, TOP_HIGH_VALUE: 8, POTENTIAL: 7 } } : {}) } };
        }
        case 'get_cross_sell_recommendations': return { status: 'READY', metadata, data: invocation.args.mode === 'summary'
          ? { available: true, total: 66, items: [], summary: { analysisCutoff: '2026-10-12', validTickets: 12647, itemsetsCount: 432,
            rulesCount: 66, qualityRulesCount: 67, crossSellCount: 33 } }
          : { available: true, sourceSku: 'SKU-1', total: crossSellItems.length, items: crossSellItems } };
        case 'get_business_health': return { status: 'READY', metadata, data: { availabilityStatus: 'PARTIAL', healthScore: null,
          healthCompletenessPolicyVersion: 'm6.10a36113-abc-informational-v1', blockingReasons: ['MARKET_BASKET_UNAVAILABLE'],
          customerDiagnostics: [{ code: 'CUSTOMER_PERIOD_COST_COVERAGE_INCOMPLETE', affectedCustomerCount: 3, unknownSaleLineCount: 7 }],
          businessHealth: { sales: { kpis: {}, freshness: { status: 'LIVE' }, alerts: [] }, inventory: { critical: 2, freshness: { status: 'LIVE' }, alerts: [] },
            customers: { atRiskCount: 4, freshness: { status: 'LIVE' }, alerts: [] }, suppliers: { pending: 4, freshness: { status: 'LIVE' }, alerts: [] },
            forecast: { knownCount: 80, freshness: { status: 'LIVE' }, alerts: [] }, marketBasket: { available: true,
              freshness: { mode: 'FROZEN', cutoff: '2026-10-12' }, alerts: [] } }, alerts: [] } };
        case 'get_product_forecast': if (invocation.useLiveRidge) {
          const days = invocation.args.horizonDays;
          const hasActive = days === 1 || Boolean(invocation.trustedForecastModelEnvelope);
          const rowStatus = days === 1 ? 'MODEL_NOT_APPROVED' : forecastFeatureUnavailable ? 'FEATURE_UNAVAILABLE'
            : hasActive ? 'READY' : 'MODEL_UNAVAILABLE';
          return { status: 'READY', metadata, data: { items: [{ sku: 'SKU-1', productName: 'Producto uno',
            status: rowStatus,
            reasonCode: days === 1 ? 'PROMOTION_POLICY_FAILED' : rowStatus === 'FEATURE_UNAVAILABLE' ? 'FEATURE_UNAVAILABLE'
              : hasActive ? null : 'ACTIVE_MODEL_NOT_FOUND',
            horizonDays: days, predictionUnits: rowStatus !== 'READY' ? null : days === 7 ? 16.25 : 32.5,
            modelFamily: days === 1 || !hasActive ? 'RIDGE_REGRESSION' : 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27',
            targetDefinition: 'effective_units_sold_cumulative_t_plus_1_through_t_plus_h',
            forecastStartDate: '2026-10-14', forecastEndDate: days === 1 ? '2026-10-14' : `2026-10-${days === 7 ? '20' : '27'}`,
            observationsThrough: '2026-10-13', featureVersion: 'RIDGE_CAUSAL27_V1', promotionPolicyVersion: 'M6.10A22-PROMOTION-v1',
            modelVersion: hasActive && days !== 1 ? 1 : null, trainedAt: hasActive ? '2026-10-15T10:00:00.000Z' : null,
            trainedDataVersion: hasActive ? '0' : null, dataCutoff: hasActive ? '2026-10-13' : null,
            activeModelStatus: days === 1 ? 'NOT_APPROVED' : hasActive ? 'ACTIVE' : 'NONE',
            dataVersion: '1', snapshotHash: 'a'.repeat(64), baselineUnits: days === 1 ? null : days === 7 ? 14 : 28,
            observedSeries: [{ date: '2026-10-13', units: 0, status: 'ZERO' }] }] } };
        }
          return { status: 'READY', metadata: { ...metadata, dataMode: 'HISTORICAL' }, data: { items: [{ sku: 'SKU-1', productName: 'Producto uno',
          status: 'READY', observationsThrough: '2026-10-13', expectedUnitsNext1d: 2.32, expectedUnitsNext7d: 16.25,
          expectedUnitsNext14d: 32.5, observedSeries: [{ date: '2026-10-13', units: 0, status: 'ZERO' }], forecastStartDate: '2026-10-14' }] } };
        default: throw new Error('unexpected skill');
      }
    }
  };
  const product = { sku: 'SKU-1', name: 'Producto uno 500 g', presentation: 'Bolsa', brand: 'Demo', sizeValue: 500, sizeUnit: 'g' };
  const registryRead = value => ({ select() { return this; }, read() { return this; }, readConcern() { return this; },
    lean() { return this; }, maxTimeMS: async () => value });
  const artifactBytes = Buffer.from('ridge-fixture');
  const models = { Product: {
    findOne: () => ({ select() { return this; }, sort() { return this; }, lean() { return this; }, maxTimeMS: async () => productPresent ? product : null }),
    find: filter => ({ select() { return this; }, lean() { return this; }, maxTimeMS: async () => {
      assert.equal(filter.businessId, V3.businessId);
      return [{ sku: 'SKU-1', name: 'Producto uno 500 g', presentation: 'Bolsa' }];
    } })
  }, ForecastModelRegistry: { findOne: filter => registryRead(activeModelMissing ? null
    : { activeArtifactId: `artifact-${filter.horizonDays}`, activeModelVersion: 1 }) },
  ForecastModelArtifact: { findOne: filter => registryRead(activeModelMissing ? null : ({ ...modelMetadata(Number(String(filter._id).split('-').at(-1))),
    _id: `artifact-${filter.horizonDays}`, artifactBytes: artifactBytes.length,
    artifactHash: require('node:crypto').createHash('sha256').update(artifactBytes).digest('hex'), artifactData: artifactBytes })) } };
  return { service: createV3BusinessIntelligenceDashboard({ models, intelligenceService, forecastRegistryService }), calls, registryCalls, models };
};

function modelMetadata(horizonDays) {
  return { businessId: V3.businessId, scenarioId: V3.scenarioId, horizonDays, status: 'ACTIVE',
    modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', modelVersion: 1,
    trainedAt: new Date('2026-10-15T10:00:00.000Z'), trainedDataVersion: '0', dataCutoff: '2026-10-13',
    featureVersion: 'RIDGE_CAUSAL27_V1', featureHash: '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5', promotionPolicyVersion: 'M6.10A22-PROMOTION-v1',
    promotionPolicyHash: 'c'.repeat(64), artifactHash: 'd'.repeat(64), artifactBytes: Buffer.byteLength('ridge-fixture'),
    globalWape: 0.2, globalMae: 1.4, globalBias: -0.03 };
}
const diagnosticRead = value => ({ select() { return this; }, read() { return this; }, readConcern() { return this; },
  lean() { return this; }, maxTimeMS: async () => value });

test('dashboard summary preserves genuine zero sales and unavailable/partial margin as null', async () => {
  for (const partial of [false, true]) {
    const { service } = makeDashboard({ partial });
    const { data } = await service.summary(request({ businessId: 'ATTACKER-CONTROLLED' }));
    assert.deepEqual(data.salesToday, { value: 0, currency: 'PEN' });
    assert.equal(data.unitsToday, 0);
    assert.equal(data.ticketsToday, 0);
    assert.equal(data.grossMargin.value, null);
    assert.equal(data.grossMargin.percent, null);
    assert.equal(data.grossMargin.availability, partial ? 'PARTIAL' : 'UNAVAILABLE');
    assert.equal(data.inventory.pendingPurchasesCount, 29);
    assert.equal(data.asOf, '2026-10-14');
  }
});

test('dashboard summary derives tenant only from the authenticated request and shares one request context', async () => {
  const { service, calls } = makeDashboard();
  await service.summary(request({ businessId: 'OTHER-TENANT' }));
  const executions = calls.filter(row => row.kind !== 'context');
  assert.equal(calls[0].businessId, V3.businessId);
  assert.equal(new Set(executions.map(row => row.context.requestId)).size, 1);
  assert.ok(executions.every(row => row.context.businessId === V3.businessId));
});

test('LIVE forecast uses exact ACTIVE Ridge artifact for 7/14; horizon 1 is not approved and 28d is rejected', async () => {
  const { service, calls, registryCalls } = makeDashboard();
  const { data } = await service.forecast(request({ horizonDays: '14' }, { sku: 'SKU-1' }));
  assert.equal(data.horizons['1d'], null);
  assert.equal(data.horizons['14d'], 32.5);
  assert.equal(data.method, 'RIDGE_REGRESSION');
  assert.equal(data.modelVersion, 1);
  assert.equal(data.baselineUnits, 28);
  assert.equal(data.forecastPeriod.selectedHorizonDays, 14);
  assert.equal(data.observedSeries[0].status, 'ZERO');
  assert.equal(data.product.presentation, 'Bolsa');
  const seven = await service.forecast(request({ horizonDays: '7' }, { sku: 'SKU-1' }));
  assert.equal(seven.data.horizons['7d'], 16.25);
  assert.equal(registryCalls.filter(row => row.kind === 'artifact').length, 2);
  const one = await service.forecast(request({ horizonDays: '1' }, { sku: 'SKU-1' }));
  assert.equal(one.data.status, 'MODEL_NOT_APPROVED');
  assert.equal(one.data.horizons['1d'], null);
  assert.equal(one.data.baselineUnits, null);
  assert.equal(registryCalls.filter(row => row.kind === 'artifact').length, 2, 'one day must not read a registry artifact');
  assert.equal(calls.filter(row => row.kind === 'get_product_forecast' && row.useLiveRidge).length, 3);
  assert.equal((await service.forecast(request({ horizonDays: '28' }, { sku: 'SKU-1' }))).error.code, 'UNSUPPORTED_HORIZON');
});

test('LIVE forecast without an ACTIVE artifact fails closed and active model metadata is safely scoped', async () => {
  const { service, registryCalls } = makeDashboard({ activeModelMissing: true });
  const result = await service.forecast(request({ horizonDays: '7' }, { sku: 'SKU-1' }));
  assert.equal(result.data.status, 'MODEL_UNAVAILABLE');
  assert.equal(result.data.horizons['7d'], null);
  assert.equal(result.data.baselineUnits, 14);
  const active = await service.activeForecastModels(request());
  assert.deepEqual(active.data.models.map(row => row.status), ['MODEL_NOT_APPROVED', 'MODEL_UNAVAILABLE', 'MODEL_UNAVAILABLE']);
  assert.equal(active.data.forecastServing.scenarioId, V3.scenarioId);
  assert.equal(active.data.forecastServing.horizons['1'].reasonCode, 'PROMOTION_POLICY_FAILED');
  assert.equal(active.data.forecastServing.horizons['7'].reasonCode, 'REGISTRY_NOT_FOUND');
  assert.equal(active.data.models[1].registryFound, false);
  assert.equal(active.data.models[1].mlLoadStatus, 'NOT_CHECKED');
  assert.ok(active.data.models.every(row => !('artifactData' in row) && !('artifactHash' in row)));
  assert.ok(registryCalls.every(row => row.businessId === V3.businessId && row.scenarioId === V3.scenarioId));
});

test('active forecast diagnostics distinguish empty registry, missing pointer and missing artifact without writes', async () => {
  const cases = [
    { label: 'registry missing', registry: null, artifact: null, reason: 'REGISTRY_NOT_FOUND' },
    { label: 'pointer missing', registry: { activeArtifactId: null, activeModelVersion: null }, artifact: null, reason: 'ACTIVE_POINTER_MISSING' },
    { label: 'artifact missing', registry: { activeArtifactId: 'a7', activeModelVersion: 1 }, artifact: null, reason: 'ACTIVE_ARTIFACT_NOT_FOUND' },
  ];
  for (const scenario of cases) {
    const { service, models } = makeDashboard({ activeModelMissing: true });
    let writes = 0;
    models.ForecastModelRegistry.findOne = () => diagnosticRead(scenario.registry);
    models.ForecastModelArtifact.findOne = () => diagnosticRead(scenario.artifact);
    for (const model of [models.ForecastModelRegistry, models.ForecastModelArtifact]) {
      model.create = model.updateOne = model.findOneAndUpdate = () => { writes++; throw new Error('diagnostic must remain read-only'); };
    }
    const { data } = await service.activeForecastModels(request({ businessId: 'ATTACKER-QUERY-MUST-BE-IGNORED' }));
    assert.equal(data.models[1].reasonCode, scenario.reason, scenario.label);
    assert.equal(data.models[1].mlLoadStatus, 'NOT_CHECKED');
    assert.equal(writes, 0);
  }
});

test('active forecast diagnostics classify artifact status, feature contract and integrity safely', async () => {
  const cases = [
    { status: 'CANDIDATE', featureVersion: 'RIDGE_CAUSAL27_V1', featureHash: '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5', reason: 'ACTIVE_ARTIFACT_NOT_ACTIVE' },
    { status: 'ACTIVE', featureVersion: 'OTHER', featureHash: '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5', reason: 'FEATURE_CONTRACT_MISMATCH' },
    { status: 'ACTIVE', featureVersion: 'RIDGE_CAUSAL27_V1', featureHash: '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5', badHash: true, reason: 'ARTIFACT_HASH_MISMATCH' },
  ];
  for (const scenario of cases) {
    const { service, models } = makeDashboard({ activeModelMissing: true });
    const bytes = Buffer.from('diagnostic-artifact');
    const artifact = { businessId: V3.businessId, scenarioId: V3.scenarioId, horizonDays: 7, modelFamily: 'RIDGE_REGRESSION',
      recipeId: 'RIDGE-CAUSAL27', modelVersion: 1, status: scenario.status, trainedDataVersion: '0', dataCutoff: '2026-10-15',
      featureVersion: scenario.featureVersion, featureHash: scenario.featureHash, promotionPolicyVersion: 'M6.10A22-PROMOTION-v1',
      artifactBytes: bytes.length, artifactHash: scenario.badHash ? '0'.repeat(64)
        : require('node:crypto').createHash('sha256').update(bytes).digest('hex'), artifactData: bytes };
    models.ForecastModelRegistry.findOne = () => diagnosticRead({ activeArtifactId: 'artifact-7', activeModelVersion: 1 });
    models.ForecastModelArtifact.findOne = () => diagnosticRead(artifact);
    const { data } = await service.activeForecastModels(request());
    assert.equal(data.models[1].reasonCode, scenario.reason);
    assert.equal(data.models[1].artifactFound, true);
    assert.equal(data.models[1].artifactHashValid, scenario.badHash ? false : true);
    assert.equal(JSON.stringify(data).includes('diagnostic-artifact'), false);
    assert.equal(JSON.stringify(data).includes(artifact.artifactHash), false);
  }
});

test('valid ACTIVE forecast diagnostics execute a READ serving check and return only safe metadata', async () => {
  const { service, models } = makeDashboard();
  const { data } = await service.activeForecastModels(request());
  assert.equal(data.models[0].status, 'MODEL_NOT_APPROVED');
  assert.equal(data.models[1].status, 'ACTIVE', JSON.stringify(data.models[1]));
  assert.equal(data.models[1].reasonCode, 'MODEL_READY');
  assert.equal(data.models[1].mlLoadStatus, 'READY');
  assert.equal(data.models[1].mlLoadReasonCode, null);
  assert.equal(data.forecastServing.dataVersion, '1');
  assert.equal(data.forecastServing.observationsClosedThrough, '2026-10-13');
  assert.equal(data.models[1].featureHashMatches, true);
  assert.equal(Object.hasOwn(data.models[1], 'artifactData'), false);
  assert.equal(Object.hasOwn(data.models[1], 'artifactHash'), false);
  assert.equal(JSON.stringify(data).includes('ridge-fixture'), false);
  assert.equal(JSON.stringify(data).includes('secret'), false);
});

test('ACTIVE 7d/14d diagnostics verify persisted Buffer, Uint8Array and BSON Binary bytes', async t => {
  const { Binary } = require('mongoose').mongo;
  const bytes = Buffer.from('ridge-fixture');
  const representations = {
    Buffer: () => Buffer.from(bytes),
    Uint8Array: () => new Uint8Array(bytes),
    'BSON Binary': () => new Binary(Buffer.from(bytes)),
  };
  for (const [name, represent] of Object.entries(representations)) {
    for (const integrity of ['valid', 'wrong hash', 'wrong byte count']) {
      await t.test(`${name}: ${integrity}`, async () => {
        const { service, models } = makeDashboard();
        models.ForecastModelArtifact.findOne = filter => {
          const horizonDays = Number(String(filter._id).split('-').at(-1));
          return diagnosticRead({ ...modelMetadata(horizonDays), artifactData: represent(),
            artifactHash: integrity === 'wrong hash' ? '0'.repeat(64)
              : require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
            artifactBytes: bytes.length + (integrity === 'wrong byte count' ? 1 : 0) });
        };
        const { data } = await service.activeForecastModels(request());
        for (const horizonDays of [7, 14]) {
          const row = data.models.find(model => model.horizonDays === horizonDays);
          assert.equal(row.artifactHashValid, integrity === 'valid');
          assert.equal(row.reasonCode, integrity === 'valid' ? 'MODEL_READY' : 'ARTIFACT_HASH_MISMATCH');
          assert.equal(row.mlLoadStatus, integrity === 'valid' ? 'READY' : 'NOT_CHECKED');
        }
        assert.equal(JSON.stringify(data).includes('ridge-fixture'), false);
      });
    }
  }
});

test('health diagnostic reports dependencies and sanitizes failures and timeout', async () => {
  const partial = await makeDashboard().service.healthDiagnostic(request({ period: 'TODAY' }));
  assert.equal(partial.data.httpStatus, 200);
  assert.equal(partial.data.dependencyStatus.inventory, 'READY');
  assert.equal(partial.data.dependencyStatus.forecast, 'READY');
  assert.equal(partial.data.dependencyStatus.supplier, 'READY');
  assert.equal(partial.data.dependencyStatus.healthAssembly, 'PARTIAL');
  assert.equal(partial.data.healthCompletenessPolicyVersion, 'm6.10a36113-abc-informational-v1');
  assert.deepEqual(partial.data.blockingReasons, ['MARKET_BASKET_UNAVAILABLE']);
  assert.deepEqual(partial.data.customerDiagnostics, [{ code: 'CUSTOMER_PERIOD_COST_COVERAGE_INCOMPLETE',
    affectedCustomerCount: 3, unknownSaleLineCount: 7 }]);
  assert.equal(partial.data.reasonCode, null);
  const failed = await makeDashboard({ fail: 'PRIVATE_MONGO_URI' }).service.healthDiagnostic(request());
  assert.equal(failed.data.httpStatus, 503);
  assert.equal(failed.data.dependencyStatus.healthAssembly, 'FAILED');
  assert.equal(failed.data.reasonCode, 'HEALTH_DEPENDENCY_FAILED');
  assert.doesNotMatch(JSON.stringify(failed.data), /PRIVATE|mongo|uri|stack/i);
  const timeoutService = createV3BusinessIntelligenceDashboard({ diagnosticTimeoutMs: 1,
    forecastRegistryService: { getActiveModelArtifact: async () => null, getActiveModelMetadata: async () => null },
    intelligenceService: { resolveContext: async () => ({ operationalDate: '2026-10-14', scenarioId: V3.scenarioId }),
      execute: () => new Promise(() => {}) } });
  const timeout = await timeoutService.healthDiagnostic(request());
  assert.equal(timeout.data.httpStatus, 504);
  assert.equal(timeout.data.reasonCode, 'HEALTH_DIAGNOSTIC_TIMEOUT');
});

test('LIVE forecast with unavailable Ridge features returns an explicit null prediction', async () => {
  const { service } = makeDashboard({ forecastFeatureUnavailable: true });
  const result = await service.forecast(request({ horizonDays: '7' }, { sku: 'SKU-1' }));
  assert.equal(result.data.status, 'FEATURE_UNAVAILABLE');
  assert.equal(result.data.horizons['7d'], null);
  assert.equal(result.data.predictionUnits, null);
  assert.equal(result.data.modelVersion, 1);
});

test('historical forecast remains MA28 and does not read the active Ridge registry', async () => {
  const { service, registryCalls } = makeDashboard();
  const result = await service.forecast(request({ horizonDays: '14', asOf: V3.historicalCutoff }, { sku: 'SKU-1' }));
  assert.equal(result.data.mode, 'HISTORICAL');
  assert.equal(result.data.method, 'MOVING_AVERAGE_28');
  assert.equal(result.data.horizons['14d'], 32.5);
  assert.equal(registryCalls.length, 0);
});

test('inventory detail exposes approved values without inventing preventive semantics', async () => {
  const { service, calls, registryCalls } = makeDashboard();
  const { data } = await service.productInventory(request({}, { sku: 'SKU-1' }));
  assert.equal(data.stock.onHand, 1);
  assert.equal(data.demand.expectedUnitsNext7d, 14);
  assert.equal(data.demand.expectedUnitsNext14d, 28);
  assert.equal(data.demand.expectedUnitsNext1d, null);
  assert.equal(data.recommendation.reorderNow, true);
  assert.equal(data.recommendation.recommendedQty, 4);
  assert.equal(data.recommendation.preventiveRecommendation, null);
  assert.equal(data.risk.level, 'HIGH');
  assert.equal(data.risk.lowStock, false);
  assert.equal(data.availability, 'READY');
  assert.equal(data.freshness.mode, 'LIVE');
  const operation = calls.find(row => row.kind === 'get_inventory_intelligence');
  assert.equal(operation.args.mode, 'detail');
  assert.deepEqual(operation.trustedInventoryRidgeModels.map(model => model.metadata.horizonDays).sort((a, b) => a - b), [7, 14]);
  assert.equal(registryCalls.filter(row => row.kind === 'artifact').length, 2);
});

test('LIVE inventory detail without ACTIVE Ridge models remains safely partial and never substitutes MA28', async () => {
  const { service, calls, registryCalls } = makeDashboard({ activeModelMissing: true });
  const { data } = await service.productInventory(request({}, { sku: 'SKU-1' }));
  assert.equal(data.stock.onHand, 1);
  assert.equal(data.stock.incoming, 2);
  assert.equal(data.availability, 'PARTIAL');
  assert.equal(data.demand.expectedDaily, null);
  assert.equal(data.demand.expectedUnitsNext1d, null);
  assert.equal(data.demand.expectedUnitsNext7d, null);
  assert.equal(data.demand.expectedUnitsNext14d, null);
  assert.equal(data.coverage.daysCover, null);
  assert.equal(data.inventoryPolicy.safetyStock, null);
  assert.equal(data.recommendation.recommendedQty, null);
  assert.equal(data.recommendation.reorderNow, null);
  assert.equal(data.risk.level, null);
  const operation = calls.find(row => row.kind === 'get_inventory_intelligence');
  assert.deepEqual(operation.trustedInventoryRidgeModels, []);
  assert.equal(operation.args.horizonDays, undefined);
  assert.equal(registryCalls.filter(row => row.kind === 'artifact').length, 2);
});

test('unknown product is rejected before calling ML and maps to a safe 404', async () => {
  const { service, calls } = makeDashboard({ productPresent: false });
  const result = await service.forecast(request({ horizonDays: '7' }, { sku: 'UNKNOWN-SKU' }));
  assert.equal(result.error.code, 'PRODUCT_NOT_FOUND');
  assert.equal(result.error.httpStatus, 404);
  assert.equal(calls.filter(row => row.kind === 'get_product_forecast').length, 0);
});

test('inventory ranking returns compact typed fields in engine order with tenant-scoped presentation', async () => {
  const { service } = makeDashboard();
  const { data } = await service.inventory(request({ limit: '5' }));
  assert.deepEqual(data.items[0], { sku: 'SKU-1', productName: 'Producto uno 500 g', presentation: 'Bolsa', stock: 1,
    coverageDays: 1.5, risk: 'HIGH', riskReasonCodes: ['LOW_COVERAGE'], recommendedQty: 4, reorderNow: true,
    availabilityStatus: null, coverageStatus: 'AVAILABLE', coverageReasonCode: null, riskStatus: null,
    riskReasonCode: null, recommendationStatus: null, recommendationReasonCode: null });
  assert.equal(data.total, 1);
});

test('LIVE inventory and health receive only tenant-scoped ACTIVE Ridge 7/14 artifacts', async () => {
  const { service, calls, registryCalls } = makeDashboard();
  await service.inventory(request());
  await service.health(request({ period: 'LAST_30_DAYS' }));
  const operations = calls.filter(row => ['get_inventory_intelligence', 'get_business_health'].includes(row.kind));
  assert.equal(operations.length, 2);
  for (const operation of operations) {
    const models = operation.trustedInventoryRidgeModels;
    assert.equal(models.length, 2);
    assert.deepEqual(models.map(model => model.metadata.horizonDays).sort((a, b) => a - b), [7, 14]);
    assert.ok(models.every(model => model.metadata.businessId === V3.businessId
      && model.metadata.scenarioId === V3.scenarioId && model.metadata.status === 'ACTIVE'));
  }
  assert.equal(registryCalls.filter(row => row.kind === 'artifact').length, operations.length * 2);
});

test('missing ACTIVE Ridge artifacts are passed as absent models for partial LIVE inventory/health', async () => {
  const { service, calls } = makeDashboard({ activeModelMissing: true });
  await service.inventory(request());
  const operation = calls.find(row => row.kind === 'get_inventory_intelligence');
  assert.deepEqual(operation.trustedInventoryRidgeModels, []);
});

test('snapshot and tenant failures are mapped to safe messages without internal details', () => {
  const error = new Error('mongo uri and stack must not leak'); error.functionalCode = 'SNAPSHOT_BOOTSTRAP_REQUIRED';
  const mapped = safeError(error);
  assert.equal(mapped.httpStatus, 503);
  assert.doesNotMatch(mapped.message, /mongo|stack|uri/i);
  for (const code of ['LIVE_SNAPSHOT_REQUIRED', 'LIVE_SNAPSHOT_INVALID']) {
    const snapshotError = safeError(Object.assign(new Error('private snapshot details'), { functionalCode: code }));
    assert.equal(snapshotError.code, code);
    assert.equal(snapshotError.httpStatus, 503);
    assert.doesNotMatch(snapshotError.message, /private|snapshot details/i);
  }
});

test('dashboard routes apply authentication before business access and analytics handlers', async () => {
  const router = createBusinessIntelligenceDashboardRoutes({
    service: Object.fromEntries(['revision', 'summary', 'sales', 'customers', 'customer', 'suppliers', 'supplier', 'associations', 'productRelated',
      'health', 'healthDiagnostic', 'inventory', 'forecast', 'activeForecastModels', 'productInventory', 'productOperationsList', 'productOperationDetail'].map(name => [name, async () => ({ data: {} })]))
  });
  assert.equal(router.stack[0].handle, authenticate);
  let status, body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await authenticate({ header: () => undefined }, res, () => assert.fail('unauthenticated request continued'));
  assert.equal(status, 401);
  assert.equal(body.success, false);
  const headers = {};
  res.set = (key, value) => { headers[key] = value; return res; };
  await router.stack.find(layer => layer.route?.path === '/revision').route.stack[0].handle(request(), res);
  assert.equal(headers['Cache-Control'], 'no-store');
  await router.stack.find(layer => layer.route?.path === '/forecast/models/active').route.stack[0].handle(request(), res);
  assert.equal(headers['Cache-Control'], 'no-store');
  await router.stack.find(layer => layer.route?.path === '/health/diagnostics').route.stack[0].handle(request(), res);
  assert.equal(headers['Cache-Control'], 'no-store');
  await router.stack.find(layer => layer.route?.path === '/products/:sku/operations').route.stack[0].handle(request(), res);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.ok(router.stack.some(layer => layer.route?.path === '/products/:sku/operations/:operationId'));
});

test('sales API keeps the requested period and uses V3 business rankings without inventing margin', async () => {
  const { service, calls } = makeDashboard();
  const result = await service.sales(request({ period: 'LAST_7_DAYS', compare: 'true' }));
  assert.equal(result.data.period.startDate, '2026-10-08');
  assert.equal(result.data.period.endDate, '2026-10-14');
  assert.equal(result.data.summary.revenue.value, 0);
  assert.equal(result.data.summary.grossMargin.value, null);
  assert.equal(result.data.grossMarginAvailability, 'UNAVAILABLE');
  assert.equal(result.data.comparisonPeriod.endDate, '2026-10-13');
  assert.equal(result.data.rankings.topProducts[0].sku, 'SKU-1');
  assert.equal(result.data.rankings.topCategories[0].category, 'FOODS_1');
  assert.ok(calls.some(row => row.kind === 'get_business_analytics' && row.args.mode === 'rank'));
});

test('sales time series delegates each point to the engine and preserves its status', async () => {
  const { service } = makeDashboard();
  const result = await service.sales(request({ period: 'LAST_7_DAYS', includeSeries: 'true' }));
  assert.equal(result.data.series.length, 7);
  assert.deepEqual(result.data.series[0], { date: '2026-10-08', revenue: { value: 0, currency: 'PEN' }, units: 0, tickets: 0, status: 'READY' });
  const last30 = await service.sales(request({ period: 'LAST_30_DAYS', includeSeries: 'true' }));
  assert.equal(last30.data.period.startDate, '2026-09-15');
  assert.equal(last30.data.series.length, 30);
});

test('customer API derives approved RFM segments and detail without exposing Mongo identifiers', async () => {
  const { service } = makeDashboard();
  const list = await service.customers(request({ sortBy: 'spend' }));
  assert.deepEqual(list.data.summary.segments, { AT_RISK: 4, INACTIVE: 6, NEW: 5, LOYAL: 10, TOP_HIGH_VALUE: 8, POTENTIAL: 7 });
  assert.equal(list.data.summary.totalRegistered, 40);
  assert.equal(list.data.summary.consumerFinalIncludedInIndividualRfm, false);
  const detail = await service.customer(request({}, { customerRef: 'CLI-001' }));
  assert.equal(detail.data.item.customerId, 'CLI-001');
  assert.equal(detail.data.item.monetary.value, 67.89);
  assert.equal(detail.data.item.spend.value, 123.45);
  assert.equal(detail.data.item.frequency, 3);
  assert.equal(Object.hasOwn(detail.data.item, 'id'), false);
});

test('supplier API reports received/pending semantics and detail cost history availability', async () => {
  const { service } = makeDashboard();
  const list = await service.suppliers(request({ period: 'LAST_30_DAYS' }));
  assert.ok(list.data, JSON.stringify(list.error));
  assert.equal(list.data.summary.pendingOrders, 29);
  assert.equal(list.data.summary.receivedOrders, 2126);
  assert.equal(list.data.items[0].pending, 4);
  assert.equal(list.data.summary.averageLeadTime.status, 'NOT_EXPOSED_BY_ENGINE');
  assert.equal(list.data.items[0].leadTimeAvailability, 'AVAILABLE');
  const insufficient = await makeDashboard({ supplierNoHistory: true }).service.suppliers(request());
  assert.equal(insufficient.data.items[0].leadTimeAvailability, 'INSUFFICIENT_HISTORY');
  const detail = await service.supplier(request({}, { supplierRef: 'SUP-05' }));
  assert.equal(detail.data.item.supplierId, 'SUP-05');
  assert.equal(detail.data.item.spend.value, 678.9);
  assert.equal(detail.data.item.costTrends[0].latestPurchaseCostCents, 1700);
  assert.equal(detail.data.item.historyAvailability, 'AVAILABLE');
});

test('Market Basket API labels frozen cutoff and projects approved rule metrics', async () => {
  const { service, calls } = makeDashboard();
  const summary = await service.associations(request({ period: 'TODAY' }));
  assert.ok(summary.data, JSON.stringify(summary.error));
  assert.equal(summary.data.mode, 'FROZEN');
  assert.equal(summary.data.cutoff, '2026-10-12');
  assert.equal(summary.data.asOf, '2026-10-12');
  assert.deepEqual(summary.data.items[0].antecedent, ['SKU-1']);
  assert.deepEqual(summary.data.items[0].consequent, ['SKU-2']);
  assert.equal(summary.data.items[0].support, .003);
  assert.equal(summary.data.items[0].confidence, .4);
  assert.equal(summary.data.items[0].lift, 1.8);
  assert.equal(summary.data.items[0].ticketCount, 32);
  assert.equal(summary.data.summary.validTickets, 12647);
  assert.equal(summary.data.summary.crossSellCount, 33);
  const related = await service.productRelated(request({ asOf: 'not-a-date', period: 'TODAY' }, { sku: 'SKU-1' }));
  assert.equal(related.data.asOf, '2026-10-12');
  assert.equal(related.data.mode, 'FROZEN');
  assert.equal(related.data.items[0].relatedProduct.sku, 'SKU-2');
  assert.equal(related.data.items[0].ticketCount, 32);
  const crossSellCalls = calls.filter(call => call.kind === 'get_cross_sell_recommendations');
  assert.equal(crossSellCalls.length, 3);
  assert.ok(crossSellCalls.every(call => call.args.asOfDate === '2026-10-12'
    && call.args.startDate === undefined && call.args.endDate === undefined));
});

test('Market Basket returns an empty related list for a known SKU without rules and safely rejects an unknown SKU', async () => {
  const empty = await makeDashboard({ crossSellItems: [] }).service.productRelated(request({}, { sku: 'SKU-1' }));
  assert.ok(empty.data, JSON.stringify(empty.error));
  assert.equal(empty.data.mode, 'FROZEN');
  assert.equal(empty.data.cutoff, '2026-10-12');
  assert.equal(empty.data.available, true);
  assert.deepEqual(empty.data.items, []);
  assert.equal(empty.data.total, 0);

  const unknown = await makeDashboard({ productPresent: false }).service.productRelated(request({}, { sku: 'UNKNOWN-SKU' }));
  assert.equal(unknown.error.code, 'PRODUCT_NOT_FOUND');
  assert.equal(unknown.error.httpStatus, 404);
});

test('health API returns domain freshness and insights without a composite score', async () => {
  const { service } = makeDashboard();
  const result = await service.health(request({ period: 'LAST_30_DAYS' }));
  assert.ok(result.data, JSON.stringify(result.error));
  assert.equal(result.data.status, 'PARTIAL');
  assert.equal(result.data.domains.marketBasket.freshness.mode, 'FROZEN');
  assert.equal(result.data.domains.inventory.metrics.critical, 2);
  assert.equal(Object.hasOwn(result.data, 'healthScore'), false);
  assert.equal(Object.hasOwn(result.data, 'compositeScore'), false);
});

test('inventory extends ABC/XYZ distribution and returns engine-filtered flag rows', async () => {
  const { service, calls } = makeDashboard();
  const summary = await service.inventory(request());
  assert.deepEqual(summary.data.summary.abcCounts, { A: 40, B: 24, C: 16 });
  assert.deepEqual(summary.data.summary.xyzCounts, { X: 55, Y: 22, Z: 3 });
  const flagged = await service.inventory(request({ flag: 'overstock', limit: '5' }));
  assert.equal(flagged.data.flag, 'overstock');
  assert.ok(calls.some(row => row.kind === 'get_inventory_intelligence' && row.args.flag === 'overstock'));
  assert.equal((await service.inventory(request({ flag: 'invented' }))).error.code, 'INVALID_REQUEST');
});

test('extended endpoints reject invalid periods and keep the series bounded', async () => {
  const { service } = makeDashboard();
  assert.equal((await service.sales(request({ period: 'LAST_YEAR', includeSeries: 'true' }))).error.code, 'INVALID_PERIOD');
  assert.equal((await service.sales(request({ startDate: '2025-10-13', endDate: '2026-10-14', includeSeries: 'true' }))).error.code, 'INVALID_PERIOD');
  assert.equal((await service.health(request({ limit: '6' }))).error.code, 'INVALID_REQUEST');
});
