const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');
const rateLimit = require('express-rate-limit');
const { readTelegramConfig } = require('../config/telegramAssistant');
const { createTelegramAssistantTransport } = require('../services/telegramAssistantTransport');
const createTelegramWebhookRoutes = ({ config = readTelegramConfig, transport = createTelegramAssistantTransport() } = {}) => {
  const router = express.Router();
  const reply = (res, status, code) => res.status(status).json({ success: status === 200, code });
  router.post('/', rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { success: false, code: 'TELEGRAM_RATE_LIMITED' } }), (req, res, next) => {
    let settings;
    try { settings = config(); } catch { return reply(res, 503, 'TELEGRAM_CHANNEL_DISABLED'); }
    if (!settings.enabled || settings.mode !== 'webhook') return reply(res, 503, 'TELEGRAM_CHANNEL_DISABLED');
    const received = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (typeof received !== 'string' || received.length > 256 || !settings.secret
      || !timingSafeEqual(createHash('sha256').update(received).digest(), createHash('sha256').update(settings.secret).digest()))
      return reply(res, 401, 'TELEGRAM_WEBHOOK_UNAUTHORIZED');
    if (Object.keys(req.query).length || !req.is('application/json') || req.get('content-encoding') && req.get('content-encoding') !== 'identity')
      return reply(res, 415, 'TELEGRAM_INVALID_CONTENT_TYPE');
    return next();
  }, express.json({ limit: '16kb', strict: true, inflate: false }), async (req, res) => {
    try {
      const result = await transport.admit(req.body);
      // A durable RECEIVED record exists. Recovery is independent of this HTTP request.
      return res.status(200).json({ success: true, status: result.status, duplicate: result.duplicate });
    } catch (error) {
      const statuses = { TELEGRAM_UNAUTHORIZED: 403, TELEGRAM_UPDATE_UNSUPPORTED: 400, TELEGRAM_BINDING_REVOKED: 403,
        TELEGRAM_UPDATE_CONFLICT: 409, TELEGRAM_CALLBACK_INVALID: 403 };
      const status = statuses[error.code] || 503;
      return reply(res, status, statuses[error.code] ? error.code : 'TELEGRAM_TRANSPORT_UNAVAILABLE');
    }
  });
  router.use((error, req, res, next) => {
    if (!error) return next();
    return reply(res, error.type === 'entity.too.large' ? 413 : 400, error.type === 'entity.too.large' ? 'TELEGRAM_PAYLOAD_TOO_LARGE' : 'TELEGRAM_INVALID_JSON');
  });
  return router;
};
module.exports = { createTelegramWebhookRoutes };
