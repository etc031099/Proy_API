const express = require('express');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const {
  getStatus,
  generateConnectionCode,
  disconnectTelegram,
  updatePreferences
} = require('../controllers/telegramController');

const router = express.Router();
router.use(authenticate);
router.use(checkBusinessAccess);
const recoveryLimiter = require('express-rate-limit')({ windowMs: 10 * 60 * 1000, limit: 3,
  keyGenerator: req => `${req.businessId}:${req.user._id}`, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, code: 'TELEGRAM_RECOVERY_RATE_LIMITED', message: 'Espera antes de solicitar otro código.' } });
router.post('/recovery/code', recoveryLimiter, require('../controllers/telegramRecoveryController').createTelegramRecoveryHandler());
router.get('/status', getStatus);
router.patch('/preferences', updatePreferences);
router.post('/connect/code', generateConnectionCode);
router.delete('/connection', disconnectTelegram);

module.exports = router;
