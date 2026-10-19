'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { createMlTestAdminRoutes } = require('../src/routes/mlTestAdmin');
const { createMlTestAdminExecutor } = require('../src/services/mlTestAdminExecutor');
const { maintenanceGuard } = require('../src/services/mlTestAccess');
const { authenticate, authorize, shouldApplyBusinessWriterFence } = require('../src/middleware/auth');
const { generateToken } = require('../src/utils/jwt');
const { User } = require('../src/models');
const config = require('../src/config/v3Operational');

const admin = { _id: 'admin-from-session', role: 'admin', isActive: true, businessId: config.businessId };
async function withServer(router, work) {
  const app = express(); app.use(express.json()); app.use('/api/ml-test', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    await work(`http://127.0.0.1:${server.address().port}/api/ml-test`);
  }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function fakeAuth(req, res, next) {
  const kind = req.header('x-test-user');
  if (!kind) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED' });
  req.user = kind === 'admin' ? admin : kind === 'foreign-admin' ? { ...admin, businessId: 'foreign-business' } : { ...admin, role: 'user' };
  next();
}
function testExecutor() {
  const actions = [];
  const status = { state: 'TEST_ACTIVE', resetEpoch: '3', testCycleId: randomUUID(), maintenance: false,
    activeCheckpointId: randomUUID(), lastCheckpointId: null, checkpoint: { status: 'READY', dataVersion: '173',
      createdAt: new Date('2026-10-18T10:00:00Z'), progress: { totalDocuments: 100, totalBytes: 2048, totalChunks: 1 } },
    restoreId: null, restoreFinish: false, cloudRestoreEnabled: false };
  return { actions, status, execute: async (req, action) => {
    actions.push({ action, user: req.user, body: req.body });
    if (action === 'STATUS') return status;
    if (action === 'CREATE') return { checkpointId: status.activeCheckpointId, status: 'READY', dataVersion: '173',
      totalDocuments: 100, totalBytes: 2048, totalChunks: 1, readDurationMs: 23 };
    if (action === 'RESTORE') return { status: 'TEST_ACTIVE', restoreId: req.body.restoreId, resetEpoch: '4', dataVersion: '173', totalDocuments: 100, totalBytes: 2048 };
    if (action === 'RESTORE_AND_FINISH') return { status: 'NO_TEST', restoreId: req.body.restoreId, resetEpoch: '5', dataVersion: '173', totalDocuments: 100, totalBytes: 2048 };
    if (action === 'ABORT_FAILED_CHECKPOINT') {
      const checkpointId = status.activeCheckpointId;
      Object.assign(status, { state: 'NO_TEST', activeCheckpointId: null, checkpoint: null, resetEpoch: '4', maintenance: false });
      return { status: 'FAILED_CHECKPOINT_ABORTED', abortedCheckpointId: checkpointId, resetEpoch: '4', idempotent: false };
    }
    throw Object.assign(new Error('secret/path must not escape'), { code: 'INTERNAL', httpStatus: 503 });
  } };
}
const authHeader = { 'x-test-user': 'admin', 'content-type': 'application/json' };

test('only the five administrative lifecycle mutations bypass the ordinary business writer fence', () => {
  // Checkpoint is exempt from the writer fence in normal operation, but its
  // maintenance guard intentionally blocks starting another checkpoint while
  // one is already creating. The remaining administrative actions are allowed
  // through maintenance to recover or finish lifecycle work.
  for (const route of ['checkpoint', 'restore', 'recover-failed-checkpoint', 'recover-stale-checkpoint', 'purge-failed-checkpoint-payloads']) {
    assert.equal(shouldApplyBusinessWriterFence('POST', config.businessId, `/api/ml-test/${route}`), false, route);
    assert.equal(shouldApplyBusinessWriterFence('POST', config.businessId, `/api/ml-test/${route}?operation=1`), false, `${route} query`);
  }
  assert.equal(shouldApplyBusinessWriterFence('POST', config.businessId, '/api/products'), true);
  assert.equal(shouldApplyBusinessWriterFence('POST', config.businessId, '/api/ml-test/checkpoint-storage'), true);
  assert.equal(shouldApplyBusinessWriterFence('POST', 'FOREIGN-TENANT', '/api/products'), false);
  assert.equal(shouldApplyBusinessWriterFence('GET', config.businessId, '/api/products'), false);
});

test('real authenticate middleware passes lifecycle requests during maintenance without entering the writer fence', async t => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'local-test-secret-for-ml-admin-authentication';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  t.mock.method(User, 'findById', () => ({ select: async () => admin }));
  const fence = require('../src/services/mlTestFence');
  let fenceCalls = 0;
  t.mock.method(fence, 'runCycle', async () => { fenceCalls += 1; throw new Error('normal writer fence invoked'); });
  const authorization = `Bearer ${generateToken({ id: admin._id })}`;

  for (const route of ['restore', 'recover-failed-checkpoint', 'recover-stale-checkpoint', 'purge-failed-checkpoint-payloads']) {
    let continued = false;
    let responseStatus = null;
    let responseBody = null;
    const req = { method: 'POST', originalUrl: `/api/ml-test/${route}`, header: name => name === 'Authorization' ? authorization : undefined };
    const res = { status(value) { responseStatus = value; return this; }, set() { return this; }, json(value) { responseBody = value; return this; } };
    await authenticate(req, res, () => { continued = true; });
    assert.equal(continued, true, `${route}: status=${responseStatus} code=${responseBody?.code || 'none'}`);
  }
  assert.equal(fenceCalls, 0);
});

test('route admin authorization still rejects a normal authenticated user', () => {
  let status = null;
  let continued = false;
  const res = { status(value) { status = value; return this; }, json() { return this; } };
  authorize('admin')({ user: { role: 'user' } }, res, () => { continued = true; });
  assert.equal(status, 403);
  assert.equal(continued, false);
});

test('private route requires authenticated admin and returns read-only scoped status', async () => {
  const executor = testExecutor();
  await withServer(createMlTestAdminRoutes({ authenticateMiddleware: fakeAuth, getExecutor: () => executor }), async base => {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    const normal = await fetch(`${base}/status`, { headers: { 'x-test-user': 'user' } });
    assert.equal(normal.status, 403);
    const response = await fetch(`${base}/status`, { headers: { 'x-test-user': 'admin' } });
    const body = await response.json(); assert.equal(response.status, 200);
    assert.equal(body.data.state, 'TEST_ACTIVE'); assert.equal(body.data.checkpoint.dataVersion, '173');
    assert.equal(body.data.resetEpoch, '3'); assert.equal(body.data.cloudRestoreEnabled, false);
    assert.deepEqual(executor.actions.map(row => row.action), ['STATUS']);
  });
});

test('orphan recovery/storage/purge remain private, reject client overrides and delegate only server actions', async () => {
  const actions = [];
  const status = { state: 'NO_TEST', maintenance: false, resetEpoch: '6', quiescence: { writersPaused: false, activeWriterCount: 0 } };
  const executor = { async execute(req, action) {
    actions.push(action);
    if (action === 'STATUS') return status;
    if (action === 'STORAGE') return { writes: 0, mode: 'READ_ONLY', checkpoints: [] };
    if (action === 'ABORT_STALE_CHECKPOINT') return { status: 'STALE_CHECKPOINT_ABORTED', resetEpoch: '6', abortedCheckpointId: randomUUID() };
    return { status: 'CHECKPOINT_PAYLOADS_PURGED', deletedChunks: 2, reclaimedBytes: 8 };
  } };
  await withServer(createMlTestAdminRoutes({ authenticateMiddleware: fakeAuth, getExecutor: () => executor }), async base => {
    for (const route of ['recover-stale-checkpoint', 'purge-failed-checkpoint-payloads']) {
      for (const [headers, expected] of [[{ 'content-type': 'application/json' }, 401],
        [{ 'content-type': 'application/json', 'x-test-user': 'user' }, 403]])
        assert.equal((await fetch(`${base}/${route}`, { method: 'POST', headers, body: '{}' })).status, expected);
      for (const body of [{ checkpointId: randomUUID() }, { force: true }, { deadlineAt: 0 }, { businessId: 'foreign' }])
        assert.equal((await fetch(`${base}/${route}`, { method: 'POST', headers: authHeader, body: JSON.stringify(body) })).status, 400);
      assert.equal((await fetch(`${base}/${route}?force=true`, { method: 'POST', headers: authHeader, body: '{}' })).status, 400);
      assert.equal((await fetch(`${base}/${route}`, { method: 'POST', headers: authHeader, body: '{}' })).status, 200);
    }
    assert.equal((await fetch(`${base}/checkpoint-storage`)).status, 401);
    assert.equal((await fetch(`${base}/checkpoint-storage`, { headers: { 'x-test-user': 'user' } })).status, 403);
    const response = await fetch(`${base}/checkpoint-storage`, { headers: authHeader });
    assert.equal((await response.json()).data.writes, 0);
    assert.deepEqual(actions, ['ABORT_STALE_CHECKPOINT', 'STATUS', 'PURGE_FAILED_CHECKPOINT_PAYLOADS', 'STORAGE']);
  });
});

test('authenticated admin from another tenant cannot read or mutate the authorized demo scope', async () => {
  const noDb = new Proxy({}, { get: () => assert.fail('foreign tenant must be rejected before DB access') });
  const executor = createMlTestAdminExecutor({ db: noDb, env: {}, target: 'CLOUD' });
  await withServer(createMlTestAdminRoutes({ authenticateMiddleware: fakeAuth, getExecutor: () => executor }), async base => {
    const response = await fetch(`${base}/status`, { headers: { 'x-test-user': 'foreign-admin' } });
    const body = await response.json(); assert.equal(response.status, 403); assert.equal(body.code, 'ML_TEST_SCOPE_FORBIDDEN');
  });
});

test('checkpoint endpoint delegates to executor; rejects client tenant/scenario scope and empty-body contract is enforced', async () => {
  const executor = testExecutor();
  await withServer(createMlTestAdminRoutes({ authenticateMiddleware: fakeAuth, getExecutor: () => executor }), async base => {
    for (const body of [{ businessId: 'foreign' }, { scenarioId: 'foreign' }, { writersPaused: true }, { localWritersPaused: true }, { timeoutMs: 1 }]) {
      const deniedScope = await fetch(`${base}/checkpoint`, { method: 'POST', headers: authHeader, body: JSON.stringify(body) });
      assert.equal(deniedScope.status, 400);
    }
    assert.equal((await fetch(`${base}/checkpoint?writersPaused=true`, { method: 'POST', headers: authHeader, body: '{}' })).status, 400);
    const response = await fetch(`${base}/checkpoint`, { method: 'POST', headers: authHeader, body: '{}' });
    const body = await response.json(); assert.equal(response.status, 201);
    assert.equal(body.data.checkpointId, executor.status.activeCheckpointId);
    assert.equal(body.data.totalBytes, 2048);
    assert.deepEqual(executor.actions.map(row => row.action), ['CREATE', 'STATUS']);
    assert.equal(executor.actions[0].user, admin);
  });
});

test('restore accepts only mode and delegates continue/finish against the active checkpoint', async () => {
  const executor = testExecutor();
  await withServer(createMlTestAdminRoutes({ authenticateMiddleware: fakeAuth, getExecutor: () => executor }), async base => {
    for (const payload of [{ mode: 'continue', checkpointId: 'attacker' }, { mode: 'finish', businessId: 'foreign' },
      { mode: 'finish', scenarioId: 'foreign' }, { mode: 'other' }]) {
      const invalid = await fetch(`${base}/restore`, { method: 'POST', headers: authHeader, body: JSON.stringify(payload) });
      assert.equal(invalid.status, 400);
    }
    for (const [mode, action] of [['continue', 'RESTORE'], ['finish', 'RESTORE_AND_FINISH']]) {
      const response = await fetch(`${base}/restore`, { method: 'POST', headers: authHeader, body: JSON.stringify({ mode }) });
      const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.data.status, mode === 'finish' ? 'NO_TEST' : 'TEST_ACTIVE');
      const call = executor.actions.findLast(row => row.action === action);
      assert.ok(call); assert.equal(call.body.checkpointId, executor.status.activeCheckpointId);
      assert.equal(call.body.branch, 'NORMAL'); assert.equal(typeof call.body.restoreId, 'string');
    }
  });
});

test('route response sanitizes unknown executor errors', async () => {
  const executor = { execute: async () => { throw Object.assign(new Error('mongodb://user:password@secret'), { code: 'INTERNAL', httpStatus: 503 }); } };
  await withServer(createMlTestAdminRoutes({ authenticateMiddleware: fakeAuth, getExecutor: () => executor }), async base => {
    const response = await fetch(`${base}/status`, { headers: { 'x-test-user': 'admin' } });
    const body = await response.text(); assert.equal(response.status, 503);
    assert(!body.includes('password')); assert(body.includes('ML_TEST_OPERATION_FAILED'));
  });
});

test('flag absent/false remains blocked by the real executor before database access', async () => {
  const noDb = new Proxy({}, { get: () => assert.fail('cloud DB must not be touched') });
  for (const env of [{}, { ML_TEST_CLOUD_RESTORE_ENABLED: 'false' }]) {
    const executor = createMlTestAdminExecutor({ db: noDb, env, target: 'CLOUD' });
    await assert.rejects(executor.execute({ user: admin, body: {}, query: {} }, 'CREATE'),
      { code: 'ML_TEST_CLOUD_RESTORE_DISABLED', httpStatus: 503 });
  }
  const executor = createMlTestAdminExecutor({ db: noDb, env: {}, target: 'CLOUD' });
  await withServer(createMlTestAdminRoutes({ authenticateMiddleware: fakeAuth, getExecutor: () => executor }), async base => {
    const response = await fetch(`${base}/checkpoint`, { method: 'POST', headers: authHeader, body: '{}' });
    const body = await response.json(); assert.equal(response.status, 503);
    assert.equal(body.code, 'ML_TEST_CLOUD_RESTORE_DISABLED');
  });
});

test('real executor status remains read-only with flag false and returns only scoped checkpoint metadata', async () => {
  const checkpointId = randomUUID(), cycleId = randomUUID(); let reads = 0, writes = 0;
  const db = { databaseName: 'demo_db', client: null, collection(name) { return {
    findOne: async filter => {
      reads++;
      if (name === 'mltestcontrols') return { businessId: config.businessId, state: 'TEST_ACTIVE', resetEpoch: 3,
        testCycleId: cycleId, activeCheckpointId: checkpointId };
      assert.equal(name, 'mltestcheckpoints');
      assert.equal(filter.businessId, config.businessId); assert.equal(filter.scenarioId, config.scenarioId);
      return { checkpointId, status: 'READY', dataVersion: '173', createdAt: new Date('2026-10-18T10:00:00Z'),
        totalDocuments: 56_675, totalBytes: 101_050_857, totalChunks: 40, hashes: { secret: 'must not escape' } };
    }, insertOne: async () => { writes++; }, updateOne: async () => { writes++; }, deleteMany: async () => { writes++; }
  }; } };
  const client = { options: { srvHost: 'demo.mongodb.net' } }; db.client = client;
  const env = { ML_TEST_CLOUD_RESTORE_ENABLED: 'false', FORECAST_CLOUD_MONGO_URI: 'mongodb+srv://user:pass@demo.mongodb.net/demo_db',
    FORECAST_CLOUD_EXPECTED_DATABASE: 'demo_db', FORECAST_CLOUD_EXPECTED_BUSINESS_ID: config.businessId,
    FORECAST_CLOUD_EXPECTED_SCENARIO_ID: config.scenarioId };
  const executor = createMlTestAdminExecutor({ client, db, target: 'CLOUD', env, certificationId: 'm6.10a3795b-admin-epoch-v1' });
  await withServer(createMlTestAdminRoutes({ authenticateMiddleware: fakeAuth, getExecutor: () => executor }), async base => {
    const response = await fetch(`${base}/status`, { headers: { 'x-test-user': 'admin' } });
    const raw = await response.text(); const body = JSON.parse(raw);
    assert.equal(response.status, 200); assert.equal(body.data.state, 'TEST_ACTIVE');
    assert.equal(body.data.checkpoint.dataVersion, '173'); assert.equal(body.data.checkpoint.progress.totalDocuments, 56_675);
    assert.equal(body.data.cloudRestoreEnabled, false); assert(!raw.includes('hashes')); assert(!raw.includes('must not escape'));
    assert.equal(reads, 2); assert.equal(writes, 0);
  });
});

test('only the authenticated admin restore path can pass through maintenance to resume its own restore', async () => {
  const db = { collection: () => ({ findOne: async () => ({ state: 'RESTORING', resetEpoch: 4 }) }) };
  let next = false, responseStatus = null;
  const res = { status(value) { responseStatus = value; return this; }, set() { return this; }, json() { return this; } };
  await maintenanceGuard({ user: admin, method: 'POST', originalUrl: '/api/ml-test/restore', params: {} }, res, () => { next = true; }, db);
  assert.equal(next, true); assert.equal(responseStatus, null);
  next = false;
  await maintenanceGuard({ user: admin, method: 'GET', originalUrl: '/api/ml-test/status', params: {} }, res, () => { next = true; }, db);
  assert.equal(next, true); assert.equal(responseStatus, null);
  next = false;
  await maintenanceGuard({ user: admin, method: 'POST', originalUrl: '/api/products', params: {} }, res, () => { next = true; }, db);
  assert.equal(next, false); assert.equal(responseStatus, 503);
});

test('failed-checkpoint recovery requires admin and empty body; clients cannot choose checkpoint, scope, epoch or actor', async () => {
  const executor = testExecutor();
  await withServer(createMlTestAdminRoutes({ authenticateMiddleware: fakeAuth, getExecutor: () => executor }), async base => {
    assert.equal((await fetch(`${base}/recover-failed-checkpoint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/recover-failed-checkpoint`, { method: 'POST', headers: { ...authHeader, 'x-test-user': 'user' }, body: '{}' })).status, 403);
    for (const key of ['checkpointId', 'businessId', 'scenarioId', 'resetEpoch', 'actor', 'writersPaused']) {
      assert.equal((await fetch(`${base}/recover-failed-checkpoint`, { method: 'POST', headers: authHeader, body: JSON.stringify({ [key]: 'forged' }) })).status, 400);
    }
    assert.equal((await fetch(`${base}/recover-failed-checkpoint?checkpointId=forged`, { method: 'POST', headers: authHeader, body: '{}' })).status, 400);
    const response = await fetch(`${base}/recover-failed-checkpoint`, { method: 'POST', headers: authHeader, body: '{}' });
    const body = await response.json(); assert.equal(response.status, 200);
    assert.equal(body.data.state, 'NO_TEST'); assert.equal(body.data.maintenance, false);
    assert.equal(body.data.status, 'FAILED_CHECKPOINT_ABORTED');
    assert.deepEqual(executor.actions.map(row => row.action), ['ABORT_FAILED_CHECKPOINT', 'STATUS']);
    assert.deepEqual(executor.actions[0].body, {});
  });
});
