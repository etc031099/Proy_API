const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { actionIntent, parseAction, resolveAction } = require('../src/automations/actionInput');
const { withActionAssistant, resultAnswer } = require('../src/automations/assistant');
const { createActionContext, validateArgs } = require('../src/automations/contracts');
const { getActionSkill } = require('../src/automations/skills');
const { publicResponse } = require('../src/services/agentHistoryProjection');
const { createActionExecutors } = require('../src/automations/executors');
const { Product } = require('../src/models');
const Rule = require('../src/models/StockAlertRule');
const id = 'bbbbbbbbbbbbbbbbbbbbbbbb', sku = 'M5-FOODS_3_511';
const req = { businessId: 'A', user: { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessId: 'A', role: 'user', isActive: true } };
const resolver = async (model, context, ref) => { assert.equal(context.businessId, 'A'); return { value: { _id: id, sku, name: 'Producto demo', isActive: true } }; };
for (const [message, operator, threshold] of [
  [`Crea una alerta de inventario para ${sku} cuando el stock sea menor o igual a 3 unidades.`, '<=', 3],
  [`Avísame si ${sku} baja de 5 unidades.`, '<', 5],
  [`Avísame cuando ${sku} tenga 3 o menos.`, '<=', 3],
  [`Avísame cuando ${sku} tenga 3 unidades o menos.`, '<=', 3],
  [`Configura una alerta para ${sku} si baja de 5.`, '<', 5],
  [`Quiero una alerta de stock para ${sku} cuando llegue a 2.`, '<=', 2],
  [`Crea una alerta para ${sku} cuando el stock sea menor que 0`, '<', 0],
  [`Crea una alerta para ${sku} cuando el stock sea menos de 3`, '<', 3]
]) test(`stock rule deterministic parse: ${message}`, async () => {
  assert.equal(actionIntent(message), 'create_stock_alert_rule');
  const parsed = parseAction(message, actionIntent(message));
  assert.deepEqual(parsed.items, [{ ref: sku }]); assert.equal(parsed.operator, operator); assert.equal(parsed.threshold, threshold);
  assert.deepEqual((await resolveAction(parsed, createActionContext(req), resolver)).args, { productId: id, operator, threshold });
});
test('missing/unsupported/invalid conditions clarify without LLM or incomplete pending', async () => {
  let prepares = 0;
  const adapter = withActionAssistant({}, { prepare() { prepares++; throw Error('must not prepare'); } }, { resolver });
  for (const suffix of ['', 'stock mayor que 3', 'stock menor que -1', 'stock menor que 1.5', 'stock menor que 1000001']) {
    const response = await adapter.handle(req, { conversationId: randomUUID(), message: `Crea una alerta para ${sku} ${suffix}` });
    assert.equal(response.requiresClarification, true); assert.equal(response.usage.totalTokens, 0); assert.equal(response.usage.totalLlmCalls, 0);
  }
  assert.equal(prepares, 0);
});
test('guided condition, product candidates and context resolve without Gemini; explicit SKU wins', async () => {
  const calls = [];
  const service = { prepare: async value => { calls.push(value.args); return { pendingActionId: randomUUID(), summary: 'Regla', status: 'PENDING' }; } };
  const ambiguousResolver = async (model, ctx, ref) => ref === 'agua' ? { clarification: 'Elige producto', candidates: [{ _id: id, name: 'Agua', sku }] } : resolver(model, ctx, ref);
  const adapter = withActionAssistant({ getContextSnapshot: async () => ({ lastEntity: { type: 'product', id, sku } }) }, service, { resolver: ambiguousResolver });
  const conversationId = randomUUID();
  await adapter.handle(req, { conversationId, message: `Crea una alerta para ${sku}` });
  const next = await adapter.handle(req, { conversationId, message: 'menor o igual a 3' }); assert.equal(next.usage.totalTokens, 0);
  const other = randomUUID();
  const candidates = await adapter.handle(req, { conversationId: other, message: 'Crea una alerta para agua cuando llegue a 2' });
  assert.equal(candidates.suggestions.length, 1);
  await adapter.handle(req, { conversationId: other, message: '1' }); assert.equal(calls[1].threshold, 2);
  await adapter.handle(req, { conversationId: randomUUID(), message: 'Crea una alerta cuando el stock sea menor que 4' });
  assert.equal(calls[2].productId, id);
  let reference;
  const explicit = withActionAssistant({ getContextSnapshot() { throw Error('explicit must win'); } }, service,
    { resolver: async (model, ctx, ref) => { reference = ref; return resolver(model, ctx, ref); } });
  await explicit.handle(req, { conversationId: randomUUID(), message: `Crea una alerta para ${sku} stock menor que 5` }); assert.equal(reference, sku);
});
test('rule contract is closed, bounded, confirmable and separate from automatic events', () => {
  const skill = getActionSkill('create_stock_alert_rule'); assert.equal(skill.requiresConfirmation, true);
  assert.equal(getActionSkill('create_inventory_alert').riskLevel, 'SAFE_AUTOMATIC');
  const args = { productId: id, operator: '<=', threshold: 3 };
  for (const threshold of [-1, 1.5, 1000001]) assert.throws(() => validateArgs(skill.inputSchema, { ...args, threshold }));
  for (const key of ['businessId', 'userId', 'enabled', 'createdBy']) assert.throws(() => validateArgs(skill.inputSchema, { ...args, [key]: 'A' }));
  assert.throws(() => validateArgs(skill.inputSchema, { ...args, operator: '>' }));
  const index = Rule.schema.indexes().find(([fields]) => fields.threshold);
  assert.equal(index[1].unique, true); assert.deepEqual(index[1].partialFilterExpression, { enabled: true });
});
test('missing or ambiguous conversation product asks instead of choosing a list member', async () => {
  for (const state of [{}, { lastEntity: { id, sku }, recentEntities: [{ id }, { id: 'cccccccccccccccccccccccc' }] }]) {
    const adapter = withActionAssistant({ getContextSnapshot: async () => state }, { prepare() { throw Error('no preparation'); } }, { resolver });
    const result = await adapter.handle(req, { conversationId: randomUUID(), message: 'Crea una alerta cuando el stock sea menor o igual a 3' });
    assert.equal(result.requiresClarification, true); assert.match(result.answer, /SKU/);
    assert.equal(result.usage.totalLlmCalls, 0); assert.equal(result.usage.totalTokens, 0);
  }
});
test('cross-tenant rule requests go to the existing F9 denial before any resolution', async () => {
  let denied = 0;
  const adapter = withActionAssistant({ handle: async () => { denied++; return { intent: 'tenant_access_denied' }; } },
    { prepare() { throw Error('no writes'); } }, { resolver() { throw Error('no reads'); } });
  const result = await adapter.handle(req, { message: `Crea una alerta para ${sku} del negocio de otro usuario cuando llegue a 3` });
  assert.equal(result.intent, 'tenant_access_denied'); assert.equal(denied, 1);
});
test('rule draft restores product/condition candidates and expires without preparation', async () => {
  let prepared = 0;
  const options = { resolver: async () => ({ clarification: 'Elige producto', candidates: [{ _id: id, name: 'Agua', sku }] }) };
  const runtime = { getContextSnapshot: async () => ({}) }, service = { prepare: async () => { prepared++; return { summary: 'Regla' }; } };
  const conversationId = randomUUID(), adapter = withActionAssistant(runtime, service, options);
  await adapter.handle(req, { conversationId, message: 'Crea una alerta para agua cuando llegue a 3' });
  const snapshot = await adapter.getContextSnapshot(req, conversationId);
  assert.equal(snapshot.operationDraft.operator, '<='); assert.equal(snapshot.operationDraft.threshold, 3);
  const restored = withActionAssistant(runtime, service, { resolver }); await restored.restoreContext(req, conversationId, snapshot);
  const response = await restored.handle(req, { conversationId, message: 'el primero' }); assert.equal(prepared, 1); assert.equal(response.usage.totalTokens, 0);
  const stale = withActionAssistant(runtime, service, { resolver });
  snapshot.operationDraft.expiresAt = Date.now() - 1;
  await stale.restoreContext(req, conversationId, snapshot);
  const result = await stale.handle(req, { conversationId, message: 'Ver más' }); assert.equal(result.requiresClarification, true); assert.equal(prepared, 1);
});
test('real executor is tenant scoped, session bound and semantically deduplicates', async () => {
  const originalProduct = Product.findOne, originalFind = Rule.findOne, originalUpdate = Rule.findOneAndUpdate;
  const rows = new Map(), session = {}, filters = [];
  const query = value => ({ select() { return this; }, session(given) { if (given) assert.equal(given, session); return this; }, lean() { return this; }, maxTimeMS: async () => typeof value === 'function' ? value() : value });
  Product.findOne = filter => { filters.push(filter); return query(filter.businessId === 'A' && filter._id === id ? { _id: id, sku, name: 'Demo' } : null); };
  Rule.findOne = filter => query(() => rows.get(JSON.stringify(filter)) || null);
  Rule.findOneAndUpdate = (filter, update, options) => {
    assert.equal(options.session, session); assert.equal(options.upsert, true); assert.equal(options.runValidators, true);
    return query(() => { const key = JSON.stringify(filter); if (!rows.has(key)) rows.set(key, { _id: id, ...update.$setOnInsert }); return rows.get(key); });
  };
  try {
    const executor = createActionExecutors().create_stock_alert_rule, args = { productId: id, operator: '<=', threshold: 3 }, context = createActionContext(req);
    const preview = await executor.preview(args, context); assert.equal(rows.size, 0); assert.ok(!JSON.stringify(preview).includes(id));
    const first = await executor.execute(args, context, session);
    assert.equal((await executor.execute(args, context, session)).alreadyExists, true); assert.equal(rows.size, 1);
    await executor.execute({ ...args, operator: '<' }, context, session); assert.equal(rows.size, 2);
    await Promise.all([1, 2].map(() => executor.execute({ ...args, threshold: 8 }, context, session))); assert.equal(rows.size, 3);
    await assert.rejects(executor.preview({ ...args, productId: 'cccccccccccccccccccccccc' }, context), { code: 'ACTION_VALIDATION_FAILED' });
    assert.ok(filters.every(filter => filter.businessId === 'A' && filter.isActive === true));
    const projected = publicResponse({ pendingAction: { result: first } }); assert.equal(projected.pendingAction.result.operator, '<=');
    assert.match(resultAnswer({ status: 'EXECUTED', result: first }), /todavía no envía/);
  } finally { Product.findOne = originalProduct; Rule.findOne = originalFind; Rule.findOneAndUpdate = originalUpdate; }
});
