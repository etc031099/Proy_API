'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  checkpointId: { type: String, required: true, immutable: true },
  collection: { type: String, required: true, immutable: true },
  chunkIndex: { type: Number, required: true, min: 0, immutable: true },
  documentCount: { type: Number, required: true, min: 0, immutable: true },
  byteCount: { type: Number, required: true, min: 1, max: 4 * 1024 * 1024, immutable: true },
  payload: { type: Buffer, required: true, immutable: true, select: false },
  contentHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true }
// Payloads use the raw driver; no hydrated document's reserved collection
// property is used. Retain the explicit wire/manifest field name.
}, { collection: 'mltestcheckpointchunks', strict: 'throw', suppressReservedKeysWarning: true, autoCreate: false, autoIndex: false });
schema.index({ checkpointId: 1, collection: 1, chunkIndex: 1 }, { unique: true, name: 'ml_test_checkpoint_chunk_uq' });
module.exports = mongoose.models.MlTestCheckpointChunk || mongoose.model('MlTestCheckpointChunk', schema);
