'use strict';

const safeError = code => Object.assign(new Error(code), { code });
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, stable(value[key])]));
  return value;
};
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
const sameKey = (left, right) => left && right
  && JSON.stringify(Object.entries(left)) === JSON.stringify(Object.entries(right));

function compatibleIndex(actual, key, expected) {
  // Index names and the legacy `background` option do not change index
  // semantics. Compare the ordered key pattern and options affecting behavior.
  return sameKey(actual.key, key)
    && Boolean(actual.unique) === Boolean(expected.unique)
    && Boolean(actual.sparse) === Boolean(expected.sparse)
    && Boolean(actual.hidden) === Boolean(expected.hidden)
    && (actual.expireAfterSeconds ?? null) === (expected.expireAfterSeconds ?? null)
    && same(actual.partialFilterExpression ?? null, expected.partialFilterExpression ?? null)
    && same(actual.collation ?? null, expected.collation ?? null);
}

function inspectIndexes(actual, model) {
  for (const [key, expected] of model.schema.indexes()) {
    const samePattern = actual.filter(row => sameKey(row.key, key));
    if (actual.some(row => row.name === expected.name && !sameKey(row.key, key))) {
      throw safeError('ML_HISTORY_INDEX_NAME_CONFLICT');
    }
    if (samePattern.length === 1 && compatibleIndex(samePattern[0], key, expected)) continue;
    if (samePattern.length) throw safeError('ML_HISTORY_INDEX_INCOMPATIBLE');
    if (actual.some(row => row.name === expected.name)) throw safeError('ML_HISTORY_INDEX_NAME_CONFLICT');
    throw safeError('ML_HISTORY_INDEX_MISSING');
  }
}

async function verifyExecutionIndexes(model = require('../models/ForecastMlUpdateExecution')) {
  let actual;
  try { actual = await model.collection.indexes(); }
  catch (error) {
    if (error?.code === 26 || error?.codeName === 'NamespaceNotFound') {
      throw safeError('ML_HISTORY_INDEX_MISSING');
    }
    throw safeError('ML_HISTORY_NOT_READY');
  }
  inspectIndexes(actual, model);
  return { status: 'READY', verifiedCount: model.schema.indexes().length };
}

// Explicit additive provisioning on backend startup, never from a history GET
// or the read-only worker preflight. No syncIndexes/drop/rebuild of old indexes.
async function provisionExecutionIndexes(model = require('../models/ForecastMlUpdateExecution')) {
  await model.createCollection();
  let actual = await model.collection.indexes();
  let provisionedCount = 0;
  for (const [key, expected] of model.schema.indexes()) {
    const samePattern = actual.filter(row => sameKey(row.key, key));
    if (actual.some(row => row.name === expected.name && !sameKey(row.key, key))) {
      throw safeError('ML_HISTORY_INDEX_NAME_CONFLICT');
    }
    if (samePattern.length === 1 && compatibleIndex(samePattern[0], key, expected)) continue;
    if (samePattern.length) throw safeError('ML_HISTORY_INDEX_INCOMPATIBLE');
    if (actual.some(row => row.name === expected.name)) throw safeError('ML_HISTORY_INDEX_NAME_CONFLICT');
    await model.collection.createIndex(key, expected);
    provisionedCount += 1;
    actual = await model.collection.indexes();
  }
  inspectIndexes(actual, model);
  return { status: 'READY', provisionedCount,
    verifiedCount: model.schema.indexes().length };
}

module.exports = { verifyExecutionIndexes, provisionExecutionIndexes, compatibleIndex, inspectIndexes };
