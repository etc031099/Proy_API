'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDeepSeekProvider } = require('../../src/agents/providers/deepseekProvider');
const { createAgentOrchestrator } = require('../../src/agents/orchestrator');
const { createConversationMemory } = require('../../src/agents/memory');
const { V3 } = require('../../src/services/v3IntelligenceService');
const { B, I, F, C, S, M, H } = require('../fixtures/j2nAcceptanceMatrix');
const binding = { ...V3, operationalDate: '2026-10-15' };
const products = [
  ['ABA-ACE-001', 'Aceite Vegetal Primor Premium 900 ml', 11, 0, 7.16, 'MEDIUM', 18, 10.75],
  ['ABA-ACE-002', 'Aceite Vegetal Cocinero 900 ml', 7, 0, 5.03, 'HIGH', 24, 9.75],
  ['ABA-ARR-001', 'Arroz Costeño Añejo Extra 750 g', 17, 57, 3.42, 'MEDIUM', 12, 34.75],
  ['PAN-FRE-001', 'Pan francés fresco paquete 4 unidades', 21, 0, 8.1, 'LOW', 5, 16.25]
].map(([sku, productName, stock, incoming, coverage, level, qty, forecast]) => ({ sku, productName,
  stock: { onHand: stock, incoming }, coverage: { daysCover: coverage }, risk: { level },
  inventoryPolicy: { configuredMinimumStock: 5 }, recommendation: { shouldReorder: true, recommendedQty: qty }, forecast }));
const kpis = { revenueCents: 500000, unitsSold: 100, ticketCount: 20, averageTicket: 250,
  averageTicketCents: 25000, grossMarginPct: null };
const dataFor = (skill, args) => {
  const requested = (args.productRefs || args.productRef || '').split('|').filter(Boolean);
  const selected = requested.length ? products.filter(row => requested.includes(row.sku)) : products.slice(0, 3);
  if (skill === I) return { items: structuredClone(selected), total: selected.length };
  if (skill === F) return args.mode === 'evaluation'
    ? { selectedOperationalMethod: { algorithm: 'MOVING_AVERAGE_28' }, modelEvaluation: [{ algorithm: 'HGB', modelStatus: 'REJECTED_FOR_OPERATIONAL_USE', metrics: { test: { wape: .302878 } } }] }
    : { method: 'MOVING_AVERAGE_28', horizonDays: args.horizonDays || 7, items: selected.map(row => ({ sku: row.sku, productName: row.productName, status: 'READY',
      expectedUnitsNext1d: 2.32, expectedUnitsNext7d: row.forecast, expectedUnitsNext14d: row.forecast * 2 })), total: selected.length };
  if (skill === S) return { items: [{ supplierCode: 'SUP-05', displayName: 'Proveedor Andino', pendingOrderCount: 29,
    leadTime: { averageDays: 4, sampleSize: 20 }, punctuality: { onTimeRatePct: 80 },
    productsSupplied: selected.map(row => ({ sku: row.sku, productName: row.productName })) }], total: 1 };
  if (skill === C) return { items: [{ customerCode: 'CLI-001', displayName: 'Cliente Ana', segment: args.segment || 'AT_RISK',
    lastPurchaseDate: '2026-09-10', totalSpentCents: 12345, ticketCount: 4,
    rfm90d: { raw: { recencyDays: 35, frequency90d: 4, monetary90dCents: 12345 } } }], total: 1 };
  if (skill === B) return args.mode === 'rank' ? { items: args.entityType === 'category'
    ? [{ categoryCode: 'ABARROTES', categoryName: 'Abarrotes', metric: 100 }]
    : selected.map(row => ({ sku: row.sku, productName: row.productName, metric: 100 })), total: 1 }
    : args.mode === 'compare' ? { kpis: structuredClone(kpis), availabilityStatus: 'AVAILABLE', comparisonMode: 'EQUIVALENT_PREVIOUS',
      period: { startDate: args.startDate, endDate: args.endDate },
      previousPeriod: { startDate: '2026-08-17', endDate: '2026-09-15', equalDuration: true },
      trends: Object.fromEntries([['revenue', 500000], ['unitsSold', 100], ['ticketCount', 20], ['averageTicket', 25000]]
        .map(([key, value]) => [key, { value, previousValue: value * 0.8, absoluteChange: value * 0.2,
          percentChange: 25, comparisonAvailable: true, comparableDurations: true }])) } : { kpis: structuredClone(kpis) };
  if (skill === H) return { businessHealth: { sales: { kpis }, inventory: { critical: 5, high: 4 },
    customers: { atRiskCount: 3 }, suppliers: { summary: { suppliers: 10 } }, marketBasket: { stableCrossSellRuleCount: 33,
      freshness: { mode: 'HISTORICAL', analysisCutoff: V3.historicalCutoff } } }, alerts: [] };
  if (skill === M) return { available: true, mode: 'FROZEN', analysisCutoff: V3.historicalCutoff,
    items: [{ antecedentSkus: ['ABA-ACE-001'], consequentSkus: ['ABA-ARR-001'], recommendedSku: 'ABA-ARR-001',
      recommendedProduct: 'Arroz Costeño', support: .08, confidence: .3, lift: 2, ticketCount: 100, stability: 'STABLE' }] };
  assert.fail(`Unexpected skill ${skill}`);
};
const synthesisFor = context => {
  const refs = skills => context.evidence.filter(row => skills.includes(row.skillId) && row.facts).map(row => row.ref);
  const make = (skills, interpretation, advisoryRecommendation) => ({ evidenceRefs: refs(skills), interpretation, advisoryRecommendation });
  if (context.responseIntent === 'inventory_priorities' && context.evidence[0].facts?.items?.length === 3) return {
    observations: [
      make([I, F], 'Cocinero tiene riesgo alto y cobertura de 5,03 días.', 'Revisa reponer las 24 unidades sugeridas.'),
      make([I, F], 'Primor tiene stock 11 y ninguna entrada pendiente.', 'Revisa la reposición sugerida de 18 unidades.'),
      make([I, F], 'Arroz tiene 57 unidades pendientes frente a demanda prevista de 34,75.', 'Considera esas entradas antes de preparar otra compra.')
    ], limitations: [] };
  let observation;
  if (context.responseIntent === 'sales_evolution') observation = make([B], 'Las ventas fueron mayores que en el período comparable anterior.', 'Vigila ventas, unidades, tickets y ticket promedio en próximos cortes comparables.');
  else if (context.responseIntent === 'ml_interpretation') observation = make([F], 'MA28 es estadístico y HGB conserva su evaluación.', 'Usa el método operativo aprobado para planificar.');
  else if (refs([C]).length) observation = make([C], 'Cliente Ana tiene 35 días de recencia observada.', 'Revisa su historial antes de planificar el contacto.');
  else if (context.responseIntent === 'supplier_advice') observation = make([S], 'Proveedor Andino registra puntualidad de 80 %.', 'Compara sus condiciones con el inventario antes de decidir.');
  else if (refs([H]).length) observation = make([H], 'El inventario muestra 5 productos críticos.', 'Revisa las prioridades de inventario antes de decidir.');
  else if (context.responseIntent === 'new_products' || context.responseIntent === 'promotion') observation = make([M], 'Las asociaciones observadas muestran lift de 2.', 'Revisa las combinaciones como hipótesis comercial sin inferir causalidad.');
  else if (refs([I]).length) {
    const item = context.evidence.find(row => row.skillId === I).facts.items[0];
    observation = make([I], `${item.productName} tiene stock ${item.stock.onHand}.`, 'Revisa la reposición sugerida antes de preparar una compra.');
  } else observation = make([B], 'Las ventas observadas suman 100 unidades.', 'Revisa la tendencia del periodo antes de decidir.');
  return { observations: [observation], limitations: [] };
};
function fixture({ output, finish = 'stop', outputTokens = 250, status = 'READY', failSkill, modifyResult, noProvider = false } = {}) {
  const calls = [], requests = [], events = [], resolutions = [];
  let genericCalls = 0;
  const service = { async resolveContext() { return binding; },
    async resolveEntity(type, query) {
      resolutions.push({ type, query });
      const compact = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
      const candidates = products.filter(row => compact(row.sku) === compact(query) || row.productName.toLowerCase().includes(query.toLowerCase()));
      const found = candidates[0] || products.find(row => /pan/i.test(query) && row.sku === 'PAN-FRE-001');
      if (!found) return { candidates: [], query, type };
      return { entity: { type, id: '507f1f77bcf86cd799439012', key: found.sku, label: found.productName } };
    },
    async execute({ skill, args }) {
      calls.push({ skill: skill.id, args });
      if (skill.id === failSkill) throw Object.assign(new Error('PRIVATE-SERVICE'), { code: 'ML_SERVICE_UNAVAILABLE' });
      const result = { status, data: dataFor(skill.id, args), metadata: { returnedCount: 1, totalMatches: 3,
        asOf: binding.operationalDate, dataMode: 'LIVE', dataVersion: '0', snapshotHash: 'a'.repeat(64),
        source: 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT', ...(skill.id === M ? { frozenCutoff: V3.historicalCutoff, dataMode: 'HISTORICAL' } : {}) } };
      if (modifyResult) modifyResult(result, skill.id);
      return result;
    } };
  const neutralProvider = noProvider ? null : createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'fictional-only', DEEPSEEK_MAX_OUTPUT_TOKENS: '500' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body);
      assert.equal(body.max_tokens, 500); assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.equal(body.tools, undefined);
      const compact = JSON.parse(body.messages[1].content), value = output ? output(compact) : synthesisFor(compact);
      return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: finish,
        message: { role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value), reasoning_content: 'PRIVATE-REASONING' } }],
        usage: { prompt_tokens: 1800, completion_tokens: outputTokens, total_tokens: 1800 + outputTokens,
          prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1800 } }) };
    } });
  const runtime = createAgentOrchestrator({ neutralProvider, memory: createConversationMemory(),
    clock: () => new Date('2026-10-15T17:00:00Z'), dependencies: { models: {}, v3Service: service }, onEvent: event => events.push(event),
    provider: { async generateStructured() { genericCalls++; assert.fail('No generic provider'); },
      async generateWithTools() { genericCalls++; assert.fail('No WRITE tools for DeepSeek'); } } });
  const req = { businessId: V3.businessId, user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, role: 'user', isActive: true } };
  const actionWrapper = require('../../src/automations/assistant').withActionAssistant(runtime, {
    async resolvePending() { return undefined; }, async get() { return undefined; },
    async prepare(input) { return { pendingActionId: randomUUID(), action: input.skillId,
      status: 'PENDING', summary: 'Preview simulado; requiere confirmación.', expiresAt: new Date(Date.now() + 600000).toISOString() }; },
    async confirmPendingAction() { assert.fail('Matrix cannot execute a WRITE'); },
    async cancelPendingAction() { assert.fail('No pending action in this fixture'); }
  }, { resolver: async () => ({ confidence: 'NOT_FOUND', candidates: [] }), supplierLookup: async () => [] });
  return { calls, requests, events, resolutions, service, runtime, req, genericCalls: () => genericCalls,
    runWrite: async message => {
      const previous = process.env.LLM_PROVIDER;
      try { process.env.LLM_PROVIDER = 'deepseek'; return await actionWrapper.handle(req, { message, conversationId: randomUUID() }); }
      finally { if (previous === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previous; }
    },
    run: (message, conversationId = randomUUID()) => runtime.handle(req, { message, conversationId }) };
}
module.exports = { fixture, binding, products, synthesisFor, dataFor };
