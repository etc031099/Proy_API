'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { ForecastModelArtifact, ForecastModelRegistry } = require('../models');

const HORIZONS = new Set([7, 14]);
const MODEL_STATUSES = new Set(['CANDIDATE', 'ACTIVE', 'REJECTED', 'SUPERSEDED', 'FAILED']);
const PROMOTION_POLICY_VERSION = 'M6.10A22-PROMOTION-v1';
const PROMOTION_POLICY_HASH = '522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3';
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_LINEAGE_BYTES = 16 * 1024;
const MAX_INT64 = 9223372036854775807n;

class ForecastRegistryError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'ForecastRegistryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, statusCode) => { throw new ForecastRegistryError(code, message, statusCode); };
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const isIsoDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const cloneJson = (value, label) => {
  const active = new Set();
  const visit = (item, depth = 0) => {
    if (depth > 12) fail('INVALID_METADATA', `${label} nesting exceeds the supported limit.`, 400);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('INVALID_METADATA', `${label} must not contain NaN or Infinity.`, 400);
      return item;
    }
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) {
      fail('INVALID_METADATA', `${label} must contain plain JSON values only.`, 400);
    }
    if (active.has(item)) fail('INVALID_METADATA', `${label} must not contain circular references.`, 400);
    active.add(item);
    const result = {};
    for (const [key, child] of Object.entries(item)) {
      if (/secret|password|credential|authorization|api.?key|access.?token/i.test(key)) {
        fail('INVALID_METADATA', `${label} must not contain secret-bearing fields.`, 400);
      }
      result[key] = visit(child, depth + 1);
    }
    active.delete(item);
    return result;
  };
  const result = visit(value);
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > MAX_LINEAGE_BYTES) fail('INVALID_METADATA', `${label} exceeds the supported size.`, 400);
  return result;
};

function validateScope({ businessId, scenarioId, horizonDays }) {
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.length > 160
      || typeof scenarioId !== 'string' || !scenarioId.trim() || scenarioId.length > 160) {
    fail('INVALID_SCOPE', 'A valid businessId and scenarioId are required.', 400);
  }
  if (!HORIZONS.has(horizonDays)) fail('UNSUPPORTED_HORIZON', 'Only 7 and 14 day model registry horizons are supported.', 400);
}

function validateCandidateInput(input) {
  validateScope(input || {});
  if (typeof input.modelFamily !== 'string' || !input.modelFamily.trim()
      || typeof input.recipeId !== 'string' || !input.recipeId.trim()) {
    fail('INVALID_MODEL_METADATA', 'modelFamily and recipeId are required.', 400);
  }
  if (!(input.trainedAt instanceof Date) || !Number.isFinite(input.trainedAt.getTime())) {
    fail('INVALID_MODEL_METADATA', 'trainedAt must be a valid date.', 400);
  }
  if (typeof input.trainedDataVersion !== 'string' || !/^(0|[1-9]\d*)$/.test(input.trainedDataVersion)
      || BigInt(input.trainedDataVersion) > MAX_INT64) {
    fail('INVALID_MODEL_METADATA', 'trainedDataVersion must be a nonnegative BSON int64 decimal string.', 400);
  }
  if (!isIsoDay(input.dataCutoff) || !isIsoDay(input.labelClosedThrough)
      || !input.trainingWindow || !isIsoDay(input.trainingWindow.startDate)
      || !isIsoDay(input.trainingWindow.endDate) || input.trainingWindow.startDate > input.trainingWindow.endDate) {
    fail('INVALID_MODEL_METADATA', 'dataCutoff, labelClosedThrough, and ordered trainingWindow dates are required.', 400);
  }
  if (typeof input.featureVersion !== 'string' || !input.featureVersion.trim()
      || !isHash(input.featureHash) || !isHash(input.sourceDatasetHash)) {
    fail('INVALID_MODEL_METADATA', 'featureVersion and valid feature/source hashes are required.', 400);
  }
  if (input.promotionPolicyVersion !== PROMOTION_POLICY_VERSION || input.promotionPolicyHash !== PROMOTION_POLICY_HASH) {
    fail('PROMOTION_POLICY_MISMATCH', 'Candidate must reference the frozen M6.10A22 promotion policy.', 400);
  }
  for (const field of ['globalWape', 'globalMae', 'globalBias']) {
    if (!isFiniteNumber(input[field]) || (field !== 'globalBias' && input[field] < 0)) {
      fail('INVALID_METRICS', `${field} must be finite${field === 'globalBias' ? '' : ' and nonnegative'}.`, 400);
    }
  }
  if (typeof input.triggerReason !== 'string' || !input.triggerReason.trim() || input.triggerReason.length > 120) {
    fail('INVALID_MODEL_METADATA', 'triggerReason is required and must be at most 120 characters.', 400);
  }
  const checks = cloneJson(input.checks, 'checks');
  if (!checks || Array.isArray(checks) || typeof checks !== 'object') fail('INVALID_MODEL_METADATA', 'checks must be a JSON object.', 400);
  const lineage = cloneJson(input.lineage, 'lineage');
  if (!lineage || Array.isArray(lineage) || typeof lineage !== 'object') fail('INVALID_MODEL_METADATA', 'lineage must be a JSON object.', 400);
  const artifactData = Buffer.isBuffer(input.artifactData) ? Buffer.from(input.artifactData)
    : input.artifactData instanceof Uint8Array ? Buffer.from(input.artifactData) : null;
  if (!artifactData || artifactData.length > MAX_ARTIFACT_BYTES) {
    fail('INVALID_ARTIFACT', 'Artifact bytes must be a buffer no larger than 5 MiB.', 400);
  }
  const artifactHash = sha256(artifactData);
  if (input.artifactHash != null && input.artifactHash !== artifactHash) {
    fail('ARTIFACT_HASH_MISMATCH', 'Provided artifactHash does not match the supplied artifact bytes.', 400);
  }
  if (input.idempotencyKey != null && (typeof input.idempotencyKey !== 'string'
      || input.idempotencyKey.trim().length < 8 || input.idempotencyKey.trim().length > 160)) {
    fail('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must be between 8 and 160 characters.', 400);
  }
  return {
    ...input,
    businessId: input.businessId.trim(), scenarioId: input.scenarioId.trim(),
    modelFamily: input.modelFamily.trim(), recipeId: input.recipeId.trim(),
    featureVersion: input.featureVersion.trim(), triggerReason: input.triggerReason.trim(),
    checks, lineage, artifactData, artifactHash,
    idempotencyKey: input.idempotencyKey?.trim() || undefined
  };
}

function candidateFingerprint(input) {
  const { artifactData, idempotencyKey, ...metadata } = input;
  return sha256(Buffer.from(JSON.stringify({ ...metadata, trainedAt: metadata.trainedAt.toISOString(), artifactHash: input.artifactHash })));
}

const isRetryableTransactionError = error => error?.hasErrorLabel?.('TransientTransactionError')
  || error?.errorLabels?.includes('TransientTransactionError')
  || error?.code === 112 || error?.codeName === 'WriteConflict'
  || error?.code === 11000;
const isUnknownCommitResult = error => error?.hasErrorLabel?.('UnknownTransactionCommitResult')
  || error?.errorLabels?.includes('UnknownTransactionCommitResult');

async function inBoundedTransaction(work, startSession = () => mongoose.startSession()) {
  const session = await startSession();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      session.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary',
        writeConcern: { w: 'majority' }, maxCommitTimeMS: 5000 });
      let result;
      try {
        result = await work(session);
      } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        if (attempt === 0 && isRetryableTransactionError(error)) continue;
        throw error;
      }
      let commitError;
      for (let commitAttempt = 0; commitAttempt < 2; commitAttempt += 1) {
        try {
          await session.commitTransaction();
          return result;
        } catch (error) {
          commitError = error;
          if (!isUnknownCommitResult(error) || commitAttempt === 1) break;
        }
      }
      if (isUnknownCommitResult(commitError)) {
        throw new ForecastRegistryError('COMMIT_RESULT_UNKNOWN', 'MongoDB could not confirm the transaction commit outcome.', 503);
      }
      if (session.inTransaction()) await session.abortTransaction();
      if (attempt === 0 && isRetryableTransactionError(commitError)) continue;
      throw commitError;
    }
    fail('TRANSACTION_RETRY_EXHAUSTED', 'A retryable model registry transaction did not complete after one retry.', 503);
  } finally {
    await session.endSession();
  }
}

function publicMetadata(row) {
  if (!row) return null;
  const result = typeof row.toObject === 'function' ? row.toObject() : { ...row };
  delete result.artifactData;
  delete result.idempotencyKey;
  delete result.idempotencyFingerprint;
  delete result.__v;
  return result;
}

function createForecastModelRegistryService({ artifactModel = ForecastModelArtifact,
  registryModel = ForecastModelRegistry, startSession, afterPromotionWrites } = {}) {
  const transact = work => inBoundedTransaction(work, startSession || (() => mongoose.startSession()));

  async function createCandidateMetadata(input) {
    const candidate = validateCandidateInput(input || {});
    const fingerprint = candidateFingerprint(candidate);
    return transact(async session => {
      const scope = { businessId: candidate.businessId, scenarioId: candidate.scenarioId,
        horizonDays: candidate.horizonDays };
      if (candidate.idempotencyKey) {
        const prior = await artifactModel.findOne({ ...scope, idempotencyKey: candidate.idempotencyKey })
          .session(session).select('+artifactData').lean().maxTimeMS(5000);
        if (prior) {
          if (prior.idempotencyFingerprint !== fingerprint) fail('IDEMPOTENCY_KEY_CONFLICT', 'idempotencyKey was already used for different candidate metadata.', 409);
          verifyArtifact(prior);
          return publicMetadata(prior);
        }
      }
      const registry = await registryModel.findOneAndUpdate(scope,
        { $setOnInsert: { ...scope, generation: 0,
          activeArtifactId: null, activeModelVersion: null }, $inc: { lastIssuedModelVersion: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true, session, runValidators: true }).maxTimeMS(5000);
      const modelVersion = registry.lastIssuedModelVersion;
      if (!Number.isSafeInteger(modelVersion) || modelVersion < 1) fail('VERSION_EXHAUSTED', 'Model version counter is invalid.', 503);
      const artifactId = new mongoose.Types.ObjectId();
      const document = {
        ...scope, modelFamily: candidate.modelFamily, recipeId: candidate.recipeId, modelVersion,
        status: 'CANDIDATE', trainedAt: candidate.trainedAt, trainedDataVersion: candidate.trainedDataVersion,
        dataCutoff: candidate.dataCutoff, trainingWindow: candidate.trainingWindow,
        labelClosedThrough: candidate.labelClosedThrough, featureVersion: candidate.featureVersion,
        featureHash: candidate.featureHash, promotionPolicyVersion: candidate.promotionPolicyVersion,
        promotionPolicyHash: candidate.promotionPolicyHash, globalWape: candidate.globalWape,
        globalMae: candidate.globalMae, globalBias: candidate.globalBias, checks: candidate.checks,
        triggerReason: candidate.triggerReason, artifactHash: candidate.artifactHash,
        artifactLocation: `mongodb:${artifactModel.collection.name}/${artifactId}`, artifactBytes: candidate.artifactData.length,
        artifactData: candidate.artifactData, sourceDatasetHash: candidate.sourceDatasetHash,
        lineage: candidate.lineage, idempotencyKey: candidate.idempotencyKey,
        idempotencyFingerprint: candidate.idempotencyKey ? fingerprint : undefined
      };
      const [created] = await artifactModel.create([{ _id: artifactId, ...document }], { session });
      verifyArtifact(created);
      return publicMetadata(created);
    });
  }

  async function getActiveModelMetadata({ businessId, scenarioId, horizonDays }) {
    validateScope({ businessId, scenarioId, horizonDays });
    const scope = { businessId: businessId.trim(), scenarioId: scenarioId.trim(), horizonDays };
    return transact(async session => {
      const artifact = await readExactActive(scope, session);
      return publicMetadata(artifact);
    });
  }

  async function getActiveModelArtifact({ businessId, scenarioId, horizonDays }) {
    validateScope({ businessId, scenarioId, horizonDays });
    const scope = { businessId: businessId.trim(), scenarioId: scenarioId.trim(), horizonDays };
    return transact(async session => {
      const artifact = await readExactActive(scope, session);
      if (!artifact) return null;
      return { metadata: publicMetadata(artifact), artifactData: Buffer.from(artifactBytes(artifact.artifactData)) };
    });
  }

  async function readExactActive(scope, session) {
    const pointer = await registryModel.findOne(scope).session(session).lean().maxTimeMS(5000);
    if (!pointer || pointer.activeArtifactId == null || pointer.activeModelVersion == null) return null;
    const artifact = await artifactModel.findOne({ ...scope, _id: pointer.activeArtifactId,
      modelVersion: pointer.activeModelVersion, status: 'ACTIVE' }).session(session)
      .select('+artifactData').lean().maxTimeMS(5000);
    if (!artifact) fail('REGISTRY_INCONSISTENT', 'Registry pointer does not resolve to its exact ACTIVE artifact.', 503);
    verifyArtifact(artifact);
    return artifact;
  }

  async function promoteCandidate({ businessId, scenarioId, horizonDays, modelVersion, expectedGeneration }) {
    validateScope({ businessId, scenarioId, horizonDays });
    if (!Number.isSafeInteger(modelVersion) || modelVersion < 1
        || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      fail('INVALID_PROMOTION_REQUEST', 'modelVersion and expectedGeneration must be nonnegative safe integers.', 400);
    }
    const scope = { businessId: businessId.trim(), scenarioId: scenarioId.trim(), horizonDays };
    return transact(async session => {
      const registry = await registryModel.findOne(scope).session(session).maxTimeMS(5000);
      if (!registry) fail('REGISTRY_NOT_FOUND', 'No model registry pointer exists for this tenant, scenario, and horizon.', 404);
      const candidate = await artifactModel.findOne({ ...scope, modelVersion }).session(session)
        .select('+artifactData').maxTimeMS(5000);
      if (!candidate) fail('CANDIDATE_NOT_FOUND', 'Candidate was not found in the requested tenant, scenario, and horizon.', 404);
      if (candidate.status === 'ACTIVE' && String(registry.activeArtifactId) === String(candidate._id)
          && registry.activeModelVersion === candidate.modelVersion) {
        verifyArtifact(candidate.toObject({ getters: false, virtuals: false }));
        return { promoted: true, idempotent: true, generation: registry.generation, artifact: publicMetadata(candidate) };
      }
      if (registry.generation !== expectedGeneration) fail('CONFLICT', 'Registry generation changed before candidate promotion.', 409);
      if (candidate.status !== 'CANDIDATE') fail('CANDIDATE_NOT_PROMOTABLE', 'Only a CANDIDATE model can be promoted.', 409);
      verifyPromotionMetadata(candidate);
      verifyArtifact(candidate.toObject({ getters: false, virtuals: false }));

      const previousId = registry.activeArtifactId;
      if (previousId != null) {
        const previous = await artifactModel.findOne({ ...scope, _id: previousId,
          modelVersion: registry.activeModelVersion, status: 'ACTIVE' }).session(session).maxTimeMS(5000);
        if (!previous) fail('REGISTRY_INCONSISTENT', 'Existing registry pointer does not resolve to one ACTIVE artifact.', 503);
        const superseded = await artifactModel.updateOne({ ...scope, _id: previousId,
          modelVersion: registry.activeModelVersion, status: 'ACTIVE' }, { $set: { status: 'SUPERSEDED' } },
        { session, runValidators: true }).exec();
        if (superseded.modifiedCount !== 1) fail('CONFLICT', 'Previous ACTIVE model changed during promotion.', 409);
      }
      const activated = await artifactModel.updateOne({ ...scope, _id: candidate._id,
        modelVersion, status: 'CANDIDATE' }, { $set: { status: 'ACTIVE', failureCode: null } },
      { session, runValidators: true }).exec();
      if (activated.modifiedCount !== 1) fail('CONFLICT', 'Candidate status changed during promotion.', 409);
      if (afterPromotionWrites) await afterPromotionWrites({ session, scope, modelVersion });

      const pointerFilter = { ...scope, generation: expectedGeneration,
        ...(previousId == null ? { activeArtifactId: null, activeModelVersion: null }
          : { activeArtifactId: previousId, activeModelVersion: registry.activeModelVersion }) };
      const pointerUpdate = await registryModel.updateOne(pointerFilter, { $set: {
        activeArtifactId: candidate._id, activeModelVersion: modelVersion, updatedAt: new Date()
      }, $inc: { generation: 1 } }, { session, runValidators: true }).exec();
      if (pointerUpdate.modifiedCount !== 1) fail('CONFLICT', 'Registry compare-and-swap failed; candidate promotion was rolled back.', 409);
      return { promoted: true, idempotent: false, generation: expectedGeneration + 1,
        artifact: publicMetadata(candidate) };
    });
  }

  async function transitionCandidate({ businessId, scenarioId, horizonDays, modelVersion, status, failureCode = null }) {
    validateScope({ businessId, scenarioId, horizonDays });
    if (!Number.isSafeInteger(modelVersion) || modelVersion < 1) fail('INVALID_MODEL_VERSION', 'modelVersion must be a positive safe integer.', 400);
    if (!['REJECTED', 'FAILED'].includes(status)) fail('INVALID_STATUS', 'Only REJECTED or FAILED candidate transitions are supported.', 400);
    if (failureCode != null && (typeof failureCode !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(failureCode))) {
      fail('INVALID_FAILURE_CODE', 'failureCode must be a sanitized uppercase code.', 400);
    }
    const scope = { businessId: businessId.trim(), scenarioId: scenarioId.trim(), horizonDays };
    return transact(async session => {
      const artifact = await artifactModel.findOne({ ...scope, modelVersion }).session(session).maxTimeMS(5000);
      if (!artifact) fail('CANDIDATE_NOT_FOUND', 'Candidate was not found in the requested tenant, scenario, and horizon.', 404);
      if (artifact.status === status) return { changed: false, idempotent: true, artifact: publicMetadata(artifact) };
      if (artifact.status !== 'CANDIDATE') fail('CANDIDATE_NOT_TRANSITIONABLE', 'Only a CANDIDATE can be rejected or marked failed.', 409);
      const result = await artifactModel.updateOne({ ...scope, modelVersion, status: 'CANDIDATE' },
        { $set: { status, failureCode: status === 'FAILED' ? failureCode : null } },
        { session, runValidators: true }).exec();
      if (result.modifiedCount !== 1) fail('CONFLICT', 'Candidate status changed during transition.', 409);
      artifact.status = status;
      artifact.failureCode = status === 'FAILED' ? failureCode : null;
      return { changed: true, idempotent: false, artifact: publicMetadata(artifact) };
    });
  }

  async function rejectCandidate(input) { return transitionCandidate({ ...input, status: 'REJECTED' }); }
  async function markCandidateFailed(input) { return transitionCandidate({ ...input, status: 'FAILED' }); }

  async function listModelVersions({ businessId, scenarioId, horizonDays, limit = 50, beforeVersion = null }) {
    validateScope({ businessId, scenarioId, horizonDays });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_LIMIT', 'limit must be between 1 and 100.', 400);
    const query = { businessId: businessId.trim(), scenarioId: scenarioId.trim(), horizonDays };
    if (beforeVersion != null) {
      if (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1) fail('INVALID_MODEL_VERSION', 'beforeVersion must be positive.', 400);
      query.modelVersion = { $lt: beforeVersion };
    }
    const rows = await artifactModel.find(query).sort({ modelVersion: -1 }).limit(limit).lean().maxTimeMS(5000);
    return rows.map(publicMetadata);
  }

  return Object.freeze({ createCandidateMetadata, getActiveModelMetadata, getActiveModelArtifact,
    promoteCandidate, rejectCandidate, markCandidateFailed, listModelVersions });
}

function verifyArtifact(artifact) {
  const bytes = artifactBytes(artifact?.artifactData);
  if (!artifact || !bytes
      || bytes.length !== artifact.artifactBytes
      || sha256(bytes) !== artifact.artifactHash) {
    fail('ARTIFACT_HASH_MISMATCH', 'Persisted artifact bytes do not match their recorded size and SHA256.', 409);
  }
  return true;
}

function artifactBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value?._bsontype === 'Binary' && Buffer.isBuffer(value.buffer)
      && Number.isSafeInteger(value.position) && value.position >= 0 && value.position <= value.buffer.length) {
    return value.buffer.subarray(0, value.position);
  }
  return null;
}

function verifyPromotionMetadata(artifact) {
  if (artifact.promotionPolicyVersion !== PROMOTION_POLICY_VERSION
      || artifact.promotionPolicyHash !== PROMOTION_POLICY_HASH
      || !isHash(artifact.featureHash) || !isHash(artifact.sourceDatasetHash)
      || !artifact.featureVersion || !artifact.modelFamily || !artifact.recipeId
      || !Number.isSafeInteger(artifact.artifactBytes) || artifact.artifactBytes < 1
      || !Number.isFinite(artifact.globalWape) || artifact.globalWape < 0
      || !Number.isFinite(artifact.globalMae) || artifact.globalMae < 0
      || !Number.isFinite(artifact.globalBias)
      || !artifact.checks || typeof artifact.checks !== 'object') {
    fail('CANDIDATE_METADATA_INVALID', 'Candidate metadata or frozen policy reference is incomplete.', 409);
  }
  return true;
}

module.exports = {
  createForecastModelRegistryService,
  ForecastRegistryError,
  HORIZONS: Object.freeze([...HORIZONS]),
  MODEL_STATUSES: Object.freeze([...MODEL_STATUSES]),
  PROMOTION_POLICY_VERSION,
  PROMOTION_POLICY_HASH,
  MAX_ARTIFACT_BYTES,
  verifyArtifact,
  _default: createForecastModelRegistryService()
};
