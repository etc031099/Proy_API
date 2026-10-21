'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, id } = require('./helpers/j2sProductFixture');
const { V3 } = require('../src/services/v3IntelligenceService');
const { getAgentDefinition } = require('../src/agents/definitions');
const { createAgentRequestContext } = require('../src/agents/contracts');
const { validateSkillInvocation } = require('../src/agents/skills');
const { validateActionInvocation } = require('../src/automations/skills');
const clustering = require('../../ml/artifacts/customer-kmeans-v3/metadata.json');
const customer = (n, name) => ({ _id: id(100 + n), stableCode: `CLI-00${n}`, name,
  businessId: V3.businessId, scenarioId: V3.scenarioId, type: 'customer', isActive: true });
const setup = () => fixture({ contactRows: [customer(1, 'Juan Pérez'), customer(2, 'Juan Paredes')],
  mlTransform(domain, payload, body) {
    if (domain === 'customers' && payload.mode === 'clustering') return { ...body,
      metadata: { ...body.metadata, source: 'CANONICAL_V3_BUNDLE', contractVersion: 'm6.9b-v3-intelligence-v1' },
      data: { ...structuredClone(clustering), ...(payload.customerCode ? {
        assignmentSource: 'AUTHORIZED_CURRENT_RFM', assignmentAsOfDate: payload.assignmentAsOfDate,
        assignments: [{ customerRef: payload.customerCode, status: 'ASSIGNED', cluster: 2, clusterName: 'Gasto moderado',
          ...payload.assignmentRfm, rfmSegment: payload.assignmentSegment }] } : {}) } };
    return body;
  } });
const participants = result => result.participants.map(row => row.agentId).sort();
for (const question of ['¿Cuánto vendimos hoy?', '¿Cómo estuvieron las ventas esta semana?',
  '¿Qué producto se vendió más?', '¿Cuántas ventas tuvimos este mes?', '¿Qué ingresos tuvimos ayer?',
  '¿Cómo van las ventas?', 'como van las ventas hoy']) test(`A5.1 Sales deterministic: ${question}`, async () => {
  const f = setup(), r = await f.run(question);
  assert.equal(r.code, null, r.answer); assert.equal(r.requiresClarification, false, r.answer);
  assert.deepEqual(participants(r), ['coordinator', 'sales']);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].domain, 'business');
  assert.equal(r.usage.totalLlmCalls, 0); assert.equal(f.mutations.length, 0);
});
test('A5.1 Sales preserves period and service numbers, not computed substitutes', async () => {
  const f = setup(), r = await f.run('¿Cuánto vendimos hoy?');
  assert.equal(f.calls[0].payload.context.asOfDate, '2026-10-15');
  assert.match(r.answer, /500\.00/); assert.match(r.answer, /20 tickets/);
  assert.equal(f.calls[0].payload.period.startDate, '2026-10-15');
});
for (const question of ['¿Quiénes son mis mejores clientes?', 'cuales son mis clientes q mas compran',
  '¿Qué clientes compran con más frecuencia?', '¿Qué clientes llevan más tiempo sin comprar?',
  '¿Cómo están distribuidos los clientes por segmento?']) test(`A5.1 Customers deterministic: ${question}`, async () => {
  const f = setup(), r = await f.run(question);
  assert.equal(r.code, null, r.answer); assert.equal(r.requiresClarification, false, r.answer);
  assert.deepEqual(participants(r), ['coordinator', 'customers']);
  assert.equal(r.usage.totalLlmCalls, 0); assert.ok(f.calls.every(row => row.domain === 'customers'));
});
test('A5.1 customer ambiguity preserves clustering through selection, history and RFM follow-up', async () => {
  const f = setup(); let r = await f.run('¿A qué grupo pertenece Juan?');
  assert.ok(r.requiresClarification, r.answer); assert.equal(r.suggestions.length, 2);
  const state = await f.snapshot();
  assert.equal(state.v3Context.pending.tasks[0].agent, 'customers');
  assert.equal(state.v3Context.pending.tasks[0].args.mode, 'clustering');
  r = await f.run('1'); assert.equal(r.code, null, r.answer);
  assert.deepEqual(participants(r), ['coordinator', 'customers']);
  assert.match(r.answer, /cluster 2/); assert.match(r.answer, /RFM/); assert.match(r.answer, /congelado/);
  assert.equal(f.calls.at(-1).payload.customerCode, 'CLI-001');
  r = await f.run('¿Cuál es el RFM de este cliente?');
  assert.equal(r.code, null, r.answer); assert.equal(f.calls.at(-1).payload.customerCode, 'CLI-001');
  assert.equal(r.usage.totalLlmCalls, 0);
});
test('A5.1 missing customer context clarifies; Consumer Final and churn cannot be inferred', async () => {
  for (const question of ['¿Cuál es el RFM de este cliente?', '¿A qué segmento pertenece Consumidor Final?',
    '¿Cuál es la probabilidad de churn de este cliente?']) {
    const f = setup(), r = await f.run(question);
    assert.ok(r.requiresClarification, r.answer); assert.equal(f.calls.length, 0); assert.equal(r.usage.totalLlmCalls, 0);
  }
});
test('A5.1 bounded Sales + Customers composition has one real skill per specialist', async () => {
  const f = setup(), r = await f.run('¿Cuál fue el producto más vendido y qué clientes compraron más?');
  assert.equal(r.code, null, r.answer); assert.deepEqual(participants(r), ['coordinator', 'customers', 'sales']);
  assert.equal(r.actions.length, 2); assert.deepEqual(f.calls.map(row => row.domain), ['business', 'customers']);
  assert.equal(r.usage.totalLlmCalls, 0);
});
test('A5.1 specialist read-only boundaries remain explicit', () => {
  const context = createAgentRequestContext({ user: { _id: id(999), businessId: V3.businessId, role: 'user', isActive: true } });
  for (const agentId of ['sales', 'customers']) {
    const agent = getAgentDefinition(agentId); assert.equal(agent.status, 'ACTIVE');
    assert.equal(agent.capabilities.canWrite, false); assert.equal(agent.limits.maxLlmCalls, 0);
    for (const skillId of ['create_sale', 'create_purchase', 'train', 'promote'])
      assert.throws(() => validateActionInvocation({ context, agentId, skillId, args: {} }));
    assert.throws(() => validateSkillInvocation({ context, agentId, skillId: 'get_product_forecast', args: {} }));
  }
  assert.throws(() => validateSkillInvocation({ context, agentId: 'sales', skillId: 'get_recent_transactions', args: { type: 'purchase' } }));
  for (const agentId of ['procurement', 'associations']) assert.equal(getAgentDefinition(agentId).status, 'ACTIVE');
  assert.equal(getAgentDefinition('operations').capabilities.canWrite, true);
});

test('A5.1 customer missing RFM stays unavailable, not zero; clustering retains separate identity', () => {
  const { renderV3 } = require('../src/agents/v3Routing');
  const result = { data: { assignments: [{ customerRef: 'CLI-001', customerName: 'Juan', status: 'ASSIGNED',
    cluster: 2, recency: null, frequency: null, monetary: null }], clusters: [], sampleCount: 4 }, metadata: { asOf: '2026-10-15' } };
  const text = renderV3('get_customer_intelligence', result, { mode: 'clustering' });
  assert.match(text, /recencia no disponible, frecuencia no disponible, valor monetario no disponible/);
  assert.match(text, /cluster 2/); assert.match(text, /RFM describe/); assert.match(text, /No se reentrena ni predice churn/);
});

test('A5.1 absent customer is not silently replaced by previous selection', async () => {
  const f = setup(); await f.run('¿Cuál es el RFM de CLI-001?');
  const before = f.calls.length, r = await f.run('¿A qué grupo pertenece NombreInexistente?');
  assert.ok(r.requiresClarification, r.answer); assert.equal(f.calls.length, before); assert.equal(r.usage.totalLlmCalls, 0);
});

test('A5.1 composition never fans out to three specialists', async () => {
  const f = setup(), r = await f.run('ventas hoy y clientes frecuentes y stock de BEB-GAS-001');
  assert.ok(r.requiresClarification, r.answer); assert.equal(f.calls.length, 0);
});
test('A5.1 recent sales use existing transaction skill and cannot query purchases', () => {
  const { routeDeterministically } = require('../src/agents/intentRouting');
  const plan = routeDeterministically('Muéstrame las ventas recientes.', {}, new Date('2026-10-15T17:00:00Z'));
  assert.equal(plan.agent, 'sales'); assert.equal(plan.intent, 'recent_transactions'); assert.equal(plan.type, 'sale');
});
test('A5.1 explicit sale creation remains Operations preview, not Sales', async t => {
  const { Product } = require('../src/models'); const { productFind } = require('./helpers/j2sProductFixture');
  t.mock.method(Product, 'find', productFind);
  const f = setup(), r = await f.run('vende 2 PAN-FRE-001');
  assert.equal(r.pendingAction.status, 'PENDING'); assert.equal(f.prepared.length, 1); assert.equal(f.mutations.length, 0);
  assert.ok(!participants(r).includes('sales'));
});

for (const [message, intent, agent, domain] of [
  ['q cosas se estan moviendo mas', 'TOP_SELLING_PRODUCTS', 'sales', 'business'],
  ['a quienes debería llamar xq ya no vienen', 'CUSTOMERS_AT_RISK', 'customers', 'customers']
]) test(`A5.1 uncertain language reuses one Coordinator NLU then ${agent}`, async () => {
  let calls = 0;
  const { createDeepSeekProvider } = require('../src/agents/providers/deepseekProvider');
  const neutralProvider = createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'offline-only' }, fetchImpl: async () => {
    calls++; return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { role: 'assistant',
      content: JSON.stringify({ intent, productQuery: null, metric: null, period: null, quantity: null, horizonDays: null,
        needsClarification: false, clarificationReason: null }) } }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) };
  } });
  const f = fixture({ neutralProvider }), r = await f.run(message);
  assert.equal(r.code, null, r.answer); assert.equal(r.agent, agent, r.answer); assert.equal(calls, 1);
  assert.equal(r.usage.totalLlmCalls, 1); assert.equal(r.usage.totalTokens, 130);
  assert.deepEqual(participants(r), ['coordinator', agent].sort()); assert.equal(f.calls[0].domain, domain);
});
