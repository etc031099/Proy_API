const mongoose = require('mongoose');

const creditPaymentSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  businessId: { type: String, required: true, trim: true },
  amount: { type: Number, required: true, min: 0.01 },
  currency: { type: String, enum: ['PEN', 'USD', 'EUR'], required: true },
  paymentMethod: { type: String, enum: ['cash', 'card', 'bank_transfer', 'wallet'], required: true },
  date: { type: Date, default: Date.now },
  notes: { type: String, trim: true, maxlength: 500 }
}, { timestamps: true });

creditPaymentSchema.index({ businessId: 1, customerId: 1, date: -1 });

module.exports = mongoose.model('CreditPayment', creditPaymentSchema);
