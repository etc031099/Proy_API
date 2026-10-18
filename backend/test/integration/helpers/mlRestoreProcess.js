'use strict';
// Disposable loopback replica-set process probe. Never accepts a cloud target.
const mongoose = require('mongoose');
const S = require('../../../src/services/mlTestCheckpointService');
const R = require('../../../src/services/mlTestRestoreService');
const F = require('../../../src/services/mlTestFence');
const M = require('../../../src/services/mlTestCheckpointManifest');
const models = require('../../../src/models');
const scope = M.authorizedScope();
const send = value => new Promise(resolve => process.send(value, resolve));
const pause = async stage => { await send({ type: 'PAUSED', stage }); await new Promise(() => {}); };
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
async function run(input) {
  const target = new URL(process.env.MONGODB_TEST_URI);
  if (target.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || !/^\/ml_checkpoint_[a-f0-9]{32}_test$/.test(target.pathname)) throw new Error('LOCAL_ONLY');
  await mongoose.connect(target.href, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 4000 });
  const db = mongoose.connection.db, client = mongoose.connection.getClient();
  S.assertLocalTarget(client, db);
  const started = Date.now();
  let verificationMs = null;
  let result;
  if (input.action === 'capture') {
    if (input.killAt === 'CAPTURE') {
      const collection = db.collection.bind(db);
      db.collection = (...args) => {
        const value = collection(...args);
        if (args[0] === 'mltestcheckpointchunks') {
          const insert = value.insertOne.bind(value);
          value.insertOne = async (...values) => { const result = await insert(...values); await pause('CAPTURE_CHUNK_PERSISTED'); return result; };
        }
        return value;
      };
    }
    result = await S.captureLocalCheckpoint({ client, db, localWritersPaused: true });
  } else if (input.action === 'restore') {
    const scan = S.scanSource;
    S.scanSource = async options => { const start = Date.now();
      const value = await scan(options); verificationMs = Date.now() - start; return value; };
    if (input.killAt === 'VERIFY') {
      S.scanSource = options => scan({ ...options, onChunk: async () => pause('FINAL_VERIFICATION_CHUNK_READ') });
    }
    result = await R.restoreLocalCheckpoint({ client, db, checkpointId: input.checkpointId,
      restoreId: input.restoreId, branch: 'NORMAL',
      afterCollection: input.killAt === 'RESTORE' ? async name => { if (name === 'products') await pause('RESTORE_PRODUCTS_COMMITTED'); } : undefined });
  } else if (['stale-writer', 'post-finish-stale'].includes(input.action)) {
    const token = await F.capture(db);
    await send({ type: 'TOKEN', token });
    await new Promise(resolve => process.once('message', resolve));
    const product = await db.collection('products').findOne({ businessId: scope.businessId });
    const attempts = {
      sale: () => require('../../../src/services/transactionWriteService').writeTransaction({ businessId: scope.businessId,
        input: { type: 'sale', currency: 'USD', paymentMethod: 'cash', products: [{ productId: product._id, quantity: 1 }] } }),
      ack: () => models.ForecastMlUpdateState.updateOne({ ...scope, horizonDays: 7 }, { $set: { pending: false } }),
      executionFinish: () => models.ForecastMlUpdateExecution.updateOne({ ...scope }, { $set: { stage: 'FINISHED' } }),
      artifactPersist: () => models.ForecastModelArtifact.updateOne({ ...scope, horizonDays: 7 }, { $set: { status: 'CANDIDATE' } }),
      registryPromotion: () => models.ForecastModelRegistry.updateOne({ ...scope, horizonDays: 7 }, { $set: { activeModelVersion: 2 } })
    };
    let trainingCalls = 0;
    if (input.action === 'post-finish-stale') Object.assign(attempts, {
      actualAck: () => require('../../../src/services/forecastMlUpdateCoordinator').ackUpdate({ ...scope, horizonDays: 7,
        testEpoch: F.durableToken(token), leaseOwner: 'old', fencingToken: 1 }),
      actualWorker: () => require('../../../src/services/forecastRidgeTrainingWorker').createForecastRidgeTrainingWorker({
        runTraining: async () => { trainingCalls++; throw new Error('UNEXPECTED_TRAINING'); } }).process({
        horizonDays: 7, claim: { testEpoch: F.durableToken(token) } }),
      manualRequest: () => require('../../../src/services/forecastManualUpdateService').createForecastManualUpdateService({
        dispatch: async () => 'DEFERRED' }).request({ user: { businessId: scope.businessId }, body: {}, query: {} }),
      deliveryAck: () => require('../../../src/services/inventoryAlertOutbox').repository.finish({ testEpoch: F.durableToken(token), eventId: 'old' }, 'old', { status: 'DELIVERED' })
    });
    result = {};
    for (const [name, work] of Object.entries(attempts)) {
      try { await F.withEpoch(db, work, token); result[name] = 'UNEXPECTED_SUCCESS'; }
      catch (error) { result[name] = error.code || error.name; }
    }
    result.externalAllowed = await F.externalAllowed(db);
    result.trainingCalls = trainingCalls;
  } else if (input.action === 'external-race') {
    let sends = 0, acks = 0;
    const dispatcher = require('../../../src/services/inventoryAlertOutbox').createInventoryAlertDispatcher({
      repo: { async claim() { await send({ type: 'CLAIMED' }); await new Promise(resolve => process.once('message', resolve));
        return { eventId: 'synthetic', payload: {}, attempts: 1 }; }, async finish() { acks++; } },
      deliver: async () => { sends++; return { delivered: true }; }, afterDelivered: async () => {} });
    result = { summary: await dispatcher.run(), sends, acks };
  } else if (input.action === 'delayed-dispatch') {
    // Invoke the REAL runner connection gate, with only Python replaced by a
    // counter. No workflow dispatch, external connection, history or training.
    let pythonCalls = 0;
    const dependencies = require('../../../scripts/run-v3-ridge-worker-cloud').productionDependencies(
      { uri: target.href, ...(input.testEpoch ? { testEpoch: input.testEpoch, github: true, queuedAt: input.queuedAt,
        manualRequestKey: input.manualRequestKey, database: db.databaseName } : {}) },
      { checkPython: async () => { pythonCalls++; throw new Error('UNEXPECTED_TRAINING'); } });
    try { await dependencies.executionHistory.begin(); result = { code: 'UNEXPECTED_SUCCESS', pythonCalls }; }
    catch (error) { result = { code: error.code, pythonCalls }; }
  } else throw new Error('UNKNOWN_ACTION');
  peakRss = Math.max(peakRss, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
  await send({ type: 'RESULT', result, elapsedMs: Date.now() - started, verificationMs, peakRssBytes: peakRss });
}
process.once('message', input => run(input).catch(async error => {
  await send({ type: 'ERROR', code: /^[A-Z_]+$/.test(error.code || '') ? error.code : error.name });
}).finally(async () => { clearInterval(sampler); await mongoose.disconnect(); process.disconnect(); }));
