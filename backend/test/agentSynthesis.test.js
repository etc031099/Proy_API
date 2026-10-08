const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSynthesisInput } = require('../src/agents/synthesis');
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
