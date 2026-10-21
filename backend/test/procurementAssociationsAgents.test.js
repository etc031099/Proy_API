'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, id } = require('./helpers/j2sProductFixture');
const { V3 } = require('../src/services/v3IntelligenceService');
const { getAgentDefinition } = require('../src/agents/definitions');
const { validateSkillInvocation } = require('../src/agents/skills');
const { validateActionInvocation } = require('../src/automations/skills');
const { createAgentRequestContext } = require('../src/agents/contracts');
const vendors = ['Distribuidora Norte', 'Distribuidora Sur'].map((name, index) => ({ _id: id(500 + index), name,
  stableCode: `SUP-00${index + 1}`, businessId: V3.businessId, scenarioId: V3.scenarioId, type: 'vendor', isActive: true }));
const setup = () => fixture({ contactRows: vendors, mlTransform(domain, payload, body) {
  if (domain === 'suppliers') body.data = { items: vendors.filter(row => !payload.supplierCode || payload.supplierCode === row.stableCode)
    .map(row => ({ supplierCode: row.stableCode, displayName: row.name, purchaseOrderCount: 5, pendingOrderCount: 2,
      receivedSpendCents: 10000, leadTime: { averageDays: 3, sampleSize: 4 }, punctuality: { onTimeRatePct: 75 } })), total: payload.supplierCode ? 1 : 2 };
  return body;
} });
const agents = result => result.participants.map(row => row.agentId).sort();
for (const question of [
  'con q productos suelen comprar coca cola?',
  'con qué productos suelen comprar coca cola?',
  'qué suelen comprar junto con coca cola?',
  'qué productos compran junto a coca cola?',
  'qué se compra con coca cola?',
  'qué productos acompañan a coca cola?',
  'con qué se suele comprar coca cola?',
  'qué productos compran junto con coca cola?',
  'con q productos suelen comprar coca cola porfa?'
]) test(`A5.2.1 human READ intent precedes product resolution: ${question}`, async () => {
  const { highPrecisionMessage } = require('../src/agents/languageNlu');
  const { normalizeProductReference, extractProductReference } = require('../src/utils/productReference');
  const { routeV3 } = require('../src/agents/v3Routing');
  const { specialistPlan } = require('../src/agents/specialistRouting');
  const normalized = highPrecisionMessage(question);
  assert.equal(normalizeProductReference(extractProductReference(normalized)), 'coca cola');
  assert.equal(highPrecisionMessage(normalized), normalized);
  for (const plan of [routeV3(question, {}, { operationalDate: '2026-10-15' }), specialistPlan(question)]) {
    assert.equal(plan?.tasks?.[0].agent, 'associations');
    assert.equal(normalizeProductReference(plan.tasks[0].args.productRef), 'coca cola');
  }
  const f = setup(); let result = await f.run(question);
  assert.equal(result.requiresClarification, true, result.answer); assert.equal(result.suggestions?.length, 2);
  const snapshot = await f.snapshot(), pending = snapshot.v3Context.pending.tasks[0];
  assert.equal(pending.agent, 'associations'); assert.equal(pending.skillId, 'get_cross_sell_recommendations');
  assert.equal(normalizeProductReference(pending.args.productRef), 'coca cola');
  const searches = JSON.stringify(f.catalogReads, (_key, value) => value instanceof RegExp ? value.source : value);
  assert.doesNotMatch(searches, /suelen|acompan|productos|junto/i);
  assert.equal(f.calls.length, 0); assert.equal(result.usage.totalLlmCalls, 0);
  result = await f.run('1');
  assert.equal(result.code, null, result.answer); assert.deepEqual(agents(result), ['associations', 'coordinator']);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.sku, 'BEB-GAS-001');
  assert.equal(result.usage.totalLlmCalls, 0); assert.equal(f.prepared.length, 0); assert.equal(f.mutations.length, 0);
});

for (const question of ['compra 10 coca colas', 'registra una compra de 10 unidades de Coca-Cola'])
  test(`A5.2.1 purchase commands retain Operations and quantity: ${question}`, async t => {
    const { Product } = require('../src/models');
    const { actionIntent, parseAction } = require('../src/automations/actionInput');
    t.mock.method(Product, 'find', require('./helpers/j2sProductFixture').productFind);
    assert.equal(actionIntent(question), 'create_purchase');
    assert.equal(require('../src/agents/languageNlu').highPrecisionMessage(question), question);
    assert.equal(parseAction(question, 'create_purchase').items[0].quantity, 10);
    const f = setup(), result = await f.run(question);
    assert.equal(result.agent, 'operations', result.answer); assert.equal(result.suggestions?.length, 2);
    assert.equal(result.usage.totalLlmCalls, 0); assert.equal(f.calls.length, 0);
    const selected = await f.run('1');
    assert.equal(selected.agent, 'operations', selected.answer);
    assert.equal(selected.pendingAction?.action, 'create_purchase', selected.answer);
    assert.equal(f.prepared[0].products[0].quantity, 10); assert.equal(f.mutations.length, 0);
  });

for (const question of ['¿Cómo están mis proveedores?', '¿Qué proveedor entrega más rápido?',
  'q proveedor suele entregar mas rapido', '¿Qué compras tengo pendientes?', '¿Qué proveedor ha sido más puntual?'])
  test(`A5.2 Procurement deterministic: ${question}`, async () => {
    const f = setup(), result = await f.run(question);
    assert.equal(result.code, null, result.answer); assert.equal(result.requiresClarification, false, result.answer);
    assert.deepEqual(agents(result), ['coordinator', 'procurement']);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].domain, 'suppliers');
    assert.equal(result.usage.totalLlmCalls, 0); assert.equal(f.mutations.length, 0);
    assert.match(result.answer, /observad|histori|registrad/);
    assert.doesNotMatch(result.answer, /probabilidad de retraso|fallará|mejor proveedor futuro/);
  });
test('A5.2 supplier ambiguity preserves detail intent and ordinal selection', async () => {
  const f = setup(); let result = await f.run('¿Cuál es el historial de compras del proveedor Distribuidora?');
  assert.equal(result.requiresClarification, true, result.answer); assert.equal(result.suggestions.length, 2);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.v3Context.pending.tasks[0].agent, 'procurement');
  assert.equal(snapshot.v3Context.pending.tasks[0].args.mode, 'detail');
  result = await f.run('1'); assert.equal(result.code, null, result.answer);
  assert.deepEqual(agents(result), ['coordinator', 'procurement']);
  assert.equal(f.calls.at(-1).payload.supplierCode, 'SUP-001');
  assert.match(result.answer, /3 días|75/);
  assert.match(result.answer, /resumen agregado.*no un listado/);
});
test('A5.2 unique and absent supplier use the existing tenant resolver', async () => {
  const f = setup(); let result = await f.run('lead time de proveedor SUP-001');
  assert.equal(result.code, null, result.answer); assert.equal(f.calls.at(-1).payload.supplierCode, 'SUP-001');
  const before = f.calls.length; result = await f.run('historial de compras del proveedor Inexistente');
  assert.equal(result.requiresClarification, true, result.answer); assert.equal(f.calls.length, before);
});
for (const question of ['q productos se compran junto con la cocacola?', '¿Qué productos se compran con Coca-Cola?', '¿Qué productos se compran junto con Coca-Cola?', 'con q se compra mas la coca cola',
  '¿Qué reglas de asociación hay para Coca-Cola?']) test(`A5.2 Associations selection: ${question}`, async () => {
  const f = setup(); let result = await f.run(question);
  assert.equal(result.requiresClarification, true, result.answer); assert.equal(result.suggestions.length, 2);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.v3Context.pending.tasks[0].agent, 'associations');
  result = await f.run('BEB-GAS-001'); assert.equal(result.code, null, result.answer);
  assert.deepEqual(agents(result), ['associations', 'coordinator']);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].domain, 'cross-sell');
  assert.equal(f.calls[0].payload.sku, 'BEB-GAS-001'); assert.equal(f.calls[0].payload.dataMode, 'HISTORICAL');
  assert.match(result.answer, /no demuestra causalidad|no implica causalidad/);
  assert.equal(result.usage.totalLlmCalls, 0); assert.equal(f.mutations.length, 0);
});
for (const reference of ['esta', 'esa']) test(`A5.2 technical association metrics preserve active product: ${reference}`, async () => {
  const f = setup(); let result = await f.run('reglas de asociación para BEB-GAS-001');
  assert.equal(result.code, null, result.answer);
  result = await f.run(`¿Cuál es el lift de ${reference} asociación?`);
  assert.equal(result.code, null, result.answer); assert.deepEqual(agents(result), ['associations', 'coordinator']);
  assert.equal(f.calls.at(-1).payload.sku, 'BEB-GAS-001');
  assert.match(result.answer, /lift 2|lift: 2/i); assert.match(result.answer, /Support|support/);
  assert.match(result.answer, /Confidence|confidence/); assert.match(result.answer, /congelado/);
});

test('A5.2.1 shared normalization does not reinterpret customers or merge separate clauses', () => {
  const { highPrecisionMessage } = require('../src/agents/languageNlu');
  for (const question of ['¿Qué clientes compran con más frecuencia?', '¿Quién suele comprar Coca-Cola?',
    'con qué productos suelen comprar coca cola y cuánto venderemos en 14 días?'])
    assert.doesNotMatch(highPrecisionMessage(question), /^productos relacionados con /);
});

test('A5.2 normal associations stay compact; explicit metrics remain available', async () => {
  const f = setup(); let result = await f.run('productos relacionados con BEB-GAS-001');
  assert.equal(result.code, null, result.answer); assert.match(result.answer, /Coca-Cola/);
  assert.doesNotMatch(result.answer, /support|confidence|lift/i);
  assert.ok(!result.v3Views[0].items[0].metrics.some(metric => /Support|Confidence|Lift/.test(metric.label)));
  result = await f.run('support de esta asociación');
  assert.equal(result.code, null, result.answer); assert.match(result.answer, /support 10%/);
  assert.match(result.answer, /proporción de tickets/);
  assert.ok(result.v3Views[0].items[0].metrics.some(metric => metric.label === 'Support' && metric.value === '10%'));
});
test('A5.2 explicit purchase writes never enter Procurement', async () => {
  const { routeV3 } = require('../src/agents/v3Routing');
  for (const question of ['registra una compra de 2 BEB-GAS-001', 'crea una orden de compra de BEB-GAS-001', 'recibe esta compra']) {
    const plan = routeV3(question, {}, { operationalDate: '2026-10-15' });
    assert.equal(plan.specialist, 'operations'); assert.equal(plan.tasks, undefined);
  }
  for (const question of ['crea una orden de compra de BEB-GAS-001', 'recibe esta compra']) {
    const f = setup(), result = await f.run(question);
    assert.ok(agents(result).includes('operations'), result.answer); assert.ok(!agents(result).includes('procurement'));
    assert.equal(f.calls.length, 0); assert.equal(f.prepared.length, 0); assert.equal(f.mutations.length, 0);
  }
});
test('A5.2 both specialists are ACTIVE, read-only and isolated from mutation skills', () => {
  const context = createAgentRequestContext({ user: { _id: id(999), businessId: V3.businessId, role: 'user', isActive: true } });
  for (const agentId of ['procurement', 'associations']) {
    const definition = getAgentDefinition(agentId);
    assert.equal(definition.status, 'ACTIVE'); assert.equal(definition.capabilities.canWrite, false);
    assert.deepEqual(definition.allowedActionSkills, []);
    for (const skillId of ['create_purchase', 'create_sale', 'train', 'promote'])
      assert.throws(() => validateActionInvocation({ context, agentId, skillId, args: {} }));
    assert.throws(() => validateSkillInvocation({ context, agentId, skillId: 'get_product_forecast', args: {} }));
  }
  assert.throws(() => validateSkillInvocation({ context, agentId: 'procurement', skillId: 'get_recent_transactions', args: { type: 'sale' } }));
  assert.doesNotThrow(() => validateSkillInvocation({ context, agentId: 'procurement', skillId: 'get_recent_transactions', args: { type: 'purchase' } }));
});

test('A5.2 registered purchase still uses Operations preview without confirmation', async t => {
  const { Product } = require('../src/models');
  t.mock.method(Product, 'find', require('./helpers/j2sProductFixture').productFind);
  const f = setup(), result = await f.run('registra una compra de 2 PAN-FRE-001');
  assert.equal(result.agent, 'operations', result.answer);
  assert.equal(result.pendingAction?.action, 'create_purchase', result.answer);
  assert.equal(f.calls.length, 0); assert.equal(f.prepared.length, 1); assert.equal(f.mutations.length, 0);
});

test('A5.2 recent purchases use the existing purchase-only read contract', () => {
  const plan = require('../src/agents/intentRouting').routeDeterministically('últimas compras', {}, new Date('2026-10-15T17:00:00Z'));
  assert.equal(plan.agent, 'procurement'); assert.equal(plan.type, 'purchase');
  assert.equal(plan.intent, 'recent_transactions');
});

test('A5.2 alternatives reuse the V3 configured-offer contract and product resolver', async () => {
  const f = setup(), result = await f.run('¿Qué ofertas de proveedores hay para BEB-GAS-001?');
  assert.equal(result.code, null, result.answer); assert.deepEqual(agents(result), ['coordinator', 'procurement']);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.mode, 'alternatives');
  assert.deepEqual(f.calls[0].payload.productSkus, ['BEB-GAS-001']);
});

test('A5.2 partial supplier metrics remain unavailable, never zero or predictive', () => {
  const { renderV3 } = require('../src/agents/v3Routing');
  const result = { data: { items: [{ supplierCode: 'SUP-001', displayName: 'Proveedor', leadTime: { averageDays: null },
    punctuality: { onTimeRatePct: null }, exclusiveOfferedSkuCount: null }] }, metadata: { asOf: '2026-10-15', dataMode: 'LIVE' } };
  const text = renderV3('get_supplier_intelligence', result, { mode: 'detail' });
  assert.match(text, /lead time observado no disponible/); assert.match(text, /puntualidad no disponible/);
  assert.match(text, /catálogo exclusivo: no disponible/);
});

for (const question of ['¿Cuál es la probabilidad de retraso del proveedor SUP-001?', '¿Qué proveedor tiene mejor desempeño?'])
  test(`A5.2 unsupported supplier prediction or score clarifies: ${question}`, async () => {
    const f = setup(), result = await f.run(question);
    assert.equal(result.requiresClarification, true, result.answer); assert.equal(f.calls.length, 0);
    assert.match(result.answer, /No existe|No hay/); assert.equal(result.usage.totalLlmCalls, 0);
  });

for (const [question, intent, agent, productQuery] of [
  ['evalúa la logística que manejo', 'SUPPLIER_PERFORMANCE', 'procurement', null]
]) test(`A5.2 uncertain language reuses the existing single NLU for ${agent}`, async () => {
  let calls = 0;
  const neutralProvider = require('../src/agents/providers/deepseekProvider').createDeepSeekProvider({
    env: { DEEPSEEK_API_KEY: 'offline-only' }, fetchImpl: async () => {
      calls++; return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify({ intent, productQuery, metric: null, period: null,
          quantity: null, horizonDays: null, needsClarification: false, clarificationReason: null }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) };
    } });
  const f = fixture({ neutralProvider }), result = await f.run(question);
  assert.equal(result.code, null, result.answer); assert.deepEqual(agents(result), ['coordinator', agent].sort());
  assert.equal(calls, 1); assert.equal(result.usage.totalLlmCalls, 1); assert.equal(f.calls.length, 1);
});

test('A5.2 binary frozen basket semantics stay with the unchanged service', async () => {
  const fs = require('node:fs'), crypto = require('node:crypto');
  const artifact = require.resolve('../../ml/data/minimarket-pasco-v3-market-basket-v1.json');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  const before = hash(), f = setup();
  const result = await f.run('explica FP-Growth para BEB-GAS-001');
  assert.equal(result.code, null, result.answer); assert.deepEqual(agents(result), ['associations', 'coordinator']);
  assert.match(result.answer, /cesta es binaria|presencia o ausencia/);
  assert.equal(hash(), before); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.dataMode, 'HISTORICAL');
  assert.ok(!('quantity' in f.calls[0].payload)); assert.ok(!('units' in f.calls[0].payload));
  assert.deepEqual(getAgentDefinition('associations').allowedSkills, ['get_cross_sell_recommendations']);
});

test('A5.2 existing validated CROSS_SELL NLU delegates to Associations without a new interpreter', () => {
  const plan = require('../src/agents/languageNlu').nluPlan({ intent: 'CROSS_SELL', productQuery: 'BEB-GAS-001',
    metric: null, period: null, quantity: null, horizonDays: null, needsClarification: false, clarificationReason: null },
  'sugiéreme un combo para BEB-GAS-001', {}, { operationalDate: '2026-10-15' });
  assert.equal(plan.tasks[0].agent, 'associations'); assert.equal(plan.tasks[0].skillId, 'get_cross_sell_recommendations');
  assert.equal(plan.tasks[0].args.productRef, 'BEB-GAS-001');
});

test('A5.2 new-domain composition cannot fan out to three specialists', async () => {
  const f = setup(), result = await f.run('stock de BEB-GAS-001 y productos relacionados con BEB-GAS-001 y proveedores');
  assert.equal(result.requiresClarification, true, result.answer); assert.equal(f.calls.length, 0);
});

for (const question of ['¿Qué productos están relacionados?', '¿Con qué producto conviene hacer venta cruzada?'])
  test(`A5.2 global association questions do not invent a product reference: ${question}`, async () => {
    const f = setup(), result = await f.run(question);
    assert.equal(result.code, null, result.answer); assert.deepEqual(agents(result), ['associations', 'coordinator']);
    assert.equal(f.calls[0].payload.mode, 'rules'); assert.equal(f.calls[0].payload.sku, undefined);
    assert.equal(result.usage.totalLlmCalls, 0);
  });

test('A5.2 supplier adapters preserve explicit periods from the shared clock contract', async () => {
  const f = setup(), result = await f.run('¿Cómo están mis proveedores este mes?');
  assert.equal(result.code, null, result.answer);
  assert.deepEqual(f.calls[0].payload.period, { startDate: '2026-10-01', endDate: '2026-10-15' });
});
