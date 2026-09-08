const mongoose = require('mongoose');

const telegramConnectionSchema = new mongoose.Schema({
  businessId: { type: String, required: true, unique: true, index: true },
  chatId: { type: String, unique: true, sparse: true, index: true },
  connectionCodeHash: { type: String },
  connectionCodeExpiresAt: { type: Date },
  enabled: { type: Boolean, default: true },
  lowStockAlertsEnabled: { type: Boolean, default: true },
  lastAlertAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('TelegramConnection', telegramConnectionSchema);
