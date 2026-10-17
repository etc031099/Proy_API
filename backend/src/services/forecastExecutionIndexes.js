'use strict';

async function verifyExecutionIndexes(model = require('../models/ForecastMlUpdateExecution')) {
  let actual;
  try { actual = await model.collection.indexes(); }
  catch { throw Object.assign(new Error('ML_HISTORY_NOT_READY'), { code: 'ML_HISTORY_NOT_READY' }); }
  for (const [key, expected] of model.schema.indexes()) {
    const index = actual.find(row => row.name === expected.name);
    if (!index || JSON.stringify(index.key) !== JSON.stringify(key) || Boolean(index.unique) !== Boolean(expected.unique)
        || JSON.stringify(index.partialFilterExpression) !== JSON.stringify(expected.partialFilterExpression)) {
      throw Object.assign(new Error('ML_HISTORY_NOT_READY'), { code: 'ML_HISTORY_NOT_READY' });
    }
  }
}

// Explicit additive provisioning on backend startup, never from a history GET
// or the read-only worker preflight. No syncIndexes/drop/rebuild of old indexes.
async function provisionExecutionIndexes(model = require('../models/ForecastMlUpdateExecution')) {
  await model.createCollection();
  await model.createIndexes();
  await verifyExecutionIndexes(model);
}

module.exports = { verifyExecutionIndexes, provisionExecutionIndexes };
