'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  businessId: { type: String, required: true, trim: true },
  scenarioId: { type: String, required: true, trim: true },
  horizonDays: { type: Number, required: true, enum: [7, 14] },
  activeModelVersion: { type: Number, default: null, min: 1, validate: value => value == null || Number.isSafeInteger(value) },
  activeArtifactId: { type: mongoose.Schema.Types.ObjectId, default: null },
  generation: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
  lastIssuedModelVersion: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger }
}, { timestamps: true, strict: 'throw', minimize: false });

schema.index({ businessId: 1, scenarioId: 1, horizonDays: 1 },
  { unique: true, name: 'forecast_model_registry_scope_uq' });

schema.pre('validate', function validateActivePointer(next) {
  const hasId = this.activeArtifactId != null;
  const hasVersion = this.activeModelVersion != null;
  if (hasId !== hasVersion || (hasVersion && this.activeModelVersion > this.lastIssuedModelVersion)) {
    this.invalidate('activeArtifactId', 'Active artifact id and version must be set together and reference an issued version.');
  }
  next();
});

module.exports = mongoose.models.ForecastModelRegistry
  || mongoose.model('ForecastModelRegistry', schema);
