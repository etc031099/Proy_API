'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAgentOrchestrator } = require('../src/agents/orchestrator');
const { createConversationMemory } = require('../src/agents/memory');
const { classifyGrounded, buildGroundedPlan } = require('../src/agents/groundedRouting');
const { isOutOfDomain } = require('../src/agents/domainGate');
const { buildGroundedContext, contextMetrics, validateGroundedOutput, MAX_CONTEXT_BYTES } = require('../src/agents/groundedContext');
const { createNeutralProvider, estimateCostUsd } = require('../src/agents/providers/neutralProvider');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const { V3 } = require('../src/services/v3IntelligenceService');
const B = 'get_business_analytics', I = 'get_inventory_intelligence', F = 'get_product_forecast';
const C = 'get_customer_intelligence', S = 'get_supplier_intelligence', M = 'get_cross_sell_recommendations', H = 'get_business_health';
const binding = { ...V3, operationalDate: '2026-10-15' };
const req = { businessId: V3.businessId, user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, role: 'user', isActive: true } };
const cases = [
  ['Analiza ventas, inventario y forecast y dime qué debería priorizar.', [B, I, F]],
  ['¿Qué productos recomiendas reponer esta semana y por qué?', [I, F, S]],
  ['¿Qué productos tienen buen potencial pero riesgo de quiebre?', [B, I, F]],
  ['¿Qué estrategia recomendarías según mis ventas y margen?', [B]],
  ['Resume el estado del negocio como si se lo explicaras al dueño.', [H]],
  ['¿Qué clientes debería intentar retener primero?', [C]],
  ['¿Qué conclusiones importantes ves en mis datos?', [H]],
  ['¿Qué debería mejorar primero?', [H]],
  ['¿Qué decisiones tomarías para mañana?', [H, I, F]],
  ['Según ventas, stock, forecast y proveedores, ¿qué debería comprar?', [B, I, F, S]],
  ['¿Qué producto vende bien pero tiene poco stock?', [B, I]],
  ['¿Hay algo preocupante en mi negocio?', [H]],
  ['¿Qué productos nuevos debería comprar?', [B, M, I]],
  ['¿Qué promoción convendría lanzar considerando margen y demanda?', [B, F, M, I]]
];
const contextBytes = [];
test.after(() => console.log('J2A_CONTEXT_BYTES', JSON.stringify({ min: Math.min(...contextBytes), max: Math.max(...contextBytes), samples: contextBytes.length })));
const outOfDomain = ['¿Quién ganó el partido ayer?', '¿Cuál es la capital de Francia?', 'Cuéntame un cuento.',
  '¿Qué laptop me recomiendas?', '¿Cuánto cuesta Bitcoin?', '¿Quién es el presidente de X?', '¿Cómo escribo un currículum?'];
const inventory = { sku: 'PAN-FRE-001', productName: 'Pan francés', stock: { onHand: 21, incoming: 10 },
  inventoryPolicy: { configuredMinimumStock: 5 }, coverage: { daysCover: 2.2 }, risk: { level: 'CRITICAL', reasonCodes: ['STOCKOUT_RISK'] },
  recommendation: { recommendedQty: 9, shouldReorder: true }, supplier: { preferredSupplierCode: 'SUP-05' } };
const kpis = { revenueCents: 50000, unitsSold: 100, ticketCount: 20, averageTicket: 25, grossMarginPct: null };
const dataFor = (skill, args) => skill === I ? { items: [structuredClone(inventory)], total: 1 }
  : skill === F ? args.mode === 'evaluation' ? { selectedOperationalMethod: { algorithm: 'MOVING_AVERAGE_28' }, modelEvaluation: [] }
    : { items: [{ sku: 'PAN-FRE-001', productName: 'Pan francés', status: 'READY', expectedUnitsNext1d: 2.32, expectedUnitsNext7d: 16.25, expectedUnitsNext14d: 32.5 }], total: 1 }
  : skill === B ? args.mode === 'rank' ? { items: [{ sku: 'PAN-FRE-001', name: 'Pan francés', categoryCode: 'PAN', metric: 100 }], total: 1 } : { kpis }
  : skill === C ? args.mode === 'clustering' ? { algorithm: 'KMeans', k: 4, sampleCount: 38, clusters: [], metrics: {} }
    : { items: [{ customerCode: 'CLI-001', displayName: 'Cliente ficticio', segment: args.segment || 'AT_RISK', lastPurchaseDate: '2026-10-10',
      ticketCount: 10, totalSpentCents: 12345, averageTicketCents: 1234.5, rfm90d: { raw: { recencyDays: 5, frequency90d: 4, monetary90dCents: 12345 } } }], total: 1 }
  : skill === S ? { items: [{ supplierCode: 'SUP-05', displayName: 'Proveedor ficticio', pendingOrderCount: 29,
    purchaseOrderCount: 22, receivedSpendCents: 67890, leadTime: { averageDays: 4, sampleSize: 20 }, punctuality: { onTimeRatePct: 80 }, productsSupplied: [] }], total: 1 }
  : skill === M ? { available: true, items: [{ recommendedSku: 'BEB-GAS-003', recommendedProduct: 'Inca Kola 500 ml', support: .08, confidence: .3, lift: 2, ticketCount: 100, stability: 'STABLE' }] }
  : { businessHealth: { sales: { kpis }, customers: { atRiskCount: 3 }, inventory: { critical: 5 }, suppliers: { summary: { suppliers: 10 } }, marketBasket: { stableCrossSellRuleCount: 33, freshness: { mode: 'HISTORICAL', analysisCutoff: V3.historicalCutoff } } }, alerts: [] };

function fixture({ neutralProvider, failSkill, status = 'READY', businessId = V3.businessId } = {}) {
  const calls = [], resolutions = [];
  let providerCalls = 0;
  const service = {
    async resolveContext(context) { return context.businessId === V3.businessId ? binding : null; },
    async resolveEntity(type, query) { resolutions.push({ type, query }); return { entity: { type, id: '507f1f77bcf86cd799439012', key: query, label: 'Pan francés' } }; },
    async execute({ skill, args, context }) {
      assert.equal(context.businessId, V3.businessId);
      if (skill.id === failSkill) throw new Error('simulated unavailable domain');
      const result = { status, data: dataFor(skill.id, args), metadata: { returnedCount: 1, totalMatches: 1,
        asOf: '2026-10-15', dataMode: 'LIVE', dataVersion: '4', snapshotHash: 'a'.repeat(64), selected: {},
        source: 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT', ...(args.startDate ? { period: { startDate: args.startDate, endDate: args.endDate } } : {}),
        ...(skill.id === M ? { asOf: V3.historicalCutoff, dataMode: 'HISTORICAL', freshness: 'FROZEN_HISTORICAL', frozenCutoff: V3.historicalCutoff } : {}) } };
      calls.push({ skillId: skill.id, args, result }); return result;
    }
  };
  const runtime = createAgentOrchestrator({ memory: createConversationMemory(), neutralProvider,
    clock: () => new Date('2026-10-15T17:00:00Z'), dependencies: { models: {}, v3Service: service },
    provider: { async generateStructured() { providerCalls++; assert.fail('No real/generic LLM permitted'); },
      async generateWithTools() { providerCalls++; assert.fail('No LLM tool selection permitted'); } } });
  const request = { ...req, businessId, user: { ...req.user, businessId } };
  return { runtime, request, calls, resolutions, providerCalls: () => providerCalls,
    run: (message, conversationId = randomUUID()) => runtime.handle(request, { message, conversationId }) };
}

const zero = result => {
  assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(result.usage.provider, 'none');
  assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.usage.estimatedCostUsd, 0);
};
for (const message of outOfDomain) test(`J2A OOD before all provider, lookup and skills: ${message}`, async () => {
  const f = fixture(), result = await f.run(message);
  assert.equal(result.intent, 'out_of_domain'); zero(result);
  assert.equal(f.providerCalls(), 0); assert.equal(f.calls.length, 0); assert.equal(f.resolutions.length, 0);
  assert.equal(result.usage.totalSkillCalls, 0); assert.match(result.answer, /negocio/);
});

for (const [message, skills] of cases) test(`J2A grounded plan -> skills -> compact context: ${message}`, async () => {
  const plan = buildGroundedPlan(message, binding);
  assert.equal(plan.route, 'GROUNDED_LLM'); assert.deepEqual(plan.skills, skills);
  const f = fixture(), result = await f.run(message);
  assert.equal(result.code, null); assert.deepEqual(f.calls.map(row => row.skillId), skills); zero(result);
  assert.equal(result.grounded.route, 'GROUNDED_LLM');
  const compact = buildGroundedContext({ question: message, plan, binding, results: f.calls });
  assert.deepEqual(compact.evidence.map(row => row.skillId), skills);
  assert.ok(contextMetrics(compact).bytes <= MAX_CONTEXT_BYTES);
  contextBytes.push(contextMetrics(compact).bytes);
  assert.ok(compact.evidence.every(row => row.facts !== null || row.omission === 'NO_CANDIDATE_SUPPLIER_EVIDENCE'),
    'only an explicitly unrelated supplier may be omitted from these fixtures');
});

test('J2A near-domain examples and product prices are not blocked', () => {
  for (const query of ['precio de Sprite', 'precio del pan', 'cuánto cuesta este producto', 'precio de Coca-Cola',
    'mejorar ventas', 'priorizar inventario', 'retener clientes', 'explicar WAPE', 'explicar K-Means', 'explicar forecast',
    'analizar el negocio', 'precio del producto Bitcoin', 'cuánto stock tengo de laptop']) assert.equal(isOutOfDomain(query), false, query);
});

test('J2A inventory prioritization is not sales-only; retention uses explicit AT_RISK, never spend as churn', async () => {
  const f = fixture(), result = await f.run('¿Qué debería priorizar en inventario?');
  assert.deepEqual(result.grounded.skills, [I, F, S]); assert.ok(f.calls.every(row => row.skillId !== B));
  const c = fixture(), retained = await c.run('¿Qué clientes debería intentar retener?');
  assert.equal(c.calls[0].args.segment, 'AT_RISK'); assert.equal(c.calls[0].args.metric, 'recency');
  assert.match(retained.answer, /señales distintas/); assert.match(retained.answer, /no hay una probabilidad/);
});

for (const query of ['¿Cuánto stock tiene PAN-FRE-001?', 'Dime mis ventas de 7 días', 'Pronóstico de PAN-FRE-001 para 7 días',
  '¿Cuáles son mis clientes de alto valor?', '¿Qué proveedores tienen pedidos pendientes?']) test(`J2A deterministic remains zero: ${query}`, async () => {
  const f = fixture(), result = await f.run(query); zero(result); assert.equal(result.code, null);
  assert.equal(result.grounded, undefined); assert.equal(f.providerCalls(), 0); assert.ok(f.calls.length > 0);
  if (/ventas/.test(query)) assert.equal((Date.parse(f.calls[0].args.endDate) - Date.parse(f.calls[0].args.startDate)) / 86400000 + 1, 7);
});

test('J2A ML concepts keep approved deterministic explanations', () => {
  for (const message of ['¿Qué significa WAPE en mi modelo?', '¿Por qué se eligieron 4 clusters?', '¿Por qué usan MA28 si evaluaron HGB?'])
    assert.equal(classifyGrounded(message).route, 'DETERMINISTIC');
  assert.equal(classifyGrounded('Interpreta qué implica WAPE para mis datos').route, 'GROUNDED_LLM');
  assert.equal(classifyGrounded('¿Qué proveedor recomiendas elegir?').route, 'GROUNDED_LLM');
});

test('J2A context privacy, exact null/minimum/risk/RFM fields, unrelated domains and size bounds', () => {
  const plan = buildGroundedPlan(cases[5][0], binding), row = { ...dataFor(C, {}), email: 'private@example.test', password: 'private' };
  row.items[0].phone = '999888777'; row.items[0].email = 'private@example.test';
  const compact = buildGroundedContext({ question: cases[5][0], plan, binding,
    results: [{ skillId: C, result: { status: 'READY', data: row, metadata: {} } }, { skillId: I, result: { status: 'READY', data: inventory } }] });
  const json = JSON.stringify(compact);
  assert.equal(compact.evidence.length, 1); assert.doesNotMatch(json, /private|999888777|PAN-FRE|email|password/);
  assert.equal(compact.evidence[0].facts.items[0].rfm90d.raw.recencyDays, 5);
  assert.ok(Object.isFrozen(compact.evidence[0].facts));
  const invPlan = buildGroundedPlan('¿Qué debería priorizar en inventario?', binding);
  const huge = buildGroundedContext({ question: 'x'.repeat(2000), plan: invPlan, binding,
    results: [{ skillId: I, result: { status: 'READY', data: { items: Array(80).fill(inventory) }, metadata: { returnedCount: 80 } } }] });
  assert.equal(huge.evidence[0].facts.items.length, 3);
  assert.equal(huge.evidence[0].facts.items[0].inventoryPolicy.configuredMinimumStock, 5);
  assert.equal(huge.evidence[0].facts.items[0].risk.level, 'CRITICAL');
  assert.ok(contextMetrics(huge).bytes <= MAX_CONTEXT_BYTES);
});

test('J2A projected evidence remains parseable, scoped to cutoff/revision and marks new products exploratory', async () => {
  const f = fixture(); await f.run(cases[12][0]);
  const plan = buildGroundedPlan(cases[12][0], binding);
  const compact = buildGroundedContext({ question: cases[12][0], plan, binding, results: f.calls });
  assert.equal(compact.noHistoricalSkuData, true);
  const basket = compact.evidence.find(row => row.skillId === M);
  assert.equal(basket.scope.mode, 'FROZEN'); assert.equal(basket.scope.frozenCutoff, '2026-10-12');
  assert.equal(compact.evidence.find(row => row.skillId === I).scope.dataVersion, '4');
  assert.equal(JSON.parse(JSON.stringify(compact)).contractVersion, 'grounded-v3-context-v1');
});

test('J2A oversize evidence is explicitly omitted as a whole object and null margins stay null', () => {
  let large = inventory;
  for (let depth = 0; depth < 6; depth++) large = { ...inventory, items: [large, large, large] };
  const plan = buildGroundedPlan(cases[0][0], binding);
  const compact = buildGroundedContext({ question: cases[0][0], plan, binding, results: [
    { skillId: B, result: { status: 'READY', data: { kpis }, metadata: {} } },
    { skillId: I, result: { status: 'READY', data: large, metadata: {} } }
  ] });
  assert.ok(contextMetrics(compact).bytes <= MAX_CONTEXT_BYTES);
  assert.equal(compact.evidence[0].facts.kpis.grossMarginPct, null);
  assert.equal(compact.evidence[1].omission, 'CONTEXT_BUDGET');
  assert.equal(compact.evidence[1].facts, null);
  assert.equal(compact.evidence[1].limited, true);
});

const responseFor = context => JSON.stringify({ observations: [{ evidenceRefs: [context.evidence[0].ref],
  interpretation: 'Los datos muestran actividad observada.', advisoryRecommendation: 'Revisa los hechos antes de decidir.' }], limitations: [] });
const mockedProvider = generate => createNeutralProvider({ provider: 'test-provider', model: 'test-model', generate });
test('J2A neutral provider gets only compact READ evidence, one generation and measured neutral usage', async () => {
  let calls = 0;
  const f = fixture({ neutralProvider: mockedProvider(async request => {
    calls++; assert.equal(request.maxTokens, 300); assert.equal(Object.hasOwn(request, 'tools'), false);
    const compact = JSON.parse(request.messages[1].content);
    assert.deepEqual(compact.evidence.map(row => row.skillId), [C]);
    return { text: responseFor(compact), usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 } };
  }) });
  const result = await f.run(cases[5][0]);
  assert.equal(calls, 1); assert.equal(result.usage.provider, 'test-provider');
  assert.equal(result.usage.llmCalls, 1); assert.equal(result.usage.inputTokens, 300);
  assert.equal(result.usage.totalTokens, 340); assert.equal(result.usage.estimatedCostUsd, null);
  assert.equal(result.usage.metricsComplete, true);
  assert.match(result.answer, /actividad observada/);
  assert.equal(publicResponse(result).usage.provider, 'test-provider');
});

test('J2A neutral transport cannot receive tools, credentials or an unbounded output request', async () => {
  let calls = 0;
  const provider = mockedProvider(async () => { calls++; return { text: '{}' }; });
  const request = { messages: [{ role: 'user', content: 'fixture' }], maxTokens: 300, temperature: 0 };
  for (const extra of [{ tools: [{ name: 'create_sale' }] }, { apiKey: 'fictional' }, { maxTokens: 100000 }])
    await assert.rejects(provider.generate({ ...request, ...extra }));
  assert.equal(calls, 0);
});

for (const failure of ['401', '429', 'timeout', '5xx', 'malformed']) test(`J2A future-provider failure preserves facts with no WRITE: ${failure}`, async () => {
  let calls = 0;
  const neutral = createNeutralProvider({ provider: 'test-provider', model: 'test-model', timeoutMs: failure === 'timeout' ? 5 : 1000,
    generate: async () => { calls++; if (failure === 'timeout') return new Promise(() => {});
      if (failure === 'malformed') return { text: 'not json', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      throw Object.assign(new Error('private provider details'), { status: failure === '5xx' ? 503 : Number(failure) }); }
  });
  const f = fixture({ neutralProvider: neutral }), result = await f.run(cases[5][0]);
  assert.equal(calls, 1); assert.equal(result.usage.llmCalls, 1);
  assert.match(result.answer, /Cliente ficticio/); assert.match(result.answer, /conservan los hechos/);
  assert.equal(result.pendingAction, undefined); assert.doesNotMatch(result.answer, /private provider/);
  assert.equal(result.usage.estimatedCostUsd, null);
});

test('J2A missing later domain retains previous verified facts and never invokes synthesis', async () => {
  let calls = 0;
  const f = fixture({ failSkill: I, neutralProvider: mockedProvider(() => { calls++; assert.fail('incomplete context'); }) });
  const result = await f.run(cases[0][0]); zero(result);
  assert.equal(calls, 0); assert.match(result.answer, /Ventas/); assert.match(result.answer, /datos suficientes/);
});

test('J2A cost config is versioned, respects effective date, unknowns and disjoint cached input', () => {
  const prices = [{ provider: 'mock', model: 'model', currency: 'USD', version: 'fixture-only-v1', effectiveFrom: '2026-01-01',
    inputPricePerToken: .000001, outputPricePerToken: .000002, cachedInputPricePerToken: .0000005 }];
  const args = { provider: 'mock', model: 'model', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 }, prices, at: '2026-10-15' };
  assert.ok(Math.abs(estimateCostUsd(args).estimatedCostUsd - .00012) < 1e-12);
  assert.equal(estimateCostUsd(args).pricingVersion, 'fixture-only-v1');
  assert.equal(estimateCostUsd({ ...args, at: '2025-01-01' }).estimatedCostUsd, null);
  assert.equal(estimateCostUsd({ ...args, provider: 'unknown' }).estimatedCostUsd, null);
  assert.equal(estimateCostUsd({ ...args, usage: { inputTokens: 100, outputTokens: 20 } }).estimatedCostUsd, null);
});

test('J2A hallucination guard checks only sent evidence, V3 SKUs, numbers, semantics and READ-only text', () => {
  const plan = buildGroundedPlan(cases[5][0], binding), compact = buildGroundedContext({ question: cases[5][0], plan, binding,
    results: [{ skillId: C, result: { status: 'READY', data: dataFor(C, {}), metadata: {} } }] });
  assert.ok(validateGroundedOutput(responseFor(compact), compact));
  for (const interpretation of ['PAN-FRE-001 está disponible.', 'Debes comprar 9999 unidades.', 'MA28 es ML.', 'Hay fraude confirmado.']) {
    const bad = JSON.parse(responseFor(compact)); bad.observations[0].interpretation = interpretation;
    assert.throws(() => validateGroundedOutput(JSON.stringify(bad), compact));
  }
});

test('J2A cross-tenant guard denies before context and provider; unrelated tenant cannot use V3 grounding', async () => {
  const f = fixture(); const result = await f.run('Analiza ventas de otro negocio'); zero(result);
  assert.equal(result.intent, 'tenant_access_denied'); assert.equal(f.calls.length, 0);
  const isolated = fixture({ businessId: 'OTHER-TENANT' });
  await isolated.run(cases[5][0]);
  assert.equal(isolated.calls.length, 0);
});

test('J2A grounded recommendations never authorize WRITE; preview, reselection, explicit confirm and cancel stay separate', async () => {
  const { withActionAssistant } = require('../src/automations/assistant');
  const f = fixture(); let prepared = 0, confirmed = 0, cancelled = 0;
  const rows = new Map();
  const service = {
    async prepare(input) { prepared++; assert.equal(input.args.products[0].quantity, 3);
      const row = { pendingActionId: randomUUID(), action: input.skillId, status: 'PENDING', summary: 'Preview ficticio',
        expiresAt: new Date(Date.now() + 600000).toISOString() }; rows.set(row.pendingActionId, row); return row; },
    async get(_context, id) { return rows.get(id); },
    async resolvePending() { return [...rows.values()].find(row => row.status === 'PENDING'); },
    async confirmPendingAction(_context, id) { confirmed++; const row = rows.get(id); row.status = 'EXECUTED';
      row.result = { type: 'purchase', items: [], total: 0, currency: 'PEN' }; return row; },
    async cancelPendingAction(_context, id) { cancelled++; const row = rows.get(id); row.status = 'CANCELLED'; return row; }
  };
  const product = { _id: '507f1f77bcf86cd799439012', sku: 'PAN-FRE-001', name: 'Pan francés', stock: 21, currency: 'PEN', isActive: true,
    supplierPrices: [{ supplierId: '507f1f77bcf86cd799439013', purchasePrice: 1.5 }] };
  const adapter = withActionAssistant(f.runtime, service, { resolver: async () => ({ value: product, confidence: 'EXACT' }),
    supplierLookup: async () => [{ _id: '507f1f77bcf86cd799439013', name: 'Proveedor ficticio', isActive: true }] });
  const conversationId = randomUUID(), send = message => adapter.handle(f.request, { message, conversationId });
  const recommendation = await send(cases[9][0]); zero(recommendation); assert.equal(prepared, 0);
  const hazlo = await send('hazlo'); zero(hazlo); assert.equal(confirmed, 0); assert.equal(prepared, 0);
  const preview = await send('Prepara una compra de 3 unidades de PAN-FRE-001.');
  assert.equal(preview.pendingAction.status, 'PENDING'); zero(preview); assert.equal(confirmed, 0);
  await send(cases[5][0]); // a grounded READ must not authorize the older pending purchase
  const reviewed = await send('hazlo'); assert.equal(confirmed, 0); assert.equal(reviewed.pendingAction.status, 'PENDING');
  const cancelledResponse = await send('cancela'); assert.equal(cancelledResponse.pendingAction.status, 'CANCELLED');
  assert.equal(cancelled, 1); assert.equal(confirmed, 0);
  await send('Prepara una compra de 3 unidades de PAN-FRE-001.');
  const confirmedResponse = await send('confirmo'); assert.equal(confirmedResponse.pendingAction.status, 'EXECUTED');
  assert.equal(confirmed, 1); // mock executor only, no commercial operation
});
