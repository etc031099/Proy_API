'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeV3 } = require('../src/agents/v3Routing');
const { buildGroundedPlan } = require('../src/agents/groundedRouting');
const { AGENTS } = require('../src/agents/definitions');
const { snapshot } = require('../src/services/agentHistoryProjection');
const { fixture, productFind } = require('./helpers/j2sProductFixture');
const binding = { operationalDate: '2026-10-20' };
const memory = { lastAgent: 'analyst', lastFamily: 'get_product_forecast',
  selectedProduct: { type: 'product', id: '507f1f77bcf86cd799439012', key: 'BEB-GAS-001', label: 'Coca-Cola' },
  selectedCustomer: { type: 'customer', id: '507f1f77bcf86cd799439013', key: 'CLI-001', label: 'Cliente' },
  lastProductTask: { skillId: 'get_product_forecast', args: { horizonDays: 14 } } };

for (const [message, agent] of [
  ['¿Cuánto stock tiene BEB-GAS-001?', 'inventory'], ['¿Cuánto venderemos de BEB-GAS-001 en 14 días?', 'forecast'],
  ['¿Qué modelo usa BEB-GAS-001 en 14 días?', 'forecast'], ['¿Cuánto vendimos este mes?', 'sales'],
  ['¿Qué segmento tiene ese cliente?', 'customers'], ['¿Cómo están mis proveedores?', 'procurement'],
  ['¿Qué productos compran junto con BEB-GAS-001?', 'associations'],
  ['¿y cuánto se vendería en dos semanas?', 'forecast'], ['¿y ese producto necesita reposición?', 'inventory'],
  ['¿qué modelo usa eso?', 'forecast'], ['¿y quién lo provee?', 'procurement'],
  ['¿qué productos suelen comprar junto con este?', 'associations'], ['¿y qué segmento tiene ese cliente?', 'customers']
]) test(`A6 direct/context route does not inherit legacy Analyst: ${message}`, () => {
  const plan = routeV3(message, memory, binding);
  assert.equal(plan.tasks.length, 1); assert.equal(plan.tasks[0].agent, agent);
  if (/eso|ese producto|dos semanas|lo provee|con este/.test(message)) assert.equal(plan.tasks[0].args.productRef, 'BEB-GAS-001');
});

test('A6 explicit shared composition dispatches exactly Inventory + Forecast', () => {
  const plan = routeV3('Para BEB-GAS-001, explícame si debo reponerlo y cuánto se espera vender en 14 días', memory, binding);
  assert.deepEqual(plan.tasks.map(task => task.agent), ['inventory', 'forecast']);
});

for (const message of ['cuánto vendí esta semana?', 'cuántas papas lays vendí?', 'qué vendí hoy?', 'ventas de papas lays', 'cómo fueron las ventas?'])
  test(`A6.1 analytical sales questions remain Sales with zero LLM: ${message}`, async () => {
    const { rows } = require('./helpers/j2sProductFixture');
    const f = fixture({ productRows: [...rows, { ...rows[0], _id: '507f1f77bcf86cd799439099', sku: 'SNA-PAP-001', name: 'Papas Lays' }] });
    const result = await f.run(message);
    assert.ok(result.participants.some(row => row.agentId === 'sales'), result.answer);
    assert.ok(!result.participants.some(row => row.agentId === 'operations'));
    assert.equal(result.usage.totalLlmCalls, 0); assert.equal(f.providerCalls.length, 0);
    assert.equal(f.prepared.length, 0); assert.equal(f.mutations.length, 0);
  });

test('A6 grounded reads belong to specialists; synthesis and historical health remain compatible', () => {
  const plan = buildGroundedPlan('Stock, inventario y demanda: ¿qué debería priorizar?', binding);
  assert.deepEqual(plan.tasks.map(task => task.agent), ['inventory', 'forecast']);
  assert.equal(buildGroundedPlan('Interpreta la salud del negocio', binding).tasks[0].agent, 'analyst');
  const excessive = buildGroundedPlan('Analiza ventas, inventario y forecast y dime qué debería priorizar.', binding);
  assert.equal(excessive.tasks.length, 0); assert.match(excessive.clarificationQuestion, /máximo dos dominios/);
});

test('A6 three-domain composition clarifies before executing any skill', async () => {
  const f = fixture(); const result = await f.run('Stock de BEB-GAS-001 y cuánto vendimos este mes y cómo están mis proveedores');
  assert.equal(result.requiresClarification, true); assert.equal(result.usage.totalSkillCalls, 0);
  assert.equal(result.usage.totalLlmCalls, 0); assert.equal(f.calls.length, 0);
});

test('A6 restored Analyst context stays readable but new V3 inventory delegates directly with zero LLM', async () => {
  const f = fixture();
  const legacy = snapshot({ lastAgent: 'analyst', lastIntent: 'business_summary' });
  assert.equal(legacy.lastAgent, 'analyst');
  await f.runtime.restoreContext(f.request, f.conversationId, legacy);
  const result = await f.run('¿Cuánto stock tiene BEB-GAS-001?');
  assert.deepEqual(result.participants.map(row => row.agentId).sort(), ['coordinator', 'inventory']);
  assert.equal(result.usage.totalLlmCalls, 0); assert.equal(f.providerCalls.length, 0);
  assert.equal(f.prepared.length, 0); assert.equal(f.mutations.length, 0);
  const reads = f.calls.length;
  const explained = await f.run('explícame eso');
  assert.equal(explained.agent, 'coordinator'); assert.equal(explained.usage.totalLlmCalls, 0);
  assert.equal(f.calls.length, reads);
});

for (const [message, action] of [['vende 1 BEB-GAS-001', 'create_sale'], ['compra 1 BEB-GAS-001', 'create_purchase']])
  test(`A6 explicit write stays Operations-only and requires confirmation: ${action}`, async t => {
    t.mock.method(require('../src/models').Product, 'find', productFind);
    const f = fixture(), result = await f.run(message);
    assert.equal(result.agent, 'operations'); assert.equal(result.pendingAction.action, action);
    assert.equal(result.pendingAction.status, 'PENDING'); assert.equal(f.mutations.length, 0);
    assert.equal(result.usage.totalLlmCalls, 0); assert.equal(result.usage.totalSkillCalls, 0);
  });

test('A6 Coordinator orchestrates; only Operations is write-capable', () => {
  assert.deepEqual(AGENTS.filter(agent => agent.capabilities.canWrite).map(agent => agent.id), ['operations']);
  for (const agent of AGENTS.filter(row => row.id !== 'operations')) assert.deepEqual(agent.allowedActionSkills, []);
  assert.equal(AGENTS.find(row => row.id === 'coordinator').capabilities.canRead, false);
  assert.equal(AGENTS.find(row => row.id === 'analyst').capabilities.readOnly, true);
});
