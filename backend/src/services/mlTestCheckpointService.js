'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { Long } = require('mongoose').mongo.BSON;
const M = require('./mlTestCheckpointManifest');
const config = require('../config/v3Operational');
const NAMES = ['mltestcontrols', 'mltestcheckpoints', 'mltestcheckpointchunks'];
const LIMIT_BYTES = 128 * 1024 * 1024;
const LIMIT_DOCUMENTS = 200000;
const READ_LIMIT_MS = 45000;
const MAX_PREFLIGHT_READ_LIMIT_MS = 120000;
const codeOf = error => typeof error?.code === 'string' && /^CHECKPOINT_[A-Z_]+$/.test(error.code)
  ? error.code : error?.code === 50 ? 'CHECKPOINT_READ_LIMIT_EXCEEDED'
    : ['MongoServerSelectionError', 'MongoNetworkError'].includes(error?.name) ? 'CHECKPOINT_MONGO_UNAVAILABLE'
      : error?.code === 251 ? 'CHECKPOINT_SNAPSHOT_TRANSACTION_FAILED' : 'CHECKPOINT_OPERATION_FAILED';

function assertLocalTarget(client, db) {
  const hosts = client.options?.hosts;
  if (client.options?.srvHost || !hosts?.length || hosts.some(host => !['localhost', '127.0.0.1', '::1'].includes(host.host))
      || !/^ml_checkpoint_[a-f0-9]{32}_test$/.test(db.databaseName)) M.fail('CHECKPOINT_LOCAL_TEST_DATABASE_REQUIRED');
}
async function assertReplicaSet(db) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName || !hello.isWritablePrimary) M.fail('CHECKPOINT_REPLICA_SET_REQUIRED');
}
// Only the three new namespaces are provisioned, and only in disposable LOCAL
// test databases. Source indexes and collections are never changed here.
async function provisionLocal(client, db) {
  assertLocalTarget(client, db);
  await assertReplicaSet(db);
  const models = [require('../models/MlTestControl'), require('../models/MlTestCheckpoint'), require('../models/MlTestCheckpointChunk')];
  for (let i = 0; i < models.length; i++) {
    try { await db.createCollection(NAMES[i]); } catch (error) { if (error.code !== 48) throw error; }
    for (const [key, options] of models[i].schema.indexes()) await db.collection(NAMES[i]).createIndex(key, options);
  }
}
function closedThrough(capturedAt) {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(capturedAt);
  return new Date(Date.parse(`${local}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
async function indexManifest(db) {
  const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name));
  const output = [];
  for (const { collection } of M.COLLECTIONS) {
    const indexes = present.has(collection) ? await db.collection(collection).listIndexes().toArray() : [];
    output.push({ collection, exists: present.has(collection), indexes: indexes
      .map(index => ({ ...index, key: Object.entries(index.key) })).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  return output;
}
async function withSnapshot(client, db, work) {
  await assertReplicaSet(db);
  const session = client.startSession({ causalConsistency: false });
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
    const value = await work(session);
    await session.commitTransaction();
    return value;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    throw error;
  } finally { await session.endSession(); }
}
function summarizeDocument(collection, raw, result) {
  if (!['v3operationalrevisions', 'forecastmodelregistries', 'forecastmodelartifacts'].includes(collection)) return;
  const doc = M.BSON.deserialize(raw, { promoteLongs: false });
  if (collection === 'v3operationalrevisions') {
    if (doc.revision == null || !/^(0|[1-9]\d*)$/.test(doc.revision.toString())) M.fail('CHECKPOINT_REVISION_INVALID');
    result.dataVersion = doc.revision.toString();
  } else if (collection === 'forecastmodelregistries') {
    result.registryPointers.push({ horizonDays: doc.horizonDays, activeModelVersion: doc.activeModelVersion,
      activeArtifactId: doc.activeArtifactId ?? null, generation: doc.generation,
      lastIssuedModelVersion: doc.lastIssuedModelVersion ?? null });
  } else {
    result.artifactReferences.push({ artifactId: doc._id, horizonDays: doc.horizonDays, modelVersion: doc.modelVersion,
      status: doc.status, artifactHash: doc.artifactHash ?? null, artifactBytes: doc.artifactBytes,
      actualArtifactBytes: doc.artifactData == null ? null : M.bytesOf(doc.artifactData).length });
    if (doc.status === 'ACTIVE') result.activeModels.push({ horizonDays: doc.horizonDays, modelVersion: doc.modelVersion,
      artifactId: doc._id, trainedDataVersion: doc.trainedDataVersion ?? null,
      dataCutoff: doc.dataCutoff ?? null, artifactHash: doc.artifactHash ?? null });
  }
}
async function scanSource({ client, db, scope, targetBytes = M.TARGET_BYTES, onChunk, onProgress,
  elapsedLimitMs = READ_LIMIT_MS, cursorMaxTimeMs = READ_LIMIT_MS }) {
  scope = M.authorizedScope(scope);
  const started = Date.now();
  const beforeIndexes = await indexManifest(db);
  const result = { collectionManifest: [], documentCounts: {}, byteCounts: {}, hashes: {}, totalBytes: 0,
    totalChunks: 0, dataVersion: null, activeModels: [], registryPointers: [], artifactReferences: [], totalDocuments: 0 };
  let currentProgress = null;
  const progress = onProgress ? { elapsedMs: 0, totalDocuments: 0, totalBsonBytes: 0, totalEstimatedChunks: 0,
    completedCollections: [], currentCollection: null } : null;
  const reportProgress = () => {
    if (!progress) return;
    progress.elapsedMs = Date.now() - started; progress.totalDocuments = result.totalDocuments;
    progress.totalBsonBytes = result.totalBytes;
    progress.totalEstimatedChunks = result.totalChunks + (currentProgress?.estimatedChunks ?? 0);
    progress.currentCollection = currentProgress;
    onProgress?.(progress);
  };
  await withSnapshot(client, db, async session => {
    // Revision belongs to the tenant, so another imported scenario is not a
    // safely isolated restore boundary. Refuse that ambiguity.
    if (await db.collection('historicalscenarios').findOne({ businessId: scope.businessId,
      scenarioId: { $ne: scope.scenarioId } }, { session, projection: { _id: 1 }, maxTimeMS: 5000 })) M.fail('CHECKPOINT_TENANT_SCOPE_AMBIGUOUS');
    for (const { collection } of M.COLLECTIONS) {
      const hash = createHash('sha256');
      let documentCount = 0, byteCount = 0, chunkCount = 0, largestDocumentBytes = 0;
      currentProgress = progress ? { collection, documentsRead: 0, bsonBytesRead: 0, estimatedChunks: 0,
        largestDocumentBytesRead: 0 } : null;
      reportProgress();
      const chunks = [];
      const cursor = db.collection(collection).find(M.scopeFilter(collection, scope), { session, raw: true,
        batchSize: 100, maxTimeMS: cursorMaxTimeMs }).sort({ _id: 1 });
      async function* documents() {
        try {
          for await (const raw of cursor) {
            if (Date.now() - started > elapsedLimitMs) {
              if (currentProgress) {
                currentProgress.fetchedAtLimit = true;
                currentProgress.fetchedDocumentBytesAtLimit = Buffer.isBuffer(raw) ? raw.length : null;
                reportProgress();
              }
              M.fail('CHECKPOINT_READ_LIMIT_EXCEEDED');
            }
            if (!Buffer.isBuffer(raw)) M.fail('CHECKPOINT_RAW_BSON_REQUIRED');
            result.totalDocuments++; result.totalBytes += raw.length;
            largestDocumentBytes = Math.max(largestDocumentBytes, raw.length);
            if (currentProgress) {
              currentProgress.documentsRead++; currentProgress.bsonBytesRead += raw.length;
              currentProgress.largestDocumentBytesRead = largestDocumentBytes; reportProgress();
            }
            if (result.totalBytes > LIMIT_BYTES || result.totalDocuments > LIMIT_DOCUMENTS) M.fail('CHECKPOINT_SOURCE_LIMIT_EXCEEDED');
            summarizeDocument(collection, raw, result);
            yield raw;
          }
        } finally { await cursor.close(); }
      }
      for await (const chunk of M.chunkDocuments(documents(), targetBytes)) {
        hash.update(chunk.payload); byteCount += chunk.byteCount; documentCount += chunk.documentCount; chunkCount++;
        if (currentProgress) { currentProgress.estimatedChunks = chunkCount; reportProgress(); }
        chunks.push({ chunkIndex: chunk.chunkIndex, documentCount: chunk.documentCount,
          byteCount: chunk.byteCount, contentHash: chunk.contentHash });
        if (onChunk) await onChunk(collection, chunk);
      }
      const contentHash = hash.digest('hex');
      result.totalChunks += chunkCount;
      result.documentCounts[collection] = documentCount; result.byteCounts[collection] = byteCount; result.hashes[collection] = contentHash;
      result.collectionManifest.push({ collection, filter: M.scopeFilter(collection, scope), documentCount,
        byteCount, chunkCount, largestDocumentBytes, contentHash, chunks });
      if (progress) progress.completedCollections.push({ collection, documents: documentCount, bsonBytes: byteCount,
        estimatedChunks: chunkCount });
      currentProgress = null; reportProgress();
    }
  });
  if (result.dataVersion === null) M.fail('CHECKPOINT_REVISION_MISSING');
  const afterIndexes = await indexManifest(db);
  if (M.hashValue({ indexes: beforeIndexes }) !== M.hashValue({ indexes: afterIndexes })) M.fail('CHECKPOINT_SOURCE_INDEXES_CHANGED');
  return { ...result, indexManifest: beforeIndexes, readDurationMs: Date.now() - started };
}

async function acquireControl(db, scope, checkpointId, capturedAt) {
  const controls = db.collection(NAMES[0]);
  try {
    await controls.updateOne({ businessId: scope.businessId }, { $setOnInsert: { businessId: scope.businessId,
      activeCheckpointId: null, testCycleId: null, state: 'NO_TEST', resetEpoch: Long.ZERO,
      createdAt: capturedAt, updatedAt: capturedAt, failureCode: null } }, { upsert: true, writeConcern: { w: 'majority' } });
  } catch (error) { if (error.code !== 11000) throw error; }
  const row = await controls.findOneAndUpdate({ businessId: scope.businessId, state: 'NO_TEST',
    activeCheckpointId: null, resetEpoch: { $gte: Long.ZERO, $lt: Long.MAX_VALUE } }, {
    $set: { activeCheckpointId: checkpointId, testCycleId: randomUUID(), state: 'CHECKPOINT_CREATING',
      updatedAt: capturedAt, failureCode: null }, $inc: { resetEpoch: Long.ONE }
  }, { returnDocument: 'after', promoteLongs: false, writeConcern: { w: 'majority' } });
  if (!row) M.fail('CHECKPOINT_CONTROL_BUSY');
  return row;
}
async function verifyStored(db, checkpointId, scope) {
  scope = M.authorizedScope(scope);
  const row = await db.collection(NAMES[1]).findOne({ checkpointId, ...scope });
  if (!row || !['CREATING', 'READY'].includes(row.status) || row.schemaVersion !== 1) M.fail('CHECKPOINT_MANIFEST_INVALID');
  if (row.collectionManifest?.length !== M.COLLECTIONS.length || new Set(row.collectionManifest.map(m => m.collection)).size !== M.COLLECTIONS.length
      || row.hashes?.manifest !== M.hashValue(M.manifestContent(row))) M.fail('CHECKPOINT_MANIFEST_HASH_MISMATCH');
  let totalBytes = 0, totalChunks = 0;
  for (let position = 0; position < M.COLLECTIONS.length; position++) {
    const entry = row.collectionManifest[position];
    if (entry.collection !== M.COLLECTIONS[position].collection
        || M.hashValue({ filter: entry.filter }) !== M.hashValue({ filter: M.scopeFilter(entry.collection, scope) })) M.fail('CHECKPOINT_SCOPE_INVALID');
    const hash = createHash('sha256'), frames = new M.FrameVerifier();
    let chunkCount = 0, byteCount = 0;
    const cursor = db.collection(NAMES[2]).find({ checkpointId, collection: entry.collection }).sort({ chunkIndex: 1 });
    try {
      for await (const chunk of cursor) {
        const payload = M.bytesOf(chunk.payload), expected = entry.chunks[chunkCount];
        if (!expected || chunk.chunkIndex !== chunkCount || expected.chunkIndex !== chunkCount
            || payload.length !== chunk.byteCount || payload.length > row.chunkTargetBytes || chunk.byteCount !== expected.byteCount
            || M.digest(payload) !== chunk.contentHash || chunk.contentHash !== expected.contentHash
            || frames.feed(payload) !== chunk.documentCount || chunk.documentCount !== expected.documentCount) M.fail('CHECKPOINT_CHUNK_INVALID');
        byteCount += payload.length; chunkCount++; hash.update(payload);
      }
    } finally { await cursor.close(); }
    if (frames.finish() !== entry.documentCount || byteCount !== entry.byteCount || chunkCount !== entry.chunkCount
        || hash.digest('hex') !== entry.contentHash || row.documentCounts[entry.collection] !== entry.documentCount
        || row.byteCounts[entry.collection] !== byteCount || row.hashes[entry.collection] !== entry.contentHash) M.fail('CHECKPOINT_COLLECTION_INVALID');
    totalBytes += byteCount; totalChunks += chunkCount;
  }
  if (totalBytes !== row.totalBytes || totalChunks !== row.totalChunks
      || await db.collection(NAMES[2]).countDocuments({ checkpointId }) !== totalChunks) M.fail('CHECKPOINT_TOTALS_INVALID');
  return { checkpointId, verified: true, totalBytes, totalChunks, documentCounts: row.documentCounts };
}
async function markFailed(db, checkpointId, scope, error) {
  const failureCode = codeOf(error);
  await db.collection(NAMES[1]).updateOne({ checkpointId, ...scope }, { $set: { status: 'FAILED', failureCode, updatedAt: new Date() } });
  await db.collection(NAMES[0]).updateOne({ businessId: scope.businessId, activeCheckpointId: checkpointId },
    { $set: { state: 'FAILED', failureCode, updatedAt: new Date() } });
}
async function assertQuiescent(db, scope) {
  for (const [collection, filter] of [
    ['forecastmlupdatestates', { ...scope, $or: [{ status: 'CLAIMED' }, { manualPending: true }] }],
    ['forecasttrainingjobs', { ...scope, status: { $in: ['CLAIMED', 'TRAINING', 'EVALUATING', 'PERSISTING'] } }],
    ['forecastmlupdateexecutions', { ...scope, stage: { $ne: 'FINISHED' } }],
    ['inventoryalertoutboxevents', { businessId: scope.businessId, status: 'IN_FLIGHT' }],
    ['inventoryalertchanneldeliveries', { businessId: scope.businessId, status: 'IN_FLIGHT' }],
    ['automationruns', { businessId: scope.businessId, status: 'RUNNING' }]
  ]) {
    if (await db.collection(collection).findOne(filter, { projection: { _id: 1 }, maxTimeMS: 5000 })) M.fail('CHECKPOINT_SOURCE_BUSY');
  }
}
async function captureLocalCheckpoint({ client, db, scope, localWritersPaused = false, createdBy = null, targetBytes = M.TARGET_BYTES }) {
  assertLocalTarget(client, db); scope = M.authorizedScope(scope);
  if (localWritersPaused !== true) M.fail('CHECKPOINT_LOCAL_QUIESCENCE_REQUIRED');
  if (createdBy !== null && (typeof createdBy !== 'string' || createdBy.length > 160)) M.fail('CHECKPOINT_ACTOR_INVALID');
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 64 || targetBytes > M.TARGET_BYTES) M.fail('CHECKPOINT_CHUNK_TARGET_INVALID');
  await provisionLocal(client, db);
  await assertQuiescent(db, scope);
  const checkpointId = randomUUID(), capturedAt = new Date();
  const control = await acquireControl(db, scope, checkpointId, capturedAt);
  try {
    await db.collection(NAMES[1]).insertOne({ checkpointId, ...scope, createdBy, status: 'CREATING', capturedAt,
      createdAt: capturedAt, updatedAt: capturedAt, schemaVersion: 1, failureCode: null,
      observationsClosedThroughAtCapture: closedThrough(capturedAt), chunkTargetBytes: targetBytes,
      totalBytes: 0, totalChunks: 0 });
    const snapshot = await scanSource({ client, db, scope, targetBytes,
      onChunk: (collection, chunk) => db.collection(NAMES[2]).insertOne({ checkpointId, collection, ...chunk }) });
    const { readDurationMs, totalDocuments, ...captured } = snapshot;
    const row = { checkpointId, ...scope, capturedAt, schemaVersion: 1, chunkTargetBytes: targetBytes,
      observationsClosedThroughAtCapture: closedThrough(capturedAt), ...captured };
    row.hashes.manifest = M.hashValue(M.manifestContent(row));
    await db.collection(NAMES[1]).updateOne({ checkpointId, ...scope, status: 'CREATING' }, { $set: { ...captured,
      hashes: row.hashes, updatedAt: new Date() } });
    const verified = await verifyStored(db, checkpointId, scope);
    const session = client.startSession();
    try {
      session.startTransaction({ writeConcern: { w: 'majority' } });
      const result = await db.collection(NAMES[0]).updateOne({ businessId: scope.businessId, activeCheckpointId: checkpointId,
        resetEpoch: control.resetEpoch, state: 'CHECKPOINT_CREATING' }, { $set: { state: 'TEST_ACTIVE', updatedAt: new Date() } }, { session });
      if (result.matchedCount !== 1) M.fail('CHECKPOINT_CONTROL_CONFLICT');
      const ready = await db.collection(NAMES[1]).updateOne({ checkpointId, ...scope, status: 'CREATING' },
        { $set: { status: 'READY', updatedAt: new Date() } }, { session });
      if (ready.matchedCount !== 1) M.fail('CHECKPOINT_CONTROL_CONFLICT');
      await session.commitTransaction();
    } catch (error) { if (session.inTransaction()) await session.abortTransaction(); throw error; }
    finally { await session.endSession(); }
    return { ...verified, status: 'READY', resetEpoch: control.resetEpoch.toString(), readDurationMs, totalDocuments };
  } catch (error) { await markFailed(db, checkpointId, scope, error); throw error; }
}
async function verifyLocalCheckpoint({ client, db, checkpointId, scope }) {
  assertLocalTarget(client, db); scope = M.authorizedScope(scope);
  try { return await verifyStored(db, checkpointId, scope); }
  catch (error) { await markFailed(db, checkpointId, scope, error); throw error; }
}
// No models are initialized, no control is acquired and no snapshot is saved.
// This path issues only metadata reads and a read-only snapshot transaction.
async function preflightCheckpoint({ client, db, scope, elapsedLimitMs = READ_LIMIT_MS }) {
  if (!Number.isSafeInteger(elapsedLimitMs) || elapsedLimitMs < READ_LIMIT_MS
      || elapsedLimitMs > MAX_PREFLIGHT_READ_LIMIT_MS) M.fail('CHECKPOINT_READ_LIMIT_INVALID');
  const started = Date.now();
  let readProgress = null;
  let report;
  try { report = await scanSource({ client, db, scope, elapsedLimitMs,
    onProgress: value => { readProgress = value; } }); }
  catch (error) {
    const errorCode = codeOf(error);
    if (['CHECKPOINT_READ_LIMIT_EXCEEDED', 'CHECKPOINT_SOURCE_LIMIT_EXCEEDED'].includes(errorCode)) error.readDiagnostics = {
      limitCause: errorCode === 'CHECKPOINT_SOURCE_LIMIT_EXCEEDED' ? 'SOURCE_VOLUME_LIMIT'
        : error.code === 50 ? 'MONGO_MAX_TIME_MS' : 'ELAPSED_TIME_BUDGET',
      limitsExceeded: errorCode === 'CHECKPOINT_SOURCE_LIMIT_EXCEEDED'
        ? [readProgress?.totalBsonBytes > LIMIT_BYTES ? 'MAX_BYTES' : null,
          readProgress?.totalDocuments > LIMIT_DOCUMENTS ? 'MAX_DOCUMENTS' : null].filter(Boolean) : [],
      limits: { readLimitMs: elapsedLimitMs, maxTimeMsPerCursor: READ_LIMIT_MS,
        maxDocuments: LIMIT_DOCUMENTS, maxBytes: LIMIT_BYTES, chunkTargetBytes: M.TARGET_BYTES,
        chunkCountLimit: null },
      collectionBytesAreLowerBounds: true,
      progress: readProgress ? { ...readProgress, elapsedMs: Date.now() - started,
        completedCollections: readProgress.completedCollections.map(row => ({ ...row })),
        currentCollection: readProgress.currentCollection ? { ...readProgress.currentCollection } : null } : null
    };
    throw error;
  }
  const largest = report.collectionManifest.reduce((max, row) => row.byteCount > (max?.byteCount ?? -1) ? row : max, null);
  return { status: 'OK', mode: 'READ_ONLY', snapshotViableWithinConfiguredReadLimits: true, cloudRestoreEnabled: false,
    writes: 0, dataVersion: report.dataVersion, totalDocuments: report.totalDocuments, totalBsonBytes: report.totalBytes,
    totalEstimatedChunks: report.totalChunks, readDurationMs: report.readDurationMs,
    largestCollection: largest?.collection ?? null, activeArtifactSizes: report.artifactReferences
      .filter(row => row.status === 'ACTIVE').map(row => ({ horizonDays: row.horizonDays,
        declaredArtifactBytes: row.artifactBytes, actualArtifactBytes: row.actualArtifactBytes })),
    collections: report.collectionManifest.map(row => ({ collection: row.collection, documentCount: row.documentCount,
      bsonBytes: row.byteCount, estimatedChunks: row.chunkCount, largestDocumentBytes: row.largestDocumentBytes })) };
}
module.exports = { captureLocalCheckpoint, verifyLocalCheckpoint, preflightCheckpoint, provisionLocal,
  assertLocalTarget, closedThrough, codeOf, LIMIT_BYTES, LIMIT_DOCUMENTS, READ_LIMIT_MS,
  MAX_PREFLIGHT_READ_LIMIT_MS };
