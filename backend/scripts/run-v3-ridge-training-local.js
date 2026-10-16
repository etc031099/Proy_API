'use strict';

// Explicit local-only entrypoint. Never imported by the HTTP application.
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { ForecastModelArtifact, ForecastModelRegistry, ForecastTrainingJob,
  ForecastMlUpdateState, ForecastMlUpdateEvent } = require('../src/models');
const { watermark } = require('../src/services/forecastMlUpdateCoordinator');
const { createForecastRidgeTrainingWorker } = require('../src/services/forecastRidgeTrainingWorker');

async function main() {
  const uri = process.env.FORECAST_LOCAL_MONGO_URI;
  if (!uri) throw new Error('FORECAST_LOCAL_MONGO_URI is required.');
  const target = new URL(uri);
  if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      || !target.pathname || target.pathname === '/' || target.searchParams.has('srv')) {
    throw new Error('Refusing a non-local or unspecified Mongo database.');
  }
  const mode = process.argv[2];
  const horizonDays = Number(process.argv[3]);
  if (!['--bootstrap', '--drain'].includes(mode) || ![7, 14].includes(horizonDays)) {
    throw new Error('Usage: node scripts/run-v3-ridge-training-local.js --bootstrap|--drain 7|14');
  }
  target.searchParams.set('directConnection', 'true');
  await mongoose.connect(target.href, { serverSelectionTimeoutMS: 5000 });
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (hello.setName !== 'rs0' || !hello.isWritablePrimary) throw new Error('Local rs0 PRIMARY is required.');
    await Promise.all([ForecastModelArtifact, ForecastModelRegistry, ForecastTrainingJob,
      ForecastMlUpdateState, ForecastMlUpdateEvent].map(model => model.init()));
    const worker = createForecastRidgeTrainingWorker();
    const result = mode === '--bootstrap'
      ? await worker.bootstrapLocal({ horizonDays, observationsClosedThrough: watermark(new Date()) })
      : await worker.runEligible({ horizonDays, leaseOwner: `local-${randomUUID()}` });
    process.stdout.write(`${JSON.stringify({ mode, horizonDays, result })}\n`);
  } finally { await mongoose.disconnect(); }
}

main().catch(error => {
  process.stderr.write(`${error.code || 'FORECAST_WORKER_FAILED'}\n`);
  process.exitCode = 1;
});
