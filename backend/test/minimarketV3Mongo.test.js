'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson } = require('../../scripts/lib/minimarket-v3-generator');
const {
  auxiliaryStableKey, BUSINESS_ID, SCENARIO_ID, assertLocalMongoUri, buildLocalDockerUri, logicalFileSha256,
  reconcileStock, scenarioFilter, stableIdentity,
} = require('../scripts/lib/minimarketV3Mongo');
const { logicalHash } = require('../scripts/lib/minimarketV3Parity');

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
