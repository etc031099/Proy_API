const { createAgentOrchestrator } = require('../agents/orchestrator');
const { EXECUTION_LIMITS, isPlainObject, isTraceId } = require('../agents/contracts');

const logAgentDiagnostic = event => {
  if (event.type !== 'error' || !event.internalCause || !event.skillId) return;
  const fields = ['requestId', 'conversationId', 'agentRunId', 'skillCallId', 'agentId', 'skillId', 'code',
    'internalCause', 'skillDurationMs', 'mlCallDurationMs', 'timeoutMs'];
  const safeEvent = Object.fromEntries(fields.filter(key => event[key] !== undefined).map(key => [key, event[key]]));
  console.error('[AgentSkillDiagnostic]', JSON.stringify(safeEvent));
};

const errors = {
  AGENT_INVALID_REQUEST: [400, 'La consulta no es válida.'],
  AGENT_SKILL_NOT_ALLOWED: [403, 'Acceso denegado.'],
  AGENT_BUDGET_EXCEEDED: [429, 'Se alcanzó el límite de ejecución. Inténtalo más tarde.'],
  AGENT_PROVIDER_FAILED: [503, 'El servicio de IA no está disponible temporalmente.'],
  AGENT_SKILL_FAILED: [503, 'No fue posible consultar los datos temporalmente.'],
  AGENT_INTERNAL_ERROR: [500, 'No fue posible consultar el asistente.']
};

// One runtime per router; memory, routing and usage belong to AG-R5, not HTTP.
const createAgentMessagesHandler = ({ enabled, orchestrator } = {}) => {
  const runtime = orchestrator || createAgentOrchestrator({ onEvent: logAgentDiagnostic });
  return async (req, res) => {
  if (enabled !== true) return res.status(404).json({ success: false, code: 'AGENT_DISABLED', message: 'Asistente no disponible.' });
  const body = req.body;
  if (!isPlainObject(body) || Object.keys(body).some(key => !['message', 'conversationId'].includes(key))
    || typeof body.message !== 'string' || body.message.trim().length < 2
    || body.message.length > EXECUTION_LIMITS.maxMessageChars
    || (Object.hasOwn(body, 'conversationId') && !isTraceId(body.conversationId))) {
    return res.status(400).json({ success: false, code: 'AGENT_INVALID_REQUEST', message: errors.AGENT_INVALID_REQUEST[1] });
  }
  const fail = code => {
    const safeCode = Object.hasOwn(errors, code) ? code : 'AGENT_INTERNAL_ERROR';
    const [status, message] = errors[safeCode];
    return res.status(status).json({ success: false, code: safeCode, message });
  };
  try {
    const result = await runtime.handle(req, { message: body.message.trim(),
      ...(body.conversationId ? { conversationId: body.conversationId } : {}) });
    if (result.code && !['AGENT_CLARIFICATION_REQUIRED', 'AGENT_UNSUPPORTED_QUERY'].includes(result.code)) return fail(result.code);
    // Explicit public envelope: never serialize provider responses or internal prompts.
    const fields = ['requestId', 'conversationId', 'answer', 'intent', 'agent', 'participants', 'actions', 'evidence',
      'usage', 'requiresClarification', 'clarificationQuestion', 'latencyMs'];
    return res.json({ success: true, data: Object.fromEntries(fields.map(key => [key, result[key]])) });
  } catch (error) {
    return fail(error.code);
  }
  };
};

module.exports = { createAgentMessagesHandler, logAgentDiagnostic };
