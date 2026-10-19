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
function parseToken(value) {
  let token; try { token = typeof value === 'string' ? JSON.parse(value) : value; } catch { fail('TEST_EPOCH_INVALID'); }
  if (!token || typeof token !== 'object' || Object.keys(token).some(key => !['resetEpoch', 'testCycleId', 'present'].includes(key))
      || typeof token.present !== 'boolean' || typeof token.resetEpoch !== 'string' || !/^(0|[1-9]\d*)$/.test(token.resetEpoch)
      || BigInt(token.resetEpoch) > 9223372036854775807n
      || (token.testCycleId !== null && (typeof token.testCycleId !== 'string' || !/^[a-f0-9-]{36}$/.test(token.testCycleId)))) fail('TEST_EPOCH_INVALID');
  return Object.freeze({ resetEpoch: String(token.resetEpoch), testCycleId: token.testCycleId, present: token.present });
}
const durableToken = token => Object.fromEntries(['resetEpoch', 'testCycleId', 'present'].map(key => [key, token[key]]));
async function assertCurrent(db, expected) {
  if (!sameToken(expected, await capture(db))) fail('STALE_TEST_EPOCH');
}
async function runClaim(work, claim) {
  if (mongoose.connection.readyState === 1) {
    const token = await capture(mongoose.connection.db);
    if (token.present && BigInt(token.resetEpoch) > 0n && !claim?.testEpoch) fail('TEST_EPOCH_REQUIRED');
    if (claim?.testEpoch) await assertCurrent(mongoose.connection.db, parseToken(claim.testEpoch));
  }
  return runCycle(work, claim?.testEpoch);
}
async function capture(db) {
  return tokenOf(await db.collection('mltestcontrols').findOne({ businessId: config.businessId }, { promoteLongs: false }));
}
async function withEpoch(db, work, expected) {
  if (cycles.getStore()) {
    if (expected && !sameToken(expected, cycles.getStore())) fail('STALE_TEST_EPOCH');
    return work();
  }
  const token = expected || await capture(db);
  if (expected) await assertCurrent(db, expected);
  // Await Mongoose thenables INSIDE the context; returning a lazy Query would
  // otherwise execute its hooks only after AsyncLocalStorage.run has exited.
  return cycles.run({ ...token }, async () => await work());
}
function runCycle(work, expected, scope) {
  if (scope?.businessId && scope.businessId !== config.businessId) return work();
  if (cycles.getStore()) {
    if (expected && !sameToken(expected, cycles.getStore())) fail('STALE_TEST_EPOCH');
    return withWriter(mongoose.connection.db, work, cycles.getStore());
  }
  if (mongoose.connection.readyState !== 1) return work();
  return withEpoch(mongoose.connection.db, () => withWriter(mongoose.connection.db, work, cycles.getStore()), expected);
}
// Admission and CHECKPOINT_CREATING contend on the SAME durable document.
// Entries have no TTL: an interrupted writer must never silently expire while
// it may still commit. A failed drain keeps maintenance closed for inspection.
async function withWriter(db, work, expected = cycles.getStore()) {
  if (expected?.writer) {
    if (expected.writer.closed) fail('TEST_WRITER_FINISHED');
    return work();
  }
  const controls = db.collection('mltestcontrols');
  let row = await controls.findOne({ businessId: config.businessId }, { promoteLongs: false });
  if (!row) {
    try {
      await controls.updateOne({ businessId: config.businessId }, { $setOnInsert: {
        _id: config.businessId, businessId: config.businessId, state: 'NO_TEST',
        resetEpoch: mongoose.mongo.BSON.Long.ZERO, testCycleId: null, activeCheckpointId: null,
        activeWriterIds: [], createdAt: new Date(), updatedAt: new Date()
      } }, { upsert: true, writeConcern: { w: 'majority' } });
    } catch (error) { if (error.code !== 11000) throw error; }
    row = await controls.findOne({ businessId: config.businessId }, { promoteLongs: false });
  }
  const token = tokenOf(row);
  // A pristine NO_TEST singleton is the only allowed absent -> present change.
  const initialized = expected?.present === false && token.present && token.resetEpoch === '0'
    && token.testCycleId === null && token.state === 'NO_TEST';
  if (expected && !sameToken(expected, token) && !initialized) fail('STALE_TEST_EPOCH');
  // Keep an outer read-only launch context consistent when its first mutation
  // creates the pristine singleton. No test cycle or epoch can be adopted here.
  if (initialized && expected === cycles.getStore()) Object.assign(expected, token);
  if (!['NO_TEST', 'TEST_ACTIVE'].includes(token.state)) fail('TEST_RESTORE_BLOCKED');
  const writer = { id: randomUUID(), closed: false, abandoned: false };
  const admitted = await controls.updateOne({ businessId: config.businessId,
    resetEpoch: row.resetEpoch, testCycleId: token.testCycleId, state: token.state },
  { $addToSet: { activeWriterIds: writer.id } }, { writeConcern: { w: 'majority' } });
  if (admitted.matchedCount !== 1) fail('TEST_RESTORE_BLOCKED');
  try { return await cycles.run({ ...token, writer }, async () => await work()); }
  finally {
    writer.closed = true;
    if (!writer.abandoned) await controls.updateOne({ businessId: config.businessId },
      { $pull: { activeWriterIds: writer.id } }, { writeConcern: { w: 'majority' } });
  }
}
// Express next() returns before async controllers finish. Hold admission until
// the response completes; a disconnected response retains its durable blocker.
function untilResponseFinished(res, next) {
  const writer = cycles.getStore()?.writer;
  return new Promise((resolve, reject) => {
    const finish = () => { res.off('close', close); resolve(); };
    const close = () => {
      res.off('finish', finish);
      if (writer) writer.abandoned = !res.writableFinished;
      resolve();
    };
    res.once('finish', finish); res.once('close', close);
    try { next(); } catch (error) { res.off('finish', finish); res.off('close', close); reject(error); }
  });
}
async function drainWriters(db, control, { timeoutMs = 30000, pollMs = 50 } = {}) {
  const started = Date.now();
  while (true) {
    const row = await db.collection('mltestcontrols').findOne({ businessId: config.businessId }, { promoteLongs: false });
    if (!row || row.state !== 'CHECKPOINT_CREATING' || row.activeCheckpointId !== control.activeCheckpointId
        || !sameToken(tokenOf(row), tokenOf(control))) fail('CHECKPOINT_CONTROL_CONFLICT');
    if (row.activeWriterIds != null && !Array.isArray(row.activeWriterIds)) fail('CHECKPOINT_WRITER_STATE_INVALID');
    if (!row.activeWriterIds?.length) return;
    if (Date.now() - started >= timeoutMs) fail('CHECKPOINT_WRITER_DRAIN_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
async function mutationTransaction(work) {
  if (mongoose.connection.readyState !== 1) return work();
  return runCycle(async () => {
    const context = cycles.getStore();
    // Production paths retain their existing transaction boundaries.
    if (!context?.present) return work();
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
  if (!row) return;
  if (!expected) fail('TEST_EPOCH_CONTEXT_REQUIRED');
  if (expected.writer?.closed) fail('TEST_WRITER_FINISHED');
  if (!['TEST_ACTIVE', 'NO_TEST'].includes(row.state)) fail('TEST_RESTORE_BLOCKED');
  if (row.state === 'NO_TEST' && !session?.inTransaction()
      && expected.writer && row.activeWriterIds?.includes(expected.writer.id)) return;
  if (!session?.inTransaction()) fail('TEST_TRANSACTION_REQUIRED');
  let changed;
  try { changed = await controls.updateOne({ businessId: config.businessId, state: row.state,
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
async function cacheIdentityDetails() {
  if (mongoose.connection.readyState !== 1) return { identity: 'NO_TEST', testEpoch: null };
  const token = await capture(mongoose.connection.db);
  if (['RESTORING', 'FAILED', 'CHECKPOINT_CREATING'].includes(token.state)) fail('TEST_RESTORE_BLOCKED');
  return {
    identity: `${token.present}:${token.testCycleId || ''}:${token.resetEpoch}:${cacheGeneration}`,
    testEpoch: token.state === 'TEST_ACTIVE' && token.testCycleId
      ? { testCycleId: token.testCycleId, resetEpoch: token.resetEpoch }
      : null,
  };
}
async function cacheIdentity() { return (await cacheIdentityDetails()).identity; }
// Applied only to checkpoint allowlisted models. Raw administrative restore uses
// the driver deliberately; raw application writers are not implicitly trusted.
function modelPlugin(schema) {
  async function relevant(model, session, docs, filter, update) {
    const db = model.db.db;
    if (!db) return false;
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
    return relevant;
  }
  async function check(model, session, docs, filter, update) {
    if (await relevant(model, session, docs, filter, update)) await guard({ db: model.db.db, session });
  }
  // Preserve standalone NO_TEST model writes, but count their COMPLETE promise
  // rather than releasing admission in a pre-hook before Mongo actually writes.
  // After a test epoch exists the original explicit-context requirement remains.
  async function ordinary(model, session, entries, work) {
    if (cycles.getStore()) return work();
    let scoped = false;
    for (const entry of entries) if (await relevant(model, session, entry.docs, entry.filter, entry.update)) { scoped = true; break; }
    if (!scoped) return work();
    const db = model.db.db, token = await capture(db);
    if (token.present && (token.state !== 'NO_TEST' || token.resetEpoch !== '0')) return work();
    if (!session?.inTransaction()) return withWriter(db, work, token);
    // A transaction writes the same control document in guard(), holding its
    // conflict fence until COMMIT. Do not await an outside release while that
    // transaction owns the document lock. Initialize BEFORE entering the query.
    let pinned;
    await withWriter(db, async () => { pinned = { ...durableToken(cycles.getStore()), state: 'NO_TEST' }; }, token);
    return cycles.run(pinned, async () => await work());
  }
  const queryMutations = new Set(['updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate',
    'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']);
  const wrapped = new WeakSet();
  schema.on('init', model => {
    if (wrapped.has(model)) return;
    wrapped.add(model);
    const exec = model.Query.prototype.exec;
    model.Query.prototype.exec = function(...args) {
      if (!queryMutations.has(this.op || args[0])) return exec.apply(this, args);
      return ordinary(this.model, this.getOptions().session,
        [{ filter: this.getFilter(), update: this.getUpdate() }], () => exec.apply(this, args));
    };
    for (const method of ['save', '$save']) {
      const save = model.prototype[method];
      model.prototype[method] = function(...args) {
        return ordinary(this.constructor, args[0]?.session || this.$session(), [{ docs: [this] }], () => save.apply(this, args));
      };
    }
    for (const method of ['insertMany', 'bulkWrite']) {
      const write = model[method];
      model[method] = function(input, options, ...args) {
        const entries = method === 'insertMany' ? [{ docs: Array.isArray(input) ? input : [input] }]
          : (input || []).map(operation => {
            const entry = Object.values(operation)[0];
            return { docs: entry.document ? [entry.document] : null, filter: entry.filter, update: entry.update || entry.replacement };
          });
        return ordinary(this, options?.session, entries, () => write.call(this, input, options, ...args));
      };
    }
  });
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
module.exports = { capture, withEpoch, runCycle, mutationTransaction, guard, externalAllowed, cacheIdentity, cacheIdentityDetails, modelPlugin,
  withWriter, untilResponseFinished, drainWriters,
  parseToken, durableToken, assertCurrent, runClaim, tokenOf,
  invalidateCaches: () => { cacheGeneration++; },
  current: () => cycles.getStore(), fail };
