const mongoose = require('mongoose');
const { isTraceId } = require('../agents/contracts');
const schema = new mongoose.Schema({
  updateId: { type: Number, required: true },
  requestKey: { type: String, required: true, validate: isTraceId },
  bindingId: { type: mongoose.Schema.Types.ObjectId, required: true },
  bindingGeneration: { type: Number, required: true },
  sequence: { type: Number, required: true },
  // Only a collision fingerprint; never store incoming text, raw updates or commercial DTOs here.
  fingerprint: { type: String, required: true },
  status: { type: String, enum: ['RECEIVED', 'PROCESSING', 'OUTPUT_READY', 'COMPLETED', 'FAILED', 'UNCERTAIN', 'DELIVERY_UNKNOWN'], required: true },
  control: { type: String, enum: ['start', 'transfer', 'candidate', 'page', 'refine', 'cancel', 'CONFIRM_ACTION', 'CANCEL_ACTION'] },
  pendingActionId: String,
  callbackQueryId: String, callbackMessageId: Number, callbackExpiresAt: Date, keyboardRequestKey: String,
  callbackAcked: Boolean,
  ownerToken: String, leaseUntil: Date, invocationStarted: { type: Boolean, default: false },
  deliveryIndex: { type: Number, default: 0 }, sending: { type: Boolean, default: false },
  deliveredMessageIds: { type: [Number], default: [] },
  resultCode: String, completedAt: Date
}, { timestamps: true, strict: 'throw', autoCreate: false, autoIndex: false });
schema.index({ updateId: 1 }, { unique: true, name: 'telegram_update_unique' });
schema.index({ requestKey: 1 }, { unique: true, name: 'telegram_request_unique' });
schema.index({ bindingId: 1, sequence: 1 }, { unique: true, name: 'telegram_binding_sequence_unique' });
schema.index({ status: 1, sequence: 1, _id: 1 }, { name: 'telegram_receipt_recovery' });
// No TTL: deleting receipts would allow old updates to be admitted again.
module.exports = mongoose.model('TelegramUpdateReceipt', schema);
