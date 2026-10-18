'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { BSON } = require('mongoose').mongo;
const A = require('../src/services/mlTestAccess');
const E = require('../src/services/mlTestAdminExecutor');
const F = require('../src/services/mlTestFence');
const { bindLaunch } = require('../src/services/mlTestWorkIdentity');
const { githubQueuedAt } = require('../scripts/bind-v3-ridge-workflow-epoch');
const config = require('../src/config/v3Operational');
const admin = { _id: 'session-admin', role: 'admin', isActive: true, businessId: config.businessId };
test('existing session authentication: missing 401, non-admin 403, demo admin scoped server-side', () => {
  assert.throws(() => A.authorizeAdminAction(null), { httpStatus: 401 });
  assert.throws(() => A.authorizeAdminAction({ ...admin, role: 'user' }), { httpStatus: 403 });
  assert.throws(() => A.authorizeAdminAction({ ...admin, businessId: 'foreign' }), { httpStatus: 403 });
  assert.deepEqual(A.authorizeAdminAction(admin), { businessId: config.businessId, scenarioId: config.scenarioId });
});
test('body/query cannot supply scope, cycle or epoch even when equal to the authorized value', () => {
  for (const key of ['businessId', 'scenarioId', 'testCycleId', 'resetEpoch']) {
    assert.throws(() => A.authorizeAdminAction(admin, { [key]: 'x' }), { code: 'ML_TEST_SCOPE_FORBIDDEN' });
    assert.throws(() => A.authorizeAdminAction(admin, {}, { [key]: 'x' }), { code: 'ML_TEST_SCOPE_FORBIDDEN' });
  }
});
test('cloud flag missing/false blocks before any connection/write; true alone lacks certification approval', async () => {
  const db = new Proxy({}, { get: () => assert.fail('cloud database must not be accessed') });
  for (const env of [{}, { ML_TEST_CLOUD_RESTORE_ENABLED: 'false' }, { ML_TEST_CLOUD_RESTORE_ENABLED: 'TRUE' }]) {
    assert.equal(E.cloudFlagEnabled(env), false);
    await assert.rejects(E.createMlTestAdminExecutor({ db, env }).execute({ user: admin, body: {} }, 'CREATE'),
      { code: 'ML_TEST_CLOUD_RESTORE_DISABLED', httpStatus: 503 });
  }
  await assert.rejects(E.createMlTestAdminExecutor({ db, env: { ML_TEST_CLOUD_RESTORE_ENABLED: 'true' } })
    .execute({ user: admin, body: {} }, 'CREATE'), { code: 'ML_TEST_CLOUD_CERTIFICATION_REQUIRED' });
});
test('finalize-without-restore / force NO_TEST are not administrative actions', async () => {
  const executor = E.createMlTestAdminExecutor();
  for (const action of ['FINISH', 'FORCE_NO_TEST', 'ABANDON']) await assert.rejects(executor.execute({ user: admin, body: {} }, action),
    { code: 'ML_TEST_ACTION_NOT_ALLOWED' });
});
test('approved internal cloud capability is tenant/host/database/object bound and cannot be forged or serialized', () => {
  const T = require('../src/services/mlTestTargetAuthorization');
  const S = require('../src/services/mlTestCheckpointService');
  const client = { options: { srvHost: 'example.mongodb.net' } }, db = { databaseName: 'approved_demo', client };
  const env = { ML_TEST_CLOUD_RESTORE_ENABLED: 'true', FORECAST_CLOUD_MONGO_URI: 'mongodb+srv://fixture:fixture@example.mongodb.net/approved_demo',
    FORECAST_CLOUD_EXPECTED_DATABASE: 'approved_demo', FORECAST_CLOUD_EXPECTED_BUSINESS_ID: config.businessId,
    FORECAST_CLOUD_EXPECTED_SCENARIO_ID: config.scenarioId };
  const grant = T.authorizeCloudTarget({ client, db, user: admin, env, certificationId: T.CERTIFICATION });
  assert.equal(T.authorized(client, db, grant), true); S.assertExecutionTarget(client, db, grant);
  assert.equal(T.authorized(client, { ...db }, grant), false); assert.equal(T.authorized({ ...client }, db, grant), false);
  assert.equal(T.authorized(client, db, JSON.parse(JSON.stringify(grant))), false);
  assert.throws(() => S.assertExecutionTarget(client, db, {}), { code: 'CHECKPOINT_LOCAL_TEST_DATABASE_REQUIRED' });
  for (const invalid of [{ ...env, FORECAST_CLOUD_EXPECTED_SCENARIO_ID: 'foreign' },
    { ...env, FORECAST_CLOUD_EXPECTED_DATABASE: 'other' },
    { ...env, FORECAST_CLOUD_MONGO_URI: env.FORECAST_CLOUD_MONGO_URI + '?tls=false' }])
    assert.throws(() => T.authorizeCloudTarget({ client, db, user: admin, env: invalid, certificationId: T.CERTIFICATION }),
      { code: 'ML_TEST_CLOUD_TARGET_INVALID' });
  assert.throws(() => T.authorizeCloudTarget({ client, db, user: { ...admin, role: 'user' }, env, certificationId: T.CERTIFICATION }), { httpStatus: 403 });
  // Only mock objects; no MongoClient/connect or cloud DB operation is invoked.
});
test('durable identity rejects stale manual/scheduled work in NO_TEST, accepts only current fresh identity', async () => {
  const cycle = randomUUID(), now = new Date('2026-10-18T18:00:00Z');
  const row = { state: 'NO_TEST', resetEpoch: BSON.Long.fromNumber(4), testCycleId: cycle, epochChangedAt: now };
  const db = { collection: () => ({ findOne: async () => row }) };
  const current = F.durableToken(F.tokenOf(row)), old = { ...current, resetEpoch: '2' };
  await assert.rejects(bindLaunch(db, { testEpoch: old, github: true, queuedAt: now.toISOString(), manualRequestKey: 'old' }), { code: 'STALE_TEST_EPOCH' });
  await assert.rejects(bindLaunch(db, { github: true, queuedAt: '2026-10-18T17:59:00Z' }), { code: 'STALE_TEST_EPOCH' });
  await assert.rejects(bindLaunch(db, { github: true, queuedAt: now.toISOString(), manualRequestKey: 'legacy' }), { code: 'TEST_EPOCH_REQUIRED' });
  await assert.rejects(bindLaunch(db, { github: true }), { code: 'TEST_QUEUE_IDENTITY_REQUIRED' });
  assert.deepEqual(await bindLaunch(db, { testEpoch: current, github: true, queuedAt: '2026-10-18T18:01:00Z' }), current);
  assert.deepEqual(await bindLaunch(db), current); // Fresh local operator CLI.
});
test('serialized epoch identity is narrow, bounded and rejects arbitrary fields', () => {
  const token = { present: true, resetEpoch: '4', testCycleId: randomUUID() };
  assert.deepEqual(F.parseToken(JSON.stringify(token)), token);
  for (const value of ['broken', { ...token, secret: 'no' }, { ...token, resetEpoch: '-1' }, { ...token, resetEpoch: '9223372036854775808' }])
    assert.throws(() => F.parseToken(value), { code: 'TEST_EPOCH_INVALID' });
});
test('GitHub queued timestamp is read from the exact server run identity, never user timestamp or secret output', async () => {
  const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '123', GITHUB_TOKEN: 'PRIVATE' };
  const valid = { id: 123, event: 'schedule', repository: { full_name: 'owner/repo' }, created_at: '2026-10-18T18:00:00Z' };
  assert.equal(await githubQueuedAt(env, async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/owner/repo/actions/runs/123'); assert.equal(options.redirect, 'error');
    return { status: 200, json: async () => valid };
  }), '2026-10-18T18:00:00.000Z');
  await assert.rejects(githubQueuedAt(env, async () => ({ status: 200, json: async () => ({ ...valid, id: 999 }) })), { code: 'TEST_QUEUE_IDENTITY_REQUIRED' });
});
test('workflow carries durable epoch across bind/check/run with no bootstrap or training policy switches', () => {
  const yaml = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../.github/workflows/forecast-ridge-auto-update.yml'), 'utf8');
  assert(yaml.includes('testEpoch:')); assert(yaml.includes('FORECAST_TEST_EPOCH: ${{ inputs.testEpoch }}'));
  assert(yaml.indexOf('bind-v3-ridge-workflow-epoch.js') < yaml.indexOf('run-v3-ridge-worker-cloud.js --check'));
  assert(yaml.includes('actions: read')); assert(yaml.includes('cancel-in-progress: false'));
  assert(yaml.includes("cron: '17 */6 * * *'")); assert(!/--bootstrap|--force|--horizon 1\b/.test(yaml));
});
