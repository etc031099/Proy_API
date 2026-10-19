'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { MongoClient, BSON } = require('mongoose').mongo;
const S = require('../../src/services/mlTestCheckpointService');
const M = require('../../src/services/mlTestCheckpointManifest');
const F = require('../../src/services/mlTestFence');
const R = require('../../src/services/mlTestRestoreService');
const A = require('../../src/services/mlTestAdminExecutor');
const Recovery = require('../../src/services/mlTestFailedCheckpointRecovery');
const config = require('../../src/config/v3Operational');
const scope = M.authorizedScope();
const user = { _id: 'authenticated-local-admin', businessId: scope.businessId, role: 'admin', isActive: true };
const req = { user, body: {}, query: {} };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(work) {
  const uri = new URL(process.env.MONGODB_TEST_URI);
  uri.pathname = `/ml_checkpoint_${randomUUID().replaceAll('-', '')}_test`;
  const client = await new MongoClient(uri.href, { monitorCommands: true, serverSelectionTimeoutMS: 4000 }).connect();
  const db = client.db();
  try {
    S.assertLocalTarget(client, db); await S.provisionLocal(client, db);
    for (const { collection } of M.COLLECTIONS) await db.createCollection(collection);
    await db.collection('historicalscenarios').insertOne({ ...scope, status: 'completed', sourceSha256: config.sourceSha256,
      metadata: { datasetVersion: config.datasetVersion, referenceDate: config.historicalCutoff, timezone: config.timezone } });
    await db.collection('v3operationalrevisions').insertOne({ _id: scope.businessId, revision: BSON.Long.fromNumber(173) });
    await db.collection('products').insertOne({ businessId: scope.businessId, sku: 'SYNTHETIC', stock: 8 });
    await db.collection('transactions').insertOne({ businessId: scope.businessId, synthetic: true });
    await work({ client, db });
  } finally { S.assertLocalTarget(client, db); await db.dropDatabase(); await client.close(); }
}
async function sourceDigest(db) {
  const hash = createHash('sha256');
  for (const { collection } of M.COLLECTIONS) for await (const raw of db.collection(collection).find(M.scopeFilter(collection, scope), { raw: true }).sort({ _id: 1 })) hash.update(raw);
  return hash.digest('hex');
}

test('failed snapshot capture: preserved diagnostics/evidence and scoped, audited CAS recovery', { timeout: 30000 }, async t => fixture(async ({ client, db }) => {
  const wrapped = Object.create(db), original = db.collection.bind(db), logs = [];
  wrapped.collection = name => {
    const collection = original(name);
    if (name === 'products') {
      const find = collection.find.bind(collection);
      collection.find = (filter, options) => options?.raw && options.session ? {
        sort() { return this; }, async *[Symbol.asyncIterator]() {
          throw Object.assign(new Error('UNTRUSTED_MESSAGE'), { name: 'MongoServerError', code: 251,
            codeName: 'NoSuchTransaction', errorLabels: ['TransientTransactionError'] });
        }, async close() {}
      } : find(filter, options);
    }
    return collection;
  };
  const executor = A.createMlTestAdminExecutor({ client, db: wrapped, target: 'LOCAL_CERTIFICATION', writersPaused: true, auditDenied: () => {} });
  const warn = console.warn; console.warn = line => logs.push(String(line));
  try { await assert.rejects(executor.execute(req, 'CREATE'), { code: 'CHECKPOINT_SNAPSHOT_TRANSACTION_FAILED' }); }
  finally { console.warn = warn; }
  const admin = A.createMlTestAdminExecutor({ client, db, target: 'LOCAL_CERTIFICATION', auditDenied: () => {} });
  const initial = await admin.execute(req, 'STATUS'), checkpointId = initial.activeCheckpointId;
  const checkpoint = await db.collection('mltestcheckpoints').findOne({ checkpointId });
  const sourceBefore = await sourceDigest(db), chunksBefore = await db.collection('mltestcheckpointchunks').countDocuments({ checkpointId });
  await t.test('251 remains FAILED; original safe fields are durable and HTTP/executor code is specific', async () => {
    assert.equal(initial.state, 'FAILED'); assert.equal(initial.maintenance, true);
    assert.equal(initial.failureCode, 'CHECKPOINT_SNAPSHOT_TRANSACTION_FAILED');
    assert.equal(checkpoint.failureDiagnostics.code, 251); assert.equal(checkpoint.failureDiagnostics.codeName, 'NoSuchTransaction');
    assert.equal(checkpoint.failureDiagnostics.phase, 'SNAPSHOT_READ'); assert.equal(checkpoint.failureDiagnostics.collection, 'products');
    assert.equal(checkpoint.status, 'FAILED'); assert(chunksBefore > 0);
    assert(logs.some(line => line.includes('NoSuchTransaction'))); assert(!logs.some(line => line.includes('UNTRUSTED_MESSAGE')));
  });
  await t.test('failed capture cannot be restored', async () => {
    await assert.rejects(R.restoreLocalCheckpoint({ client, db, scope, checkpointId, restoreId: randomUUID(), branch: 'NORMAL' }),
      { code: 'RESTORE_READY_CHECKPOINT_REQUIRED' });
  });
  const controls = db.collection('mltestcontrols'), checkpoints = db.collection('mltestcheckpoints');
  for (const [name, fields, code] of [
    ['READY checkpoint', { status: 'READY' }, 'CHECKPOINT_RECOVERY_NOT_FAILED_CAPTURE'],
    ['checkpoint which previously reached READY', { readyAt: new Date() }, 'CHECKPOINT_RECOVERY_NOT_FAILED_CAPTURE']
  ]) await t.test(`cannot abandon ${name}`, async () => {
    await checkpoints.updateOne({ checkpointId }, { $set: fields });
    try { await assert.rejects(admin.execute(req, 'ABORT_FAILED_CHECKPOINT'), { code }); }
    finally { await checkpoints.updateOne({ checkpointId }, { $set: { status: 'FAILED', readyAt: null } }); }
  });
  for (const [name, fields, cleanup, code] of [
    ['restore identity', { restoreId: randomUUID() }, { restoreId: null }, 'CHECKPOINT_RECOVERY_RESTORE_PRESENT'],
    ['restore lease', { restoreLeaseUntil: new Date(Date.now() + 60000) }, { restoreLeaseUntil: null }, 'CHECKPOINT_RECOVERY_RESTORE_PRESENT'],
    ['active writer', { activeWriterIds: [randomUUID()] }, { activeWriterIds: [] }, 'CHECKPOINT_RECOVERY_WRITERS_PRESENT'],
    ['previous checkpoint pointer', { lastCheckpointId: randomUUID() }, { lastCheckpointId: null }, 'CHECKPOINT_RECOVERY_PRIOR_CHECKPOINT_PRESENT']
  ]) await t.test(`cannot abandon with ${name}`, async () => {
    await controls.updateOne({ businessId: scope.businessId }, { $set: fields });
    try { await assert.rejects(admin.execute(req, 'ABORT_FAILED_CHECKPOINT'), { code }); }
    finally { await controls.updateOne({ businessId: scope.businessId }, { $set: cleanup }); }
  });
  await t.test('another READY source in the same scope blocks recovery', async () => {
    const other = await checkpoints.insertOne({ ...scope, checkpointId: randomUUID(), status: 'READY' });
    try { await assert.rejects(admin.execute(req, 'ABORT_FAILED_CHECKPOINT'), { code: 'CHECKPOINT_RECOVERY_READY_PRESENT' }); }
    finally { await checkpoints.deleteOne({ _id: other.insertedId }); }
  });
  await t.test('mandatory audit cannot be omitted by an internal caller', async () => {
    await assert.rejects(Recovery.abortFailedCheckpoint({ client, db, scope, actionId: randomUUID(), actor: user._id }),
      { code: 'CHECKPOINT_RECOVERY_AUDIT_REQUIRED' });
    assert.equal((await F.capture(db)).state, 'FAILED');
  });
  await t.test('an audit from a different epoch or cycle cannot authorize recovery', async () => {
    const token = await F.capture(db);
    for (const mismatch of [{ epoch: String(BigInt(token.resetEpoch) + 1n) }, { testCycleId: randomUUID() }]) {
      const actionId = randomUUID();
      await db.collection(A.AUDIT).insertOne({ actionId, actor: user._id, ...scope,
        action: 'ABORT_FAILED_CHECKPOINT', result: 'STARTED', epoch: token.resetEpoch,
        testCycleId: token.testCycleId, ...mismatch });
      await assert.rejects(Recovery.abortFailedCheckpoint({ client, db, scope, actionId, actor: user._id }),
        { code: 'CHECKPOINT_RECOVERY_CONFLICT' });
      assert.deepEqual(await F.capture(db), token);
    }
  });
  await t.test('concurrent recovery has one CAS winner; maintenance remains until control, receipt and audit commit', async () => {
    const racingDb = Object.create(db);
    let admitted = 0, releaseUpdates, allowCommit, atCommit;
    const updates = new Promise(resolve => { releaseUpdates = resolve; });
    const commitGate = new Promise(resolve => { allowCommit = resolve; });
    const reachedCommit = new Promise(resolve => { atCommit = resolve; });
    racingDb.collection = name => {
      const collection = original(name), updateOne = collection.updateOne.bind(collection);
      collection.updateOne = async (filter, update, options) => {
        if (name === 'mltestcontrols' && update.$set?.state === 'NO_TEST') {
          if (++admitted === 2) releaseUpdates(); await updates;
        }
        if (name === A.AUDIT && update.$set?.result === 'SUCCEEDED' && options?.session) { atCommit(); await commitGate; }
        return updateOne(filter, update, options);
      };
      return collection;
    };
    const racing = A.createMlTestAdminExecutor({ client, db: racingDb, target: 'LOCAL_CERTIFICATION', auditDenied: () => {} });
    const attempts = Promise.allSettled([racing.execute(req, 'ABORT_FAILED_CHECKPOINT'), racing.execute(req, 'ABORT_FAILED_CHECKPOINT')]);
    await reachedCommit;
    const during = await admin.execute(req, 'STATUS'); assert.equal(during.state, 'FAILED'); assert.equal(during.maintenance, true);
    allowCommit(); const results = await attempts;
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.find(row => row.status === 'rejected').reason.code, 'CHECKPOINT_RECOVERY_CONFLICT');
    const after = await admin.execute(req, 'STATUS');
    assert.equal(after.state, 'NO_TEST'); assert.equal(after.maintenance, false); assert.equal(after.activeCheckpointId, null);
    assert.equal(BigInt(after.resetEpoch), BigInt(initial.resetEpoch) + 1n);
    assert.equal(after.lastAbortedCheckpointId, checkpointId);
  });
  await t.test('FAILED evidence survives; idempotent replay never changes epoch or operational data', async () => {
    const after = await admin.execute(req, 'STATUS');
    const replay = await admin.execute(req, 'ABORT_FAILED_CHECKPOINT');
    assert.equal(replay.idempotent, true); assert.equal(replay.resetEpoch, after.resetEpoch);
    const preserved = await checkpoints.findOne({ checkpointId });
    assert.equal(preserved.status, 'FAILED'); assert.equal(preserved.failureCode, checkpoint.failureCode); assert(preserved.abandonedAt);
    assert.equal(await db.collection('mltestcheckpointchunks').countDocuments({ checkpointId }), chunksBefore);
    assert.equal(await sourceDigest(db), sourceBefore);
    const audit = await db.collection(A.AUDIT).findOne({ actionId: preserved.abandonmentActionId });
    assert.equal(audit.action, 'ABORT_FAILED_CHECKPOINT'); assert.equal(audit.result, 'SUCCEEDED');
    assert.equal(audit.checkpointId, checkpointId); assert.equal(audit.epoch, after.resetEpoch);
  });
  await t.test('next checkpoint starts at a newer epoch and exact restore still works', async () => {
    const fresh = await S.captureOperationalCheckpoint({ client, db, scope });
    assert.equal(fresh.status, 'READY'); assert(BigInt(fresh.resetEpoch) > BigInt(initial.resetEpoch));
    assert((await checkpoints.findOne({ checkpointId: fresh.checkpointId })).readyAt);
    await R.restoreLocalCheckpoint({ client, db, scope, checkpointId: fresh.checkpointId, restoreId: randomUUID(), branch: 'NORMAL', finish: true });
    assert.equal(await sourceDigest(db), sourceBefore);
  });
}));

test('the deployed legacy FAILED/null dataVersion shape can be abandoned without deleting partial chunks', async () => fixture(async ({ client, db }) => {
  const checkpointId = randomUUID(), cycle = randomUUID();
  await db.collection('mltestcontrols').insertOne({ businessId: scope.businessId, state: 'FAILED', activeCheckpointId: checkpointId,
    testCycleId: cycle, resetEpoch: BSON.Long.ONE, lastCheckpointId: null, restoreId: null, activeWriterIds: [] });
  await db.collection('mltestcheckpoints').insertOne({ ...scope, checkpointId, status: 'FAILED', dataVersion: null,
    totalBytes: 0, totalChunks: 0, failureCode: 'CHECKPOINT_SNAPSHOT_TRANSACTION_FAILED' });
  await db.collection('mltestcheckpointchunks').insertOne({ checkpointId, collection: 'transactions', payload: new BSON.Binary(Buffer.from('partial evidence')) });
  const before = await sourceDigest(db);
  const admin = A.createMlTestAdminExecutor({ client, db, target: 'LOCAL_CERTIFICATION', auditDenied: () => {} });
  const result = await admin.execute(req, 'ABORT_FAILED_CHECKPOINT'); assert.equal(result.state, 'NO_TEST'); assert.equal(result.resetEpoch, '2');
  assert.equal(await db.collection('mltestcheckpointchunks').countDocuments({ checkpointId }), 1);
  assert.equal(await sourceDigest(db), before);
}));

test('production snapshot session pins one majority snapshot across collections despite external writes', async () => fixture(async ({ client, db }) => {
  let changed = false, observed;
  const before = await db.collection('products').findOne({ businessId: scope.businessId });
  const result = await S.scanSource({ client, db, scope, onChunk: async (collection, chunk) => {
    if (!changed && collection === 'transactions') { changed = true; await db.collection('products').updateOne({ _id: before._id }, { $set: { stock: 999 } }); }
    if (collection === 'products') observed = BSON.deserialize(chunk.payload).stock;
  } });
  assert(changed); assert.equal(observed, 8); assert.equal((await db.collection('products').findOne({ _id: before._id })).stock, 999);
  assert.equal(result.dataVersion, '173');
}));

test('one capture deadline covers snapshot, chunk writes and verification; each phase timeout stays FAILED and recoverable',
  { timeout: 30000 }, async t => fixture(async ({ client, db }) => {
    for (const phase of ['SNAPSHOT_READ', 'CHUNK_WRITE', 'VERIFY']) await t.test(`timeout in ${phase}`, async () => {
      let fakeNow = 1000, injected = false;
      const wrapped = Object.create(db), original = db.collection.bind(db);
      wrapped.collection = name => {
        const collection = original(name);
        if (phase === 'CHUNK_WRITE' && name === 'mltestcheckpointchunks') {
          const insertOne = collection.insertOne.bind(collection);
          collection.insertOne = async (...args) => {
            const result = await insertOne(...args);
            if (!injected) { injected = true; fakeNow += 240001; }
            return result;
          };
        }
        return collection;
      };
      const logs = [];
      await assert.rejects(S.captureOperationalCheckpoint({ client, db: wrapped, scope,
        now: () => fakeNow, logDiagnostic: row => logs.push(row), logProgress: row => {
          if (phase !== 'CHUNK_WRITE' && row.phase === phase && !injected) { injected = true; fakeNow += 240001; }
        } }), error => {
        assert.equal(error.code, 'CHECKPOINT_OPERATION_TIMEOUT'); assert.equal(error.phase, phase); return true;
      });
      const control = await db.collection('mltestcontrols').findOne({ businessId: scope.businessId });
      const checkpoint = await db.collection('mltestcheckpoints').findOne({ checkpointId: control.activeCheckpointId });
      assert.equal(control.state, 'FAILED'); assert.equal(checkpoint.status, 'FAILED');
      assert.equal(checkpoint.readyAt, null); assert.deepEqual(control.activeWriterIds || [], []);
      assert.equal(logs[0].phase, phase); assert.equal(logs[0].budgetMs, 240000);
      assert.equal(checkpoint.captureMetrics.budgetMs, 240000);
      const admin = A.createMlTestAdminExecutor({ client, db, target: 'LOCAL_CERTIFICATION', auditDenied: () => {} });
      const recovery = await admin.execute(req, 'ABORT_FAILED_CHECKPOINT');
      assert.equal(recovery.state, 'NO_TEST'); assert.equal(recovery.status, 'FAILED_CHECKPOINT_ABORTED');
      assert.equal((await F.capture(db)).state, 'NO_TEST');
      // Prepare an independent next phase case with a fresh cycle and epoch.
      if (phase !== 'VERIFY') {
        await db.collection('mltestcontrols').updateOne({ businessId: scope.businessId }, { $set: {
          state: 'NO_TEST', activeCheckpointId: null, lastCheckpointId: null, restoreId: null,
          restoreLeaseUntil: null, restoreOwnerNonce: null, restoreHeartbeatNonce: null,
          restoreFinish: false, activeWriterIds: []
        } });
      }
    });
  }));

test('a lost recovery commit acknowledgement cannot overwrite its atomic success audit or break a safe replay', async () => fixture(async ({ client, db }) => {
  const checkpointId = randomUUID();
  await db.collection('mltestcontrols').insertOne({ businessId: scope.businessId, state: 'FAILED', activeCheckpointId: checkpointId,
    testCycleId: randomUUID(), resetEpoch: BSON.Long.ONE, activeWriterIds: [] });
  await db.collection('mltestcheckpoints').insertOne({ ...scope, checkpointId, status: 'FAILED', dataVersion: null, totalBytes: 0, totalChunks: 0 });
  const lostAckClient = Object.create(client);
  lostAckClient.startSession = (...args) => {
    const session = client.startSession(...args), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async () => {
      await commit();
      throw Object.assign(new Error('UNTRUSTED_ACK_ERROR'), { name: 'MongoNetworkError', errorLabels: ['UnknownTransactionCommitResult'] });
    };
    return session;
  };
  const uncertain = A.createMlTestAdminExecutor({ client: lostAckClient, db, target: 'LOCAL_CERTIFICATION', auditDenied: () => {} });
  await assert.rejects(uncertain.execute(req, 'ABORT_FAILED_CHECKPOINT'));
  assert.equal((await F.capture(db)).state, 'NO_TEST');
  const success = await db.collection(A.AUDIT).findOne({ action: 'ABORT_FAILED_CHECKPOINT' });
  assert.equal(success.result, 'SUCCEEDED');
  const admin = A.createMlTestAdminExecutor({ client, db, target: 'LOCAL_CERTIFICATION', auditDenied: () => {} });
  const replay = await admin.execute(req, 'ABORT_FAILED_CHECKPOINT');
  assert.equal(replay.idempotent, true); assert.equal(replay.resetEpoch, '2');
}));

test('long chunk I/O outlives the local transaction limit: legacy transaction fails, production snapshot capture remains consistent', { timeout: 125000 }, async () => fixture(async ({ client, db }) => {
  const { transactionLifetimeLimitSeconds: seconds } = await db.admin().command({ getParameter: 1, transactionLifetimeLimitSeconds: 1 });
  assert.equal(seconds, 60, 'this reproduction requires the default local transaction limit; no parameter is modified');
  const old = client.startSession(); old.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
  await db.collection('products').findOne({}, { session: old });
  const commands = [], listener = event => {
    if (event.commandName === 'find' && event.command.readConcern?.level === 'snapshot' && event.command.autocommit !== false)
      commands.push({ collection: event.command.find, time: event.command.readConcern.atClusterTime });
  };
  client.on('commandStarted', listener);
  const wrapped = Object.create(db), original = db.collection.bind(db);
  const wrappedClient = Object.create(client);
  wrappedClient.startSession = (...args) => {
    const session = client.startSession(...args), commit = session.commitTransaction.bind(session);
    session.commitTransaction = async (...commitArgs) => {
      const result = await commit(...commitArgs);
      if (session.delayAfterChunkCommit) {
        session.delayAfterChunkCommit = false;
        await delay(95000); // Delay after the short chunk transaction, while the source snapshot stays pinned.
        try { await db.collection('products').findOne({}, { session: old }); }
        catch (error) { legacyCode = error.code; }
      }
      return result;
    };
    return session;
  };
  let delayed = false, deniedWriter = false, legacyCode;
  wrapped.collection = name => {
    const collection = original(name);
    if (name === 'mltestcheckpointchunks') {
      const insertOne = collection.insertOne.bind(collection);
      collection.insertOne = async (...args) => {
        const result = await insertOne(...args);
        if (!delayed) {
          delayed = true;
          await assert.rejects(F.withWriter(db, () => assert.fail('writer cannot enter while snapshot streams')), { code: 'TEST_RESTORE_BLOCKED' });
          deniedWriter = true;
          args[1].session.delayAfterChunkCommit = true;
        }
        return result;
      };
    }
    return collection;
  };
  try {
    const result = await S.captureOperationalCheckpoint({ client: wrappedClient, db: wrapped, scope });
    assert.equal(legacyCode, 251); assert.equal(result.status, 'READY'); assert(deniedWriter);
    assert.equal(result.metrics.snapshotTransactionMs, 0); assert(result.metrics.snapshotSessionMs >= 95000);
    assert(result.metrics.maxChunkBytes <= M.TARGET_BYTES);
    const pinned = commands.filter(row => row.time != null);
    assert(pinned.length >= M.COLLECTIONS.length);
    for (const row of pinned) assert.deepEqual(row.time, pinned[0].time);
    console.log('SNAPSHOT_LIFETIME_PROOF', JSON.stringify({ localTransactionLimitSeconds: seconds, legacyCode, snapshotStatus: result.status, metrics: result.metrics }));
  } finally { client.off('commandStarted', listener); await old.abortTransaction().catch(() => {}); await old.endSession(); }
}));

test('cloud-equivalent BSON volume streams within limits, verifies chunks and restores exactly', { timeout: 90000 }, async () => fixture(async ({ client, db }) => {
  for (const horizonDays of [7, 14]) {
    const bytes = Buffer.alloc(horizonDays === 7 ? 8752 : 8711, 1);
    await db.collection('forecastmodelartifacts').insertOne({ ...scope, horizonDays, modelVersion: 1, status: 'ACTIVE', artifactBytes: bytes.length,
      artifactData: new BSON.Binary(bytes), artifactHash: M.digest(bytes), trainedDataVersion: '173', dataCutoff: '2026-10-15' });
    await db.collection('forecastmodelregistries').insertOne({ ...scope, horizonDays, activeModelVersion: 1, generation: 1 });
  }
  let count = 0, bytes = 0;
  for (const { collection } of M.COLLECTIONS) for await (const raw of db.collection(collection).find({}, { raw: true })) { count++; bytes += raw.length; }
  const total = 56676, target = 101053736, n = total - count;
  const base = { _id: new BSON.ObjectId(), businessId: scope.businessId, synthetic: true, padding: '' };
  const overhead = BSON.calculateObjectSize(base), remaining = target - bytes - n * overhead;
  assert(remaining > 0);
  const destinations = ['transactions', 'inventorymovements', 'creditpayments', 'v3operationalchanges',
    'inventoryalerts', 'inventoryalertoutboxevents', 'inventoryalertchanneldeliveries', 'stockalertrules'];
  let batch = [], destination = 0;
  for (let i = 0; i < n; i++) {
    const next = Math.min(7, Math.floor(i * 8 / n));
    if (next !== destination && batch.length) { await db.collection(destinations[destination]).insertMany(batch); batch = []; }
    destination = next;
    batch.push({ ...base, _id: new BSON.ObjectId(), padding: 'x'.repeat(Math.floor(remaining / n) + (i < remaining % n ? 1 : 0)) });
    if (batch.length === 500 || i === n - 1) { await db.collection(destinations[destination]).insertMany(batch); batch = []; }
  }
  const result = await S.captureOperationalCheckpoint({ client, db, scope });
  assert.equal(result.totalDocuments, total); assert.equal(result.totalBytes, target); assert.equal(result.status, 'READY');
  assert.equal(result.metrics.bytesStreamed, target); assert.equal(result.metrics.snapshotTransactionMs, 0);
  assert(result.metrics.maxChunkBytes <= M.TARGET_BYTES); assert(result.metrics.peakRssBytes < 512 * 1024 * 1024);
  const before = await sourceDigest(db);
  await R.restoreLocalCheckpoint({ client, db, scope, checkpointId: result.checkpointId, restoreId: randomUUID(), branch: 'NORMAL', finish: true });
  assert.equal(await sourceDigest(db), before);
  console.log('CLOUD_EQUIVALENT_VOLUME', JSON.stringify({ documents: result.totalDocuments, bsonBytes: result.totalBytes, chunks: result.totalChunks, metrics: result.metrics }));
}));
