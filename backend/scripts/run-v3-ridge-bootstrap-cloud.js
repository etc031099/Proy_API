'use strict';

// Explicit operator entrypoint. Never imported by Express, never loads dotenv.
const { parseOptions, validateTarget, createCloudBootstrap } = require('../src/services/forecastCloudBootstrap');

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseOptions(argv);
  validateTarget(env.FORECAST_CLOUD_MONGO_URI, options['expected-database']);
  const mongoose = require('mongoose');
  // Prevent implicit model initialization from creating collections/indexes on a dry-run.
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  const { ForecastModelRegistry: Registry, ForecastModelArtifact: Artifact,
    ForecastTrainingJob: Job, V3OperationalRevision: Revision } = require('../src/models');
  const config = require('../src/config/v3Operational');
  const { exportOperationalChanges, watermark } = require('../src/services/forecastMlUpdateCoordinator');
  const { runPython, createForecastRidgeTrainingWorker } = require('../src/services/forecastRidgeTrainingWorker');
  try {
    await mongoose.connect(env.FORECAST_CLOUD_MONGO_URI, { autoCreate: false, autoIndex: false,
      serverSelectionTimeoutMS: 10000, dbName: options['expected-database'] });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (mongoose.connection.db.databaseName !== options['expected-database']
        || !hello.isWritablePrimary || !hello.setName || hello.setName === 'rs0') {
      throw Object.assign(new Error('CLOUD_ENVIRONMENT_MISMATCH'), { code: 'CLOUD_ENVIRONMENT_MISMATCH' });
    }
    const read = (model, filter, session) => model.findOne(filter).session(session || null).maxTimeMS(5000).lean();
    const bootstrap = createCloudBootstrap({
      watermark,
      readRevision: session => Revision.findById(config.businessId).session(session || null)
        .setOptions({ useBigInt64: true }).maxTimeMS(5000).lean(),
      readRegistry: (scope, session) => read(Registry, scope, session),
      countArtifacts: (scope, session) => Artifact.countDocuments(scope).session(session || null).maxTimeMS(5000),
      exportJournal: async inputDataVersion => {
        const journal = [];
        const result = await exportOperationalChanges({ businessId: config.businessId, scenarioId: config.scenarioId,
          inputDataVersion, onPage: async page => journal.push(...JSON.parse(JSON.stringify(page,
            (_, value) => typeof value === 'bigint' ? String(value) : value))) });
        if (!result.complete) throw Object.assign(new Error('DATASET_INVALID'), { code: 'DATASET_INVALID' });
        return journal;
      },
      inspectDataset: request => runPython(request),
      createWorker: bootstrapPrecondition => createForecastRidgeTrainingWorker({ bootstrapPrecondition }),
      assertIndexes: async () => {
        const required = [
          [Registry, 'forecast_model_registry_scope_uq'],
          [Artifact, 'forecast_model_artifact_version_uq'],
          [Artifact, 'forecast_model_one_active_per_horizon_uq'],
          [Artifact, 'forecast_model_artifact_idempotency_uq'],
          [Job, 'forecast_training_job_key_uq']
        ];
        for (const [model, name] of required) {
          let indexes;
          try { indexes = await model.collection.indexes(); }
          catch (error) {
            if (error.code === 26 || error.codeName === 'NamespaceNotFound') {
              throw Object.assign(new Error('ML_INDEXES_NOT_READY'), { code: 'ML_INDEXES_NOT_READY' });
            }
            throw error;
          }
          const expected = model.schema.indexes().find(([, spec]) => spec.name === name);
          const actual = indexes.find(index => index.name === name);
          if (!actual?.unique || JSON.stringify(actual.key) !== JSON.stringify(expected[0])
              || JSON.stringify(actual.partialFilterExpression) !== JSON.stringify(expected[1].partialFilterExpression)) {
            throw Object.assign(new Error('ML_INDEXES_NOT_READY'), { code: 'ML_INDEXES_NOT_READY' });
          }
        }
      }
    });
    const report = await bootstrap.run(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status === 'PARTIAL' || report.status === 'FAILED') process.exitCode = 1;
    return report;
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main().catch(error => {
  // Never echo Mongo errors, argv, URI, credentials, dataset or child stderr.
  const allowed = new Set(['INVALID_CLOUD_ARGUMENTS', 'CLOUD_CONFIRMATION_REQUIRED', 'TENANT_MISMATCH',
    'SCENARIO_MISMATCH', 'EXPECTED_DATABASE_REQUIRED', 'PROMOTION_POLICY_MISMATCH', 'FEATURE_HASH_MISMATCH',
    'BOOTSTRAP_EVIDENCE_HASH_MISMATCH', 'BOOTSTRAP_EVIDENCE_INVALID', 'INVALID_DATA_VERSION',
    'INVALID_CLOSED_THROUGH', 'DRY_RUN_PRECONDITIONS_REQUIRED', 'INVALID_CLOUD_TARGET',
    'CLOUD_ENVIRONMENT_MISMATCH', 'BOOTSTRAP_LINEAGE_INVALID', 'DATA_VERSION_MISMATCH',
    'CLOSED_THROUGH_CHANGED', 'REGISTRY_ALREADY_INITIALIZED', 'DATASET_NOT_FEASIBLE', 'ML_INDEXES_NOT_READY']);
  process.stderr.write(`${JSON.stringify({ status: 'ABORTED', code: allowed.has(error.code)
    ? error.code : 'CLOUD_BOOTSTRAP_FAILED' })}\n`);
  process.exitCode = 1;
});

module.exports = { main };
