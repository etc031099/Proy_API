'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  checkpointId: { type: String, required: true, immutable: true },
  businessId: { type: String, required: true, immutable: true },
  scenarioId: { type: String, required: true, immutable: true },
  createdBy: { type: String, default: null },
  status: { type: String, required: true, enum: ['CREATING', 'READY', 'FAILED'] },
  capturedAt: { type: Date, required: true },
  dataVersion: { type: String, default: null },
  observationsClosedThroughAtCapture: { type: String, required: true },
  activeModels: { type: [mongoose.Schema.Types.Mixed], default: [] },
  registryPointers: { type: [mongoose.Schema.Types.Mixed], default: [] },
  artifactReferences: { type: [mongoose.Schema.Types.Mixed], default: [] },
  collectionManifest: { type: [mongoose.Schema.Types.Mixed], default: [] },
  documentCounts: { type: mongoose.Schema.Types.Mixed, default: {} },
  byteCounts: { type: mongoose.Schema.Types.Mixed, default: {} },
  hashes: { type: mongoose.Schema.Types.Mixed, default: {} },
  indexManifest: { type: [mongoose.Schema.Types.Mixed], default: [] },
  schemaVersion: { type: Number, required: true, enum: [1] },
  totalBytes: { type: Number, required: true, min: 0 },
  totalChunks: { type: Number, required: true, min: 0 },
  chunkTargetBytes: { type: Number, required: true, min: 64, max: 4 * 1024 * 1024 },
  failureCode: { type: String, default: null }
}, { collection: 'mltestcheckpoints', timestamps: true, strict: 'throw', autoCreate: false, autoIndex: false });
schema.index({ checkpointId: 1 }, { unique: true, name: 'ml_test_checkpoint_id_uq' });
schema.index({ businessId: 1, scenarioId: 1, status: 1, createdAt: -1 }, { name: 'ml_test_checkpoint_status' });
module.exports = mongoose.models.MlTestCheckpoint || mongoose.model('MlTestCheckpoint', schema);
