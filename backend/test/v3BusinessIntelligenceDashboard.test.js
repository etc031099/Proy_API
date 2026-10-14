'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createV3BusinessIntelligenceDashboard, safeError } = require('../src/services/v3BusinessIntelligenceDashboard');
const { createBusinessIntelligenceDashboardRoutes } = require('../src/routes/businessIntelligenceDashboard');
const { V3 } = require('../src/services/v3IntelligenceService');
const { authenticate } = require('../src/middleware/auth');

const user = { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, isActive: true, role: 'user' };
const request = (query = {}, params = {}) => ({ user, businessId: user.businessId, query, params });
const makeDashboard = ({ fail, partial = false, productPresent = true } = {}) => {
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
          data: { kpis: { revenueCents: 0, unitsSold: 0, ticketCount: 0, averageTicket: 0, grossMarginCents: null, grossMarginPct: null } } };
        case 'get_inventory_intelligence': return invocation.args.mode === 'summary' ? { status: 'READY', metadata, data: { summary: {
          products: 80, critical: 2, high: 3, medium: 10, low: 65, shouldReorder: 5, lowStock: 8, overstock: 4, incomingUnits: 10 } } }
          : { status: 'READY', metadata, data: { total: 1, items: [{ sku: 'SKU-1', productName: 'Producto uno',
            stock: { onHand: 1, incoming: 2, inventoryPosition: 3 }, coverage: { daysCover: 1.5, status: 'AVAILABLE' },
            demand: { expectedDaily: 2, expectedUnitsNext1d: 2, expectedUnitsNext7d: 14, expectedUnitsNext14d: 28 },
            inventoryPolicy: { safetyStock: 3, reorderPoint: 5 }, recommendation: { shouldReorder: true, recommendedQty: 4 },
            risk: { level: 'HIGH', reasonCodes: ['LOW_COVERAGE'] }, classification: { abc: 'A', xyz: 'X' } }] } };
        case 'get_supplier_intelligence': return { status: 'READY', metadata, data: { total: 10,
          items: [{ pendingOrderCount: 2 }, { pendingOrderCount: 3 }], summary: { pendingOrders: 29 } } };
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
    service: { summary: async () => ({ data: {} }), inventory: async () => ({ data: {} }), forecast: async () => ({ data: {} }), productInventory: async () => ({ data: {} }) }
  });
  assert.equal(router.stack[0].handle, authenticate);
  let status, body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await authenticate({ header: () => undefined }, res, () => assert.fail('unauthenticated request continued'));
  assert.equal(status, 401);
  assert.equal(body.success, false);
});
