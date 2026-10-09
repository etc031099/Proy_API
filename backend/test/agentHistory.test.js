const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { createAgentConversationService } = require('../src/services/agentConversationService');
const { publicResponse, snapshot, titleFor } = require('../src/services/agentHistoryProjection');
const { createAgentOrchestrator } = require('../src/agents/orchestrator');
const { createConversationMemory } = require('../src/agents/memory');
const { routeDeterministically } = require('../src/agents/intentRouting');
const createRoutes = require('../src/routes/agent');
const Conversation = require('../src/models/AgentConversation');
const Message = require('../src/models/AgentConversationMessage');
const mongoose = require('mongoose');
const { createAgentHistoryRepository } = require('../src/services/agentHistoryRepository');
const req = (user = 'aaaaaaaaaaaaaaaaaaaaaaaa', business = 'TENANT-A') => ({
  user: { _id: user, businessId: business, role: 'user', isActive: true }, businessId: business });
const response = id => ({ requestId: randomUUID(), conversationId: id, answer: 'Hay productos con stock bajo.',
  intent: 'low_stock', agent: 'operations', participants: [{ agentId: 'operations', model: null, llmCalls: 0, skillCalls: 1,
    inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedInputTokens: 0, toolUseTokens: 0, totalTokens: 0, latencyMs: 1, providerLatencyMs: 0, usageAvailable: true }],
  actions: [{ skillId: 'get_low_stock_products', agentId: 'operations', status: 'SUCCEEDED', durationMs: 1 }],
  evidence: [{ evidenceId: randomUUID(), sourceType: 'skill', skillId: 'get_low_stock_products', label: 'Inventario', recordCount: 3 }],
  usage: { totalLlmCalls: 0, totalSkillCalls: 1, totalTokens: 0, agents: [], providerGenerations: [] },
  requiresClarification: false, clarificationQuestion: null, latencyMs: 2 });
const fixture = () => {
  const conversations = [], messages = [], scopeReads = [];
  let executions = 0, fails = false, completeFailure = false;
  const match = (row, scope) => row.userId === scope.userId && row.businessId === scope.businessId;
  const find = (scope, id) => conversations.find(row => match(row, scope) && row.conversationId === id);
  const repository = {
    findConversation: async (scope, id) => { scopeReads.push(scope); return find(scope, id); },
    findRequest: async (scope, key, role) => messages.find(row => match(row, scope) && row.requestKey === key && row.role === role),
    async begin(scope, id, text, key, title, isNew) {
      if (isNew) conversations.push({ ...scope, conversationId: id, title, messageCount: 0, status: 'active', createdAt: new Date(), updatedAt: new Date() });
      const conversation = find(scope, id); conversation.messageCount++; conversation.lastMessageAt = new Date();
      const row = { ...scope, conversationId: id, text, requestKey: key, role: 'user', status: 'pending', _id: randomUUID(), createdAt: new Date() };
      messages.push(row); return row;
    },
    async complete(scope, id, key, result, state) {
      if (completeFailure) throw Error('private DB error');
      const conversation = find(scope, id); conversation.messageCount++; conversation.lastMessageAt = new Date();
      conversation.contextSnapshot = state; conversation.lastIntent = result.intent; conversation.lastAgent = result.agent;
      messages.find(row => match(row, scope) && row.requestKey === key && row.role === 'user').status = 'completed';
      messages.push({ ...scope, conversationId: id, requestKey: key, text: result.answer, response: result,
        role: 'assistant', status: 'completed', _id: randomUUID(), createdAt: new Date() });
    },
    async fail(scope, key) { messages.find(row => match(row, scope) && row.requestKey === key).status = 'failed'; },
    async retry(scope, key) { const row = messages.find(row => match(row, scope) && row.requestKey === key && row.status === 'failed');
      if (row) row.status = 'pending'; return { modifiedCount: row ? 1 : 0 }; },
    async list(scope, page, limit) {
      const items = conversations.filter(row => match(row, scope)).slice().reverse();
      const totalPages = Math.max(1, Math.ceil(items.length / limit)); page = Math.min(page, totalPages);
      return { items: items.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: items.length, totalPages } };
    },
    async messages(scope, id, page, limit) {
      const items = messages.filter(row => match(row, scope) && row.conversationId === id).slice().reverse();
      return { messages: items.slice((page - 1) * limit, page * limit).reverse(), pagination: {
        page, limit, total: items.length, totalPages: Math.max(1, Math.ceil(items.length / limit)) } };
    },
    async remove(scope, id) { for (const rows of [conversations, messages]) for (let i = rows.length - 1; i >= 0; i--)
      if (match(rows[i], scope) && rows[i].conversationId === id) rows.splice(i, 1); }
  };
  const runtime = { async handle(auth, input) { executions++; if (fails) throw Object.assign(Error('raw provider secret'), { code: 'AGENT_PROVIDER_FAILED' });
    return { ...response(input.conversationId), systemPrompt: 'private', usage: { ...response(input.conversationId).usage, raw: 'private' } }; },
    async getContextSnapshot() { return { lastIntent: 'low_stock', lastAgent: 'operations', lastProductSelection: { sourceIntent: 'low_stock',
      items: Array.from({ length: 10 }, (_, i) => ({ id: `00000000000000000000000${i}`, sku: `SKU-${i}`, name: `Producto ${i}`, rawDto: 'private' })) }, apiKey: 'private' }; },
    async restoreContext() {}, async forgetConversation() {} };
  const service = createAgentConversationService({ runtime, repository, onError() {} });
  return { service, repository, runtime, conversations, messages, scopeReads, get executions() { return executions; },
    fail: value => { fails = value; }, failComplete: value => { completeFailure = value; } };
};

test('history retains safe choices while draft is valid and disables stale/expired drafts', async () => {
  const f = fixture(), now = Date.now();
  const draft = { action: 'create_sale', items: [{ ref: 'food', quantity: 2 }], updatedAt: now, expiresAt: now + 120000,
    selection: { slot: 'product', index: 0, candidates: [{ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Foods', sku: 'FOOD' }] } };
  f.runtime.handle = async (auth, input) => ({ ...response(input.conversationId), suggestionsExpiresAt: draft.expiresAt,
    suggestions: [{ label: '1. Foods — FOOD', message: 'Opción 1', raw: 'private' }] });
  f.runtime.getContextSnapshot = async () => ({ operationDraft: draft });
  const sent = await f.service.send(req(), { message: 'vende 2 food' });
  let restored = await f.service.get(req(), sent.conversationId, 1, 50);
  let result = restored.messages.find(row => row.response).response;
  assert.deepEqual(result.suggestions, [{ label: '1. Foods — FOOD', message: 'Opción 1' }]);
  assert.equal(result.suggestionsExpiresAt, draft.expiresAt);
  f.conversations[0].contextSnapshot.operationDraft.expiresAt = now - 1;
  restored = await f.service.get(req(), sent.conversationId, 1, 50);
  result = restored.messages.find(row => row.response).response;
  assert.equal(result.suggestionsExpiresAt, 0); assert.equal(result.suggestions.length, 1);
});

test('first message creates a deterministic titled conversation, both messages, counts and safe activity', async () => {
  const f = fixture(); assert.equal(f.conversations.length, 0);
  const result = await f.service.send(req(), { message: 'Muéstrame los productos con stock bajo' });
  assert.equal(f.conversations.length, 1); assert.equal(f.messages.length, 2);
  assert.equal(f.conversations[0].title, 'Productos con stock bajo'); assert.equal(f.conversations[0].messageCount, 2);
  assert.ok(f.conversations[0].lastMessageAt instanceof Date);
  assert.equal(f.messages[0].role, 'user'); assert.equal(f.messages[1].role, 'assistant');
  assert.equal(f.messages[1].response.usage.totalTokens, 0);
  assert.equal(result.conversationId, f.conversations[0].conversationId);
  assert.doesNotMatch(JSON.stringify(f.messages), /systemPrompt|private|apiKey|rawDto/);
  assert.equal(f.conversations[0].contextSnapshot.lastProductSelection.items.length, 5);
});

test('list/detail pagination is scoped, chronological and never invokes the orchestrator', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) await f.service.send(req(), { message: `Consulta ${i}` });
  const executions = f.executions;
  const page = await f.service.list(req(), 2, 10);
  assert.equal(page.pagination.total, 12); assert.equal(page.pagination.totalPages, 2); assert.equal(page.items.length, 2);
  assert.equal(page.items[0].userId, undefined); assert.equal(page.items[0].contextSnapshot, undefined);
  const id = page.items[0].conversationId;
  await f.service.send(req(), { message: 'Segunda consulta', conversationId: id });
  const detail = await f.service.get(req(), id, 1, 50);
  assert.deepEqual(detail.messages.map(row => row.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(detail.conversation.messageCount, 4); assert.equal(detail.messages[1].response.actions[0].skillId, 'get_low_stock_products');
  const older = await f.service.get(req(), id, 2, 2); assert.equal(older.messages[0].text, page.items[0].title);
  assert.equal(f.executions, executions + 1);
});

test('different user or business cannot read, append or delete the same UUID; false IDs return not found', async () => {
  const f = fixture(); const { conversationId } = await f.service.send(req(), { message: 'stock bajo' });
  for (const auth of [req('bbbbbbbbbbbbbbbbbbbbbbbb'), req('aaaaaaaaaaaaaaaaaaaaaaaa', 'TENANT-B')]) {
    assert.equal((await f.service.list(auth, 1, 10)).items.length, 0);
    for (const operation of [() => f.service.get(auth, conversationId, 1, 50),
      () => f.service.remove(auth, conversationId), () => f.service.send(auth, { message: 'hello', conversationId })]) {
      await assert.rejects(operation(), error => error.code === 'AGENT_CONVERSATION_NOT_FOUND');
    }
  }
  await assert.rejects(f.service.get(req(), randomUUID(), 1, 50), error => error.code === 'AGENT_CONVERSATION_NOT_FOUND');
  assert.equal(f.messages.length, 2); assert.equal(f.executions, 1);
  await f.service.remove(req(), conversationId); assert.equal(f.messages.length, 0); assert.equal(f.conversations.length, 0);
});

test('same request key returns persisted result without duplicate messages or generation', async () => {
  const f = fixture(), key = randomUUID();
  const first = await f.service.send(req(), { message: 'stock bajo' }, key);
  const second = await f.service.send(req(), { message: 'stock bajo' }, key);
  assert.deepEqual(first, second); assert.equal(f.executions, 1); assert.equal(f.messages.length, 2);
  await assert.rejects(f.service.send(req(), { message: 'different message' }, key), error => error.code === 'AGENT_HISTORY_CONFLICT');
});

test('failed execution retains only failed user message, and explicit retry reuses it', async () => {
  const f = fixture(), key = randomUUID(); f.fail(true);
  await assert.rejects(f.service.send(req(), { message: 'hello' }, key), error => error.code === 'AGENT_PROVIDER_FAILED');
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].status, 'failed'); assert.equal(f.conversations[0].messageCount, 1);
  f.fail(false); await f.service.send(req(), { message: 'hello' }, key);
  assert.equal(f.messages.length, 2); assert.equal(f.conversations[0].messageCount, 2);
});

test('post-generation persistence failure leaves uncertain pending result and prohibits re-generation', async () => {
  const f = fixture(), key = randomUUID(); f.failComplete(true);
  await assert.rejects(f.service.send(req(), { message: 'hello' }, key), error => error.code === 'AGENT_HISTORY_PERSISTENCE_FAILED');
  await assert.rejects(f.service.send(req(), { message: 'hello' }, key), error => error.code === 'AGENT_HISTORY_CONFLICT');
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].status, 'pending'); assert.equal(f.executions, 1);
});

test('metadata and compact snapshot drop unexpected nested properties, redact secrets and preserve null tokens/fallback', () => {
  const value = response(randomUUID()); value.participants[0].apiKey = 'private'; value.evidence[0].payload = 'private';
  value.usage.providerGenerations = [{ requestedModel: 'gemini-3.7-flash', finalModel: 'gemini-3.6-flash', fallbackUsed: true,
    providerAttempts: 3, logicalGenerationUsage: { totalTokens: null, headers: 'private' }, rawResponse: 'private' }];
  const projected = publicResponse(value);
  assert.equal(projected.usage.providerGenerations[0].finalModel, 'gemini-3.6-flash');
  assert.equal(projected.usage.providerGenerations[0].logicalGenerationUsage.totalTokens, null);
  assert.doesNotMatch(JSON.stringify(projected), /apiKey|payload|headers|rawResponse|private/);
  assert.match(titleFor('token=private Gemini'), /omitido/);
  assert.equal(snapshot({ messages: ['private'], apiKey: 'private' }).messages, undefined);
});

test('real compact memory hydrates on restart/TTL with ordinal references and zero provider calls, scoped by auth', async () => {
  let now = 0;
  const runtime = createAgentOrchestrator({ memory: createConversationMemory({ now: () => now, ttlMs: 10 }),
    provider: { generateStructured() { assert.fail('no generation'); }, generateWithTools() { assert.fail('no generation'); } } });
  const id = randomUUID(), state = snapshot({ lastIntent: 'replenishment_candidates', lastAgent: 'analyst',
    lastProductSelection: { sourceIntent: 'replenishment_candidates', items: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaab', sku: 'SKU-001', name: 'Producto' }] } });
  await runtime.restoreContext(req(), id, state);
  const read = await runtime.getContextSnapshot(req(), id);
  assert.equal(routeDeterministically('¿Y cuánto vendió el primero este mes?', read, new Date('2026-10-08')).selector.productId, 'aaaaaaaaaaaaaaaaaaaaaaab');
  assert.deepEqual(await runtime.getContextSnapshot(req('bbbbbbbbbbbbbbbbbbbbbbbb'), id), {});
  now = 20; assert.deepEqual(await runtime.getContextSnapshot(req(), id), {});
  await runtime.restoreContext(req(), id, state); assert.ok((await runtime.getContextSnapshot(req(), id)).lastProductSelection);
  await runtime.forgetConversation(req(), id); assert.deepEqual(await runtime.getContextSnapshot(req(), id), {});
});

test('Mongo schemas define tenant/user indexes, UUID validation and bounded storage', async () => {
  assert.ok(Conversation.schema.indexes().some(([fields, options]) => options.unique && fields.userId && fields.businessId && fields.conversationId));
  assert.ok(Message.schema.indexes().some(([fields, options]) => options.unique && fields.requestKey && fields.role && fields.businessId && fields.userId));
  await assert.rejects(new Conversation({ conversationId: 'bad', userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessId: 'A', title: 'x', lastMessageAt: new Date() }).validate());
  await assert.rejects(new Message({ conversationId: randomUUID(), requestKey: randomUUID(), userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    businessId: 'A', role: 'user', status: 'pending', text: 'x'.repeat(20001) }).validate());
});

test('actual Mongo repository scopes atomic begin/complete/delete and closes sessions', async t => {
  const scope = { userId: req().user._id, businessId: req().businessId }, id = randomUUID(), key = randomUUID();
  let ended = 0, transactions = 0;
  const session = { withTransaction: async operation => { transactions++; return operation(); }, endSession: async () => { ended++; } };
  t.mock.method(mongoose, 'startSession', async () => session);
  const check = filter => { assert.equal(filter.userId, scope.userId); assert.equal(filter.businessId, scope.businessId); assert.equal(filter.conversationId, id); };
  t.mock.method(Conversation, 'create', async (rows, options) => { check(rows[0]); assert.equal(options.session, session); });
  t.mock.method(Conversation, 'updateOne', async (filter, update, options) => {
    check(filter); assert.equal(options.session, session); assert.equal(update.$inc.messageCount, 1); return { matchedCount: 1 };
  });
  t.mock.method(Message, 'create', async (rows, options) => { check(rows[0]); assert.equal(rows[0].requestKey, key);
    assert.equal(options.session, session); return [{ toObject: () => rows[0] }]; });
  t.mock.method(Message, 'updateOne', async (filter, update, options) => { check(filter); assert.equal(filter.requestKey, key);
    assert.equal(options.session, session); assert.equal(update.$set.status, 'completed'); });
  t.mock.method(Conversation, 'deleteOne', async (filter, options) => { check(filter); assert.equal(options.session, session); return { deletedCount: 1 }; });
  t.mock.method(Message, 'deleteMany', async (filter, options) => { check(filter); assert.equal(options.session, session); });
  const repository = createAgentHistoryRepository();
  await repository.begin(scope, id, 'Consulta', key, 'Consulta', true);
  await repository.complete(scope, id, key, response(id), {});
  await repository.remove(scope, id);
  assert.equal(transactions, 3); assert.equal(ended, 3);
  t.mock.method(Conversation, 'updateOne', async () => { throw Error('database failure'); });
  await assert.rejects(repository.begin(scope, id, 'Consulta', key, 'Consulta', false));
  assert.equal(ended, 4);
});

test('database failure before generation never calls the runtime; concurrent submissions cannot duplicate it', async () => {
  const f = fixture(); f.repository.begin = async () => { throw Error('database failure'); };
  await assert.rejects(f.service.send(req(), { message: 'stock bajo' })); assert.equal(f.executions, 0);
  const concurrent = fixture(), key = randomUUID(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  concurrent.runtime.handle = async (auth, input) => { entered(); await new Promise(resolve => { release = resolve; }); return response(input.conversationId); };
  const first = concurrent.service.send(req(), { message: 'stock bajo' }, key);
  await started;
  await assert.rejects(concurrent.service.send(req(), { message: 'stock bajo' }, key), error => error.code === 'AGENT_HISTORY_BUSY');
  release(); await first; assert.equal(concurrent.messages.length, 2);
});

test('history HTTP requires auth/flag, validates pagination and rejects identity scope from query/body', async t => {
  const f = fixture(), app = express(); app.use(express.json());
  const auth = (request, res, next) => { Object.assign(request, req()); next(); };
  app.use('/api/agent', createRoutes({ enabled: true, orchestrator: f.runtime, historyService: f.service,
    authenticateMiddleware: auth, businessAccessMiddleware: (request, res, next) => next() }));
  app.use('/disabled', createRoutes({ enabled: false, orchestrator: f.runtime, historyService: f.service,
    authenticateMiddleware: auth, businessAccessMiddleware: (request, res, next) => next() }));
  app.use('/protected', createRoutes({ enabled: true, historyService: f.service }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/protected/conversations`)).status, 401);
  assert.equal((await fetch(`${base}/disabled/conversations`)).status, 404);
  assert.equal((await fetch(`${base}/api/agent/conversations?businessId=B`)).status, 400);
  assert.equal((await fetch(`${base}/api/agent/conversations?limit=51`)).status, 400);
  assert.equal((await fetch(`${base}/api/agent/conversations?userId=x`)).status, 400);
  const sent = await fetch(`${base}/api/agent/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ message: 'stock bajo' }) });
  assert.equal(sent.status, 200); const { data } = await sent.json();
  const loaded = await fetch(`${base}/api/agent/conversations/${data.conversationId}`); assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).data.messages.length, 2);
  const deleted = await fetch(`${base}/api/agent/conversations/${data.conversationId}`, { method: 'DELETE' }); assert.equal(deleted.status, 200);
  assert.equal((await fetch(`${base}/api/agent/conversations/${data.conversationId}`)).status, 404);
});
