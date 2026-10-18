'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const M = require('../src/services/mlTestCheckpointManifest');
const S = require('../src/services/mlTestCheckpointService');
const { environment, failureReport, PREFLIGHT_READ_BUDGET_MS } = require('../scripts/preflight-v3-ml-test-checkpoint-cloud');
const config = require('../src/config/v3Operational');
const { BSON } = M;
const collect = async source => { const rows = []; for await (const row of source) rows.push(row); return rows; };
const local = { options: { hosts: [{ host: '127.0.0.1' }] } };
const databaseName = `ml_checkpoint_${randomUUID().replaceAll('-', '')}_test`;
const bufferFor = doc => BSON.serialize(doc);

test('raw BSON preserves ObjectId, dates, int64, Decimal128, Binary subtypes, nested values and timestamps', async () => {
  const doc = { _id: new BSON.ObjectId(), date: new Date('2026-10-18T18:00:00Z'),
    long: BSON.Long.fromString('9007199254740993'), decimal: BSON.Decimal128.fromString('12.3400'),
    binary: new BSON.Binary(Buffer.from([0, 255, 34]), 0x80), buffer: Buffer.from('artifact'),
    timestamp: BSON.Timestamp.fromNumber(123), nested: [{ nil: null, flags: [true, false], value: 1.25 }] };
  const raw = bufferFor(doc);
  const chunks = await collect(M.chunkDocuments([raw], 64));
  const joined = Buffer.concat(chunks.map(row => row.payload));
  assert.deepEqual(joined, raw);
  const copy = BSON.deserialize(joined, { promoteLongs: false });
  assert(copy._id.equals(doc._id)); assert.equal(copy.long.toString(), '9007199254740993');
  assert.equal(copy.decimal.toString(), '12.3400'); assert.equal(copy.binary.sub_type, 0x80);
  assert.deepEqual(copy.binary.value(true), doc.binary.value(true)); assert.equal(copy.date.getTime(), doc.date.getTime());
  assert.deepEqual(copy.nested, doc.nested); assert(copy.timestamp.equals(doc.timestamp));
  const frames = new M.FrameVerifier();
  assert.equal(chunks.reduce((sum, chunk) => sum + frames.feed(chunk.payload), 0), 1);
  assert.equal(frames.finish(), 1);
});
test('chunking and hashes are deterministic for a sorted BSON stream', async () => {
  const raw = [1, 2, 3].map(_id => bufferFor({ _id, text: 'x'.repeat(70) }));
  const first = await collect(M.chunkDocuments(raw, 64));
  assert.deepEqual(first, await collect(M.chunkDocuments(raw, 64)));
  assert.equal(first.reduce((sum, chunk) => sum + chunk.documentCount, 0), 3);
  assert(first.every(chunk => chunk.byteCount <= 64 && M.digest(chunk.payload) === chunk.contentHash));
  assert.deepEqual(Buffer.concat(first.map(chunk => chunk.payload)), Buffer.concat(raw));
  assert.equal(M.hashValue({ b: 2, a: 1 }), M.hashValue({ a: 1, b: 2 }));
  assert.notEqual(M.hashValue({ a: 2 }), M.hashValue({ a: 1 }));
});
test('a document larger than 4 MiB is split without losing BSON or exceeding the target', async () => {
  const raw = bufferFor({ _id: 1, artifact: new BSON.Binary(Buffer.alloc(M.TARGET_BYTES + 123)) });
  const chunks = await collect(M.chunkDocuments([raw]));
  assert.equal(chunks.length, 2); assert.equal(chunks[0].documentCount, 0); assert.equal(chunks[1].documentCount, 1);
  const verifier = new M.FrameVerifier(); chunks.forEach(chunk => verifier.feed(chunk.payload));
  assert.equal(verifier.finish(), 1); assert.deepEqual(Buffer.concat(chunks.map(chunk => chunk.payload)), raw);
});
test('empty collections, exact chunk boundaries, corrupt frames and invalid targets are handled', async () => {
  assert.deepEqual(await collect(M.chunkDocuments([])), []);
  const raw = bufferFor({ _id: 1 });
  const chunks = await collect(M.chunkDocuments(Array(64).fill(raw), raw.length * 8));
  assert.equal(chunks.length, 8); assert(chunks.every(chunk => chunk.documentCount === 8));
  await assert.rejects(collect(M.chunkDocuments([Buffer.from('invalid')], 64)), { code: 'CHECKPOINT_BSON_INVALID' });
  await assert.rejects(collect(M.chunkDocuments([raw], M.TARGET_BYTES + 1)), { code: 'CHECKPOINT_CHUNK_TARGET_INVALID' });
  const frames = new M.FrameVerifier(); frames.feed(raw.subarray(0, 5));
  assert.throws(() => frames.finish(), { code: 'CHECKPOINT_BSON_TRUNCATED' });
});
test('tenant filters include LIVE scenarioId=null; ML uses the exact authorized scenario', () => {
  for (const collection of ['transactions', 'inventorymovements', 'products', 'contacts', 'creditpayments',
    'pendingactions', 'actionaudits', 'actiondomainevents', 'automationruns']) {
    assert.deepEqual(M.scopeFilter(collection, config), { businessId: config.businessId });
    assert.equal(Object.hasOwn(M.scopeFilter(collection, config), 'scenarioId'), false);
  }
  assert.deepEqual(M.scopeFilter('forecastmodelartifacts', config), { businessId: config.businessId, scenarioId: config.scenarioId });
  assert.deepEqual(M.scopeFilter('v3operationalrevisions', config), { _id: config.businessId });
  assert.throws(() => M.scopeFilter('transactions', { ...config, businessId: 'foreign' }), { code: 'CHECKPOINT_SCOPE_INVALID' });
  assert.throws(() => M.scopeFilter('forecastmlupdateevents', { ...config, scenarioId: 'foreign' }), { code: 'CHECKPOINT_SCOPE_INVALID' });
});
test('credentials, control, checkpoint, archive and all non-allowlisted namespaces are excluded', () => {
  assert.equal(M.COLLECTIONS.length, 23);
  for (const name of ['users', 'sessions', 'telegramconnections', 'mltestcontrols', 'mltestcheckpoints',
    'mltestcheckpointchunks', 'mltestarchives', '$cmd']) {
    assert.throws(() => M.scopeFilter(name, config), { code: 'CHECKPOINT_COLLECTION_FORBIDDEN' });
  }
});
test('the three models opt out of implicit provisioning and declare only additive indexes', () => {
  const models = [require('../src/models/MlTestControl'), require('../src/models/MlTestCheckpoint'), require('../src/models/MlTestCheckpointChunk')];
  for (const model of models) { assert.equal(model.schema.options.autoCreate, false); assert.equal(model.schema.options.autoIndex, false); }
  assert(models[0].schema.indexes().some(([key, spec]) => key.businessId === 1 && spec.unique));
  assert(models[1].schema.indexes().some(([key, spec]) => key.checkpointId === 1 && spec.unique));
  assert(models[1].schema.indexes().some(([key]) => key.status === 1));
  assert(models[2].schema.indexes().some(([key, spec]) => key.checkpointId === 1 && key.collection === 1 && key.chunkIndex === 1 && spec.unique));
});
test('capture is refused for cloud, normal local databases or absent local quiescence', async () => {
  assert.throws(() => S.assertLocalTarget({ options: { srvHost: 'example.mongodb.net' } }, { databaseName }), { code: 'CHECKPOINT_LOCAL_TEST_DATABASE_REQUIRED' });
  assert.throws(() => S.assertLocalTarget(local, { databaseName: 'inventory_billing' }), { code: 'CHECKPOINT_LOCAL_TEST_DATABASE_REQUIRED' });
  await assert.rejects(S.captureLocalCheckpoint({ client: local, db: { databaseName } }), { code: 'CHECKPOINT_LOCAL_QUIESCENCE_REQUIRED' });
});
test('cloud preflight validates only the explicit env, rejects insecure targets and prints no credentials', () => {
  assert.throws(() => environment({}), { code: 'CHECKPOINT_CLOUD_ENV_REQUIRED' });
  const env = { FORECAST_CLOUD_MONGO_URI: 'mongodb+srv://fixture:fixture@fixture.mongodb.net/demo',
    FORECAST_CLOUD_EXPECTED_DATABASE: 'demo', FORECAST_CLOUD_EXPECTED_BUSINESS_ID: config.businessId,
    FORECAST_CLOUD_EXPECTED_SCENARIO_ID: config.scenarioId };
  assert.equal(environment(env).database, 'demo');
  assert.throws(() => environment({ ...env, FORECAST_CLOUD_MONGO_URI: `${env.FORECAST_CLOUD_MONGO_URI}?tls=false` }), { code: 'CHECKPOINT_CLOUD_TARGET_INVALID' });
  assert.equal(S.codeOf(new Error('a secret from a driver')), 'CHECKPOINT_OPERATION_FAILED');
});
test('read-limit preflight diagnostic reports bounded aggregate progress without error text or secrets', () => {
  const report = failureReport(Object.assign(new Error('mongodb+srv://user:secret@host/db'), { code: 'CHECKPOINT_READ_LIMIT_EXCEEDED',
    readDiagnostics: { limitCause: 'ELAPSED_TIME_BUDGET', limits: { readLimitMs: 120000, maxTimeMsPerCursor: 45000, maxDocuments: 200000,
      maxBytes: 134217728, chunkTargetBytes: 4194304, chunkCountLimit: null }, collectionBytesAreLowerBounds: true,
    progress: { elapsedMs: 45001, totalDocuments: 120, totalBsonBytes: 9000, totalEstimatedChunks: 4,
      completedCollections: [{ collection: 'transactions', documents: 100, bsonBytes: 7500, estimatedChunks: 3 }],
      currentCollection: { collection: 'products', documentsRead: 20, bsonBytesRead: 1500,
        estimatedChunks: 1, largestDocumentBytesRead: 500 } } } }));
  assert.equal(report.code, 'CHECKPOINT_READ_LIMIT_EXCEEDED');
  assert.equal(report.readLimit.configured.readLimitMs, 120000);
  assert.equal(report.readLimit.configured.maxTimeMsPerCursor, 45000);
  assert.equal(report.readLimit.progress.currentCollection.collection, 'products');
  assert.equal(report.readLimit.progress.completedCollections[0].bsonBytes, 7500);
  assert.equal(report.readLimit.progress.largestMeasuredCollection.collection, 'transactions');
  assert(!JSON.stringify(report).includes('secret'));
  assert(!JSON.stringify(report).includes('mongodb'));
  assert(!Object.hasOwn(report, 'message'));
});
test('source byte-limit diagnostics identify the crossed limit and keep full snapshot size unknown', () => {
  const report = failureReport(Object.assign(new Error('private driver detail'), { code: 'CHECKPOINT_SOURCE_LIMIT_EXCEEDED',
    readDiagnostics: { limitCause: 'SOURCE_VOLUME_LIMIT', limitsExceeded: ['MAX_BYTES'],
      limits: { readLimitMs: 120000, maxTimeMsPerCursor: 45000, maxDocuments: 200000,
        maxBytes: 128 * 1024 * 1024, chunkTargetBytes: 4 * 1024 * 1024, chunkCountLimit: null },
      collectionBytesAreLowerBounds: true,
      progress: { elapsedMs: 80000, totalDocuments: 60000, totalBsonBytes: 134217900, totalEstimatedChunks: 33,
        completedCollections: [{ collection: 'transactions', documents: 15000, bsonBytes: 58000000, estimatedChunks: 14 }],
        currentCollection: { collection: 'inventorymovements', documentsRead: 45000,
          bsonBytesRead: 76217900, estimatedChunks: 19 } } } }));
  assert.equal(report.sourceLimit.limitsExceeded[0], 'MAX_BYTES');
  assert.equal(report.sourceLimit.configured.maxBytes, 128 * 1024 * 1024);
  assert.equal(report.sourceLimit.minimumObservedSnapshotBytes, 134217900);
  assert.equal(report.sourceLimit.bytesOverLimitAtCutoff, 172);
  assert.equal(report.sourceLimit.completeSnapshotSizeEstimateBytes, null);
  assert.equal(report.sourceLimit.progress.currentCollection.collection, 'inventorymovements');
  assert(!JSON.stringify(report).includes('private driver detail'));
});
test('read-only preflight attaches exact bounded progress when the elapsed time budget expires', async () => {
  assert.equal(PREFLIGHT_READ_BUDGET_MS, 120000);
  assert.equal(S.READ_LIMIT_MS, 45000);
  assert.equal(S.LIMIT_BYTES, 128 * 1024 * 1024);
  assert.equal(S.LIMIT_DOCUMENTS, 200000);
  const raw = BSON.serialize({ _id: 'sample' });
  let clockCalls = 0, inTransaction = false;
  const client = { startSession: () => ({ startTransaction: () => { inTransaction = true; },
    inTransaction: () => inTransaction, commitTransaction: async () => { inTransaction = false; },
    abortTransaction: async () => { inTransaction = false; }, endSession: async () => {} }) };
  const db = { databaseName: 'diagnostic-only', admin: () => ({ command: async () => ({ setName: 'test', isWritablePrimary: true }) }),
    listCollections: () => ({ toArray: async () => [] }), collection: name => ({
      findOne: async () => null,
      find: () => ({ sort() { return this; }, async *[Symbol.asyncIterator]() { if (name === 'transactions') yield raw; }, close: async () => {} })
    }) };
  const originalNow = Date.now;
  Date.now = () => ++clockCalls < 4 ? 1000 : 121001;
  try {
    await assert.rejects(S.preflightCheckpoint({ client, db, scope: config, elapsedLimitMs: PREFLIGHT_READ_BUDGET_MS }), error => {
      assert.equal(error.code, 'CHECKPOINT_READ_LIMIT_EXCEEDED');
      assert.equal(error.readDiagnostics.limitCause, 'ELAPSED_TIME_BUDGET');
      assert.equal(error.readDiagnostics.progress.currentCollection.collection, 'transactions');
      assert.equal(error.readDiagnostics.progress.currentCollection.documentsRead, 0);
      assert.equal(error.readDiagnostics.progress.currentCollection.fetchedAtLimit, true);
      assert.equal(error.readDiagnostics.progress.currentCollection.fetchedDocumentBytesAtLimit, raw.length);
      assert.equal(error.readDiagnostics.limits.readLimitMs, 120000);
      assert.equal(error.readDiagnostics.limits.maxTimeMsPerCursor, 45000);
      return true;
    });
  } finally { Date.now = originalNow; }
});
test('closedThrough uses the real Lima day, never a stored test date', () => {
  assert.equal(S.closedThrough(new Date('2026-10-18T04:59:59Z')), '2026-10-16');
  assert.equal(S.closedThrough(new Date('2026-10-18T05:00:00Z')), '2026-10-17');
});

async function storedFixture() {
  const checkpointId = randomUUID();
  const chunks = await collect(M.chunkDocuments([bufferFor({ _id: 1, businessId: config.businessId, stock: 50 })], 64));
  const collectionManifest = M.COLLECTIONS.map(({ collection }) => {
    const rows = collection === 'products' ? chunks : [];
    return { collection, filter: M.scopeFilter(collection, config), documentCount: collection === 'products' ? 1 : 0,
      byteCount: rows.reduce((sum, chunk) => sum + chunk.byteCount, 0), chunkCount: rows.length,
      largestDocumentBytes: 0, contentHash: M.digest(Buffer.concat(rows.map(chunk => chunk.payload))),
      chunks: rows.map(({ payload, ...meta }) => meta) };
  });
  const row = { checkpointId, businessId: config.businessId, scenarioId: config.scenarioId, schemaVersion: 1,
    status: 'CREATING', capturedAt: new Date('2026-10-18T18:00:00Z'), dataVersion: '5',
    observationsClosedThroughAtCapture: '2026-10-17', activeModels: [], registryPointers: [], artifactReferences: [],
    collectionManifest, documentCounts: {}, byteCounts: {}, hashes: {}, indexManifest: [], totalChunks: chunks.length,
    totalBytes: chunks.reduce((sum, chunk) => sum + chunk.byteCount, 0), chunkTargetBytes: 64 };
  for (const meta of collectionManifest) {
    row.documentCounts[meta.collection] = meta.documentCount; row.byteCounts[meta.collection] = meta.byteCount;
    row.hashes[meta.collection] = meta.contentHash;
  }
  row.hashes.manifest = M.hashValue(M.manifestContent(row));
  const stored = chunks.map(chunk => ({ checkpointId, collection: 'products', ...chunk }));
  const control = { state: 'CHECKPOINT_CREATING', resetEpoch: BSON.Long.fromNumber(9) };
  const db = { databaseName, collection(name) {
    if (name === 'mltestcheckpoints') return { findOne: async () => row, updateOne: async (_filter, change) => Object.assign(row, change.$set) };
    if (name === 'mltestcontrols') return { updateOne: async (_filter, change) => Object.assign(control, change.$set) };
    assert.equal(name, 'mltestcheckpointchunks');
    return { countDocuments: async () => stored.length, find: filter => ({ sort: () => ({
      async *[Symbol.asyncIterator]() { yield* stored.filter(chunk => chunk.collection === filter.collection); }, async close() {} }) }) };
  } };
  return { db, row, stored, control, checkpointId };
}
test('complete stored manifest is verified after rereading chunks', async () => {
  const fixture = await storedFixture();
  const result = await S.verifyLocalCheckpoint({ client: local, db: fixture.db, checkpointId: fixture.checkpointId });
  assert.equal(result.verified, true); assert.equal(result.documentCounts.products, 1);
  assert.equal(result.totalChunks, fixture.stored.length);
});
test('corrupt stored bytes mark checkpoint/control FAILED without decreasing resetEpoch', async () => {
  const fixture = await storedFixture(); fixture.stored[0].payload[10] ^= 1;
  await assert.rejects(S.verifyLocalCheckpoint({ client: local, db: fixture.db, checkpointId: fixture.checkpointId }), { code: 'CHECKPOINT_CHUNK_INVALID' });
  assert.equal(fixture.row.status, 'FAILED'); assert.equal(fixture.control.state, 'FAILED');
  assert.equal(fixture.control.resetEpoch.toString(), '9');
});
test('tampered metadata and extra chunks cannot verify', async () => {
  const meta = await storedFixture(); meta.row.dataVersion = '999';
  await assert.rejects(S.verifyLocalCheckpoint({ client: local, db: meta.db, checkpointId: meta.checkpointId }), { code: 'CHECKPOINT_MANIFEST_HASH_MISMATCH' });
  const extra = await storedFixture(); extra.stored.push({ ...extra.stored[0], collection: 'users' });
  await assert.rejects(S.verifyLocalCheckpoint({ client: local, db: extra.db, checkpointId: extra.checkpointId }), { code: 'CHECKPOINT_TOTALS_INVALID' });
});
