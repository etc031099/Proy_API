'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { V3, createV3IntelligenceService } = require('../src/services/v3IntelligenceService');
const { createAgentOrchestrator } = require('../src/agents/orchestrator');
const { createConversationMemory } = require('../src/agents/memory');
const { createNeutralProvider } = require('../src/agents/providers/neutralProvider');
const { buildGroundedPlan } = require('../src/agents/groundedRouting');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const { createMlServiceClient } = require('../src/services/mlServiceClient');
const query = '¿Qué productos debería reponer esta semana y por qué?';
const BINDING = { ...V3, operationalDate: '2026-10-15' };
const I = 'get_inventory_intelligence', F = 'get_product_forecast', S = 'get_supplier_intelligence';
const req = { businessId: V3.businessId, user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId, role: 'user', isActive: true } };
const chain = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean() { return this; }, maxTimeMS() { return Promise.resolve(value); } });
const product = { _id: '507f1f77bcf86cd799439012', sku: 'PAN-FRE-001', name: 'Pan francés' };
function fixture({ partial = false, failInventory = false, invalidQty = false } = {}) {
  const calls = [], events = [], snapshots = []; let providerCalls = 0;
  const models = {
    HistoricalScenario: { findOne: () => chain({ businessId: V3.businessId, scenarioId: V3.scenarioId, status: 'completed', sourceSha256: V3.datasetSha256,
      metadata: { datasetVersion: V3.datasetVersion, referenceDate: V3.referenceDate, timezone: V3.timezone } }) },
    Product: { find: () => chain([product]) },
    Contact: { find: () => chain([{ _id: '507f1f77bcf86cd799439013', stableCode: 'SUP-05', name: 'Proveedor ficticio' }]) }
  };
  const service = createV3IntelligenceService({ models, clock: () => new Date('2026-10-15T17:00:00Z'),
    snapshotBuilder: async ({ businessId, asOfDate }) => {
      snapshots.push({ businessId, asOfDate });
      return { mode: 'LIVE', dataVersion: '0', snapshot: { metadata: { businessId, scenarioId: V3.scenarioId, asOfDate,
        dataVersion: '0', snapshotVersion: 'v3-operational-snapshot-v2', snapshotHash: 'a'.repeat(64) } } };
    }, mlClient: { async intelligence(domain, payload) {
      calls.push({ domain, payload });
      if (domain === 'inventory' && failInventory) { const error = new Error('private details'); error.functionalCode = 'ARTIFACT_UNAVAILABLE'; throw error; }
      const inventory = { sku: product.sku, productName: product.name, stock: { onHand: 21, incoming: 10 },
        inventoryPolicy: { configuredMinimumStock: 5 }, risk: { level: partial ? null : 'CRITICAL', reasonCodes: partial ? ['LIVE_FORECAST_REQUIRED'] : [], lowStock: false },
        recommendation: { recommendedQty: partial || invalidQty ? null : 9, shouldReorder: partial ? null : true,
          ...(partial ? { status: 'LIVE_FORECAST_REQUIRED' } : {}) } };
      const data = domain === 'inventory' ? { items: [inventory], total: 1, availabilityStatus: partial ? 'PARTIAL' : 'AVAILABLE',
        ...(partial ? { fieldAvailability: { stock: 'AVAILABLE', reorder: 'PARTIAL', forecast: 'PARTIAL' } } : {}) }
        : domain === 'forecast' ? { items: [{ sku: product.sku, productName: product.name, status: 'READY', expectedUnitsNext7d: 16.25 }], total: 1 }
          : { items: [{ supplierCode: 'SUP-05', displayName: 'Proveedor ficticio', pendingOrderCount: 29 }], total: 1 };
      return { requestId: payload.requestId, status: partial && domain === 'inventory' ? 'PARTIAL' : 'OK', data,
        metadata: { ...payload.context, dataVersion: '0', snapshotHash: 'a'.repeat(64), contractVersion: 'm6.9f4-live-intelligence-v1', source: 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT' } };
    } } });
  const neutralProvider = createNeutralProvider({ provider: 'mock', model: 'fixture', generate: async input => {
    providerCalls++; const compact = JSON.parse(input.messages[1].content);
    assert.deepEqual(compact.evidence.map(row => row.skillId), [I, F, S]);
    return { text: JSON.stringify({ observations: [{ evidenceRefs: ['E1'], interpretation: 'El inventario requiere revisión.',
      advisoryRecommendation: 'Revisa las necesidades antes de comprar.' }], limitations: [] }), usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
  } });
  const runtime = createAgentOrchestrator({ memory: createConversationMemory(), neutralProvider, dependencies: { models, v3Service: service },
    onEvent: event => events.push(event), provider: { generateStructured() { assert.fail('No Gemini'); }, generateWithTools() { assert.fail('No tool selection'); } } });
  return { calls, events, snapshots, providerCalls: () => providerCalls,
    run: message => runtime.handle(req, { message, conversationId: randomUUID() }) };
}
test('J2C exact replenishment plan uses real backend adapter, all three skills, scoped forecast and one mock generation', async () => {
  const plan = buildGroundedPlan(query, BINDING);
  assert.equal(plan.route, 'GROUNDED_LLM'); assert.deepEqual(plan.skills, [I, F, S]);
  assert.deepEqual(plan.tasks[0].args, { limit: 3, mode: 'recommendations' });
  const f = fixture(), result = await f.run(query);
  assert.deepEqual(f.calls.map(row => row.domain), ['inventory', 'forecast', 'suppliers']);
  assert.deepEqual(f.calls[1].payload.skus, [product.sku]); assert.equal(f.providerCalls(), 1);
  assert.ok(f.calls.every(row => row.payload.context.businessId === V3.businessId && row.payload.context.asOfDate === '2026-10-15'));
  assert.equal(result.pendingAction, undefined);
});
test('J2C real LIVE partial shape keeps null recommendation, verified stock and supplier facts without synthesis', async () => {
  const f = fixture({ partial: true }), result = await f.run(query);
  assert.equal(result.actions.find(row => row.skillId === I).status, 'SUCCEEDED');
  assert.match(result.answer, /21/); assert.match(result.answer, /Proveedor ficticio/);
  assert.equal(f.providerCalls(), 0); assert.equal(result.usage.totalTokens, 0); assert.equal(result.pendingAction, undefined);
});
test('J2C inventory failure skips dependent forecast but retains independent supplier facts and sanitized cause', async () => {
  const f = fixture({ failInventory: true }), result = await f.run(query);
  assert.deepEqual(f.calls.map(row => row.domain), ['inventory', 'suppliers']);
  assert.match(result.answer, /Proveedor ficticio/); assert.equal(f.providerCalls(), 0); assert.equal(result.pendingAction, undefined);
  assert.ok(result.grounded.failures.some(row => row.skillId === I && row.code === 'ARTIFACT_UNAVAILABLE'));
  assert.ok(publicResponse(result).grounded.failures.some(row => row.code === 'ARTIFACT_UNAVAILABLE'));
  assert.doesNotMatch(JSON.stringify(result), /private details/);
});

test('J2C HTTP client preserves allowed functional code and status without private response text', async () => {
  const client = createMlServiceClient({ serviceUrl: 'http://127.0.0.1:1', serviceSecret: 'fixture-only',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ code: 'ARTIFACT_UNAVAILABLE', message: 'private sensitive details' }) }) });
  await assert.rejects(client.intelligence('inventory', {}), error => {
    assert.equal(error.httpStatus, 503); assert.equal(error.functionalCode, 'ARTIFACT_UNAVAILABLE');
    assert.doesNotMatch(error.message, /private/); return true;
  });
});
test('J2C ML timeout is distinguished from unavailable without exposing transport details', async () => {
  const client = createMlServiceClient({ serviceUrl: 'http://127.0.0.1:1', serviceSecret: 'fixture-only', timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private network error')))) });
  await assert.rejects(client.intelligence('inventory', {}), error => error.code === 'ML_SERVICE_UNAVAILABLE'
    && error.diagnostic.internalCause === 'AGENT_SKILL_TIMEOUT' && !/private/.test(error.message));
});
test('J2C null recommendation without explicit partial provenance is still rejected', async () => {
  const f = fixture({ invalidQty: true }), result = await f.run(query);
  assert.equal(result.actions.find(row => row.skillId === I).status, 'FAILED'); assert.equal(f.providerCalls(), 0);
});
test('J2C ordinary and grounded inventory keep same authorized tenant/date and distinct approved filters', async () => {
  const ordinary = fixture(), grounded = fixture();
  await ordinary.run('Muéstrame productos con stock bajo y su stock mínimo'); await grounded.run(query);
  const a = ordinary.calls.find(row => row.domain === 'inventory').payload, b = grounded.calls[0].payload;
  assert.deepEqual(a.context, b.context);
  assert.equal(a.mode, 'rank'); assert.equal(a.flag, 'low_stock'); assert.equal(a.limit, 20);
  assert.equal(b.mode, 'recommendations'); assert.equal(b.flag, undefined); assert.equal(b.limit, 3);
});
