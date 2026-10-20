'use strict';

const { MongoClient } = require('mongodb');

const REQUIRED = Object.freeze({
  uri: 'MONGODB_URI', database: 'PRODUCT_OP_INDEX_EXPECTED_DATABASE',
  businessId: 'PRODUCT_OP_INDEX_BUSINESS_ID', scenarioId: 'PRODUCT_OP_INDEX_SCENARIO_ID'
});
const INDEXES = Object.freeze({
  created: 'product_ops_tx_created_v1', cancelled: 'product_ops_tx_cancelled_v1',
  movements: 'product_ops_mov_events_v1', changes: 'product_ops_change_entity_v1'
});
const EXISTING_RECEIPT_INDEX = 'businessId_1_productId_1_occurredAt_1_createdAt_1';
const movementPartial = Object.freeze({ $or: [
  { type: 'manual_adjustment' },
  { type: 'purchase', reason: 'v3_purchase_receipt' },
  { type: 'purchase', 'scenarioData.type': 'purchase_receipt' }
] });

function safeError(code) { const error = new Error(code); error.code = code; return error; }

function readConfig(env = process.env, args = process.argv.slice(2)) {
  const allowedArgs = args.length === 2 && args[0] === '--sku';
  const uri = env[REQUIRED.uri]?.trim();
  const database = env[REQUIRED.database]?.trim();
  const businessId = env[REQUIRED.businessId]?.trim();
  const scenarioId = env[REQUIRED.scenarioId]?.trim();
  const sku = allowedArgs ? args[1]?.trim() : '';
  if (!allowedArgs || !sku || !uri || !database || !businessId || !scenarioId) throw safeError('PRODUCT_OP_EXPLAIN_CONFIG_INVALID');
  let parsed;
  try { parsed = new URL(uri); } catch { throw safeError('PRODUCT_OP_EXPLAIN_URI_INVALID'); }
  if (!/^mongodb(?:\+srv)?:$/.test(parsed.protocol)) throw safeError('PRODUCT_OP_EXPLAIN_URI_INVALID');
  if (!['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'].includes(parsed.hostname.toLowerCase())) {
    throw safeError('PRODUCT_OP_EXPLAIN_LOCAL_MONGO_REQUIRED');
  }
  if (decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '') !== database) {
    throw safeError('PRODUCT_OP_EXPLAIN_DATABASE_MISMATCH');
  }
  return { uri, database, businessId, scenarioId, sku };
}

function collectPlan(plan, state = { indexes: [], blockingSort: false, stages: [] }) {
  if (!plan || typeof plan !== 'object') return state;
  if (plan.stage) {
    state.stages.push(plan.stage);
    if (plan.stage === 'SORT') state.blockingSort = true;
  }
  if (plan.indexName) state.indexes.push(plan.indexName);
  for (const value of Object.values(plan)) {
    if (Array.isArray(value)) value.forEach(item => collectPlan(item, state));
    else if (value && typeof value === 'object') collectPlan(value, state);
  }
  return state;
}

function summarizeExplain(name, expectation, explain) {
  const winning = explain.queryPlanner?.winningPlan || {};
  const plan = collectPlan(winning);
  const execution = explain.executionStats || {};
  const acceptedIndexes = Array.isArray(expectation) ? expectation : [expectation];
  const acceptedIndexUsed = plan.indexes.some(index => acceptedIndexes.includes(index));
  const indexName = [...new Set(plan.indexes)].join(', ') || null;
  const preferredReceiptPlan = name === 'PURCHASE_RECEIVED' && plan.indexes.includes(EXISTING_RECEIPT_INDEX);
  const status = !acceptedIndexUsed ? 'INDEX_NOT_USED'
    : plan.blockingSort ? (preferredReceiptPlan || name === 'PURCHASE_RECEIVED' ? 'PASS_WITH_REVIEW' : 'REVIEW_BLOCKING_SORT')
    : 'PASS';
  return { query: name, ...(Array.isArray(expectation) ? { acceptedIndexes } : { expectedIndex: expectation }), indexName,
    mainStage: plan.stages[0] || null, totalKeysExamined: execution.totalKeysExamined ?? null,
    totalDocsExamined: execution.totalDocsExamined ?? null, nReturned: execution.nReturned ?? null,
    blockingSort: plan.blockingSort, executionTimeMillis: execution.executionTimeMillis ?? null,
    acceptedIndexUsed, status };
}

async function certify({ db, businessId, scenarioId, sku, onStage = () => {} }) {
  onStage('SKU_RESOLUTION');
  const products = db.collection('products');
  const matches = await products.find({ businessId, sku }, { projection: { _id: 1, sku: 1 } }).limit(2).toArray();
  if (matches.length !== 1) throw safeError(matches.length ? 'PRODUCT_OP_EXPLAIN_SKU_AMBIGUOUS' : 'PRODUCT_OP_EXPLAIN_SKU_NOT_FOUND');
  const productId = matches[0]._id;
  const tx = db.collection('transactions');
  const movements = db.collection('inventorymovements');
  const changes = db.collection('v3operationalchanges');
  const tenantScenario = { businessId, $or: [{ scenarioId }, { scenarioId: null }, { scenarioId: { $exists: false } }] };
  const definitions = [
    ['SALE', INDEXES.created, tx, { ...tenantScenario, 'products.productId': productId, type: 'sale' }, { date: -1, _id: -1 }],
    ['PURCHASE_CREATED', INDEXES.created, tx, { ...tenantScenario, 'products.productId': productId, type: 'purchase' }, { date: -1, _id: -1 }],
    ['SALE_CANCELLED', INDEXES.cancelled, tx, { ...tenantScenario, 'products.productId': productId, type: 'sale', status: 'cancelled', cancelledAt: { $type: 'date' } }, { cancelledAt: -1, _id: -1 }],
    ['PURCHASE_RECEIVED', [EXISTING_RECEIPT_INDEX, INDEXES.movements], movements, { ...tenantScenario, productId, type: 'purchase', ...movementPartial }, { occurredAt: -1, _id: -1 }],
    ['INVENTORY_ADJUSTMENT', INDEXES.movements, movements, { ...tenantScenario, productId, type: 'manual_adjustment' }, { occurredAt: -1, _id: -1 }],
    ['JOURNAL_ENRICHMENT', INDEXES.changes, changes, { businessId, scenarioId, entityKey: { $in: [] } }, null]
  ];

  // Pick one bounded transaction identity in scope for the enrichment plan; this does not fetch activity payload.
  const entity = await tx.find({ ...tenantScenario, 'products.productId': productId }, { projection: { _id: 1 } }).limit(1).next();
  const journalQuery = definitions[5][3];
  journalQuery.entityKey = entity ? String(entity._id) : '__no_matching_transaction__';
  const results = [];
  for (const [name, expectedIndex, collection, filter, sort] of definitions) {
    onStage(`EXPLAIN_${name}`);
    const cursor = collection.find(filter, { projection: { _id: 1 } });
    if (sort) cursor.sort(sort);
    cursor.limit(20);
    const explain = await cursor.explain('executionStats');
    results.push(summarizeExplain(name, expectedIndex, explain));
  }
  const status = results.some(row => row.status === 'INDEX_NOT_USED') ? 'INDEX_NOT_USED'
    : results.some(row => row.status === 'REVIEW_BLOCKING_SORT') ? 'REVIEW_REQUIRED'
      : results.some(row => row.status === 'PASS_WITH_REVIEW') ? 'PASS_WITH_REVIEW' : 'PASS';
  const reviewNotes = results.some(row => row.query === 'PURCHASE_RECEIVED' && row.status === 'PASS_WITH_REVIEW')
    ? ['PURCHASE_RECEIVED_BLOCKING_SORT_MEASURED_LOCALLY; do not force product_ops_mov_events_v1; remeasure in Atlas before any production history rollout.'] : [];
  return { status,
    sku, productId: String(productId), checks: results, reviewNotes };
}

async function runCli({ env = process.env, args = process.argv.slice(2), stdout = console.log,
  clientFactory = options => new MongoClient(options.uri, options.clientOptions) } = {}) {
  let client;
  let stage = 'CONFIG';
  try {
    const config = readConfig(env, args);
    stage = 'CONNECT';
    client = clientFactory({ uri: config.uri, clientOptions: { serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000, maxPoolSize: 2, readPreference: 'primary' } });
    await client.connect();
    const db = client.db(config.database);
    stage = 'CERTIFICATION';
    const result = await certify({ db, businessId: config.businessId, scenarioId: config.scenarioId, sku: config.sku,
      onStage: current => { stage = current; } });
    stage = 'OUTPUT';
    stdout(JSON.stringify({ ...result, database: config.database, writes: 0 }));
    if (['INDEX_NOT_USED', 'REVIEW_REQUIRED'].includes(result.status)) process.exitCode = 1;
    return result;
  } catch (error) {
    const allowed = new Set(['PRODUCT_OP_EXPLAIN_CONFIG_INVALID', 'PRODUCT_OP_EXPLAIN_URI_INVALID',
      'PRODUCT_OP_EXPLAIN_DATABASE_MISMATCH', 'PRODUCT_OP_EXPLAIN_LOCAL_MONGO_REQUIRED',
      'PRODUCT_OP_EXPLAIN_SKU_NOT_FOUND', 'PRODUCT_OP_EXPLAIN_SKU_AMBIGUOUS']);
    const code = allowed.has(error?.code) ? error.code : 'PRODUCT_OP_EXPLAIN_FAILED';
    const exceptionType = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
      ? error.name : 'Error';
    stdout(JSON.stringify({ status: 'FAILED', code, stage, exceptionType, writes: 0 }));
    process.exitCode = 1;
    return { status: 'FAILED', code };
  } finally { if (client) await client.close().catch(() => {}); }
}

if (require.main === module) runCli();

module.exports = { REQUIRED, INDEXES, EXISTING_RECEIPT_INDEX, movementPartial, readConfig,
  collectPlan, summarizeExplain, certify, runCli };
