const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSynthesisInput } = require('../src/agents/synthesis');
const { buildNarrativeSynthesisInput, validateNarrativeSynthesis, renderNarrativeSynthesis,
  renderNarrativeFallback } = require('../src/agents/synthesis');
const { createAgentExecution, createAgentRequestContext, createGeminiProvider } = require('../src/agents');
const { logAgentProviderDiagnostic } = require('../src/controllers/agentMessagesController');

const results = () => [
  { skillId: 'get_business_summary', result: { status: 'READY', data: {
    activeProducts: 60, lowStockProducts: 8, completedTransactionsCount: 2,
    sales: { completedTransactionsCount: 2, totalUnits: 7, amountsByCurrency: [
      { currency: 'PEN', amount: 60, label: 'irrelevant' }, { currency: 'USD', amount: 8 }] },
    purchases: { completedTransactionsCount: 0, amountsByCurrency: [] }, internal: 'omit'
  }, metadata: { periodMode: 'current', period: { startDate: '2026-10-01', endDate: '2026-10-31' }, asOf: '2026-10-08T12:00:00Z' } } },
  { skillId: 'get_low_stock_products', result: { status: 'READY', data: Array.from({ length: 20 }, (_, index) => ({
    id: 'internal-id', sku: `SKU-${index}`, name: 'Producto ficticio', stock: 2, minStockLevel: 5, shortage: 3,
    email: 'private@example.com', category: 'unnecessary'
  })), metadata: { totalMatches: 20 } } }
];
const input = () => ({ agentId: 'analyst', ...buildSynthesisInput('business_summary', 'Resumen genérico', results()) });

test('summary sends only compact facts, separate currencies and at most three products, with no history', () => {
  const request = input();
  assert.equal(request.messages.length, 1);
  const payload = JSON.parse(request.messages[0].text);
  assert.deepEqual(Object.keys(payload), ['catalog', 'activity', 'lowStock']);
  assert.deepEqual(payload.catalog, { activeProducts: 60, lowStockCount: 8 });
  assert.deepEqual(payload.activity.salesByCurrency, [{ currency: 'PEN', amount: 60 }, { currency: 'USD', amount: 8 }]);
  assert.equal(payload.lowStock.items.length, 3);
  assert.deepEqual(Object.keys(payload.lowStock.items[0]), ['sku', 'label', 'stock', 'minStock', 'deficit']);
  assert.doesNotMatch(JSON.stringify(request), /internal-id|private@|irrelevant|totalUnits|participants|conversation|asOf/);
  assert.equal(request.diagnostics.evidenceCount, 2);
  assert.equal(request.diagnostics.selectedItemsCount, 3);
});

test('historical synthesis uses only the real period, never invented last activity dates', () => {
  const rows = results();
  const historic = structuredClone(rows[0]);
  historic.result.metadata.periodMode = 'latest';
  historic.result.metadata.period = { startDate: '2025-07-01', endDate: '2025-07-31' };
  rows.splice(1, 0, historic);
  const payload = JSON.parse(buildSynthesisInput('business_summary', '', rows).messages[0].text);
  assert.equal(payload.activity.section, 0);
  assert.equal(payload.historicalContext.section, 1);
  assert.equal(payload.lowStock.section, 2);
  assert.equal(payload.historicalContext.period.startDate, '2025-07-01');
  assert.equal(payload.historicalContext.lastActivityDate, undefined);
  assert.equal(payload.historicalContext.catalog, undefined);
});

test('compact structured generation retains low thinking, ceilings, usage and safe size instrumentation', async () => {
  let captured;
  const provider = createGeminiProvider({ apiKey: 'synthetic-test-key', client: { models: {
    generateContent: async request => {
      captured = request;
      return { text: '{"sections":[0,1]}', candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8, thoughtsTokenCount: 5, totalTokenCount: 133 } };
    }
  } } });
  const context = createAgentRequestContext({ user: { _id: '507f1f77bcf86cd799439011', businessId: 'DEMO', role: 'user', isActive: true }, businessId: 'DEMO' });
  const execution = createAgentExecution({ context, provider });
  const request = input();
  const result = await execution.generateStructured(request);
  assert.deepEqual(result.output, { sections: [0, 1] });
  assert.equal(captured.config.maxOutputTokens, 1024);
  assert.equal(captured.config.thinkingConfig.thinkingLevel, 'low');
  assert.equal(captured.config.httpOptions.timeout, 15000);
  assert.equal(execution.finish().totalTokens, 133);
  const event = execution.getEvents().find(row => row.type === 'provider_attempt');
  assert.equal(event.promptChars, request.systemInstruction.length + request.messages[0].text.length);
  assert.equal(event.promptBytesApprox, Buffer.byteLength(request.systemInstruction + request.messages[0].text));
  assert.equal(event.selectedItemsCount, 3);
  assert.equal(event.messageCount, 1);
  assert.equal(event.totalTokens, 133);
  assert.equal(event.cachedInputTokens, null);
  assert.equal(event.providerStatus, null);
  assert.equal(event.providerAttempt, 1);
  let logged;
  const original = console.error;
  try { console.error = (...args) => { logged = args.join(' '); }; logAgentProviderDiagnostic(event); }
  finally { console.error = original; }
  assert.match(logged, /promptChars/);
  assert.doesNotMatch(logged, /Producto ficticio|SKU-|salesByCurrency|systemInstruction/);
});

// Synthetic facts exercise the real domain contracts; no cloud or Gemini traffic.
const inventoryEvidence = () => {
  const rows = results();
  rows[0].result.data.lowStockProducts = 23;
  rows[0].result.data.sales.completedTransactionsCount = 0;
  rows[0].result.data.purchases.completedTransactionsCount = 0;
  rows[1].result.data = [{ sku: 'M5-FOODS_3_511', stock: 4, minStockLevel: 18, name: 'Producto demo' }];
  rows.push({ skillId: 'analyze_demand_forecast', result: { status: 'READY', data: {
    products: 60, ready: 60, notReady: 0, states: { OK: 24, VIGILAR: 3, REPONER: 33 },
    stockTotal: 815, predictedDemandTotal: 712.74, recommendedTotal: 543
  }, metadata: { mode: 'summary', anchor: '2026-05-17' } } });
  rows.push({ skillId: 'analyze_demand_forecast', result: { status: 'READY', data: [
    { sku: 'M5-FOODS_3_511', predictedDemand7d: 73.13, stockAtAnchor: 4, demandStockGap: 69.13, recommendedQty: 88 },
    { sku: 'M5-FOODS_3_491', predictedDemand7d: 66.15, stockAtAnchor: 16, demandStockGap: 50.15, recommendedQty: 69 }
  ], metadata: { mode: 'exceeding_stock', anchor: '2026-05-17' } } });
  rows.forEach((row, index) => { row.result.evidence = { evidenceId: `ref-${index}`, label: `Fuente ${index}`,
    ...(row.result.metadata.period ? { period: row.result.metadata.period } : {}) }; });
  return rows;
};
const groundedNarrative = () => ({ observations: [
  { evidenceRefs: ['ref-0'], interpretation: 'Inventario operativo actual: 23 de 60 productos bajo mínimo indican presión de stock.', advisoryRecommendation: 'Prioriza revisar esas alertas.' },
  { evidenceRefs: ['ref-2'], interpretation: 'El replay histórico muestra 33 de 60 en REPONER y 543 unidades recomendadas: el volumen merece atención.', advisoryRecommendation: 'Dimensiona el abastecimiento dentro de ese escenario.' },
  { evidenceRefs: ['ref-3'], interpretation: 'M5-FOODS_3_511 tiene demanda histórica 73.13 frente a stock 4; la brecha 69.13 destaca la presión de abastecimiento.', advisoryRecommendation: 'Revisa este producto prioritariamente dentro del replay.' }
], limitations: [] });

test('inventory prompt retains operational activity, stock, historical states and two critical SKUs within compact budget', () => {
  const input = buildNarrativeSynthesisInput('inventory_interpretation', 'Explícame los principales problemas.', inventoryEvidence());
  const payload = JSON.parse(input.messages[0].text);
  assert.ok(input.messages[0].text.length <= 2000);
  assert.equal(payload.evidence[0].facts.lowStockProducts, 23);
  assert.equal(payload.evidence[0].facts.completedSalesCount, 0);
  assert.equal(payload.evidence[0].facts.completedPurchasesCount, 0);
  assert.equal(payload.evidence[1].facts[0].stock, 4);
  assert.equal(payload.evidence[1].facts[0].minStockLevel, 18);
  assert.deepEqual(payload.evidence[2].facts.states, { OK: 24, VIGILAR: 3, REPONER: 33 });
  assert.equal(payload.evidence[3].facts.length, 2);
  assert.equal(payload.evidence[3].anchor, '2026-05-17');
  assert.doesNotMatch(input.messages[0].text, /internal-id|private@|unnecessary|totalUnits/);
});

test('useful synthesis leads with priorities, concrete figures and one separate historical scope note', () => {
  const rows = inventoryEvidence(), output = groundedNarrative();
  validateNarrativeSynthesis(output, rows, 'inventory_interpretation');
  const answer = renderNarrativeSynthesis('inventory_interpretation', rows, output);
  assert.match(answer, /^Los principales problemas/);
  assert.match(answer, /23 de 60/); assert.match(answer, /33 de 60/); assert.match(answer, /543/);
  assert.match(answer, /M5-FOODS_3_511/); assert.match(answer, /cortes distintos/);
  assert.equal(answer.match(/2026-05-17/g).length, 1);
  assert.doesNotMatch(answer, /Datos verificados|Estos hechos describen/);
});

test('generic narratives, invented numbers, SKUs, refs and causal claims are rejected', () => {
  for (const [field, value, code] of [
    ['interpretation', 'Estos hechos describen la situación consultada.', 'SYNTHESIS_GENERIC_INTERPRETATION'],
    ['interpretation', 'Inventario actual con 999 productos bajo mínimo.', 'SYNTHESIS_UNGROUNDED_NUMBER'],
    ['interpretation', 'SKU-FAKE está bajo mínimo con stock 4.', 'SYNTHESIS_UNGROUNDED_SKU'],
    ['interpretation', 'La causa es mala gestión del stock.', 'SYNTHESIS_UNSUPPORTED_CLAIM']
  ]) {
    const output = { observations: [{ ...groundedNarrative().observations[0], [field]: value }], limitations: [] };
    assert.throws(() => validateNarrativeSynthesis(output, inventoryEvidence(), 'inventory_interpretation'), { code });
  }
  const output = groundedNarrative(); output.observations[0].evidenceRefs = ['invented'];
  assert.throws(() => validateNarrativeSynthesis(output, inventoryEvidence(), 'inventory_interpretation'), { code: 'SYNTHESIS_INVALID_EVIDENCE_REF' });
});

test('inventory fallback is concrete, includes inactivity without causality, and handles missing domains', () => {
  const rows = inventoryEvidence();
  const answer = renderNarrativeFallback('inventory_interpretation', rows);
  assert.match(answer, /23 de 60/); assert.match(answer, /33 de 60/); assert.match(answer, /543/);
  assert.match(answer, /M5-FOODS_3_491/); assert.match(answer, /no hay ventas ni compras completadas/);
  assert.match(answer, /esto no demuestra por qué/); assert.match(answer, /cortes distintos/);
  const operationalOnly = renderNarrativeFallback('inventory_interpretation', rows.slice(0, 2));
  assert.match(operationalOnly, /23 de 60/); assert.doesNotMatch(operationalOnly, /33 de 60|543|2026-05-17/);
  const historicalOnly = renderNarrativeFallback('inventory_interpretation', rows.slice(2));
  assert.match(historicalOnly, /33 de 60/); assert.match(historicalOnly, /solo se consultó/);
  assert.doesNotMatch(historicalOnly, /23 de 60/);
});
