'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const L = require('../src/services/mlTestCheckpointLifecycle');
const A = require('../src/services/mlTestAdminExecutor');
const config = require('../src/config/v3Operational');
test('orphan detection requires matching owner/control, hard deadline, old heartbeat and never-READY evidence', () => {
  const now = Date.now(), checkpointId = randomUUID(), created = now - 500000;
  const control = { state: 'CHECKPOINT_CREATING', activeCheckpointId: checkpointId, updatedAt: new Date(created) };
  const row = { checkpointId, status: 'CREATING', capturedAt: new Date(created), updatedAt: new Date(created),
    captureProtocolVersion: 'SNAPSHOT_SESSION_V1', readyAt: null, ...L.ownership(created, 240000) };
  assert.equal(L.staleCapture(control, row, now), true);
  for (const changed of [{ status: 'READY' }, { readyAt: new Date(created) }, { captureHeartbeatAt: new Date(now) },
    { captureLeaseUntil: new Date(now + 1) }, { captureDeadlineAt: new Date(now + 1) },
    { captureOwnerNonce: null }, { captureOwnershipVersion: 'unknown' }, { updatedAt: new Date(now) }]) {
    assert.equal(L.staleCapture(control, { ...row, ...changed }, now), false);
  }
  assert.equal(L.staleCapture({ ...control, activeCheckpointId: randomUUID() }, row, now), false);
  const legacy = { ...row }; for (const key of Object.keys(legacy)) if (key.startsWith('capture') && key !== 'capturedAt' && key !== 'captureProtocolVersion') delete legacy[key];
  assert.equal(L.staleCapture(control, legacy, created + 419999), false);
  assert.equal(L.staleCapture(control, legacy, created + 420000), true);
});
test('new administrative writes require existing authenticated scope/flag and accept no client bypass fields', async () => {
  const db = new Proxy({}, { get: () => assert.fail('authorization must precede database access') });
  const user = { _id: 'session-admin', role: 'admin', isActive: true, businessId: config.businessId };
  const executor = A.createMlTestAdminExecutor({ db, env: {}, auditDenied: () => {} });
  for (const action of ['ABORT_STALE_CHECKPOINT', 'PURGE_FAILED_CHECKPOINT_PAYLOADS']) {
    await assert.rejects(executor.execute({ user, body: {}, query: {} }, action), { code: 'ML_TEST_CLOUD_RESTORE_DISABLED' });
    for (const body of [{ checkpointId: randomUUID() }, { force: true }, { now: Date.now() }, { writersPaused: true }])
      await assert.rejects(executor.execute({ user, body, query: {} }, action));
    await assert.rejects(executor.execute({ user: { ...user, role: 'user' }, body: {}, query: {} }, action), { httpStatus: 403 });
    await assert.rejects(executor.execute({ user: { ...user, businessId: 'FOREIGN' }, body: {}, query: {} }, action), { code: 'ML_TEST_SCOPE_FORBIDDEN' });
  }
  await assert.rejects(executor.execute({ user: { ...user, businessId: 'FOREIGN' }, body: {}, query: {} }, 'STORAGE'), { code: 'ML_TEST_SCOPE_FORBIDDEN' });
});
