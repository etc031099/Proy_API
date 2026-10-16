'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const config = require('../../src/config/v3Operational');
const { V3OperationalRevision: Revision, ForecastModelArtifact: Artifact,
  ForecastModelRegistry: Pointer, ForecastTrainingJob: Job } = require('../../src/models');
const { createForecastRidgeTrainingWorker } = require('../../src/services/forecastRidgeTrainingWorker');
const { createForecastModelRegistryService } = require('../../src/services/forecastModelRegistryService');

test('bootstrap local Ridge 7/14 from pinned history, with exact ACTIVE reload',
  { timeout: 180000 }, async () => {
    await mongoose.connect(process.env.MONGODB_TEST_URI, { serverSelectionTimeoutMS: 10000 });
    const dbName = mongoose.connection.db.databaseName;
    assert.match(dbName, /^forecast_ridge_[a-f0-9]+_test$/);
    try {
      const hello = await mongoose.connection.db.admin().command({ hello: 1 });
      assert.equal(hello.setName, 'rs0');
      assert.equal(hello.isWritablePrimary, true);
      await Promise.all([Revision.init(), Artifact.init(), Pointer.init(), Job.init()]);
      await Revision.create({ _id: config.businessId, revision: 0n, bootstrapStatus: 'VERIFIED',
        historicalDatasetVersion: config.datasetVersion, historicalDatasetSha256: config.sourceSha256 });
      const worker = createForecastRidgeTrainingWorker({ log: () => {} });
      const seven = await worker.bootstrapLocal({ horizonDays: 7, observationsClosedThrough: '2026-10-15' });
      const fourteen = await worker.bootstrapLocal({ horizonDays: 14, observationsClosedThrough: '2026-10-15' });
      assert.equal(seven.status, 'PROMOTED');
      assert.equal(fourteen.status, 'PROMOTED');
      assert.equal(seven.modelVersion, 1);
      assert.equal(fourteen.modelVersion, 1);
      const reader = createForecastModelRegistryService(); // restart-like service recreation
      for (const horizonDays of [7, 14]) {
        const scope = { businessId: config.businessId, scenarioId: config.scenarioId, horizonDays };
        assert.equal(await Artifact.countDocuments({ ...scope, status: 'ACTIVE' }), 1);
        const envelope = await reader.getActiveModelArtifact(scope);
        assert.equal(envelope.metadata.status, 'ACTIVE');
        assert.equal(envelope.metadata.modelVersion, 1);
        assert.equal(crypto.createHash('sha256').update(envelope.artifactData).digest('hex'),
          envelope.metadata.artifactHash);
        const parsed = JSON.parse(envelope.artifactData.toString('utf8'));
        assert.equal(parsed.modelVersion, 1);
        assert.equal(parsed.horizonDays, horizonDays);
      }
      assert.equal(await Artifact.countDocuments({ horizonDays: 1 }), 0);
      assert.equal(await Job.countDocuments({ horizonDays: 1 }), 0);
      assert.equal((await worker.bootstrapLocal({ horizonDays: 7,
        observationsClosedThrough: '2026-10-15' })).idempotent, true);
    } finally {
      await mongoose.connection.dropDatabase(); // exact random disposable _test DB only
      await mongoose.disconnect();
    }
  });
