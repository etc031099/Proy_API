'use strict';
const { createHash } = require('node:crypto');
const { BSON } = require('mongoose').mongo;
const config = require('../config/v3Operational');
const TARGET_BYTES = 4 * 1024 * 1024;
const MAX_BSON_BYTES = 16 * 1024 * 1024;
const TENANT = ['transactions', 'inventorymovements', 'products', 'contacts', 'creditpayments',
  'v3operationalchanges', 'inventoryalerts', 'inventoryalertoutboxevents', 'inventoryalertchanneldeliveries',
  'stockalertrules', 'pendingactions', 'actionaudits', 'actiondomainevents', 'automationruns'];
const SCENARIO = ['forecastmlupdateevents', 'forecastmlupdatestates', 'forecastmlupdateexecutions',
  'forecasttrainingjobs', 'forecastmodelregistries', 'forecastmodelartifacts', 'historicalscenarios', 'minimarketv3records'];
const COLLECTIONS = Object.freeze([...TENANT.map(collection => Object.freeze({ collection, scope: 'TENANT' })),
  Object.freeze({ collection: 'v3operationalrevisions', scope: 'REVISION' }),
  ...SCENARIO.map(collection => Object.freeze({ collection, scope: 'SCENARIO' }))]);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => {
  if (value === null || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value) || value._bsontype) return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
};
const hashValue = value => digest(BSON.serialize(canonical(value)));
function authorizedScope(scope = config) {
  if (scope.businessId !== config.businessId || scope.scenarioId !== config.scenarioId) fail('CHECKPOINT_SCOPE_INVALID');
  return { businessId: config.businessId, scenarioId: config.scenarioId };
}
function scopeFilter(collection, scope) {
  const safe = authorizedScope(scope);
  const entry = COLLECTIONS.find(row => row.collection === collection);
  if (!entry) fail('CHECKPOINT_COLLECTION_FORBIDDEN');
  return entry.scope === 'REVISION' ? { _id: safe.businessId }
    : entry.scope === 'TENANT' ? { businessId: safe.businessId } : safe;
}
const bytesOf = value => Buffer.isBuffer(value) ? value
  : value instanceof Uint8Array ? Buffer.from(value)
    : value?._bsontype === 'Binary' ? Buffer.from(value.value(true)) : fail('CHECKPOINT_BINARY_INVALID');

// A chunk is a fragment of a BSON document stream, not a BSON array. A large
// document may span chunks. documentCount counts frames COMPLETED in that chunk.
async function* chunkDocuments(rawDocuments, targetBytes = TARGET_BYTES) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 64 || targetBytes > TARGET_BYTES) fail('CHECKPOINT_CHUNK_TARGET_INVALID');
  let parts = [], size = 0, completed = 0, chunkIndex = 0;
  for await (const value of rawDocuments) {
    const raw = bytesOf(value);
    if (raw.length < 5 || raw.length > MAX_BSON_BYTES || raw.readInt32LE(0) !== raw.length || raw[raw.length - 1] !== 0) fail('CHECKPOINT_BSON_INVALID');
    let offset = 0;
    while (offset < raw.length) {
      const count = Math.min(targetBytes - size, raw.length - offset);
      parts.push(raw.subarray(offset, offset + count)); size += count; offset += count;
      if (offset === raw.length) completed++;
      if (size === targetBytes) {
        const payload = Buffer.concat(parts, size);
        yield { chunkIndex: chunkIndex++, documentCount: completed, byteCount: size, payload, contentHash: digest(payload) };
        parts = []; size = 0; completed = 0;
      }
    }
  }
  if (size) {
    const payload = Buffer.concat(parts, size);
    yield { chunkIndex, documentCount: completed, byteCount: size, payload, contentHash: digest(payload) };
  }
}
class FrameVerifier {
  constructor() { this.pending = Buffer.alloc(0); this.documentCount = 0; }
  feed(payload) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, payload]) : payload;
    let offset = 0, completed = 0;
    while (this.pending.length - offset >= 4) {
      const length = this.pending.readInt32LE(offset);
      if (length < 5 || length > MAX_BSON_BYTES) fail('CHECKPOINT_BSON_INVALID');
      if (this.pending.length - offset < length) break;
      BSON.deserialize(this.pending.subarray(offset, offset + length), { promoteValues: false });
      offset += length; completed++; this.documentCount++;
    }
    this.pending = this.pending.subarray(offset);
    return completed;
  }
  finish() { if (this.pending.length) fail('CHECKPOINT_BSON_TRUNCATED'); return this.documentCount; }
}
const manifestContent = row => Object.fromEntries(['checkpointId', 'businessId', 'scenarioId', 'schemaVersion',
  'capturedAt', 'dataVersion', 'observationsClosedThroughAtCapture', 'activeModels', 'registryPointers',
  'artifactReferences', 'collectionManifest', 'documentCounts', 'byteCounts', 'indexManifest', 'totalBytes',
  'totalChunks', 'chunkTargetBytes'].map(key => [key, row[key]]));
module.exports = { BSON, COLLECTIONS, TARGET_BYTES, MAX_BSON_BYTES, fail, digest, hashValue,
  authorizedScope, scopeFilter, bytesOf, chunkDocuments, FrameVerifier, manifestContent };
