'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Long, ObjectId } = require('mongoose').mongo.BSON;
const { createMlTestActivity, MAX_EVENTS } = require('../src/services/mlTestActivity');
const { createMlTestAdminRoutes } = require('../src/routes/mlTestAdmin');
const config = require('../src/config/v3Operational');
const user = { _id: 'admin', role: 'admin', isActive: true, businessId: config.businessId };
const checkpointId = '22222222-2222-4222-8222-222222222222';
const cycleId = '11111111-1111-4111-8111-111111111111';
const id = value => new ObjectId(String(value).padStart(24, '0'));
const scope = { businessId: config.businessId, scenarioId: config.scenarioId };
const createSale = (n, lines, extra = {}) => ({ ...scope, revision: Long.fromNumber(n), eventOrdinal: 0,
  entityType: 'sale', operation: 'CREATE', entityKey: String(id(n)), effectiveAtUtc: new Date('2026-10-19T15:00:00Z'),
  projection: { initialStatus: 'completed', lines: lines.map(([sku, quantity]) => ({ sku, quantity })) }, ...extra });

function field(row, path) { return path.split('.').reduce((value, key) => value?.[key], row); }
function equals(a, b) { return a == null || b == null ? a === b : String(a) === String(b); }
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(option => matches(row, option));
    const actual = field(row, key);
    if (value && typeof value === 'object' && !value._bsontype) return Object.entries(value).every(([operator, bound]) =>
      operator === '$in' ? bound.some(item => equals(actual, item)) : operator === '$gt' ? BigInt(actual) > BigInt(bound)
        : operator === '$lte' ? BigInt(actual) <= BigInt(bound) : assert.fail('unexpected query operator ' + operator));
    return equals(actual, value);
  });
}
function fixture(options = {}) {
  const control = { businessId: config.businessId, state: 'TEST_ACTIVE', resetEpoch: Long.fromNumber(5), testCycleId: cycleId,
    activeCheckpointId: checkpointId, ...options.control };
  const tables = {
    mltestcontrols: [control], mltestcheckpoints: [{ ...scope, checkpointId, status: 'READY', dataVersion: '173', ...options.checkpoint }],
    v3operationalrevisions: [{ _id: config.businessId, revision: Long.fromNumber(177) }],
    v3operationalchanges: [createSale(173, [['OLD', 100]]), createSale(174, [['A', 2], ['A', 3], ['B', 1]]),
      createSale(175, [['A', 4]]), createSale(176, [['PURCHASE', 200]], { entityType: 'purchase' }),
      { ...scope, revision: Long.fromNumber(177), entityType: 'transaction', operation: 'CANCEL', entityKey: String(id(100)),
        projection: { type: 'sale' }, effectiveAtUtc: new Date('2026-10-19T16:00:00Z') },
      createSale(177, [['FOREIGN', 500]], { businessId: 'other' }), createSale(177, [['OTHER-SCENARIO', 500]], { scenarioId: 'other' })],
    transactions: [{ _id: id(100), businessId: config.businessId, type: 'sale', status: 'cancelled', products: [{ productId: id(3), quantity: 2 }] },
      { _id: id(101), businessId: 'other', type: 'sale', status: 'cancelled', products: [{ sku: 'FOREIGN', quantity: 500 }] }],
    products: ['A', 'B', 'C'].map((sku, index) => ({ _id: id(index + 1), businessId: config.businessId, sku, name: 'Producto ' + sku })),
  };
  if (options.rows) tables.v3operationalchanges = options.rows;
  const reads = []; let ended = 0;
  const client = { options: { hosts: [{ host: 'localhost', port: 27017 }], replicaSet: 'rs0', ...options.client },
    startSession(settings) { assert.deepEqual(settings, { snapshot: true, causalConsistency: false });
      return { endSession: async () => { ended++; } }; } };
  const db = { databaseName: 'inventory_billing', client,
    admin: () => ({ command: async () => ({ setName: 'rs0', isWritablePrimary: true, me: 'localhost:27017', hosts: ['localhost:27017'] }) }),
    collection(name) {
      assert.ok(tables[name], name);
      return { async findOne(filter, readOptions) { reads.push({ name, filter, readOptions }); return tables[name].find(row => matches(row, filter)) || null; },
        find(filter, readOptions) {
          reads.push({ name, filter, readOptions }); let values = tables[name].filter(row => matches(row, filter));
          const cursor = { sort() { values = values.sort((a, b) => Number(BigInt(b.revision || 0) - BigInt(a.revision || 0))); return cursor; },
            limit(n) { values = values.slice(0, n); return cursor; }, toArray: async () => { options.afterRead?.(name, control); return values; } };
          return cursor;
        } };
    } };
  const env = { NODE_ENV: 'test', ML_TEST_LOCAL_ENABLED: 'true', MONGODB_URI: 'mongodb://localhost:27017/inventory_billing?replicaSet=rs0',
    ML_TEST_LOCAL_EXPECTED_DATABASE: 'inventory_billing', MONGODB_REPLICA_SET: 'rs0', ...options.env };
  return { service: createMlTestActivity({ client, db, env }), tables, reads, control, ended: () => ended };
}

test('uses only checkpoint revision and tenant/scenario; aggregates repeated lines and sales per SKU', async () => {
  const f = fixture(); const result = await f.service.execute({ user });
  assert.deepEqual(result.summary, { baselineRevision: '173', currentRevision: '177', totalSales: 2,
    grossUnits: 10, affectedProducts: 3, cancellationCount: 1 });
  assert.deepEqual(result.products.map(row => row.sku), ['C', 'A', 'B']);
  const a = result.products.find(row => row.sku === 'A');
  assert.equal(a.totalQuantity, 9); assert.equal(a.saleCount, 2); assert.equal(a.operations.length, 2);
  assert.equal(a.operations[1].quantity, 5); assert.equal(a.name, 'Producto A');
  const query = f.reads.find(row => row.name === 'v3operationalchanges');
  assert.equal(String(query.filter.revision.$gt), '173'); assert.equal(query.filter.businessId, config.businessId);
  assert.equal(query.filter.scenarioId, config.scenarioId); assert.equal(query.readOptions.readConcern.level, 'snapshot');
  assert.equal(f.ended(), 1); assert.equal(JSON.stringify(result).includes('PURCHASE'), false);
});

test('cancellation of a pre-checkpoint sale is separate, never counted or subtracted as a new sale', async () => {
  const result = await fixture().service.execute({ user });
  const c = result.products.find(row => row.sku === 'C');
  assert.equal(c.saleCount, 0); assert.equal(c.totalQuantity, 0); assert.equal(c.cancelledQuantity, 2);
  assert.equal(c.operations[0].kind, 'SALE_CANCELLED'); assert.equal(result.summary.grossUnits, 10);
});

test('cancellation retains the originally committed SKU when the current product was renamed', async () => {
  const cancellation = fixture().tables.v3operationalchanges.find(row => row.operation === 'CANCEL');
  const f = fixture({ rows: [createSale(100, [['ORIGINAL', 2]]), cancellation] });
  f.tables.transactions[0].products = [{ productId: id(1), quantity: 2 }];
  f.tables.products[0].sku = 'RENAMED';
  const result = await f.service.execute({ user });
  assert.equal(result.products[0].sku, 'ORIGINAL'); assert.equal(result.summary.totalSales, 0);
  assert.equal(f.reads.filter(row => row.name === 'transactions').length, 1);
});

test('restore/epoch changes during a read discard the response and close the snapshot session', async () => {
  const f = fixture({ afterRead(name, control) { if (name === 'products') control.resetEpoch = Long.fromNumber(6); } });
  await assert.rejects(f.service.execute({ user }), { code: 'STALE_TEST_EPOCH' }); assert.equal(f.ended(), 1);
});

test('cancellation cannot resolve a transaction from another tenant', async () => {
  const f = fixture(); const cancellation = f.tables.v3operationalchanges.find(row => row.operation === 'CANCEL');
  cancellation.entityKey = String(id(101));
  await assert.rejects(f.service.execute({ user }), { code: 'ML_TEST_ACTIVITY_REFERENCE_INVALID' });
});

test('UI and assistant committed sales have identical observation semantics', async () => {
  const rows = [createSale(174, [['A', 1]], { source: 'ui' }), createSale(175, [['A', 1]], { source: 'assistant' })];
  const result = await fixture({ rows }).service.execute({ user });
  assert.equal(result.products.length, 1); assert.equal(result.products[0].saleCount, 2);
  assert.ok(result.products[0].operations.every(row => row.kind === 'SALE_COMPLETED'));
  assert.equal('source' in result.products[0].operations[0], false);
});

test('LOCAL authorization fails closed for production, disabled flags, cloud and foreign tenant', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { ML_TEST_LOCAL_ENABLED: undefined }, { ML_TEST_LOCAL_ENABLED: 'false' },
    { MONGODB_URI: 'mongodb+srv://user:secret@example.mongodb.net/inventory_billing' }, { ML_TEST_LOCAL_EXPECTED_DATABASE: 'other' }]) {
    const f = fixture({ env }); await assert.rejects(f.service.execute({ user })); assert.equal(f.reads.length, 0);
  }
  for (const invalid of [{ ...user, role: 'user' }, { ...user, businessId: 'foreign' }, null]) {
    const f = fixture(); await assert.rejects(f.service.execute({ user: invalid })); assert.equal(f.reads.length, 0);
  }
});

test('requires active cycle, nonzero epoch, READY checkpoint, and a real baseline revision', async () => {
  for (const control of [{ state: 'NO_TEST' }, { state: 'RESTORING' }, { state: 'CHECKPOINT_CREATING' }, { testCycleId: null },
    { resetEpoch: Long.ZERO }, { activeCheckpointId: null }]) await assert.rejects(fixture({ control }).service.execute({ user }), { code: 'ML_TEST_CYCLE_NOT_ACTIVE' });
  await assert.rejects(fixture({ checkpoint: { status: 'FAILED' } }).service.execute({ user }), { code: 'ML_TEST_CHECKPOINT_NOT_READY' });
  await assert.rejects(fixture({ checkpoint: { dataVersion: null } }).service.execute({ user }), { code: 'ML_TEST_ACTIVITY_REVISION_INVALID' });
});

test('rejects client scope/baseline overrides and malformed cursor', async () => {
  for (const query of [{ businessId: 'foreign' }, { scenarioId: 'other' }, { baselineRevision: '0' }, { limit: 21 }, { cursor: 'invalid' }])
    await assert.rejects(fixture().service.execute({ user, query }));
});

test('pagination pins upper revision and rejects cross-checkpoint/epoch cursors', async () => {
  const f = fixture(); const first = await f.service.execute({ user, query: { limit: 1 } });
  f.tables.v3operationalchanges.push(createSale(178, [['NEW', 1]]));
  f.tables.v3operationalrevisions[0].revision = Long.fromNumber(178);
  const second = await f.service.execute({ user, query: { limit: 1, cursor: first.page.nextCursor } });
  assert.equal(second.summary.currentRevision, '177'); assert.equal(second.products[0].sku, 'A');
  f.control.resetEpoch = Long.fromNumber(6);
  await assert.rejects(f.service.execute({ user, query: { cursor: first.page.nextCursor } }), { code: 'ML_TEST_ACTIVITY_CURSOR_INVALID' });
});

test('bounds recent operations while totals include every committed sale; caps source reads', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => createSale(174 + index, [['A', 1]]));
  const f = fixture({ rows }); f.tables.v3operationalrevisions[0].revision = Long.fromNumber(200);
  const result = await f.service.execute({ user }); assert.equal(result.summary.totalSales, 12);
  assert.equal(result.products[0].operations.length, 5); assert.equal(result.products[0].operationCount, 12);
  const huge = fixture({ rows: Array.from({ length: MAX_EVENTS + 1 }, () => createSale(174, [['A', 1]])) });
  await assert.rejects(huge.service.execute({ user }), { code: 'ML_TEST_ACTIVITY_READ_LIMIT_EXCEEDED' });
});

test('finish verification is an internal read of the finalized receipt; GET still requires TEST_ACTIVE', async () => {
  const f = fixture({ rows: [], control: { state: 'NO_TEST', activeCheckpointId: null, testCycleId: null,
    lastCheckpointId: checkpointId, restoreFinish: true, restoreId: 'receipt', finalizedAt: new Date() } });
  f.tables.v3operationalrevisions[0].revision = Long.fromNumber(173);
  await assert.rejects(f.service.execute({ user }), { code: 'ML_TEST_CYCLE_NOT_ACTIVE' });
  const result = await f.service.verifyRestored({ user }); assert.equal(result.status, 'EMPTY');
  assert.equal(result.currentRevision, '173');
  f.control.finalizedAt = null;
  await assert.rejects(f.service.verifyRestored({ user }), { code: 'ML_TEST_CYCLE_NOT_ACTIVE' });
});

test('activity route is private, sanitized and read-only; client cannot supply baseline', async () => {
  const f = fixture();
  const router = createMlTestAdminRoutes({ authenticateMiddleware(req, res, next) {
    if (!req.headers['x-test-user']) return res.status(401).json({ success: false });
    req.user = req.headers['x-test-user'] === 'admin' ? user : { ...user, role: 'user' }; next();
  }, getActivity: () => f.service });
  const app = express(); app.use('/api/ml-test', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/api/ml-test/activity';
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-test-user': 'user' } })).status, 403);
    assert.equal((await fetch(url + '?baselineRevision=0', { headers: { 'x-test-user': 'admin' } })).status, 400);
    const response = await fetch(url, { headers: { 'x-test-user': 'admin' } });
    const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.data.summary.totalSales, 2);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(body), /password|mongodb:|customerName|artifactData/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
