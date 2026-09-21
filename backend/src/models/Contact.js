const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Contact name is required'],
    trim: true,
    maxLength: [100, 'Name cannot exceed 100 characters']
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    trim: true
  },
  documentType: {
    type: String,
    enum: ['dni', 'ruc'],
    lowercase: true,
    trim: true
  },
  documentNumber: {
    type: String,
    trim: true,
    maxlength: [20, 'Document number cannot exceed 20 characters']
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      'Please enter a valid email'
    ]
  },
  address: {
    street: {
      type: String,
      trim: true
    },
    city: {
      type: String,
      trim: true
    },
    state: {
      type: String,
      trim: true
    },
    zipCode: {
      type: String,
      trim: true
    },
    country: {
      type: String,
      trim: true,
      default: 'India'
    }
  },
  latitude: {
    type: Number,
    min: [-90, 'Latitude must be at least -90'],
    max: [90, 'Latitude cannot exceed 90']
  },
  longitude: {
    type: Number,
    min: [-180, 'Longitude must be at least -180'],
    max: [180, 'Longitude cannot exceed 180']
  },
  type: {
    type: String,
    required: [true, 'Contact type is required'],
    enum: ['customer', 'vendor'],
    lowercase: true
  },
  businessId: {
    type: String,
    required: [true, 'Business ID is required'],
    trim: true,
    default: '20765432101'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  notes: {
    type: String,
    trim: true,
    maxLength: [500, 'Notes cannot exceed 500 characters']
  },
  // Financial tracking
  creditLimit: {
    type: Number,
    default: 0,
    min: [0, 'Credit limit cannot be negative']
  },
  currentBalance: {
    type: Number,
    default: 0
  },
  balancesByCurrency: {
    PEN: { type: Number, default: 0, min: 0 },
    USD: { type: Number, default: 0, min: 0 },
    EUR: { type: Number, default: 0, min: 0 }
  },
  scenarioId: { type: String, default: null, trim: true },
  sourceEventId: { type: String, default: null, trim: true }
}, {
  timestamps: true
});

// Indexes for better query performance
contactSchema.index({ businessId: 1, type: 1 });
contactSchema.index({ businessId: 1, name: 1 });
contactSchema.index({ phone: 1 });
contactSchema.index({ email: 1 }, { sparse: true });
contactSchema.index({ businessId: 1, scenarioId: 1 });
contactSchema.index(
  { businessId: 1, scenarioId: 1, sourceEventId: 1 },
  { unique: true, partialFilterExpression: {
    scenarioId: { $type: 'string', $gt: '' },
    sourceEventId: { $type: 'string', $gt: '' }
  } }
);

// Virtual for full address
contactSchema.virtual('fullAddress').get(function() {
  const addr = this.address;
  const parts = [addr.street, addr.city, addr.state, addr.zipCode, addr.country].filter(Boolean);
  return parts.join(', ');
});

// Virtual for contact info
contactSchema.virtual('contactInfo').get(function() {
  const info = [this.phone];
  if (this.email) info.push(this.email);
  return info.join(' | ');
});

// Ensure virtual fields are included in JSON output
contactSchema.set('toJSON', { virtuals: true });

// Static methods
contactSchema.statics.findCustomers = function(businessId) {
  return this.find({ businessId, type: 'customer', isActive: true });
};

contactSchema.statics.findVendors = function(businessId) {
  return this.find({ businessId, type: 'vendor', isActive: true });
};

contactSchema.statics.searchContacts = function(businessId, searchTerm) {
  const regex = new RegExp(searchTerm, 'i');
  return this.find({
    businessId,
    isActive: true,
    $or: [
      { name: regex },
      { phone: regex },
      { email: regex }
    ]
  });
};

// Methods
contactSchema.methods.updateBalance = function(amount) {
  this.currentBalance += amount;
  return this.save();
};

module.exports = mongoose.model('Contact', contactSchema);
