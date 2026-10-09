const { createAgentOrchestrator } = require('../agents/orchestrator');
const { EXECUTION_LIMITS, isPlainObject, isTraceId } = require('../agents/contracts');
const { HISTORY_ERRORS } = require('./agentHistoryController');

const logAgentDiagnostic = event => {
  if (event.type !== 'error' || !event.internalCause || !event.skillId) return;
  const fields = ['requestId', 'conversationId', 'agentRunId', 'skillCallId', 'agentId', 'skillId', 'code',
    'internalCause', 'skillDurationMs', 'mlCallDurationMs', 'timeoutMs'];
  const safeEvent = Object.fromEntries(fields.filter(key => event[key] !== undefined).map(key => [key, event[key]]));
  console.error('[AgentSkillDiagnostic]', JSON.stringify(safeEvent));
};

const logAgentProviderDiagnostic = event => {
  const providerAttempt = event.type === 'provider_attempt';
  if (providerAttempt && event.providerAttempt === 1 && event.status === 'SUCCEEDED' && event.evidenceCount === undefined) return;
  if (!providerAttempt && (event.type !== 'error' || !String(event.internalCause || '').startsWith('GEMINI_'))) return;
  const fields = ['requestId', 'conversationId', 'agentRunId', 'agentId', 'model', 'publicCode', 'status',
    'internalCause', 'providerStatus', 'providerCode', 'finishReason', 'llmDurationMs', 'durationMs', 'timeoutMs',
    'llmCallsBeforeFailure', 'usageAvailable', 'metricsComplete', 'responseKind', 'candidateCount',
    'hasText', 'hasFunctionCall', 'hasUsageMetadata', 'providerAttempt', 'providerAttempts', 'retryReason', 'retryScheduled',
    'firstAttemptDurationMs', 'retryDelayMs', 'secondAttemptDurationMs', 'totalProviderDurationMs',
    'promptChars', 'promptBytesApprox', 'evidenceCount', 'selectedItemsCount', 'messageCount', 'dtoFieldCount',
    'inputTokens', 'outputTokens', 'thoughtTokens', 'cachedInputTokens', 'toolUseTokens', 'totalTokens',
    'requestedModel', 'finalModel', 'fallbackUsed', 'fallbackIndex', 'fallbackScheduled'];
  const safeEvent = Object.fromEntries(fields.filter(key => event[key] !== undefined).map(key => [key, event[key]]));
  console.error('[AgentProviderDiagnostic]', JSON.stringify(safeEvent));
};

const logAgentEvent = event => {
  logAgentDiagnostic(event);
  logAgentProviderDiagnostic(event);
};

const errors = {
  ...Object.fromEntries(Object.entries(require('../automations/contracts').ERROR_MESSAGES).map(([code, message]) => [code,
    [code === 'ACTION_VALIDATION_FAILED' ? 400 : code === 'ACTION_NOT_ALLOWED' ? 403 : code === 'ACTION_EXECUTION_FAILED' ? 503 : 409, message]])),
  ...HISTORY_ERRORS,
  AGENT_INVALID_REQUEST: [400, 'La consulta no es válida.'],
  AGENT_SKILL_NOT_ALLOWED: [403, 'Acceso denegado.'],
  AGENT_BUDGET_EXCEEDED: [429, 'Se alcanzó el límite de ejecución. Inténtalo más tarde.'],
  AGENT_PROVIDER_FAILED: [503, 'El servicio de IA no está disponible temporalmente.'],
  AGENT_SKILL_FAILED: [503, 'No fue posible consultar los datos temporalmente.'],
  AGENT_INTERNAL_ERROR: [500, 'No fue posible consultar el asistente.']
};

// One runtime per router; memory, routing and usage belong to AG-R5, not HTTP.
const createAgentMessagesHandler = ({ enabled, orchestrator, history } = {}) => {
  const runtime = orchestrator || createAgentOrchestrator({ onEvent: logAgentEvent });
  return async (req, res) => {
  if (enabled !== true) return res.status(404).json({ success: false, code: 'AGENT_DISABLED', message: 'Asistente no disponible.' });
  const body = req.body;
  if (!isPlainObject(body) || Object.keys(body).some(key => !['message', 'conversationId'].includes(key))
    || typeof body.message !== 'string' || !body.message.trim()
    || (body.message.trim().length === 1 && !/^[1-5]$/.test(body.message.trim()))
    || body.message.length > EXECUTION_LIMITS.maxMessageChars
    || (Object.hasOwn(body, 'conversationId') && !isTraceId(body.conversationId))) {
    return res.status(400).json({ success: false, code: 'AGENT_INVALID_REQUEST', message: errors.AGENT_INVALID_REQUEST[1] });
  }
  const fail = code => {
    const safeCode = Object.hasOwn(errors, code) ? code : 'AGENT_INTERNAL_ERROR';
    const [status, message] = errors[safeCode];
    return res.status(status).json({ success: false, code: safeCode, message,
      ...(req.agentConversationId ? { conversationId: req.agentConversationId } : {}) });
  };
  try {
    const key = req.get('Idempotency-Key');
    if (key !== undefined && !isTraceId(key)) return fail('AGENT_INVALID_REQUEST');
    const input = { message: body.message.trim(), ...(body.conversationId ? { conversationId: body.conversationId } : {}) };
    const result = history ? await history.send(req, input, key) : await runtime.handle(req, input);
    if (result.code && !['AGENT_CLARIFICATION_REQUIRED', 'AGENT_UNSUPPORTED_QUERY'].includes(result.code)) return fail(result.code);
    // Explicit public envelope: never serialize provider responses or internal prompts.
    const fields = ['requestId', 'conversationId', 'answer', 'intent', 'agent', 'participants', 'actions', 'evidence',
      'usage', 'requiresClarification', 'clarificationQuestion', 'latencyMs', 'pendingAction', 'suggestions', 'suggestionsExpiresAt'];
    return res.json({ success: true, data: Object.fromEntries(fields.filter(key => result[key] !== undefined).map(key => [key, result[key]])) });
  } catch (error) {
    return fail(error.code);
  }
  };
};

module.exports = { createAgentMessagesHandler, logAgentDiagnostic, logAgentProviderDiagnostic, logAgentEvent };
