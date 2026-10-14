'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  businessId: { type: String, required: true, trim: true },
  scenarioId: { type: String, required: true, trim: true },
  revision: { type: mongoose.Schema.Types.BigInt, required: true, min: 1n },
  eventOrdinal: { type: Number, required: true, min: 0 },
  eventKey: { type: String, required: true, trim: true },
  effectiveAtUtc: { type: Date, required: true },
  entityType: { type: String, enum: ['sale', 'purchase', 'product', 'customer', 'supplier', 'movement', 'transaction'], required: true },
  entityKey: { type: String, required: true, trim: true },
  operation: { type: String, enum: ['CREATE', 'UPDATE', 'DEACTIVATE', 'CANCEL', 'ADJUST', 'RECEIVE'], required: true },
  projection: { type: mongoose.Schema.Types.Mixed, default: null }
}, { versionKey: false, timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' });

schema.index({ businessId: 1, revision: 1, eventOrdinal: 1 }, { unique: true, name: 'v3_operational_change_revision_ordinal_uq' });
schema.index({ businessId: 1, effectiveAtUtc: 1, revision: 1 }, { name: 'v3_operational_change_asof' });
schema.index(
  { businessId: 1, 'projection.receiptKey': 1 },
  { unique: true, name: 'v3_operational_change_receipt_key_uq', partialFilterExpression: {
    operation: 'RECEIVE', 'projection.receiptKey': { $type: 'string' }
  } }
);

module.exports = mongoose.models.V3OperationalChange
  || mongoose.model('V3OperationalChange', schema);
