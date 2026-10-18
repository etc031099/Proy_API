'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const config = require('../config/v3Operational');
const cycles = new AsyncLocalStorage();
let cacheGeneration = 0;
const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409, httpStatus: 409 }); };
const tokenOf = row => Object.freeze({ resetEpoch: String(row?.resetEpoch ?? 0),
  testCycleId: row?.testCycleId ?? null, present: Boolean(row), state: row?.state || 'NO_TEST' });
const sameToken = (a, b) => a.resetEpoch === b.resetEpoch && a.testCycleId === b.testCycleId && a.present === b.present;
async function capture(db) {
  return tokenOf(await db.collection('mltestcontrols').findOne({ businessId: config.businessId }, { promoteLongs: false }));
}
async function withEpoch(db, work, expected) {
  if (cycles.getStore()) {
    if (expected && !sameToken(expected, cycles.getStore())) fail('STALE_TEST_EPOCH');
    return work();
  }
  const token = expected || await capture(db);
  // Await Mongoose thenables INSIDE the context; returning a lazy Query would
  // otherwise execute its hooks only after AsyncLocalStorage.run has exited.
  return cycles.run(token, async () => await work());
}
function runCycle(work, expected) {
  if (cycles.getStore()) {
    if (expected && !sameToken(expected, cycles.getStore())) fail('STALE_TEST_EPOCH');
    return work();
  }
  if (mongoose.connection.readyState !== 1) return work();
  return withEpoch(mongoose.connection.db, work, expected);
}
async function mutationTransaction(work) {
  if (mongoose.connection.readyState !== 1) return work();
  return runCycle(async () => {
    const context = cycles.getStore();
    // Production paths retain their existing transaction boundaries.
    if (!context?.present || await externalAllowed()) return work();
    if (context.session?.inTransaction()) return work();
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => cycles.run({ ...context, session }, async () => await work()),
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }); }
    finally { await session.endSession(); }
  });
}
// The write to the control document creates a real write conflict with restore.
// A read-before-write check alone would permit stale transaction commits.
async function guard({ db, session, expected = cycles.getStore() }) {
  const controls = db.collection('mltestcontrols');
  const row = await controls.findOne({ businessId: config.businessId }, { session, promoteLongs: false });
  if (expected && (expected.resetEpoch !== String(row?.resetEpoch ?? 0)
      || expected.testCycleId !== (row?.testCycleId ?? null) || expected.present !== Boolean(row))) fail('STALE_TEST_EPOCH');
  if (!row || row.state === 'NO_TEST') return;
  if (!expected) fail('TEST_EPOCH_CONTEXT_REQUIRED');
  if (row.state !== 'TEST_ACTIVE') fail('TEST_RESTORE_BLOCKED');
  if (!session?.inTransaction()) fail('TEST_TRANSACTION_REQUIRED');
  let changed;
  try { changed = await controls.updateOne({ businessId: config.businessId, state: 'TEST_ACTIVE',
    resetEpoch: row.resetEpoch, testCycleId: expected.testCycleId }, { $set: { writeFenceNonce: randomUUID() } }, { session }); }
  catch (error) {
    if (error.code === 112 || error.hasErrorLabel?.('TransientTransactionError')) {
      const latest = tokenOf(await controls.findOne({ businessId: config.businessId }, { promoteLongs: false }));
      if (!sameToken(expected, latest)) fail('STALE_TEST_EPOCH');
    }
    throw error;
  }
  if (changed.matchedCount !== 1) fail('STALE_TEST_EPOCH');
}
async function externalAllowed(db = mongoose.connection.db, expected = cycles.getStore()) {
  if (!db) return true;
  const row = await db.collection('mltestcontrols').findOne({ businessId: config.businessId }, { promoteLongs: false });
  if (expected && !sameToken(expected, tokenOf(row))) return false;
  return !row || row.state === 'NO_TEST';
}
async function cacheIdentity() {
  if (mongoose.connection.readyState !== 1) return 'NO_TEST';
  const token = await capture(mongoose.connection.db);
  if (['RESTORING', 'FAILED', 'CHECKPOINT_CREATING'].includes(token.state)) fail('TEST_RESTORE_BLOCKED');
  return `${token.present}:${token.testCycleId || ''}:${token.resetEpoch}:${cacheGeneration}`;
}
// Applied only to checkpoint allowlisted models. Raw administrative restore uses
// the driver deliberately; raw application writers are not implicitly trusted.
function modelPlugin(schema) {
  async function check(model, session, docs, filter, update) {
    const db = model.db.db;
    if (!db) return;
    let relevant = docs?.some(doc => doc.businessId === config.businessId || String(doc._id) === config.businessId);
    relevant ||= filter?.businessId === config.businessId || String(filter?._id) === config.businessId
      || update?.$set?.businessId === config.businessId || update?.$setOnInsert?.businessId === config.businessId;
    if (!relevant && docs?.some(doc => doc.isNew === false)) {
      relevant = Boolean(await db.collection(model.collection.name).findOne({ businessId: config.businessId,
        _id: { $in: docs.filter(doc => doc.isNew === false).map(doc => doc._id) } }, { session, projection: { _id: 1 } }));
    }
    if (!relevant && !docs) {
      const scope = model.collection.name === 'v3operationalrevisions' ? { _id: config.businessId } : { businessId: config.businessId };
      relevant = Boolean(await db.collection(model.collection.name).findOne({ $and: [filter || {}, scope] },
        { session, projection: { _id: 1 } }));
    }
    if (relevant) await guard({ db, session });
  }
  schema.pre('save', async function() {
    if (!this.$session() && cycles.getStore()?.session) this.$session(cycles.getStore().session);
    await check(this.constructor, this.$session(), [this]);
  });
  schema.pre('insertMany', function(next, docs, options) {
    if (options && !options.session && cycles.getStore()?.session) options.session = cycles.getStore().session;
    check(this, options?.session, docs).then(() => next(), next);
  });
  schema.pre('bulkWrite', function(next, operations, options) {
    if (options && !options.session && cycles.getStore()?.session) options.session = cycles.getStore().session;
    (async () => { for (const operation of operations) {
      const entry = Object.values(operation)[0];
      await check(this, options?.session, entry.document ? [entry.document] : null, entry.filter, entry.update || entry.replacement);
    } })().then(() => next(), next);
  });
  schema.pre(['updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate', 'findOneAndReplace',
    'deleteOne', 'deleteMany', 'findOneAndDelete'], { query: true, document: false }, async function() {
    if (!this.getOptions().session && cycles.getStore()?.session) this.session(cycles.getStore().session);
    await check(this.model, this.getOptions().session, null, this.getFilter(), this.getUpdate());
  });
  schema.pre('deleteOne', { document: true, query: false }, async function() {
    await check(this.constructor, this.$session(), [this]);
  });
}
module.exports = { capture, withEpoch, runCycle, mutationTransaction, guard, externalAllowed, cacheIdentity, modelPlugin,
  invalidateCaches: () => { cacheGeneration++; },
  current: () => cycles.getStore(), fail };
