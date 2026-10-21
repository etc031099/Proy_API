'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { V3, createV3IntelligenceService } = require('../src/services/v3IntelligenceService');
const { createAgentRequestContext } = require('../src/agents/contracts');
const { createAgentExecution } = require('../src/agents/execution');
const { createAgentOrchestrator } = require('../src/agents/orchestrator');
const { createConversationMemory } = require('../src/agents/memory');
const { getSkillDefinition, SKILLS, validateSkillInvocation } = require('../src/agents/skills');
const { routeV3, renderV3 } = require('../src/agents/v3Routing');
const { createV3RidgeServingAuthority } = require('../src/services/v3RidgeServingAuthority');

const sku = 'BEB-GAS-001';
const req = () => ({ user: { _id: '507f1f77bcf86cd799439011', businessId: V3.businessId,
  role: 'user', isActive: true }, businessId: V3.businessId });
const clock = () => new Date('2026-10-20T17:00:00Z');
const query = row => ({ select() { return this; }, sort() { return this; }, limit() { return this; },
  lean() { return this; }, maxTimeMS() { return Promise.resolve(row); } });
function fixture({ unavailable = [], foreign = false, empty = false } = {}) {
  const calls = [], scopes = [];
  const models = {
    HistoricalScenario: { findOne: () => query({ businessId: V3.businessId, scenarioId: V3.scenarioId,
      status: 'completed', sourceSha256: V3.datasetSha256, metadata: { datasetVersion: V3.datasetVersion,
        referenceDate: V3.referenceDate, timezone: V3.timezone } }) },
    Product: { find: () => query([{ _id: '507f1f77bcf86cd799439012', sku, name: 'Coca-Cola' }]) }
  };
  const forecastRegistryService = { getActiveModelArtifact: async scope => {
    scopes.push(scope);
    if (unavailable.includes(scope.horizonDays)) return null;
    return { artifactData: Buffer.from('approved-test-artifact'), metadata: {
      ...scope, businessId: foreign ? 'FOREIGN' : scope.businessId, status: 'ACTIVE',
      modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', modelVersion: 2,
      featureVersion: 'RIDGE_CAUSAL27_V1', trainedDataVersion: '83', dataCutoff: '2026-10-15' } };
  } };
  const snapshotBuilder = async ({ businessId, asOfDate }) => ({ mode: 'LIVE', dataVersion: '177', snapshot: {
    metadata: { businessId, scenarioId: V3.scenarioId, asOfDate, dataVersion: '177',
      snapshotVersion: 'v3-operational-snapshot-v2', snapshotHash: 'f'.repeat(64),
      observationsClosedThrough: '2026-10-19', capturedAtUtc: clock().toISOString() } } });
  const mlClient = { intelligence: async (domain, payload) => {
    calls.push({ domain, payload });
    let data;
    if (domain === 'forecast') {
      assert.equal(payload.useLiveRidge, true, 'LIVE must never use the legacy forecast path');
      const active = payload.activeRidgeModel;
      data = { items: [{ sku, horizonDays: payload.horizonDays,
        status: active ? 'READY' : 'MODEL_UNAVAILABLE', reasonCode: active ? null : 'ACTIVE_MODEL_NOT_FOUND',
          predictionUnits: active ? payload.horizonDays + .5 : null,
        activeModelStatus: active ? 'ACTIVE' : 'NONE', modelFamily: 'RIDGE_REGRESSION',
        modelVersion: active?.metadata.modelVersion ?? null, featureVersion: 'RIDGE_CAUSAL27_V1',
        trainedDataVersion: '83', dataVersion: '177', observationsThrough: '2026-10-19' }], total: 1 };
    } else if (domain === 'inventory') {
      data = { availabilityStatus: 'PARTIAL', items: [{ sku, productName: 'Coca-Cola',
        stock: { onHand: 8, incoming: 0, inventoryPosition: 8 },
        coverage: { daysCover: null }, risk: { level: null },
        inventoryPolicy: { safetyStock: null, reorderPoint: null },
        recommendation: { status: 'PARTIAL', availabilityStatus: 'PARTIAL',
          reasonCode: 'FORECAST_HORIZON_UNAVAILABLE', shouldReorder: null, recommendedQty: null } }], total: 1 };
    } else if (domain === 'health') data = { businessHealth: { status: 'PARTIAL', inventory: { critical: null } } };
    else throw new Error('Unexpected ML domain');
    if (domain === 'forecast' && empty) data = { items: [], total: 0 };
    return { requestId: payload.requestId, status: domain === 'forecast' ? 'OK' : 'PARTIAL', data,
      metadata: { ...payload.context, source: 'HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT',
        contractVersion: 'm6.9f4-live-intelligence-v1', dataVersion: '177', snapshotHash: 'f'.repeat(64) } };
  } };
  const service = createV3IntelligenceService({ models, forecastRegistryService, mlClient, snapshotBuilder, clock });
  const invoke = async (skillId, args) => {
    const execution = createAgentExecution({ context: createAgentRequestContext(req()), dependencies: { v3Service: service } });
    try { return await execution.executeSkill({ agentId: 'analyst', skillId, args }); }
    finally { execution.finish(); }
  };
  return { service, invoke, calls, scopes };
}

for (const horizonDays of [7, 14]) test(`assistant real tool scores ${horizonDays}d using scoped ACTIVE Ridge and preserves lineage`, async () => {
  const f = fixture();
  const result = await f.invoke('get_product_forecast', { mode: 'detail', productRef: sku, horizonDays });
  assert.equal(result.data.method, 'RIDGE_REGRESSION');
  const row = result.data.items[0];
  assert.equal(row.predictionUnits, horizonDays + .5);
  assert.equal(row.modelVersion, 2); assert.equal(row.featureVersion, 'RIDGE_CAUSAL27_V1');
  assert.equal(row.dataVersion, '177'); assert.equal(row.observationsThrough, '2026-10-19');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.scopes, [{ businessId: V3.businessId, scenarioId: V3.scenarioId, horizonDays }]);
  assert.equal(f.calls[0].payload.activeRidgeModel.metadata.status, 'ACTIVE');
});

test('missing ACTIVE remains unavailable with no MA28 fallback or missing-to-zero conversion', async () => {
  const f = fixture({ unavailable: [7] });
  const result = await f.invoke('get_product_forecast', { mode: 'detail', productRef: sku, horizonDays: 7 });
  assert.equal(result.status, 'PARTIAL'); assert.equal(result.data.items[0].predictionUnits, null);
  assert.equal(result.data.items[0].status, 'MODEL_UNAVAILABLE');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.activeRidgeModel, null);
  assert.match(renderV3('get_product_forecast', result, { horizonDays: 7 }), /unidades no disponibles/);
});

test('an empty Ridge result stays NO_DATA rather than claiming READY', async () => {
  const f = fixture({ empty: true });
  const result = await f.invoke('get_product_forecast', { mode: 'detail', productRef: sku, horizonDays: 7 });
  assert.equal(result.status, 'NO_DATA'); assert.deepEqual(result.data.items, []);
  assert.equal(result.metadata.returnedCount, 0); assert.equal(f.calls.length, 1);
});

test('1d and global forecast without a product never request legacy inference', async () => {
  const f = fixture();
  await assert.rejects(f.invoke('get_product_forecast', { mode: 'detail', productRef: sku, horizonDays: 1 }),
    error => error.functionalCode === 'UNSUPPORTED_HORIZON');
  await assert.rejects(f.invoke('get_product_forecast', { mode: 'rank', horizonDays: 7 }),
    error => error.functionalCode === 'FORECAST_PRODUCT_REQUIRED');
  assert.equal(f.calls.length, 0); assert.equal(f.scopes.length, 0);
});

test('method and tomorrow copy expose Ridge 7/14 without approving 1d', async () => {
  const f = fixture();
  const result = await f.invoke('get_product_forecast', { mode: 'method' });
  assert.deepEqual(result.data.horizons, [7, 14]);
  assert.match(renderV3('get_product_forecast', result, {}), /Ridge Regression ACTIVE/);
  const plan = routeV3(`¿Cuál es el pronóstico de ${sku} mañana?`, {}, { ...V3, operationalDate: '2026-10-20' });
  assert.match(plan.clarificationQuestion, /1 día no está aprobado/);
  assert.equal(plan.tasks, undefined);
  assert.equal(f.calls.length, 0);
});

for (const skillId of ['get_inventory_intelligence', 'get_business_health']) test(`${skillId} receives the dashboard Ridge pair and preserves partial data`, async () => {
  const f = fixture({ unavailable: [14] });
  const result = await f.invoke(skillId, skillId.includes('inventory') ? { mode: 'detail', productRef: sku } : {});
  assert.equal(result.status, 'PARTIAL');
  assert.deepEqual(f.calls[0].payload.activeRidgeModels.map(model => model.metadata.horizonDays), [7]);
  assert.deepEqual(f.scopes.map(scope => scope.horizonDays), [7, 14]);
  if (skillId.includes('inventory')) {
    const row = result.data.items[0];
    assert.equal(row.stock.inventoryPosition, 8); assert.equal(row.stock.incoming, 0);
    assert.equal(row.coverage.daysCover, null); assert.equal(row.risk.level, null);
    assert.equal(row.recommendation.shouldReorder, null); assert.equal(row.recommendation.recommendedQty, null);
  }
});

test('real orchestrator maps the Coca-Cola 14d question to ACTIVE and tomorrow to clarification', async () => {
  const f = fixture();
  const runtime = createAgentOrchestrator({ memory: createConversationMemory(), clock,
    dependencies: { v3Service: f.service, clock } });
  const conversationId = randomUUID();
  const result = await runtime.handle(req(), { message: '¿Cuánto venderemos de Coca-Cola en 14 días?', conversationId });
  assert.equal(result.code, null); assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(f.calls[0]?.payload.horizonDays, 14);
  assert.equal(f.calls[0]?.payload.useLiveRidge, true);
  assert.match(result.answer, /Ridge LIVE · autoridad ACTIVE/);
  const tomorrow = await runtime.handle(req(), { message: '¿Cuál es su pronóstico mañana?', conversationId });
  assert.match(tomorrow.answer, /1 día no está aprobado/);
  assert.equal(f.calls.length, 1);
});

test('inventory cards preserve unknown reorder, risk and policy instead of asserting No or zero', async () => {
  const f = fixture();
  const runtime = createAgentOrchestrator({ memory: createConversationMemory(), clock,
    dependencies: { v3Service: f.service, clock } });
  const result = await runtime.handle(req(), { message: `Inventario de ${sku}` });
  assert.equal(result.code, null);
  assert.ok(result.v3Views?.[0]?.items?.[0], JSON.stringify(result));
  const metrics = result.v3Views[0].items[0].metrics;
  for (const label of ['Reponer', 'Riesgo', 'Stock de seguridad', 'Punto de reorden'])
    assert.equal(metrics.find(metric => metric.label === label)?.value, 'no disponible', label);
  assert.equal(metrics.find(metric => metric.label === 'Posición de inventario').value, 8);
});

test('tenant injection is rejected by the tool schema and foreign ACTIVE cannot reach ML', async () => {
  for (const key of ['businessId', 'scenarioId', 'useLiveRidge', 'trustedForecastModelEnvelope', 'trustedInventoryRidgeModels']) {
    assert.throws(() => validateSkillInvocation({ context: createAgentRequestContext(req()), agentId: 'analyst',
      skillId: 'get_product_forecast', args: { productRef: sku, [key]: 'FOREIGN' } }), { code: 'AGENT_INVALID_SKILL_ARGS' });
  }
  const f = fixture({ foreign: true });
  await assert.rejects(f.invoke('get_product_forecast', { mode: 'detail', productRef: sku, horizonDays: 7 }),
    error => error.code === 'AGENT_SKILL_EXECUTION_FAILED');
  assert.equal(f.calls.length, 0);
});

test('shared authority preserves both healthy horizons and isolates unavailable models', async () => {
  const f = fixture();
  await f.invoke('get_business_health', {});
  assert.deepEqual(f.calls[0].payload.activeRidgeModels.map(model => model.metadata.horizonDays), [7, 14]);
  const authority = createV3RidgeServingAuthority({ registry: { getActiveModelArtifact: async () => { throw new Error('Unavailable'); } } });
  assert.deepEqual(await authority.modelsFor({ businessId: V3.businessId, scenarioId: V3.scenarioId }), []);
});

test('unimplemented READ capabilities are absent from registry and tool declarations', () => {
  for (const id of ['get_inventory_summary', 'get_purchase_summary', 'get_supplier_details']) {
    assert.equal(SKILLS.some(skill => skill.id === id), false);
    assert.throws(() => getSkillDefinition(id), { code: 'AGENT_SKILL_NOT_FOUND' });
  }
});

test('grounded replenishment retains Ridge outputs and authorizes genuine unavailability', () => {
  const { buildGroundedContext } = require('../src/agents/groundedContext');
  const { buildAllowedLimitations } = require('../src/agents/groundedLimitations');
  const compact = buildGroundedContext({ question: '¿Por qué debo reponer?',
    plan: { skills: ['get_inventory_intelligence', 'get_product_forecast'], responseIntent: 'inventory_priorities' },
    binding: { operationalDate: '2026-10-20' }, results: [
      { skillId: 'get_inventory_intelligence', result: { status: 'READY', metadata: { dataMode: 'LIVE' },
        data: { items: [{ sku, stock: { onHand: 8, incoming: 0, inventoryPosition: 8 } }] } } },
      { skillId: 'get_product_forecast', result: { status: 'READY', metadata: { dataMode: 'LIVE' },
        data: { method: 'RIDGE_REGRESSION', horizonDays: 7, items: [{ sku, status: 'READY',
          predictionUnits: 12.5, modelVersion: 2, featureVersion: 'RIDGE_CAUSAL27_V1', dataVersion: '177' }] } } }
    ] });
  const prediction = compact.evidence.find(row => row.skillId === 'get_product_forecast').facts.items[0];
  assert.equal(prediction.predictionUnits, 12.5); assert.equal(prediction.modelVersion, 2);
  assert.equal(prediction.featureVersion, 'RIDGE_CAUSAL27_V1');
  assert.equal(buildAllowedLimitations([{ ref: 'E1', skillId: 'get_product_forecast', status: 'PARTIAL',
    facts: { items: [{ status: 'MODEL_UNAVAILABLE', predictionUnits: null }] } }])[0].code, 'FORECAST_UNAVAILABLE');
});
