'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { ForecastModelArtifact, ForecastModelRegistry } = require('../../src/models');
const {
  createForecastModelRegistryService,
  ForecastRegistryError,
  PROMOTION_POLICY_VERSION,
  PROMOTION_POLICY_HASH
} = require('../../src/services/forecastModelRegistryService');

const uri = process.env.MONGODB_TEST_URI;
const testDatabasePattern = /^forecast_registry_[a-f0-9]{32}_test$/;
const bytesFor = label => Buffer.from(`fixture:${label}`, 'utf8');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function candidateInput({ businessId = 'registry-tenant-a', scenarioId = 'scenario-fixture', horizonDays = 7,
  label = `${businessId}-${horizonDays}-${Date.now()}-${crypto.randomUUID()}`, idempotencyKey } = {}) {
  const artifactData = bytesFor(label);
  return {
    businessId, scenarioId, horizonDays,
    modelFamily: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27',
    trainedAt: new Date('2026-10-16T12:00:00.000Z'), trainedDataVersion: '12',
    dataCutoff: '2026-10-15', trainingWindow: { startDate: '2025-10-13', endDate: '2026-09-01' },
    labelClosedThrough: '2026-09-01', featureVersion: 'CAUSAL27-v1', featureHash: 'a'.repeat(64),
    promotionPolicyVersion: PROMOTION_POLICY_VERSION, promotionPolicyHash: PROMOTION_POLICY_HASH,
    globalWape: 0.21, globalMae: 2.7, globalBias: -0.02,
    checks: { global: { passed: true }, groups: [] }, triggerReason: 'ACCEPTANCE_FIXTURE',
    artifactHash: digest(artifactData), sourceDatasetHash: 'b'.repeat(64), artifactData,
    lineage: { source: 'local-test-fixture', datasetVersion: 'fixture-v1' }, idempotencyKey
  };
}

const service = createForecastModelRegistryService();

test('forecast model registry supports isolated tenant/horizon versions, CAS promotion, idempotency, rollback, and integrity',
  { timeout: 30000 }, async () => {
    assert.ok(uri, 'MONGODB_TEST_URI is required');
    const parsed = new URL(uri);
    assert.equal(parsed.protocol, 'mongodb:');
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
    assert.equal(parsed.searchParams.get('directConnection'), 'true');
    assert.equal(parsed.searchParams.has('replicaSet'), false);
    assert.match(parsed.pathname.slice(1), testDatabasePattern);

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, directConnection: true });
    const dbName = mongoose.connection.name;
    assert.match(dbName, testDatabasePattern, 'test runner must point only at its disposable random database');
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.equal(hello.setName, 'rs0', 'transactions require the configured local replica set');
    assert.equal(hello.isWritablePrimary, true);
    await Promise.all([ForecastModelArtifact.init(), ForecastModelRegistry.init()]);

    const artifactIndexes = await ForecastModelArtifact.collection.listIndexes().toArray();
    const registryIndexes = await ForecastModelRegistry.collection.listIndexes().toArray();
    assert(artifactIndexes.some(index => index.name === 'forecast_model_artifact_version_uq' && index.unique));
    assert(artifactIndexes.some(index => index.name === 'forecast_model_one_active_per_horizon_uq'
      && index.unique && index.partialFilterExpression?.status === 'ACTIVE'));
    assert(artifactIndexes.some(index => index.name === 'forecast_model_artifact_idempotency_uq' && index.unique));
    assert(registryIndexes.some(index => index.name === 'forecast_model_registry_scope_uq' && index.unique));

    await assert.rejects(service.createCandidateMetadata(candidateInput({ horizonDays: 1 })),
      error => error instanceof ForecastRegistryError && error.code === 'UNSUPPORTED_HORIZON');
    await assert.rejects(service.createCandidateMetadata({ ...candidateInput(), globalWape: Infinity }),
      error => error instanceof ForecastRegistryError && error.code === 'INVALID_METRICS');
    await assert.rejects(service.createCandidateMetadata({ ...candidateInput(), artifactHash: 'f'.repeat(64) }),
      error => error instanceof ForecastRegistryError && error.code === 'ARTIFACT_HASH_MISMATCH');
    const emptyArtifactInput = candidateInput({ businessId: 'registry-empty-artifact', label: 'empty-placeholder' });
    emptyArtifactInput.artifactData = Buffer.alloc(0);
    emptyArtifactInput.artifactHash = digest(emptyArtifactInput.artifactData);
    const emptyArtifact = await service.createCandidateMetadata(emptyArtifactInput);
    assert.equal(emptyArtifact.artifactBytes, 0);
    await assert.rejects(service.promoteCandidate({ businessId: emptyArtifactInput.businessId,
      scenarioId: emptyArtifactInput.scenarioId, horizonDays: 7, modelVersion: 1, expectedGeneration: 0 }),
    error => error.code === 'CANDIDATE_METADATA_INVALID');
    assert.equal((await ForecastModelArtifact.findById(emptyArtifact._id)).status, 'CANDIDATE');

    const input7 = candidateInput({ label: 'tenant-a-7-v1', idempotencyKey: 'candidate-a7-v1-key' });
    const first7 = await service.createCandidateMetadata(input7);
    assert.equal(first7.modelVersion, 1);
    assert.equal(first7.status, 'CANDIDATE');
    assert.equal(Object.hasOwn(first7, 'artifactData'), false);
    const repeatedCreate = await service.createCandidateMetadata(input7);
    assert.equal(repeatedCreate._id.toString(), first7._id.toString());
    assert.equal(await ForecastModelArtifact.countDocuments({ businessId: input7.businessId, horizonDays: 7 }), 1);
    await ForecastModelArtifact.updateOne({ _id: first7._id }, { $set: { globalWape: 99, recipeId: 'TAMPERED' } });
    const immutableMetadata = await ForecastModelArtifact.findById(first7._id).lean();
    assert.equal(immutableMetadata.globalWape, input7.globalWape);
    assert.equal(immutableMetadata.recipeId, input7.recipeId);

    const promoted7 = await service.promoteCandidate({ businessId: input7.businessId, scenarioId: input7.scenarioId,
      horizonDays: 7, modelVersion: 1, expectedGeneration: 0 });
    assert.equal(promoted7.generation, 1);
    assert.equal(promoted7.idempotent, false);
    const exactActive7 = await service.getActiveModelMetadata({ businessId: input7.businessId,
      scenarioId: input7.scenarioId, horizonDays: 7 });
    assert.equal(exactActive7.modelVersion, 1);
    assert.equal(exactActive7.status, 'ACTIVE');
    assert.equal(Object.hasOwn(exactActive7, 'artifactData'), false);
    const activeBytes7 = await service.getActiveModelArtifact({ businessId: input7.businessId,
      scenarioId: input7.scenarioId, horizonDays: 7 });
    assert.deepEqual(activeBytes7.artifactData, input7.artifactData);
    assert.equal(digest(activeBytes7.artifactData), activeBytes7.metadata.artifactHash);
    await ForecastModelArtifact.collection.updateOne({ _id: first7._id }, { $set: { artifactData: bytesFor('tampered') } });
    await assert.rejects(service.getActiveModelArtifact({ businessId: input7.businessId,
      scenarioId: input7.scenarioId, horizonDays: 7 }),
    error => error instanceof ForecastRegistryError && error.code === 'ARTIFACT_HASH_MISMATCH');
    await ForecastModelArtifact.collection.updateOne({ _id: first7._id }, { $set: { artifactData: input7.artifactData } });

    const second7Input = candidateInput({ label: 'tenant-a-7-v2' });
    const second7 = await service.createCandidateMetadata(second7Input);
    assert.equal(second7.modelVersion, 2);
    const promotedV2 = await service.promoteCandidate({ businessId: input7.businessId, scenarioId: input7.scenarioId,
      horizonDays: 7, modelVersion: 2, expectedGeneration: 1 });
    assert.equal(promotedV2.generation, 2);
    assert.equal((await ForecastModelArtifact.findById(first7._id)).status, 'SUPERSEDED');
    assert.equal((await ForecastModelArtifact.findById(second7._id)).status, 'ACTIVE');
    const duplicatePromotion = await service.promoteCandidate({ businessId: input7.businessId,
      scenarioId: input7.scenarioId, horizonDays: 7, modelVersion: 2, expectedGeneration: 0 });
    assert.equal(duplicatePromotion.idempotent, true);
    assert.equal(duplicatePromotion.generation, 2);

    const stale = await service.createCandidateMetadata(candidateInput({ label: 'tenant-a-7-stale' }));
    await assert.rejects(service.promoteCandidate({ businessId: input7.businessId, scenarioId: input7.scenarioId,
      horizonDays: 7, modelVersion: stale.modelVersion, expectedGeneration: 0 }),
    error => error instanceof ForecastRegistryError && error.code === 'CONFLICT');
    assert.equal((await ForecastModelArtifact.findById(stale._id)).status, 'CANDIDATE');
    assert.equal((await service.getActiveModelMetadata({ businessId: input7.businessId,
      scenarioId: input7.scenarioId, horizonDays: 7 })).modelVersion, 2);

    const rejected = await service.createCandidateMetadata(candidateInput({ label: 'tenant-a-7-rejected' }));
    const rejection = await service.rejectCandidate({ businessId: input7.businessId, scenarioId: input7.scenarioId,
      horizonDays: 7, modelVersion: rejected.modelVersion });
    assert.equal(rejection.artifact.status, 'REJECTED');
    await assert.rejects(service.promoteCandidate({ businessId: input7.businessId, scenarioId: input7.scenarioId,
      horizonDays: 7, modelVersion: rejected.modelVersion, expectedGeneration: 2 }),
    error => error.code === 'CANDIDATE_NOT_PROMOTABLE');
    const failed = await service.createCandidateMetadata(candidateInput({ label: 'tenant-a-7-failed' }));
    assert.equal((await service.markCandidateFailed({ businessId: input7.businessId, scenarioId: input7.scenarioId,
      horizonDays: 7, modelVersion: failed.modelVersion, failureCode: 'TRAINING_FAILED' })).artifact.status, 'FAILED');
    await assert.rejects(service.promoteCandidate({ businessId: input7.businessId, scenarioId: input7.scenarioId,
      horizonDays: 7, modelVersion: failed.modelVersion, expectedGeneration: 2 }),
    error => error.code === 'CANDIDATE_NOT_PROMOTABLE');
    assert.equal((await service.getActiveModelMetadata({ businessId: input7.businessId,
      scenarioId: input7.scenarioId, horizonDays: 7 })).modelVersion, 2);

    const input14 = candidateInput({ label: 'tenant-a-14-v1', horizonDays: 14 });
    const first14 = await service.createCandidateMetadata(input14);
    assert.equal(first14.modelVersion, 1, 'version sequence is independent per horizon');
    assert.equal((await service.promoteCandidate({ businessId: input14.businessId, scenarioId: input14.scenarioId,
      horizonDays: 14, modelVersion: 1, expectedGeneration: 0 })).generation, 1);
    assert.equal((await service.getActiveModelMetadata({ businessId: input14.businessId,
      scenarioId: input14.scenarioId, horizonDays: 14 })).modelVersion, 1);

    const inputTenantB = candidateInput({ businessId: 'registry-tenant-b', label: 'tenant-b-7-v1' });
    const tenantB = await service.createCandidateMetadata(inputTenantB);
    assert.equal(tenantB.modelVersion, 1);
    await service.promoteCandidate({ businessId: inputTenantB.businessId, scenarioId: inputTenantB.scenarioId,
      horizonDays: 7, modelVersion: 1, expectedGeneration: 0 });
    assert.equal(await service.getActiveModelMetadata({ businessId: 'registry-tenant-a',
      scenarioId: input7.scenarioId, horizonDays: 7 }).then(row => row.modelVersion), 2);
    assert.equal(await service.getActiveModelMetadata({ businessId: 'registry-tenant-a',
      scenarioId: input7.scenarioId, horizonDays: 14 }).then(row => row.modelVersion), 1);
    assert.equal(await service.getActiveModelMetadata({ businessId: 'registry-tenant-a',
      scenarioId: 'other-scenario', horizonDays: 7 }), null);
    assert.deepEqual((await service.listModelVersions({ businessId: 'registry-tenant-a',
      scenarioId: input7.scenarioId, horizonDays: 7 })).map(row => row.modelVersion), [5, 4, 3, 2, 1]);
    assert.equal((await service.listModelVersions({ businessId: 'registry-tenant-a', scenarioId: input7.scenarioId,
      horizonDays: 7 })).some(row => row.businessId === 'registry-tenant-b'), false);
    await assert.rejects(service.promoteCandidate({ businessId: inputTenantB.businessId, scenarioId: input7.scenarioId,
      horizonDays: 7, modelVersion: 2, expectedGeneration: 1 }),
    error => error.code === 'CANDIDATE_NOT_FOUND');

    const rollbackInput = candidateInput({ businessId: 'registry-rollback', label: 'rollback-v1' });
    const rollbackV1 = await service.createCandidateMetadata(rollbackInput);
    await service.promoteCandidate({ businessId: rollbackInput.businessId, scenarioId: rollbackInput.scenarioId,
      horizonDays: 7, modelVersion: 1, expectedGeneration: 0 });
    const rollbackV2Input = candidateInput({ businessId: 'registry-rollback', label: 'rollback-v2' });
    const rollbackV2 = await service.createCandidateMetadata(rollbackV2Input);
    const throwingService = createForecastModelRegistryService({ afterPromotionWrites: async () => {
      throw new Error('ROLLBACK_FIXTURE');
    } });
    await assert.rejects(throwingService.promoteCandidate({ businessId: rollbackInput.businessId,
      scenarioId: rollbackInput.scenarioId, horizonDays: 7, modelVersion: 2, expectedGeneration: 1 }), /ROLLBACK_FIXTURE/);
    assert.equal((await ForecastModelArtifact.findById(rollbackV1._id)).status, 'ACTIVE');
    assert.equal((await ForecastModelArtifact.findById(rollbackV2._id)).status, 'CANDIDATE');
    const rollbackPointer = await ForecastModelRegistry.findOne({ businessId: rollbackInput.businessId }).lean();
    assert.equal(rollbackPointer.generation, 1);
    assert.equal(rollbackPointer.activeModelVersion, 1);

    const raceBusiness = 'registry-concurrent';
    const [raceA, raceB] = await Promise.all([
      service.createCandidateMetadata(candidateInput({ businessId: raceBusiness, label: 'race-a' })),
      service.createCandidateMetadata(candidateInput({ businessId: raceBusiness, label: 'race-b' }))
    ]);
    assert.deepEqual([raceA.modelVersion, raceB.modelVersion].sort(), [1, 2]);
    const settled = await Promise.allSettled([raceA, raceB].map(row => service.promoteCandidate({
      businessId: raceBusiness, scenarioId: 'scenario-fixture', horizonDays: 7,
      modelVersion: row.modelVersion, expectedGeneration: 0
    })));
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    const loser = settled.find(result => result.status === 'rejected');
    assert(loser.reason instanceof ForecastRegistryError);
    assert.equal(loser.reason.code, 'CONFLICT');
    assert.equal(await ForecastModelArtifact.countDocuments({ businessId: raceBusiness, status: 'ACTIVE' }), 1);
    const racePointer = await ForecastModelRegistry.findOne({ businessId: raceBusiness }).lean();
    assert.equal(racePointer.generation, 1);
    // Concurrent allocation need not assign version 1 to the first promise.
    const winner = [raceA, raceB].find(row => racePointer.activeArtifactId.equals(row._id));
    assert(winner, 'ACTIVE pointer must resolve to one of the competing candidates');
    assert.equal(racePointer.activeModelVersion, winner.modelVersion);

  });

test.after(async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      const dbName = mongoose.connection.name;
      if (!testDatabasePattern.test(dbName)) throw new Error('Refusing to drop a non-disposable Mongo database.');
      await mongoose.connection.db.dropDatabase();
    }
  } finally {
    await mongoose.disconnect();
  }
});
