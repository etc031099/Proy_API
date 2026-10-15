'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { V3, createV3IntelligenceService } = require('../src/services/v3IntelligenceService');
const { createMlServiceClient } = require('../src/services/mlServiceClient');
const { createDeepSeekProvider } = require('../src/agents/providers/deepseekProvider');
const { createConversationMemory } = require('../src/agents/memory');
const query = '¿Qué clientes debería intentar recuperar y por qué?';
const period = { startDate: '2026-09-16', endDate: '2026-10-15' };
const C = 'get_customer_intelligence';
const customers = [
  { customerCode: 'CLI-ELENA', displayName: 'Elena Rojas Quispe', lastPurchaseDate: '2026-08-22', ticketCount: 96, spendCents: 186261, averageTicketCents: 1940 },
  { customerCode: 'CLI-SAMUEL', displayName: 'Samuel Vargas León', lastPurchaseDate: '2026-09-02', ticketCount: 41, spendCents: 78846, averageTicketCents: 1923 },
  { customerCode: 'CLI-MARTIN', displayName: 'Martín Salazar Huamán', lastPurchaseDate: '2026-09-10', ticketCount: 105, spendCents: 212624, averageTicketCents: 2025 }
];
const chain = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean() { return this; }, maxTimeMS: async () => value });

test('J2P production path trace at the published J2O baseline (no runtime fix)', async t => {
  t.mock.method(console, 'info', () => {});
  let trace;
  // Observe real validator inputs locally, before its destructured imports load.
  // No generated sentence, prompt, credentials or raw envelope enters the trace.
  const numbers = require('../src/agents/groundedNumbers');
  const collect = numbers.numericEvidence;
  t.mock.method(numbers, 'numericEvidence', (...args) => {
    const evidence = collect(...args);
    trace.numeric.push({ analysisWindowDaysPresentAtValidation: evidence.analysisWindowDays.length > 0,
      analysisWindowDaysValue: evidence.analysisWindowDays[0] ?? null,
      temporalNumberAuthorizedForObservation: evidence.analysisWindowDays.includes(30) });
    return evidence;
  });
  const contextModule = require('../src/agents/groundedContext');
  const build = contextModule.buildGroundedContext, validate = contextModule.validateGroundedOutput;
  t.mock.method(contextModule, 'buildGroundedContext', input => {
    trace.skillMetadata = input.results.map(row => ({ skillId: row.skillId, period: row.result.metadata.period }));
    trace.compact = build(input); return trace.compact;
  });
  t.mock.method(contextModule, 'validateGroundedOutput', (text, context) => {
    trace.validationContext = context; return validate(text, context);
  });
  const { createAgentOrchestrator } = require('../src/agents/orchestrator');
  function fixture(interpretation, message = query, evidenceRefs = ['E1']) {
    trace = { numeric: [], ml: [], providers: 0 };
    const snapshotHash = 'a'.repeat(64);
    const models = {
      HistoricalScenario: { findOne: () => chain({ businessId: V3.businessId, scenarioId: V3.scenarioId, status: 'completed',
        sourceSha256: V3.datasetSha256, metadata: { datasetVersion: V3.datasetVersion, referenceDate: V3.referenceDate, timezone: V3.timezone } }) },
      Contact: { find: () => chain([...customers.map((row, index) => ({ _id: String(index), stableCode: row.customerCode, name: row.displayName })),
        { _id: 'supplier-fixture', stableCode: 'SUP-05', name: 'Proveedor de prueba' }]) },
      Product: { find: () => chain([{ _id: 'product-fixture', sku: 'PAN-FRE-001', name: 'Pan francés' }]) }
    };
    const mlClient = createMlServiceClient({ serviceUrl: 'https://fixture.invalid', serviceSecret: 'fictional-only', fetchImpl: async (_url, input) => {
      const payload = JSON.parse(input.body); trace.ml.push(payload);
      const domain = _url.split('/').at(-1);
      const data = domain === 'customers' ? { items: customers, total: 3 }
        : domain === 'business' ? { kpis: { revenueCents: 20000, unitsSold: 45, ticketCount: 12 } }
          : domain === 'health' ? { businessHealth: { customers: { atRiskCount: 3 } } }
            : domain === 'suppliers' ? { items: [{ supplierCode: 'SUP-05', displayName: 'Proveedor de prueba', pendingOrderCount: 29 }], total: 1 }
              : domain === 'inventory' ? { items: [{ sku: 'PAN-FRE-001', productName: 'Pan francés', stock: { onHand: 21, incoming: 0 },
                risk: { level: 'HIGH' }, recommendation: { recommendedQty: 9, shouldReorder: true } }], total: 1 }
                : { horizonDays: payload.horizonDays, method: 'MOVING_AVERAGE_28', items: [{ sku: 'PAN-FRE-001', productName: 'Pan francés',
                  status: 'READY', expectedUnitsNext1d: 2.32, expectedUnitsNext7d: 16.25, expectedUnitsNext14d: 32.5 }], total: 1 };
      return { ok: true, status: 200, json: async () => ({ requestId: payload.requestId, status: 'OK', data,
        metadata: { ...payload.context, dataVersion: '0', snapshotHash, source: 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT', contractVersion: 'm6.9f4-live-intelligence-v1' } }) };
    } });
    const clock = () => new Date('2026-10-15T17:00:00Z');
    const service = createV3IntelligenceService({ models, mlClient, clock, snapshotBuilder: async ({ businessId, asOfDate }) => ({
      mode: 'LIVE', dataVersion: '0', snapshot: { metadata: { businessId, scenarioId: V3.scenarioId, asOfDate, dataVersion: '0',
        snapshotHash, snapshotVersion: 'v3-operational-snapshot-v2' } } }) });
    const neutralProvider = createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'fictional-only', DEEPSEEK_MAX_OUTPUT_TOKENS: '500' },
      fetchImpl: async (_url, input) => {
        trace.providers++; const request = JSON.parse(input.body);
        assert.equal(request.max_tokens, 500); trace.promptContext = JSON.parse(request.messages[1].content);
        return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: {
          role: 'assistant', content: JSON.stringify({ observations: [{ evidenceRefs, interpretation,
            advisoryRecommendation: 'Revisa el historial observado antes de planificar un contacto.' }], limitations: [] }) } }],
          usage: { prompt_tokens: 1660, completion_tokens: 80, total_tokens: 1740, prompt_cache_hit_tokens: 1408, prompt_cache_miss_tokens: 252 } }) };
      } });
    const runtime = createAgentOrchestrator({ memory: createConversationMemory(), clock, neutralProvider, dependencies: { models, v3Service: service },
      provider: { generateStructured() { assert.fail('No generic provider'); }, generateWithTools() { assert.fail('No WRITE'); } } });
    return runtime.handle({ businessId: V3.businessId, user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, role: 'user', isActive: true } },
      { message, conversationId: randomUUID() });
  }
  await t.test('exact requested mock already passes before any J2P fix; window survives every boundary', async () => {
    const result = await fixture('En los últimos 30 días, estos clientes muestran señales de inactividad observada.');
    assert.equal(result.grounded.responseDiagnostic.validationResult, 'ACCEPTED');
    assert.equal(trace.providers, 1); assert.equal(trace.ml.length, 1); assert.deepEqual(trace.ml[0].period, period);
    assert.deepEqual(trace.skillMetadata, [{ skillId: C, period }]);
    assert.equal(trace.compact.evidence[0].scope.analysisWindowDays, 30);
    assert.deepEqual(trace.promptContext, trace.compact);
    assert.strictEqual(trace.validationContext, trace.compact);
    assert.deepEqual(trace.numeric[0], { analysisWindowDaysPresentAtValidation: true, analysisWindowDaysValue: 30,
      temporalNumberAuthorizedForObservation: true });
    assert.equal(result.usage.totalSkillCalls, 1); assert.equal(result.pendingAction, undefined);
    assert.match(result.answer, /últimos 30 días/);
  });
  for (const interpretation of ['En los últimos 60 días, estos clientes muestran inactividad.',
    'Estos clientes acumulan 30 unidades.', 'El descuento sugerido es 30 %.']) {
    await t.test(`unsupported claim is still rejected: ${interpretation}`, async () => {
      const result = await fixture(interpretation);
      assert.equal(result.grounded.responseDiagnostic.validationReason, 'UNSUPPORTED_NUMBER');
      assert.equal(trace.numeric[0].analysisWindowDaysValue, 30);
    });
  }
  await t.test('same diagnostic can occur with the window present when prose differs; cloud wording remains unknown', async () => {
    const result = await fixture('El período analizado comprende 30 días.');
    assert.equal(result.grounded.responseDiagnostic.validationReason, 'UNSUPPORTED_NUMBER');
    assert.deepEqual(result.grounded.responseDiagnostic.unsupportedNumberDetails, [{ value: 30, pattern: 'QUANTITY_WITH_UNIT' }]);
    assert.equal(trace.numeric[0].analysisWindowDaysValue, 30);
    assert.equal(trace.numeric[0].temporalNumberAuthorizedForObservation, true);
  });
  for (const message of ['Analiza mis ventas recientes', 'Interpreta la salud del negocio', 'Qué proveedor recomiendas elegir']) {
    await t.test(`real cross-domain adapter retains cited period: ${message}`, async () => {
      const result = await fixture('En los últimos 30 días, los datos requieren revisión.', message);
      assert.equal(result.grounded.responseDiagnostic.validationResult, 'ACCEPTED');
      assert.equal(trace.compact.evidence[0].scope.analysisWindowDays, 30);
      assert.strictEqual(trace.validationContext, trace.compact);
    });
  }
  for (const days of [1, 7, 14]) await t.test(`real forecast adapter keeps horizon ${days} grounded through E3 alone`, async () => {
    const result = await fixture(`La proyección cubre los próximos ${days} días.`,
      `Analiza ventas, inventario y forecast para ${days} días`, ['E3']);
    assert.equal(result.grounded.responseDiagnostic.validationResult, 'ACCEPTED');
    assert.equal(trace.compact.evidence[2].skillId, 'get_product_forecast');
    assert.equal(trace.compact.evidence[2].facts.horizonDays, days);
    assert.deepEqual(trace.numeric[0], { analysisWindowDaysPresentAtValidation: false, analysisWindowDaysValue: null,
      temporalNumberAuthorizedForObservation: false });
  });
});
