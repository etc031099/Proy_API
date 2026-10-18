'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  businessId: { type: String, required: true, trim: true },
  scenarioId: { type: String, required: true, trim: true },
  recordType: { type: String, required: true, enum: ['category', 'promotion', 'price_history', 'supplier_cost_history'] },
  stableKey: { type: String, required: true, trim: true },
  sourceEventId: { type: String, required: true, trim: true },
  localDate: { type: String, default: null, trim: true },
  canonicalData: { type: mongoose.Schema.Types.Mixed, required: true }
}, { timestamps: true });

schema.index({ businessId: 1, scenarioId: 1, recordType: 1, stableKey: 1 }, { unique: true, name: 'v3_record_stable_key' });
schema.index({ businessId: 1, scenarioId: 1, localDate: 1 });

schema.plugin(require('../services/mlTestFence').modelPlugin);
module.exports = mongoose.model('MinimarketV3Record', schema);
