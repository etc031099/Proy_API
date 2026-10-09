const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });
const { User } = require('../../src/models');
const authRoutes = require('../../src/routes/auth');
const { authenticate, checkBusinessAccess } = require('../../src/middleware/auth');
const runId = `${Date.now()}_${process.pid}`;
const createdIds = [];
let server;
const oldEnv = Object.fromEntries(['JWT_SECRET', 'DEMO_V2_REGISTRATION_ENABLED', 'DEMO_V2_REGISTRATION_EMAIL'].map(key => [key, process.env[key]]));

test.before(async () => {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri || !/^mongodb:\/\/(?:[^@/]+@)?(?:127\.0\.0\.1|localhost):27017\//.test(uri)) {
    throw new Error('Only a local Mongo replica-set test connection is allowed');
  }
  await mongoose.connect(uri, { dbName: `auth_v2_${runId}_test`, serverSelectionTimeoutMS: 10000 });
  assert.equal((await mongoose.connection.db.admin().command({ hello: 1 })).isWritablePrimary, true);
  await User.init();
  process.env.JWT_SECRET = 'synthetic-integration-test-only-secret-123456';
  process.env.DEMO_V2_REGISTRATION_ENABLED = 'true';
  process.env.DEMO_V2_REGISTRATION_EMAIL = 'synthetic-v2@example.com';
  const app = express(); app.use(express.json()); app.use('/api/auth', authRoutes);
  app.get('/tenant', authenticate, checkBusinessAccess, (req, res) => res.json({ businessId: req.businessId }));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (mongoose.connection.readyState === 1) await User.deleteMany({ _id: { $in: createdIds } });
  await mongoose.disconnect();
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const post = (route, body, token) => fetch(`http://127.0.0.1:${server.address().port}/api/auth/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
});
test('real registration/hash/login preserves V1 and provisions exactly one isolated V2 owner', async () => {
  const password = 'SyntheticOnly1';
  const response = await post('register', { name: 'Synthetic V1', email: 'synthetic-v1@example.com', password, businessId: 'ML-CLOUD-DEMO' });
  assert.equal(response.status, 201);
  const v1 = (await response.json()).data;
  createdIds.push(v1.user.id);
  const before = await User.findById(v1.user.id).select('+password').lean();
  const provision = await post('register-demo-v2', { name: 'Synthetic V2', email: 'synthetic-v2@example.com', password }, v1.token);
  assert.equal(provision.status, 201);
  const v2 = (await provision.json()).data;
  createdIds.push(v2.user.id);
  assert.equal(v2.user.businessId, 'ML-CLOUD-DEMO-V2');
  assert.deepEqual(await User.findById(v1.user.id).select('+password').lean(), before);
  const stored = await User.findById(v2.user.id).select('+password');
  assert.notEqual(stored.password, password);
  assert.equal(await stored.comparePassword(password), true);
  process.env.DEMO_V2_REGISTRATION_ENABLED = 'false';
  for (const [email, businessId] of [['synthetic-v1@example.com', 'ML-CLOUD-DEMO'], ['synthetic-v2@example.com', 'ML-CLOUD-DEMO-V2']]) {
    const login = await post('login', { email, password });
    assert.equal(login.status, 200);
    const data = (await login.json()).data;
    const tenant = await fetch(`http://127.0.0.1:${server.address().port}/tenant?businessId=OTHER`, { headers: { Authorization: `Bearer ${data.token}` } });
    assert.deepEqual(await tenant.json(), { businessId });
  }
  process.env.DEMO_V2_REGISTRATION_ENABLED = 'true';
  const duplicate = await post('register-demo-v2', { name: 'Duplicate', email: 'synthetic-v2@example.com', password }, v1.token);
  assert.equal(duplicate.status, 409);
  assert.equal(await User.countDocuments({ businessId: 'ML-CLOUD-DEMO-V2' }), 1);
});
