'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, productFind, id } = require('./helpers/j2sProductFixture');
const { Product } = require('../src/models');
const { actionIntent, parseAction } = require('../src/automations/actionInput');
const { V3 } = require('../src/services/v3IntelligenceService');
const writes = ['registra una venta de 2 cocacolas', 'registra la venta de 2 cocacolas',
  'registra la venta de 2 coca colas', 'vende 2 coca colas', 'crea una venta de 2 Coca-Cola',
  'anota una venta de 2 Coca-Cola', 'quiero registrar una venta de 2 unidades de Coca-Cola'];
for (const message of writes) test(`A5.1.1 WRITE precedes Sales with zero NLU: ${message}`, async t => {
  assert.equal(actionIntent(message), 'create_sale');
  assert.equal(parseAction(message, 'create_sale').items[0].quantity, 2);
  t.mock.method(Product, 'find', productFind);
  const f = fixture(); const first = await f.run(message);
  assert.equal(first.agent, 'operations', first.answer);
  assert.equal(f.calls.length, 0); assert.equal(f.prepared.length, 0); assert.equal(f.mutations.length, 0);
  assert.ok(first.suggestions?.length >= 2, first.answer);
  assert.equal(first.usage.totalLlmCalls, 0);
  assert.ok(!first.participants.some(row => row.agentId === 'sales'));
  const selected = await f.run('1');
  assert.equal(selected.pendingAction?.status, 'PENDING', selected.answer);
  assert.equal(f.prepared.length, 1); assert.equal(f.prepared[0].products[0].quantity, 2);
  assert.equal(f.mutations.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(selected.usage.totalLlmCalls, 0);
});
test('A5.1.1 selection 2 is a candidate index, never a new quantity; explicit confirm executes only once', async t => {
  t.mock.method(Product, 'find', productFind);
  const f = fixture(); await f.run('anota una venta de 2 Coca-Cola');
  const preview = await f.run('2');
  assert.equal(preview.pendingAction.status, 'PENDING'); assert.equal(f.mutations.length, 0);
  assert.equal(f.prepared[0].products[0].quantity, 2);
  const confirmed = await f.run('confirmar');
  assert.equal(confirmed.pendingAction.status, 'EXECUTED'); assert.equal(f.mutations.length, 1);
  assert.equal(f.confirmations[0].id, preview.pendingAction.pendingActionId);
  await f.run('confirmar'); assert.equal(f.mutations.length, 1);
});
test('A5.1.1 read-only runtime also refuses to turn an explicit action into business analytics', async () => {
  const f = fixture(); const r = await f.runtime.handle(f.request, { message: 'registra la venta de 2 cocacolas', conversationId: f.conversationId });
  assert.equal(r.agent, 'operations'); assert.ok(r.requiresClarification); assert.equal(f.calls.length, 0);
});
for (const message of ['como fueron las ventas', 'qué producto se vendió más', 'cuántas ventas tuvimos', 'cuánto vendimos hoy'])
  test(`A5.1.1 Sales READ preserved: ${message}`, async () => {
    const f = fixture(), r = await f.run(message);
    assert.equal(actionIntent(message), null); assert.equal(r.agent, 'sales', r.answer);
    assert.equal(r.usage.totalLlmCalls, 0); assert.equal(f.prepared.length, 0);
  });
test('A5.1.1 future sales remain Forecast READ, not an Operations action', async () => {
  const { routeV3 } = require('../src/agents/v3Routing');
  const message = 'se espera vender Coca-Cola en 14 días';
  assert.equal(actionIntent(message), null);
  const plan = routeV3(message, {}, { operationalDate: '2026-10-15' });
  assert.equal(plan.tasks[0].agent, 'forecast'); assert.equal(plan.tasks[0].args.horizonDays, 14);
  assert.equal(plan.tasks[0].skillId, 'get_product_forecast');
});
for (const [names, expected] of [[[], 'NONE'], [['Juan Pérez'], 'ONE'], [['Juan Pérez', 'Juan Paredes'], 'MANY']])
  test(`A5.1.1 customer resolver preserves ${expected} real matches`, async () => {
    const f = fixture({ contactRows: names.map((name, i) => ({ _id: id(i + 1), name, stableCode: `CLI-00${i + 1}`,
      businessId: V3.businessId, scenarioId: V3.scenarioId, type: 'customer', isActive: true })) });
    const result = await f.service.resolveEntity('customer', 'Juan', { businessId: V3.businessId, requestId: `juan-${expected}` });
    if (expected === 'ONE') assert.equal(result.entity?.key, 'CLI-001');
    else { assert.equal(result.entity, undefined); assert.equal(result.candidates.length, names.length); }
    assert.equal(f.calls.length, 0);
  });
test('A5.1.1 best-customer labels remain the exact service RFM segment, not inferred KMeans or churn', async () => {
  const f = fixture({ contactRows: [{ _id: id(1), name: 'Cliente real del fixture', stableCode: 'CLI-001',
    businessId: V3.businessId, scenarioId: V3.scenarioId, type: 'customer', isActive: true }] });
  const r = await f.run('quienes son mis mejores clientes');
  assert.equal(f.calls[0].payload.metric, 'spend');
  assert.match(r.answer, /en riesgo según actividad observada/);
  assert.doesNotMatch(r.answer, /abandonará|probabilidad de churn|cluster asignado/);
});
