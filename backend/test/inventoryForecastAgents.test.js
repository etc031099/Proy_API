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
const { withActionAssistant } = require('../src/automations/assistant');
const req = (businessId = V3.businessId) => ({ user: { _id: '507f1f77bcf86cd799439011', businessId, role: 'user', isActive: true }, businessId });
const clock = () => new Date('2026-10-20T17:00:00Z');
const sku = 'BEB-GAS-001';
const query = rows => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean() { return this; }, maxTimeMS() { return Promise.resolve(rows); } });
function fixture({ reorder = true, throughActions = false, neutralProvider, inventoryPartial = false } = {}) {
  const calls = [], scopes = [];
  const products = [{ _id: '507f1f77bcf86cd799439012', sku, name: 'Coca-Cola Sabor Original 500 ml' },
    { _id: '507f1f77bcf86cd799439013', sku: 'BEB-GAS-002', name: 'Coca-Cola Sin Azúcar 500 ml' }];
  const models = { HistoricalScenario: { findOne: () => query({ businessId: V3.businessId, scenarioId: V3.scenarioId,
    status: 'completed', sourceSha256: V3.datasetSha256, metadata: { datasetVersion: V3.datasetVersion, referenceDate: V3.referenceDate, timezone: V3.timezone } }) },
    Product: { find: filter => { assert.equal(filter.businessId, V3.businessId); return query(products); } },
    Contact: { find: () => query([]), findOne: () => query(null) } };
  const forecastRegistryService = { getActiveModelArtifact: async scope => {
    scopes.push(scope); return { artifactData: Buffer.from('approved-test-artifact'), metadata: { ...scope, status: 'ACTIVE',
      modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', modelVersion: 1, featureVersion: 'RIDGE_CAUSAL27_V1', trainedDataVersion: '83', dataCutoff: '2026-10-15' } };
  } };
  const snapshotBuilder = async ({ businessId, asOfDate }) => ({ mode: 'LIVE', dataVersion: '173', snapshot: { metadata: {
    businessId, scenarioId: V3.scenarioId, asOfDate, dataVersion: '173', snapshotVersion: 'v3-operational-snapshot-v2',
    snapshotHash: 'a'.repeat(64), observationsClosedThrough: '2026-10-19', capturedAtUtc: clock().toISOString() } } });
  const mlClient = { intelligence: async (domain, payload) => {
    calls.push({ domain, payload });
    const partial = domain === 'inventory' && (reorder === null || inventoryPartial);
    const inventoryRow = { sku, productName: products[0].name,
      stock: { onHand: 14, incoming: 0, inventoryPosition: 14 }, coverage: { daysCover: 1.78 }, risk: { level: 'HIGH' },
      inventoryPolicy: { configuredMinimumStock: 5, safetyStock: 8, reorderPoint: 59 },
      recommendation: { shouldReorder: reorder, recommendedQty: reorder === null ? null : reorder ? 102 : 0,
        ...(reorder === null ? { status: 'PARTIAL', availabilityStatus: 'PARTIAL', reasonCode: 'FORECAST_HORIZON_UNAVAILABLE' } : {}) } };
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
  const lookups = [], observedService = { ...service, resolveEntity: async (...args) => {
    lookups.push(args[1]); return service.resolveEntity(...args);
  } };
  const runtime = () => {
    const agent = createAgentOrchestrator({ memory: createConversationMemory(), clock, neutralProvider, dependencies: { v3Service: observedService, clock } });
    const denied = () => assert.fail('A read must never prepare or execute an action');
    return throughActions ? withActionAssistant(agent, { prepare: denied, get: denied, confirmPendingAction: denied,
      cancelPendingAction: denied }, { clock: Date.now }) : agent;
  };
  return { runtime: runtime(), restart: runtime, service, calls, scopes, lookups };
}
const ids = result => result.participants.map(row => row.agentId);

const nluValue = (intent, patch = {}) => ({ intent, productQuery: null, metric: null, period: null, quantity: null,
  horizonDays: null, needsClarification: false, clarificationReason: null, ...patch });
function semanticFixture(value = nluValue('AMBIGUOUS', { needsClarification: true, clarificationReason: 'MISSING_INTENT' }), { text, failure = false } = {}) {
  const requests = [];
  const provider = require('../src/agents/providers/deepseekProvider').createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'offline-only' },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (failure) throw Error('offline diagnostic failure');
      return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text ?? JSON.stringify(value) } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) };
    } });
  return { ...fixture({ throughActions: true, neutralProvider: provider }), requests, provider };
}

for (const [question, domains, technical] of [
  ['y esta en q cantidad se venderia en 2 semanas', ['forecast']],
  ['esta coca cola necesita reposicion? y en q cantidad se vendera de aqui a dos semanas?', ['inventory', 'forecast']],
  ['q modelo esta usando eso?', ['forecast'], true],
  ['esta misma cuanto venderia en dos semanas', ['forecast']],
  ['¿Considera que debería reponer este producto?', ['inventory']],
  ['¿En qué cantidad se vendería durante las próximas dos semanas?', ['forecast']],
  ['¿Cuánto cree que se venderá Coca-Cola Sabor Original 500 ml de aquí a 14 días?', ['forecast']],
  ['¿Ya debería reponerla y cuánto cree que se venda en 14 días?', ['inventory', 'forecast']],
  ['Ahora dime si ya debería reponerla.', ['inventory']],
  ['¿Cuánto vendería la Coca-Cola que elegimos en dos semanas?', ['forecast']]
]) test(`A4.6 clear context and cloud language remain deterministic with DeepSeek available: ${question}`, async () => {
  const f = semanticFixture(), conversationId = randomUUID();
  await f.runtime.handle(req(), { message: `pronóstico de ${sku} en 14 días`, conversationId });
  const result = await f.runtime.handle(req(), { message: question, conversationId });
  assert.equal(result.requiresClarification, false, result.answer);
  assert.deepEqual(f.calls.slice(1).map(row => row.domain), domains);
  assert.deepEqual(f.calls.slice(1).map(row => row.payload.skus), domains.map(() => [sku]));
  assert.equal(f.requests.length, 0); assert.equal(result.usage.totalLlmCalls, 0);
  assert.ok(!ids(result).includes('analyst')); assert.ok(!f.lookups.includes('aqui'));
  if (domains.includes('forecast')) assert.equal(f.calls.at(-1).payload.horizonDays, 14);
  if (technical) { assert.equal(result.requestedIntent, 'model_status'); assert.match(result.answer, /ACTIVE v1.*RIDGE_CAUSAL27_V1/); }
});

for (const choice of [sku, 'la primera nomás', '1']) test(`A4.6 exact/ordinal pending forecast resolves before NLU: ${choice}`, async () => {
  const f = semanticFixture(), conversationId = randomUUID();
  const first = await f.runtime.handle(req(), { message: '¿Cuánto venderemos de Coca-Cola en 14 días?', conversationId });
  assert.equal(first.requiresClarification, true);
  const result = await f.runtime.handle(req(), { message: choice, conversationId });
  assert.equal(result.agent, 'forecast'); assert.equal(result.actions.length, 1);
  assert.equal(f.requests.length, 0); assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(result.pendingAction, undefined);
});

for (const [message, intent, patch, domains] of [
  ['¿A cuánto podría ascender la salida de Coca-Cola en 14 días?', 'FORECAST', { productQuery: 'Coca-Cola', horizonDays: 14 }, ['forecast']],
  ['Valora si las existencias de Coca-Cola serán suficientes para seguir atendiendo', 'REPLENISHMENT', { productQuery: 'Coca-Cola' }, ['inventory']],
  ['Valora la reposición individual de Coca-Cola y cuánto potencial de salida tendría en 14 días', 'INVENTORY_FORECAST', { productQuery: 'Coca-Cola', horizonDays: 14 }, ['inventory', 'forecast']]
]) test(`A4.6 final structured fallback dispatches facts only through active skills: ${intent}`, async () => {
  const f = semanticFixture(nluValue(intent, patch)), conversationId = randomUUID();
  const first = await f.runtime.handle(req(), { message, conversationId });
  assert.equal(f.requests.length, 1, JSON.stringify({ answer: first.answer, intent: first.intent, lookups: f.lookups })); assert.equal(first.requiresClarification, true, first.answer);
  assert.equal(f.calls.length, 0);
  const state = snapshot(await f.runtime.getContextSnapshot(req(), conversationId));
  assert.equal(state.v3Context.pending.query, 'Coca-Cola');
  const restarted = f.restart(); await restarted.restoreContext(req(), conversationId, state);
  const result = await restarted.handle(req(), { message: sku, conversationId });
  assert.equal(f.requests.length, 1, 'selection must not classify a second time');
  assert.equal(result.usage.totalLlmCalls, 0);
  assert.deepEqual(f.calls.map(row => row.domain), domains);
  assert.equal(result.actions.length, domains.length);
  assert.ok(!ids(result).includes('analyst'));
  if (domains.includes('forecast')) assert.match(result.answer, /108.27 unidades.*14 días/);
  if (domains.includes('inventory')) assert.match(result.answer, /Stock actual: 14 unidades/);
  const projected = require('../src/services/agentHistoryProjection').publicResponse(first);
  assert.equal(projected.semanticClassification.calls, 1); assert.equal(projected.usage.totalLlmCalls, 1);
  assert.equal(projected.usage.totalTokens, 130); assert.equal(projected.semanticClassification.accepted, true);
  const coordinator = first.participants.find(row => row.agentId === 'coordinator');
  assert.equal(coordinator.llmCalls, 1); assert.ok(!ids(first).includes('analyst'));
});

test('A4.6 NLU classifies an elliptical reference but server context chooses the SKU, horizon and lineage', async () => {
  const f = semanticFixture(nluValue('FORECAST_MODEL_STATUS')), conversationId = randomUUID();
  await f.runtime.handle(req(), { message: `pronóstico de ${sku} en 14 días`, conversationId });
  const result = await f.runtime.handle(req(), { message: 'Detalla la identidad técnica de esa estimación', conversationId });
  assert.equal(f.requests.length, 1, JSON.stringify({ answer: result.answer, intent: result.intent, lookups: f.lookups })); assert.equal(result.requestedIntent, 'model_status');
  assert.match(result.answer, /ACTIVE v1.*RIDGE_CAUSAL27_V1.*14 días/);
  assert.deepEqual(f.calls.at(-1).payload.skus, [sku]);
  const context = JSON.parse(f.requests[0].messages[1].content).context;
  assert.equal(context.hasActiveProduct, true); assert.equal(context.lastProductTask.horizonDays, 14);
  assert.equal(context.lastProductTask.requestedIntent, 'forecast');
  assert.doesNotMatch(JSON.stringify(context), /BEB-GAS|Coca|businessId|scenario|userId|snapshot|stock/);
  assert.equal(result.usage.totalLlmCalls, 1); assert.equal(result.participants.find(row => row.agentId === 'forecast').skillCalls, 1);
});

test('A4.6 ambiguous pending context is described but cannot be selected by NLU', async () => {
  const f = semanticFixture(nluValue('FORECAST', { horizonDays: 14 })), conversationId = randomUUID();
  await f.runtime.handle(req(), { message: '¿Debo reponer Coca-Cola?', conversationId });
  const result = await f.runtime.handle(req(), { message: '¿A cuánto podría ascender la salida de esa en 14 días?', conversationId });
  assert.equal(f.requests.length, 1); assert.equal(result.requiresClarification, true); assert.equal(f.calls.length, 0);
  const context = JSON.parse(f.requests[0].messages[1].content).context;
  assert.equal(context.hasActiveProduct, false); assert.equal(context.pending.entityType, 'product');
  assert.deepEqual(context.pending.requestedIntents, ['replenishment']);
});

for (const invalid of [
  { ...nluValue('FORECAST'), stock: 999 },
  nluValue('FORECAST', { productQuery: 'INVENTADO-999' }),
  nluValue('FORECAST', { horizonDays: 7 }),
  nluValue('FORECAST', { needsClarification: true }),
  nluValue('DELETE_ALL'),
  { ...nluValue('FORECAST'), tasks: [{ skillId: 'train' }] }
]) test(`A4.6 invalid NLU cannot invent fields, targets, horizons or commands: ${JSON.stringify(invalid)}`, async () => {
  const f = semanticFixture(invalid);
  const result = await f.runtime.handle(req(), { message: '¿A cuánto podría ascender la salida de Coca-Cola en 14 días?' });
  assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0); assert.equal(result.requiresClarification, true);
  assert.equal(result.semanticClassification.accepted, false);
});

for (const options of [{ failure: true }, { text: 'not json' }]) test(`A4.6 provider uncertainty fails safely after one attempt: ${JSON.stringify(options)}`, async () => {
  const f = semanticFixture(undefined, options);
  const result = await f.runtime.handle(req(), { message: '¿A cuánto podría ascender la salida de Coca-Cola en 14 días?' });
  assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0); assert.equal(result.requiresClarification, true);
});

test('A4.6 truly ambiguous meaning asks for clarification and does not execute an interpretation', async () => {
  const f = semanticFixture();
  const result = await f.runtime.handle(req(), { message: '¿Debo actuar sobre esas existencias o revisar la salida?' });
  assert.equal(f.requests.length, 1); assert.equal(result.requiresClarification, true); assert.equal(f.calls.length, 0);
});

test('A4.6 compound schema rejects fan-out, distinct explicit SKUs and WRITE mixtures', () => {
  const { validateNlu } = require('../src/agents/languageNlu');
  for (const message of [
    'Stock de BEB-GAS-001 y forecast de BEB-GAS-002 en 14 días',
    'stock de Coca-Cola y forecast en 14 días y ventas de hoy',
    'stock de Coca-Cola y vende 2 unidades',
    'stock de Coca-Cola y confirma la compra'
  ]) assert.throws(() => validateNlu(JSON.stringify(nluValue('INVENTORY_FORECAST')), message), { code: 'NLU_SCHEMA_INVALID' });
  assert.equal(require('../src/agents/compositeRouting').writeClause('cuánto se espera vender en 14 días'), false);
  assert.equal(require('../src/agents/compositeRouting').writeClause('vende 2 Coca-Cola'), true);
});

test('A4.6 an uncertain sufficiency question uses one NLU and the active inventory skill', async () => {
  const f = semanticFixture(nluValue('REPLENISHMENT')), conversationId = randomUUID();
  await f.runtime.handle(req(), { message: `pronóstico de ${sku} en 14 días`, conversationId });
  const result = await f.runtime.handle(req(), { message: '¿Me alcanzará el stock considerando lo que se espera vender?', conversationId });
  assert.equal(f.requests.length, 1); assert.equal(result.agent, 'inventory');
  assert.equal(result.actions.length, 1); assert.match(result.answer, /Stock actual: 14 unidades/);
  assert.deepEqual(f.calls.at(-1).payload.skus, [sku]); assert.equal(result.pendingAction, undefined);
});

test('A4.6 methodology NLU remains distinct from numerical forecast and uses the existing method skill', async () => {
  const f = semanticFixture(nluValue('FORECAST_METHOD'));
  const result = await f.runtime.handle(req(), { message: 'Describe cómo se obtiene la estimación de demanda' });
  assert.equal(f.requests.length, 1); assert.equal(result.agent, 'forecast');
  assert.equal(result.requestedIntent, 'method'); assert.equal(result.actions[0].skillId, 'get_product_forecast');
  assert.match(result.answer, /Ridge Regression/); assert.equal(f.calls.length, 0);
});

test('A4.6 NLU cannot ignore a different explicit entity in favor of the active product', () => {
  const { nluPlan, validateNlu } = require('../src/agents/languageNlu');
  const plan = nluPlan(nluValue('FORECAST'), '¿A cuánto ascendería la salida de Pepsi en 14 días?',
    { selectedProduct: { key: sku }, lastFamily: 'get_product_forecast' }, { operationalDate: '2026-10-20' });
  assert.ok(plan.clarificationQuestion); assert.equal(plan.tasks, undefined);
  assert.throws(() => validateNlu(JSON.stringify(nluValue('FORECAST', { productQuery: 'aqui' })),
    'cuánto saldría de aqui a dos semanas'), { code: 'NLU_SCHEMA_INVALID' });
});

test('A4.6 execution enforces one NLU call even if a caller attempts another', async () => {
  const f = semanticFixture(), execution = createAgentExecution({ context: createAgentRequestContext(req()),
    neutralProvider: f.provider, dependencies: { v3Service: f.service } });
  try {
    await execution.generateSemantic({ maxTokens: 300, temperature: 0, messages: [{ role: 'user', content: 'offline test' }] });
    await assert.rejects(execution.generateSemantic({ messages: [] }), { code: 'AGENT_INVALID_REQUEST' });
    assert.equal(f.requests.length, 1);
  } finally { execution.finish(); }
});

test('A4.6 an unavailable NLU leaves uncertain active-domain language as a safe clarification', async () => {
  const f = fixture({ throughActions: true });
  const result = await f.runtime.handle(req(), { message: '¿A cuánto podría ascender la salida en 14 días?' });
  assert.equal(result.requiresClarification, true); assert.equal(f.calls.length, 0);
  assert.equal(result.usage.totalLlmCalls, 0);
});

for (const question of [
  'debo reponer coca cola o todavia aguanta?',
  'coca cola ya toca reponer?', 'coca cola todavía aguanta?',
  'crees que debo comprar más coca cola?', 'me alcanza la coca cola o repongo?',
  '¿Crees que ya debería reponer Coca-Cola?', '¿Considera que debería reponer Coca-Cola?',
  'cuanto stock me qeda de coca cola y si ya deberia comprar mas'
]) test(`A4.5 human replenishment isolates the product and retains its pending decision: ${question}`, async () => {
  const f = fixture({ throughActions: true }), conversationId = randomUUID();
  const first = await f.runtime.handle(req(), { message: question, conversationId });
  assert.equal(first.requiresClarification, true, first.answer);
  const state = snapshot(await f.runtime.getContextSnapshot(req(), conversationId));
  assert.equal(state.v3Context.pending.tasks[0].requestedIntent, 'replenishment');
  assert.equal(state.v3Context.pending.query.toLowerCase().replace(/-/g, ' '), 'coca cola');
  const restarted = f.restart(); await restarted.restoreContext(req(), conversationId, state);
  const result = await restarted.handle(req(), { message: sku, conversationId });
  assert.equal(result.agent, 'inventory'); assert.equal(result.actions.length, 1);
  assert.match(result.answer, /Sí, debes reponer Coca-Cola/);
  assert.match(result.answer, /Stock actual: 14 unidades/);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].payload.skus, [sku]);
  assert.equal(result.usage.totalLlmCalls, 0);
});

for (const question of [
  'masomenos cuanto coca cola voy a vender en 14 dias',
  'cuánto crees que venda coca cola en 14 días',
  'cuánto se vendería coca cola de aquí a 14 días',
  'más o menos cuánto saldrá coca cola en dos semanas',
  'qué cantidad crees que vendamos de coca cola en dos semanas',
  '¿Cuánto cree que se venderá Coca-Cola en 14 días?',
  '¿Cuánto crees que se venda Coca-Cola de aquí a 14 días?'
]) test(`A4.5 human forecast retains 14 days through product selection: ${question}`, async () => {
  const f = fixture({ throughActions: true }), conversationId = randomUUID();
  const first = await f.runtime.handle(req(), { message: question, conversationId });
  assert.equal(first.requiresClarification, true, first.answer);
  const state = snapshot(await f.runtime.getContextSnapshot(req(), conversationId));
  assert.equal(state.v3Context.pending.query.toLowerCase().replace(/-/g, ' '), 'coca cola');
  assert.equal(state.v3Context.pending.tasks[0].requestedIntent, 'forecast');
  assert.equal(state.v3Context.pending.tasks[0].args.horizonDays, 14);
  const result = await f.runtime.handle(req(), { message: sku, conversationId });
  assert.equal(result.agent, 'forecast'); assert.match(result.answer, /Se esperan 108.27 unidades.*14 días/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.horizonDays, 14);
  assert.equal(result.usage.totalLlmCalls, 0);
});

for (const [question, domains, technical] of [
  ['y esa coca cuanto crees q salga en estas 2 semanas', ['forecast']],
  ['¿Y esa misma Coca-Cola cuánto vendería en dos semanas?', ['forecast']],
  ['esa misma cuánto vendería en 14 días', ['forecast']],
  ['y esa cuánto tiene de stock', ['inventory']],
  ['ya toca reponerla?', ['inventory']],
  ['q modelo esta usando eso?', ['forecast'], true],
  ['¿Qué modelo usa ese pronóstico?', ['forecast'], true],
  ['¿Qué modelo utiliza este pronóstico?', ['forecast'], true],
  ['qué modelo usa eso?', ['forecast'], true],
  ['ya pero ahora dime si tengo q reponerla', ['inventory']],
  ['esa coca ya toca reponerla? y cuanto crees q venda en 14 dias', ['inventory', 'forecast']],
  ['¿Esa Coca-Cola ya debería reponerse y cuánto se venderá en 14 días?', ['inventory', 'forecast']],
  ['¿Esta Coca-Cola necesita reposición y cuánto se venderá en dos semanas?', ['inventory', 'forecast']],
  ['¿Me alcanza el stock y cuánto se espera vender en dos semanas?', ['inventory', 'forecast']],
  ['¿Ya debo reponerla? Además, ¿cuánto venderemos en 14 días?', ['inventory', 'forecast']]
]) test(`A4.5 human follow-up uses only the active product and explicit intent: ${question}`, async () => {
  const f = fixture({ throughActions: true }), conversationId = randomUUID();
  await f.runtime.handle(req(), { message: `¿Cuánto venderemos de ${sku} en 14 días?`, conversationId });
  const result = await f.runtime.handle(req(), { message: question, conversationId });
  assert.equal(result.requiresClarification, false, result.answer);
  assert.deepEqual(f.calls.slice(1).map(call => call.domain), domains);
  assert.deepEqual(f.calls.slice(1).map(call => call.payload.skus), domains.map(() => [sku]));
  assert.equal(result.actions.length, domains.length); assert.equal(result.usage.totalLlmCalls, 0);
  const forecast = f.calls.slice(1).find(call => call.domain === 'forecast');
  if (forecast) assert.equal(forecast.payload.horizonDays, 14);
  if (technical) { assert.equal(result.requestedIntent, 'model_status'); assert.match(result.answer, /modelo ACTIVE v1.*featureVersion RIDGE_CAUSAL27_V1/); }
  if (domains.includes('inventory') && !question.includes('stock')) assert.match(result.answer, /Sí, debes reponer/);
});

test('A4.5 ordinal selection is not a quantity and ambiguity never adopts a previous product', async () => {
  const f = fixture({ throughActions: true }), conversationId = randomUUID();
  await f.runtime.handle(req(), { message: '¿Cuánto crees que venda coca cola en 14 días?', conversationId });
  const selected = await f.runtime.handle(req(), { message: 'la primera nomas', conversationId });
  assert.equal(selected.agent, 'forecast'); assert.equal(selected.actions.length, 1);
  assert.deepEqual(f.calls[0].payload.skus, [sku]); assert.equal(f.calls[0].payload.horizonDays, 14);
  assert.equal(selected.pendingAction, undefined);
  await f.runtime.handle(req(), { message: '¿Debo reponer coca cola?', conversationId });
  const before = f.calls.length;
  const ambiguous = await f.runtime.handle(req(), { message: 'esa misma cuánto vendería en 14 días', conversationId });
  assert.equal(ambiguous.requiresClarification, true); assert.equal(f.calls.length, before);
});

test('A4.5 a different explicit SKU overrides active context; a mismatched contextual hint cannot borrow it', async () => {
  const f = fixture({ throughActions: true }), conversationId = randomUUID();
  await f.runtime.handle(req(), { message: `pronóstico de ${sku} en 14 días`, conversationId });
  await f.runtime.handle(req(), { message: '¿Cuánto cree que se venderá BEB-GAS-002 en dos semanas?', conversationId });
  assert.deepEqual(f.calls.at(-1).payload.skus, ['BEB-GAS-002']);
  const count = f.calls.length;
  const unknown = await f.runtime.handle(req(), { message: 'esa pepsi cuánto vendería en 14 días', conversationId });
  assert.equal(f.calls.length, count); assert.equal(unknown.requiresClarification, true);
  assert.equal(f.lookups.at(-1), 'pepsi');
});

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
  assert.equal(model.agent, 'forecast'); assert.match(model.answer, /modelo ACTIVE v1/);
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

test('P0 shared-product cloud wording executes inventory and forecast once, preserving direct conclusions and history', async () => {
  const f = fixture(); const result = await f.runtime.handle(req(), { message:
    'Para Coca-Cola Sabor Original 500 ml, explícame si debo reponerla y también cuánto se espera vender en 14 días.' });
  assert.equal(result.code, null);
  assert.deepEqual(ids(result), ['coordinator', 'inventory', 'forecast']);
  assert.deepEqual(f.calls.map(row => row.domain), ['inventory', 'forecast']);
  assert.deepEqual(f.calls.map(row => row.payload.skus), [[sku], [sku]]);
  assert.equal(f.calls[1].payload.horizonDays, 14);
  assert.equal(f.calls[0].payload.operationalSnapshot.metadata.snapshotHash, f.calls[1].payload.operationalSnapshot.metadata.snapshotHash);
  assert.match(result.answer, /Sí, debes reponer Coca-Cola Sabor Original 500 ml/);
  assert.match(result.answer, /Se esperan 108.27 unidades.*14 días/);
  const restored = require('../src/services/agentHistoryProjection').publicResponse(JSON.parse(JSON.stringify(result)));
  assert.equal(restored.answer, result.answer);
  assert.deepEqual(restored.v3Views, result.v3Views);
  assert.deepEqual(ids(restored), ids(result));
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

for (const question of [
  '¿Qué modelo y versión está usando el pronóstico de Coca-Cola en 14 días?',
  '¿Cuál es el featureVersion del pronóstico de Coca-Cola en 14 días?'
]) test(`A4.3 technical intent survives candidate selection and persisted history: ${question}`, async () => {
  const f = fixture(), conversationId = randomUUID();
  const first = await f.runtime.handle(req(), { message: question, conversationId });
  assert.equal(first.requiresClarification, true); assert.equal(f.calls.length, 0);
  const state = JSON.parse(JSON.stringify(snapshot(await f.runtime.getContextSnapshot(req(), conversationId))));
  assert.equal(state.v3Context.pending.tasks[0].requestedIntent, 'model_status');
  assert.equal(state.v3Context.pending.tasks[0].args.horizonDays, 14);
  assert.equal(state.v3Context.pending.query, 'Coca-Cola');
  const resumed = f.restart(); await resumed.restoreContext(req(), conversationId, state);
  const result = await resumed.handle(req(), { message: sku, conversationId });
  assert.equal(result.agent, 'forecast'); assert.equal(result.requestedIntent, 'model_status');
  assert.deepEqual(ids(result), ['coordinator', 'forecast']);
  assert.equal(result.actions.length, 1); assert.equal(result.actions[0].skillId, 'get_product_forecast');
  assert.match(result.answer, /^El pronóstico de Coca-Cola Sabor Original 500 ml utiliza Ridge LIVE con el modelo ACTIVE v1/);
  assert.match(result.answer, /featureVersion RIDGE_CAUSAL27_V1/); assert.match(result.answer, /horizonte consultado es de 14 días/);
  assert.doesNotMatch(result.answer, /^Se esperan/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.horizonDays, 14);
  assert.deepEqual(f.calls[0].payload.skus, [sku]);
  const restored = require('../src/services/agentHistoryProjection').publicResponse(JSON.parse(JSON.stringify(result)));
  assert.equal(restored.requestedIntent, 'model_status'); assert.equal(restored.answer, result.answer);
});

for (const question of ['¿Qué versión está usando?', '¿Cuál es el featureVersion?', '¿Hasta qué fecha están cerradas las observaciones?'])
  test(`A4.3 technical follow-up reuses the selected product and horizon: ${question}`, async () => {
    const f = fixture(), conversationId = randomUUID();
    await f.runtime.handle(req(), { message: `¿Cuánto venderemos de ${sku} en 14 días?`, conversationId });
    const result = await f.runtime.handle(req(), { message: question, conversationId });
    assert.equal(result.agent, 'forecast'); assert.equal(result.requestedIntent, 'model_status');
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].payload.horizonDays, 14);
    assert.deepEqual(f.calls[1].payload.skus, [sku]); assert.match(result.answer, /modelo ACTIVE v1/);
    assert.match(result.answer, /Revisión de datos: 173/); assert.match(result.answer, /Observaciones cerradas hasta: 2026-10-19/);
    const metrics = result.v3Views[0].items[0].metrics;
    assert.equal(metrics.find(metric => metric.label === 'Observaciones cerradas hasta').value, '2026-10-19');
  });

test('A4.3 value, methodology and unavailable horizon keep their own semantics', async () => {
  const f = fixture();
  const value = await f.runtime.handle(req(), { message: `¿Cuánto venderemos de ${sku} en 14 días?` });
  assert.equal(value.requestedIntent, 'forecast'); assert.match(value.answer, /^Se esperan 108.27 unidades/);
  const method = await f.runtime.handle(req(), { message: '¿Qué metodología usa el pronóstico?' });
  assert.equal(method.agent, 'forecast'); assert.equal(method.requestedIntent, 'method');
  assert.match(method.answer, /Ridge Regression ACTIVE/);
  const unavailable = await f.runtime.handle(req(), { message: '¿Por qué no hay pronóstico de 1 día?' });
  assert.equal(unavailable.agent, 'forecast'); assert.match(unavailable.answer, /1 día no está aprobado/);
  assert.equal(f.calls.length, 1);
});

for (const connector of ['y', 'y también', 'además', 'junto con', 'a la vez', 'por otro lado'])
  test(`A4.3 shared-product composition accepts ${connector} with one resolution and skill per specialist`, async () => {
    const f = fixture();
    const result = await f.runtime.handle(req(), { message:
      `Para Coca-Cola Sabor Original 500 ml, explícame si debo reponerla ${connector} cuánto se espera vender en 14 días.` });
    assert.equal(result.requiresClarification, false); assert.equal(result.code, null);
    assert.deepEqual(ids(result), ['coordinator', 'inventory', 'forecast']);
    assert.deepEqual(result.actions.map(action => [action.agentId, action.skillId]),
      [['inventory', 'get_inventory_intelligence'], ['forecast', 'get_product_forecast']]);
    assert.deepEqual(f.calls.map(call => call.domain), ['inventory', 'forecast']);
    assert.deepEqual(f.calls.map(call => call.payload.skus), [[sku], [sku]]);
    assert.equal(f.calls[1].payload.horizonDays, 14);
    assert.equal(f.lookups.filter(ref => ref === 'Coca-Cola Sabor Original 500 ml').length, 1);
    assert.match(result.answer, /Sí, debes reponer/); assert.match(result.answer, /Se esperan 108.27 unidades/);
  });

test('A4.3 ambiguous shared entity is selected once for both tasks, including after restart', async () => {
  const f = fixture(), conversationId = randomUUID();
  const first = await f.runtime.handle(req(), { message:
    'Para Coca-Cola, explícame si debo reponerla y cuánto se espera vender en 14 días.', conversationId });
  assert.equal(first.requiresClarification, true); assert.equal(f.calls.length, 0);
  const state = JSON.parse(JSON.stringify(snapshot(await f.runtime.getContextSnapshot(req(), conversationId))));
  assert.equal(state.v3Context.pending.tasks.length, 2);
  const resumed = f.restart(); await resumed.restoreContext(req(), conversationId, state);
  const result = await resumed.handle(req(), { message: sku, conversationId });
  assert.equal(result.requiresClarification, false); assert.deepEqual(ids(result), ['coordinator', 'inventory', 'forecast']);
  assert.deepEqual(f.calls.map(call => call.payload.skus), [[sku], [sku]]); assert.equal(result.actions.length, 2);
});

for (const question of [
  `¿Cuánto stock tengo de ${sku} y cuánto venderemos de BEB-GAS-002 en 14 días?`,
  `¿Cuánto stock tengo de ${sku} y cuánto venderemos de ese producto en 14 días?`
]) test(`A4.3 separate or ambiguous product clauses remain safe: ${question}`, async () => {
  const f = fixture(); const result = await f.runtime.handle(req(), { message: question });
  assert.equal(result.requiresClarification, true); assert.equal(f.calls.length, 0); assert.equal(result.actions.length, 0);
});

test('A6.1 stock plus implicit forecast resolves one shared candidate for both specialists after restart', async () => {
  const f = fixture({ throughActions: true }), conversationId = randomUUID();
  const first = await f.runtime.handle(req(), { message:
    'cuánto stock tengo de coca cola y cuánto se venderá en 14 días?', conversationId });
  assert.equal(first.requiresClarification, true); assert.ok(first.suggestions.length >= 2);
  assert.equal(first.usage.totalLlmCalls, 0); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.lookups, ['coca cola']);
  const state = JSON.parse(JSON.stringify(snapshot(await f.runtime.getContextSnapshot(req(), conversationId))));
  assert.deepEqual(state.v3Context.pending.tasks.map(row => row.args.productRef), ['coca cola', 'coca cola']);
  const resumed = f.restart(); await resumed.restoreContext(req(), conversationId, state);
  const result = await resumed.handle(req(), { message: sku, conversationId });
  assert.equal(result.requiresClarification, false);
  assert.deepEqual(ids(result), ['coordinator', 'inventory', 'forecast']);
  assert.deepEqual(result.actions.map(row => row.skillId), ['get_inventory_intelligence', 'get_product_forecast']);
  assert.deepEqual(f.calls.map(row => row.payload.skus), [[sku], [sku]]);
  assert.equal(f.calls[1].payload.horizonDays, 14); assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(f.lookups.filter(ref => ref === 'coca cola').length, 1);
});

test('A6.1 shared contextual replenishment and two-week forecast retain the selected product', async () => {
  const f = fixture({ throughActions: true }), conversationId = randomUUID();
  await f.runtime.handle(req(), { message: `stock de ${sku}`, conversationId });
  f.calls.length = 0; f.lookups.length = 0;
  const result = await f.runtime.handle(req(), { message:
    'esta coca cola necesita reposición y cuánto venderá en dos semanas?', conversationId });
  assert.equal(result.requiresClarification, false);
  assert.deepEqual(ids(result), ['coordinator', 'inventory', 'forecast']);
  assert.deepEqual(f.calls.map(row => row.payload.skus), [[sku], [sku]]);
  assert.equal(f.calls[1].payload.horizonDays, 14); assert.equal(result.usage.totalLlmCalls, 0);
  assert.equal(f.lookups.length, 0);
});

for (const question of ['con todo lo que sabes de coca cola, qué harías?', 'qué harías con esta coca cola?',
  'viendo lo q tengo y lo q probablemente venda q hago con coca?',
  'según los datos que tienes de coca cola, explícame en palabras simples si debería preocuparme por este producto y por qué'])
  test(`A6.2 open product interpretation shares resolver and produces one grounded answer: ${question}`, async () => {
    const requests = [];
    const neutralProvider = require('../src/agents/providers/deepseekProvider').createDeepSeekProvider({ env: { DEEPSEEK_API_KEY: 'offline-only' },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body); requests.push(body);
        assert.equal(body.tools, undefined);
        const context = JSON.parse(body.messages[1].content);
        assert.deepEqual(context.evidence.map(row => row.skillId), ['get_inventory_intelligence', 'get_product_forecast']);
        assert.ok(context.evidence.every(row => row.facts.items.every(item => item.sku === sku)));
        return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ observations: [
          { evidenceRefs: ['E1', 'E2'], interpretation: 'Coca-Cola tiene stock 14 y riesgo alto.', advisoryRecommendation: 'Revisa su reposición con el pronóstico disponible; la cantidad sugerida es 102.' }
        ], limitations: [] }) } }], usage: { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460,
          prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 400 } }) };
      } });
    const f = fixture({ throughActions: true, neutralProvider, inventoryPartial: true }), conversationId = randomUUID();
    let result = await f.runtime.handle(req(), { message: question, conversationId });
    assert.equal(result.requiresClarification, true); assert.equal(requests.length, 0); assert.equal(f.calls.length, 0);
    const state = snapshot(await f.runtime.getContextSnapshot(req(), conversationId));
    assert.equal(state.v3Context.pending.responseMode, 'grounded-product');
    const resumed = f.restart(); await resumed.restoreContext(req(), conversationId, state);
    result = await resumed.handle(req(), { message: sku, conversationId });
    assert.equal(result.requiresClarification, false, result.answer);
    assert.equal(requests.length, 1); assert.equal(result.usage.totalLlmCalls, 1);
    assert.equal(result.usage.totalTokens, 460); assert.equal(result.groundedAnswer.accepted, true);
    assert.equal(result.grounded.generation.status, 'SUCCEEDED');
    assert.equal(result.semanticClassification, undefined);
    assert.deepEqual(f.calls.map(row => row.domain), ['inventory', 'forecast']);
    assert.deepEqual(ids(result), ['coordinator', 'inventory', 'forecast', 'analyst']);
    assert.match(result.answer, /stock 14/); assert.match(result.answer, /102/);
    assert.equal((await resumed.getContextSnapshot(req(), conversationId)).v3Context.selectedProduct.key, sku);
  });

test('A4.3 shared-product grammar does not consume unrelated, historical, write or cross-product clauses', () => {
  const { sharedProductPlan, specialistPlan } = require('../src/agents/specialistRouting');
  for (const question of [
    'Para Coca-Cola y Pepsi, explícame si debo reponerla y cuánto se espera vender en 14 días.',
    'Para Coca-Cola, explícame si debo reponerla y cuánto se espera vender de Pepsi en 14 días.',
    'Para Coca-Cola, explícame si debo reponerla y registra una venta en 14 días.',
    'Para Coca-Cola, explícame si debo reponerla y cuánto se espera vender en 1 día.',
    'Para Coca-Cola, explícame si debo reponerla y compara el histórico en 14 días.'
  ]) assert.equal(sharedProductPlan(question), null);
  assert.equal(specialistPlan('¿Qué modelo y ventas hay hoy?'), null);
  assert.equal(specialistPlan('¿Qué versión usa la aplicación?'), null);
  assert.equal(specialistPlan('¿Qué revisión tiene el proveedor?'), null);
});
