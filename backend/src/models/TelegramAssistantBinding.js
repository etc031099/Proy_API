const mongoose = require('mongoose');
const { isTraceId } = require('../agents/contracts');
// Transport identity is separate from notification preferences and transferable destinations.
const schema = new mongoose.Schema({
  chatId: { type: String, required: true }, telegramUserId: { type: String, required: true },
  systemUserId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  businessId: { type: String, required: true, maxlength: 50 },
  conversationId: { type: String, required: true, validate: isTraceId },
  bindingGeneration: { type: Number, required: true, min: 1 },
  active: { type: Boolean, required: true, default: true },
  nextSequence: { type: Number, required: true, default: 0 },
  processingVersion: { type: Number, required: true, default: 0 },
  activeReceiptId: { type: mongoose.Schema.Types.ObjectId, default: null },
  keyboardRequestKey: { type: String, default: null },
  keyboardClaimKey: { type: String, default: null }
}, { timestamps: true, strict: 'throw', autoCreate: false, autoIndex: false });
schema.index({ chatId: 1 }, { unique: true, name: 'telegram_assistant_chat_unique' });
schema.index({ businessId: 1 }, { unique: true, name: 'telegram_assistant_business_unique' });
schema.index({ conversationId: 1 }, { unique: true, name: 'telegram_assistant_conversation_unique' });
module.exports = mongoose.model('TelegramAssistantBinding', schema);
