'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createForecastRidgeTrainingWorker, canonicalBytes, runPython } = require('../src/services/forecastRidgeTrainingWorker');

test('canonical artifact bytes do not depend on key insertion order', () => {
  assert.deepEqual(canonicalBytes({ z: 1, a: { y: 2, x: 3 } }), canonicalBytes({ a: { x: 3, y: 2 }, z: 1 }));
});
test('horizon 1 cannot claim, create a job, evaluate or persist', async () => {
  const worker = createForecastRidgeTrainingWorker();
  await assert.rejects(worker.runEligible({ horizonDays: 1, leaseOwner: 'test' }), { code: 'MODEL_NOT_APPROVED' });
});
test('foreign tenant is rejected before reading coordinator or registry', async () => {
  const worker = createForecastRidgeTrainingWorker();
  await assert.rejects(worker.runEligible({ horizonDays: 7, businessId: 'other', leaseOwner: 'test' }),
    { code: 'INVALID_SCOPE' });
});
test('foreign scenario is rejected before claiming', async () => {
  const worker = createForecastRidgeTrainingWorker();
  await assert.rejects(worker.runEligible({ horizonDays: 7, scenarioId: 'other', leaseOwner: 'test' }),
    { code: 'INVALID_SCOPE' });
});
test('automatic processing requires a coordinator claim', async () => {
  await assert.rejects(createForecastRidgeTrainingWorker().process({ horizonDays: 7,
    inputDataVersion: '100', observationsClosedThrough: '2026-10-15' }), { code: 'DATASET_INVALID' });
});
test('Python subprocess accepts only internal allowlisted modules', () => {
  assert.throws(() => runPython({}, { moduleName: 'untrusted.module' }), /Invalid internal Python module/);
});
