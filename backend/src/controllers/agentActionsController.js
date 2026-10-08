const { createActionContext, isTraceId, ActionError, fail } = require('../automations/contracts');
const { isPlainObject } = require('../agents/contracts');
const createAgentActionHandler = ({ enabled, service, decision }) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (enabled !== true) return res.status(404).json({ success: false, code: 'AGENT_DISABLED' });
  try {
    const body = req.body;
    if (!isPlainObject(body) || Object.keys(body).some(key => key !== 'conversationId')
      || !isTraceId(body.conversationId) || !isTraceId(req.params.id)) fail('ACTION_VALIDATION_FAILED');
    const context = createActionContext(req, { conversationId: body.conversationId });
    const data = await service[decision === 'confirm' ? 'confirmPendingAction' : 'cancelPendingAction'](context, req.params.id);
    return res.json({ success: true, data });
  } catch (error) {
    const safe = error instanceof ActionError ? error : new ActionError('ACTION_EXECUTION_FAILED');
    const status = safe.code === 'ACTION_VALIDATION_FAILED' ? 400 : safe.code === 'ACTION_NOT_ALLOWED' ? 403
      : safe.code === 'ACTION_EXECUTION_FAILED' ? 503 : 409;
    return res.status(status).json({ success: false, code: safe.code, message: safe.message });
  }
};
module.exports = { createAgentActionHandler };
