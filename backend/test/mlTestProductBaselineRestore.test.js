'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const S = require('../src/services/mlTestCheckpointService');
const R = require('../src/services/mlTestRestoreService');
const M = require('../src/services/mlTestCheckpointManifest');
const B = require('../src/services/mlTestProductBaselineService');
const T = require('../src/services/mlTestTargetAuthorization');
const F = require('../src/services/mlTestFence');
const E = require('../src/services/mlTestAdminExecutor');
const scope = M.authorizedScope();

test('authenticated LOCAL CREATE provisions auxiliary indexes before opening a checkpoint/cycle', async t => {
  const calls = [], client = {}, env = { ML_TEST_LOCAL_ENABLED: 'true' };
  const db = { async createCollection() {}, collection() { return { async createIndex() {},
    async insertOne() {}, async updateOne() {} }; } };
  t.mock.method(T, 'authorizeLocalTarget', async () => ({}));
  t.mock.method(S, 'assertExecutionTarget', () => {});
  t.mock.method(F, 'capture', async () => ({ resetEpoch: '0', testCycleId: null }));
  t.mock.method(B, 'provision', async input => {
    assert.equal(input.db, db); assert.equal(input.client, client); assert.equal(input.env, env);
    calls.push('provision'); return true;
  });
  t.mock.method(S, 'captureOperationalCheckpoint', async () => { calls.push('capture'); return { checkpointId: randomUUID(), status: 'READY' }; });
  const executor = E.createMlTestAdminExecutor({ client, db, env, target: 'LOCAL' });
  const result = await executor.execute({ user: { _id: 'authenticated-admin', isActive: true, role: 'admin', businessId: scope.businessId }, body: {}, query: {} }, 'CREATE');
  assert.equal(result.status, 'READY'); assert.deepEqual(calls, ['provision', 'capture']);
});

for (const finish of [false, true]) test(`restore ${finish ? 'finish' : 'continue'} clears auxiliary baselines in the same epoch-transition transaction`, async t => {
  const checkpointId = randomUUID(), testCycleId = randomUUID(), restoreId = randomUUID(), calls = [];
  const empty = Object.fromEntries(R.ORDER.map(name => [name, 0]));
  const hashes = Object.fromEntries(R.ORDER.map(name => [name, 'fixture-hash']));
  const checkpoint = { ...scope, checkpointId, status: 'READY', dataVersion: '173', documentCounts: empty,
    byteCounts: empty, hashes, activeModels: [] };
  const initial = { businessId: scope.businessId, state: 'TEST_ACTIVE', resetEpoch: M.BSON.Long.fromNumber(4),
    activeCheckpointId: checkpointId, testCycleId };
  const session = { inTransaction: () => true, async withTransaction(work) { return work(); }, async endSession() {} };
  const client = { startSession: () => session };
  const cursor = { sort() { return this; }, limit() { return this; }, toArray: async () => [],
    async *[Symbol.asyncIterator]() {}, async close() {} };
  const db = { async createCollection() {}, collection(name) { return {
    async findOne() { return name === 'mltestcheckpoints' ? checkpoint : name === 'mltestcontrols' ? initial : null; },
    find() { return cursor; }, countDocuments: async () => 0,
    async createIndex() {}, async insertOne() {}, async insertMany() {},
    async findOneAndUpdate(_query, _update, options) { assert.equal(options.session, session); calls.push('epoch');
      return { ...initial, state: 'RESTORING', resetEpoch: M.BSON.Long.fromNumber(5) }; },
    async deleteMany() { calls.push('source'); }, async updateOne() { return { matchedCount: 1 }; }
  }; } };
  t.mock.method(S, 'assertExecutionTarget', () => {});
  t.mock.method(S, 'verifyLocalCheckpoint', async () => {});
  t.mock.method(S, 'scanSource', async () => ({ documentCounts: empty, byteCounts: empty, hashes, dataVersion: '173', totalDocuments: 0, totalBytes: 0 }));
  t.mock.method(B, 'clearCycle', async input => {
    assert.equal(input.db, db); assert.equal(input.client, client);
    assert.equal(input.session, session); assert.equal(input.checkpointId, checkpointId); assert.equal(input.testCycleId, testCycleId);
    calls.push('baseline-cleanup');
  });
  const result = await R.restoreLocalCheckpoint({ client, db, checkpointId, restoreId, scope, branch: 'NORMAL', finish });
  assert.equal(result.status, finish ? 'NO_TEST' : 'TEST_ACTIVE');
  assert(calls.indexOf('epoch') < calls.indexOf('baseline-cleanup'));
  assert(calls.indexOf('baseline-cleanup') < calls.indexOf('source'));
});
