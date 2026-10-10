const mongoose = require('mongoose');
// Configuration only; InventoryAlert stores crossings detected during real stock changes.
const schema = new mongoose.Schema({
  businessId: { type: String, required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, required: true },
  operator: { type: String, enum: ['<', '<='], required: true },
  threshold: { type: Number, required: true, min: 0, max: 1000000, validate: Number.isSafeInteger },
  enabled: { type: Boolean, default: true, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, required: true }
}, { timestamps: true, strict: 'throw' });
schema.index({ businessId: 1, productId: 1, operator: 1, threshold: 1 },
  { unique: true, partialFilterExpression: { enabled: true } });
schema.index({ businessId: 1, productId: 1, enabled: 1 });
module.exports = mongoose.model('StockAlertRule', schema);
