const { isPlainObject } = require('../agents/contracts');
const HISTORY_ERRORS = {
  AGENT_CONVERSATION_NOT_FOUND: [404, 'Conversación no encontrada.'],
  AGENT_HISTORY_CONFLICT: [409, 'La consulta ya está en proceso o su resultado no pudo confirmarse. Recarga el historial antes de enviar otra.'],
  AGENT_HISTORY_BUSY: [409, 'Esta conversación tiene una consulta en proceso.'],
  AGENT_HISTORY_LIMIT: [429, 'Esta conversación alcanzó su límite. Inicia una nueva.'],
  AGENT_HISTORY_PERSISTENCE_FAILED: [503, 'No se pudo confirmar el guardado. Recarga el historial; no se repetirá la generación automáticamente.']
};
const createAgentHistoryHandler = ({ enabled, history, operation }) => async (req, res) => {
  if (enabled !== true) return res.status(404).json({ success: false, code: 'AGENT_DISABLED', message: 'Asistente no disponible.' });
  try {
    if (!isPlainObject(req.query) || Object.keys(req.query).some(key => !['page', 'limit'].includes(key))) {
      return res.status(400).json({ success: false, code: 'AGENT_INVALID_REQUEST', message: 'Solicitud no válida.' });
    }
    if (Object.values(req.query).some(value => typeof value !== 'string' || !/^\d+$/.test(value))
      || operation === 'remove' && Object.keys(req.body || {}).length) {
      return res.status(400).json({ success: false, code: 'AGENT_INVALID_REQUEST', message: 'Solicitud no válida.' });
    }
    const page = Number(req.query.page ?? 1), limit = Number(req.query.limit ?? (operation === 'get' ? 50 : 10));
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || operation === 'remove' && Object.keys(req.query).length) return res.status(400).json({ success: false, code: 'AGENT_INVALID_REQUEST', message: 'Solicitud no válida.' });
    const data = operation === 'list' ? await history.list(req, page, limit)
      : operation === 'get' ? await history.get(req, req.params.conversationId, page, limit) : await history.remove(req, req.params.conversationId);
    return res.json({ success: true, data });
  } catch (error) {
    const [status, message] = HISTORY_ERRORS[error.code] || [503, 'No fue posible cargar el historial. Inténtalo nuevamente.'];
    return res.status(status).json({ success: false, code: HISTORY_ERRORS[error.code] ? error.code : 'AGENT_HISTORY_UNAVAILABLE', message });
  }
};
module.exports = { createAgentHistoryHandler, HISTORY_ERRORS };
