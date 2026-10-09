const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { User } = require('../src/models');
const authRoutes = require('../src/routes/auth');

const input = { name: 'Demo owner', email: 'demo-v2@example.com', password: 'SyntheticOnly1' };
const v1 = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', businessId: 'ML-CLOUD-DEMO', isActive: true, role: 'user' };

const setup = async (t, options = {}) => {
  const old = { enabled: process.env.DEMO_V2_REGISTRATION_ENABLED, email: process.env.DEMO_V2_REGISTRATION_EMAIL, jwt: process.env.JWT_SECRET };
  process.env.DEMO_V2_REGISTRATION_ENABLED = options.enabled ?? 'true';
  process.env.DEMO_V2_REGISTRATION_EMAIL = options.email ?? input.email;
  process.env.JWT_SECRET = 'synthetic-unit-test-only-secret-123456';
  t.after(() => {
    for (const [key, value] of Object.entries({ DEMO_V2_REGISTRATION_ENABLED: old.enabled, DEMO_V2_REGISTRATION_EMAIL: old.email, JWT_SECRET: old.jwt })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  let created;
  t.mock.method(User, 'findById', () => ({ select: async () => options.owner ?? v1 }));
  t.mock.method(User, 'findOne', async query => options.lookup?.(query) ?? null);
  t.mock.method(User, 'create', async data => {
    if (options.createError) throw options.createError;
    created = data;
    return { ...data, _id: 'bbbbbbbbbbbbbbbbbbbbbbbb' };
  });
  const app = express(); app.use(express.json()); app.use('/api/auth', authRoutes);
  app.use((err, req, res, next) => res.status(500).json({ success: false, message: 'Internal error' }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = jwt.sign({ id: v1._id }, process.env.JWT_SECRET);
  return { created: () => created, post: (body = input, auth = true, route = 'register-demo-v2') => fetch(`http://127.0.0.1:${server.address().port}/api/auth/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
  }) };
};

test('demo provisioning is disabled by default and requires an authenticated V1 owner', async t => {
  const off = await setup(t, { enabled: 'false' });
  assert.equal((await off.post()).status, 404);
  process.env.DEMO_V2_REGISTRATION_ENABLED = 'true';
  assert.equal((await off.post(input, false)).status, 401);
  assert.equal(off.created(), undefined);
});
test('demo provisions server-side logical V2 business without changing V1', async t => {
  const s = await setup(t); const response = await s.post();
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.user.businessId, 'ML-CLOUD-DEMO-V2');
  assert.equal(s.created().businessId, 'ML-CLOUD-DEMO-V2');
  assert.equal(v1.businessId, 'ML-CLOUD-DEMO');
  assert.equal(body.data.user.password, undefined);
});
test('other tenant and unconfigured/unapproved email cannot provision', async t => {
  const s = await setup(t, { owner: { ...v1, businessId: 'OTHER' } });
  assert.equal((await s.post()).status, 403); assert.equal(s.created(), undefined);
});
test('allowlist is server-side and fails closed when missing', async t => {
  const s = await setup(t, { email: '' });
  assert.equal((await s.post()).status, 403);
  process.env.DEMO_V2_REGISTRATION_EMAIL = 'different@example.com';
  assert.equal((await s.post()).status, 403); assert.equal(s.created(), undefined);
});
for (const field of ['businessId', 'role', '_id', 'scenarioId', 'userId']) {
  test(`demo rejects client-selected ${field}`, async t => {
    const s = await setup(t);
    assert.equal((await s.post({ ...input, [field]: 'forbidden' })).status, 400);
    assert.equal(s.created(), undefined);
  });
}
for (const data of [{}, { ...input, password: 'secret' }, { ...input, email: { $ne: null } },
  { ...input, name: [] }, { ...input, password: 'X'.repeat(100) }, { ...input, password: 'A1' + 'á'.repeat(36) }]) {
  test('demo validates identity and never echoes credential values', async t => {
    const s = await setup(t); const response = await s.post(data);
    assert.equal(response.status, 400);
    const body = await response.json(); assert.equal(body.errors, undefined);
    assert.equal(s.created(), undefined);
  });
}
test('demo rejects duplicate business/email and safely handles unique-index races', async t => {
  const s = await setup(t, { lookup: query => query.businessId ? { businessId: query.businessId } : null });
  const response = await s.post(); assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'BUSINESS_EXISTS');
  assert.equal(s.created(), undefined);
});
test('duplicate email uses normal conflict contract', async t => {
  const s = await setup(t, { lookup: query => query.email ? { email: query.email } : null });
  const response = await s.post(); assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'EMAIL_EXISTS');
});
test('unique business race is normalized without leaking raw values', async t => {
  const s = await setup(t, { createError: { code: 11000, keyPattern: { businessId: 1 } } });
  const response = await s.post(); assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'BUSINESS_EXISTS');
});
test('normal public registration cannot claim reserved V2 but normal V1 remains compatible', async t => {
  const s = await setup(t);
  assert.equal((await s.post({ ...input, businessId: 'ML-CLOUD-DEMO-V2' }, false, 'register')).status, 403);
  assert.equal((await s.post({ ...input, businessId: 'ML-CLOUD-DEMO' }, false, 'register')).status, 201);
  assert.equal(s.created().businessId, 'ML-CLOUD-DEMO');
});
test('unknown DB failure returns a sanitized response', async t => {
  const s = await setup(t, { createError: new Error('private Mongo URI/password') });
  const response = await s.post(); assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('private'));
});
