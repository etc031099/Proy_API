'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  businessId: { type: String, required: true },
  scenarioId: { type: String, required: true },
  horizonDays: { type: Number, required: true, enum: [7, 14] },
  eventKey: { type: String, required: true },
  eventType: { type: String, required: true, enum: ['SALE_COMPLETED', 'SALE_CANCELLED', 'PRODUCT_UPDATED'] },
  entityKey: { type: String, required: true },
  dataVersion: { type: mongoose.Schema.Types.BigInt, required: true },
  affectedLocalDate: { type: String, default: null },
  historicalCorrection: { type: Boolean, required: true, default: false },
  occurredAt: { type: Date, required: true }
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, strict: 'throw' });

schema.index({ businessId: 1, scenarioId: 1, horizonDays: 1, eventKey: 1 },
  { unique: true, name: 'forecast_ml_update_event_key_uq' });
schema.index({ businessId: 1, scenarioId: 1, horizonDays: 1, dataVersion: 1 },
  { name: 'forecast_ml_update_event_revision' });

module.exports = mongoose.models.ForecastMlUpdateEvent || mongoose.model('ForecastMlUpdateEvent', schema);
