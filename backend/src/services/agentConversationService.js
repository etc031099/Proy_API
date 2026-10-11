const { randomUUID } = require('node:crypto');
const { createAgentRequestContext, isTraceId } = require('../agents/contracts');
const { createAgentHistoryRepository } = require('./agentHistoryRepository');
const { redact, publicResponse, snapshot, titleFor } = require('./agentHistoryProjection');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const summary = row => Object.fromEntries(['conversationId', 'title', 'lastMessageAt', 'messageCount', 'status', 'createdAt', 'updatedAt'].map(key => [key, row[key]]));

const createAgentConversationService = ({ runtime, repository = createAgentHistoryRepository(), actionService,
  onError = () => console.error('[AgentHistoryDiagnostic] persistence_failed') }) => {
  const queues = new Map();
  const scopeFor = req => { const context = createAgentRequestContext(req); return { userId: context.userId, businessId: context.businessId }; };
  const serialized = async (scope, id, operation) => {
    const key = JSON.stringify([scope.userId, scope.businessId, id]);
    if (!queues.has(key) && queues.size >= 1000) fail('AGENT_HISTORY_BUSY');
    const prior = queues.get(key);
    if (prior) fail('AGENT_HISTORY_BUSY');
    const task = Promise.resolve().then(operation);
    queues.set(key, task);
    try { return await task; } finally { queues.delete(key); }
  };
  const owned = async (scope, id) => {
    if (!isTraceId(id)) fail('AGENT_CONVERSATION_NOT_FOUND');
    const conversation = await repository.findConversation(scope, id);
    if (!conversation) fail('AGENT_CONVERSATION_NOT_FOUND');
    return conversation;
  };
  return Object.freeze({
    async send(req, input, requestKey = randomUUID()) {
      if (!isTraceId(requestKey)) fail('AGENT_INVALID_REQUEST');
      const scope = scopeFor(req);
      return serialized(scope, input.conversationId || requestKey, async () => {
        const previous = await repository.findRequest(scope, requestKey, 'user');
        if (previous && (input.conversationId && input.conversationId !== previous.conversationId
          || previous.text !== redact(input.message))) fail('AGENT_HISTORY_CONFLICT');
        let id = previous?.conversationId || input.conversationId;
        const conversation = id ? await owned(scope, id) : null;
        id ||= randomUUID();
        req.agentConversationId = id;
        if (previous?.status === 'completed') {
          const cached = await repository.findRequest(scope, requestKey, 'assistant');
          if (!cached?.response) fail('AGENT_HISTORY_CONFLICT');
          return publicResponse(cached.response);
        }
        if (previous?.status === 'pending') fail('AGENT_HISTORY_CONFLICT');
        if (previous) {
          const changed = await repository.retry(scope, requestKey);
          if (!changed.modifiedCount) fail('AGENT_HISTORY_CONFLICT');
        } else {
          try { await repository.begin(scope, id, redact(input.message), requestKey, titleFor(input.message), !conversation); }
          catch (error) { if (error.code === 11000) fail('AGENT_HISTORY_CONFLICT'); throw error; }
        }
        let result;
        try {
          if (conversation?.contextSnapshot) await runtime.restoreContext?.(req, id, snapshot(conversation.contextSnapshot));
          req.agentActionRequestId = requestKey;
          result = await runtime.handle(req, { message: input.message, conversationId: id });
          if (result.code && !['AGENT_CLARIFICATION_REQUIRED', 'AGENT_UNSUPPORTED_QUERY'].includes(result.code)) {
            fail(result.code);
          }
        } catch (error) {
          try { await repository.fail(scope, requestKey); } catch { onError(); }
          throw error;
        }
        const response = publicResponse(result);
        try {
          const state = await runtime.getContextSnapshot?.(req, id) || {};
          await repository.complete(scope, id, requestKey, response, snapshot(state));
        } catch {
          // Leave pending: replay must not regenerate an answer whose persistence is uncertain.
          onError(); fail('AGENT_HISTORY_PERSISTENCE_FAILED');
        }
        return response;
      });
    },
    async list(req, page, limit) {
      const result = await repository.list(scopeFor(req), page, limit);
      return { ...result, items: result.items.map(summary) };
    },
    async get(req, id, page, limit) {
      const scope = scopeFor(req);
      const conversation = await owned(scope, id);
      await runtime.restoreContext?.(req, id, snapshot(conversation.contextSnapshot || {}));
      const result = await repository.messages(scope, id, page, limit);
      const messages = await Promise.all(result.messages.map(async row => {
        let response = row.response ? publicResponse(row.response) : undefined;
        if (response?.suggestions?.length) {
          const draft = require('../automations/operationDraft').compactDraft(conversation.contextSnapshot?.operationDraft);
          const supplier = require('../agents/memory').compactSupplierResolution(conversation.contextSnapshot?.supplierResolution, Date.now());
          const productSelection = require('../agents/memory').compactProductSelection(conversation.contextSnapshot?.lastProductSelection, Date.now);
          const productSelectionExpiresAt = productSelection?.sourceIntent === 'search_product'
            ? productSelection.createdAt + require('../agents/memory').TTL_MS : null;
          // Saved choices remain readable, but only a current draft, supplier resolution or product selection can act.
          if ((!draft || draft.expiresAt !== response.suggestionsExpiresAt)
            && (!supplier || supplier.expiresAt !== response.suggestionsExpiresAt)
            && productSelectionExpiresAt !== response.suggestionsExpiresAt) response.suggestionsExpiresAt = 0;
        }
        if (response?.pendingAction && actionService) {
          const context = require('../automations/contracts').createActionContext(req, { conversationId: id });
          try { response = publicResponse({ ...response, pendingAction: await actionService.get(context, response.pendingAction.pendingActionId) }); }
          catch { fail('AGENT_HISTORY_PERSISTENCE_FAILED'); } // Do not invent a terminal state when authoritative lookup fails.
        }
        return ({
        id: row._id.toString(), role: row.role, text: redact(row.text), status: row.status, createdAt: row.createdAt,
        ...(response ? { response } : {})
      }); }));
      return { conversation: summary(conversation), ...result, messages };
    },
    async remove(req, id) {
      const scope = scopeFor(req);
      return serialized(scope, id, async () => {
        await owned(scope, id); await repository.remove(scope, id); await runtime.forgetConversation?.(req, id);
        return { deleted: true };
      });
    }
  });
};
module.exports = { createAgentConversationService };
