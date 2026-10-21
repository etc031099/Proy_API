'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { V3, createV3IntelligenceService } = require('../src/services/v3IntelligenceService');
const { createAgentOrchestrator } = require('../src/agents/orchestrator');
const { createConversationMemory } = require('../src/agents/memory');
const { createAgentExecution } = require('../src/agents/execution');
const { createAgentRequestContext } = require('../src/agents/contracts');
const { validateSkillInvocation } = require('../src/agents/skills');
const { getAgentDefinition } = require('../src/agents/definitions');
const { validateActionInvocation } = require('../src/automations/skills');
const { snapshot } = require('../src/services/agentHistoryProjection');
const req = (businessId = V3.businessId) => ({ user: { _id: '507f1f77bcf86cd799439011', businessId, role: 'user', isActive: true }, businessId });
const clock = () => new Date('2026-10-20T17:00:00Z');
const sku = 'BEB-GAS-001';
const query = rows => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean() { return this; }, maxTimeMS() { return Promise.resolve(rows); } });
function fixture({ reorder = true } = {}) {
  const calls = [], scopes = [];
  const products = [{ _id: '507f1f77bcf86cd799439012', sku, name: 'Coca-Cola Sabor Original 500 ml' },
    { _id: '507f1f77bcf86cd799439013', sku: 'BEB-GAS-002', name: 'Coca-Cola Sin Azúcar 500 ml' }];
  const models = { HistoricalScenario: { findOne: () => query({ businessId: V3.businessId, scenarioId: V3.scenarioId,
    status: 'completed', sourceSha256: V3.datasetSha256, metadata: { datasetVersion: V3.datasetVersion, referenceDate: V3.referenceDate, timezone: V3.timezone } }) },
    Product: { find: filter => { assert.equal(filter.businessId, V3.businessId); return query(products); } } };
  const forecastRegistryService = { getActiveModelArtifact: async scope => {
    scopes.push(scope); return { artifactData: Buffer.from('approved-test-artifact'), metadata: { ...scope, status: 'ACTIVE',
      modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', modelVersion: 1, featureVersion: 'RIDGE_CAUSAL27_V1', trainedDataVersion: '83', dataCutoff: '2026-10-15' } };
  } };
  const snapshotBuilder = async ({ businessId, asOfDate }) => ({ mode: 'LIVE', dataVersion: '173', snapshot: { metadata: {
    businessId, scenarioId: V3.scenarioId, asOfDate, dataVersion: '173', snapshotVersion: 'v3-operational-snapshot-v2',
    snapshotHash: 'a'.repeat(64), observationsClosedThrough: '2026-10-19', capturedAtUtc: clock().toISOString() } } });
  const mlClient = { intelligence: async (domain, payload) => {
    calls.push({ domain, payload });
    const partial = domain === 'inventory' && reorder === null;
    const inventoryRow = { sku, productName: products[0].name,
      stock: { onHand: 14, incoming: 0, inventoryPosition: 14 }, coverage: { daysCover: 1.78 }, risk: { level: 'HIGH' },
      inventoryPolicy: { configuredMinimumStock: 5, safetyStock: 8, reorderPoint: 59 },
      recommendation: { shouldReorder: reorder, recommendedQty: reorder === null ? null : reorder ? 102 : 0,
        ...(partial ? { status: 'PARTIAL', availabilityStatus: 'PARTIAL', reasonCode: 'FORECAST_HORIZON_UNAVAILABLE' } : {}) } };
    if (domain === 'forecast') { assert.equal(payload.useLiveRidge, true); assert.ok([7, 14].includes(payload.horizonDays)); }
    const data = domain === 'forecast' ? { items: [{ sku, horizonDays: payload.horizonDays, status: 'READY',
      predictionUnits: payload.horizonDays === 14 ? 108.27 : 55.5, activeModelStatus: 'ACTIVE', modelVersion: 1,
      featureVersion: 'RIDGE_CAUSAL27_V1', trainedDataVersion: '83', dataVersion: '173', observationsThrough: '2026-10-19' }], total: 1 }
      : { items: payload.flag === 'should_reorder' && !reorder ? [] : [inventoryRow], total: 1,
        ...(partial ? { availabilityStatus: 'PARTIAL' } : {}) };
    return { requestId: payload.requestId, status: partial ? 'PARTIAL' : 'OK', data, metadata: { ...payload.context,
      source: 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT', contractVersion: 'm6.9f4-live-intelligence-v1', dataVersion: '173', snapshotHash: 'a'.repeat(64) } };
  } };
  const service = createV3IntelligenceService({ models, forecastRegistryService, snapshotBuilder, mlClient, clock });
  const runtime = () => createAgentOrchestrator({ memory: createConversationMemory(), clock, dependencies: { v3Service: service, clock } });
  return { runtime: runtime(), restart: runtime, service, calls, scopes };
}
const ids = result => result.participants.map(row => row.agentId);

for (const horizon of [7, 14]) test(`forecast ${horizon}d preserves intention through ambiguous SKU selection and compact history`, async () => {
  const f = fixture(), conversationId = randomUUID();
  const first = await f.runtime.handle(req(), { message: `¿Cuánto venderemos de Coca-Cola en ${horizon} días?`, conversationId });
  assert.equal(first.requiresClarification, true); assert.equal(f.calls.length, 0);
  assert.deepEqual(ids(first), ['coordinator']);
  const state = snapshot(await f.runtime.getContextSnapshot(req(), conversationId));
  assert.equal(state.v3Context.pending.tasks[0].requestedIntent, 'forecast');
  assert.equal(state.v3Context.pending.tasks[0].args.horizonDays, horizon);
  const resumed = f.restart(); await resumed.restoreContext(req(), conversationId, state);
  const result = await resumed.handle(req(), { message: sku, conversationId });
  assert.equal(result.code, null); assert.equal(result.agent, 'forecast'); assert.deepEqual(ids(result), ['coordinator', 'forecast']);
  assert.match(result.answer, new RegExp(`Se esperan ${horizon === 14 ? '108.27' : '55.5'} unidades.*${horizon} días`));
  assert.equal(result.actions[0].agentId, 'forecast'); assert.equal(result.actions[0].skillId, 'get_product_forecast');
  assert.equal(result.evidence.length, 1); assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.horizonDays, horizon); assert.deepEqual(f.calls[0].payload.skus, [sku]);
});

for (const reorder of [true, false, null]) test(`inventory resolves original replenishment question with service result ${reorder}`, async () => {
  const f = fixture({ reorder }), conversationId = randomUUID();
  const first = await f.runtime.handle(req(), { message: '¿Debo reponer Coca-Cola?', conversationId });
  assert.equal(first.requiresClarification, true); assert.equal(f.calls.length, 0);
  const state = await f.runtime.getContextSnapshot(req(), conversationId);
  assert.equal(state.v3Context.pending.tasks[0].requestedIntent, 'replenishment');
  const result = await f.runtime.handle(req(), { message: sku, conversationId });
  assert.equal(result.code, null); assert.equal(result.agent, 'inventory'); assert.deepEqual(ids(result), ['coordinator', 'inventory']);
  assert.match(result.answer, reorder === true ? /Sí, debes reponer Coca-Cola/ : reorder === false ? /No necesitas reponer Coca-Cola/ : /recomendación de reposición.*no está disponible/);
  if (reorder === null) assert.doesNotMatch(result.answer, /No necesitas reponer/);
  assert.equal(result.actions[0].agentId, 'inventory'); assert.equal(result.evidence.length, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.flag, undefined, 'a detail decision must not filter false/unknown recommendations');
  assert.ok(result.v3Views[0].items.length); assert.equal(result.usage.totalLlmCalls, 0);
});

test('forecast owns tomorrow limitation and product model questions without fallback', async () => {
  const f = fixture();
  const tomorrow = await f.runtime.handle(req(), { message: '¿Por qué no puedes pronosticar mañana?' });
  assert.equal(tomorrow.agent, 'forecast'); assert.deepEqual(ids(tomorrow), ['coordinator', 'forecast']);
  assert.match(tomorrow.answer, /1 día no está aprobado/); assert.equal(f.calls.length, 0); assert.equal(tomorrow.actions.length, 0);
  const model = await f.runtime.handle(req(), { message: `¿Qué modelo se usa para ${sku}?` });
  assert.equal(model.agent, 'forecast'); assert.match(model.answer, /Modelo v1 · ACTIVE/);
});

for (const [question, pattern] of [[`¿Cuánto stock tengo de ${sku}?`, /El stock de .* es 14/],
  [`¿Cuál es la cobertura de ${sku}?`, /cobertura.*1.78 días/], ['¿Qué productos tienen riesgo alto?', /riesgo HIGH/]]) {
  test(`inventory owns ${question}`, async () => {
    const f = fixture(); const result = await f.runtime.handle(req(), { message: question });
    assert.equal(result.agent, 'inventory'); assert.deepEqual(ids(result), ['coordinator', 'inventory']);
    assert.match(result.answer, pattern); assert.equal(f.calls.length, 1);
  });
}

test('why replenishment uses sufficient inventory evidence without duplicate forecast request', async () => {
  const f = fixture(); const result = await f.runtime.handle(req(), { message: `¿Por qué debería reponer ${sku}?` });
  assert.equal(result.agent, 'inventory'); assert.match(result.answer, /posición de inventario es 14.*por debajo.*59/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].domain, 'inventory');
});

test('explicit inventory plus forecast composes only two specialists with the same SKU and snapshot', async () => {
  const f = fixture(); const result = await f.runtime.handle(req(), { message:
    `¿Cuánto stock tengo de ${sku} y cuánto venderemos de ${sku} en 14 días?` });
  assert.equal(result.code, null); assert.equal(result.agent, 'coordinator');
  assert.deepEqual(ids(result), ['coordinator', 'inventory', 'forecast']);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map(row => row.domain), ['inventory', 'forecast']);
  assert.deepEqual(f.calls.map(row => row.payload.skus), [[sku], [sku]]);
  assert.equal(f.calls[1].payload.horizonDays, 14);
  assert.equal(f.calls[0].payload.operationalSnapshot.metadata.snapshotHash, f.calls[1].payload.operationalSnapshot.metadata.snapshotHash);
  assert.equal(result.evidence.length, 2);
});

test('an explicit new question replaces pending intent rather than forcing old replenishment', async () => {
  const f = fixture(), conversationId = randomUUID();
  await f.runtime.handle(req(), { message: '¿Debo reponer Coca-Cola?', conversationId });
  const result = await f.runtime.handle(req(), { message: `¿Cuánto stock tengo de ${sku}?`, conversationId });
  assert.match(result.answer, /El stock de/); assert.doesNotMatch(result.answer, /Sí, debes reponer/);
  assert.equal(f.calls.length, 1);
});

test('specialists have domain-only skills and no action or training permissions', () => {
  const context = createAgentRequestContext(req());
  for (const [agentId, own, foreign] of [['forecast', 'get_product_forecast', 'get_inventory_intelligence'], ['inventory', 'get_inventory_intelligence', 'get_product_forecast']]) {
    assert.equal(getAgentDefinition(agentId).status, 'ACTIVE');
    assert.deepEqual(getAgentDefinition(agentId).allowedSkills, [own]);
    assert.throws(() => validateSkillInvocation({ context, agentId, skillId: foreign, args: {} }), { code: 'AGENT_SKILL_NOT_ALLOWED' });
    for (const skillId of ['create_sale', 'create_purchase', 'create_product', 'create_stock_alert_rule', 'adjust_stock', 'train', 'promote'])
      assert.throws(() => validateActionInvocation({ context, agentId, skillId, args: {} }));
  }
  for (const args of [{ mode: 'evaluation' }, { horizonDays: 1 }, { asOfDate: '2026-10-12' }])
    assert.throws(() => validateSkillInvocation({ context, agentId: 'forecast', skillId: 'get_product_forecast', args }), { code: 'AGENT_SKILL_NOT_ALLOWED' });
  for (const key of ['businessId', 'scenarioId', 'trustedForecastModelEnvelope'])
    assert.throws(() => validateSkillInvocation({ context, agentId: 'forecast', skillId: 'get_product_forecast', args: { [key]: 'FOREIGN' } }), { code: 'AGENT_INVALID_SKILL_ARGS' });
});

test('foreign-family attempts never dispatch a service or acquire ACTIVE artifacts', async () => {
  const f = fixture(); const execution = createAgentExecution({ context: createAgentRequestContext(req()), dependencies: { v3Service: f.service } });
  try {
    await assert.rejects(execution.executeSkill({ agentId: 'forecast', skillId: 'get_inventory_intelligence', args: { productRef: sku } }), { code: 'AGENT_SKILL_NOT_ALLOWED' });
    await assert.rejects(execution.executeSkill({ agentId: 'inventory', skillId: 'get_product_forecast', args: { productRef: sku, horizonDays: 7 } }), { code: 'AGENT_SKILL_NOT_ALLOWED' });
    assert.equal(f.calls.length, 0); assert.equal(f.scopes.length, 0);
  } finally { execution.finish(); }
});

test('an unsupported new forecast question clears an older pending selection', async () => {
  const f = fixture(), conversationId = randomUUID();
  await f.runtime.handle(req(), { message: '¿Debo reponer Coca-Cola?', conversationId });
  const result = await f.runtime.handle(req(), { message: '¿Por qué no puedes pronosticar mañana?', conversationId });
  assert.equal(result.agent, 'forecast'); assert.equal(f.calls.length, 0);
  const state = await f.runtime.getContextSnapshot(req(), conversationId);
  assert.equal(state.v3Context.pending, null);
});
