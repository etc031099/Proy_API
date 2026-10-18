'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');
const { BSON } = mongoose.mongo;
const S = require('../../src/services/mlTestCheckpointService');
const R = require('../../src/services/mlTestRestoreService');
const F = require('../../src/services/mlTestFence');
const M = require('../../src/services/mlTestCheckpointManifest');
const A = require('../../src/services/mlTestAdminExecutor');
const config = require('../../src/config/v3Operational');
const models = require('../../src/models');
const scope = M.authorizedScope();
const user = { _id: new BSON.ObjectId(), role: 'admin', isActive: true, businessId: scope.businessId };
const children = new Set();
function processProbe(input) {
  const child = fork(path.join(__dirname, 'helpers/mlRestoreProcess.js'), [], { env: process.env,
    silent: true, windowsHide: true });
  child.stdout.resume(); child.stderr.resume();
  children.add(child); child.once('exit', () => children.delete(child));
  const queued = [], waiting = [];
  child.on('message', value => { const resolve = waiting.shift(); if (resolve) resolve(value); else queued.push(value); });
  const next = () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiting.push(resolve));
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.send(input);
  return { child, next, async result() { const message = await next(); await exited;
    assert.equal(message.type, 'RESULT', JSON.stringify(message)); return message.result; } };
}
test('9.5B admin lifecycle and durable stale-vs-fresh work after NO_TEST (local replica set)', { timeout: 90000 }, async t => {
  let db, client;
  try {
    await mongoose.connect(process.env.MONGODB_TEST_URI, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 4000 });
    db = mongoose.connection.db; client = mongoose.connection.getClient(); S.assertLocalTarget(client, db);
    await S.provisionLocal(client, db);
    for (const { collection } of M.COLLECTIONS) await db.createCollection(collection);
    for (const name of ['V3OperationalRevision', 'V3OperationalChange', 'ForecastMlUpdateState', 'ForecastMlUpdateEvent',
      'ForecastModelArtifact', 'ForecastModelRegistry', 'ForecastTrainingJob', 'ForecastMlUpdateExecution']) {
      for (const [key, options] of models[name].schema.indexes()) await db.collection(models[name].collection.name).createIndex(key, options);
    }
    await db.collection('historicalscenarios').insertOne({ ...scope, status: 'completed', sourceSha256: config.sourceSha256,
      metadata: { datasetVersion: config.datasetVersion, referenceDate: config.historicalCutoff, timezone: config.timezone } });
    await db.collection('v3operationalrevisions').insertOne({ _id: scope.businessId, revision: BSON.Long.fromNumber(83),
      bootstrapStatus: 'VERIFIED', historicalDatasetVersion: config.datasetVersion, historicalDatasetSha256: config.sourceSha256 });
    const productId = new BSON.ObjectId();
    await db.collection('products').insertOne({ _id: productId, businessId: scope.businessId, sku: 'LOCAL', name: 'Synthetic',
      price: 2, costPrice: 1, stock: 50, minStockLevel: 0, currency: 'USD', category: 'Local', isActive: true });
    const registryModule = require('../../src/services/forecastModelRegistryService');
    const registry = registryModule.createForecastModelRegistryService();
    for (const horizonDays of [7, 14]) {
      const candidate = await registry.createCandidateMetadata({ ...scope, horizonDays, modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27',
        trainedAt: new Date('2026-10-16T12:00:00Z'), trainedDataVersion: '83', dataCutoff: '2026-10-15',
        labelClosedThrough: '2026-09-01', trainingWindow: { startDate: '2025-10-13', endDate: '2026-09-01' },
        featureVersion: 'CAUSAL27-v1', featureHash: 'a'.repeat(64), sourceDatasetHash: 'b'.repeat(64),
        promotionPolicyVersion: registryModule.PROMOTION_POLICY_VERSION, promotionPolicyHash: registryModule.PROMOTION_POLICY_HASH,
        globalWape: 0.21, globalMae: 2.7, globalBias: -0.02, checks: { global: { passed: true }, groups: [] },
        triggerReason: 'LOCAL_FIXTURE', artifactData: Buffer.from('synthetic-not-trained'), lineage: { source: 'local-fixture' } });
      await registry.promoteCandidate({ ...scope, horizonDays, modelVersion: candidate.modelVersion, expectedGeneration: 0 });
    }
    const admin = A.createMlTestAdminExecutor({ client, db, target: 'LOCAL_CERTIFICATION', writersPaused: true });
    const req = body => ({ user, body, query: {} });
    let checkpoint;
    await t.test('admin CREATE is audited and scope cannot be overridden', async () => {
      await assert.rejects(admin.execute({ user: null, body: {} }, 'CREATE'), { httpStatus: 401 });
      await assert.rejects(admin.execute({ user: { ...user, role: 'user' }, body: {} }, 'CREATE'), { httpStatus: 403 });
      await assert.rejects(admin.execute({ ...req({}), query: { businessId: 'foreign' } }, 'CREATE'), { httpStatus: 403 });
      checkpoint = await admin.execute(req({}), 'CREATE'); assert.equal(checkpoint.status, 'READY');
      const before = await db.collection(A.AUDIT).countDocuments({});
      const status = await admin.execute(req({}), 'STATUS'); assert.equal(status.state, 'TEST_ACTIVE');
      assert.equal(status.activeCheckpointId, checkpoint.checkpointId);
      assert.equal(await db.collection(A.AUDIT).countDocuments({}), before);
    });
    let base = { checkpointId: checkpoint.checkpointId, branch: 'NORMAL' };
    await t.test('restore-and-continue retains TEST_ACTIVE; no direct finalize action exists', async () => {
      await F.withEpoch(db, async () => {
        await F.mutationTransaction(() => models.Product.updateOne({ _id: productId, businessId: scope.businessId }, { $set: { stock: 47 } }));
      });
      const restored = await admin.execute(req({ ...base, restoreId: randomUUID() }), 'RESTORE');
      assert.equal(restored.status, 'TEST_ACTIVE'); assert.equal((await models.Product.findById(productId).lean()).stock, 50);
      await assert.rejects(admin.execute(req({}), 'FINISH'), { code: 'ML_TEST_ACTION_NOT_ALLOWED' });
    });
    await t.test('FAILED finish cannot skip restore; same-id recovery verifies before NO_TEST, epoch monotonic', async () => {
      const restoreId = randomUUID();
      await assert.rejects(R.restoreLocalCheckpoint({ client, db, ...base, restoreId, finish: true,
        afterCollection: async collection => { if (collection === 'products') throw new Error('LOCAL_INTERRUPTION'); } }),
      { code: 'RESTORE_OPERATION_FAILED' });
      const failed = await F.capture(db); assert.equal(failed.state, 'FAILED');
      await assert.rejects(admin.execute(req({}), 'FORCE_NO_TEST'), { code: 'ML_TEST_ACTION_NOT_ALLOWED' });
      const recovered = await admin.execute(req({ ...base, restoreId }), 'RECOVER_AND_FINISH');
      assert.equal(recovered.status, 'NO_TEST'); assert.equal(BigInt(recovered.resetEpoch), BigInt(failed.resetEpoch) + 1n);
      checkpoint = await admin.execute(req({}), 'CREATE'); base = { ...base, checkpointId: checkpoint.checkpointId };
    });
    let oldToken, manualKey;
    const oldProcess = processProbe({ action: 'post-finish-stale' });
    const message = await oldProcess.next(); assert.equal(message.type, 'TOKEN'); oldToken = F.durableToken(message.token);
    await t.test('manual request and ML claim carry a durable testEpoch without dispatch', async () => {
      const request = require('../../src/services/forecastManualUpdateService').createForecastManualUpdateService({ dispatch: async () => 'DEFERRED' });
      assert.equal((await request.request(req({}))).requestStatus, 'REQUEST_ACCEPTED');
      const row = await db.collection('forecastmlupdatestates').findOne({ ...scope, horizonDays: 7 });
      assert.deepEqual(row.manualTestEpoch, oldToken); manualKey = row.manualRequestKey;
      await require('../../src/services/forecastMlUpdateCoordinator').refreshWatermarks(scope);
      const claim = await require('../../src/services/forecastMlUpdateCoordinator').claimEligibleUpdate({
        ...scope, horizonDays: 7, leaseOwner: 'local-admin-test' });
      assert(claim, 'fixture historical watermark must be naturally eligible; never force policy');
      assert.deepEqual(claim.testEpoch, oldToken);
      const claimed = await db.collection('forecastmlupdatestates').findOne({ ...scope, horizonDays: 7 });
      assert.deepEqual(claimed.claimedTestEpoch, oldToken);
    });
    const finishId = randomUUID();
    await t.test('restore-and-finish stays fenced until verified, then advances epoch and retains tombstone', async () => {
      const result = await admin.execute(req({ ...base, restoreId: finishId }), 'RESTORE_AND_FINISH');
      assert.equal(result.status, 'NO_TEST'); assert(BigInt(result.resetEpoch) > BigInt(oldToken.resetEpoch));
      const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId });
      assert.equal(control.activeCheckpointId, null); assert.equal(control.lastCheckpointId, checkpoint.checkpointId);
      assert.equal(control.testCycleId, oldToken.testCycleId); assert(control.epochChangedAt instanceof Date);
      assert.equal(await db.collection('forecastmlupdateexecutions').countDocuments(scope), 0);
    });
    await t.test('separate stale process rejects sale/ACK/worker/finish/artifact/promotion/manual/delivery ACK after NO_TEST', async () => {
      oldProcess.child.send({ continue: true }); const result = await oldProcess.result();
      for (const key of ['sale', 'ack', 'executionFinish', 'artifactPersist', 'registryPromotion', 'actualAck', 'actualWorker', 'manualRequest', 'deliveryAck'])
        assert.equal(result[key], 'STALE_TEST_EPOCH', key);
      assert.equal(result.trainingCalls, 0);
      const delayed = await processProbe({ action: 'delayed-dispatch', testEpoch: oldToken, manualRequestKey: manualKey,
        queuedAt: '2026-10-18T00:00:00Z' }).result();
      assert.equal(delayed.code, 'STALE_TEST_EPOCH'); assert.equal(delayed.pythonCalls, 0);
      assert.equal(await db.collection('forecastmlupdateexecutions').countDocuments(scope), 0);
    });
    await t.test('fresh sale after NO_TEST works; finish receipt replay cannot erase fresh activity', async () => {
      await require('../../src/services/transactionWriteService').writeTransaction({ businessId: scope.businessId,
        input: { type: 'sale', currency: 'USD', paymentMethod: 'cash', products: [{ productId, quantity: 1 }] } });
      assert.equal((await models.Product.findById(productId).lean()).stock, 49);
      const replay = await admin.execute(req({ ...base, restoreId: finishId }), 'RESTORE_AND_FINISH');
      assert.equal(replay.idempotent, true); assert.equal((await models.Product.findById(productId).lean()).stock, 49);
    });
    await t.test('fresh worker uses real pipeline/history and current epoch, with Python stubbed and no fit', async () => {
      let pythonChecks = 0;
      const deps = require('../../scripts/run-v3-ridge-worker-cloud').productionDependencies({ uri: process.env.MONGODB_TEST_URI,
        database: db.databaseName, ...scope, python: 'NOT_EXECUTED', executionIdentity: { triggerSource: 'CLI', cliInvocationKey: randomUUID() } },
      { checkPython: async () => { pythonChecks++; return { promotionReadiness: Object.fromEntries([7, 14].map(h => [h,
        { status: 'NO_PROMOTION_INSUFFICIENT_HISTORY', availableOrigins: 0, requiredOrigins: 107 }])) }; } });
      const result = await deps.withFence(() => require('../../src/services/forecastCloudWorker').createCloudWorker(deps).run('RUN'));
      assert.equal(result.status, 'OK'); assert.equal(pythonChecks, 1); assert(result.executionId);
      assert.equal(await db.collection('forecastmlupdateexecutions').countDocuments({ executionId: result.executionId }), 1);
      assert.deepEqual(result.horizons.map(row => row.horizonDays), [7, 14]);
    });
    await t.test('fresh manual request works and stores current identity, never the old cycle epoch', async () => {
      let dispatched;
      const service = require('../../src/services/forecastManualUpdateService').createForecastManualUpdateService({
        dispatch: async input => { dispatched = input; return 'DEFERRED'; } });
      assert.equal((await service.request(req({}))).requestStatus, 'REQUEST_ACCEPTED');
      const current = F.durableToken(await F.capture(db)); assert.deepEqual(dispatched.testEpoch, current);
      assert.notEqual(current.resetEpoch, oldToken.resetEpoch);
    });
    await t.test('legacy claim without epoch fails closed; fresh delivery claim persists current epoch', async () => {
      await assert.rejects(require('../../src/services/forecastMlUpdateCoordinator').ackUpdate({ ...scope,
        horizonDays: 7, leaseOwner: 'legacy', fencingToken: 1 }), { code: 'TEST_EPOCH_REQUIRED' });
      const alertId = new BSON.ObjectId(), eventId = `${alertId}:inventory.alert.opened`;
      await F.withEpoch(db, () => F.mutationTransaction(() => require('../../src/models/InventoryAlertOutboxEvent').create({
        businessId: scope.businessId, eventId, eventType: 'inventory.alert.opened', alertId,
        productId, payload: { synthetic: true } })));
      const row = await F.withEpoch(db, () => require('../../src/services/inventoryAlertOutbox').repository.claim(new Date(), 'local-delivery'));
      assert.equal(row.eventId, eventId); assert.deepEqual(row.testEpoch, F.durableToken(await F.capture(db)));
    });
    await t.test('audit is durable outside snapshot and includes actor/action/scope/cycle/epoch/time/result', async () => {
      const rows = await db.collection(A.AUDIT).find({}).toArray(); assert(rows.length >= 4);
      for (const row of rows) { assert.equal(row.actor, String(user._id)); assert(row.action); assert(row.timestamp instanceof Date);
        assert.equal(row.businessId, scope.businessId); assert(row.epoch); assert(row.testCycleId !== undefined); assert.equal(row.result, 'SUCCEEDED'); }
      assert(!M.COLLECTIONS.some(row => row.collection === A.AUDIT));
    });
  } finally { for (const child of children) child.kill('SIGKILL');
    if (db) { S.assertLocalTarget(client, db); await db.dropDatabase(); } await mongoose.disconnect(); }
});
test('failed capture without READY checkpoint never has a force-NO_TEST escape; audit preserves sanitized failure', async () => {
  const uri = new URL(process.env.MONGODB_TEST_URI); uri.pathname = `/ml_checkpoint_${randomUUID().replaceAll('-', '')}_test`;
  const client = await new mongoose.mongo.MongoClient(uri.href).connect(), db = client.db();
  try {
    S.assertLocalTarget(client, db);
    await db.collection('v3operationalrevisions').insertOne({ _id: scope.businessId, revision: BSON.Long.fromNumber(83) });
    const original = db.collection.bind(db);
    db.collection = (...args) => { const collection = original(...args);
      if (args[0] === 'mltestcheckpointchunks') collection.insertOne = async () => { throw new Error('DO_NOT_EXPOSE_SECRET'); };
      return collection; };
    const executor = A.createMlTestAdminExecutor({ client, db, target: 'LOCAL_CERTIFICATION', writersPaused: true });
    const req = body => ({ user, body, query: {} });
    await assert.rejects(executor.execute(req({}), 'CREATE'), { code: 'ML_TEST_OPERATION_FAILED' });
    const failed = await F.capture(db); assert.equal(failed.state, 'FAILED');
    const control = await original('mltestcontrols').findOne({ businessId: scope.businessId });
    await assert.rejects(executor.execute(req({ checkpointId: control.activeCheckpointId, restoreId: randomUUID(), branch: 'NORMAL' }),
      'RECOVER_AND_FINISH'), { code: 'ML_TEST_SAME_RESTORE_REQUIRED' });
    assert.equal((await F.capture(db)).state, 'FAILED'); assert.equal((await F.capture(db)).resetEpoch, failed.resetEpoch);
    const audits = await original(A.AUDIT).find({}).toArray(); assert.equal(audits.length, 2);
    assert(audits.every(row => row.result === 'FAILED')); assert(!JSON.stringify(audits).includes('DO_NOT_EXPOSE_SECRET'));
  } finally { S.assertLocalTarget(client, db); await db.dropDatabase(); await client.close(); }
});
