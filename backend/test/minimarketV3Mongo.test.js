'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson } = require('../../scripts/lib/minimarket-v3-generator');
const {
  auxiliaryStableKey, BUSINESS_ID, SCENARIO_ID, assertLocalMongoUri, buildLocalDockerUri, logicalFileSha256,
  reconcileStock, scenarioFilter, stableIdentity,
  assertAtlasMongoUri, assertImportConnection, assertAtlasRollback, assertV3Write, writeUpserts,
  resetScenario, RESET_MODELS,
} = require('../scripts/lib/minimarketV3Mongo');
const { logicalHash, operationalFieldsMatch } = require('../scripts/lib/minimarketV3Parity');
const { validateAtlasScenario, compareProtectedSnapshots } = require('../scripts/lib/minimarketV3Atlas');
const { parseArgs } = require('../scripts/import-minimarket-v3-atlas');

describe('M6.4 local-only Mongo import and logical parity guards', () => {
  it('accepts only an explicit local Mongo URI and rejects Atlas', () => {
    assert.equal(assertLocalMongoUri('mongodb://u:p@127.0.0.1:27017/inventory_billing?authSource=admin&directConnection=true').hostname, '127.0.0.1');
    assert.throws(() => assertLocalMongoUri('mongodb+srv://u:p@cluster.example/inventory_billing'), /solo se permite Mongo local/);
    assert.throws(() => assertLocalMongoUri('mongodb://localhost:27018/inventory_billing?directConnection=true'), /solo se permite Mongo local/);
  });

  it('converts only the known Docker-local service URI to loopback direct mode', () => {
    const uri = buildLocalDockerUri('mongodb://local-user:local-pass@mongodb:27017/inventory_billing?authSource=admin&replicaSet=rs0');
    const parsed = assertLocalMongoUri(uri);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.equal(parsed.searchParams.get('directConnection'), 'true');
    assert.equal(parsed.searchParams.has('replicaSet'), false);
    assert.throws(() => buildLocalDockerUri('mongodb://u:p@cluster.example/inventory_billing'), /no apunta al Mongo local esperado/);
  });

  it('scopes all reset filters to exactly the approved V3 tenant and scenario', () => {
    assert.deepEqual(scenarioFilter(), { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID });
    assert.equal(SCENARIO_ID.includes('*'), false);
  });

  it('resolves stable identities independently of Mongo ObjectIds', () => {
    assert.deepEqual(stableIdentity('product', { sku: 'BEB-GAS-001' }), { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, sku: 'BEB-GAS-001' });
    assert.equal(stableIdentity('contact', { sourceEventId: 'dataset|supplier|SUP-01|1' }).sourceEventId, 'dataset|supplier|SUP-01|1');
    assert.equal(stableIdentity('transaction', { stableCode: 'V3-SALE-1' }).stableCode, 'V3-SALE-1');
    assert.equal(stableIdentity('movement', { sourceEventId: 'event-2' }).sourceEventId, 'event-2');
    assert.throws(() => stableIdentity('unknown', {}), /no soportada/);
  });

  it('builds unique auxiliary keys from actual canonical price-history fields', () => {
    assert.equal(auxiliaryStableKey('price_history', { sku: 'SKU-1', effectiveFrom: '2026-01-02' }), 'SKU-1|2026-01-02');
    assert.equal(auxiliaryStableKey('supplier_cost_history', { sku: 'SKU-1', supplierCode: 'SUP-01', effectiveFrom: '2026-01-02' }), 'SKU-1|SUP-01|2026-01-02');
  });

  it('reconciles stock from opening balances and movements against the closing snapshot', () => {
    const products = [{ sku: 'SKU-1', endingStock: 6 }, { sku: 'SKU-2', endingStock: 2 }];
    const snapshots = [{ sku: 'SKU-1', onHandUsable: 6 }, { sku: 'SKU-2', onHandUsable: 2 }];
    const movements = [{ sku: 'SKU-1', quantityDelta: 10 }, { sku: 'SKU-1', quantityDelta: -4 }, { sku: 'SKU-2', quantityDelta: 3 }, { sku: 'SKU-2', quantityDelta: -1 }];
    assert.deepEqual(reconcileStock(products, snapshots, movements), []);
    assert.deepEqual(reconcileStock([{ ...products[0], endingStock: 7 }], snapshots, movements), ['SKU-1']);
  });

  it('produces stable logical hashes independent of object insertion order', () => {
    const left = [{ sku: 'B', price: 2 }, { sku: 'A', price: 1 }];
    const right = [{ price: 1, sku: 'A' }, { price: 2, sku: 'B' }];
    assert.equal(logicalHash(left, (row) => row.sku), logicalHash(right, (row) => row.sku));
    assert.equal(canonicalJson(left[0]), canonicalJson({ price: 2, sku: 'B' }));
    assert.equal(logicalFileSha256(left, 'sku'), logicalFileSha256(right, 'sku'));
  });

  it('rejects any tenant-crossing reference projection', () => {
    const refs = [{ ownerBusinessId: BUSINESS_ID, targetBusinessId: BUSINESS_ID }, { ownerBusinessId: BUSINESS_ID, targetBusinessId: 'V1' }];
    assert.equal(refs.filter((row) => row.ownerBusinessId !== row.targetBusinessId).length, 1);
  });

  it('keeps Lima local dates explicit and does not derive them from UTC midnight', () => {
    const at = new Date('2026-10-12T05:00:00.000Z');
    const limaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    assert.equal(limaDate, '2026-10-12');
  });
});

describe('M6.4B controlled Atlas target, writes and recovery', () => {
  const uri = 'mongodb+srv://fixture-user:fixture-pass@cluster0.e2a81nq.mongodb.net/inventory_billing';
  it('accepts only the exact approved Atlas SRV host/database with TLS', () => {
    assert.equal(assertAtlasMongoUri(uri).hostname, 'cluster0.e2a81nq.mongodb.net');
    for (const bad of [uri.replace('cluster0', 'other'), uri.replace('inventory_billing', 'test'), uri.replace('mongodb+srv', 'mongodb'), uri + '?tls=false']) {
      assert.throws(() => assertAtlasMongoUri(bad), /Atlas target/);
    }
  });
  it('checks the actual driver SRV target and preserves the default local-only guard', () => {
    const connection = { name: 'inventory_billing', host: 'shard00.example.mongodb.net', getClient: () => ({ options: { srvHost: 'cluster0.e2a81nq.mongodb.net' } }) };
    assert.doesNotThrow(() => assertImportConnection(connection, { target: 'atlas', atlasUri: uri }));
    assert.throws(() => assertImportConnection(connection), /target explícito/);
    assert.throws(() => assertImportConnection({ ...connection, name: 'test' }, { target: 'atlas', atlasUri: uri }), /base incorrecta/);
    assert.throws(() => assertImportConnection({ ...connection, getClient: () => ({ options: { srvHost: 'other.mongodb.net' } }) }, { target: 'atlas', atlasUri: uri }), /target explícito/);
  });
  it('fails closed on unapproved existing V3, residue, or a different canonical hash', () => {
    assert.doesNotThrow(() => validateAtlasScenario(null, { products: 0 }, 'hash'));
    assert.throws(() => validateAtlasScenario(null, { products: 1 }, 'hash'), /sin marcador/);
    assert.throws(() => validateAtlasScenario({ sourceSha256: 'other' }, {}, 'hash'), /inesperado/);
    assert.throws(() => validateAtlasScenario({ sourceSha256: 'hash', status: 'completed', metadata: { importTarget: 'local' } }, {}, 'hash'), /inesperado/);
    for (const status of ['importing', 'failed', 'completed']) assert.doesNotThrow(() => validateAtlasScenario({ sourceSha256: 'hash', status, metadata: { importTarget: 'atlas' } }, { products: 1 }, 'hash'));
  });
  it('requires explicit mode/scenario and confirmations for apply or rollback', () => {
    const base = ['--atlas', '--scenario-id', SCENARIO_ID];
    assert.equal(parseArgs([...base, '--dry-run']).mode, 'dry-run');
    assert.throws(() => parseArgs([...base, '--apply']), /confirm-v3-import/);
    assert.throws(() => parseArgs([...base, '--rollback']), /confirmación/);
    assert.throws(() => parseArgs([...base, '--dry-run', '--apply']), /único modo/);
    assert.throws(() => parseArgs(['--atlas', '--scenario-id', '*', '--apply']), /exactos/);
    assert.throws(() => parseArgs(['--dry-run']), /exactos/);
  });
  it('rollback scope excludes every tenant except exact V3', () => {
    const args = { atlas: true, confirmed: true, businessId: BUSINESS_ID, scenarioId: SCENARIO_ID };
    assert.deepEqual(assertAtlasRollback(args), scenarioFilter());
    for (const delta of [{ atlas: false }, { confirmed: false }, { businessId: 'ML-CLOUD-DEMO' }, { scenarioId: '*' }]) assert.throws(() => assertAtlasRollback({ ...args, ...delta }), /Rollback requiere/);
  });
  it('the cleanup executor sends exact tenant/scenario filters to all six collections', async (t) => {
    const { HistoricalScenario } = require('../src/models');
    const calls = [];
    for (const model of [...RESET_MODELS, HistoricalScenario]) {
      t.mock.method(model.collection, 'deleteMany', async (filter) => { calls.push({ collection: model.collection.collectionName, filter }); return { deletedCount: 0 }; });
    }
    await resetScenario();
    assert.equal(calls.length, 6);
    for (const call of calls) assert.deepEqual(call.filter, scenarioFilter());
    assert.equal(calls.some((call) => call.collection === 'users' || call.collection === 'telegramconnections'), false);
  });
  it('rejects missing/foreign scope in both write document and filter', () => {
    assert.doesNotThrow(() => assertV3Write(scenarioFilter(), scenarioFilter()));
    assert.throws(() => assertV3Write(scenarioFilter(), {}), /scope V3/);
    assert.throws(() => assertV3Write({ ...scenarioFilter(), businessId: 'V2' }, scenarioFilter()), /scope V3/);
  });
  it('upserts stable keys in batches and makes identical second import a no-op', async () => {
    const store = new Map(); let writes = 0; let batches = 0;
    const keyFor = (row) => stableIdentity('product', row);
    const model = { collection: {
      find: (query) => ({ toArray: async () => query.$or.map((filter) => store.get(canonicalJson(filter))).filter(Boolean) }),
      bulkWrite: async (ops) => { batches += 1; writes += ops.length; for (const op of ops) store.set(canonicalJson(op.updateOne.filter), op.updateOne.update.$set); },
    } };
    const rows = Array.from({ length: 3 }, (_, i) => ({ ...scenarioFilter(), sku: `SKU-${i}`, canonicalData: { sku: `SKU-${i}` } }));
    await writeUpserts(model, rows, keyFor, 2);
    assert.equal(writes, 3); assert.equal(batches, 2);
    await writeUpserts(model, rows, keyFor, 2);
    assert.equal(writes, 3); assert.equal(batches, 2);
    await assert.rejects(() => writeUpserts(model, [{ ...rows[0], businessId: 'V1' }], keyFor), /scope V3/);
  });
  it('detects protected tenant content changes even when counts remain unchanged', () => {
    const before = { protectedTenants: { 'ML-CLOUD-DEMO': { products: { count: 1, sha256: 'same' } }, 'ML-CLOUD-DEMO-V2': {} } };
    const after = JSON.parse(JSON.stringify(before));
    assert.equal(compareProtectedSnapshots(before, after).documentHashesUnchanged, true);
    after.protectedTenants['ML-CLOUD-DEMO'].products.sha256 = 'changed';
    assert.throws(() => compareProtectedSnapshots(before, after), /Snapshot protegido cambió/);
  });
  it('parity accounts for BSON null optionals while rejecting real operational drift', () => {
    const expected = { customerId: undefined, products: [{ unitsSold: undefined, quantity: 2 }], stock: 4 };
    const actual = { customerId: null, products: [{ unitsSold: null, quantity: 2 }], stock: 4, _id: 'technical' };
    assert.equal(operationalFieldsMatch(actual, expected), true);
    assert.equal(operationalFieldsMatch({ ...actual, stock: 3 }, expected), false);
    assert.equal(operationalFieldsMatch(null, expected), false);
  });
});
