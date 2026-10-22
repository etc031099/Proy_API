'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleGrounded } = require('../src/agents/grounded');
const { buildGroundedPlan } = require('../src/agents/groundedRouting');
const { createAgentExecution } = require('../src/agents/execution');
const { createAgentRequestContext } = require('../src/agents/contracts');
const { configuredGroundedProvider } = require('../src/agents/providers/selection');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const { V3 } = require('../src/services/v3IntelligenceService');
const I = 'get_inventory_intelligence';
const binding = { ...V3, operationalDate: '2026-10-21' };
const question = 'qué harías con esta coca cola?';
const scope = { selectedProduct: { key: 'BEB-GAS-001' } };
const inventory = { status: 'PARTIAL', metadata: { asOf: binding.operationalDate, dataMode: 'LIVE' }, data: {
  availabilityStatus: 'PARTIAL', items: [{ sku: 'BEB-GAS-001', productName: 'Coca-Cola Sabor Original 500 ml',
    stock: { onHand: 13, incoming: 0 }, coverage: { daysCover: 1.67 }, risk: { level: 'HIGH' },
    recommendation: { recommendedQty: 102, shouldReorder: true } }] } };
const forecast = { status: 'READY', metadata: { asOf: binding.operationalDate, dataMode: 'LIVE' }, data: {
  method: 'RIDGE_REGRESSION', horizonDays: 7, items: [{ sku: 'BEB-GAS-001', status: 'READY', horizonDays: 7,
    predictionUnits: 55.36, activeModelStatus: 'ACTIVE', modelVersion: 1, featureVersion: 'RIDGE_CAUSAL27_V1' }] } };
const valid = (stock = 13) => JSON.stringify({ observations: [{ evidenceRefs: ['E1', 'E2'],
  interpretation: `Coca-Cola tiene stock ${stock} y cobertura de 1.67 días.`,
  advisoryRecommendation: 'Revisa la reposición sugerida de 102 antes de decidir; no se ejecutó una compra.' }], limitations: [] });
async function run({ available = true, failing = false, generated = valid(), inv = inventory, fc = forecast } = {}) {
  let calls = 0, accepted;
  const response = await handleGrounded({ message: question, context: {}, resolvedPlan: buildGroundedPlan(question, binding, scope),
    resolvedBinding: binding, run: async (_agent, skill) => structuredClone(skill === I ? inv : fc),
    execution: { hasGroundedProvider: () => available,
      groundedProviderAvailability: () => ({ providerConfigured: available, groundedGenerationEnabled: available }),
      async generateGrounded(input) {
        calls++;
        const compact = JSON.parse(input.messages[1].content);
        assert.equal(compact.evidence[0].status, 'PARTIAL');
        assert.equal(compact.evidence[0].facts.items[0].stock.onHand, inv.data.items[0].stock.onHand);
        assert.ok(compact.allowedLimitations.some(row => row.code === 'ANALYTICS_PARTIAL'));
        if (failing) throw Object.assign(new Error('simulated unavailable provider'), { code: 'AGENT_PROVIDER_FAILED' });
        return { text: generated, provider: 'deepseek', model: 'offline' };
      }, recordGroundedSynthesis(value) { accepted = value; } } });
  return { response, calls, accepted };
}

test('A6.2.1 exact cloud PARTIAL inventory remains partial but supplies enough known evidence for one synthesis', async () => {
  const { response, calls, accepted } = await run();
  assert.equal(calls, 1); assert.equal(accepted, true);
  assert.deepEqual(response.grounded.generation, { required: true, providerConfigured: true, groundedGenerationEnabled: true,
    attempted: true, status: 'SUCCEEDED', reason: null });
  assert.match(response.answer, /13/); assert.match(response.answer, /102/);
  assert.match(response.answer, /información analítica.*parcial/);
  assert.doesNotMatch(response.answer, /No hay datos suficientes para una interpretación completa/);
});

for (const field of ['stock', 'coverage', 'risk', 'recommendation'])
  test(`A6.2.1 missing ${field} never becomes zero or authorizes partial synthesis`, async () => {
    const inv = structuredClone(inventory); delete inv.data.items[0][field];
    const { response, calls } = await run({ inv });
    assert.equal(calls, 0); assert.equal(response.grounded.generation.required, true);
    assert.equal(response.grounded.generation.reason, 'INSUFFICIENT_EVIDENCE');
  });

test('A6.2.1 forecast unavailable blocks a complete product interpretation without inventing missing evidence', async () => {
  const { response, calls } = await run({ fc: { ...forecast, status: 'NO_DATA', data: { items: [] } } });
  assert.equal(calls, 0); assert.equal(response.grounded.generation.reason, 'INSUFFICIENT_EVIDENCE');
});

test('A6.2.1 provider absent is distinct from synthesis not required', async () => {
  const { response, calls } = await run({ available: false });
  assert.equal(calls, 0); assert.equal(response.grounded.generation.required, true);
  assert.equal(response.grounded.generation.reason, 'PROVIDER_UNAVAILABLE');
  assert.equal(response.grounded.generation.providerConfigured, false);
  assert.match(response.answer, /proveedor no está habilitado o configurado/);
});

test('A6.2.1 failed provider is an attempted synthesis, not a successful generation', async () => {
  const { response, calls, accepted } = await run({ failing: true });
  assert.equal(calls, 1); assert.equal(accepted, false);
  assert.equal(response.grounded.generation.attempted, true);
  assert.equal(response.grounded.generation.status, 'FAILED');
  assert.equal(response.grounded.generation.reason, 'PROVIDER_FAILED');
  assert.match(response.answer, /hechos obtenidos/);
});

test('A6.2.1 invented number still rejects the entire generation and uses factual fallback', async () => {
  const { response, calls, accepted } = await run({ generated: valid(999) });
  assert.equal(calls, 1); assert.equal(accepted, false);
  assert.equal(response.grounded.generation.status, 'REJECTED');
  assert.equal(response.grounded.generation.reason, 'GROUNDING_REJECTED');
  assert.doesNotMatch(response.answer, /999/);
});

test('A6.2.1 natural concern wording routes to scoped Inventory + Forecast instead of a product card', () => {
  const q = 'según los datos que tienes de coca cola, explícame en palabras simples si debería preocuparme por este producto y por qué';
  const plan = buildGroundedPlan(q, binding);
  assert.equal(plan.responseMode, 'grounded-product');
  assert.deepEqual(plan.tasks.map(row => row.agent), ['inventory', 'forecast']);
  assert.deepEqual(plan.tasks.map(row => row.args.productRef), ['coca cola', 'coca cola']);
});

test('A6.2.1 safe generation diagnostics survive the same response/history projection without secrets', async () => {
  const { response } = await run();
  const projected = publicResponse({ ...response, grounded: { ...response.grounded,
    generation: { ...response.grounded.generation, secret: 'never-return-this' } } });
  assert.deepEqual(projected.grounded.generation, response.grounded.generation);
  assert.doesNotMatch(JSON.stringify(projected), /never-return-this/);
});

for (const [env, configured, enabled] of [
  [{}, false, false], [{ AGENT_ENABLED: 'false', LLM_PROVIDER: 'deepseek' }, false, false],
  [{ AGENT_ENABLED: 'true', LLM_PROVIDER: 'deepseek' }, false, true],
  [{ AGENT_ENABLED: 'true', LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'fictional-secret' }, true, true]
]) test(`A6.2.1 production provider factory (no HTTP) exposes only configuration presence: configured=${configured}, enabled=${enabled}`, () => {
  const provider = configuredGroundedProvider(env);
  const context = createAgentRequestContext({ businessId: V3.businessId,
    user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, role: 'user', isActive: true } });
  const execution = createAgentExecution({ context, neutralProvider: provider });
  const status = execution.groundedProviderAvailability();
  assert.deepEqual(status, { providerConfigured: configured, groundedGenerationEnabled: enabled });
  assert.doesNotMatch(JSON.stringify(status), /fictional-secret|api.key/i);
  assert.equal(execution.getUsage().totalLlmCalls, 0); execution.finish();
});
