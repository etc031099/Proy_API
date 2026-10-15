'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDeepSeekProvider, readDeepSeekConfig, normalizeDeepSeekUsage } = require('../src/agents/providers/deepseekProvider');
const { configuredGroundedProvider, selectedProvider } = require('../src/agents/providers/selection');
const { estimateCostUsd } = require('../src/agents/providers/neutralProvider');
const { DEEPSEEK_PRICES } = require('../src/config/deepseekPricing');
const { validateEnvironment } = require('../src/config/env');
const { createAgentOrchestrator } = require('../src/agents/orchestrator');
const { createConversationMemory } = require('../src/agents/memory');
const { createAgentExecution } = require('../src/agents/execution');
const { createAgentRequestContext } = require('../src/agents/contracts');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const { V3 } = require('../src/services/v3IntelligenceService');
const env = { DEEPSEEK_API_KEY: 'fictional-test-key-only' };
const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
  prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600,
  prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 0 } };
const output = JSON.stringify({ observations: [{ evidenceRefs: ['E1'], interpretation: 'Los datos permiten revisar las prioridades.',
  advisoryRecommendation: 'Revisa estos hechos antes de decidir.' }], limitations: [] });
const envelope = (patch = {}) => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop',
  message: { role: 'assistant', content: output, reasoning_content: 'PRIVATE-REASONING-DO-NOT-RETAIN' } }], usage, ...patch });
const request = { route: 'GROUNDED_LLM', messages: [{ role: 'system', content: 'Devuelve JSON en español.' },
  { role: 'user', content: '{}' }], maxTokens: 300, temperature: 0 };
const reply = data => ({ ok: true, status: 200, json: async () => data });
const providerFor = (fetchImpl, extra = {}) => createDeepSeekProvider({ env, fetchImpl, ...extra });
const req = { businessId: V3.businessId, user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, role: 'user', isActive: true } };
const binding = { ...V3, operationalDate: '2026-10-15' };
const B = 'get_business_analytics', I = 'get_inventory_intelligence', F = 'get_product_forecast', S = 'get_supplier_intelligence', C = 'get_customer_intelligence';
const inv = { sku: 'PAN-FRE-001', productName: 'Pan francés', stock: { onHand: 21, incoming: 10 },
  inventoryPolicy: { configuredMinimumStock: 5 }, risk: { level: 'CRITICAL' }, recommendation: { shouldReorder: true, recommendedQty: 9 } };
const kpis = { revenueCents: 50000, unitsSold: 100, ticketCount: 20, averageTicket: 25, grossMarginPct: null };
const dataFor = (skill, args) => skill === I ? { items: [inv], total: 1 }
  : skill === B ? args.mode === 'rank' ? { items: [{ categoryCode: 'PAN', metric: 100 }], total: 1 } : { kpis }
  : skill === F ? { items: [{ sku: inv.sku, productName: inv.productName, status: 'READY', expectedUnitsNext7d: 16.25 }], total: 1 }
  : skill === C ? { items: [{ customerCode: 'CLI-001', displayName: 'Cliente ficticio', segment: args.segment || 'AT_RISK',
    lastPurchaseDate: '2026-10-10', ticketCount: 10, totalSpentCents: 12345, rfm90d: { raw: { recencyDays: 5, frequency90d: 4, monetary90dCents: 12345 } } }], total: 1 }
  : skill === S ? { items: [{ supplierCode: 'SUP-05', displayName: 'Proveedor ficticio', pendingOrderCount: 29 }], total: 1 }
  : skill === 'get_business_health' ? { businessHealth: { sales: { kpis }, inventory: { critical: 5 }, customers: { atRiskCount: 3 } }, alerts: [] }
  : { available: true, items: [] };

function fixture({ fetchImpl = async () => reply(envelope()), providerEnv = env } = {}) {
  const calls = [], requests = [], events = [];
  const service = { async resolveContext() { return binding; },
    async resolveEntity(_type, query) { return { entity: { type: 'product', id: '507f1f77bcf86cd799439012', key: query, label: inv.productName } }; },
    async execute({ skill, args }) {
      assert.ok(require('../src/agents/v3Skills').V3_SKILLS[skill.id]);
      calls.push({ skill: skill.id, args });
      return { status: 'READY', data: dataFor(skill.id, args), metadata: { returnedCount: 1, totalMatches: 1, asOf: binding.operationalDate,
        dataMode: 'LIVE', dataVersion: '0', snapshotHash: 'a'.repeat(64), source: 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT' } };
    } };
  const neutralProvider = createDeepSeekProvider({ env: providerEnv, fetchImpl: async (url, options) => {
    requests.push(JSON.parse(options.body)); return fetchImpl(url, options);
  } });
  const runtime = createAgentOrchestrator({ neutralProvider, memory: createConversationMemory(),
    clock: () => new Date('2026-10-15T17:00:00Z'), dependencies: { models: {}, v3Service: service }, onEvent: event => events.push(event),
    provider: { async generateStructured() { assert.fail('Gemini fallback forbidden'); }, async generateWithTools() { assert.fail('Tool selection forbidden'); } } });
  return { runtime, calls, requests, events, run: message => runtime.handle(req, { message, conversationId: randomUUID() }) };
}

test('J2B official transport: non-beta URL, JSON, thinking disabled, no tools, bounded output, final content only', async () => {
  const calls = [];
  const provider = providerFor(async (url, options) => { calls.push({ url, options }); return reply(envelope()); });
  const result = await provider.generate(request), body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.method, 'POST');
  assert.equal(body.model, 'deepseek-flash'); assert.equal(body.reasoning_effort, 'none'); assert.equal(body.max_tokens, 300);
  assert.equal(body.temperature, 0); assert.equal(body.stream, false); assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.tools, undefined); assert.equal(body.thinking, undefined);
  assert.equal(result.text, output); assert.equal(result.provider, 'deepseek'); assert.equal(result.model, 'deepseek-flash');
  assert.deepEqual(result.usage, { inputTokens: 1000, outputTokens: 100, totalTokens: 1100,
    cachedInputTokens: 400, cacheMissInputTokens: 600, reasoningTokens: 0 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-REASONING|fictional-test-key|Authorization/);
  assert.ok(result.latencyMs >= 0); assert.equal(result.estimatedCostUsd, null);
  assert.ok(Math.abs(result.estimatedCostRangeUsd.min - 0.0001512) < 1e-12);
  assert.ok(Math.abs(result.estimatedCostRangeUsd.max - 0.0003024) < 1e-12);
});

test('J2B configured output can be lower than 300; rejects paid thinking, untrusted URLs, legacy model and oversized config', async () => {
  for (const patch of [{ DEEPSEEK_BASE_URL: 'https://evil.example' }, { DEEPSEEK_BASE_URL: 'https://api.deepseek.com/beta' },
    { DEEPSEEK_BASE_URL: 'https://user:private@api.deepseek.com' }, { DEEPSEEK_MODEL: 'deepseek-chat' },
    { DEEPSEEK_REASONING_EFFORT: 'high' }, { DEEPSEEK_MAX_OUTPUT_TOKENS: '301' }]) assert.throws(() => readDeepSeekConfig(patch));
  let cap;
  await providerFor(async (_url, options) => { cap = JSON.parse(options.body).max_tokens; return reply(envelope()); },
    { env: { ...env, DEEPSEEK_MAX_OUTPUT_TOKENS: '200' } }).generate(request);
  assert.equal(cap, 200);
  assert.equal(readDeepSeekConfig({ DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1' }).endpoint, 'https://api.deepseek.com/v1/chat/completions');
});

test('J2B request must explicitly be GROUNDED_LLM and cannot carry tools or credentials', async () => {
  let calls = 0;
  const provider = providerFor(async () => { calls++; return reply(envelope()); });
  for (const patch of [{ route: undefined }, { route: 'DETERMINISTIC' }, { route: 'OUT_OF_DOMAIN' },
    { tools: [{ name: 'create_sale' }] }, { apiKey: 'fake' }, { maxTokens: 301 },
    { messages: [{ role: 'user', content: 'fixture', apiKey: 'fake' }] }]) await assert.rejects(provider.generate({ ...request, ...patch }));
  assert.equal(calls, 0);
});

test('J2B usage never invents missing fields and preserves cache detail', () => {
  assert.equal(normalizeDeepSeekUsage().inputTokens, null);
  assert.equal(normalizeDeepSeekUsage({ prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 }).cachedInputTokens, null);
  assert.equal(normalizeDeepSeekUsage({ prompt_tokens_details: { cached_tokens: 5 } }).cachedInputTokens, 5);
  assert.throws(() => normalizeDeepSeekUsage({ ...usage, prompt_cache_miss_tokens: 601 }));
  assert.throws(() => normalizeDeepSeekUsage({ ...usage, total_tokens: 1101 }));
});

test('J2B pricing is versioned, cache is disjoint, unknown models/breakdown remain unknown', () => {
  const args = { provider: 'deepseek', model: 'deepseek-flash', prices: DEEPSEEK_PRICES, at: '2026-10-15', usage: normalizeDeepSeekUsage(usage) };
  assert.equal(estimateCostUsd(args).pricingVersion, 'deepseek-flash-2026-10-15');
  for (const change of [{ at: '2026-01-01' }, { model: 'deepseek-v4-pro' }, { usage: { inputTokens: 1000, outputTokens: 100 } }]) {
    const price = estimateCostUsd({ ...args, ...change }); assert.equal(price.estimatedCostUsd, null); assert.equal(price.estimatedCostRangeUsd, undefined);
  }
  const empty = estimateCostUsd({ ...args, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheMissInputTokens: 0 } });
  assert.deepEqual(empty.estimatedCostRangeUsd, { min: 0, max: 0 });
});

const groundedCases = [
  ['Analiza ventas, inventario y forecast y dime qué debería priorizar.', [B, I, F]],
  ['¿Qué clientes debería intentar retener?', [C]],
  ['¿Qué productos debería reponer esta semana y por qué?', [I, F, S]],
  ['Resume el estado del negocio para el dueño.', ['get_business_health']],
  ['Según ventas, stock, forecast y proveedores, ¿qué debería comprar?', [B, I, F, S]],
  ['Resume el estado del negocio y dime qué priorizar.', ['get_business_health']]
];
for (const [message, skills] of groundedCases) test(`J2B grounded -> approved skills -> one DeepSeek call: ${message}`, async () => {
  const f = fixture(), result = await f.run(message);
  assert.equal(result.code, null); assert.deepEqual(f.calls.map(row => row.skill), skills); assert.equal(f.requests.length, 1);
  const body = f.requests[0], compact = JSON.parse(body.messages[1].content);
  assert.ok(Buffer.byteLength(body.messages[1].content) <= 6400); assert.match(body.messages[0].content, /español/);
  assert.deepEqual(compact.evidence.map(row => row.skillId), skills); assert.equal(body.max_tokens, 300);
  assert.equal(result.usage.provider, 'deepseek'); assert.equal(result.usage.llmCalls, 1); assert.equal(result.usage.totalTokens, 1100);
  assert.equal(result.usage.cacheMissInputTokens, 600); assert.equal(result.usage.cachedInputTokens, 400);
  assert.equal(result.usage.reasoningTokens, 0); assert.equal(result.usage.estimatedCostUsd, null);
  assert.ok(publicResponse(result).usage.estimatedCostRangeUsd.min > 0);
  assert.match(result.answer, /Los datos permiten/); assert.equal(result.pendingAction, undefined);
  assert.ok(f.events.some(row => row.type === 'synthesis_finished' && row.status === 'ACCEPTED'));
  assert.doesNotMatch(JSON.stringify(publicResponse(result)), /PRIVATE-REASONING|fictional-test-key|Authorization/);
  if (skills[0] === C) { assert.equal(f.calls[0].args.segment, 'AT_RISK'); assert.equal(f.calls[0].args.metric, 'recency'); }
});

for (const message of ['stock del pan', 'Dime mis ventas de 7 días', 'Pronóstico de Sprite para 14 días',
  '¿Cuáles son mis clientes de alto valor?', '¿Qué proveedores tienen pedidos pendientes?', 'Muéstrame productos con stock bajo',
  'Cuéntame un cuento', '¿Cuánto cuesta Bitcoin?', '¿Cuál es la capital de Francia?']) test(`J2B bypass costs zero: ${message}`, async () => {
  const f = fixture(), result = await f.run(message);
  assert.equal(f.requests.length, 0); assert.equal(result.usage.provider, 'none'); assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.usage.llmCalls, 0); assert.equal(result.usage.estimatedCostUsd, 0);
});

test('J2B new products carry exploratory constraint without validated new-SKU forecast', async () => {
  const f = fixture(), result = await f.run('¿Qué productos nuevos debería incorporar?');
  assert.equal(f.requests.length, 1);
  const compact = JSON.parse(f.requests[0].messages[1].content);
  assert.equal(compact.noHistoricalSkuData, true); assert.match(result.answer, /exploratoria/);
  assert.equal(f.calls.some(row => row.skill === F), false);
});

for (const failure of ['401', '429', '5xx', 'timeout', 'malformed', 'tool_call', 'length', 'bad_grounding']) test(`J2B failure preserves READ facts, no fallback/WRITE: ${failure}`, async () => {
  let aborted = false;
  const f = fixture({ providerEnv: { ...env, DEEPSEEK_TIMEOUT_MS: failure === 'timeout' ? '5' : '1000' },
    fetchImpl: async (_url, options) => {
      if (['401', '429', '5xx'].includes(failure)) return { ok: false, status: failure === '5xx' ? 503 : Number(failure), json() { assert.fail('Never read private error bodies'); } };
      if (failure === 'timeout') { options.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); }
      if (failure === 'malformed') return { ok: true, async json() { throw new Error('private body'); } };
      const response = envelope();
      if (failure === 'tool_call') response.choices[0].message.tool_calls = [{ function: { name: 'create_purchase' } }];
      if (failure === 'length') response.choices[0].finish_reason = 'length';
      if (failure === 'bad_grounding') response.choices[0].message.content = output.replace('Los datos permiten revisar las prioridades.', 'Hay 999999 clientes.');
      return reply(response);
    } });
  const result = await f.run(groundedCases[1][0]);
  assert.equal(f.requests.length, 1); assert.equal(result.usage.llmCalls, 1); assert.match(result.answer, /Cliente ficticio/);
  assert.match(result.answer, /conservan los hechos/); assert.equal(result.pendingAction, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fictional-test-key|PRIVATE-REASONING|private body/);
  assert.ok(f.events.some(row => row.type === 'synthesis_finished' && row.status === 'REJECTED'));
  if (failure === 'bad_grounding') assert.equal(result.usage.totalTokens, 1100);
  else { assert.equal(result.usage.totalTokens, null); assert.ok(result.usage.providerFailures.length); }
  if (failure === 'timeout') assert.equal(aborted, true);
});

test('J2B environment selector is opt-in, preserves Gemini defaults and validates selected credentials only', () => {
  assert.equal(selectedProvider({}), 'gemini'); assert.equal(configuredGroundedProvider({}), null);
  assert.equal(configuredGroundedProvider({ LLM_PROVIDER: 'deepseek', AGENT_ENABLED: 'false' }), null);
  assert.equal(configuredGroundedProvider({ LLM_PROVIDER: 'deepseek', AGENT_ENABLED: 'true', ...env }).provider, 'deepseek');
  const base = { NODE_ENV: 'test', MONGODB_URI: 'mongodb://localhost:27017/test', JWT_SECRET: 'a'.repeat(64),
    AGENT_ENABLED: 'true', LLM_PROVIDER: 'deepseek', ...env };
  assert.equal(validateEnvironment(base, { warn() {} }).llmProvider, 'deepseek');
  assert.equal(validateEnvironment({ ...base, LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'fictional-gemini-key' }, { warn() {} }).llmProvider, 'gemini');
  assert.throws(() => validateEnvironment({ ...base, LLM_PROVIDER: 'gemini' }, { warn() {} }), /GEMINI_API_KEY/);
  assert.throws(() => validateEnvironment({ ...base, DEEPSEEK_API_KEY: '' }, { warn() {} }), /DEEPSEEK_API_KEY/);
  assert.throws(() => validateEnvironment({ ...base, LLM_PROVIDER: 'other' }, { warn() {} }), /LLM_PROVIDER/);
});

test('J2B selected DeepSeek cannot fall back to default Gemini for generic classification', async () => {
  const before = process.env.LLM_PROVIDER;
  try {
    process.env.LLM_PROVIDER = 'deepseek';
    const context = createAgentRequestContext(req, { conversationId: randomUUID() });
    const execution = createAgentExecution({ context, neutralProvider: null, dependencies: { models: {} } });
    await assert.rejects(execution.generateStructured({ agentId: 'coordinator' }), error => error.code === 'AGENT_PROVIDER_FAILED');
    assert.equal(execution.getUsage().llmCalls, 0);
  } finally { if (before === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = before; }
});

test('J2B runtime environment wiring is lazy and uses DeepSeek only for grounded requests', async () => {
  const names = ['AGENT_ENABLED', 'LLM_PROVIDER', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL',
    'DEEPSEEK_REASONING_EFFORT', 'DEEPSEEK_MAX_OUTPUT_TOKENS', 'DEEPSEEK_TIMEOUT_MS'];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]])), originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    names.forEach(key => delete process.env[key]);
    Object.assign(process.env, { AGENT_ENABLED: 'true', LLM_PROVIDER: 'deepseek', ...env });
    globalThis.fetch = async () => { calls++; return reply(envelope()); };
    const runtime = createAgentOrchestrator({ memory: createConversationMemory(), dependencies: { models: {}, v3Service: {
      async resolveContext() { return binding; },
      async execute() { return { status: 'READY', data: dataFor(C, {}), metadata: { returnedCount: 1 } }; }
    } } });
    await runtime.handle(req, { message: 'Cuéntame un cuento' }); assert.equal(calls, 0);
    const result = await runtime.handle(req, { message: groundedCases[1][0] });
    assert.equal(calls, 1); assert.equal(result.usage.provider, 'deepseek'); assert.match(result.answer, /Los datos permiten/);
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach(key => { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; });
  }
});

test('J2B missing credentials and unknown usage stay controlled without manufactured zero consumption', async () => {
  let calls = 0;
  const noKey = providerFor(async () => { calls++; assert.fail('No key must not use network'); }, { env: {} });
  await assert.rejects(noKey.generate(request), error => error.failureKind === 'CONFIGURATION'); assert.equal(calls, 0);
  const f = fixture({ fetchImpl: async () => reply(envelope({ usage: undefined })) });
  const result = await f.run(groundedCases[1][0]);
  assert.equal(result.usage.totalTokens, null); assert.equal(result.usage.estimatedCostUsd, null);
  assert.equal(result.usage.estimatedCostRangeUsd, null); assert.equal(result.usage.metricsComplete, false);
});

test('J2B a successful DeepSeek recommendation cannot confirm a WRITE; explicit preview and cancel bypass DeepSeek', async () => {
  const { withActionAssistant } = require('../src/automations/assistant');
  const f = fixture(); let prepared = 0, confirmed = 0, cancelled = 0, row;
  const actionService = {
    async prepare(input) { prepared++; assert.equal(input.args.products[0].quantity, 3);
      row = { pendingActionId: randomUUID(), action: input.skillId, status: 'PENDING', summary: 'Preview ficticio',
        expiresAt: new Date(Date.now() + 600000).toISOString() }; return row; },
    async get() { return row; }, async resolvePending() { return row?.status === 'PENDING' ? row : undefined; },
    async confirmPendingAction() { confirmed++; assert.fail('This sequence never confirms'); },
    async cancelPendingAction() { cancelled++; row.status = 'CANCELLED'; return row; }
  };
  const adapter = withActionAssistant(f.runtime, actionService, {
    resolver: async () => ({ value: { _id: '507f1f77bcf86cd799439012', sku: inv.sku, name: inv.productName, stock: 21,
      currency: 'PEN', isActive: true, supplierPrices: [{ supplierId: '507f1f77bcf86cd799439013', purchasePrice: 1.5 }] }, confidence: 'EXACT' }),
    supplierLookup: async () => [{ _id: '507f1f77bcf86cd799439013', name: 'Proveedor ficticio', isActive: true }]
  });
  const conversationId = randomUUID(), send = message => adapter.handle(req, { message, conversationId });
  await send(groundedCases[4][0]); assert.equal(f.requests.length, 1); assert.equal(prepared, 0);
  await send('hazlo'); assert.equal(prepared, 0); assert.equal(confirmed, 0);
  const preview = await send('Prepara una compra de 3 unidades de PAN-FRE-001.');
  assert.equal(preview.pendingAction.status, 'PENDING'); assert.equal(prepared, 1);
  await send(groundedCases[1][0]); assert.equal(f.requests.length, 2);
  await send('hazlo'); assert.equal(confirmed, 0);
  const cancellation = await send('Mejor no, cancela.'); assert.equal(cancellation.pendingAction.status, 'CANCELLED');
  assert.equal(cancelled, 1); assert.equal(confirmed, 0); assert.equal(f.requests.length, 2);
});
