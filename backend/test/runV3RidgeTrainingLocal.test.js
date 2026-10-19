'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runner = require('../scripts/run-v3-ridge-training-local');
const fence = require('../src/services/mlTestFence');
const updateCoordinator = require('../src/services/forecastMlUpdateCoordinator');
const { describePending } = require('../src/services/forecastCloudWorker');
const config = require('../src/config/v3Operational');

const active = { state: 'TEST_ACTIVE', resetEpoch: '5', testCycleId: '11111111-1111-4111-8111-111111111111', present: true };

test('local runner accepts only localhost Mongo and requires rs0 PRIMARY', () => {
  assert.equal(runner.assertLocalTarget('mongodb://localhost:27017/inventory_billing?replicaSet=rs0').hostname, 'localhost');
  assert.throws(() => runner.assertLocalTarget('mongodb+srv://cluster.example.mongodb.net/inventory_billing'));
  assert.throws(() => runner.assertLocalTarget('mongodb://cluster.example.net:27017/inventory_billing?replicaSet=rs0'));
  runner.assertLocalReplicaSetPrimary({ setName: 'rs0', isWritablePrimary: true });
  assert.throws(() => runner.assertLocalReplicaSetPrimary({ setName: 'other', isWritablePrimary: true }));
  assert.throws(() => runner.assertLocalReplicaSetPrimary({ setName: 'rs0', isWritablePrimary: false }));
});

test('drain calls the existing runEligible inside the exact captured TEST_ACTIVE epoch', async () => {
  const row = { state: active.state, resetEpoch: require('mongoose').mongo.BSON.Long.fromString(active.resetEpoch),
    testCycleId: active.testCycleId };
  const db = { collection: () => ({ findOne: async () => row }) };
  const captured = await fence.capture(db);
  const calls = [];
  const worker = { runEligible: async input => {
    calls.push({ input, token: fence.current() });
    return { status: 'NO_PENDING_WORK' };
  } };
  for (const horizonDays of [7, 14]) {
    const result = await runner.drainInCapturedEpoch({ db, worker, horizonDays, leaseOwner: `local-${horizonDays}`, token: captured });
    assert.equal(result.result.status, 'NO_PENDING_WORK');
  }
  assert.deepEqual(calls.map(call => call.input), [
    { horizonDays: 7, leaseOwner: 'local-7' },
    { horizonDays: 14, leaseOwner: 'local-14' }
  ]);
  assert.deepEqual(calls.map(call => ({ state: call.token.state, resetEpoch: call.token.resetEpoch,
    testCycleId: call.token.testCycleId })), [
    { state: 'TEST_ACTIVE', resetEpoch: '5', testCycleId: active.testCycleId },
    { state: 'TEST_ACTIVE', resetEpoch: '5', testCycleId: active.testCycleId }
  ]);
});

const now = new Date('2026-10-19T16:00:00.000Z');
function pendingState(reason) {
  const closedThrough = updateCoordinator.watermark(now);
  const latestMatureOrigin = updateCoordinator.matureOrigin(closedThrough, 7);
  const previousMatureOrigin = new Date(`${latestMatureOrigin}T00:00:00.000Z`);
  previousMatureOrigin.setUTCDate(previousMatureOrigin.getUTCDate() - 1);
  const lastTrainedMatureOrigin = reason === 'NOT_MATURE'
    ? latestMatureOrigin : previousMatureOrigin.toISOString().slice(0, 10);
  const row = { businessId: config.businessId, scenarioId: config.scenarioId, horizonDays: 7, status: 'PENDING',
    manualPending: true, manualRequestKey: 'manual-request-key', latestDataVersion: '173', lastProcessedDataVersion: '83',
    observationsClosedThrough: closedThrough, latestMatureOrigin, initialMatureOrigin: latestMatureOrigin,
    lastTrainedMatureOrigin, lastDirtyAt: new Date(+now - 60 * 60 * 1000),
    nextEligibleAt: new Date(+now - 30 * 60 * 1000), lastAttemptAt: null };
  if (reason === 'COOLDOWN_ACTIVE') row.lastAttemptAt = new Date(+now - 60 * 60 * 1000);
  if (reason === 'DEBOUNCE_NOT_ELAPSED') row.nextEligibleAt = new Date(+now + 60 * 1000);
  return row;
}

for (const reason of ['COOLDOWN_ACTIVE', 'DEBOUNCE_NOT_ELAPSED', 'NOT_MATURE']) {
  test(`${reason} from shared describePending closes the matching manual request inside TEST_ACTIVE`, async () => {
    const control = { state: 'TEST_ACTIVE', resetEpoch: require('mongoose').mongo.BSON.Long.fromString(active.resetEpoch),
      testCycleId: active.testCycleId };
    const db = { collection: () => ({ findOne: async () => control }) };
    const token = await fence.capture(db);
    const state = pendingState(reason);
    const completions = [];
    const result = await runner.drainInCapturedEpoch({ db, worker: { runEligible: async () => null }, horizonDays: 7,
      leaseOwner: 'local-reason', token, readState: async () => state, update: updateCoordinator,
      describe: describePending, now: () => now,
      completeManualEvaluation: async input => {
        completions.push({ input, epoch: fence.current() });
        return true;
      } });
    assert.deepEqual(result, { result: null, evaluation: reason, manualRequestClosed: true });
    assert.equal(completions.length, 1);
    assert.equal(completions[0].input.result, reason);
    assert.equal(completions[0].input.manualRequestKey, state.manualRequestKey);
    assert.equal(completions[0].epoch.testCycleId, active.testCycleId);
  });
}

test('non-null runEligible result does not invoke describe or duplicate manual completion', async () => {
  const control = { state: 'TEST_ACTIVE', resetEpoch: require('mongoose').mongo.BSON.Long.fromString(active.resetEpoch),
    testCycleId: active.testCycleId };
  const db = { collection: () => ({ findOne: async () => control }) };
  const token = await fence.capture(db);
  let completions = 0, reads = 0;
  const result = await runner.drainInCapturedEpoch({ db, worker: { runEligible: async () => ({ status: 'PROMOTED', modelVersion: 2 }) },
    horizonDays: 14, leaseOwner: 'local-success', token, readState: async () => { reads++; return null; },
    completeManualEvaluation: async () => { completions++; return true; } });
  assert.deepEqual(result, { result: { status: 'PROMOTED', modelVersion: 2 } });
  assert.equal(reads, 0);
  assert.equal(completions, 0);
});

test('drain rejects missing or non-active test cycle and never silently adopts a newer epoch', async () => {
  assert.throws(() => runner.assertActiveTestEpoch({ ...active, state: 'NO_TEST' }), { code: 'TEST_EPOCH_REQUIRED' });
  assert.throws(() => runner.assertActiveTestEpoch({ ...active, testCycleId: null }), { code: 'TEST_EPOCH_REQUIRED' });
  assert.throws(() => runner.assertActiveTestEpoch({ ...active, resetEpoch: '0' }), { code: 'TEST_EPOCH_REQUIRED' });
  let reads = 0;
  const db = { collection: () => ({ findOne: async () => {
    reads += 1;
    return reads === 1
      ? { state: 'TEST_ACTIVE', resetEpoch: require('mongoose').mongo.BSON.Long.fromString('5'), testCycleId: active.testCycleId }
      : { state: 'TEST_ACTIVE', resetEpoch: require('mongoose').mongo.BSON.Long.fromString('6'), testCycleId: '22222222-2222-4222-8222-222222222222' };
  } }) };
  const captured = await fence.capture(db);
  let called = false;
  await assert.rejects(runner.drainInCapturedEpoch({ db, worker: { runEligible: async () => { called = true; } },
    horizonDays: 7, leaseOwner: 'local-stale', token: captured }), { code: 'STALE_TEST_EPOCH' });
  assert.equal(called, false);
});

test('bootstrap is refused during TEST_ACTIVE and unchanged worker policy still requires 107 origins', () => {
  assert.throws(() => runner.assertBootstrapAllowed(active), { code: 'TEST_BOOTSTRAP_ACTIVE_CYCLE_FORBIDDEN' });
  assert.doesNotThrow(() => runner.assertBootstrapAllowed({ state: 'NO_TEST' }));
  const worker = fs.readFileSync(path.join(__dirname, '../src/services/forecastRidgeTrainingWorker.js'), 'utf8');
  assert.match(worker, /protocol\.requiredOrigins !== 107/);
});
