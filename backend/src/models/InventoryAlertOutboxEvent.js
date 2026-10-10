const mongoose = require('mongoose');
// Immutable business snapshot; only delivery metadata changes after insertion.
const schema = new mongoose.Schema({
  eventId: { type: String, required: true, immutable: true },
  eventType: { type: String, enum: ['inventory.alert.opened', 'inventory.alert.resolved'], required: true, immutable: true },
  businessId: { type: String, required: true, immutable: true },
  alertId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  productId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  status: { type: String, enum: ['PENDING', 'IN_FLIGHT', 'DELIVERED', 'FAILED'], default: 'PENDING' },
  attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: Date, leaseToken: String, deliveredAt: Date, lastAttemptAt: Date,
  lastErrorCategory: { type: String, enum: ['NETWORK', 'TIMEOUT', 'RATE_LIMIT', 'UNAVAILABLE', 'AUTH', 'PAYLOAD', 'DISABLED', 'INVALID_ACK'] },
  receivedAt: Date
}, { timestamps: true, strict: 'throw' });
schema.index({ eventId: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
module.exports = mongoose.model('InventoryAlertOutboxEvent', schema);
