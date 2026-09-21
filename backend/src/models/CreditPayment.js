const mongoose = require('mongoose');

const creditPaymentSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  businessId: { type: String, required: true, trim: true },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, enum: ['PEN', 'USD', 'EUR'], required: true },
  paymentMethod: { type: String, enum: ['cash', 'card', 'bank_transfer', 'wallet'], required: true },
  date: { type: Date, default: Date.now },
  notes: { type: String, trim: true, maxlength: 500 },
  scenarioId: { type: String, default: null, trim: true },
  sourceEventId: { type: String, default: null, trim: true }
}, { timestamps: true });

creditPaymentSchema.index({ businessId: 1, customerId: 1, date: -1 });
creditPaymentSchema.index({ businessId: 1, scenarioId: 1 });
creditPaymentSchema.index(
  { businessId: 1, scenarioId: 1, sourceEventId: 1 },
  { unique: true, partialFilterExpression: {
    scenarioId: { $type: 'string', $gt: '' },
    sourceEventId: { $type: 'string', $gt: '' }
  } }
);

module.exports = mongoose.model('CreditPayment', creditPaymentSchema);
