'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3, handleV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');
const { validateSkillArgs } = require('../src/agents/contracts');
const { getSkillDefinition } = require('../src/agents/skills');

const binding = { ...V3, operationalDate: '2026-10-14', asOfDate: V3.referenceDate };
const globalQueries = [
  ['Muéstrame productos con stock bajo y su stock mínimo', 'low_stock'],
  ['¿Qué productos tienen poco stock?', 'low_stock'],
  ['¿Qué se está acabando?', 'low_stock'],
  ['stock bajo', 'low_stock'],
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
    assert.deepEqual(validateSkillArgs(getSkillDefinition('get_inventory_intelligence').inputSchema, plan.tasks[0].args), plan.tasks[0].args);
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

test('H.6-FIX3 low-stock list shows name and stock values, resolving only returned SKU identities', async () => {
  const calls = [];
  const state = {};
  const response = await handleV3({
    message: globalQueries[0][0], state, context: { businessId: V3.businessId, userId: 'fix3', conversationId: 'list' },
    service: { resolveContext: async () => binding, resolveEntity: async (type, reference, context) => {
      calls.push(['resolve', type, reference, context]);
      return reference === 'PAN-FRE-001' ? { entity:{ type:'product', id:'bbbbbbbbbbbbbbbbbbbbbbbb', key:reference, label:'Pan francés' } } : {};
    } },
    run: async (...args) => {
      calls.push(['run', ...args]);
      return { status: 'READY', data: { total: 1, items: [{ sku: 'PAN-FRE-001', productName: 'Pan francés',
        stock: { onHand: 2 }, inventoryPolicy: { configuredMinimumStock: 3 }, risk: { level: 'HIGH' } }] },
        metadata: { asOf: '2026-10-14', dataMode: 'LIVE', selected: {} } };
    },
    commit: patch => Object.assign(state, patch)
  });
  assert.deepEqual(calls.filter(call => call[0] === 'resolve').map(call => call[2]), ['PAN-FRE-001'],
    'resolve only the returned SKU, never the global natural-language filter');
  assert.equal(calls.filter(call => call[0] === 'run').length, 1);
  assert.equal(calls[0][1], 'operations');
  assert.equal(calls[0][2], 'get_inventory_intelligence');
  assert.match(response.answer, /Pan francés/);
  assert.match(response.answer, /Stock actual: 2/);
  assert.match(response.answer, /Stock mínimo: 3/);
  assert.doesNotMatch(response.answer, /riesgo|cobertura|pronóstico|forecast|proveedor/i);
  assert.deepEqual(response.v3Views[0].items[0].metrics.map(metric => metric.label), ['Stock actual', 'Stock mínimo']);
});

test('H.6-FIX3 nearest-minimum query reads all bounded inventory pages and chooses the smallest positive gap', async () => {
  const calls = [], state = {};
  const rows = [
    { sku: 'LOW-001', productName: 'Producto bajo', stock: { onHand: 2 }, inventoryPolicy: { configuredMinimumStock: 3 } },
    { sku: 'NEAR-002', productName: 'Producto cercano', stock: { onHand: 4 }, inventoryPolicy: { configuredMinimumStock: 3 } },
    { sku: 'NEAR-003', productName: 'Producto más lejano', stock: { onHand: 7 }, inventoryPolicy: { configuredMinimumStock: 4 } }
  ];
  const response = await handleV3({
    message: '¿Qué producto está más cerca de su stock mínimo sin haberlo alcanzado?', state,
    context: { businessId: V3.businessId, userId: 'fix3', conversationId: 'nearest' },
    service: { resolveContext: async () => binding, resolveEntity: async (...args) => { calls.push(['resolve', ...args]); return {}; } },
    run: async (_agent, _skill, args) => {
      calls.push(['run', args.offset]);
      return { status: 'READY', data: { total: rows.length, items: args.offset === 0 ? rows : [] },
        metadata: { asOf: '2026-10-14', dataMode: 'LIVE', selected: {} } };
    },
    commit: patch => Object.assign(state, patch)
  });
  assert.deepEqual(calls.filter(row => row[0] === 'run').map(row => row[1]), [0, 20, 40, 60]);
  assert.equal(calls.filter(row => row[0] === 'resolve').length, 0);
  assert.match(response.answer, /Producto cercano: stock actual 4 unidades; stock mínimo 3 unidades/);
  assert.doesNotMatch(response.answer, /Producto bajo|más lejano/);
  assert.deepEqual(response.v3Views[0].items[0].metrics.map(metric => metric.label), ['Stock actual', 'Stock mínimo']);
});

test('H.6-FIX3 leaves existing brand/category filters and should-reorder condition distinct', () => {
  const branded = routeV3('¿Qué productos Gloria están por acabarse?', {}, binding);
  assert.equal(branded.responseMode, 'inventory-filter');
  assert.equal(branded.condition, 'low_stock');
  const category = routeV3('¿Qué galletas están con poco stock?', {}, binding);
  assert.equal(category.responseMode, 'inventory-filter');
  assert.equal(category.condition, 'low_stock');
  const reorder = routeV3('¿Cuáles debería reponer?', {}, binding);
  assert.equal(reorder.tasks[0].args.flag, 'should_reorder');
  assert.equal(routeV3('¿Cuánto stock tiene el pan francés?', {}, binding).responseMode, 'minimal');
});

