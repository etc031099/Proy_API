'use strict';
const mongoose = require('mongoose');
// Auxiliary LOCAL test metadata: deliberately excluded from the checkpoint
// allowlist. Provisioned only after the local target and active cycle checks.
const schema = new mongoose.Schema({
  businessId: { type: String, required: true, immutable: true },
  scenarioId: { type: String, required: true, immutable: true },
  checkpointId: { type: String, required: true, immutable: true },
  testCycleId: { type: String, required: true, immutable: true },
  resetEpoch: { type: String, required: true, immutable: true },
  sku: { type: String, required: true, immutable: true },
  productId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  productName: { type: String, required: true, immutable: true },
  presentation: { type: String, default: null, immutable: true },
  baselineRevision: { type: String, required: true, immutable: true },
  capturedRevision: { type: String, required: true, immutable: true },
  capturedAt: { type: Date, required: true, immutable: true },
  trigger: { type: String, enum: ['SALE_COMPLETED', 'SALE_CANCELLED'], required: true, immutable: true },
  stock: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  forecast7: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  forecast14: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  coverage: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  risk: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  recommendation: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  createdAt: { type: Date, required: true, immutable: true }
}, { collection: 'mltestproductbaselines', autoCreate: false, autoIndex: false, strict: 'throw' });
schema.index({ businessId: 1, scenarioId: 1, checkpointId: 1, testCycleId: 1, resetEpoch: 1, sku: 1 },
  { unique: true, name: 'ml_test_product_baseline_epoch_sku_uq' });
module.exports = mongoose.models.MlTestProductBaseline || mongoose.model('MlTestProductBaseline', schema);
