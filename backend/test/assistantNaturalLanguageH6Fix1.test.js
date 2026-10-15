'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3, handleV3, renderV3 } = require('../src/agents/v3Routing');
const { V3 } = require('../src/services/v3IntelligenceService');
const { actionIntent, parseAction } = require('../src/automations/actionInput');
const { contextBinding } = require('../src/agents/memory');

const binding = { ...V3, operationalDate: '2026-10-14', asOfDate: V3.referenceDate };
const examples = [
  ['¿Cuál Coca-Cola está por acabarse?', 'coca cola', null, 'low_stock'],
  ['¿Qué Coca-Cola está con poco stock?', 'coca cola', null, 'low_stock'],
  ['¿Qué gaseosas Coca-Cola debería reponer?', 'BEB-GAS', 'coca cola', 'should_reorder'],
  ['¿Qué productos Gloria están por acabarse?', 'gloria', null, 'low_stock'],
  ['¿Qué galletas están con poco stock?', 'GAL', null, 'low_stock']
];

test('H.6-FIX1 maps human brand/category + depletion phrases to the existing low_stock condition', () => {
  for (const [message, lookup, brandFilter, condition] of examples) {
    const plan = routeV3(message, {}, binding);
    assert.equal(plan?.responseMode, 'inventory-filter', message);
    assert.equal(plan.lookup, lookup, message);
    assert.equal(plan.brandFilter, brandFilter, message);
    assert.equal(plan.condition, condition, message);
  }
});

test('H.6-FIX1 resolves matching candidates through the existing resolver and queries only low-stock SKUs', async () => {
  const context = { businessId: V3.businessId, userId: 'h6-fix1', conversationId: 'brand-low-stock' };
  const state = {};
  const products = [
    { id: '1'.padStart(24, '0'), key: 'BEB-GAS-001', label: 'Coca-Cola Original 500 ml', type: 'product' },
    { id: '2'.padStart(24, '0'), key: 'BEB-GAS-004', label: 'Coca-Cola Original 1.5 L', type: 'product' },
    { id: '3'.padStart(24, '0'), key: 'BEB-GAS-005', label: 'Inca Kola 500 ml', type: 'product' }
  ];
  const calls = [];
  const service = {
    resolveContext: async () => binding,
    resolveEntity: async (type, query, _context, offset = 0) => {
      calls.push(['resolve', type, query, offset]);
      const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '');
      const rows = query === 'BEB-GAS' ? products : products.filter(row => row.label.toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalizedQuery));
      return { type, candidates: rows.slice(offset, offset + 5), pagination: { totalMatches: rows.length, offset, limit: 5 } };
    }
  };
  const response = await handleV3({ message: examples[0][0], state, context, service,
    run: async (_agent, skillId, args) => {
      calls.push(['run', skillId, args]);
      return { status: 'READY', data: { items: [{ sku: 'BEB-GAS-001', productName: 'Coca-Cola Original 500 ml',
        stock: { onHand: 2 }, risk: { lowStock: true } }], total: 1 },
        metadata: { asOf: '2026-10-14', dataMode: 'LIVE', selected: {} } };
    }, commit: patch => Object.assign(state, patch) });
  const inventory = calls.find(call => call[0] === 'run');
  assert.equal(inventory[1], 'get_inventory_intelligence');
  assert.equal(inventory[2].mode, 'summary');
  assert.equal(inventory[2].flag, 'low_stock');
  assert.equal(inventory[2].productRefs, 'BEB-GAS-001|BEB-GAS-004');
  const { getSkillDefinition } = require('../src/agents/skills');
  const { validateSkillArgs } = require('../src/agents/contracts');
  assert.deepEqual(validateSkillArgs(getSkillDefinition('get_inventory_intelligence').inputSchema, inventory[2]), inventory[2]);
  assert.match(response.answer, /Coca-Cola Original 500 ml: 2 unidades disponibles; bajo stock\./);
  assert.doesNotMatch(response.answer, /Inca Kola|cobertura|pronóstico|forecast|riesgo/);
  assert.equal(response.v3Views[0].items.length, 1);
  assert.deepEqual(response.v3Views[0].items[0].metrics.map(metric => metric.label), ['Stock', 'Riesgo']);
});

test('H.6-FIX1 never treats “saca” as a sale without an existing operation meaning', () => {
  assert.equal(actionIntent('saca 2 de la segunda'), null);
  assert.equal(actionIntent('vende 2 de la segunda'), 'create_sale');
  const parsed = parseAction('vende 2 de la segunda', 'create_sale');
  assert.deepEqual(parsed.items, [{ quantity: 2, ref: 'segunda' }]);
  const clarification = routeV3('saca 2 de la segunda', {}, binding);
  assert.match(clarification.clarificationQuestion, /venta|corregir el stock/);
  assert.equal(routeV3('¿Qué conclusiones sacas de estos datos?', {}, binding), null);
});

test('H.6-FIX1 low-stock filter reports an empty result without expanding the inventory card', () => {
  const answer = renderV3('get_inventory_intelligence', { data: { items: [] }, metadata: { asOf: '2026-10-14' } },
    { mode: 'summary', flag: 'low_stock' }, 'inventory-filter');
  assert.equal(answer, 'No encontré productos que coincidan con esa marca o categoría bajo la condición de bajo stock.');
  const unavailable = renderV3('get_inventory_intelligence', { status: 'PARTIAL', data: { reasonCode: 'LIVE_FORECAST_REQUIRED', items: [] },
    metadata: { asOf: '2026-10-14' } }, { mode: 'summary', flag: 'should_reorder' }, 'inventory-filter');
  assert.match(unavailable, /falta evidencia de pronóstico/);
});

test('H.6-FIX1 out-of-domain requests still fall through the current classifier unchanged', () => {
  for (const message of ['¿Quién ganó el partido de ayer?', '¿Cuál es la capital de Japón?',
    'Escríbeme una historia de terror.', '¿Qué laptop me recomiendas?']) {
    assert.equal(routeV3(message, {}, binding), null, message);
  }
});

test('H.6-FIX1 uses the authenticated scenario binding for query context', () => {
  assert.equal(typeof contextBinding({ businessId: V3.businessId, userId: 'h6-fix1', conversationId: 'binding' }), 'string');
});
