'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const S = require('../src/services/mlTestCheckpointService');
const D = require('../src/services/mlTestCheckpointDiagnostics');
const { neverReady } = require('../src/services/mlTestFailedCheckpointRecovery');
const A = require('../src/services/mlTestAdminExecutor');
const config = require('../src/config/v3Operational');

test('snapshot error classification preserves the functional code instead of generic ML_TEST_OPERATION_FAILED', () => {
  assert.equal(S.codeOf({ code: 251 }), 'CHECKPOINT_SNAPSHOT_TRANSACTION_FAILED');
  assert.equal(S.codeOf({ code: 286 }), 'CHECKPOINT_SNAPSHOT_TOO_OLD');
  assert.equal(S.codeOf({ code: 246 }), 'CHECKPOINT_SNAPSHOT_UNAVAILABLE');
  assert.equal(S.codeOf({ code: 'CHECKPOINT_CONTROL_BUSY' }), 'CHECKPOINT_CONTROL_BUSY');
});

test('safe diagnostics retain codes, labels and phase; never copy messages, stack, hosts or documents', () => {
  const record = D.failure({ name: 'MongoServerError', code: 251, codeName: 'NoSuchTransaction',
    errorLabels: ['TransientTransactionError', 'SECRET_LABEL'], message: 'mongodb://user:password@private/customer',
    stack: 'private/path', document: { email: 'private@example.test' } }, {
    checkpointId: randomUUID(), phase: 'SOURCE_READ', sessionPhase: 'SNAPSHOT_OPEN', collection: 'transactions', durationMs: 77000
  });
  assert.equal(record.code, 251); assert.equal(record.codeName, 'NoSuchTransaction');
  assert.equal(record.category, 'NO_SUCH_TRANSACTION'); assert.equal(record.collection, 'transactions');
  assert.deepEqual(record.labels, ['TransientTransactionError']);
  assert.deepEqual(D.safeStoredFailure({ ...record, payload: 'SECRET' }), record);
  assert.doesNotMatch(JSON.stringify(record), /password|private|mongodb:|SECRET|email|stack/);
  const unsafe = D.failure({ name: 'SECRET', code: 'mongodb://secret', codeName: 'SECRET', errorLabels: ['SECRET'] },
    { collection: 'private-customer', phase: 'SECRET', checkpointId: 'SECRET' });
  assert.doesNotMatch(JSON.stringify(unsafe), /SECRET|private|mongodb:/);
  assert.deepEqual(D.safeMetrics({ snapshotTransactionMs: 0, peakRssBytes: 123, token: 'SECRET', bytesStreamed: -1 }),
    { snapshotTransactionMs: 0, peakRssBytes: 123 });
});

test('a legacy FAILED capture is recoverable only with an incomplete initial manifest', () => {
  const failed = { status: 'FAILED', dataVersion: null, totalBytes: 0, totalChunks: 0 };
  assert.equal(neverReady(failed), true);
  for (const change of [{ status: 'READY' }, { readyAt: new Date() }, { dataVersion: '173' },
    { hashes: { manifest: 'hash' } }, { collectionManifest: [{}] }, { totalBytes: 1 }]) {
    assert.equal(neverReady({ ...failed, ...change }), false);
  }
});

test('new protocol supports failed full manifests but refuses any checkpoint which reached READY', () => {
  const failed = { status: 'FAILED', captureProtocolVersion: S.CAPTURE_PROTOCOL, readyAt: null,
    dataVersion: '173', hashes: { manifest: 'hash' }, totalBytes: 100 };
  assert.equal(neverReady(failed), true);
  assert.equal(neverReady({ ...failed, readyAt: new Date() }), false);
  assert.equal(neverReady({ ...failed, status: 'READY' }), false);
});

test('recovery still requires authenticated scoped admin and cloud flag before any database access', async () => {
  const db = new Proxy({}, { get: () => assert.fail('must reject before DB access') });
  const user = { _id: 'real-session-fixture', role: 'admin', isActive: true, businessId: config.businessId };
  const executor = A.createMlTestAdminExecutor({ db, env: {}, auditDenied: () => {} });
  await assert.rejects(executor.execute({ user, body: {}, query: {} }, 'ABORT_FAILED_CHECKPOINT'), { code: 'ML_TEST_CLOUD_RESTORE_DISABLED' });
  await assert.rejects(executor.execute({ user: { ...user, role: 'user' }, body: {}, query: {} }, 'ABORT_FAILED_CHECKPOINT'), { httpStatus: 403 });
  await assert.rejects(executor.execute({ user: { ...user, businessId: 'FOREIGN' }, body: {}, query: {} }, 'ABORT_FAILED_CHECKPOINT'), { code: 'ML_TEST_SCOPE_FORBIDDEN' });
  for (const body of [{ checkpointId: randomUUID() }, { writersPaused: true }, { resetEpoch: '1' }, { businessId: 'foreign' }])
    await assert.rejects(executor.execute({ user, body, query: {} }, 'ABORT_FAILED_CHECKPOINT'));
});
