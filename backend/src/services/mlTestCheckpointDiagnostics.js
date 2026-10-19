'use strict';
const { COLLECTIONS } = require('./mlTestCheckpointManifest');
const names = new Set(['Error', 'MongoServerError', 'MongoNetworkError', 'MongoNetworkTimeoutError',
  'MongoServerSelectionError', 'MongoCompatibilityError', 'MongoOperationTimeoutError', 'MongoTransactionError',
  'MongoInvalidArgumentError', 'MongoExpiredSessionError', 'MongoWriteConcernError', 'MongoUnexpectedServerResponseError']);
const codeNames = new Set(['NoSuchTransaction', 'TransactionExceededLifetimeLimitSeconds', 'MaxTimeMSExpired',
  'SnapshotTooOld', 'SnapshotUnavailable', 'CursorNotFound', 'WriteConflict', 'Interrupted', 'InterruptedAtShutdown',
  'NotWritablePrimary', 'PrimarySteppedDown', 'ExceededMemoryLimit', 'TransactionTooLargeForCache']);
const labels = new Set(['TransientTransactionError', 'UnknownTransactionCommitResult', 'RetryableWriteError', 'NoWritesPerformed']);
const phases = new Set(['QUIESCENCE', 'DRAIN', 'SNAPSHOT_READ', 'CHUNK_WRITE', 'VERIFY', 'FINALIZE',
  'MANIFEST_CREATE', 'METADATA_READ', 'TENANT_SCOPE_READ', 'SOURCE_READ', 'METADATA_VERIFY', 'MANIFEST_WRITE', 'RECOVERY']);
const sessionPhases = new Set(['NOT_OPEN', 'SNAPSHOT_OPEN', 'SNAPSHOT_CLOSED', 'FINALIZE_TRANSACTION', 'RECOVERY_TRANSACTION']);
const metricKeys = ['totalMs', 'budgetMs', 'snapshotSessionMs', 'snapshotTransactionMs', 'chunkWriteMs', 'verifyMs',
  'finalizeTransactionMs', 'bytesStreamed', 'maxChunkBytes', 'peakRssBytes', 'remainingBudgetMs'];
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value) ? value : null;
function safeMetrics(value = {}) {
  if (!value || typeof value !== 'object') return {};
  const output = Object.fromEntries(metricKeys.filter(key => Number.isFinite(value[key]) && value[key] >= 0)
    .map(key => [key, Math.round(value[key])]));
  if (value.phaseElapsedMs && typeof value.phaseElapsedMs === 'object') {
    output.phaseElapsedMs = Object.fromEntries([...phases].filter(key => Number.isFinite(value.phaseElapsedMs[key]) && value.phaseElapsedMs[key] >= 0)
      .map(key => [key, Math.round(value.phaseElapsedMs[key])]));
  }
  return output;
}
function failure(error, context = {}) {
  const codeName = codeNames.has(error?.codeName) ? error.codeName : null;
  const code = Number.isInteger(error?.code) ? error.code : null;
  const category = codeName === 'TransactionExceededLifetimeLimitSeconds' ? 'TRANSACTION_LIFETIME_LIMIT'
    : code === 251 ? 'NO_SUCH_TRANSACTION' : code === 50 ? 'OPERATION_TIME_LIMIT'
      : codeName === 'SnapshotTooOld' || code === 286 ? 'SNAPSHOT_HISTORY_EXPIRED'
        : codeName === 'SnapshotUnavailable' || code === 246 ? 'SNAPSHOT_UNAVAILABLE'
          : /Network|ServerSelection/.test(error?.name || '') ? 'NETWORK_OR_SELECTION' : 'OPERATION_FAILED';
  return {
    event: 'ML_TEST_CHECKPOINT_FAILURE', checkpointId: uuid(context.checkpointId),
    phase: phases.has(context.phase) ? context.phase : null,
    collection: COLLECTIONS.some(row => row.collection === context.collection) ? context.collection : null,
    sessionPhase: sessionPhases.has(context.sessionPhase) ? context.sessionPhase : null,
    durationMs: Number.isFinite(context.durationMs) && context.durationMs >= 0 ? Math.round(context.durationMs) : null,
    budgetMs: Number.isFinite(error?.budgetMs) && error.budgetMs >= 0 ? Math.round(error.budgetMs) : null,
    phaseElapsedMs: Number.isFinite(error?.phaseElapsedMs) && error.phaseElapsedMs >= 0 ? Math.round(error.phaseElapsedMs) : null,
    remainingBudgetMs: Number.isFinite(error?.remainingBudgetMs) && error.remainingBudgetMs >= 0 ? Math.round(error.remainingBudgetMs) : null,
    name: names.has(error?.name) ? error.name : 'Error', code, codeName,
    labels: Array.isArray(error?.errorLabels) ? error.errorLabels.filter(label => labels.has(label)) : [], category
  };
}
const logFailure = record => console.warn(JSON.stringify(record));
function logProgress(record) {
  if (!record || !phases.has(record.phase)) return;
  console.info(JSON.stringify({ event: 'ML_TEST_CHECKPOINT_PROGRESS',
    checkpointId: uuid(record.checkpointId), phase: record.phase,
    budgetMs: Number.isFinite(record.budgetMs) ? Math.max(0, Math.round(record.budgetMs)) : null,
    elapsedMs: Number.isFinite(record.elapsedMs) ? Math.max(0, Math.round(record.elapsedMs)) : null,
    remainingBudgetMs: Number.isFinite(record.remainingBudgetMs) ? Math.max(0, Math.round(record.remainingBudgetMs)) : null }));
}
function safeStoredFailure(value) {
  if (!value || typeof value !== 'object') return null;
  return failure({ name: value.name, code: value.code, codeName: value.codeName, errorLabels: value.labels }, value);
}
module.exports = { failure, safeStoredFailure, safeMetrics, logFailure, logProgress };
