const mongoose = require('mongoose');

const inventoryMovementSchema = new mongoose.Schema({
  businessId: { type: String, required: true, trim: true },
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    default: null
  },
  type: {
    type: String,
    enum: ['opening', 'purchase', 'sale', 'cancellation', 'manual_adjustment'],
    required: true
  },
  quantityDelta: { type: Number, required: true },
  stockBefore: { type: Number, required: true, min: 0 },
  stockAfter: { type: Number, required: true, min: 0 },
  occurredAt: { type: Date, required: true, default: Date.now },
  source: {
    type: String,
    enum: ['api', 'historical_import', 'backfill'],
    required: true
  },
  scenarioId: { type: String, default: null, trim: true },
  sourceEventId: { type: String, default: null, trim: true }
}, {
  timestamps: { createdAt: true, updatedAt: false }
});

inventoryMovementSchema.index({ businessId: 1, productId: 1, occurredAt: 1, createdAt: 1 });
inventoryMovementSchema.index({ businessId: 1, transactionId: 1 });
inventoryMovementSchema.index({ businessId: 1, scenarioId: 1 });
inventoryMovementSchema.index(
  { businessId: 1, scenarioId: 1, sourceEventId: 1 },
  {
    name: 'businessId_1_scenarioId_1_sourceEventId_1',
    unique: true,
    partialFilterExpression: {
      scenarioId: { $type: 'string', $gt: '' },
      sourceEventId: { $type: 'string', $gt: '' }
    }
  }
);
inventoryMovementSchema.index(
  { businessId: 1, sourceEventId: 1 },
  {
    name: 'businessId_1_backfillSourceEventId_1',
    unique: true,
    partialFilterExpression: {
      source: 'backfill',
      sourceEventId: { $type: 'string', $gt: '' }
    }
  }
);

inventoryMovementSchema.pre('validate', function validateStockEquation(next) {
  const values = [this.quantityDelta, this.stockBefore, this.stockAfter];
  if (!values.every(Number.isSafeInteger)) {
    return next(new Error('Inventory movement quantities must be safe integers'));
  }
  if (this.quantityDelta === 0) {
    return next(new Error('Zero-quantity inventory movements are not allowed'));
  }
  if (this.stockAfter !== this.stockBefore + this.quantityDelta) {
    return next(new Error('Inventory movement violates stockAfter = stockBefore + quantityDelta'));
  }
  next();
});

const rejectMutation = function rejectMutation(next) {
  next(new Error('InventoryMovement is append-only'));
};

inventoryMovementSchema.pre('save', function rejectExistingDocumentSave(next) {
  if (!this.isNew) return next(new Error('InventoryMovement is append-only'));
  next();
});

for (const operation of [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace'
]) {
  inventoryMovementSchema.pre(operation, rejectMutation);
}

module.exports = mongoose.model('InventoryMovement', inventoryMovementSchema);
