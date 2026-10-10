const { asyncHandler } = require('../middleware/validation');
const telegramService = require('../services/telegramService');

const getStatus = asyncHandler(async (req, res) => {
  const connection = await telegramService.getConnection(req.businessId);
  res.json({
    success: true,
    data: {
      configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      connected: Boolean(connection?.chatId),
      enabled: connection?.enabled ?? false,
      lowStockAlertsEnabled: connection?.lowStockAlertsEnabled ?? false,
      stockRuleAlertsEnabled: connection?.stockRuleAlertsEnabled === true,
      stockRuleResolvedAlertsEnabled: connection?.stockRuleResolvedAlertsEnabled === true
    }
  });
});

const generateConnectionCode = asyncHandler(async (req, res) => {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return res.status(503).json({ success: false, message: 'Telegram notifications are not configured.' });
  }
  const result = await telegramService.createConnectionCode(req.businessId);
  res.json({ success: true, data: result });
});

const disconnectTelegram = asyncHandler(async (req, res) => {
  await telegramService.disconnect(req.businessId);
  res.json({ success: true, message: 'Telegram notifications disconnected.' });
});

const updatePreferences = asyncHandler(async (req, res) => {
  const allowed = ['stockRuleAlertsEnabled', 'stockRuleResolvedAlertsEnabled'];
  if (!req.body || Array.isArray(req.body) || !Object.keys(req.body).length
    || Object.keys(req.body).some(key => !allowed.includes(key) || typeof req.body[key] !== 'boolean')) {
    return res.status(400).json({ success: false, message: 'Invalid Telegram preferences.' });
  }
  const connection = await require('../models/TelegramConnection').findOneAndUpdate(
    { businessId: req.businessId }, { $set: req.body }, { new: true, runValidators: true });
  if (!connection) return res.status(409).json({ success: false, message: 'Connect Telegram first.' });
  res.json({ success: true, data: {
    stockRuleAlertsEnabled: connection.stockRuleAlertsEnabled === true,
    stockRuleResolvedAlertsEnabled: connection.stockRuleResolvedAlertsEnabled === true
  } });
});
module.exports = { getStatus, generateConnectionCode, disconnectTelegram, updatePreferences };
