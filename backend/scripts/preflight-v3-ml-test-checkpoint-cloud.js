'use strict';
// Deliberately does not load dotenv or initialize Mongoose models.
const { MongoClient } = require('mongoose').mongo;
const config = require('../src/config/v3Operational');
const M = require('../src/services/mlTestCheckpointManifest');
const service = require('../src/services/mlTestCheckpointService');
const PREFLIGHT_READ_BUDGET_MS = 120000;
const finite = value => Number.isFinite(value) ? value : null;
function failureReport(error) {
  const report = { status: 'FAILED', code: service.codeOf(error), writes: 0, cloudRestoreEnabled: false };
  const details = error?.readDiagnostics;
  const isSourceLimit = report.code === 'CHECKPOINT_SOURCE_LIMIT_EXCEEDED';
  if (!['CHECKPOINT_READ_LIMIT_EXCEEDED', 'CHECKPOINT_SOURCE_LIMIT_EXCEEDED'].includes(report.code) || !details) return report;
  const allowed = new Set(M.COLLECTIONS.map(row => row.collection));
  const collection = row => row && allowed.has(row.collection) ? {
    collection: row.collection, documents: finite(row.documents ?? row.documentsRead),
    bsonBytes: finite(row.bsonBytes ?? row.bsonBytesRead),
    estimatedChunks: finite(row.estimatedChunks), largestDocumentBytes: finite(row.largestDocumentBytesRead),
    fetchedAtLimit: row.fetchedAtLimit === true,
    fetchedDocumentBytesAtLimit: finite(row.fetchedDocumentBytesAtLimit)
  } : null;
  const progress = details.progress;
  const diagnostic = { cause: details.limitCause, limitsExceeded: details.limitsExceeded || [],
    configured: { readLimitMs: finite(details.limits?.readLimitMs),
      maxTimeMsPerCursor: finite(details.limits?.maxTimeMsPerCursor), maxDocuments: finite(details.limits?.maxDocuments),
      maxBytes: finite(details.limits?.maxBytes), chunkTargetBytes: finite(details.limits?.chunkTargetBytes),
      chunkCountLimit: finite(details.limits?.chunkCountLimit) },
    collectionBytesAreLowerBounds: details.collectionBytesAreLowerBounds === true,
    progress: progress ? { elapsedMs: finite(progress.elapsedMs), totalDocuments: finite(progress.totalDocuments),
      totalBsonBytes: finite(progress.totalBsonBytes), totalEstimatedChunks: finite(progress.totalEstimatedChunks),
      observedDocumentsAtStop: finite(progress.totalDocuments)
        + (progress.currentCollection?.fetchedAtLimit === true ? 1 : 0),
      observedBsonBytesAtStop: finite(progress.totalBsonBytes)
        + (progress.currentCollection?.fetchedAtLimit === true ? finite(progress.currentCollection.fetchedDocumentBytesAtLimit) || 0 : 0),
      completedCollections: Array.isArray(progress.completedCollections)
        ? progress.completedCollections.map(collection).filter(Boolean) : [],
      currentCollection: collection(progress.currentCollection),
      largestMeasuredCollection: [...(progress.completedCollections || []),
        ...(progress.currentCollection ? [{ ...progress.currentCollection, documents: progress.currentCollection.documentsRead,
          bsonBytes: progress.currentCollection.bsonBytesRead }] : [])].filter(row => allowed.has(row.collection))
        .map(row => ({ collection: row.collection, bsonBytes: finite(row.bsonBytes ?? row.bsonBytesRead),
          complete: row.collection !== progress.currentCollection?.collection }))
        .sort((a, b) => b.bsonBytes - a.bsonBytes)[0] || null } : null };
  if (isSourceLimit && diagnostic.limitsExceeded.includes('MAX_BYTES')) {
    const observedBytes = diagnostic.progress?.totalBsonBytes ?? null;
    const maxBytes = diagnostic.configured.maxBytes;
    diagnostic.minimumObservedSnapshotBytes = observedBytes;
    diagnostic.bytesOverLimitAtCutoff = observedBytes === null || maxBytes === null ? null : Math.max(0, observedBytes - maxBytes);
    diagnostic.completeSnapshotSizeEstimateBytes = null;
    diagnostic.sizeEstimateNote = 'LOWER_BOUND_ONLY_STOPPED_AT_CONFIGURED_BYTE_LIMIT';
  }
  report[isSourceLimit ? 'sourceLimit' : 'readLimit'] = diagnostic;
  return report;
}
function environment(env) {
  const names = ['FORECAST_CLOUD_MONGO_URI', 'FORECAST_CLOUD_EXPECTED_DATABASE',
    'FORECAST_CLOUD_EXPECTED_BUSINESS_ID', 'FORECAST_CLOUD_EXPECTED_SCENARIO_ID'];
  if (names.some(name => !env[name])) M.fail('CHECKPOINT_CLOUD_ENV_REQUIRED');
  const database = env.FORECAST_CLOUD_EXPECTED_DATABASE;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(database)) M.fail('CHECKPOINT_CLOUD_TARGET_INVALID');
  M.authorizedScope({ businessId: env.FORECAST_CLOUD_EXPECTED_BUSINESS_ID, scenarioId: env.FORECAST_CLOUD_EXPECTED_SCENARIO_ID });
  let uri;
  try { uri = new URL(env.FORECAST_CLOUD_MONGO_URI); } catch { M.fail('CHECKPOINT_CLOUD_TARGET_INVALID'); }
  if (uri.protocol !== 'mongodb+srv:' || !uri.hostname.endsWith('.mongodb.net') || !uri.username || !uri.password
      || uri.pathname !== `/${database}` || uri.port || uri.hash
      || ['tls', 'ssl'].some(key => uri.searchParams.has(key) && uri.searchParams.get(key) !== 'true')
      || ['tlsInsecure', 'tlsAllowInvalidCertificates', 'tlsAllowInvalidHostnames', 'directConnection']
        .some(key => uri.searchParams.has(key) && uri.searchParams.get(key) !== 'false')) M.fail('CHECKPOINT_CLOUD_TARGET_INVALID');
  return { uri: env.FORECAST_CLOUD_MONGO_URI, database };
}
async function main(argv = process.argv.slice(2), env = process.env) {
  let client;
  try {
    if (argv.length) M.fail('CHECKPOINT_ARGUMENTS_INVALID');
    const settings = environment(env);
    client = new MongoClient(settings.uri, { retryWrites: false, serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 50000, maxPoolSize: 2, readPreference: 'primary' });
    await client.connect();
    const report = await service.preflightCheckpoint({ client, db: client.db(settings.database), scope: config,
      elapsedLimitMs: PREFLIGHT_READ_BUDGET_MS });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failureReport(error))}\n`);
    return 1;
  } finally { await client?.close(); }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main, environment, failureReport, PREFLIGHT_READ_BUDGET_MS };
