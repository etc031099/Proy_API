'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3, renderV3, handleV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');
const { actionDecision } = require('../src/automations/actionDecision');
const { actionIntent, parseAction, resolveAction } = require('../src/automations/actionInput');

const binding = { ...V3, operationalDate: '2026-10-14', asOfDate: V3.referenceDate };
const route = (message, state = {}) => routeV3(message, state, binding);
const skill = plan => plan?.tasks?.[0];

test('H5 academic forecast questions remain evaluation READ without product or action decision', () => {
  for (const message of ['¿Qué modelo de Machine Learning se evaluó para predecir demanda?', '¿Por qué usan MA28 si evaluaron HGB?']) {
    assert.equal(actionDecision(message), null);
    assert.equal(skill(route(message))?.skillId, 'get_product_forecast');
    assert.equal(skill(route(message))?.args.mode, 'evaluation');
    assert.equal(skill(route(message))?.args.productRef, undefined);
  }
});

test('H5 high-value customers retain customer domain for segmentation follow-up', () => {
  const first = route('¿Cuáles son mis clientes de alto valor?');
  assert.equal(skill(first)?.skillId, 'get_customer_intelligence');
  const followup = route('¿Cómo los segmentaste?', { lastFamily: 'get_customer_intelligence',
    selectedProduct: { key: 'PAN-FRE-001' }, ranking: { type: 'customer', items: [] } });
  assert.equal(skill(followup)?.skillId, 'get_customer_intelligence');
  assert.equal(skill(followup)?.args.mode, 'clustering');
  assert.equal(skill(followup)?.args.customerRef, undefined);
});

test('H5 pending suppliers and lead-time follow-up do not inherit a stale product', () => {
  const first = route('¿Qué proveedores tienen pedidos pendientes?', { selectedProduct: { key: 'PAN-FRE-001' } });
  assert.equal(skill(first)?.skillId, 'get_supplier_intelligence');
  assert.equal(skill(first)?.pendingOnly, true);
  assert.equal(skill(first)?.args.productRef, undefined);
  const next = route('¿Y cuál tiene mayor tiempo de entrega?', { lastFamily: 'get_supplier_intelligence',
    selectedProduct: { key: 'PAN-FRE-001' }, ranking: { type: 'supplier', items: [] } });
  assert.equal(skill(next)?.skillId, 'get_supplier_intelligence');
  assert.equal(skill(next)?.args.metric, 'lead_time');
  assert.equal(skill(next)?.args.sortDirection, 'desc');
  assert.equal(skill(next)?.args.productRef, undefined);
});

test('H5 global sales plus reorder multi-intent stays entity-free', () => {
  const plan = route('Dime mis ventas de 7 días y qué productos debería reponer.');
  assert.deepEqual(plan.tasks.map(t => t.skillId), ['get_business_analytics', 'get_inventory_intelligence']);
  assert.equal(plan.tasks[0].args.productRef, undefined);
  assert.equal(plan.tasks[1].args.mode, 'rank');
  assert.equal(plan.tasks[1].args.productRef, undefined);
});

test('H5 exact SKU seeds and survives inventory, forecast and coverage follow-ups', () => {
  const first = route('Háblame de PAN-FRE-001.');
  assert.equal(first.lookup, 'PAN-FRE-001');
  const state = { selectedProduct: { key: 'PAN-FRE-001' }, lastFamily: 'get_inventory_intelligence' };
  assert.equal(skill(route('¿Cuál es su stock?', state))?.args.productRef, 'PAN-FRE-001');
  state.lastFamily = 'get_product_forecast';
  const forecast = skill(route('¿Y su pronóstico a 14 días?', state));
  assert.equal(forecast?.args.productRef, 'PAN-FRE-001');
  assert.equal(forecast?.args.horizonDays, 14);
  assert.equal(skill(route('¿Cuántos días de cobertura tiene?', state))?.args.productRef, 'PAN-FRE-001');
});

test('H5 purchase proposal parses SKU and quantity; cancellation is not confirmation', () => {
  const message = 'Prepara una compra de 3 unidades de PAN-FRE-001.';
  assert.equal(actionIntent(message), 'create_purchase');
  const parsed = parseAction(message, 'create_purchase');
  assert.deepEqual(parsed.items, [{ quantity: 3, ref: 'PAN-FRE-001' }]);
  assert.equal(route(message), null);
  assert.equal(actionDecision('Mejor no, cancela.'), 'cancel');
});

test('H5 purchase resolution creates revalidated preview args without executing a write', async () => {
  const product = { _id: 'a'.repeat(24), sku: 'PAN-FRE-001', name: 'Pan francés',
    isActive: true, stock: 21, currency: 'PEN', supplierPrices: [{ supplierId: 'b'.repeat(24), purchasePrice: 1 }] };
  const supplier = { _id: 'b'.repeat(24), name: 'Proveedor', isActive: true };
  const calls = [];
  const resolved = await resolveAction(parseAction('Prepara una compra de 3 unidades de PAN-FRE-001.', 'create_purchase'),
    { businessId: 'c'.repeat(24) }, async (_model, _context, ref) => {
      calls.push(ref);
      return { confidence: 'EXACT', value: product };
    }, async () => [supplier]);
  assert.deepEqual(calls, ['PAN-FRE-001']);
  assert.deepEqual(resolved.args.products, [{ productId: product._id, quantity: 3 }]);
  assert.equal(resolved.args.vendorId, supplier._id);
  assert.equal(resolved.args.currency, 'PEN');
});

test('H5 supplier pending list uses only supplied pending counts and preserves supplier context', async () => {
  const state = { selectedProductReference: { id: 'a'.repeat(24), sku: 'PAN-FRE-001', name: 'Pan francés' } };
  const context = { businessId: 'c'.repeat(24), userId: 'd'.repeat(24), conversationId: 'h5-test' };
  const productEntity = { type: 'product', id: 'a'.repeat(24), key: 'PAN-FRE-001', label: 'Pan francés' };
  const suppliers = [
    { supplierCode: 'SUP-01', displayName: 'Proveedor uno', purchaseOrderCount: 12, pendingOrderCount: 2, leadTime: { averageDays: 4 } },
    { supplierCode: 'SUP-02', displayName: 'Proveedor dos', purchaseOrderCount: 11, pendingOrderCount: 0, leadTime: { averageDays: 8 } },
    { supplierCode: 'SUP-03', displayName: 'Proveedor tres', purchaseOrderCount: 10, pendingOrderCount: 1, leadTime: { averageDays: 6 } }
  ];
  const calls = [];
  const service = { resolveContext: async () => binding, resolveEntity: async (type, ref) => ({ entity: type === 'product' ? productEntity
    : { type, id: String(Number(ref.slice(-2))).padStart(24, '0'), key: ref, label: ref } }) };
  const run = async (_agent, skillId, args) => {
    calls.push({ skillId, args });
    return Object.freeze({ data: Object.freeze({ items: Object.freeze(suppliers.map(row => Object.freeze({ ...row }))), total: suppliers.length }),
      metadata: Object.freeze({ asOf: '2026-10-14', dataMode: 'LIVE', selected: Object.freeze({}) }) });
  };
  const first = await handleV3({ message: '¿Qué proveedores tienen pedidos pendientes?', state, context, service, run,
    commit: patch => Object.assign(state, patch) });
  assert.match(first.answer, /Proveedor uno/);
  assert.match(first.answer, /Proveedor tres/);
  assert.doesNotMatch(first.answer, /Proveedor dos/);
  assert.match(first.answer, /2 proveedores con pedidos pendientes/);
  assert.equal(state.v3Context.lastFamily, 'get_supplier_intelligence');
  assert.equal(state.v3Context.selectedProduct, null);
  const second = await handleV3({ message: '¿Y cuál tiene mayor tiempo de entrega?', state, context, service, run,
    commit: patch => Object.assign(state, patch) });
  assert.equal(calls.at(-1).skillId, 'get_supplier_intelligence');
  assert.equal(calls.at(-1).args.metric, 'lead_time');
  assert.equal(calls.at(-1).args.productRef, undefined);
  assert.match(second.answer, /Proveedor/);
});

test('H5 health observations are humanized without altering their codes', () => {
  const answer = renderV3('get_business_health', { metadata: { asOf: '2026-10-14', dataMode: 'LIVE' },
    data: { businessHealth: { sales: { kpis: { revenueCents: 0 } }, customers: { atRiskCount: 0 },
      inventory: { critical: 5 }, suppliers: { summary: { suppliers: 10 } }, marketBasket: { stableCrossSellRuleCount: 33 } },
    alerts: [{ code: 'CRITICAL_STOCK_COUNT', summary: 'The inventory snapshot contains critical SKU risk cases.' }] } }, {});
  assert.doesNotMatch(answer, /The inventory snapshot contains/);
  assert.match(answer, /inventario|productos/i);
});
