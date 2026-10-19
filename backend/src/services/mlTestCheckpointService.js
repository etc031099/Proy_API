'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { Long } = require('mongoose').mongo.BSON;
const M = require('./mlTestCheckpointManifest');
const config = require('../config/v3Operational');
const D = require('./mlTestCheckpointDiagnostics');
const CAPTURE_PROTOCOL = 'SNAPSHOT_SESSION_V1';
const { LIMITS, budget } = require('./mlTestOperationBudget');
const NAMES = ['mltestcontrols', 'mltestcheckpoints', 'mltestcheckpointchunks'];
const LIMIT_BYTES = 128 * 1024 * 1024;
const LIMIT_DOCUMENTS = 200000;
const READ_LIMIT_MS = 45000;
const MAX_PREFLIGHT_READ_LIMIT_MS = 120000;
const codeOf = error => typeof error?.code === 'string' && /^CHECKPOINT_[A-Z_]+$/.test(error.code)
  ? error.code : error?.code === 50 ? 'CHECKPOINT_READ_LIMIT_EXCEEDED'
    : ['MongoServerSelectionError', 'MongoNetworkError'].includes(error?.name) ? 'CHECKPOINT_MONGO_UNAVAILABLE'
      : error?.code === 251 ? 'CHECKPOINT_SNAPSHOT_TRANSACTION_FAILED'
        : error?.code === 286 ? 'CHECKPOINT_SNAPSHOT_TOO_OLD'
          : error?.code === 246 ? 'CHECKPOINT_SNAPSHOT_UNAVAILABLE' : 'CHECKPOINT_OPERATION_FAILED';

function assertLocalTarget(client, db) {
  const hosts = client.options?.hosts;
  if (client.options?.srvHost || !hosts?.length || hosts.some(host => !['localhost', '127.0.0.1', '::1'].includes(host.host))
      || !/^ml_checkpoint_[a-f0-9]{32}_test$/.test(db.databaseName)) M.fail('CHECKPOINT_LOCAL_TEST_DATABASE_REQUIRED');
}
function assertExecutionTarget(client, db, authorization) {
  if (!require('./mlTestTargetAuthorization').authorized(client, db, authorization)) assertLocalTarget(client, db);
}
async function assertReplicaSet(db) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName || !hello.isWritablePrimary) M.fail('CHECKPOINT_REPLICA_SET_REQUIRED');
}
// Only the three administrative namespaces are provisioned: disposable LOCAL
// databases or an explicit admin/certification capability for the demo target.
// Source indexes and collections are never changed here.
async function provisionLocal(client, db, authorization) {
  assertExecutionTarget(client, db, authorization);
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
  // The driver pins the first majority-committed atClusterTime and reuses it
  // for every read in this session. There is NO long-running transaction.
  // Requires MongoDB 5.0+; unsupported/expired snapshots fail closed, no fallback.
  const session = client.startSession({ snapshot: true, causalConsistency: false });
  let failure;
  try {
    return await work(session);
  } catch (error) { failure = error; throw error; }
  finally { try { await session.endSession(); } catch (error) { if (!failure) throw error; } }
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
  elapsedLimitMs = READ_LIMIT_MS, cursorMaxTimeMs = READ_LIMIT_MS, onStage = () => {}, metrics = {} }) {
  scope = M.authorizedScope(scope);
  const started = Date.now();
  const checkBudget = budget(elapsedLimitMs);
  onStage({ phase: 'METADATA_READ', sessionPhase: 'NOT_OPEN', collection: null });
  const beforeIndexes = await indexManifest(db);
  Object.assign(metrics, { snapshotTransactionMs: 0, chunkWriteMs: 0, maxChunkBytes: 0 });
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
  const snapshotStarted = Date.now();
  try { await withSnapshot(client, db, async session => {
    // Revision belongs to the tenant, so another imported scenario is not a
    // safely isolated restore boundary. Refuse that ambiguity.
    onStage({ phase: 'TENANT_SCOPE_READ', sessionPhase: 'SNAPSHOT_OPEN', collection: 'historicalscenarios' });
    if (await db.collection('historicalscenarios').findOne({ businessId: scope.businessId,
      scenarioId: { $ne: scope.scenarioId } }, { session, readConcern: { level: 'snapshot' }, readPreference: 'primary', projection: { _id: 1 }, maxTimeMS: 5000 })) M.fail('CHECKPOINT_TENANT_SCOPE_AMBIGUOUS');
    for (const { collection } of M.COLLECTIONS) {
      onStage({ phase: 'SOURCE_READ', collection });
      const hash = createHash('sha256');
      let documentCount = 0, byteCount = 0, chunkCount = 0, largestDocumentBytes = 0;
      currentProgress = progress ? { collection, documentsRead: 0, bsonBytesRead: 0, estimatedChunks: 0,
        largestDocumentBytesRead: 0 } : null;
      reportProgress();
      const chunks = [];
      const cursor = db.collection(collection).find(M.scopeFilter(collection, scope), { session, raw: true,
        readConcern: { level: 'snapshot' }, readPreference: 'primary',
        batchSize: 100, maxTimeMS: cursorMaxTimeMs }).sort({ _id: 1 });
      async function* documents() {
        try {
          for await (const raw of cursor) {
            const rss = process.memoryUsage().rss;
            metrics.peakRssBytes = Math.max(metrics.peakRssBytes || 0, rss);
            if (rss > LIMITS.maxRssBytes) M.fail('CHECKPOINT_MEMORY_LIMIT_EXCEEDED');
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
        if (result.totalChunks + chunkCount > LIMITS.maxChunks) M.fail('CHECKPOINT_CHUNK_LIMIT_EXCEEDED');
        if (currentProgress) { currentProgress.estimatedChunks = chunkCount; reportProgress(); }
        chunks.push({ chunkIndex: chunk.chunkIndex, documentCount: chunk.documentCount,
          byteCount: chunk.byteCount, contentHash: chunk.contentHash });
        metrics.maxChunkBytes = Math.max(metrics.maxChunkBytes, chunk.byteCount);
        if (onChunk) {
          onStage({ phase: 'CHUNK_WRITE', collection });
          const writeStarted = Date.now();
          try { await onChunk(collection, chunk); }
          finally { metrics.chunkWriteMs += Date.now() - writeStarted; }
          onStage({ phase: 'SOURCE_READ', collection });
        }
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
  }); } finally { metrics.snapshotSessionMs = Date.now() - snapshotStarted; }
  if (result.dataVersion === null) M.fail('CHECKPOINT_REVISION_MISSING');
  checkBudget();
  onStage({ phase: 'METADATA_VERIFY', sessionPhase: 'SNAPSHOT_CLOSED', collection: null });
  const afterIndexes = await indexManifest(db);
  if (M.hashValue({ indexes: beforeIndexes }) !== M.hashValue({ indexes: afterIndexes })) M.fail('CHECKPOINT_SOURCE_INDEXES_CHANGED');
  metrics.bytesStreamed = result.totalBytes;
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
      updatedAt: capturedAt, epochChangedAt: capturedAt, failureCode: null }, $inc: { resetEpoch: Long.ONE }
  }, { returnDocument: 'after', promoteLongs: false, writeConcern: { w: 'majority' } });
  if (!row) M.fail('CHECKPOINT_CONTROL_BUSY');
  return row;
}
async function verifyStored(db, checkpointId, scope, checkOperation = () => {}) {
  const checkBudget = budget(LIMITS.verificationMs);
  scope = M.authorizedScope(scope);
  const row = await db.collection(NAMES[1]).findOne({ checkpointId, ...scope }, { promoteLongs: false });
  if (!row || !['CREATING', 'READY'].includes(row.status) || row.schemaVersion !== 1) M.fail('CHECKPOINT_MANIFEST_INVALID');
  if (!Number.isSafeInteger(row.totalBytes) || row.totalBytes < 0 || row.totalBytes > LIMIT_BYTES
      || !Number.isSafeInteger(row.totalChunks) || row.totalChunks < 0 || row.totalChunks > LIMITS.maxChunks
      || Object.values(row.documentCounts || {}).some(value => !Number.isSafeInteger(value) || value < 0)
      || Object.values(row.documentCounts || {}).reduce((sum, value) => sum + value, 0) > LIMIT_DOCUMENTS) M.fail('CHECKPOINT_TOTALS_INVALID');
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
        checkOperation();
        checkBudget();
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
async function markFailed(db, checkpointId, scope, error, diagnostics = {}) {
  const failureCode = codeOf(error);
  await db.collection(NAMES[1]).updateOne({ checkpointId, ...scope }, { $set: { status: 'FAILED', failureCode,
    ...diagnostics, updatedAt: new Date() } });
  await db.collection(NAMES[0]).updateOne({ businessId: scope.businessId, activeCheckpointId: checkpointId },
    { $set: { state: 'FAILED', failureCode, updatedAt: new Date() } });
}
async function assertQuiescent(db, scope, { session } = {}) {
  for (const [collection, filter] of [
    ['forecastmlupdatestates', { ...scope, $or: [{ status: 'CLAIMED' }, { manualPending: true }] }],
    ['forecasttrainingjobs', { ...scope, status: { $in: ['CLAIMED', 'TRAINING', 'EVALUATING', 'PERSISTING'] } }],
    ['forecastmlupdateexecutions', { ...scope, stage: { $ne: 'FINISHED' } }],
    ['inventoryalertoutboxevents', { businessId: scope.businessId, status: 'IN_FLIGHT' }],
    ['inventoryalertchanneldeliveries', { businessId: scope.businessId, status: 'IN_FLIGHT' }],
    ['automationruns', { businessId: scope.businessId, status: 'RUNNING' }]
  ]) {
    if (await db.collection(collection).findOne(filter, { session, projection: { _id: 1 }, maxTimeMS: 5000 })) M.fail('CHECKPOINT_SOURCE_BUSY');
  }
}
async function captureCheckpoint({ client, db, scope, localWritersPaused = false, createdBy = null, targetBytes = M.TARGET_BYTES,
  authorization, logDiagnostic = D.logFailure }, operational) {
  assertExecutionTarget(client, db, authorization); scope = M.authorizedScope(scope);
  const checkOperation = budget(LIMITS.captureMs);
  // A caller assertion is retained ONLY for disposable local certification.
  // Cloud always requires the operative state transition and durable drain.
  if (!operational && (localWritersPaused !== true
      || require('./mlTestTargetAuthorization').authorized(client, db, authorization))) M.fail('CHECKPOINT_LOCAL_QUIESCENCE_REQUIRED');
  if (createdBy !== null && (typeof createdBy !== 'string' || createdBy.length > 160)) M.fail('CHECKPOINT_ACTOR_INVALID');
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 64 || targetBytes > M.TARGET_BYTES) M.fail('CHECKPOINT_CHUNK_TARGET_INVALID');
  await provisionLocal(client, db, authorization);
  // Reject already-visible jobs/dispatches without entering maintenance. The
  // operative path repeats this check after closing admission and draining.
  await assertQuiescent(db, scope);
  const checkpointId = randomUUID(), capturedAt = new Date();
  const control = await acquireControl(db, scope, checkpointId, capturedAt);
  const started = Date.now(), metrics = { snapshotTransactionMs: 0, peakRssBytes: process.memoryUsage().rss };
  const context = { checkpointId, phase: 'QUIESCENCE', sessionPhase: 'NOT_OPEN', collection: null };
  const sampler = setInterval(() => { metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss); }, 25);
  sampler.unref();
  try {
    if (operational) {
      await require('./mlTestFence').drainWriters(db, control);
      checkOperation();
      await assertQuiescent(db, scope);
    }
    context.phase = 'MANIFEST_CREATE';
    await db.collection(NAMES[1]).insertOne({ checkpointId, ...scope, createdBy, status: 'CREATING', capturedAt,
      createdAt: capturedAt, updatedAt: capturedAt, schemaVersion: 1, failureCode: null,
      captureProtocolVersion: CAPTURE_PROTOCOL, readyAt: null,
      observationsClosedThroughAtCapture: closedThrough(capturedAt), chunkTargetBytes: targetBytes,
      totalBytes: 0, totalChunks: 0 });
    const snapshot = await scanSource({ client, db, scope, targetBytes, elapsedLimitMs: LIMITS.captureMs,
      metrics, onStage: stage => Object.assign(context, stage),
      onChunk: (collection, chunk) => { checkOperation(); return db.collection(NAMES[2]).insertOne({ checkpointId, collection, ...chunk }); } });
    const { readDurationMs, totalDocuments, ...captured } = snapshot;
    const row = { checkpointId, ...scope, capturedAt, schemaVersion: 1, chunkTargetBytes: targetBytes,
      observationsClosedThroughAtCapture: closedThrough(capturedAt), ...captured };
    row.hashes.manifest = M.hashValue(M.manifestContent(row));
    context.phase = 'MANIFEST_WRITE';
    await db.collection(NAMES[1]).updateOne({ checkpointId, ...scope, status: 'CREATING' }, { $set: { ...captured,
      hashes: row.hashes, updatedAt: new Date() } });
    context.phase = 'VERIFY';
    const verifyStarted = Date.now();
    const verified = await verifyStored(db, checkpointId, scope, checkOperation);
    metrics.verifyMs = Date.now() - verifyStarted;
    checkOperation();
    const session = client.startSession();
    const finalizeStarted = Date.now();
    Object.assign(context, { phase: 'FINALIZE', sessionPhase: 'FINALIZE_TRANSACTION' });
    try {
      session.startTransaction({ writeConcern: { w: 'majority' } });
      const result = await db.collection(NAMES[0]).updateOne({ businessId: scope.businessId, activeCheckpointId: checkpointId,
        resetEpoch: control.resetEpoch, state: 'CHECKPOINT_CREATING' }, { $set: { state: 'TEST_ACTIVE', updatedAt: new Date() } }, { session });
      if (result.matchedCount !== 1) M.fail('CHECKPOINT_CONTROL_CONFLICT');
      const ready = await db.collection(NAMES[1]).updateOne({ checkpointId, ...scope, status: 'CREATING' },
        { $set: { status: 'READY', readyAt: new Date(), captureMetrics: D.safeMetrics(metrics), updatedAt: new Date() } }, { session });
      if (ready.matchedCount !== 1) M.fail('CHECKPOINT_CONTROL_CONFLICT');
      await session.commitTransaction();
    } catch (error) { if (session.inTransaction()) await session.abortTransaction(); throw error; }
    finally { metrics.finalizeTransactionMs = Date.now() - finalizeStarted; await session.endSession(); }
    metrics.totalMs = Date.now() - started;
    return { ...verified, status: 'READY', resetEpoch: control.resetEpoch.toString(), readDurationMs, totalDocuments,
      metrics: D.safeMetrics(metrics) };
  } catch (error) {
    metrics.totalMs = Date.now() - started;
    const failureDiagnostics = D.failure(error, { ...context, durationMs: metrics.totalMs });
    try { logDiagnostic(failureDiagnostics); } catch { /* Never log the raw error as fallback. */ }
    await markFailed(db, checkpointId, scope, error, { failureDiagnostics, captureMetrics: D.safeMetrics(metrics) });
    throw error;
  } finally { clearInterval(sampler); }
}
const captureLocalCheckpoint = options => captureCheckpoint(options, false);
const captureOperationalCheckpoint = options => captureCheckpoint(options, true);
async function verifyLocalCheckpoint({ client, db, checkpointId, scope, authorization }) {
  assertExecutionTarget(client, db, authorization); scope = M.authorizedScope(scope);
  try { return await verifyStored(db, checkpointId, scope); }
  catch (error) { await markFailed(db, checkpointId, scope, error); throw error; }
}
// No models are initialized, no control is acquired and no snapshot is saved.
// This path issues only metadata reads and a read-only snapshot session.
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
        chunkCountLimit: LIMITS.maxChunks },
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
  captureOperationalCheckpoint,
  assertQuiescent, CAPTURE_PROTOCOL,
  scanSource,
  assertLocalTarget, assertExecutionTarget, closedThrough, codeOf, LIMIT_BYTES, LIMIT_DOCUMENTS, READ_LIMIT_MS,
  MAX_PREFLIGHT_READ_LIMIT_MS };
