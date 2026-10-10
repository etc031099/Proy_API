const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  businessId: { type: String, required: true }, actionId: { type: String, required: true },
  type: { type: String, enum: ['LOW_STOCK', 'REPLENISHMENT_REQUIRED', 'TRANSACTION_ANOMALY'], required: true },
  productId: mongoose.Schema.Types.ObjectId, label: { type: String, required: true, maxlength: 160 },
  status: { type: String, enum: ['OPEN', 'RESOLVED'], default: 'OPEN' },
  source: { type: String, enum: ['automatic', 'stock_alert_rule'], default: 'automatic' },
  ruleId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockAlertRule', default: null },
  inventoryMovementId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryMovement', default: null },
  condition: { type: new mongoose.Schema({
    operator: { type: String, enum: ['<', '<='], required: true },
    threshold: { type: Number, min: 0, max: 1000000, required: true, validate: Number.isSafeInteger }
  }, { _id: false, strict: 'throw' }), default: undefined },
  previousStock: { type: Number, min: 0, validate: Number.isSafeInteger },
  newStock: { type: Number, min: 0, validate: Number.isSafeInteger }
}, { timestamps: true, strict: 'throw' });
schema.index({ businessId: 1, actionId: 1 }, { unique: true });
schema.index({ businessId: 1, ruleId: 1, inventoryMovementId: 1 },
  { unique: true, partialFilterExpression: { source: 'stock_alert_rule' } });
schema.pre('validate', function validateRuleEvidence(next) {
  if (this.source === 'stock_alert_rule' && (!this.ruleId || !this.inventoryMovementId || !this.productId
    || !this.condition || !Number.isSafeInteger(this.previousStock) || !Number.isSafeInteger(this.newStock))) {
    this.invalidate('source', 'Stock rule events require rule, movement, product, condition and stock evidence');
  }
  next();
});
module.exports = mongoose.model('InventoryAlert', schema);
