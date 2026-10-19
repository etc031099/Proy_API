'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BSON } = require('mongoose').mongo;
const F = require('../src/services/mlTestFence');
const access = require('../src/services/mlTestAccess');
const config = require('../src/config/v3Operational');
const { LIMITS, budget } = require('../src/services/mlTestOperationBudget');
const admin = { _id: 'authenticated', businessId: config.businessId, role: 'admin', isActive: true };
test('future admin boundary rejects unauthenticated, non-admin and client tenant/epoch overrides', () => {
  assert.throws(() => access.authorizeAdminAction(null), { httpStatus: 401 });
  for (const user of [{ ...admin, role: 'user' }, { ...admin, isActive: false }, { ...admin, businessId: 'foreign' }]) {
    assert.throws(() => access.authorizeAdminAction(user), { httpStatus: 403 });
  }
  for (const body of [{ businessId: config.businessId }, { scenarioId: 'foreign' }, { resetEpoch: '2' }, { testCycleId: 'x' }]) {
    assert.throws(() => access.authorizeAdminAction(admin, body), { code: 'ML_TEST_SCOPE_FORBIDDEN' });
  }
  assert.deepEqual(access.authorizeAdminAction(admin), { businessId: config.businessId, scenarioId: config.scenarioId });
});
test('technical status is scoped, sanitized and keeps cloud restore disabled', async () => {
  let reads = 0;
  const db = { collection: () => ({ findOne: async () => { reads++; return { resetEpoch: BSON.Long.fromNumber(3),
    state: 'RESTORING', testCycleId: 'cycle', secret: 'NEVER_RETURN' }; } }) };
  const own = await access.readStatus(admin, db);
  assert.equal(own.maintenance, true); assert.equal(own.resetEpoch, '3'); assert.equal(own.cloudRestoreEnabled, false);
  assert(!JSON.stringify(own).includes('secret'));
  assert.equal((await access.readStatus({ businessId: 'foreign' }, db)).state, 'NO_TEST'); assert.equal(reads, 1);
});
function localCapabilityFixture({ database = 'inventory_billing_local', hello = {}, env = {}, user = admin } = {}) {
  const client = { options: { replicaSet: 'rs0', hosts: [{ host: '127.0.0.1', port: 27017 }] } };
  const db = { client, databaseName: database,
    collection: () => ({ findOne: async () => ({ resetEpoch: BSON.Long.fromNumber(3), state: 'TEST_ACTIVE', testCycleId: 'cycle-123' }) }),
    admin: () => ({ command: async () => ({ setName: 'rs0', isWritablePrimary: true,
      me: '127.0.0.1:27017', hosts: ['127.0.0.1:27017'], ...hello }) }) };
  const configEnv = { NODE_ENV: 'development', ML_TEST_LOCAL_ENABLED: 'true',
    ML_TEST_LOCAL_EXPECTED_DATABASE: 'inventory_billing_local', MONGODB_REPLICA_SET: 'rs0',
    MONGODB_URI: 'mongodb://demo-user:demo-password@127.0.0.1:27017/inventory_billing_local?replicaSet=rs0', ...env };
  return { client, db, env: configEnv, user };
}
test('test-control status grants destructive capability only for validated local admin target', async () => {
  const fixture = localCapabilityFixture();
  const status = await access.readStatus(fixture.user, fixture.db, fixture);
  assert.deepEqual(status.capabilities.destructiveMlTestControls, { allowed: true, target: 'LOCAL', reasonCode: null });
  assert.equal(status.resetEpoch, '3'); assert.equal(status.testCycleId, 'cycle-123');
  assert.equal(status.maintenance, false); assert.equal(status.state, 'TEST_ACTIVE');
  assert(!JSON.stringify(status).includes('demo-password'));
  assert(!JSON.stringify(status).includes('demo-user'));
  assert(!JSON.stringify(status).includes('mongodb://'));
});
test('test-control capability fails closed for disabled flag and production', async () => {
  const disabled = localCapabilityFixture({ env: { ML_TEST_LOCAL_ENABLED: 'false' } });
  assert.deepEqual((await access.readStatus(disabled.user, disabled.db, disabled)).capabilities.destructiveMlTestControls,
    { allowed: false, target: null, reasonCode: 'ML_TEST_LOCAL_DISABLED' });
  const production = localCapabilityFixture({ env: { NODE_ENV: 'production' } });
  assert.deepEqual((await access.readStatus(production.user, production.db, production)).capabilities.destructiveMlTestControls,
    { allowed: false, target: null, reasonCode: 'ML_TEST_PRODUCTION_FORBIDDEN' });
});
test('test-control capability fails closed for wrong target, replica set, or non-admin user', async () => {
  const wrongDatabase = localCapabilityFixture({ database: 'inventory_billing' });
  assert.equal((await access.readStatus(wrongDatabase.user, wrongDatabase.db, wrongDatabase)).capabilities.destructiveMlTestControls.reasonCode,
    'ML_TEST_LOCAL_TARGET_INVALID');
  const wrongReplicaSet = localCapabilityFixture({ hello: { setName: 'other-rs' } });
  assert.equal((await access.readStatus(wrongReplicaSet.user, wrongReplicaSet.db, wrongReplicaSet)).capabilities.destructiveMlTestControls.reasonCode,
    'ML_TEST_LOCAL_REPLICA_SET_REQUIRED');
  const atlasTarget = localCapabilityFixture({ env: { MONGODB_URI: 'mongodb+srv://user:password@cluster.mongodb.net/inventory_billing_local' } });
  assert.deepEqual((await access.readStatus(atlasTarget.user, atlasTarget.db, atlasTarget)).capabilities.destructiveMlTestControls,
    { allowed: false, target: null, reasonCode: 'ML_TEST_LOCAL_TARGET_INVALID' });
  const ordinaryUser = localCapabilityFixture({ user: { ...admin, role: 'user' } });
  assert.deepEqual((await access.readStatus(ordinaryUser.user, ordinaryUser.db, ordinaryUser)).capabilities.destructiveMlTestControls,
    { allowed: false, target: null, reasonCode: 'ML_TEST_ADMIN_REQUIRED' });
  const inactiveAdmin = localCapabilityFixture({ user: { ...admin, isActive: false } });
  assert.deepEqual((await access.readStatus(inactiveAdmin.user, inactiveAdmin.db, inactiveAdmin)).capabilities.destructiveMlTestControls,
    { allowed: false, target: null, reasonCode: 'ML_TEST_ADMIN_REQUIRED' });
});
test('external delivery claimed in prior epoch is suppressed immediately before send, even after returning to NO_TEST', async () => {
  let row = { state: 'NO_TEST', resetEpoch: BSON.Long.fromNumber(1), testCycleId: 'cycle' }, sent = 0;
  const db = { collection: () => ({ findOne: async () => row }) };
  const claimed = await F.capture(db);
  assert.equal(await F.externalAllowed(db, claimed), true);
  row = { ...row, resetEpoch: BSON.Long.fromNumber(2) };
  if (await F.externalAllowed(db, claimed)) sent++;
  assert.equal(sent, 0);
  await assert.rejects(F.guard({ db, session: { inTransaction: () => true }, expected: claimed }), { code: 'STALE_TEST_EPOCH' });
});
test('budget preserves 128MiB / 200k / bounded chunks, time and memory fail closed', () => {
  assert.equal(LIMITS.maxBytes, 134217728); assert.equal(LIMITS.maxDocuments, 200000);
  assert.equal(LIMITS.maxChunks, 128);
  let now = 0;
  const check = budget(120000, { now: () => now, memory: () => ({ rss: 10 }) }); check();
  now = 120001; assert.throws(check, { code: 'CHECKPOINT_OPERATION_TIMEOUT' });
  assert.throws(budget(120000, { memory: () => ({ rss: LIMITS.maxRssBytes + 1 }) }), { code: 'CHECKPOINT_MEMORY_LIMIT_EXCEEDED' });
});
test('critical authenticated routes invoke maintenance guard before business handlers; status route is read-only', () => {
  const fs = require('node:fs'), path = require('node:path');
  const auth = fs.readFileSync(path.join(__dirname, '../src/middleware/auth.js'), 'utf8');
  assert(auth.indexOf('.maintenanceGuard(') < auth.indexOf('.runCycle('));
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/businessIntelligenceDashboard.js'), 'utf8');
  assert(routes.includes("router.get('/test-control/status'"));
  assert(!/router\.(post|put|delete).*test-control/.test(routes));
});
test('RESTORING / FAILED / CHECKPOINT_CREATING return sanitized 503 before critical GET or POST', async () => {
  for (const state of ['RESTORING', 'FAILED', 'CHECKPOINT_CREATING']) for (const method of ['GET', 'POST']) {
    const db = { collection: () => ({ findOne: async () => ({ state, resetEpoch: BSON.Long.ONE }) }) };
    let called = false, code, body;
    const res = { status(value) { code = value; return this; }, set() { return this; }, json(value) { body = value; return this; } };
    await access.maintenanceGuard({ user: admin, method, originalUrl: '/api/products' }, res, () => { called = true; }, db);
    assert.equal(called, false); assert.equal(code, 503); assert.equal(body.code, 'ML_TEST_MAINTENANCE');
  }
});
