'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  _id: { type: String, required: true }, // authenticated businessId; one row per tenant
  revision: { type: mongoose.Schema.Types.BigInt, required: true, default: 0n, min: 0n },
  bootstrapStatus: { type: String, enum: ['UNVERIFIED', 'VERIFIED'], required: true, default: 'UNVERIFIED' },
  historicalDatasetVersion: { type: String, default: null },
  historicalDatasetSha256: { type: String, default: null }
}, { versionKey: false, timestamps: true });

schema.plugin(require('../services/mlTestFence').modelPlugin);
module.exports = mongoose.models.V3OperationalRevision
  || mongoose.model('V3OperationalRevision', schema);
