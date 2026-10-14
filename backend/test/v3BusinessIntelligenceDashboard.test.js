'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createV3BusinessIntelligenceDashboard, safeError } = require('../src/services/v3BusinessIntelligenceDashboard');
const { createBusinessIntelligenceDashboardRoutes } = require('../src/routes/businessIntelligenceDashboard');
const { V3 } = require('../src/services/v3IntelligenceService');
const { authenticate } = require('../src/middleware/auth');

const user = { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, isActive: true, role: 'user' };
const request = (query = {}, params = {}) => ({ user, businessId: user.businessId, query, params });
const makeDashboard = ({ fail, partial = false, productPresent = true, supplierNoHistory = false,
  crossSellItems = [{ antecedentSkus: ['SKU-1'], consequentSkus: ['SKU-2'], recommendedSku: 'SKU-2',
    recommendedProduct: 'Producto dos', ticketCount: 32,
    support: .003, confidence: .4, lift: 1.8, stability: { status: 'STABLE' } }] } = {}) => {
  const calls = [];
  const intelligenceService = {
    async resolveContext(context) { calls.push({ kind: 'context', businessId: context.businessId });
      return { businessId: V3.businessId, operationalDate: '2026-10-14' }; },
    async execute(invocation) {
      calls.push({ kind: invocation.skill.id, context: invocation.context, args: invocation.args });
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
        case 'get_inventory_intelligence': return invocation.args.mode === 'summary' ? { status: 'READY', metadata, data: { summary: {
          products: 80, critical: 2, high: 3, medium: 10, low: 65, shouldReorder: 5, lowStock: 8, overstock: 4,
          slowMoving: 6, deadStock: 0, incomingUnits: 10 }, abcCounts: { A: 40, B: 24, C: 16 },
          xyzCounts: { X: 55, Y: 22, Z: 3 }, abcXyzCounts: { AX: 20 } } }
          : { status: 'READY', metadata, data: { total: 1, items: [{ sku: 'SKU-1', productName: 'Producto uno',
            stock: { onHand: 1, incoming: 2, inventoryPosition: 3 }, coverage: { daysCover: 1.5, status: 'AVAILABLE' },
            demand: { expectedDaily: 2, expectedUnitsNext1d: 2, expectedUnitsNext7d: 14, expectedUnitsNext14d: 28 },
            inventoryPolicy: { safetyStock: 3, reorderPoint: 5 }, recommendation: { shouldReorder: true, recommendedQty: 4 },
            risk: { level: 'HIGH', reasonCodes: ['LOW_COVERAGE'] }, classification: { abc: 'A', xyz: 'X' } }] } };
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
          businessHealth: { sales: { kpis: {}, freshness: { status: 'LIVE' }, alerts: [] }, inventory: { critical: 2, freshness: { status: 'LIVE' }, alerts: [] },
            customers: { atRiskCount: 4, freshness: { status: 'LIVE' }, alerts: [] }, suppliers: { pending: 4, freshness: { status: 'LIVE' }, alerts: [] },
            forecast: { knownCount: 80, freshness: { status: 'LIVE' }, alerts: [] }, marketBasket: { available: true,
              freshness: { mode: 'FROZEN', cutoff: '2026-10-12' }, alerts: [] } }, alerts: [] } };
        case 'get_product_forecast': return { status: 'READY', metadata, data: { items: [{ sku: 'SKU-1', productName: 'Producto uno',
          status: 'READY', observationsThrough: '2026-10-13', expectedUnitsNext1d: 2.32, expectedUnitsNext7d: 16.25,
          expectedUnitsNext14d: 32.5, observedSeries: [{ date: '2026-10-13', units: 0, status: 'ZERO' }], forecastStartDate: '2026-10-14' }] } };
        default: throw new Error('unexpected skill');
      }
    }
  };
  const product = { name: 'Producto uno 500 g', presentation: 'Bolsa', brand: 'Demo', sizeValue: 500, sizeUnit: 'g' };
  const models = { Product: {
    findOne: () => ({ select() { return this; }, lean() { return this; }, maxTimeMS: async () => productPresent ? product : null }),
    find: filter => ({ select() { return this; }, lean() { return this; }, maxTimeMS: async () => {
      assert.equal(filter.businessId, V3.businessId);
      return [{ sku: 'SKU-1', name: 'Producto uno 500 g', presentation: 'Bolsa' }];
    } })
  } };
  return { service: createV3BusinessIntelligenceDashboard({ models, intelligenceService }), calls };
};

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

test('forecast contract returns 1/7/14 totals and certified series; 28d is rejected', async () => {
  const { service } = makeDashboard();
  const { data } = await service.forecast(request({ horizonDays: '14' }, { sku: 'SKU-1' }));
  assert.equal(data.horizons['1d'], 2.32);
  assert.equal(data.forecastPeriod.units, 32.5);
  assert.equal(data.forecastPeriod.selectedHorizonDays, 14);
  assert.equal(data.observedSeries[0].status, 'ZERO');
  assert.equal(data.product.presentation, 'Bolsa');
  assert.equal((await service.forecast(request({ horizonDays: '28' }, { sku: 'SKU-1' }))).error.code, 'UNSUPPORTED_HORIZON');
});

test('inventory detail exposes approved values without inventing preventive semantics', async () => {
  const { service } = makeDashboard();
  const { data } = await service.productInventory(request({}, { sku: 'SKU-1' }));
  assert.equal(data.stock.onHand, 1);
  assert.equal(data.demand.expectedUnitsNext7d, 14);
  assert.equal(data.recommendation.reorderNow, true);
  assert.equal(data.recommendation.recommendedQty, 4);
  assert.equal(data.recommendation.preventiveRecommendation, null);
  assert.equal(data.risk.level, 'HIGH');
  assert.equal(data.availability, 'READY');
  assert.equal(data.freshness.mode, 'LIVE');
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
    coverageDays: 1.5, risk: 'HIGH', riskReasonCodes: ['LOW_COVERAGE'], recommendedQty: 4, reorderNow: true });
  assert.equal(data.total, 1);
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
    service: Object.fromEntries(['summary', 'sales', 'customers', 'customer', 'suppliers', 'supplier', 'associations', 'productRelated',
      'health', 'inventory', 'forecast', 'productInventory'].map(name => [name, async () => ({ data: {} })]))
  });
  assert.equal(router.stack[0].handle, authenticate);
  let status, body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await authenticate({ header: () => undefined }, res, () => assert.fail('unauthenticated request continued'));
  assert.equal(status, 401);
  assert.equal(body.success, false);
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
