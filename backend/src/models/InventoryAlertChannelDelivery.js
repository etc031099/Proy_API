const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  businessId: { type: String, required: true, immutable: true },
  eventId: { type: String, required: true, immutable: true },
  channel: { type: String, enum: ['telegram'], default: 'telegram', immutable: true },
  destinationKey: { type: String, required: true, immutable: true },
  productId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  sku: { type: String, required: true, immutable: true },
  eventType: { type: String, enum: ['inventory.alert.opened', 'inventory.alert.resolved'], required: true, immutable: true },
  status: { type: String, enum: ['PENDING', 'IN_FLIGHT', 'DELIVERED', 'SKIPPED', 'FAILED'], default: 'PENDING' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lastAttemptAt: Date,
  deliveredAt: Date,
  leaseUntil: Date,
  leaseToken: String,
  skipReason: { type: String, enum: ['telegram_not_configured', 'telegram_disabled', 'preference_disabled', 'unsupported_event', 'destination_changed'] },
  lastErrorCategory: { type: String, enum: ['TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'UNAVAILABLE', 'AUTH', 'FORBIDDEN', 'INVALID_CHAT', 'CONFIGURATION', 'INVALID_RESPONSE'] }
}, { timestamps: true, strict: 'throw' });
schema.index({ eventId: 1, channel: 1, destinationKey: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
schema.index({ businessId: 1, createdAt: -1 });
module.exports = mongoose.model('InventoryAlertChannelDelivery', schema);
