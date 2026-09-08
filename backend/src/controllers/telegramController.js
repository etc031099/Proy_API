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
      lowStockAlertsEnabled: connection?.lowStockAlertsEnabled ?? false
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

module.exports = { getStatus, generateConnectionCode, disconnectTelegram };
