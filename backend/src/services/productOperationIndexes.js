'use strict';

const INDEX_MANIFEST = Object.freeze([
  Object.freeze({
    name: 'product_ops_tx_created_v1', collection: 'transactions',
    key: Object.freeze({ businessId: 1, 'products.productId': 1, type: 1, date: -1, _id: -1 }),
    unique: false, sparse: false
  }),
  Object.freeze({
    name: 'product_ops_tx_cancelled_v1', collection: 'transactions',
    key: Object.freeze({ businessId: 1, 'products.productId': 1, cancelledAt: -1, _id: -1 }),
    unique: false, sparse: false,
    partialFilterExpression: Object.freeze({ type: 'sale', status: 'cancelled', cancelledAt: Object.freeze({ $type: 'date' }) })
  }),
  Object.freeze({
    name: 'product_ops_mov_events_v1', collection: 'inventorymovements',
    key: Object.freeze({ businessId: 1, productId: 1, type: 1, occurredAt: -1, _id: -1 }),
    unique: false, sparse: false,
    partialFilterExpression: Object.freeze({ $or: Object.freeze([
      Object.freeze({ type: 'manual_adjustment' }),
      Object.freeze({ type: 'purchase', reason: 'v3_purchase_receipt' }),
      Object.freeze({ type: 'purchase', 'scenarioData.type': 'purchase_receipt' })
    ]) })
  }),
  Object.freeze({
    name: 'product_ops_change_entity_v1', collection: 'v3operationalchanges',
    key: Object.freeze({ businessId: 1, scenarioId: 1, entityKey: 1 }), unique: false, sparse: false
  })
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null));
}

function sameOrderedKey(left, right) {
  return Boolean(left && right)
    && JSON.stringify(Object.entries(left)) === JSON.stringify(Object.entries(right));
}

function matchesDefinition(actual, spec) {
  return sameOrderedKey(actual.key, spec.key)
    && Boolean(actual.unique) === spec.unique
    && Boolean(actual.sparse) === spec.sparse
    && sameValue(actual.partialFilterExpression, spec.partialFilterExpression);
}

function inspectOneIndex(actualIndexes, spec) {
  const byName = actualIndexes.find(index => index.name === spec.name);
  if (byName) {
    return matchesDefinition(byName, spec)
      ? { name: spec.name, collection: spec.collection, status: 'PRESENT', actualIndexName: byName.name }
      : { name: spec.name, collection: spec.collection, status: 'CONFLICT', actualIndexName: byName.name };
  }
  const equivalent = actualIndexes.find(index => matchesDefinition(index, spec));
  if (equivalent) return { name: spec.name, collection: spec.collection,
    status: 'PRESENT', actualIndexName: equivalent.name, compatibleName: true };
  const sameKey = actualIndexes.find(index => sameOrderedKey(index.key, spec.key));
  if (sameKey) return { name: spec.name, collection: spec.collection,
    status: 'CONFLICT', actualIndexName: sameKey.name };
  return { name: spec.name, collection: spec.collection, status: 'MISSING', actualIndexName: null };
}

async function readIndexStates(db) {
  const existingCollections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name));
  const cache = new Map();
  const states = [];
  for (const spec of INDEX_MANIFEST) {
    if (!existingCollections.has(spec.collection)) {
      states.push({ name: spec.name, collection: spec.collection, status: 'MISSING', actualIndexName: null,
        collectionMissing: true });
      continue;
    }
    if (!cache.has(spec.collection)) cache.set(spec.collection, await db.collection(spec.collection).indexes());
    states.push(inspectOneIndex(cache.get(spec.collection), spec));
  }
  return states;
}

async function checkProductOperationIndexes(db) {
  if (!db || typeof db.collection !== 'function' || typeof db.listCollections !== 'function') {
    throw safeError('PRODUCT_OP_INDEX_DATABASE_UNAVAILABLE');
  }
  const indexes = await readIndexStates(db);
  return { status: indexes.some(index => index.status === 'CONFLICT') ? 'CONFLICT'
    : indexes.some(index => index.status === 'MISSING') ? 'MISSING' : 'READY', indexes };
}

async function provisionProductOperationIndexes(db) {
  const before = await checkProductOperationIndexes(db);
  if (before.status === 'CONFLICT') throw safeError('PRODUCT_OP_INDEX_CONFLICT', { indexes: before.indexes });
  const missing = before.indexes.filter(index => index.status === 'MISSING');
  if (missing.some(index => index.collectionMissing)) {
    throw safeError('PRODUCT_OP_INDEX_COLLECTION_MISSING', { indexes: before.indexes });
  }
  for (const state of missing) {
    const spec = INDEX_MANIFEST.find(item => item.name === state.name);
    const options = { name: spec.name, unique: spec.unique, sparse: spec.sparse };
    if (spec.partialFilterExpression) options.partialFilterExpression = spec.partialFilterExpression;
    await db.collection(spec.collection).createIndex(spec.key, options);
  }
  const after = await checkProductOperationIndexes(db);
  if (after.status !== 'READY') throw safeError(after.status === 'CONFLICT'
    ? 'PRODUCT_OP_INDEX_CONFLICT' : 'PRODUCT_OP_INDEX_VERIFY_FAILED', { indexes: after.indexes });
  return { status: 'READY', createdCount: missing.length, indexes: after.indexes };
}

function safeError(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details) error.details = details;
  return error;
}

module.exports = { INDEX_MANIFEST, canonical, sameValue, sameOrderedKey, matchesDefinition,
  inspectOneIndex, readIndexStates, checkProductOperationIndexes, provisionProductOperationIndexes, safeError };
