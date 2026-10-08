const test = require('node:test');
const assert = require('node:assert/strict');
const { createActionContext, validateArgs, fail, randomUUID, zeroUsage } = require('../src/automations/contracts');
const { ACTION_SKILLS, getActionSkill, validateActionInvocation, getActionDeclarations } = require('../src/automations/skills');
const { createActionService } = require('../src/automations/execution');
const { createActionRepository } = require('../src/automations/repository');
const { createAutomationEngine } = require('../src/automations/engine');
const { AUTOMATION_DEFINITIONS } = require('../src/automations/definitions');
const { createBusinessEvent, validateTrigger } = require('../src/automations/triggers');
const { safeAudit } = require('../src/automations/audit');
const { withActionAssistant } = require('../src/automations/assistant');
const { createAgentActionHandler } = require('../src/controllers/agentActionsController');
const uuid = '11111111-1111-4111-8111-111111111111';
const req = (businessId = 'A', userId = 'aaaaaaaaaaaaaaaaaaaaaaaa') => ({ businessId,
  user: { _id: userId, businessId, isActive: true, role: 'user' }, body: { businessId: 'B' } });
const ctx = (business = 'A', user, channel = 'assistant', conversation = uuid) => createActionContext(req(business, user), { sourceChannel: channel, conversationId: conversation });
const product = { name: 'Prueba', sku: 'SKU-001', price: 10, stock: 5, minStockLevel: 2, currency: 'PEN', category: 'General' };
// Transactional fixture exercises the actual repository, including session propagation,
// commit/abort, scoped queries and failure audit, without touching a real business.
function fixture({ auditFailure = false, executorFailure = false } = {}) {
  let rows = [], audits = [], writes = 0, version = 0, time = new Date();
  const filters = [], sessions = [];
  const match = (row, filter) => Object.entries(filter).every(([key, val]) => val && typeof val === 'object' && '$gt' in val
    ? row[key] > val.$gt : String(row[key]) === String(val));
  const model = {
    async create(row) { if (rows.some(existing => existing.businessId === row.businessId && existing.userId === row.userId
      && existing.sourceChannel === row.sourceChannel && existing.externalRequestId === row.externalRequestId)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      const saved = structuredClone(row); rows.push(saved); return { toObject: () => structuredClone(saved) }; },
    findOne(filter) {
      filters.push(filter); let session;
      const query = { session(value) { session = value; return query; }, maxTimeMS() { return query; }, lean() { return query; },
        exec: async () => structuredClone(rows.find(row => match(row, filter)) || null),
        then(resolve, reject) { return Promise.resolve().then(() => {
          const row = (session ? session.rows : rows).find(row => match(row, filter));
          return row ? Object.assign(structuredClone(row), { toObject() { return Object.fromEntries(Object.entries(this).filter(([, v]) => typeof v !== 'function')); },
            async save({ session: given }) { assert.equal(given, session); const index = session.rows.findIndex(r => r.pendingActionId === this.pendingActionId); session.rows[index] = structuredClone(this.toObject()); } }) : null;
        }).then(resolve, reject); }
      }; return query;
    },
    find(filter) { return { sort() { return this; }, limit() { return this; }, lean() { return this; }, maxTimeMS() { return this; },
      exec: async () => rows.filter(row => match(row, filter)).slice(0, 2) }; }
  };
  const startSession = async () => {
    const s = { active: false, version, rows: structuredClone(rows), audits: [], writes: 0,
      startTransaction() { this.active = true; }, inTransaction() { return this.active; },
      async commitTransaction() { if (this.version !== version) throw Object.assign(new Error('write conflict'), { code: 112 });
        rows = this.rows; audits.push(...this.audits); writes += this.writes; version++; this.active = false; },
      async abortTransaction() { this.active = false; this.aborted = true; }, async endSession() { this.ended = true; } };
    sessions.push(s); return s;
  };
  const repository = createActionRepository({ pendingModel: model, conversationModel: { exists: () => ({ maxTimeMS: async () => true }) }, startSession,
    audit: async (row, context, status, now, session, errorCode) => { if (auditFailure && status === 'EXECUTED') throw new Error('private database payload');
      session.audits.push(safeAudit(row, context, status, now, errorCode)); } });
  const executors = Object.fromEntries(['create_product', 'create_inventory_alert'].map(id => [id, {
    preview: async args => ({ summary: 'Preparar acción', fields: { sku: args.sku || 'alert' } }),
    async execute(args, context, session) { assert.ok(Object.isFrozen(args)); assert.equal(context.businessId, 'A');
      if (executorFailure) throw new Error('password=private'); session.writes++; return { id: 'cccccccccccccccccccccccc' }; }
  }]));
  const service = createActionService({ repository, executors, clock: () => time });
  return { service, repository, sessions, filters, rows: () => rows, audits: () => audits, writes: () => writes,
    expire: () => { time = new Date(time.getTime() + 600001); } };
}
const prepare = (f, context = ctx(), args = product, key = randomUUID()) => f.service.prepare({ agentId: 'operations', skillId: 'create_product', args, context, externalRequestId: key });
test('action registry is separate, closed and exposes four real operations executors', () => {
  assert.equal(ACTION_SKILLS.length, 14); assert.equal(new Set(ACTION_SKILLS.map(x => x.id)).size, 14);
  assert.deepEqual(ACTION_SKILLS.filter(x => x.status === 'READY').map(x => x.id), ['create_product', 'create_sale', 'create_purchase', 'create_inventory_alert']);
  assert.ok(ACTION_SKILLS.every(x => x.auditRequired && x.idempotent && x.riskLevel !== 'RESTRICTED'));
  assert.equal(getActionDeclarations('operations').length, 4);
  for (const id of ['analyst', 'coordinator']) assert.deepEqual(getActionDeclarations(id), []);
});
for (const field of ['businessId', 'userId', 'role', 'model', 'apiKey', 'query', 'url', '$where']) test(`action schema rejects ${field}`, () => {
  assert.throws(() => validateArgs(getActionSkill('create_product').inputSchema, { ...product, [field]: 'forbidden' }), { code: 'ACTION_VALIDATION_FAILED' });
});
for (const value of [-1, Infinity, NaN, '10', null]) test(`action price rejects ${String(value)}`, () => {
  assert.throws(() => validateArgs(getActionSkill('create_product').inputSchema, { ...product, price: value }), { code: 'ACTION_VALIDATION_FAILED' });
});
test('secret-like text and raw nested filters fail before persistence', () => {
  for (const args of [{ ...product, name: 'password=private' }, { ...product, name: { $regex: '.*' } }])
    assert.throws(() => validateArgs(getActionSkill('create_product').inputSchema, args), { code: 'ACTION_VALIDATION_FAILED' });
});
test('context comes from auth, is branded, immutable and never trusts body tenant', () => {
  const c = ctx(); assert.equal(c.businessId, 'A'); assert.ok(Object.isFrozen(c));
  assert.throws(() => validateActionInvocation({ context: { ...c }, agentId: 'operations', skillId: 'create_product', args: product }), { code: 'ACTION_NOT_ALLOWED' });
});
for (const [agentId, skillId] of [['coordinator', 'create_product'], ['analyst', 'create_product'], ['operations', 'executeMongoQuery'],
  ['operations', 'update_product'], ['operations', 'create_supplier']]) test(`denies ${agentId}/${skillId}`, async () => {
  const f = fixture(); await assert.rejects(f.service.prepare({ agentId, skillId, args: product, context: ctx(), externalRequestId: randomUUID() }), { code: 'ACTION_NOT_ALLOWED' });
  assert.equal(f.rows().length, 0);
});
test('preview freezes arguments, writes no product and requires explicit confirm with zero IA usage', async () => {
  const f = fixture(), args = { ...product }, p = await prepare(f, ctx(), args); args.stock = 999;
  assert.equal(p.status, 'PENDING'); assert.equal(f.writes(), 0); assert.equal(f.rows()[0].validatedArgs.stock, 5);
  const restored = require('../src/services/agentHistoryProjection').publicResponse({ pendingAction: p }).pendingAction;
  assert.equal(restored.expiresAt, p.expiresAt); assert.equal(typeof restored.expiresAt, 'string');
  assert.equal(new Date(p.expiresAt) - f.rows()[0].createdAt, 600000);
  const done = await f.service.confirmPendingAction(ctx(), p.pendingActionId);
  assert.equal(done.status, 'EXECUTED'); assert.deepEqual(done.usage, zeroUsage()); assert.equal(f.writes(), 1);
  assert.equal(f.audits()[0].status, 'EXECUTED'); assert.ok(f.sessions.every(s => s.ended));
});
test('repeated preparation and confirmations return original result without duplicate writes', async () => {
  const f = fixture(), key = randomUUID(), c = ctx(), p = await prepare(f, c, product, key);
  assert.equal((await prepare(f, c, product, key)).pendingActionId, p.pendingActionId);
  await f.service.confirmPendingAction(c, p.pendingActionId);
  assert.deepEqual((await f.service.confirmPendingAction(c, p.pendingActionId)).result, { id: 'cccccccccccccccccccccccc' });
  assert.equal((await prepare(f, c, product, key)).status, 'EXECUTED'); assert.equal(f.writes(), 1); assert.equal(f.audits().length, 1);
  await assert.rejects(prepare(f, c, { ...product, stock: 4 }, key), { code: 'ACTION_CONFLICT' });
});
test('parallel preparations and confirmations stay idempotent under unique index/write conflict', async () => {
  const f = fixture(), c = ctx(), key = randomUUID();
  const prepared = await Promise.all([prepare(f, c, product, key), prepare(f, c, product, key)]);
  assert.equal(prepared[0].pendingActionId, prepared[1].pendingActionId); assert.equal(f.rows().length, 1);
  const confirmed = await Promise.allSettled(prepared.map(p => f.service.confirmPendingAction(c, p.pendingActionId)));
  assert.equal(confirmed.filter(p => p.status === 'fulfilled').length, 1);
  assert.equal(confirmed.find(p => p.status === 'rejected').reason.code, 'ACTION_CONFLICT');
  assert.equal(f.writes(), 1); assert.equal((await f.service.confirmPendingAction(c, prepared[0].pendingActionId)).status, 'EXECUTED');
});
test('tenant, user, channel and conversation mismatches cannot confirm or see pending actions', async () => {
  const f = fixture(), p = await prepare(f);
  for (const c of [ctx('B'), ctx('A', 'bbbbbbbbbbbbbbbbbbbbbbbb'), ctx('A', undefined, 'telegram'), ctx('A', undefined, 'assistant', randomUUID())]) {
    await assert.rejects(f.service.confirmPendingAction(c, p.pendingActionId), { code: 'ACTION_NOT_ALLOWED' });
    await assert.rejects(f.service.get(c, p.pendingActionId), { code: 'ACTION_NOT_ALLOWED' });
  }
  assert.equal(f.writes(), 0); assert.ok(f.filters.every(filter => filter.businessId && filter.userId && filter.sourceChannel && filter.conversationId));
});
test('expired and cancelled actions cannot execute, terminal audit contains no arguments', async () => {
  for (const expired of [true, false]) {
    const f = fixture(), p = await prepare(f);
    if (expired) f.expire(); else await f.service.cancelPendingAction(ctx(), p.pendingActionId);
    await assert.rejects(f.service.confirmPendingAction(ctx(), p.pendingActionId), { code: expired ? 'ACTION_EXPIRED' : 'ACTION_CANCELLED' });
    assert.equal(f.writes(), 0); assert.equal(f.audits().length, 1); assert.equal(f.audits()[0].validatedArgs, undefined);
  }
});
test('tampered persisted arguments are rejected before execution', async () => {
  const f = fixture(), p = await prepare(f); f.rows()[0].validatedArgs.stock = 500;
  await assert.rejects(f.service.confirmPendingAction(ctx(), p.pendingActionId), { code: 'ACTION_CONFLICT' }); assert.equal(f.writes(), 0);
});
for (const config of [{ executorFailure: true }, { auditFailure: true }]) test(`atomic rollback on ${Object.keys(config)[0]}`, async () => {
  const f = fixture(config), p = await prepare(f);
  await assert.rejects(f.service.confirmPendingAction(ctx(), p.pendingActionId), { code: 'ACTION_EXECUTION_FAILED' });
  assert.equal(f.writes(), 0); assert.equal(f.rows()[0].status, 'FAILED'); assert.equal(f.audits()[0].status, 'FAILED');
  assert.ok(f.sessions.some(s => s.aborted)); assert.ok(!JSON.stringify(f.audits()).includes('private'));
});
test('safe automatic alerts are atomic, idempotent and never need Gemini or approval', async () => {
  const f = fixture(), key = randomUUID(), args = { type: 'LOW_STOCK', label: 'Stock bajo' };
  const invocation = { agentId: 'operations', skillId: 'create_inventory_alert', args, context: ctx(), externalRequestId: key };
  assert.equal((await f.service.prepare(invocation)).status, 'EXECUTED'); await f.service.prepare(invocation);
  assert.equal(f.writes(), 1); assert.equal(f.audits().length, 1);
});
test('assistant prepares structured product and asks only missing fields for financial writes', async () => {
  const f = fixture(), adapter = withActionAssistant({ handle() { assert.fail('Gemini must not run'); } }, f.service);
  const first = await adapter.handle(req(), { message: `Crear producto ${JSON.stringify(product)}`, conversationId: uuid });
  assert.equal(first.pendingAction.status, 'PENDING'); assert.equal(first.usage.totalTokens, 0);
  const done = await adapter.handle(req(), { message: 'sí', conversationId: uuid }); assert.equal(done.pendingAction.status, 'EXECUTED');
  const missing = await adapter.handle(req(), { message: 'Crear producto {"name":"Solo nombre"}', conversationId: uuid });
  assert.equal(missing.requiresClarification, true); assert.ok(!missing.answer.includes('faltan: name'));
  for (const message of ['Registrar venta {}', 'Registrar compra {}'])
    assert.match((await adapter.handle(req(), { message, conversationId: uuid })).answer, /faltan/);
  assert.equal(f.writes(), 1);
});
test('yes/no without unique pending never executes a write or calls Gemini', async () => {
  const adapter = withActionAssistant({}, { resolvePending: async () => null });
  assert.equal((await adapter.handle(req(), { message: 'sí', conversationId: uuid })).requiresClarification, true);
});
test('action controller rejects manipulated confirmation args and sanitizes executor errors', async () => {
  const response = () => ({ code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  const handler = createAgentActionHandler({ enabled: true, decision: 'confirm', service: { confirmPendingAction() { throw new Error('password=private'); } } });
  let res = response(); await handler({ ...req(), params: { id: uuid }, body: { conversationId: uuid, args: product } }, res); assert.equal(res.code, 400);
  res = response(); await handler({ ...req(), params: { id: uuid }, body: { conversationId: uuid } }, res); assert.equal(res.code, 503); assert.ok(!JSON.stringify(res.body).includes('private'));
  res = response(); await createAgentActionHandler({ enabled: false })({}, res); assert.equal(res.code, 404);
});
test('event contracts inject auth tenant and reject payloads and arbitrary trigger names', () => {
  const c = ctx(), input = { eventId: uuid, type: 'PRODUCT_CREATED', timestamp: new Date().toISOString(), entityType: 'product', entityId: 'cccccccccccccccccccccccc' };
  assert.equal(createBusinessEvent(c, input).businessId, 'A');
  for (const extra of [{ businessId: 'B' }, { metadata: { password: 'private' } }]) assert.throws(() => createBusinessEvent(c, { ...input, ...extra }), { code: 'ACTION_VALIDATION_FAILED' });
  assert.throws(() => validateTrigger({ eventId: uuid, type: 'SCHEDULE', name: 'executeShell', sourceChannel: 'assistant' }, c), { code: 'ACTION_VALIDATION_FAILED' });
});
test('automation executes one read batch and bounded internal alerts, records run once and consumes zero tokens', async () => {
  const ledger = new Map(); let readCalls = 0, actionCalls = 0, saved;
  const runs = { async claim(row) { const old = ledger.get(row.eventId); if (old) return { row: old, claimed: false }; ledger.set(row.eventId, row); return { row, claimed: true }; },
    async finish(row, update) { Object.assign(row, update); saved = update; } };
  const engine = createAutomationEngine({ definitions: [{ ...AUTOMATION_DEFINITIONS[0], enabled: true }], runs,
    readFactory: () => ({ runAgent: (id, fn) => fn(), executeSkill: async () => { readCalls++; return { data: Array.from({ length: 10 }, () => ({ id: 'cccccccccccccccccccccccc' })) }; }, finish() {} }),
    actionService: { prepare: async input => { actionCalls++; assert.equal(input.skillId, 'create_inventory_alert'); return { pendingActionId: randomUUID() }; } } });
  const input = { definition: 'low_stock_internal_alerts', context: ctx('A', undefined, 'automation'), trigger: { eventId: uuid, type: 'MANUAL', name: 'dashboard', sourceChannel: 'automation' } };
  assert.equal((await engine.executeAutomation(input)).status, 'SUCCEEDED'); assert.equal((await engine.executeAutomation(input)).alreadyProcessed, true);
  assert.equal(readCalls, 1); assert.equal(actionCalls, 3); assert.equal(saved.usage.totalTokens, 0); assert.equal(saved.providerAttempts, 0);
});
test('actual create_product executor shares CRUD opening movement/session and minimizes DTO', async t => {
  const { Product, InventoryMovement } = require('../src/models');
  const { createActionExecutors } = require('../src/automations/executors');
  const session = {}; let movement, insert, saves = 0;
  t.mock.method(Product, 'exists', filter => { assert.equal(filter.businessId, 'A'); return { maxTimeMS: async () => false }; });
  t.mock.method(Product, 'create', async (docs, options) => { assert.equal(options.session, session); insert = docs[0];
    return [{ ...docs[0], _id: 'cccccccccccccccccccccccc', async save(options) { assert.equal(options.session, session); saves++; } }]; });
  t.mock.method(InventoryMovement, 'create', async (docs, options) => { assert.equal(options.session, session); movement = docs[0]; return docs; });
  t.mock.method(require('../src/models/ActionDomainEvent'), 'create', async (docs, options) => { assert.equal(options.session, session); assert.equal(options.ordered, true); return docs; });
  const executor = createActionExecutors().create_product;
  const preview = await executor.preview(product, ctx()); assert.equal(preview.fields.resultingStock, 5);
  const result = await executor.execute(product, ctx(), session);
  assert.equal(insert.businessId, 'A'); assert.equal(insert.stock, 0); assert.equal(result.stock, 5);
  assert.equal(saves, 1); assert.equal(movement.type, 'opening'); assert.equal(movement.quantityDelta, 5); assert.equal(movement.businessId, 'A');
  assert.deepEqual(Object.keys(result).sort(), ['id', 'name', 'sku', 'stock']);
  movement = null;
  assert.equal((await executor.execute({ ...product, stock: 0 }, ctx(), session)).stock, 0);
  assert.equal(movement, null); assert.equal(saves, 1);
  t.mock.method(Product, 'exists', () => ({ maxTimeMS: async () => true }));
  await assert.rejects(executor.preview(product, ctx()), { code: 'ACTION_CONFLICT' });
});
test('PendingAction and AutomationRun declare unique idempotency indexes and frozen args without TTL deletion', () => {
  const Pending = require('../src/models/PendingAction'), Run = require('../src/models/AutomationRun');
  assert.equal(Pending.schema.path('validatedArgs').options.immutable, true);
  assert.equal(Pending.schema.path('argsHash').options.immutable, true);
  assert.ok(Pending.schema.indexes().some(([key, opt]) => key.externalRequestId && key.businessId && key.userId && key.sourceChannel && opt.unique));
  assert.ok(!Pending.schema.indexes().some(([, opt]) => opt.expireAfterSeconds !== undefined));
  assert.ok(Run.schema.indexes().some(([key, opt]) => key.businessId && key.eventId && key.automationId && opt.unique));
});
test('disabled automation never reads or writes; partial failure records only committed alerts', async () => {
  let saved, calls = 0;
  const runs = { claim: async row => ({ row, claimed: true }), finish: async (row, update) => { saved = update; } };
  const input = { definition: 'low_stock_internal_alerts', context: ctx('A', undefined, 'automation'),
    trigger: { eventId: uuid, type: 'MANUAL', name: 'dashboard', sourceChannel: 'automation' } };
  assert.equal((await createAutomationEngine({ runs, readFactory() { assert.fail('disabled'); } }).executeAutomation(input)).status, 'SKIPPED');
  const engine = createAutomationEngine({ runs, definitions: [{ ...AUTOMATION_DEFINITIONS[0], enabled: true }],
    readFactory: () => ({ runAgent: (id, operation) => operation(), finish() {}, executeSkill: async () => ({ data: [{ id: 'a' }, { id: 'b' }] }) }),
    actionService: { prepare: async () => { if (++calls > 1) throw new Error('secret=private'); return { pendingActionId: uuid }; } } });
  assert.equal((await engine.executeAutomation(input)).status, 'PARTIAL'); assert.deepEqual(saved.actions, [uuid]);
  assert.equal(saved.errorCode, 'ACTION_EXECUTION_FAILED'); assert.ok(!JSON.stringify(saved).includes('private'));
});
test('actual alert executor rejects foreign product and inserts only safe fields with caller session', async t => {
  const { Product } = require('../src/models'); const Alert = require('../src/models/InventoryAlert');
  const { createActionExecutors } = require('../src/automations/executors'); const executor = createActionExecutors().create_inventory_alert;
  const args = { type: 'LOW_STOCK', productId: 'cccccccccccccccccccccccc', label: 'Stock bajo' }, c = ctx(), session = {};
  t.mock.method(Product, 'exists', filter => { assert.equal(filter.businessId, 'A'); return { maxTimeMS: async () => false }; });
  await assert.rejects(executor.preview(args, c), { code: 'ACTION_VALIDATION_FAILED' });
  t.mock.method(Product, 'exists', () => ({ maxTimeMS: async () => true }));
  t.mock.method(Alert, 'create', async (docs, options) => { assert.equal(options.session, session); assert.equal(docs[0].businessId, 'A');
    assert.equal(docs[0].actionId, uuid); return [{ ...docs[0], _id: 'cccccccccccccccccccccccc', status: 'OPEN' }]; });
  assert.deepEqual(await executor.execute(args, c, session, uuid), { id: 'cccccccccccccccccccccccc', type: 'LOW_STOCK', status: 'OPEN' });
});
test('action HTTP endpoint enforces auth, flag, scoped confirmation and closed body', async t => {
  const express = require('express'), routes = require('../src/routes/agent'); let calls = 0;
  const app = express(); app.use(express.json());
  const service = { async confirmPendingAction(context, id) { calls++; assert.equal(context.userId, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(context.businessId, 'A'); assert.equal(context.conversationId, uuid); assert.equal(id, uuid); return { status: 'EXECUTED', usage: zeroUsage() }; } };
  const authenticateMiddleware = (request, res, next) => { if (request.get('X-Test-Session') !== 'synthetic') return res.sendStatus(401);
    const identity = req(); request.user = identity.user; request.businessId = identity.businessId; next(); };
  app.use('/api/agent', routes({ enabled: true, actionService: service, authenticateMiddleware, businessAccessMiddleware: (req, res, next) => next() }));
  app.use('/disabled', routes({ enabled: false, actionService: service, authenticateMiddleware, businessAccessMiddleware: (req, res, next) => next() }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (prefix, body, auth = true) => fetch(`http://127.0.0.1:${server.address().port}${prefix}/actions/${uuid}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Test-Session': 'synthetic' } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('/api/agent', { conversationId: uuid }, false)).status, 401);
  assert.equal((await post('/disabled', { conversationId: uuid })).status, 404);
  for (const key of ['args', 'businessId', 'userId', 'model', 'skill', 'prompt']) assert.equal((await post('/api/agent', { conversationId: uuid, [key]: 'bad' })).status, 400);
  const response = await post('/api/agent', { conversationId: uuid }); assert.equal(response.status, 200); assert.equal((await response.json()).data.usage.totalTokens, 0);
  assert.equal(calls, 1);
});
