'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bank = require('./fixtures/a62FallbackCases');
const { fixture, productFind } = require('./helpers/j2sProductFixture');
const { Product } = require('../src/models');
const { createDeepSeekProvider } = require('../src/agents/providers/deepseekProvider');
const { validateGroundedOutput, buildGroundedContext } = require('../src/agents/groundedContext');
const { V3 } = require('../src/services/v3IntelligenceService');
const { routeV3 } = require('../src/agents/v3Routing');
const I = 'get_inventory_intelligence';
const binding = { ...V3, operationalDate: '2026-10-20' };
const output = (text = 'Coca-Cola tiene stock 21.', ref = 'E1') => JSON.stringify({ observations: [{ evidenceRefs: [ref],
  interpretation: text, advisoryRecommendation: 'Revisa los datos antes de decidir; no se ejecutó una compra.' }], limitations: [] });
function setup({ text, fail = false, truncated = false, nlu = false } = {}) {
  const requests = [];
  const provider = createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'offline-only' }, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    assert.equal(body.tools, undefined); assert.equal(body.reasoning_effort, 'none');
    if (fail) throw new Error('offline simulated failure');
    const compact = JSON.parse(body.messages[1].content);
    const customer = compact.responseIntent === 'customer_interpretation';
    const content = nlu && body.max_tokens === 300 ? JSON.stringify({ intent: 'INVENTORY_FORECAST', productQuery: 'BEB-GAS-001',
      metric: null, period: null, quantity: null, horizonDays: null, needsClarification: false, clarificationReason: null })
      : text || output(customer ? 'El cliente requiere revisar su actividad observada.' : undefined);
    return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: truncated ? 'length' : 'stop',
      message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 400, completion_tokens: 80, total_tokens: 480, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 400 } }) };
  } });
  const f = fixture({ neutralProvider: provider, contactRows: [{ _id: '507f1f77bcf86cd799439088', stableCode: 'CLI-001',
    name: 'Cliente de prueba', type: 'customer', businessId: V3.businessId, scenarioId: V3.scenarioId, isActive: true }],
    forecastRegistryService: { getActiveModelArtifact: async scope => ({ artifactData: Buffer.from('approved-test-artifact'),
      metadata: { ...scope, status: 'ACTIVE', modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', modelVersion: 1,
        featureVersion: 'RIDGE_CAUSAL27_V1', trainedDataVersion: '0', dataCutoff: '2026-10-14' } }) },
    mlTransform: (domain, payload, response) => domain !== 'forecast' ? response : { ...response, data: { total: 1,
      items: [{ sku: 'BEB-GAS-001', horizonDays: payload.horizonDays, status: 'READY', predictionUnits: 55.5,
        activeModelStatus: 'ACTIVE', modelVersion: 1, featureVersion: 'RIDGE_CAUSAL27_V1', trainedDataVersion: '0', dataVersion: '0',
        observationsThrough: '2026-10-14' }] } } });
  return { ...f, requests };
}

test('A6.2 certification sample reuses 100 prior NLU cases plus 50 focused utterances', () => {
  assert.equal(bank.reusedNlu.length, 100); assert.equal(bank.cases.length, 50);
  assert.equal(new Set(bank.cases.map(row => row.message)).size, 50);
  assert.equal(new Set([...bank.reusedNlu, ...bank.cases].map(row => require('../src/agents/domainGate').normalize(row.message))).size, 150);
  assert.deepEqual(bank.cases.reduce((counts, row) => ({ ...counts, [row.category]: (counts[row.category] || 0) + 1 }), {}),
    { deterministic: 12, grounded: 10, clarification: 6, outOfScope: 6, writeAmbiguous: 4, writeExplicit: 4, security: 8 });
});

for (const row of bank.cases) test(`A6.2 ${row.category}: ${row.message}`, async t => {
  const f = setup();
  if (row.category === 'writeExplicit') t.mock.method(Product, 'find', productFind);
  if (['grounded', 'deterministic'].includes(row.category)) {
    await f.run('stock de BEB-GAS-001');
    if (/cliente/.test(row.message)) await f.run('cuál es el RFM de CLI-001');
    f.calls.length = 0;
  }
  let result = await f.run(row.message);
  if (row.category === 'grounded' && result.suggestions?.some(item => item.message === 'BEB-GAS-001')) {
    assert.equal(f.requests.length, 0);
    result = await f.run('BEB-GAS-001');
  }
  assert.equal(f.mutations.length, 0);
  if (row.category === 'grounded') {
    assert.equal(result.requiresClarification, false, result.answer);
    assert.equal(result.groundedAnswer?.accepted, true, JSON.stringify(result.grounded));
    assert.equal(result.usage.totalLlmCalls, 1); assert.equal(f.requests.length, 1);
    assert.equal(result.usage.totalTokens, 480); assert.equal(result.semanticClassification, undefined);
    assert.ok(result.participants.some(agent => agent.agentId === 'analyst'));
    assert.ok(f.requests.every(request => Buffer.byteLength(JSON.stringify(request.messages)) <= 8000));
  } else if (['security', 'outOfScope'].includes(row.category)) {
    assert.equal(result.usage.totalLlmCalls, 0); assert.equal(result.usage.totalSkillCalls, 0);
    assert.equal(f.prepared.length, 0); assert.match(result.answer, /negocio|ámbito|acceso|permitid/i);
  } else if (row.category === 'writeAmbiguous') {
    assert.equal(result.agent, 'operations'); assert.equal(result.requiresClarification, true);
    assert.equal(f.prepared.length, 0); assert.equal(result.usage.totalLlmCalls, 0);
  } else if (row.category === 'writeExplicit') {
    assert.equal(result.agent, 'operations'); assert.equal(result.pendingAction.status, 'PENDING');
    assert.equal(f.prepared.length, 1); assert.equal(result.usage.totalLlmCalls, 0);
  } else if (row.category === 'deterministic') assert.equal(result.usage.totalLlmCalls, 0, result.answer);
  else {
    // The oracle deliberately returns an invalid NLU shape for uncertain reads:
    // never turn provider confusion into facts or a write.
    assert.equal(result.requiresClarification, true, result.answer);
    assert.ok(result.usage.totalLlmCalls <= 1); assert.equal(f.prepared.length, 0);
  }
});

const compact = buildGroundedContext({ question: 'analiza este producto', binding,
  plan: { skills: [I], responseIntent: 'product_interpretation' }, results: [{ skillId: I, result: { status: 'READY',
    metadata: { asOf: binding.operationalDate, dataMode: 'LIVE' }, data: { items: [{ sku: 'BEB-GAS-001',
      productName: 'Coca-Cola Sabor Original 500 ml', stock: { onHand: 21 }, risk: { level: 'HIGH' } }] } } }] });
for (const [text, reason] of [
  ['Coca-Cola tiene stock 999.', 'UNSUPPORTED_NUMBER'], ['Revisa BEB-FAKE-999.', 'UNKNOWN_ENTITY'],
  ['Revisa beb-fake-999.', 'UNKNOWN_ENTITY'], ['Pepsi tiene stock 21.', 'UNKNOWN_ENTITY'],
  ['Revisa Pepsi.', 'UNKNOWN_ENTITY'], ['El producto pepsi requiere atención.', 'UNKNOWN_ENTITY'],
  ['El cliente Juan tiene riesgo alto.', 'UNKNOWN_ENTITY'], ['Isolation Forest confirma fraude.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['El producto está agotado.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['El producto tiene riesgo bajo.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['Esta asociación demuestra causalidad.', 'UNSUPPORTED_SEMANTIC_CLAIM'],
  ['La probabilidad de fraude es alta.', 'UNSUPPORTED_SEMANTIC_CLAIM'], ['Registra una compra.', 'UNSUPPORTED_SEMANTIC_CLAIM']
]) test(`A6.2 rejects unsupported generated fact: ${text}`, () => {
  assert.throws(() => validateGroundedOutput(output(text), compact), error => error.validationReason === reason);
});
test('A6.2 references and negated model limitations remain grounded', () => {
  assert.throws(() => validateGroundedOutput(output('Coca-Cola tiene stock 21.', 'E9'), compact), { validationReason: 'EVIDENCE_REFERENCE_INVALID' });
  assert.ok(validateGroundedOutput(output('No es una probabilidad de fraude.'), compact));
});

test('A6.2 required evidence limitation is rendered even when generated limitations are empty', async () => {
  const response = await require('../src/agents/grounded').handleGrounded({ message: 'qué te preocupa de este producto?', context: {},
    resolvedBinding: binding, resolvedPlan: { route: 'GROUNDED_LLM', responseIntent: 'product_interpretation', domains: ['inventory', 'forecast'],
      skills: [I, 'get_product_forecast'], tasks: [{ skillId: I, agent: 'inventory', args: {} }, { skillId: 'get_product_forecast', agent: 'forecast', args: {} }] },
    run: async (_agent, skillId) => skillId === I ? { status: 'READY', metadata: { asOf: binding.operationalDate },
      data: { items: [{ sku: 'BEB-GAS-001', productName: 'Coca-Cola', stock: { onHand: 21 } }] } }
      : { status: 'READY', metadata: { asOf: binding.operationalDate }, data: { items: [{ sku: 'BEB-GAS-001', status: 'MODEL_UNAVAILABLE' }] } },
    execution: { hasGroundedProvider: () => true, generateGrounded: async () => ({ text: output(), provider: 'deepseek', model: 'offline' }), recordGroundedSynthesis() {} } });
  assert.match(response.answer, /No hay pronóstico disponible/);
});

for (const options of [{ text: output('Coca-Cola tiene stock 999.') }, { fail: true }, { truncated: true }, { text: '{invalid' }])
  test(`A6.2 provider/grounding failure returns facts without retries: ${JSON.stringify(options)}`, async () => {
    const f = setup(options); await f.run('stock de BEB-GAS-001');
    const result = await f.run('qué te preocupa de este producto?');
    assert.equal(result.usage.totalLlmCalls, 1); assert.equal(f.requests.length, 1);
    assert.equal(result.groundedAnswer.accepted, false); assert.match(result.answer, /hechos obtenidos/);
    assert.doesNotMatch(result.answer, /999|offline simulated/); assert.equal(f.prepared.length, 0);
  });

test('A6.2 open analysis cannot reuse a foreign-context identity or fan out to unrelated domains', async () => {
  const f = setup(); const missing = await f.run('qué te preocupa de este producto?');
  assert.equal(missing.requiresClarification, true); assert.equal(f.requests.length, 0);
  const plan = routeV3('qué conclusión sacas de este cliente?', {}, binding);
  assert.ok(plan.clarificationQuestion);
  const excessive = await f.run('stock de BEB-GAS-001 y cuánto vendimos este mes y cómo están mis proveedores');
  assert.equal(excessive.requiresClarification, true); assert.equal(excessive.usage.totalSkillCalls, 0);
  const open = await f.run('qué harías con ventas inventario y pronóstico de BEB-GAS-001?');
  assert.equal(open.requiresClarification, true); assert.equal(open.usage.totalSkillCalls, 0);
  await f.run('stock de BEB-GAS-001');
  const saved = await f.snapshot(), foreign = setup();
  await foreign.actions.restoreContext(foreign.request, foreign.conversationId,
    { ...saved, v3Context: { ...saved.v3Context, binding: 'f'.repeat(64) } });
  const denied = await foreign.run('qué te preocupa de este producto?');
  assert.equal(denied.requiresClarification, true); assert.equal(foreign.requests.length, 0);
  assert.equal(denied.usage.totalSkillCalls, 0);
});

test('A6.2 uncommon interpretation uses at most one existing NLU plus one grounded synthesis with separate paid usage', async () => {
  const f = setup({ nlu: true });
  const result = await f.run('dada la disponibilidad y la salida orientame sobre BEB-GAS-001');
  assert.equal(result.requiresClarification, false, result.answer);
  assert.equal(result.semanticClassification.accepted, true); assert.equal(result.groundedAnswer.accepted, true);
  assert.deepEqual(f.requests.map(row => row.max_tokens), [300, 500]); // existing provider cap
  assert.equal(result.usage.totalLlmCalls, 2); assert.equal(result.usage.totalTokens, 960);
  assert.equal(f.prepared.length, 0); assert.equal(f.mutations.length, 0);
});

test('A6.2 questioning an existing prediction explains verified evidence, not Sales or a new inference', async () => {
  const f = setup(); await f.run('pronóstico de BEB-GAS-001 en 14 días');
  const before = f.calls.length;
  const result = await f.run('esa prediccion la inventaste?');
  assert.equal(result.intent, 'explain_previous'); assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(f.calls.length, before); assert.match(result.answer, /hechos.*consulta anterior/);
  assert.match(result.answer, /Ridge LIVE/); assert.match(result.answer, /55.5/);
});

test('A6.2 normal context chain retains product through forecast, replenishment and procurement', async () => {
  const f = setup(); await f.run('cuánto stock tengo de coca cola?'); await f.run('BEB-GAS-001');
  const forecast = await f.run('y cuánto venderé de esta en dos semanas?');
  assert.equal(forecast.usage.totalLlmCalls, 0); assert.equal(f.calls.at(-1).payload.horizonDays, 14);
  const replenish = await f.run('necesito comprar más?');
  assert.equal(replenish.usage.totalLlmCalls, 0); assert.equal(f.calls.at(-1).domain, 'inventory');
  assert.deepEqual(f.calls.at(-1).payload.skus, ['BEB-GAS-001']);
  const suppliers = await f.run('quién me la provee?');
  assert.equal(suppliers.usage.totalLlmCalls, 0); assert.equal(f.calls.at(-1).domain, 'suppliers');
  assert.deepEqual(f.calls.at(-1).payload.productSkus, ['BEB-GAS-001']);
});
