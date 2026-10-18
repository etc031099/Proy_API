'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEMO_BUSINESS_ID, REQUIRED_ENV, promoteDemoV3Admin, runCli } = require('../scripts/promote-demo-v3-admin');

const makeUser = overrides => ({ _id: '507f1f77bcf86cd799439011', businessId: DEMO_BUSINESS_ID,
  email: 'demo-admin@example.test', role: 'user', isActive: true, name: 'Demo', password: 'hash-secret', ...overrides });

function fakeDb(users) {
  const state = { users: users.map(user => ({ ...user })), writes: 0, updates: [] };
  state.collection = name => {
    assert.equal(name, 'users');
    return {
      find(filter) {
        let rows = state.users.filter(user => user.email === filter.email);
        const cursor = {
          project() { return cursor; },
          limit(count) { rows = rows.slice(0, count); return cursor; },
          async toArray() { return rows.map(({ _id, businessId, role, isActive }) => ({ _id, businessId, role, isActive })); }
        };
        return cursor;
      },
      async updateOne(filter, update, options) {
        state.writes++;
        state.updates.push({ filter, update, options });
        const user = state.users.find(row => row._id === filter._id && row.businessId === filter.businessId
          && row.role === filter.role && row.isActive === filter.isActive);
        if (!user) return { matchedCount: 0, modifiedCount: 0 };
        Object.assign(user, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async findOne(filter) {
        const user = state.users.find(row => row._id === filter._id && row.businessId === filter.businessId);
        return user && { _id: user._id, businessId: user.businessId, role: user.role, isActive: user.isActive };
      }
    };
  };
  return state;
}

const input = db => ({ db, expectedEmail: 'demo-admin@example.test', expectedDatabase: 'demo_v3' });

test('dry run reports a sanitized target and performs zero writes', async () => {
  const db = fakeDb([makeUser()]);
  const result = await promoteDemoV3Admin(input(db));
  assert.equal(result.status, 'DRY_RUN'); assert.equal(result.writes, 0); assert.equal(db.writes, 0);
  assert.deepEqual(Object.keys(result), ['status', 'userId', 'businessId', 'currentRole', 'targetRole', 'writes']);
  assert.equal(result.userId, '507f…9011');
});

test('missing user fails closed', async () => {
  await assert.rejects(promoteDemoV3Admin(input(fakeDb([]))), { code: 'ADMIN_PROMOTION_USER_NOT_FOUND' });
});

test('tenant mismatch fails closed without writing', async () => {
  const db = fakeDb([makeUser({ businessId: 'OTHER-TENANT' })]);
  await assert.rejects(promoteDemoV3Admin(input(db)), { code: 'ADMIN_PROMOTION_TENANT_MISMATCH' });
  assert.equal(db.writes, 0);
});

test('inactive user fails closed', async () => {
  const db = fakeDb([makeUser({ isActive: false })]);
  await assert.rejects(promoteDemoV3Admin(input(db)), { code: 'ADMIN_PROMOTION_USER_INACTIVE' });
  assert.equal(db.writes, 0);
});

test('multiple email matches fail closed', async () => {
  const db = fakeDb([makeUser(), makeUser({ _id: '507f1f77bcf86cd799439012' })]);
  await assert.rejects(promoteDemoV3Admin(input(db)), { code: 'ADMIN_PROMOTION_MULTIPLE_USERS' });
  assert.equal(db.writes, 0);
});

test('apply conditionally promotes only role and verifies admin with majority write concern', async () => {
  const original = makeUser(); const db = fakeDb([original]);
  const result = await promoteDemoV3Admin({ ...input(db), apply: true });
  assert.equal(result.status, 'PROMOTED'); assert.equal(result.writes, 1);
  assert.deepEqual(db.updates[0].filter, { _id: original._id, businessId: DEMO_BUSINESS_ID, role: 'user', isActive: true });
  assert.deepEqual(db.updates[0].update, { $set: { role: 'admin' } });
  assert.deepEqual(db.updates[0].options, { writeConcern: { w: 'majority' } });
  assert.deepEqual(db.users[0], { ...original, role: 'admin' });
});

test('already admin is idempotent and does not write', async () => {
  const db = fakeDb([makeUser({ role: 'admin' })]);
  const result = await promoteDemoV3Admin({ ...input(db), apply: true });
  assert.equal(result.status, 'ALREADY_ADMIN'); assert.equal(result.writes, 0); assert.equal(db.writes, 0);
});

test('database and fixed demo scope are required', async () => {
  const db = fakeDb([makeUser()]);
  await assert.rejects(promoteDemoV3Admin({ ...input(db), expectedDatabase: '' }), { code: 'ADMIN_PROMOTION_SCOPE_INVALID' });
  await assert.rejects(promoteDemoV3Admin({ ...input(db), businessId: 'OTHER-TENANT' }), { code: 'ADMIN_PROMOTION_SCOPE_INVALID' });
});

test('CLI defaults to dry run and never prints connection URI or email', async () => {
  const secretUri = 'mongodb://private-user:private-password@localhost:27017/demo_v3';
  const email = 'demo-admin@example.test';
  const db = fakeDb([makeUser()]); const output = [];
  class FakeMongoClient {
    constructor(uri) { assert.equal(uri, secretUri); }
    async connect() {}
    db() { return db; }
    async close() {}
  }
  const result = await runCli({
    env: { [REQUIRED_ENV.uri]: secretUri, [REQUIRED_ENV.database]: 'demo_v3', [REQUIRED_ENV.email]: email },
    args: [], stdout: line => output.push(line), clientFactory: FakeMongoClient
  });
  assert.equal(result.status, 'DRY_RUN'); assert.equal(db.writes, 0);
  assert.doesNotMatch(output.join('\n'), /private-user|private-password|mongodb:|demo-admin@example\.test|hash-secret/);
});

test('missing explicit config does not attempt a database connection', async () => {
  let constructed = false;
  class FakeMongoClient { constructor() { constructed = true; } }
  const output = [];
  await assert.rejects(runCli({ env: {}, args: [], stdout: line => output.push(line), clientFactory: FakeMongoClient }),
    { code: 'ADMIN_PROMOTION_CONFIG_MISSING' });
  assert.equal(constructed, false);
});
