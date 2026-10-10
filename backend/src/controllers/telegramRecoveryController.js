const { telegramRecovery } = require('../services/telegramRecovery');
const createTelegramRecoveryHandler = ({ service = telegramRecovery, configured = () => Boolean(process.env.TELEGRAM_BOT_TOKEN) } = {}) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.body == null || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) {
    return res.status(400).json({ success: false, code: 'INVALID_RECOVERY_REQUEST', message: 'La solicitud debe estar vacía.' });
  }
  if (!configured()) return res.status(503).json({ success: false, code: 'TELEGRAM_RECOVERY_UNAVAILABLE', message: 'Telegram no está disponible.' });
  try {
    const data = await service.initiate({ businessId: req.businessId, userId: req.user._id });
    return res.json({ success: true, data });
  } catch (error) {
    const errors = {
      TELEGRAM_RECOVERY_FORBIDDEN: [403, 'No tienes acceso al negocio.'],
      TELEGRAM_DESTINATION_CONNECTED: [409, 'Desconecta primero el Telegram actual de este negocio.'],
      TELEGRAM_RECOVERY_RATE_LIMITED: [429, 'Espera unos minutos antes de solicitar otro código.'],
      TELEGRAM_RECOVERY_CONFLICT: [409, 'Otra solicitud está en curso. Vuelve a intentarlo.']
    };
    const code = Object.hasOwn(errors, error.code) ? error.code : 'TELEGRAM_RECOVERY_UNAVAILABLE';
    const [status, message] = errors[code] || [503, 'No se pudo iniciar la recuperación. Vuelve a intentarlo.'];
    return res.status(status).json({ success: false, code, message });
  }
};
module.exports = { createTelegramRecoveryHandler };
