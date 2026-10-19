'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { createMlTestAdminRoutes } = require('../src/routes/mlTestAdmin');
const { createMlTestAdminExecutor } = require('../src/services/mlTestAdminExecutor');
const { maintenanceGuard } = require('../src/services/mlTestAccess');
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
    throw Object.assign(new Error('secret/path must not escape'), { code: 'INTERNAL', httpStatus: 503 });
  } };
}
const authHeader = { 'x-test-user': 'admin', 'content-type': 'application/json' };

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
    for (const body of [{ businessId: 'foreign' }, { scenarioId: 'foreign' }, { writersPaused: true }, { localWritersPaused: true }]) {
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
