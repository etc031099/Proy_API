'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3, handleV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');

const binding = { ...V3, operationalDate: '2026-10-14', asOfDate: V3.referenceDate };
const globalQueries = [
  ['Muéstrame productos con stock bajo y su stock mínimo', 'low_stock'],
  ['¿Qué productos tienen poco stock?', 'low_stock'],
  ['¿Qué productos están por debajo del mínimo?', 'low_stock'],
  ['¿Qué productos están por acabarse?', 'low_stock'],
  ['Dime el stock actual y mínimo de los productos con poco stock', 'low_stock'],
  ['¿Cuáles debería reponer?', 'should_reorder']
];

test('H.6-FIX3 global inventory condition phrases route to the existing condition without product lookup', () => {
  for (const [message, condition] of globalQueries) {
    const plan = routeV3(message, {}, binding);
    assert.equal(plan?.responseMode, 'inventory-condition-list', message);
    assert.equal(plan?.tasks?.[0]?.skillId, 'get_inventory_intelligence', message);
    assert.equal(plan.tasks[0].args.mode, 'rank', message);
    assert.equal(plan.tasks[0].args.flag, condition, message);
    assert.equal(plan.lookup, undefined, message);
  }
});

test('H.6-FIX3 keeps a named product stock question on the individual product route', () => {
  const plan = routeV3('¿Cuánto stock tiene el pan francés?', {}, binding);
  assert.equal(plan.responseMode, 'minimal');
  assert.equal(plan.lookup, 'pan frances');
});

test('H.6-FIX3 nearest-above-minimum query uses the approved ranking and excludes products at/below minimum', () => {
  const plan = routeV3('¿Qué producto está más cerca de su stock mínimo sin haberlo alcanzado?', {}, binding);
  assert.equal(plan?.responseMode, 'inventory-nearest-minimum');
  assert.equal(plan?.tasks?.[0]?.skillId, 'get_inventory_intelligence');
  assert.equal(plan.tasks[0].args.mode, 'rank');
  assert.equal(plan.tasks[0].args.metric, 'low_stock');
  assert.equal(plan.tasks[0].args.flag, undefined);
});

test('H.6-FIX3 low-stock list shows only name, current stock and configured minimum without entity resolution', async () => {
  const calls = [];
  const state = {};
  const response = await handleV3({
    message: globalQueries[0][0], state, context: { businessId: V3.businessId, userId: 'fix3', conversationId: 'list' },
    service: { resolveContext: async () => binding, resolveEntity: async (...args) => { calls.push(['resolve', ...args]); return {}; } },
    run: async (...args) => {
      calls.push(['run', ...args]);
      return { status: 'READY', data: { total: 1, items: [{ sku: 'PAN-FRE-001', productName: 'Pan francés',
        stock: { onHand: 2 }, inventoryPolicy: { configuredMinimumStock: 3 }, risk: { level: 'HIGH' } }] },
        metadata: { asOf: '2026-10-14', dataMode: 'LIVE', selected: {} } };
    },
    commit: patch => Object.assign(state, patch)
  });
  assert.equal(calls.filter(call => call[0] === 'resolve').length, 0);
  assert.equal(calls.filter(call => call[0] === 'run').length, 1);
  assert.equal(calls[0][1], 'operations');
  assert.equal(calls[0][2], 'get_inventory_intelligence');
  assert.match(response.answer, /Pan francés/);
  assert.match(response.answer, /Stock actual: 2/);
  assert.match(response.answer, /Stock mínimo: 3/);
  assert.doesNotMatch(response.answer, /riesgo|cobertura|pronóstico|forecast|proveedor/i);
  assert.deepEqual(response.v3Views[0].items[0].metrics.map(metric => metric.label), ['Stock actual', 'Stock mínimo']);
});

