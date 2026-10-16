'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const config = require('../../src/config/v3Operational');
const { ForecastTrainingJob: Job, ForecastModelArtifact: Artifact, ForecastModelRegistry: Pointer,
  ForecastMlUpdateState: State, ForecastMlUpdateEvent: Event,
  V3OperationalRevision: Revision, V3OperationalChange: Change } = require('../../src/models');
const coord = require('../../src/services/forecastMlUpdateCoordinator');
const { createForecastModelRegistryService } = require('../../src/services/forecastModelRegistryService');
const { createForecastRidgeTrainingWorker, canonicalBytes } = require('../../src/services/forecastRidgeTrainingWorker');

const root = path.resolve(__dirname, '../../..');
const F = '84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5';
const P = '522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3';
const scope = horizonDays => ({ businessId: config.businessId, scenarioId: config.scenarioId, horizonDays });
const cats = ['sku', 'categoryCode', 'subcategoryCode', 'brand', 'presentation', 'unit'];
const nums = ['sizeValue', 'containedUnits', 'weekdayNext', 'weekendNextDays', 'monthNext', 'dayOfMonthNext',
  'paydayDays', 'monthEndDays', 'currentUnits', 'lag_1', 'lag_7', 'lag_14', 'lag_28', 'rollingMean_7',
  'rollingMean_14', 'rollingMean_28', 'rollingStd_7', 'rollingStd_28', 'zeroSalesStreak', 'daysSinceLastSale', 'neverSoldInObservedWindow'];
let cases, now, registry;
const clone = value => JSON.parse(JSON.stringify(value));
function artifact(horizonDays, version = null) {
  return { schemaVersion: 'ridge-causal27-json-v1', ...scope(horizonDays), modelVersion: version,
    modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', featureVersion: 'RIDGE_CAUSAL27_V1',
    featureHash: F, categoricalFeatures: cats, numericFeatures: nums,
    categories: Object.fromEntries(cats.map(k => [k, ['fixture']])), scalerMean: nums.map(() => 0),
    scalerScale: nums.map(() => 1), coefficients: Array(27).fill(0), intercept: horizonDays,
    alpha: 10, solver: 'lsqr', tol: .0001 };
}
function result(request, name = 'PASS') {
  const evaluation = clone(cases[name]);
  return { artifact: artifact(request.horizonDays), sourceDatasetHash: 'a'.repeat(64),
    trainedDataVersion: request.inputDataVersion, dataCutoff: request.observationsClosedThrough,
    trainingWindow: { startDate: '2025-11-10', endDate: coord.matureOrigin(request.observationsClosedThrough, request.horizonDays) },
    labelClosedThrough: request.observationsClosedThrough, featureVersion: 'RIDGE_CAUSAL27_V1', featureHash: F,
    promotionPolicyVersion: 'M6.10A22-PROMOTION-v1', promotionPolicyHash: P,
    globalWape: evaluation.model.wape, globalMae: evaluation.model.mae, globalBias: evaluation.model.normalized_bias,
    checks: evaluation, lineage: { fixture: true }, performanceMs: { evaluation: 1 },
    parityMaxAbsoluteError: 0, evaluationStatus: evaluation.status };
}
async function seedCandidate(horizonDays, key, service = registry, businessId = config.businessId) {
  return service.createCandidateMetadata({ ...scope(horizonDays), businessId,
    modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', trainedAt: new Date('2026-10-16T00:00:00Z'),
    trainedDataVersion: '0', dataCutoff: '2026-10-15', labelClosedThrough: '2026-10-15',
    trainingWindow: { startDate: '2025-11-10', endDate: '2026-10-01' }, featureVersion: 'RIDGE_CAUSAL27_V1',
    featureHash: F, sourceDatasetHash: 'b'.repeat(64), promotionPolicyVersion: 'M6.10A22-PROMOTION-v1',
    promotionPolicyHash: P, globalWape: .2, globalMae: 1, globalBias: 0, checks: { fixture: true },
    triggerReason: 'CONTROLLED_PREVIOUS_ACTIVE', lineage: { fixture: true }, idempotencyKey: key,
    artifactFactory: version => canonicalBytes({ ...artifact(horizonDays, version), businessId }) });
}
async function reset({ correction = false } = {}) {
  await Promise.all([Job, Artifact, Pointer, State, Event, Revision, Change].map(m => m.deleteMany({})));
  registry = createForecastModelRegistryService();
  now = new Date('2027-03-01T12:00:00Z');
  for (const h of [7, 14]) {
    const candidate = await seedCandidate(h, `previous-v1-${h}`);
    await registry.promoteCandidate({ ...scope(h), modelVersion: candidate.modelVersion, expectedGeneration: 0 });
    const closed = coord.watermark(now), mature = coord.matureOrigin(closed, h);
    await State.create({ ...scope(h), status: 'READY', pendingSince: new Date(now - 86400000),
      latestDataVersion: 100n, eventCount: 1, lastDirtyAt: new Date(now - 86400000),
      observationsClosedThrough: closed, initialMatureOrigin: '2026-10-01', latestMatureOrigin: mature,
      nextEligibleAt: new Date(now - 1000), triggerReason: 'SALE_COMPLETED',
      historicalCorrectionVersion: correction ? 100n : null, affectedLocalDate: correction ? '2026-10-01' : null });
  }
  await Revision.create({ _id: config.businessId, revision: 100n, bootstrapStatus: 'VERIFIED' });
}
async function signal(version, correction = false) {
  const session = await mongoose.startSession();
  const change = correction ? { entityType: 'transaction', entityKey: `cancel-${version}`, operation: 'CANCEL', projection: { type: 'sale' } }
    : { entityType: 'sale', entityKey: `sale-${version}`, operation: 'CREATE', projection: { initialStatus: 'completed', localDate: '2027-03-01' } };
  try {
    session.startTransaction();
    await Revision.updateOne({ _id: config.businessId }, { $set: { revision: BigInt(version) } }, { session });
    await Change.create([{ businessId: config.businessId, scenarioId: config.scenarioId, revision: BigInt(version),
      eventOrdinal: 0, eventKey: `event-${version}`, effectiveAtUtc: now, ...change }], { session });
    await coord.recordCommittedChange({ businessId: config.businessId, scenarioId: config.scenarioId,
      dataVersion: String(version), change, eventOrdinal: 0, session, now,
      affectedLocalDate: correction ? '2026-10-01' : null });
    await session.commitTransaction();
  } finally { await session.endSession(); }
}
function worker(options = {}) {
  return createForecastRidgeTrainingWorker({ registry, clock: () => now,
    runTraining: async request => result(request), log: () => {}, ...options });
}
async function state(h = 7) { return State.findOne(scope(h)).setOptions({ useBigInt64: true }).lean(); }
async function active(h = 7) { return registry.getActiveModelMetadata(scope(h)); }

test('certified policy outcomes and durable lifecycle on isolated local rs0', { timeout: 120000 }, async t => {
  const target = new URL(process.env.MONGODB_TEST_URI);
  assert.match(target.pathname, /^\/forecast_lifecycle_[a-f0-9]{32}_test$/);
  cases = JSON.parse(execFileSync(process.env.FORECAST_TRAINING_PYTHON,
    ['-m', 'ml.tests.test_m6_10a341_ridge_policy', '--emit-cases'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
  await mongoose.connect(target.href, { serverSelectionTimeoutMS: 10000 });
  const database = mongoose.connection.name;
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.equal(hello.setName, 'rs0'); assert.equal(hello.isWritablePrimary, true);
    await Promise.all([Job, Artifact, Pointer, State, Event, Revision, Change].map(m => m.init()));
    await t.test('PASS persists v2, supersedes v1, exact ACK, horizon isolation and no 1d', async () => {
      await reset();
      const answer = await worker().runEligible({ horizonDays: 7, leaseOwner: 'pass-worker' });
      assert.equal(answer.status, 'PROMOTED'); assert.equal(answer.modelVersion, 2);
      assert.equal((await active()).modelVersion, 2);
      assert.equal((await Artifact.findOne({ ...scope(7), modelVersion: 1 })).status, 'SUPERSEDED');
      const s = await state();
      assert.equal(s.lastProcessedDataVersion, 100n); assert.equal(s.lastOutcome, 'PROMOTED');
      assert.equal(s.lastTrainedMatureOrigin, coord.matureOrigin(coord.watermark(now), 7));
      assert.equal(s.lastModelVersion, 2); assert.equal(s.lastAckFencingToken, 1); assert.equal(s.status, 'IDLE');
      assert.equal((await active(14)).modelVersion, 1);
      assert.equal(await Artifact.countDocuments({ horizonDays: 1 }), 0);
      assert.equal(await Job.countDocuments({ horizonDays: 1 }), 0);
      assert.equal(await worker().runEligible({ horizonDays: 7, leaseOwner: 'again' }), null);
      console.info(JSON.stringify({ event: 'LOCAL_LIFECYCLE_TIMING', ...answer.performanceMs }));
    });
    await t.test('quality REJECT persists reasons and ACKs dataset while retaining ACTIVE', async () => {
      await reset();
      const answer = await worker({ runTraining: async request => result(request, 'WAPE') })
        .runEligible({ horizonDays: 7, leaseOwner: 'reject-worker' });
      assert.equal(answer.status, 'REJECTED'); assert.equal((await active()).modelVersion, 1);
      const rejected = await Artifact.findOne({ ...scope(7), modelVersion: 2 }).lean();
      assert.equal(rejected.status, 'REJECTED'); assert(rejected.checks.reasons.includes('G1_POOLED_WAPE_5PCT'));
      assert.equal((await state()).lastOutcome, 'REJECTED');
      assert.equal((await state()).lastProcessedDataVersion, 100n);
      assert.equal((await Job.findOne()).status, 'REJECTED');
    });
    await t.test('14d PASS uses its own registry version and leaves 7d untouched', async () => {
      await reset();
      await worker({ runTraining: async request => result(request, 'PASS14') })
        .runEligible({ horizonDays: 14, leaseOwner: 'fourteen' });
      assert.equal((await active(14)).modelVersion, 2); assert.equal((await active(7)).modelVersion, 1);
      assert.equal((await state(14)).lastModelVersion, 2); assert.equal((await state(7)).lastProcessedDataVersion, null);
    });
    await t.test('zero target volume is REJECTED with undefined metrics preserved as null', async () => {
      await reset();
      await worker({ runTraining: async request => result(request, 'ZERO_VOLUME') })
        .runEligible({ horizonDays: 7, leaseOwner: 'zero-volume' });
      const rejected = await Artifact.findOne({ ...scope(7), modelVersion: 2 });
      assert.equal(rejected.status, 'REJECTED'); assert.equal(rejected.globalWape, null);
      assert.equal(rejected.globalBias, null); assert.equal((await active()).modelVersion, 1);
    });
    await t.test('insufficient history ACK without candidate or version increment', async () => {
      await reset();
      const answer = await worker({ runTraining: async request => ({ ...result(request), artifact: null,
        evaluationStatus: 'INSUFFICIENT_EVALUATION_HISTORY', checks: { policyHash: P,
          policyVersion: 'M6.10A22-PROMOTION-v1', status: 'INSUFFICIENT_EVALUATION_HISTORY', reasons: ['INSUFFICIENT_EVALUATION_HISTORY'] } }) })
        .runEligible({ horizonDays: 7, leaseOwner: 'insufficient' });
      assert.equal(answer.status, 'NO_PROMOTION_INSUFFICIENT_HISTORY');
      assert.equal(await Artifact.countDocuments(scope(7)), 1);
      assert.equal((await Pointer.findOne(scope(7))).lastIssuedModelVersion, 1);
      assert.equal((await state()).lastOutcome, answer.status);
    });
    for (const outcome of ['PASS', 'WAPE', 'FAILED']) await t.test(`event 101 during ${outcome} preserves pending data`, async () => {
      await reset();
      const w = worker({ runTraining: async request => {
        await signal(101);
        if (outcome === 'FAILED') throw Object.assign(new Error('runtime'), { code: 'TRAINING_RUNTIME_UNAVAILABLE' });
        return result(request, outcome);
      } });
      if (outcome === 'FAILED') await assert.rejects(w.runEligible({ horizonDays: 7, leaseOwner: 'racing' }));
      else await w.runEligible({ horizonDays: 7, leaseOwner: 'racing' });
      const s = await state(); assert.equal(s.latestDataVersion, 101n); assert.equal(s.status, 'PENDING');
      assert.equal(s.lastProcessedDataVersion, outcome === 'FAILED' ? null : 100n);
      if (outcome === 'FAILED') assert.equal(s.lastFailureRetryable, true);
    });
    await t.test('historical correction during training survives ACK of old dataset', async () => {
      await reset();
      await worker({ runTraining: async request => { await signal(101, true); return result(request); } })
        .runEligible({ horizonDays: 7, leaseOwner: 'correction' });
      const s = await state(); assert.equal(s.historicalCorrectionVersion, 101n);
      assert.equal(s.affectedLocalDate, '2026-10-01'); assert.equal(s.lastProcessedDataVersion, 100n);
    });
    await t.test('technical parity failure is terminal, retains v1 and does not ACK', async () => {
      await reset();
      await assert.rejects(worker({ runTraining: async () => { throw Object.assign(new Error('parity'), { code: 'ARTIFACT_PARITY_FAILED' }); } })
        .runEligible({ horizonDays: 7, leaseOwner: 'technical' }), { code: 'ARTIFACT_PARITY_FAILED' });
      assert.equal((await active()).modelVersion, 1); assert.equal((await Job.findOne()).status, 'FAILED');
      assert.equal((await state()).lastFailureRetryable, false); assert.equal((await state()).lastProcessedDataVersion, null);
      now = new Date(now.getTime() + 16 * 60000);
      assert.equal(await worker().runEligible({ horizonDays: 7, leaseOwner: 'no-loop' }), null);
    });
    for (const code of ['FEATURE_UNAVAILABLE', 'POLICY_COMPUTATION_FAILED']) await t.test(`technical ${code} is FAILED, never a quality ACK`, async () => {
      await reset();
      await assert.rejects(worker({ runTraining: async () => { throw Object.assign(new Error(code), { code }); } })
        .runEligible({ horizonDays: 7, leaseOwner: 'technical-code' }), { code });
      assert.equal((await Job.findOne()).status, 'FAILED'); assert.equal((await state()).lastProcessedDataVersion, null);
      assert.equal((await active()).modelVersion, 1);
    });
    await t.test('inconsistent export aborts before fit and calls retryable failUpdate', async () => {
      await reset(); let fit = 0;
      await assert.rejects(worker({ update: { ...coord, exportOperationalChanges: async () => {
        throw new Error('TRAINING_EXPORT_VERSION_MISMATCH');
      } }, runTraining: async request => { fit += 1; return result(request); } })
        .runEligible({ horizonDays: 7, leaseOwner: 'export-race' }), { code: 'TRAINING_EXPORT_VERSION_MISMATCH' });
      assert.equal(fit, 0); assert.equal((await state()).lastFailureRetryable, true);
      assert.equal((await Job.findOne()).status, 'FAILED'); assert.equal((await active()).modelVersion, 1);
    });
    await t.test('PASS without the approved 107-origin protocol fails before candidate', async () => {
      await reset();
      await assert.rejects(worker({ runTraining: async request => {
        const answer = result(request); answer.checks.protocol.availableOrigins = 106; return answer;
      } }).runEligible({ horizonDays: 7, leaseOwner: 'invalid-protocol' }), { code: 'TRAINING_RESPONSE_INVALID' });
      assert.equal(await Artifact.countDocuments(scope(7)), 1); assert.equal((await state()).lastProcessedDataVersion, null);
    });
    await t.test('concurrent workers issue one candidate/version and one ACK', async () => {
      await reset(); let fits = 0;
      const w = worker({ runTraining: async request => { fits += 1; return result(request); } });
      const answers = await Promise.all(['concurrent-a', 'concurrent-b'].map(leaseOwner =>
        w.runEligible({ horizonDays: 7, leaseOwner })));
      assert.equal(answers.filter(Boolean).length, 1); assert.equal(fits, 1);
      assert.equal(await Job.countDocuments(), 1); assert.equal((await Pointer.findOne(scope(7))).lastIssuedModelVersion, 2);
    });
    await t.test('stale worker cannot persist candidate; new token recovers same job', async () => {
      await reset(); let recovered;
      await assert.rejects(worker({ runTraining: async request => {
        now = new Date(now.getTime() + 6 * 60000);
        recovered = await coord.claimEligibleUpdate({ ...scope(7), leaseOwner: 'worker-b', now });
        return result(request);
      } }).runEligible({ horizonDays: 7, leaseOwner: 'worker-a' }), { code: 'STALE_FENCING_TOKEN' });
      assert.equal(await Artifact.countDocuments(scope(7)), 1);
      assert.equal((await state()).leaseOwner, 'worker-b');
      await worker().process({ ...scope(7), inputDataVersion: recovered.inputDataVersion,
        observationsClosedThrough: recovered.observationsClosedThrough, claim: recovered });
      assert.equal(await Job.countDocuments(), 1); assert.equal((await active()).modelVersion, 2);
    });
    await t.test('lost lease before promotion leaves candidate unserved for recovered worker', async () => {
      await reset(); let recovered;
      await assert.rejects(worker({ beforePromotion: async () => {
        now = new Date(now.getTime() + 6 * 60000);
        recovered = await coord.claimEligibleUpdate({ ...scope(7), leaseOwner: 'promote-b', now });
      } }).runEligible({ horizonDays: 7, leaseOwner: 'promote-a' }), { code: 'STALE_FENCING_TOKEN' });
      assert.equal((await active()).modelVersion, 1);
      const w = worker({ runTraining: async () => { throw new Error('must reuse prepared artifact'); } });
      await w.process({ ...scope(7), inputDataVersion: recovered.inputDataVersion,
        observationsClosedThrough: recovered.observationsClosedThrough, claim: recovered });
      assert.equal((await active()).modelVersion, 2);
      assert.equal((await Pointer.findOne(scope(7))).lastIssuedModelVersion, 2);
    });
    await t.test('full promotion transaction rollback keeps exact v1 pointer and no false ACK', async () => {
      await reset();
      const broken = createForecastModelRegistryService({ afterPromotionWrites: () => {
        throw Object.assign(new Error('injected rollback'), { code: 'PROMOTION_TEST_FAILURE' });
      } });
      await assert.rejects(worker({ registry: broken }).runEligible({ horizonDays: 7, leaseOwner: 'rollback' }));
      assert.equal((await active()).modelVersion, 1);
      assert.equal(await Artifact.countDocuments({ ...scope(7), status: 'ACTIVE' }), 1);
      assert.equal((await Artifact.findOne({ ...scope(7), modelVersion: 2 })).status, 'FAILED');
      assert.equal((await state()).lastProcessedDataVersion, null);
    });
    await t.test('CAS loser cannot serve candidate and leaves legitimate winning pointer intact', async () => {
      await reset();
      await assert.rejects(worker({ beforePromotion: async () => {
        const winner = await seedCandidate(7, 'cas-winner');
        await registry.promoteCandidate({ ...scope(7), modelVersion: winner.modelVersion, expectedGeneration: 1 });
      } }).runEligible({ horizonDays: 7, leaseOwner: 'cas-loser' }), { code: 'REGISTRY_CAS_CONFLICT' });
      assert.equal((await active()).modelVersion, 3);
      assert.equal((await Artifact.findOne({ ...scope(7), modelVersion: 2 })).status, 'FAILED');
      assert.equal((await state()).lastProcessedDataVersion, null);
    });
    await t.test('restart retries same prepared job/candidate without new version or fit', async () => {
      await reset({ correction: true });
      await assert.rejects(worker({ beforePromotion: () => {
        throw Object.assign(new Error('transient exhaustion'), { code: 'TRANSACTION_RETRY_EXHAUSTED' });
      } }).runEligible({ horizonDays: 7, leaseOwner: 'restart-a' }));
      assert.equal((await Job.findOne()).retryable, true);
      now = new Date(now.getTime() + 16 * 60000);
      await worker({ runTraining: async () => { throw new Error('do not refit'); } })
        .runEligible({ horizonDays: 7, leaseOwner: 'restart-b' });
      assert.equal(await Job.countDocuments(), 1);
      assert.equal((await Pointer.findOne(scope(7))).lastIssuedModelVersion, 2);
      assert.equal((await active()).modelVersion, 2);
    });
    await t.test('promotion survives ACK failure; restart ACKs without double promotion', async () => {
      await reset({ correction: true });
      await assert.rejects(worker({ update: { ...coord, ackUpdate: async () => { throw new Error('ack network'); } } })
        .runEligible({ horizonDays: 7, leaseOwner: 'ack-a' }), { code: 'ACK_PENDING' });
      assert.equal((await active()).modelVersion, 2);
      now = new Date(now.getTime() + 16 * 60000);
      await worker({ runTraining: async () => { throw new Error('no duplicate train'); } })
        .runEligible({ horizonDays: 7, leaseOwner: 'ack-b' });
      const s = await state(), job = await Job.findOne().lean();
      assert.equal(job.status, 'PROMOTED'); assert(job.ackedAt);
      assert.equal((await Pointer.findOne(scope(7))).lastIssuedModelVersion, 2);
      const oldTime = s.lastSuccessAt.getTime();
      assert.equal(await coord.ackUpdate({ ...scope(7), leaseOwner: 'ack-b', fencingToken: s.lastAckFencingToken,
        inputDataVersion: '100', processedMatureOrigin: s.lastTrainedMatureOrigin, modelVersion: 2,
        outcome: 'PROMOTED', jobKey: job.trainingKey, now }), true);
      assert.equal((await state()).lastSuccessAt.getTime(), oldTime);
    });
    await t.test('lease lost after promotion forbids stale ACK and new token finishes it', async () => {
      await reset(); let recovered;
      const wrappedRegistry = { ...registry, promoteCandidate: async input => {
        const answer = await registry.promoteCandidate(input);
        now = new Date(now.getTime() + 6 * 60000);
        recovered = await coord.claimEligibleUpdate({ ...scope(7), leaseOwner: 'ack-new-token', now });
        return answer;
      } };
      await assert.rejects(worker({ registry: wrappedRegistry }).runEligible({ horizonDays: 7, leaseOwner: 'ack-stale' }),
        { code: 'STALE_FENCING_TOKEN' });
      assert.equal((await state()).lastProcessedDataVersion, null);
      assert.equal((await active()).modelVersion, 2);
      await worker({ runTraining: async () => { throw new Error('no new fit'); } }).process({ ...scope(7),
        inputDataVersion: recovered.inputDataVersion, observationsClosedThrough: recovered.observationsClosedThrough, claim: recovered });
      assert.equal((await state()).lastAckFencingToken, recovered.fencingToken);
      assert.equal((await Pointer.findOne(scope(7))).lastIssuedModelVersion, 2);
    });
    await t.test('ACK metadata mismatch fails without changing claim', async () => {
      await reset();
      const claim = await coord.claimEligibleUpdate({ ...scope(7), leaseOwner: 'exact-ack', now });
      await assert.rejects(coord.ackUpdate({ ...claim, inputDataVersion: '99', processedMatureOrigin: claim.latestMatureOrigin,
        outcome: 'REJECTED', now }), { code: 'ACK_DATASET_MISMATCH' });
      assert.equal((await state()).status, 'CLAIMED'); assert.equal((await state()).lastProcessedDataVersion, null);
    });
    await t.test('claim pins current global revision when unrelated writes advanced journal', async () => {
      await reset();
      await Revision.updateOne({ _id: config.businessId }, { $set: { revision: 105n } });
      const claim = await coord.claimEligibleUpdate({ ...scope(7), leaseOwner: 'global-version', now });
      assert.equal(claim.inputDataVersion, '105');
      assert.equal((await state()).claimedDataVersion, 105n);
    });
    await t.test('real local --drain returns insufficient history without training or replacing v1', async () => {
      await reset();
      const current = new Date(), closed = coord.watermark(current);
      await State.updateMany({}, { $set: { observationsClosedThrough: closed,
        nextEligibleAt: new Date(current - 1000), lastDirtyAt: new Date(current - 86400000),
        latestMatureOrigin: '2026-10-01', initialMatureOrigin: '2026-09-01' } });
      const output = execFileSync(process.execPath, ['scripts/run-v3-ridge-training-local.js', '--drain', '7'],
        { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30000,
          env: { ...process.env, FORECAST_LOCAL_MONGO_URI: target.href } });
      const answer = JSON.parse(output.trim().split('\n').at(-1));
      assert.equal(answer.result.status, 'NO_PROMOTION_INSUFFICIENT_HISTORY');
      assert.equal(await Artifact.countDocuments(scope(7)), 1);
      assert.equal((await active()).modelVersion, 1);
      assert.equal((await state()).lastOutcome, 'NO_PROMOTION_INSUFFICIENT_HISTORY');
    });
    await t.test('foreign tenant and 1d cannot create state/job/artifact; logs contain no payload', async () => {
      await reset(); const logs = [];
      const w = worker({ log: (event, fields) => logs.push({ event, ...fields }) });
      await assert.rejects(w.runEligible({ horizonDays: 1, leaseOwner: 'one' }), { code: 'MODEL_NOT_APPROVED' });
      await assert.rejects(w.runEligible({ horizonDays: 7, businessId: 'other', leaseOwner: 'other' }), { code: 'INVALID_SCOPE' });
      await w.runEligible({ horizonDays: 7, leaseOwner: 'logs' });
      const wire = JSON.stringify(logs);
      for (const forbidden of ['coefficients', 'artifactBase64', 'projection', 'mongodb:', 'password']) assert(!wire.includes(forbidden));
      assert(logs.some(x => x.event === 'ML_MODEL_PROMOTED'));
      assert.equal(await Job.countDocuments({ horizonDays: 1 }), 0);
      const persisted = await registry.getActiveModelArtifact(scope(7));
      assert.equal(crypto.createHash('sha256').update(persisted.artifactData).digest('hex'), persisted.metadata.artifactHash);
    });
  } finally {
    assert.equal(mongoose.connection.name, database);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
