'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');
const models = require('../src/models');
const { config, buildV3OperationalSnapshot } = require('../src/services/v3OperationalSnapshotService');

const ROOT = path.resolve(__dirname, '../..');
const NOW = new Date('2026-10-15T21:00:00Z');
const SALE_ID = '000000000000000000000002';
function query(value) {
  const q = { then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  for (const name of ['select', 'session', 'lean', 'maxTimeMS', 'setOptions', 'readConcern', 'sort', 'limit', 'option']) q[name] = () => q;
  return q;
}
async function snapshot(t, cancelled) {
  let active = false;
  t.mock.method(mongoose, 'startSession', async () => ({
    startTransaction: () => { active = true; }, inTransaction: () => active,
    commitTransaction: async () => { active = false; }, abortTransaction: async () => { active = false; }, endSession: async () => {},
  }));
  t.mock.method(models.HistoricalScenario, 'findOne', () => query({ sourceSha256: config.sourceSha256,
    metadata: { datasetVersion: config.datasetVersion, referenceDate: config.historicalCutoff, timezone: config.timezone } }));
  t.mock.method(models.V3OperationalRevision, 'findById', () => query({ revision: cancelled ? 2n : 1n,
    bootstrapStatus: 'VERIFIED', historicalDatasetVersion: config.datasetVersion, historicalDatasetSha256: config.sourceSha256 }));
  const sale = { businessId: config.businessId, scenarioId: config.scenarioId, revision: 1n, eventOrdinal: 0,
    eventKey: '1:0:sale:live-sale:CREATE', effectiveAtUtc: new Date('2026-10-14T15:00:00Z'),
    entityType: 'sale', entityKey: SALE_ID, operation: 'CREATE', projection: {
      saleKey: SALE_ID, occurredAtUtc: '2026-10-14T15:00:00.000Z', localDate: '2026-10-14', customerKey: null,
      currency: 'PEN', totalCents: 250, initialStatus: 'completed', lines: [{ lineKey: `${SALE_ID}:0`, productKey: 'base.P1',
        sku: 'P1', quantity: 1, unitPriceCents: 250, lineTotalCents: 250, unitCostAtSaleCents: null,
        costBasis: 'UNKNOWN', costKnown: false, promo: false }] } };
  const cancel = { ...sale, revision: 2n, eventKey: '2:0:transaction:live-sale:CANCEL',
    effectiveAtUtc: new Date('2026-10-15T16:59:00Z'), entityType: 'transaction', operation: 'CANCEL',
    projection: { contractVersion: 2, transactionKey: SALE_ID, transactionOrigin: 'LIVE', type: 'sale',
      kind: 'CANCEL', affectedStableLineKeys: [`${SALE_ID}:0`] } };
  t.mock.method(models.V3OperationalChange, 'find', filter => query(filter.effectiveAtUtc.$gt ? [] : cancelled ? [sale, cancel] : [sale]));
  t.mock.method(models.Transaction, 'find', () => query([{ _id: SALE_ID, businessId: config.businessId,
    scenarioId: null, type: 'sale', products: [{ stableLineKey: `${SALE_ID}:0` }] }]));
  t.mock.method(models.Product, 'find', () => query([{ _id: 'product-one', productKey: 'base.P1', sku: 'P1',
    stock: 10, createdAt: new Date('2026-10-01T00:00:00Z') }]));
  t.mock.method(models.InventoryMovement, 'aggregate', () => query([{ _id: 'product-one', onHand: 10,
    movementCount: 1, operationalMovementCount: 0, lastOperationalOccurredAt: null }]));
  return (await buildV3OperationalSnapshot({ businessId: config.businessId, asOfDate: '2026-10-15', now: NOW })).snapshot;
}

const pythonCheck = String.raw`
import json,sys
from pathlib import Path
sys.path.append(str(Path('ml/.venv/Lib/site-packages').resolve()))
from ml.service.v3_schemas import V3OperationalSnapshot
from ml.service.v3_live_context import validate_snapshot,snapshot_hash
raw=json.load(sys.stdin)
s=V3OperationalSnapshot.model_validate(raw)
assert snapshot_hash(s)==s.metadata.snapshotHash, 'Python parse changed the backend hash'
validate_snapshot(s,base_records={'products':[{'productKey':'base.P1','sku':'P1','name':'Producto base'}],
 'customers':[],'suppliers':[],'sales':[],'purchases':[],'saleItems':[],'purchaseLines':[]},
 request_business_id=s.metadata.businessId,request_scenario_id=s.metadata.scenarioId,
 request_dataset_version=s.metadata.historicalDatasetVersion,request_dataset_sha256=s.metadata.historicalDatasetSha256,
 request_timezone=s.metadata.timezone,request_as_of_date=s.metadata.asOfDate,
 request_body_bytes=len(json.dumps(raw,ensure_ascii=False,separators=(',',':')).encode('utf-8')))
print('strict schema + hash + bytes + context PASS')
`;

for (const cancelled of [false, true]) {
  test(`L.2 real builder -> Python strict wire parity (${cancelled ? 'v2 cancellation' : 'v1'})`, async t => {
    const raw = await snapshot(t, cancelled);
    assert.equal(raw.metadata.contractVersion, cancelled ? '2' : '1');
    assert.equal(Object.hasOwn(raw.metadata, 'receiptEvents'), false);
    assert.equal(Object.hasOwn(raw.metadata, 'cancellationEvents'), false);
    assert.equal(raw.metadata.payloadBytes, Buffer.byteLength(JSON.stringify(raw)));
    assert.equal(raw.metadata.dataVersion, cancelled ? '2' : '1');
    assert.equal(raw.closedSalesDays.reduce((n, row) => n + row.unitsSold, 0), cancelled ? 0 : 1);
    if (cancelled) {
      assert.deepEqual(raw.transactionChanges[0].lineChanges, [{ lineKey: `${SALE_ID}:0`, receivedQty: null,
        productKey: null, sku: null, orderedQty: null, purchaseUnitCostCents: null, costBasis: null, currency: null }]);
      assert.equal(raw.transactionChanges[0].receiptKey, null);
      assert.equal(raw.transactionChanges[0].supplierKey, null);
    }
    const child = spawnSync(process.env.PYTHON || 'python', ['-c', pythonCheck], {
      cwd: ROOT, input: JSON.stringify(raw), encoding: 'utf8', timeout: 30000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.match(child.stdout, /context PASS/);
  });
}
