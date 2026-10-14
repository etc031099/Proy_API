const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { User } = require('../src/models');
const authRoutes = require('../src/routes/auth');

const input = { name: 'Demo V3 owner', email: 'demo-v3@example.com', password: 'SyntheticOnly1' };
const v1 = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessId: 'ML-CLOUD-DEMO', isActive: true, role: 'user' };

const setup = async (t, options = {}) => {
  const env = Object.fromEntries(['DEMO_V3_REGISTRATION_ENABLED', 'DEMO_V3_REGISTRATION_EMAIL', 'JWT_SECRET'].map(key => [key, process.env[key]]));
  process.env.DEMO_V3_REGISTRATION_ENABLED = options.enabled ?? 'true';
  process.env.DEMO_V3_REGISTRATION_EMAIL = options.email ?? input.email;
  process.env.JWT_SECRET = 'synthetic-unit-test-only-secret-123456';
  t.after(() => { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let created;
  t.mock.method(User, 'findById', () => ({ select: async () => options.owner ?? v1 }));
  t.mock.method(User, 'findOne', async query => options.lookup?.(query) ?? null);
  t.mock.method(User, 'create', async data => { if (options.createError) throw options.createError; created = data; return { ...data, _id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }; });
  const app = express(); app.use(express.json()); app.use('/api/auth', authRoutes);
  app.use((err, req, res, next) => res.status(500).json({ success: false, message: 'Internal error' }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = jwt.sign({ id: v1._id }, process.env.JWT_SECRET);
  return { created: () => created, post: (body = input, auth = true, route = 'register-demo-v3') => fetch(`http://127.0.0.1:${server.address().port}/api/auth/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
  }) };
};

test('V3 provisioning is disabled by default and requires an authenticated V1 owner', async t => {
  const s = await setup(t, { enabled: 'false' });
  assert.equal((await s.post()).status, 404);
  process.env.DEMO_V3_REGISTRATION_ENABLED = 'true';
  assert.equal((await s.post(input, false)).status, 401);
  assert.equal(s.created(), undefined);
});
test('provisioning assigns the V3 business server-side and does not change V1', async t => {
  const s = await setup(t); const response = await s.post();
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.user.businessId, 'MINIMARKET-PASCO-V3');
  assert.equal(s.created().businessId, 'MINIMARKET-PASCO-V3');
  assert.equal(v1.businessId, 'ML-CLOUD-DEMO');
  assert.equal(body.data.user.password, undefined);
});
test('other tenant and unapproved or missing allowlist cannot provision', async t => {
  const s = await setup(t, { owner: { ...v1, businessId: 'OTHER' } });
  assert.equal((await s.post()).status, 403); assert.equal(s.created(), undefined);
});
test('missing email allowlist fails closed', async t => {
  const s = await setup(t, { email: '' });
  assert.equal((await s.post()).status, 403);
  assert.equal(s.created(), undefined);
});
test('allowlist is exact, server-side, and client cannot choose tenant', async t => {
  const s = await setup(t);
  assert.equal((await s.post({ ...input, businessId: 'OTHER' })).status, 400);
  assert.equal(s.created(), undefined);
  process.env.DEMO_V3_REGISTRATION_EMAIL = 'different@example.com';
  assert.equal((await s.post()).status, 403); assert.equal(s.created(), undefined);
});
for (const field of ['role', '_id', 'scenarioId', 'userId']) {
  test(`V3 registration rejects client-selected ${field}`, async t => {
    const s = await setup(t);
    assert.equal((await s.post({ ...input, [field]: 'forbidden' })).status, 400);
    assert.equal(s.created(), undefined);
  });
}
test('public registration cannot claim reserved V3 and normal registrations still work', async t => {
  const s = await setup(t);
  assert.equal((await s.post({ ...input, businessId: 'MINIMARKET-PASCO-V3' }, false, 'register')).status, 403);
  assert.equal((await s.post({ ...input, businessId: 'ordinary-business' }, false, 'register')).status, 201);
  assert.equal(s.created().businessId, 'ordinary-business');
});
test('duplicate tenant and database errors stay sanitized', async t => {
  const duplicate = await setup(t, { lookup: query => query.businessId ? { businessId: query.businessId } : null });
  assert.equal((await duplicate.post()).status, 409);
  const failed = await setup(t, { createError: new Error('private database detail') });
  const response = await failed.post(); assert.equal(response.status, 500);
  assert.equal((await response.text()).includes('private'), false);
});
