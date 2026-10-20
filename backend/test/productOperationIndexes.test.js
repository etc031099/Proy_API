'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_MANIFEST, checkProductOperationIndexes, provisionProductOperationIndexes } = require('../src/services/productOperationIndexes');
const { parseArgs, readConfig, runCli } = require('../scripts/product-operation-indexes');
const { INDEXES, EXISTING_RECEIPT_INDEX, readConfig: readExplainConfig, collectPlan, summarizeExplain, certify,
  runCli: runExplainCli } = require('../scripts/certify-product-operation-query-plans');

const expected = [
  { name: 'product_ops_tx_created_v1', collection: 'transactions', key: { businessId: 1, 'products.productId': 1, type: 1, date: -1, _id: -1 }, unique: false, sparse: false },
  { name: 'product_ops_tx_cancelled_v1', collection: 'transactions', key: { businessId: 1, 'products.productId': 1, cancelledAt: -1, _id: -1 }, unique: false, sparse: false,
    partialFilterExpression: { type: 'sale', status: 'cancelled', cancelledAt: { $type: 'date' } } },
  { name: 'product_ops_mov_events_v1', collection: 'inventorymovements', key: { businessId: 1, productId: 1, type: 1, occurredAt: -1, _id: -1 }, unique: false, sparse: false,
    partialFilterExpression: { $or: [{ type: 'manual_adjustment' }, { type: 'purchase', reason: 'v3_purchase_receipt' }, { type: 'purchase', 'scenarioData.type': 'purchase_receipt' }] } },
  { name: 'product_ops_change_entity_v1', collection: 'v3operationalchanges', key: { businessId: 1, scenarioId: 1, entityKey: 1 }, unique: false, sparse: false }
];

function mockDb(initial = {}) {
  const names = ['transactions', 'inventorymovements', 'v3operationalchanges'];
  const indexes = Object.fromEntries(names.map(name => [name, [{ name: '_id_', key: { _id: 1 } }, ...(initial[name] || [])]]));
  const calls = [];
  return { calls, db: {
    listCollections: () => ({ toArray: async () => names.map(name => ({ name })) }),
    collection: name => ({
      indexes: async () => structuredClone(indexes[name]),
      createIndex: async (key, options) => {
        calls.push({ operation: 'createIndex', collection: name, key: structuredClone(key), options: structuredClone(options) });
        indexes[name].push({ name: options.name, key: structuredClone(key), unique: options.unique,
          sparse: options.sparse, partialFilterExpression: options.partialFilterExpression });
        return options.name;
      }
    })
  } };
}

function actual(spec, overrides = {}) {
  return { name: spec.name, key: structuredClone(spec.key), unique: spec.unique, sparse: spec.sparse,
    ...(spec.partialFilterExpression ? { partialFilterExpression: structuredClone(spec.partialFilterExpression) } : {}), ...overrides };
}

function explainDb() {
  const id = '64b000000000000000000001';
  const stats = { [INDEXES.created]: [20, 20, 20, 1], [INDEXES.cancelled]: [3, 3, 3, 1],
    [INDEXES.movements]: [4, 4, 4, 1], [INDEXES.changes]: [1, 1, 1, 1],
    [EXISTING_RECEIPT_INDEX]: [218, 218, 20, 4] };
  const makeCursor = (collection, filter) => {
    const cursor = {
      limit() { return this; }, sort() { return this; },
      async toArray() { return [{ _id: id }]; },
      async next() { return { _id: id }; },
      async explain() {
        const indexName = collection === 'transactions'
          ? (filter.status === 'cancelled' ? INDEXES.cancelled : INDEXES.created)
          : collection === 'inventorymovements'
            ? (filter.type === 'manual_adjustment' ? INDEXES.movements : EXISTING_RECEIPT_INDEX)
            : INDEXES.changes;
        const [keys, docs, nReturned, executionTimeMillis] = stats[indexName];
        return { queryPlanner: { winningPlan: { ...(indexName === EXISTING_RECEIPT_INDEX ? { stage: 'SORT' } : { stage: 'FETCH' }),
          inputStage: { stage: 'IXSCAN', indexName } } },
        executionStats: { totalKeysExamined: keys, totalDocsExamined: docs, nReturned, executionTimeMillis } };
      }
    };
    return cursor;
  };
  return { collection: name => ({ find: filter => makeCursor(name, filter) }) };
}

test('manifest defines exactly the four approved index specs and legal single-array multikey definitions', () => {
  assert.equal(INDEX_MANIFEST.length, 4);
  assert.deepEqual(INDEX_MANIFEST.map(spec => ({ name: spec.name, collection: spec.collection, key: spec.key,
    unique: spec.unique, sparse: spec.sparse, ...(spec.partialFilterExpression ? { partialFilterExpression: spec.partialFilterExpression } : {}) })), expected);
  for (const spec of INDEX_MANIFEST.slice(0, 2)) {
    const arrayPaths = Object.keys(spec.key).filter(key => key.startsWith('products.'));
    assert.deepEqual(arrayPaths, ['products.productId']);
    assert.equal(arrayPaths.length, 1);
  }
  assert.equal(INDEX_MANIFEST.some(spec => Object.keys(spec.key).some(key => /projection\.lines\.sku/.test(key))), false);
});

test('check reports PRESENT, MISSING, and CONFLICT without writes', async () => {
  const all = { transactions: expected.slice(0, 2).map(actual), inventorymovements: [actual(expected[2])],
    v3operationalchanges: [actual(expected[3])] };
  assert.equal((await checkProductOperationIndexes(mockDb(all).db)).status, 'READY');
  const missing = await checkProductOperationIndexes(mockDb({ transactions: [actual(expected[0])],
    inventorymovements: [actual(expected[2])], v3operationalchanges: [actual(expected[3])] }).db);
  assert.equal(missing.status, 'MISSING');
  const conflict = await checkProductOperationIndexes(mockDb({ transactions: [actual(expected[0]),
    actual(expected[1], { partialFilterExpression: { status: 'cancelled' } })], inventorymovements: [actual(expected[2])],
    v3operationalchanges: [actual(expected[3])] }).db);
  assert.equal(conflict.status, 'CONFLICT');
});

test('apply creates only missing indexes, leaves present indexes untouched, and never drops/syncs', async () => {
  const { db, calls } = mockDb({ transactions: [actual(expected[0])], inventorymovements: [actual(expected[2])],
    v3operationalchanges: [actual(expected[3])] });
  const result = await provisionProductOperationIndexes(db);
  assert.equal(result.status, 'READY');
  assert.equal(result.createdCount, 1);
  assert.deepEqual(calls.map(row => row.options.name), ['product_ops_tx_cancelled_v1']);
  assert.ok(calls.every(row => row.operation === 'createIndex'));
});

test('apply aborts before any createIndex when a conflict exists', async () => {
  const { db, calls } = mockDb({ transactions: [actual(expected[0]), actual(expected[1], { unique: true })],
    inventorymovements: [actual(expected[2])], v3operationalchanges: [actual(expected[3])] });
  await assert.rejects(provisionProductOperationIndexes(db), { code: 'PRODUCT_OP_INDEX_CONFLICT' });
  assert.deepEqual(calls, []);
});

test('equivalent index with a different name is accepted and reported', async () => {
  const alias = actual(expected[0], { name: 'existing_equivalent_index' });
  const { db } = mockDb({ transactions: [alias, actual(expected[1])], inventorymovements: [actual(expected[2])],
    v3operationalchanges: [actual(expected[3])] });
  const result = await checkProductOperationIndexes(db);
  assert.equal(result.status, 'READY');
  assert.equal(result.indexes[0].actualIndexName, 'existing_equivalent_index');
});

test('CLI defaults to read-only check and rejects ambiguous or unknown mode flags', () => {
  assert.equal(parseArgs([]), 'CHECK');
  assert.equal(parseArgs(['--check']), 'CHECK');
  assert.equal(parseArgs(['--apply']), 'APPLY');
  assert.throws(() => parseArgs(['--check', '--apply']), { code: 'PRODUCT_OP_INDEX_ARGUMENTS_INVALID' });
  assert.throws(() => parseArgs(['--uri', 'mongodb://secret']), { code: 'PRODUCT_OP_INDEX_ARGUMENTS_INVALID' });
});

test('CLI default check mode does not create indexes', async () => {
  const { db, calls } = mockDb({ transactions: [actual(expected[0]), actual(expected[1])],
    inventorymovements: [actual(expected[2])], v3operationalchanges: [actual(expected[3])] });
  const lines = [];
  const result = await runCli({ env: { MONGODB_URI: 'mongodb://localhost:27017/inventory_billing',
    PRODUCT_OP_INDEX_EXPECTED_DATABASE: 'inventory_billing' }, args: [], stdout: line => lines.push(line),
  clientFactory: () => ({ connect: async () => {}, db: () => db, close: async () => {} }) });
  assert.equal(result.mode, 'CHECK');
  assert.equal(result.writes, 0);
  assert.deepEqual(calls, []);
  assert.equal(JSON.parse(lines[0]).status, 'READY');
});

test('remote apply requires a separate explicit confirmation', async () => {
  const lines = [];
  const previousExitCode = process.exitCode;
  const result = await runCli({ env: { MONGODB_URI: 'mongodb+srv://host.example/inventory_billing',
    PRODUCT_OP_INDEX_EXPECTED_DATABASE: 'inventory_billing' }, args: ['--apply'], stdout: line => lines.push(line),
  clientFactory: () => { throw new Error('must stop before connecting'); } });
  assert.equal(result.code, 'PRODUCT_OP_INDEX_REMOTE_APPLY_BLOCKED');
  assert.equal(result.writes, 0);
  assert.equal(JSON.parse(lines[0]).code, 'PRODUCT_OP_INDEX_REMOTE_APPLY_BLOCKED');
  process.exitCode = previousExitCode;
});

test('CLI output and failures never contain configured URI credentials', async () => {
  const secret = 'mongodb://user:password@localhost:27017/inventory_billing';
  const env = { MONGODB_URI: secret, PRODUCT_OP_INDEX_EXPECTED_DATABASE: 'inventory_billing' };
  assert.deepEqual(readConfig(env), { uri: secret, expectedDatabase: 'inventory_billing', isLocal: true });
  const lines = [];
  const previousExitCode = process.exitCode;
  await runCli({ env, args: [], stdout: line => lines.push(line), clientFactory: () => ({
    connect: async () => { throw new Error(secret); }, close: async () => {}
  }) });
  process.exitCode = previousExitCode;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(secret), false);
  assert.equal(lines[0].includes('password'), false);
});

test('explain CLI failure reports safe stage/type while hiding message and credentials', async () => {
  const secret = 'mongodb://user:password@localhost:27017/inventory_billing';
  const env = { MONGODB_URI: secret, PRODUCT_OP_INDEX_EXPECTED_DATABASE: 'inventory_billing',
    PRODUCT_OP_INDEX_BUSINESS_ID: 'B', PRODUCT_OP_INDEX_SCENARIO_ID: 'S' };
  const lines = [];
  const previousExitCode = process.exitCode;
  await runExplainCli({ env, args: ['--sku', 'SKU-1'], stdout: line => lines.push(line), clientFactory: () => ({
    connect: async () => { throw new Error(secret); }, close: async () => {}
  }) });
  process.exitCode = previousExitCode;
  const output = JSON.parse(lines[0]);
  assert.equal(output.stage, 'CONNECT');
  assert.equal(output.exceptionType, 'Error');
  assert.equal(lines[0].includes(secret), false);
  assert.equal(lines[0].includes('password'), false);
});

test('query plan summary reports index, work, blocking sort, and timing', () => {
  const explain = { queryPlanner: { winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'product_ops_tx_created_v1' } } },
    executionStats: { totalKeysExamined: 23, totalDocsExamined: 21, nReturned: 20, executionTimeMillis: 4 } };
  const result = summarizeExplain('SALE', 'product_ops_tx_created_v1', explain);
  assert.equal(result.acceptedIndexUsed, true);
  assert.equal(result.blockingSort, false);
  assert.equal(result.totalKeysExamined, 23);
  assert.equal(result.status, 'PASS');
  const tree = collectPlan({ stage: 'SORT', inputStage: explain.queryPlanner.winningPlan });
  assert.equal(tree.blockingSort, true);
});

test('certification requires approved indexes and accepts the measured receipt plan with visible sort review', async () => {
  const result = await certify({ db: explainDb(), businessId: 'B', scenarioId: 'S', sku: 'SKU-1' });
  assert.equal(result.status, 'PASS_WITH_REVIEW');
  const byQuery = Object.fromEntries(result.checks.map(row => [row.query, row]));
  assert.equal(byQuery.SALE.expectedIndex, INDEXES.created);
  assert.equal(byQuery.SALE.status, 'PASS');
  assert.equal(byQuery.PURCHASE_CREATED.expectedIndex, INDEXES.created);
  assert.equal(byQuery.PURCHASE_CREATED.status, 'PASS');
  assert.equal(byQuery.SALE_CANCELLED.expectedIndex, INDEXES.cancelled);
  assert.equal(byQuery.SALE_CANCELLED.status, 'PASS');
  assert.equal(byQuery.INVENTORY_ADJUSTMENT.expectedIndex, INDEXES.movements);
  assert.equal(byQuery.INVENTORY_ADJUSTMENT.status, 'PASS');
  assert.equal(byQuery.JOURNAL_ENRICHMENT.expectedIndex, INDEXES.changes);
  assert.equal(byQuery.JOURNAL_ENRICHMENT.status, 'PASS');
  assert.deepEqual(byQuery.PURCHASE_RECEIVED.acceptedIndexes, [EXISTING_RECEIPT_INDEX, INDEXES.movements]);
  assert.equal(byQuery.PURCHASE_RECEIVED.indexName, EXISTING_RECEIPT_INDEX);
  assert.equal(byQuery.PURCHASE_RECEIVED.status, 'PASS_WITH_REVIEW');
  assert.equal(byQuery.PURCHASE_RECEIVED.blockingSort, true);
  assert.equal(byQuery.PURCHASE_RECEIVED.totalKeysExamined, 218);
  assert.equal(byQuery.PURCHASE_RECEIVED.totalDocsExamined, 218);
  assert.equal(byQuery.PURCHASE_RECEIVED.nReturned, 20);
});

test('certification configuration requires a fixed SKU argument and exact expected database scope', () => {
  const env = { MONGODB_URI: 'mongodb://localhost:27017/inventory_billing',
    PRODUCT_OP_INDEX_EXPECTED_DATABASE: 'inventory_billing', PRODUCT_OP_INDEX_BUSINESS_ID: 'B',
    PRODUCT_OP_INDEX_SCENARIO_ID: 'S' };
  assert.equal(readExplainConfig(env, ['--sku', 'SKU-1']).sku, 'SKU-1');
  assert.throws(() => readExplainConfig({ ...env, MONGODB_URI: 'mongodb+srv://host.example/inventory_billing' },
    ['--sku', 'SKU-1']), { code: 'PRODUCT_OP_EXPLAIN_LOCAL_MONGO_REQUIRED' });
  assert.throws(() => readExplainConfig(env, ['--sku', 'SKU-1', '--uri', 'x']), { code: 'PRODUCT_OP_EXPLAIN_CONFIG_INVALID' });
  assert.throws(() => readConfig({ ...env, PRODUCT_OP_INDEX_EXPECTED_DATABASE: 'other' }), { code: 'PRODUCT_OP_INDEX_DATABASE_MISMATCH' });
});
