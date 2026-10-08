const mongoose = require('mongoose');
// Transactional outbox only: no dispatcher, scheduler or automation cascade in AUTO-R2.
// An event is visible to future consumers only after the enclosing business commit.
const schema = new mongoose.Schema({
  businessId: { type: String, required: true }, actionId: { type: String, required: true },
  type: { type: String, enum: ['PRODUCT_CREATED', 'SALE_CREATED', 'PURCHASE_CREATED', 'INVENTORY_CHANGED'], required: true },
  entityId: { type: String, required: true }, status: { type: String, enum: ['PENDING'], default: 'PENDING' }
}, { timestamps: true, strict: 'throw' });
schema.index({ businessId: 1, actionId: 1, type: 1 }, { unique: true });
module.exports = mongoose.model('ActionDomainEvent', schema);
