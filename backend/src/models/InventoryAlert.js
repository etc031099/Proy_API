const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  businessId: { type: String, required: true }, actionId: { type: String, required: true },
  type: { type: String, enum: ['LOW_STOCK', 'REPLENISHMENT_REQUIRED', 'TRANSACTION_ANOMALY'], required: true },
  productId: mongoose.Schema.Types.ObjectId, label: { type: String, required: true, maxlength: 160 },
  status: { type: String, enum: ['OPEN', 'RESOLVED'], default: 'OPEN' }
}, { timestamps: true, strict: 'throw' });
schema.index({ businessId: 1, actionId: 1 }, { unique: true });
module.exports = mongoose.model('InventoryAlert', schema);
