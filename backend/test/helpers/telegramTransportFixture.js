const { randomUUID } = require('node:crypto');
const { createTelegramTransportRepository } = require('../../src/services/telegramTransportRepository');
const { createTelegramAssistantTransport } = require('../../src/services/telegramAssistantTransport');
const { createAgentConversationService } = require('../../src/services/agentConversationService');
const { withActionAssistant } = require('../../src/automations/assistant');
const { readTelegramConfig } = require('../../src/config/telegramAssistant');
const Binding = require('../../src/models/TelegramAssistantBinding');
const Receipt = require('../../src/models/TelegramUpdateReceipt');
const Callback = require('../../src/models/TelegramCallbackToken');
const Conversation = require('../../src/models/AgentConversation');
const Message = require('../../src/models/AgentConversationMessage');
const mapping = { chatId: '123', telegramUserId: '123', systemUserId: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessId: 'DEMO', bindingGeneration: 1 };
const environment = (mappings = [mapping]) => ({ AGENT_ENABLED: 'true', TELEGRAM_ASSISTANT_ENABLED: 'true', TELEGRAM_UPDATES_MODE: 'webhook',
  TELEGRAM_ASSISTANT_OPERATIONS_ENABLED: 'false', TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyzABCDE12345',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(40), TELEGRAM_ASSISTANT_BINDINGS: JSON.stringify(mappings) });
const fixture = ({ runtime, mappings = [mapping] } = {}) => {
  let state = { bindings: [], receipts: [], conversations: [], messages: [], tokens: [] }, tail = Promise.resolve();
  let userOverride, failComplete = false, conversationCalls = 0, now = Date.now(), failSend = false, failAdmission = false;
  const sent = [], acks = [], calls = [];
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => value?.$in
    ? value.$in.includes(row[key]) : String(row[key]) === String(value));
  const apply = (row, changes) => {
    Object.assign(row, changes.$set || {});
    for (const [key, value] of Object.entries(changes.$inc || {})) row[key] = (row[key] || 0) + value;
    return row;
  };
  const model = (name, schema) => {
    const query = (filter, one, change) => {
      let sort = null, limit = Infinity;
      const q = { session: () => q, sort: value => { sort = value; return q; }, limit: value => { limit = value; return q; },
        async lean() {
          let rows = state[name].filter(row => matches(row, filter));
          if (sort) rows.sort((a, b) => { for (const [key, direction] of Object.entries(sort)) {
            if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * direction;
          } return 0; });
          rows = rows.slice(0, limit);
          if (change && rows[0]) apply(rows[0], change);
          return structuredClone(one ? rows[0] || null : rows);
        } };
      return q;
    };
    return { schema, collection: { listIndexes: () => ({ toArray: async () => schema.indexes().map(([key, options]) => ({ key, ...options })) }) },
      aggregate: async pipeline => {
        const heads = new Map();
        for (const row of state[name].filter(row => matches(row, pipeline[0].$match)).slice().sort((a, b) => a.sequence - b.sequence))
          if (!heads.has(String(row.bindingId))) heads.set(String(row.bindingId), row);
        return structuredClone([...heads.values()].slice(0, 20));
      },
      find: filter => query(filter, false), findOne: filter => query(filter, true), findOneAndUpdate: (filter, change) => query(filter, true, change),
      async updateOne(filter, change) { const row = state[name].find(row => matches(row, filter)); if (row) apply(row, change); return { modifiedCount: row ? 1 : 0 }; },
      async updateMany(filter, change) { state[name].filter(row => matches(row, filter)).forEach(row => apply(row, change)); },
      async create(rows) { return rows.map(row => {
        for (const [key, options] of schema.indexes()) {
          if (options.unique && state[name].some(existing => Object.keys(key).every(field => String(existing[field]) === String(row[field]))))
            throw Object.assign(Error('duplicate'), { code: 11000 });
        }
        const result = { _id: randomUUID(), nextSequence: 0, activeReceiptId: null, deliveryIndex: 0,
          invocationStarted: false, deliveredMessageIds: [], ...row }; state[name].push(result); return structuredClone(result);
      }); }
    };
  };
  const transact = work => {
    const operation = tail.then(async () => {
      const before = structuredClone(state);
      try { return await work({ fixtureSession: true }); } catch (error) { state = before; throw error; }
    }); tail = operation.catch(() => {}); return operation;
  };
  const repository = createTelegramTransportRepository({ BindingModel: model('bindings', Binding.schema), ReceiptModel: model('receipts', Receipt.schema),
    ConversationModel: model('conversations', Conversation.schema), MessageModel: model('messages', Message.schema), CallbackModel: model('tokens', Callback.schema),
    transact, clock: () => now });
  const historyRepository = {
    ensureConversation: async (scope, conversationId) => {
      conversationCalls++;
      if (!state.conversations.some(row => row.conversationId === conversationId)) state.conversations.push({ ...scope, conversationId, status: 'active' });
    },
    enqueue: async (scope, conversationId, text, requestKey) => {
      state.messages.push({ ...scope, conversationId, text, requestKey, role: 'user', status: 'queued' });
      if (failAdmission) throw Error('synthetic admission failure');
    },
    findConversation: async (scope, id) => state.conversations.find(row => matches(row, scope) && row.conversationId === id),
    findRequest: async (scope, key, role) => state.messages.find(row => matches(row, scope) && row.requestKey === key && row.role === role),
    startQueued: async (scope, key) => { const row = state.messages.find(row => matches(row, scope) && row.requestKey === key && row.status === 'queued');
      if (row) row.status = 'pending'; return { modifiedCount: row ? 1 : 0 }; },
    fail: async (scope, key) => { state.messages.find(row => matches(row, scope) && row.requestKey === key).status = 'failed'; },
    complete: async (scope, id, key, response, contextSnapshot) => {
      if (failComplete) throw Error('synthetic persistence failure');
      state.conversations.find(row => row.conversationId === id).contextSnapshot = contextSnapshot;
      state.messages.find(row => row.requestKey === key).status = 'completed';
      state.messages.push({ ...scope, conversationId: id, requestKey: key, role: 'assistant', response });
    }
  };
  const make = (core = runtime) => {
    const runtime = withActionAssistant(core || { handle: async (_req, input) => { calls.push(input.message); return { answer: 'Respuesta de lectura', participants: [], actions: [], evidence: [] }; },
      getContextSnapshot: async () => ({}) }, { prepare: () => { throw Error('Forbidden write'); } }, { readOnly: true });
    const conversations = createAgentConversationService({ runtime, durableTransport: true, repository: historyRepository, onError: () => {} });
    return createTelegramAssistantTransport({ config: () => readTelegramConfig(environment(mappings)), repository, conversations,
      loadUser: async id => userOverride !== undefined ? userOverride : { _id: id, businessId: mappings.find(row => row.systemUserId === id)?.businessId, role: 'user', isActive: true },
      telegram: { answerCallbackQuery: async id => acks.push(id), sendMessage: async (chat, text, extra) => {
        sent.push({ chat, text, ...extra }); if (failSend) throw Error('uncertain network response'); return { message_id: sent.length };
      } } });
  };
  return { make, repository, sent, acks, calls, get state() { return state; }, get conversationCalls() { return conversationCalls; },
    user: value => { userOverride = value; }, crash: value => { failComplete = value; }, failAdmission: value => { failAdmission = value; },
    failSend: value => { failSend = value; }, advance: ms => { now += ms; } };
};
module.exports = { fixture, mapping, environment };
