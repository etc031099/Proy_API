const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  token: { type: String, required: true },
  bindingId: { type: mongoose.Schema.Types.ObjectId, required: true },
  chatId: String, telegramUserId: String, systemUserId: mongoose.Schema.Types.ObjectId, businessId: String,
  conversationId: String, sourceChannel: { type: String, enum: ['telegram'], default: 'telegram' },
  bindingGeneration: Number, keyboardRequestKey: String,
  purpose: { type: String, enum: ['candidate', 'page', 'refine', 'cancel'], required: true },
  label: { type: String, required: true, maxlength: 100 },
  position: Number,
  selectionMessage: { type: String, required: true, maxlength: 2000 },
  expiresAt: { type: Date, required: true }, messageId: Number,
  consumedRequestKey: String
}, { timestamps: true, strict: 'throw', autoCreate: false, autoIndex: false });
schema.index({ token: 1 }, { unique: true, name: 'telegram_callback_token_unique' });
schema.index({ keyboardRequestKey: 1, bindingId: 1 }, { name: 'telegram_callback_keyboard' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'telegram_callback_expiry' });
module.exports = mongoose.model('TelegramCallbackToken', schema);
