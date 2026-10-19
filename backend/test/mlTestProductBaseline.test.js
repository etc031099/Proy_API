'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const config = require('../src/config/v3Operational');
const target = require('../src/services/mlTestTargetAuthorization');
const fence = require('../src/services/mlTestFence');
const Model = require('../src/models/MlTestProductBaseline');
const { COLLECTION, createMlTestProductBaselineService } = require('../src/services/mlTestProductBaselineService');
const scope = { businessId: config.businessId, scenarioId: config.scenarioId };

function fixture() {
  let rows = {
    mltestcontrols: [{ ...scope, state: 'TEST_ACTIVE', resetEpoch: '4', testCycleId: randomUUID(), activeCheckpointId: randomUUID() }],
    mltestcheckpoints: [], v3operationalrevisions: [{ _id: scope.businessId, revision: '173', bootstrapStatus: 'VERIFIED' }],
    forecastmodelregistries: [7, 14].map(horizonDays => ({ ...scope, horizonDays, activeModelVersion: 1, generation: 1 })),
    products: ['A', 'B'].map(sku => ({ ...scope, _id: new mongoose.Types.ObjectId(), sku, name: `Product ${sku}`, stock: 10 })),
    transactions: [], [COLLECTION]: []
  };
  rows.mltestcheckpoints.push({ ...scope, checkpointId: rows.mltestcontrols[0].activeCheckpointId, status: 'READY', dataVersion: '173' });
  const events = [], client = { options: { hosts: [{ host: '127.0.0.1', port: 27017 }], replicaSet: 'rs0' } };
  const env = { ML_TEST_LOCAL_ENABLED: 'true', NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1:27017/ml_baseline_test?replicaSet=rs0',
    MONGODB_REPLICA_SET: 'rs0', ML_TEST_LOCAL_EXPECTED_DATABASE: 'ml_baseline_test' };
  const match = (row, query) => Object.entries(query).every(([key, value]) => value?.$in
    ? value.$in.some(item => String(row[key]) === String(item)) : String(row[key]) === String(value));
  const source = options => options?.session?.rows || rows;
  const db = { client, databaseName: 'ml_baseline_test',
    admin: () => ({ command: async () => ({ setName: 'rs0', isWritablePrimary: true, me: '127.0.0.1:27017', hosts: ['127.0.0.1:27017'] }) }),
    async createCollection(name) { events.push(['ddl', name]); },
    collection(name) { return {
      async findOne(query, options) { return (source(options)[name] || []).find(row => match(row, query)) || null; },
      find(query, options) { return { toArray: async () => (source(options)[name] || []).filter(row => match(row, query)) }; },
      async createIndex(keys, options) { events.push(['index', keys, options]); return options.name; },
      async updateOne(query, update, options) {
        assert(options.session?.inTransaction(), 'baseline writes must share the active business session');
        const values = source(options)[name];
        if (!values.some(row => match(row, query))) values.push(update.$setOnInsert);
        events.push(['baseline', options.session]); return { matchedCount: 1 };
      },
      async deleteMany(query, options) {
        assert(options.session?.inTransaction());
        const data = source(options); data[name] = (data[name] || []).filter(row => !match(row, query));
        events.push(['cleanup', options.session]);
      }
    }; }
  };
  const epochFence = { ...fence,
    async assertCurrent(_db, token) { const current = rows.mltestcontrols[0];
      if (String(current.resetEpoch) !== token.resetEpoch || current.testCycleId !== token.testCycleId) throw Object.assign(new Error('STALE_TEST_EPOCH'), { code: 'STALE_TEST_EPOCH' }); },
    async withEpoch(_db, work, token) { await this.assertCurrent(_db, token); return work(); },
    async guard({ session }) { events.push(['guard', session]); }
  };
  const dashboard = {
    async productInventory(req) { events.push(['inventory', req.params.sku]); return { data: {
      product: { sku: req.params.sku, name: 'Product', presentation: 'Unit' }, mode: 'LIVE',
      freshness: { dataVersion: rows.v3operationalrevisions[0].revision },
      stock: { onHand: rows.products.find(p => p.sku === req.params.sku).stock, incoming: 2, inventoryPosition: 12 },
      coverage: { daysCover: 3, status: 'AVAILABLE' }, risk: { level: 'HIGH', reasonCodes: ['REORDER'] },
      recommendation: { reorderNow: true, recommendedQty: 12, status: 'COMPLETE' } } }; },
    async forecast(req) { events.push(['forecast', req.params.sku, req.query.horizonDays]); return { data: { product: { sku: req.params.sku },
      mode: 'LIVE', status: 'READY', modelFamily: 'RIDGE_REGRESSION', method: 'RIDGE_REGRESSION', activeModelStatus: 'ACTIVE',
      dataVersion: rows.v3operationalrevisions[0].revision,
      horizonDays: req.query.horizonDays, modelVersion: 1, trainedDataVersion: '83', forecastPeriod: { units: req.query.horizonDays === 7 ? 4.99 : 10.43 } } }; }
  };
  const service = createMlTestProductBaselineService({ db, client, env, epochFence, dashboardFactory: () => dashboard });
  const sale = (...indices) => ({ businessId: scope.businessId, input: { type: 'sale',
    products: indices.map(index => ({ productId: rows.products[index]._id, quantity: 1 })) } });
  const session = () => ({ rows: Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values.map(row => ({ ...row }))])), inTransaction: () => true });
  const commit = tx => { rows = tx.rows; };
  return { service, env, db, client, rows: () => rows, events, dashboard, epochFence, sale, session, commit };
}

test('dedicated model has local auxiliary collection and unique scoped epoch/SKU index, excluded from snapshot', () => {
  assert.equal(Model.schema.options.autoCreate, false); assert.equal(Model.schema.options.autoIndex, false);
  const [[keys, options]] = Model.schema.indexes();
  assert.deepEqual(Object.keys(keys), ['businessId', 'scenarioId', 'checkpointId', 'testCycleId', 'resetEpoch', 'sku']);
  assert.equal(options.unique, true);
  assert(!require('../src/services/mlTestCheckpointManifest').COLLECTIONS.some(row => row.collection === COLLECTION));
});

test('disabled/production/cloud/foreign/wrong local targets are inert without forecasts, DDL or baseline documents', async () => {
  for (const mode of ['disabled', 'production', 'cloud', 'foreign', 'wrong-database', 'wrong-replica', 'not-primary']) {
    const f = fixture();
    if (mode === 'disabled') f.env.ML_TEST_LOCAL_ENABLED = 'false';
    if (mode === 'production') f.env.NODE_ENV = 'production';
    if (mode === 'cloud') { f.env.MONGODB_URI = 'mongodb+srv://example.mongodb.net/ml_baseline_test'; f.client.options.srvHost = 'example.mongodb.net'; }
    if (mode === 'wrong-database') f.env.ML_TEST_LOCAL_EXPECTED_DATABASE = 'wrong_test';
    if (mode === 'wrong-replica') f.env.MONGODB_REPLICA_SET = 'other';
    if (mode === 'not-primary') f.db.admin = () => ({ command: async () => ({ setName: 'rs0', isWritablePrimary: false }) });
    const input = f.sale(0); if (mode === 'foreign') input.businessId = 'foreign';
    assert.equal(await f.service.prepareSale(input), null); assert.deepEqual(f.events, []);
    assert.equal(f.rows()[COLLECTION].length, 0);
  }
});

test('NO_TEST and missing/non-READY checkpoint skip analytical capture', async () => {
  for (const mode of ['inactive', 'missing', 'creating']) {
    const f = fixture();
    if (mode === 'inactive') f.rows().mltestcontrols[0].state = 'NO_TEST';
    if (mode === 'missing') f.rows().mltestcheckpoints = [];
    if (mode === 'creating') f.rows().mltestcheckpoints[0].status = 'CREATING';
    assert.equal(await f.service.prepareSale(f.sale(0)), null); assert.deepEqual(f.events, []);
  }
});

test('explicit local checkpoint provisioning creates only auxiliary indexes, never analytical documents or scoring', async () => {
  const f = fixture(); f.rows().mltestcontrols[0].state = 'NO_TEST';
  assert.equal(await f.service.provision(), true);
  assert.deepEqual(f.events.map(event => event[0]), ['ddl', 'index']);
  assert.equal(f.rows()[COLLECTION].length, 0);
  f.events.length = 0; f.env.ML_TEST_LOCAL_ENABLED = 'false';
  assert.equal(await f.service.provision(), false); assert.deepEqual(f.events, []);
});

test('first sale captures exact preoperation stock, live Ridge 7/14 and authoritative inventory metrics atomically', async () => {
  const f = fixture(), plan = await f.service.prepareSale(f.sale(0));
  assert.equal(f.rows()[COLLECTION].length, 0, 'prepare never persists a final baseline');
  const tx = f.session(); await f.service.persist({ plan, session: tx });
  tx.rows.products[0].stock--; tx.rows.v3operationalrevisions[0].revision = '174'; f.commit(tx);
  const row = f.rows()[COLLECTION][0];
  assert.equal(row.stock.onHand, 10); assert.equal(f.rows().products[0].stock, 9);
  assert.equal(row.forecast7.units, 4.99); assert.equal(row.forecast14.units, 10.43);
  assert.equal(row.coverage.daysCover, 3); assert.equal(row.risk.level, 'HIGH');
  assert.equal(row.recommendation.recommendedQty, 12);
  assert.equal(row.capturedRevision, '173'); assert.equal(row.baselineRevision, '173');
  assert.equal(row.resetEpoch, '4'); assert.equal(row.trigger, 'SALE_COMPLETED');
  assert(f.events.findIndex(e => e[0] === 'guard') < f.events.findIndex(e => e[0] === 'baseline'));
  assert.deepEqual(f.events.filter(e => e[0] === 'forecast').map(e => e[2]), [7, 14]);
});

test('later sales preserve the first baseline and do not rescore; two new SKUs capture two rows', async () => {
  const f = fixture(); const plan = await f.service.prepareSale(f.sale(0, 1)); const tx = f.session();
  await f.service.persist({ plan, session: tx }); f.commit(tx);
  assert.equal(f.rows()[COLLECTION].length, 2);
  const original = f.rows()[COLLECTION][0], reads = f.events.length;
  assert.equal(await f.service.prepareSale(f.sale(0)), null); assert.equal(f.events.length, reads);
  assert.equal(f.rows()[COLLECTION][0], original);
});

test('aborting a failed business transaction rolls back the staged baseline', async () => {
  const f = fixture(), plan = await f.service.prepareSale(f.sale(0)), tx = f.session();
  await f.service.persist({ plan, session: tx });
  assert.equal(tx.rows[COLLECTION].length, 1); // simulated subsequent business validation/commit failure: no commit
  assert.equal(f.rows()[COLLECTION].length, 0);
  await assert.rejects(f.service.persist({ plan, session: {} }), { code: 'ML_TEST_BASELINE_TRANSACTION_REQUIRED' });
});

test('concurrent prepared sales keep one first-commit baseline through the shared guard and unique key', async () => {
  const f = fixture(); const [first, second] = await Promise.all([f.service.prepareSale(f.sale(0)), f.service.prepareSale(f.sale(0))]);
  // Transactions serialize on the same mltestcontrols guard write in Mongo.
  const t1 = f.session(); await f.service.persist({ plan: first, session: t1 });
  t1.rows.products[0].stock = 9; t1.rows.v3operationalrevisions[0].revision = '174'; f.commit(t1);
  const t2 = f.session(); await f.service.persist({ plan: second, session: t2 });
  t2.rows.products[0].stock = 8; f.commit(t2);
  assert.equal(f.rows()[COLLECTION].length, 1); assert.equal(f.rows()[COLLECTION][0].stock.onHand, 10);
});

test('revision/stock/ACTIVE pointer drift is rejected rather than persisted as a false BEFORE', async () => {
  for (const mode of ['revision', 'stock', 'model']) {
    const f = fixture(), plan = await f.service.prepareSale(f.sale(0));
    if (mode === 'revision') f.rows().v3operationalrevisions[0].revision = '174';
    if (mode === 'stock') f.rows().products[0].stock = 9;
    if (mode === 'model') f.rows().forecastmodelregistries[0].generation++;
    await assert.rejects(f.service.persist({ plan, session: f.session() }), { code: 'ML_TEST_BASELINE_SOURCE_CHANGED' });
    assert.equal(f.rows()[COLLECTION].length, 0);
  }
});

test('epoch change between prepare and business transaction aborts with STALE_TEST_EPOCH', async () => {
  const f = fixture(), plan = await f.service.prepareSale(f.sale(0)); f.rows().mltestcontrols[0].resetEpoch = '5';
  await assert.rejects(f.service.persist({ plan, session: f.session() }), { code: 'STALE_TEST_EPOCH' });
  assert.equal(f.rows()[COLLECTION].length, 0);
});

test('persist rechecks local target and READY checkpoint instead of trusting a formerly valid plan', async () => {
  for (const mode of ['disabled', 'atlas', 'checkpoint']) {
    const f = fixture(), plan = await f.service.prepareSale(f.sale(0));
    if (mode === 'disabled') f.env.ML_TEST_LOCAL_ENABLED = 'false';
    if (mode === 'atlas') f.client.options.srvHost = 'fixture.mongodb.net';
    if (mode === 'checkpoint') f.rows().mltestcheckpoints[0].status = 'FAILED';
    await assert.rejects(f.service.persist({ plan, session: f.session() }),
      { code: mode === 'checkpoint' ? 'ML_TEST_BASELINE_CHECKPOINT_INVALID' : 'ML_TEST_BASELINE_LOCAL_TARGET_REQUIRED' });
    assert.equal(f.rows()[COLLECTION].length, 0);
  }
});

test('analytical response lineage and changes during capture fail explicitly', async () => {
  for (const mode of ['stale-forecast', 'stale-inventory', 'revision-race']) {
    const f = fixture(), forecast = f.dashboard.forecast, inventory = f.dashboard.productInventory;
    if (mode === 'stale-inventory') f.dashboard.productInventory = async req => {
      const result = await inventory(req); result.data.freshness.dataVersion = '172'; return result;
    };
    else f.dashboard.forecast = async req => {
      const result = await forecast(req);
      if (mode === 'stale-forecast') result.data.dataVersion = '172';
      else if (req.query.horizonDays === 14) f.rows().v3operationalrevisions[0].revision = '174';
      return result;
    };
    await assert.rejects(f.service.prepareSale(f.sale(0)), { code: mode === 'stale-inventory'
      ? 'ML_TEST_BASELINE_INVENTORY_UNVERIFIED' : mode === 'stale-forecast'
        ? 'ML_TEST_BASELINE_FORECAST_UNVERIFIED' : 'ML_TEST_BASELINE_SOURCE_CHANGED' });
    assert.equal(f.rows()[COLLECTION].length, 0);
  }
});

test('an aborted concurrent contender cannot displace the first successful transaction baseline', async () => {
  const f = fixture(); const [aborted, winner] = await Promise.all([f.service.prepareSale(f.sale(0)), f.service.prepareSale(f.sale(0))]);
  await f.service.persist({ plan: aborted, session: f.session() }); // business abort: never publish this session
  assert.equal(f.rows()[COLLECTION].length, 0);
  const tx = f.session(); await f.service.persist({ plan: winner, session: tx }); f.commit(tx);
  assert.equal(f.rows()[COLLECTION].length, 1); assert.equal(f.rows()[COLLECTION][0].stock.onHand, 10);
});

test('first contact with a later SKU records its actual preoperation revision separately from checkpoint revision', async () => {
  const f = fixture(); let tx = f.session(); await f.service.persist({ plan: await f.service.prepareSale(f.sale(0)), session: tx });
  tx.rows.v3operationalrevisions[0].revision = '174'; tx.rows.products[0].stock = 9; f.commit(tx);
  const plan = await f.service.prepareSale(f.sale(1)); tx = f.session(); await f.service.persist({ plan, session: tx }); f.commit(tx);
  const row = f.rows()[COLLECTION].find(item => item.sku === 'B');
  assert.equal(row.baselineRevision, '173'); assert.equal(row.capturedRevision, '174');
  assert.equal(row.forecast7.dataVersion, '174'); assert.equal(row.stock.onHand, 10);
});

test('purchase, preview and historical import never trigger capture', async () => {
  const f = fixture(); const sale = f.sale(0);
  assert.equal(await f.service.prepareSale({ ...sale, input: { ...sale.input, type: 'purchase' } }), null);
  assert.equal(await f.service.prepareSale({ ...sale, preview: true }), null);
  assert.equal(await f.service.prepareSale({ ...sale, historical: {} }), null);
  assert.deepEqual(f.events, []);
});

test('first cancellation captures current pre-cancel state even for an older sale; subsequent cancellation never replaces', async () => {
  const f = fixture(), id = new mongoose.Types.ObjectId();
  f.rows().transactions.push({ _id: id, businessId: scope.businessId, type: 'sale', status: 'completed',
    products: [{ productId: f.rows().products[0]._id }] });
  const plan = await f.service.prepareCancellation({ businessId: scope.businessId, transactionId: id });
  const tx = f.session(); await f.service.persist({ plan, session: tx }); f.commit(tx);
  assert.equal(f.rows()[COLLECTION][0].trigger, 'SALE_CANCELLED'); assert.equal(f.rows()[COLLECTION][0].stock.onHand, 10);
  assert.equal(await f.service.prepareCancellation({ businessId: scope.businessId, transactionId: id }), null);
  f.rows().transactions[0].type = 'purchase'; assert.equal(await f.service.prepareCancellation({ businessId: scope.businessId, transactionId: id }), null);
});

test('restore continue removes auxiliary epochs atomically and the next sale creates a fresh epoch baseline; finish clears cycle', async () => {
  const f = fixture(); let tx = f.session(); await f.service.persist({ plan: await f.service.prepareSale(f.sale(0)), session: tx }); f.commit(tx);
  const control = f.rows().mltestcontrols[0], cycle = { checkpointId: control.activeCheckpointId, testCycleId: control.testCycleId };
  tx = f.session(); tx.rows.mltestcontrols[0].state = 'RESTORING'; await f.service.clearCycle({ ...cycle, session: tx });
  tx.rows.mltestcontrols[0].resetEpoch = '5'; tx.rows.mltestcontrols[0].state = 'TEST_ACTIVE'; f.commit(tx);
  assert.equal(f.rows()[COLLECTION].length, 0);
  tx = f.session(); await f.service.persist({ plan: await f.service.prepareSale(f.sale(0)), session: tx }); f.commit(tx);
  assert.equal(f.rows()[COLLECTION][0].resetEpoch, '5');
  tx = f.session(); tx.rows.mltestcontrols[0].state = 'RESTORING'; await f.service.clearCycle({ ...cycle, session: tx });
  tx.rows.mltestcontrols[0].state = 'NO_TEST'; f.commit(tx);
  assert.equal(f.rows()[COLLECTION].length, 0);
});

test('cleanup requires RESTORING ownership and aborting that transition preserves metadata', async () => {
  const f = fixture(); let tx = f.session(); await f.service.persist({ plan: await f.service.prepareSale(f.sale(0)), session: tx }); f.commit(tx);
  const control = f.rows().mltestcontrols[0], cycle = { checkpointId: control.activeCheckpointId, testCycleId: control.testCycleId };
  await assert.rejects(f.service.clearCycle({ ...cycle, session: f.session() }), { code: 'ML_TEST_BASELINE_CLEANUP_STATE_INVALID' });
  tx = f.session(); tx.rows.mltestcontrols[0].state = 'RESTORING'; await f.service.clearCycle({ ...cycle, session: tx });
  assert.equal(tx.rows[COLLECTION].length, 0); assert.equal(f.rows()[COLLECTION].length, 1, 'uncommitted cleanup remains rollbackable');
});

test('new cycle/checkpoint never reuses an older baseline', async () => {
  const f = fixture(); let tx = f.session(); await f.service.persist({ plan: await f.service.prepareSale(f.sale(0)), session: tx }); f.commit(tx);
  f.rows().mltestcontrols[0].testCycleId = randomUUID(); f.rows().mltestcontrols[0].activeCheckpointId = randomUUID();
  f.rows().mltestcheckpoints[0].checkpointId = f.rows().mltestcontrols[0].activeCheckpointId;
  tx = f.session(); await f.service.persist({ plan: await f.service.prepareSale(f.sale(0)), session: tx }); f.commit(tx);
  assert.equal(f.rows()[COLLECTION].length, 2);
});

test('genuine unavailable status is preserved but statistical fallback and transport errors are rejected', async () => {
  for (const mode of ['unavailable', 'ma28', 'error']) {
    const f = fixture(); f.dashboard.forecast = async req => mode === 'error' ? { error: { code: 'ML_SERVICE_UNAVAILABLE' } }
      : { data: { product: { sku: req.params.sku }, mode: 'LIVE', horizonDays: req.query.horizonDays,
        dataVersion: '173',
        status: 'MODEL_UNAVAILABLE', reasonCode: 'ACTIVE_MODEL_NOT_FOUND',
        method: mode === 'ma28' ? 'MOVING_AVERAGE_28' : null, modelFamily: null, forecastPeriod: null } };
    if (mode !== 'unavailable') await assert.rejects(f.service.prepareSale(f.sale(0)), { code: 'ML_TEST_BASELINE_FORECAST_UNVERIFIED' });
    else { const plan = await f.service.prepareSale(f.sale(0));
      assert.equal(plan.captured[0].forecast7.status, 'MODEL_UNAVAILABLE'); assert.equal(plan.captured[0].forecast7.units, null); }
  }
});
