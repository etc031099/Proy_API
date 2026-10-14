const mongoose = require('mongoose');

const purchaseReceiptLineSchema = new mongoose.Schema({
  stableLineKey: { type: String, required: true, trim: true },
  receivedQty: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  purchaseUnitCostCents: { type: Number, default: null, min: 0, validate: value => value == null || Number.isSafeInteger(value) },
  costBasis: { type: String, enum: ['OBSERVED_RECEIPT_COST', 'ORDER_COST', 'PRODUCT_CURRENT_COST', 'HISTORICAL_COST', 'UNAVAILABLE'], required: true },
  currency: { type: String, default: null, trim: true }
}, { _id: false, strict: 'throw' });

const purchaseReceiptSchema = new mongoose.Schema({
  receiptKey: { type: String, required: true, trim: true, minlength: 8, maxlength: 160 },
  receivedAtUtc: { type: Date, required: true },
  lines: { type: [purchaseReceiptLineSchema], required: true, validate: value => value.length > 0 }
}, { _id: false, strict: 'throw' });

const purchaseLifecycleSchema = new mongoose.Schema({
  fulfillmentMode: { type: String, enum: ['IMMEDIATE', 'DEFERRED'], required: true },
  orderedAtUtc: { type: Date, required: true },
  promisedAtUtc: { type: Date, default: null },
  receiptState: { type: String, enum: ['NONE', 'COMPLETE'], required: true, default: 'NONE' },
  receipts: { type: [purchaseReceiptSchema], default: [] }
}, { _id: false, strict: 'throw' });

const transactionItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'Product ID is required']
  },
  productName: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: [true, 'Quantity is required'],
    min: [1, 'Quantity must be at least 1']
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative']
  },
  // Purchase cost captured at the time of purchase; sale price remains in price.
  costPrice: {
    type: Number,
    min: [0, 'Cost price cannot be negative']
  },
  total: {
    type: Number,
    required: true
  },
  sku: { type: String, default: null, trim: true },
  productKey: { type: String, default: null, trim: true },
  stableLineKey: { type: String, default: null, trim: true },
  sourceEventId: { type: String, default: null, trim: true },
  requestedQuantity: { type: Number, default: null },
  unitsSold: { type: Number, default: null },
  discountCents: { type: Number, default: null },
  costCents: { type: Number, default: null }
}, { _id: false });

const transactionSchema = new mongoose.Schema({
  type: {
    type: String,
    required: [true, 'Transaction type is required'],
    enum: ['sale', 'purchase'],
    lowercase: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact',
  },
  customerName: {
    type: String,
    required: function() { return this.type === 'sale'; },
    default: function() { return this.type === 'sale' ? 'Consumidor final' : undefined; },
    trim: true
  },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact',
    required: function() { return this.type === 'purchase'; }
  },
  vendorName: {
    type: String,
    required: function() { return this.type === 'purchase'; }
  },
  // Alias retained alongside vendorId so purchase records expose their supplier explicitly.
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact'
  },
  products: [transactionItemSchema],
  totalAmount: {
    type: Number,
    required: [true, 'Total amount is required'],
    min: [0, 'Total amount cannot be negative']
  },
  currency: {
    type: String,
    enum: ['PEN', 'USD', 'EUR'],
    default: 'PEN',
    uppercase: true,
    trim: true
  },
  exchangeRate: {
    type: Number,
    default: 1,
    min: [0.0001, 'Exchange rate must be greater than zero']
  },
  originalAmount: {
    type: Number,
    default: 0,
    min: [0, 'Original amount cannot be negative']
  },
  date: {
    type: Date,
    required: [true, 'Transaction date is required'],
    default: Date.now
  },
  businessId: {
    type: String,
    required: [true, 'Business ID is required'],
    trim: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'cancelled'],
    default: 'completed'
  },
  cancelledAt: {
    type: Date,
    default: null
  },
  scenarioId: { type: String, default: null, trim: true },
  sourceEventId: { type: String, default: null, trim: true },
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'bank_transfer', 'credit', 'crypto', 'bitcoin', 'tether', 'wallet', 'other'],
    default: 'cash',
    lowercase: true,
    trim: true
  },
  notes: {
    type: String,
    trim: true,
    maxLength: [500, 'Notes cannot exceed 500 characters']
  },
  invoiceNumber: {
    type: String,
    trim: true
  },
  stableCode: { type: String, default: null, trim: true },
  localDate: { type: String, default: null, trim: true },
  sourceEventId: { type: String, default: null, trim: true },
  scenarioData: { type: mongoose.Schema.Types.Mixed, default: null },
  purchaseLifecycle: { type: purchaseLifecycleSchema, default: null }
}, {
  timestamps: true
});

// Indexes for better query performance
transactionSchema.index({ businessId: 1, date: -1 });
transactionSchema.index({ businessId: 1, type: 1, date: -1 });
transactionSchema.index({ businessId: 1, customerId: 1 });
transactionSchema.index({ businessId: 1, vendorId: 1 });
transactionSchema.index({ businessId: 1, scenarioId: 1 });
transactionSchema.index(
  { businessId: 1, scenarioId: 1, sourceEventId: 1 },
  { unique: true, partialFilterExpression: {
    scenarioId: { $type: 'string', $gt: '' },
    sourceEventId: { $type: 'string', $gt: '' }
  } }
);
transactionSchema.index({ invoiceNumber: 1 }, { sparse: true });
transactionSchema.index(
  { businessId: 1, 'purchaseLifecycle.receipts.receiptKey': 1 },
  { unique: true, name: 'transaction_v3_receipt_key_uq', partialFilterExpression: {
    'purchaseLifecycle.receipts.receiptKey': { $type: 'string' }
  } }
);

// Pre-save middleware to calculate totals while preserving explicit currency conversions
transactionSchema.pre('save', function(next) {
  this.products.forEach(item => {
    item.total = Number(item.quantity || 0) * Number(item.price || 0);
  });

  const computedTotal = this.products.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const explicitTotal = Number(this.totalAmount);

  if (Number.isFinite(explicitTotal) && explicitTotal > 0) {
    this.totalAmount = explicitTotal;
  } else {
    this.totalAmount = computedTotal;
  }

  next();
});

// Virtual for transaction summary
transactionSchema.virtual('summary').get(function() {
  const contactName = this.type === 'sale' ? this.customerName : this.vendorName;
  const itemCount = this.products.length;
  const totalQty = this.products.reduce((sum, item) => sum + item.quantity, 0);
  
  return {
    id: this._id,
    type: this.type,
    contactName,
    itemCount,
    totalQuantity: totalQty,
    totalAmount: this.totalAmount,
    date: this.date
  };
});

// Ensure virtual fields are included in JSON output
transactionSchema.set('toJSON', { virtuals: true });

// Static methods
transactionSchema.statics.findByDateRange = function(businessId, startDate, endDate) {
  return this.find({
    businessId,
    date: {
      $gte: startDate,
      $lte: endDate
    }
  }).sort({ date: -1 });
};

transactionSchema.statics.findByContact = function(businessId, contactId, contactType) {
  const filter = { businessId };
  if (contactType === 'customer') {
    filter.customerId = contactId;
  } else {
    filter.vendorId = contactId;
  }
  return this.find(filter).sort({ date: -1 });
};

transactionSchema.statics.getRevenue = function(businessId, startDate, endDate) {
  const matchStage = {
    businessId,
    type: 'sale',
    status: 'completed'
  };
  
  if (startDate && endDate) {
    matchStage.date = { $gte: startDate, $lte: endDate };
  }
  
  return this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$totalAmount' },
        transactionCount: { $sum: 1 }
      }
    }
  ]);
};

transactionSchema.statics.getExpenses = function(businessId, startDate, endDate) {
  const matchStage = {
    businessId,
    type: 'purchase',
    status: 'completed'
  };
  
  if (startDate && endDate) {
    matchStage.date = { $gte: startDate, $lte: endDate };
  }
  
  return this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalExpenses: { $sum: '$totalAmount' },
        transactionCount: { $sum: 1 }
      }
    }
  ]);
};

module.exports = mongoose.model('Transaction', transactionSchema);
