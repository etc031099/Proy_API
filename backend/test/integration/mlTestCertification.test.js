'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MongoClient, BSON } = require('mongoose').mongo;
const S = require('../../src/services/mlTestCheckpointService');
const M = require('../../src/services/mlTestCheckpointManifest');
const config = require('../../src/config/v3Operational');
const scope = M.authorizedScope();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function child(uri, input) {
  const process = fork(path.join(__dirname, 'helpers/mlRestoreProcess.js'), [], {
    env: { ...global.process.env, MONGODB_TEST_URI: uri }, silent: true, windowsHide: true });
  process.stdout.resume(); process.stderr.resume();
  const queue = [], waiters = [];
  process.on('message', message => { const waiter = waiters.shift(); if (waiter) waiter(message); else queue.push(message); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LOCAL_CHILD_TIMEOUT')), 300000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  const exited = new Promise(resolve => process.once('exit', (code, signal) => resolve({ code, signal })));
  process.send(input);
  return { process, next, exited, async result() { const message = await next(); assert.equal(message.type, 'RESULT', JSON.stringify(message)); await exited; return message; },
    async kill() { process.kill('SIGKILL'); return exited; } };
}
async function fixture(work, large = false) {
  const uri = new URL(process.env.MONGODB_TEST_URI);
  uri.pathname = `/ml_checkpoint_${randomUUID().replaceAll('-', '')}_test`;
  const client = await new MongoClient(uri.href, { serverSelectionTimeoutMS: 4000 }).connect();
  const db = client.db();
  try {
    S.assertLocalTarget(client, db); await S.provisionLocal(client, db);
    for (const { collection } of M.COLLECTIONS) await db.createCollection(collection);
    await db.collection('historicalscenarios').insertOne({ ...scope, status: 'completed', sourceSha256: config.sourceSha256,
      metadata: { datasetVersion: config.datasetVersion, referenceDate: config.historicalCutoff, timezone: config.timezone } });
    await db.collection('v3operationalrevisions').insertOne({ _id: scope.businessId, revision: BSON.Long.fromNumber(173),
      bootstrapStatus: 'VERIFIED', historicalDatasetVersion: config.datasetVersion, historicalDatasetSha256: config.sourceSha256 });
    await db.collection('products').insertOne({ businessId: scope.businessId, sku: 'SYNTHETIC', name: 'Synthetic product',
      stock: 50, price: 2, costPrice: 1, currency: 'USD', category: 'Local', isActive: true });
    for (const collection of ['forecastmlupdatestates', 'forecastmlupdateexecutions', 'forecastmodelartifacts', 'forecastmodelregistries']) {
      await db.collection(collection).insertOne({ ...scope, horizonDays: 7, status: 'ACTIVE', stage: 'FINISHED',
        modelVersion: 1, artifactBytes: 1, artifactData: new BSON.Binary(Buffer.from('x')), generation: 1, activeModelVersion: 1 });
    }
    if (large) {
      // Exact total BSON bytes and document count, no personal/cloud data.
      let bytes = 0, count = 0;
      for (const { collection } of M.COLLECTIONS) for await (const raw of db.collection(collection).find({}, { raw: true })) { bytes += raw.length; count++; }
      const total = 56675, targetBytes = 101050857, n = total - count;
      const base = { _id: new BSON.ObjectId(), businessId: scope.businessId, synthetic: true, padding: '' };
      const overhead = BSON.calculateObjectSize(base), remaining = targetBytes - bytes - n * overhead;
      assert(remaining > 0);
      const destinations = ['transactions', 'inventorymovements', 'creditpayments', 'v3operationalchanges',
        'inventoryalerts', 'inventoryalertoutboxevents', 'inventoryalertchanneldeliveries', 'stockalertrules'];
      let batch = [], destination = 0;
      for (let i = 0; i < n; i++) {
        const nextDestination = Math.min(7, Math.floor(i * 8 / n));
        if (nextDestination !== destination && batch.length) {
          await db.collection(destinations[destination]).insertMany(batch); batch = [];
        }
        destination = nextDestination;
        const paddingBytes = Math.floor(remaining / n) + (i < remaining % n ? 1 : 0);
        batch.push({ ...base, _id: new BSON.ObjectId(), padding: 'x'.repeat(paddingBytes) });
        if (batch.length === 500 || i === n - 1) { await db.collection(destinations[destination]).insertMany(batch); batch = []; }
      }
    }
    await work({ uri: uri.href, client, db });
  } finally { S.assertLocalTarget(client, db); await db.dropDatabase(); await client.close(); }
}
test('A.3.7.9.5 real processes: abrupt death, fencing and synthetic cloud volume', { timeout: 600000 }, async t => {
  const scenario = (name, work) => t.test(name, { skip: Boolean(process.env.ML_TEST_CERTIFICATION_FILTER)
    && !name.includes(process.env.ML_TEST_CERTIFICATION_FILTER) }, work);
  await scenario('abrupt capture death never marks partial checkpoint READY or reopens control', () => fixture(async ({ uri, db }) => {
    const p = child(uri, { action: 'capture', killAt: 'CAPTURE' });
    assert.equal((await p.next()).stage, 'CAPTURE_CHUNK_PERSISTED'); await p.kill();
    const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId });
    assert.equal(control.state, 'CHECKPOINT_CREATING'); assert.equal(String(control.resetEpoch), '1');
    assert.equal(await db.collection('mltestcheckpoints').countDocuments({ status: 'READY' }), 0);
    await delay(100); assert.equal((await db.collection('mltestcontrols').findOne({})).state, 'CHECKPOINT_CREATING');
  }));
  for (const killAt of ['RESTORE', 'VERIFY']) await scenario(`abrupt ${killAt} death: explicit same-id resume after lease, no epoch rollback`, () => fixture(async ({ uri, db }) => {
    const captured = await child(uri, { action: 'capture' }).result();
    const checkpointId = captured.result.checkpointId, restoreId = randomUUID();
    const p = child(uri, { action: 'restore', checkpointId, restoreId, killAt });
    assert.equal((await p.next()).type, 'PAUSED'); await p.kill();
    const stopped = await db.collection('mltestcontrols').findOne({});
    assert.equal(stopped.state, 'RESTORING'); assert.equal(String(stopped.resetEpoch), '2');
    const premature = child(uri, { action: 'restore', checkpointId, restoreId });
    assert.equal((await premature.next()).code, 'RESTORE_CONTROL_BUSY'); await premature.exited;
    const remaining = Math.max(0, stopped.restoreLeaseUntil.getTime() - Date.now() + 30);
    // Genuine lease expiry, no fixture edits to epoch/lease or recovery state.
    while (Date.now() < stopped.restoreLeaseUntil.getTime() + 30) await delay(Math.min(1000, remaining));
    const resumed = await child(uri, { action: 'restore', checkpointId, restoreId }).result();
    assert.equal(resumed.result.status, 'TEST_ACTIVE'); assert.equal(resumed.result.resetEpoch, '2');
    assert.equal((await child(uri, { action: 'restore', checkpointId, restoreId }).result()).result.idempotent, true);
  }));
  await scenario('independent old process cannot sell/ACK/finish/persist/promote after another process restores', () => fixture(async ({ uri, db }) => {
    const captured = await child(uri, { action: 'capture' }).result();
    const old = child(uri, { action: 'stale-writer' }); assert.equal((await old.next()).type, 'TOKEN');
    await child(uri, { action: 'restore', checkpointId: captured.result.checkpointId, restoreId: randomUUID() }).result();
    old.process.send({ continue: true }); const attempt = await old.result();
    for (const name of ['sale', 'ack', 'executionFinish', 'artifactPersist', 'registryPromotion']) assert.equal(attempt.result[name], 'STALE_TEST_EPOCH', name);
    assert.equal(attempt.result.externalAllowed, false);
    assert.equal((await db.collection('products').findOne({})).stock, 50);
    const delayed = await child(uri, { action: 'delayed-dispatch' }).result();
    assert.equal(delayed.result.code, 'TEST_CLOUD_WORKER_DISABLED'); assert.equal(delayed.result.pythonCalls, 0);
    assert.equal(await db.collection('forecastmlupdateexecutions').countDocuments({}), 1);
  }));
  await scenario('56,675 documents / 101,050,857 BSON bytes: bounded capture, persisted chunks and exact restore', () => fixture(async ({ uri, db }) => {
    const captured = await child(uri, { action: 'capture' }).result();
    assert.equal(captured.result.totalDocuments, 56675); assert.equal(captured.result.totalBytes, 101050857);
    const sizes = await db.collection('mltestcheckpointchunks').aggregate([{ $group: { _id: null,
      bytes: { $sum: '$byteCount' }, largest: { $max: '$byteCount' }, count: { $sum: 1 } } }]).next();
    assert.equal(sizes.bytes, 101050857); assert(sizes.largest <= M.TARGET_BYTES); assert(sizes.count >= 38 && sizes.count <= 42);
    await db.collection('products').updateOne({}, { $set: { stock: 47 } });
    const restored = await child(uri, { action: 'restore', checkpointId: captured.result.checkpointId, restoreId: randomUUID() }).result();
    assert.equal(restored.result.totalDocuments, 56675); assert.equal((await db.collection('products').findOne({})).stock, 50);
    assert(captured.peakRssBytes < 512 * 1024 * 1024); assert(restored.peakRssBytes < 512 * 1024 * 1024);
    console.log('CERTIFICATION_VOLUME', JSON.stringify({ documents: 56675, bsonBytes: sizes.bytes,
      persistedChunks: sizes.count, largestChunkBytes: sizes.largest, captureMs: captured.elapsedMs,
      restoreIncludingVerificationMs: restored.elapsedMs, capturePeakRssBytes: captured.peakRssBytes,
      finalVerificationMs: restored.verificationMs,
      restorePeakRssBytes: restored.peakRssBytes }));
  }, true));
  await scenario('delivery claimed before epoch change cannot send or ACK afterwards', () => fixture(async ({ uri, db }) => {
    await db.collection('mltestcontrols').insertOne({ businessId: scope.businessId, state: 'NO_TEST',
      resetEpoch: BSON.Long.ZERO, activeCheckpointId: null, testCycleId: null });
    const delivery = child(uri, { action: 'external-race' }); assert.equal((await delivery.next()).type, 'CLAIMED');
    const captured = await child(uri, { action: 'capture' }).result();
    await child(uri, { action: 'restore', checkpointId: captured.result.checkpointId, restoreId: randomUUID() }).result();
    delivery.process.send({ continue: true }); const result = await delivery.result();
    assert.equal(result.result.sends, 0); assert.equal(result.result.acks, 0); assert.equal(result.result.summary.suppressed, true);
  }));
});
