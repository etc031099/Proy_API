const mongoose = require('mongoose');
const {
  SKU_INDEX_NAME,
  SKU_INDEX_KEY,
  SKU_PARTIAL_FILTER,
  normalizeSku
} = require('../utils/sku');

const supplierPriceSchema = new mongoose.Schema({
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact',
    required: true
  },
  purchasePrice: {
    type: Number,
    required: true,
    min: [0, 'Purchase price cannot be negative']
  }
}, { _id: false });

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true,
    maxLength: [100, 'Product name cannot exceed 100 characters']
  },
  description: {
    type: String,
    trim: true,
    maxLength: [500, 'Description cannot exceed 500 characters']
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative']
  },
  currency: {
    type: String,
    enum: ['PEN', 'USD', 'EUR'],
    default: 'USD',
    uppercase: true,
    trim: true
  },
  costPrice: {
    type: Number,
    min: [0, 'Cost price cannot be negative'],
    default: 0
  },
  // Supplier purchase prices are denominated in Product.currency.
  supplierPrices: {
    type: [supplierPriceSchema],
    default: []
  },
  preferredSupplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact',
    default: null
  },
  stock: {
    type: Number,
    required: [true, 'Stock quantity is required'],
    min: [0, 'Stock cannot be negative'],
    default: 0
  },
  category: {
    type: String,
    required: [true, 'Category is required'],
    trim: true,
    maxLength: [50, 'Category cannot exceed 50 characters']
  },
  businessId: {
    type: String,
    required: [true, 'Business ID is required'],
    trim: true
  },
  sku: {
    type: String,
    trim: true,
    set: normalizeSku
  },
  isActive: {
    type: Boolean,
    default: true
  },
  minStockLevel: {
    type: Number,
    default: 0,
    min: [0, 'Minimum stock level cannot be negative']
  },
  scenarioId: { type: String, default: null, trim: true },
  sourceEventId: { type: String, default: null, trim: true }
}, {
  timestamps: true
});

// Indexes for better query performance
productSchema.index({ businessId: 1, name: 1 });
productSchema.index({ businessId: 1, category: 1 });
productSchema.index({ businessId: 1, stock: 1 });
productSchema.index({ businessId: 1, scenarioId: 1 });
productSchema.index(
  { businessId: 1, scenarioId: 1, sourceEventId: 1 },
  { unique: true, partialFilterExpression: {
    scenarioId: { $type: 'string', $gt: '' },
    sourceEventId: { $type: 'string', $gt: '' }
  } }
);
productSchema.index(SKU_INDEX_KEY, {
  name: SKU_INDEX_NAME,
  unique: true,
  partialFilterExpression: SKU_PARTIAL_FILTER
});

// Virtual for low stock indicator
productSchema.virtual('isLowStock').get(function() {
  return this.stock <= this.minStockLevel;
});

// Ensure virtual fields are included in JSON output
productSchema.set('toJSON', { virtuals: true });

// Static methods
productSchema.statics.findByBusiness = function(businessId) {
  return this.find({ businessId, isActive: true });
};

productSchema.statics.findLowStock = function(businessId) {
  return this.aggregate([
    { $match: { businessId, isActive: true } },
    { $addFields: { isLowStock: { $lte: ['$stock', '$minStockLevel'] } } },
    { $match: { isLowStock: true } }
  ]);
};

module.exports = mongoose.model('Product', productSchema);
