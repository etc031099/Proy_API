'use strict';

const mongoose = require('mongoose');
const config = require('../src/config/v3Operational');
const { V3OperationalRevision: Revision } = require('../src/models');
const { createForecastModelRegistryService } = require('../src/services/forecastModelRegistryService');
const { exportOperationalChanges, watermark } = require('../src/services/forecastMlUpdateCoordinator');
const { runPython } = require('../src/services/forecastRidgeTrainingWorker');

async function main() {
  if (!process.env.FORECAST_LOCAL_MONGO_URI) throw new Error('FORECAST_LOCAL_MONGO_URI is required.');
  const target = new URL(process.env.FORECAST_LOCAL_MONGO_URI);
  if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      || !target.pathname || target.pathname === '/') throw new Error('Refusing non-local Mongo.');
  target.searchParams.set('directConnection', 'true');
  await mongoose.connect(target.href, { serverSelectionTimeoutMS: 5000 });
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (hello.setName !== 'rs0' || !hello.isWritablePrimary) throw new Error('Local rs0 PRIMARY required.');
    const revision = await Revision.findById(config.businessId).setOptions({ useBigInt64: true }).lean();
    if (!revision || revision.bootstrapStatus !== 'VERIFIED'
        || revision.historicalDatasetSha256 !== config.sourceSha256) throw new Error('Invalid V3 lineage.');
    const version = String(revision.revision);
    const journal = [];
    await exportOperationalChanges({ businessId: config.businessId, scenarioId: config.scenarioId,
      inputDataVersion: version, onPage: async page => journal.push(...JSON.parse(JSON.stringify(page,
        (_, value) => typeof value === 'bigint' ? String(value) : value))) });
    const registry = createForecastModelRegistryService();
    const models = {};
    for (const horizonDays of [7, 14]) {
      const envelope = await registry.getActiveModelArtifact({ businessId: config.businessId,
        scenarioId: config.scenarioId, horizonDays });
      if (!envelope) throw new Error('ACTIVE_MODEL_NOT_FOUND');
      models[String(horizonDays)] = { metadata: envelope.metadata,
        artifactBase64: envelope.artifactData.toString('base64') };
    }
    const result = await runPython({ businessId: config.businessId, scenarioId: config.scenarioId,
      inputDataVersion: version, observationsClosedThrough: watermark(new Date()),
      journal, models }, { moduleName: 'ml.service.v3_ridge_bundle_check' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await mongoose.disconnect(); }
}

main().catch(error => {
  process.stderr.write(`${error.code || 'BUNDLE_CHECK_FAILED'}\n`);
  process.exitCode = 1;
});
