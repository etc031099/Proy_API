'use strict';

// Dedicated cloud worker. No dotenv, bootstrap, implicit URI or date override.
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('../src/config/v3Operational');
const { parseMode, validateEnvironment, createCloudWorker, safeCode, fail,
  TRAINING_TIMEOUT_MS, CYCLE_TIMEOUT_MS } = require('../src/services/forecastCloudWorker');
const ROOT = path.resolve(__dirname, '../..');

const PYTHON_PREFLIGHT = `
import base64, json, sys
from datetime import date
try:
    from ml.service import v3_ridge_training, v3_live_ridge, v3_ridge_policy
    v3_ridge_policy.load_policy()
    payload = json.load(sys.stdin)
    readiness = {}
    for item in payload['models']:
        h = item['metadata']['horizonDays']
        v3_live_ridge.load_verified_ridge_artifact(
            {'metadata': item['metadata'], 'artifactData': base64.b64decode(item['artifactBase64'], validate=True)},
            business_id=payload['businessId'], scenario_id=payload['scenarioId'], horizon_days=h)
        protocol = v3_ridge_policy.temporal_protocol(date.fromisoformat(payload['closedThrough']), h)
        readiness[str(h)] = {'status': 'READY' if protocol['status'] == 'READY' else 'NO_PROMOTION_INSUFFICIENT_HISTORY',
                            'availableOrigins': protocol['availableOrigins'], 'requiredOrigins': protocol['requiredOrigins']}
    print(json.dumps({'ok': True, 'pythonVersion': sys.version.split()[0], 'promotionReadiness': readiness}))
except ImportError:
    print(json.dumps({'ok': False, 'code': 'PYTHON_IMPORT_FAILED'}))
except Exception as error:
    code = getattr(error, 'code', None)
    print(json.dumps({'ok': False, 'code': code if code in ('ARTIFACT_INVALID', 'POLICY_COMPUTATION_FAILED') else 'PYTHON_PREFLIGHT_FAILED'}))
`;

function checkPython(executable, payload, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, ['-c', PYTHON_PREFLIGHT],
      { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', oversized = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    child.stdin.on('error', () => {});
    child.stderr.resume(); // Never print traceback, paths, credentials or artifacts.
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 32768) { oversized = true; child.kill(); }
    });
    child.on('error', () => {
      clearTimeout(timer); reject(Object.assign(new Error(), { code: 'PYTHON_UNAVAILABLE' }));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut || oversized || code !== 0) return reject(Object.assign(new Error(),
        { code: timedOut ? 'PYTHON_PREFLIGHT_TIMEOUT' : 'PYTHON_PREFLIGHT_FAILED' }));
      try {
        const result = JSON.parse(output);
        if (result.ok !== true) return reject(Object.assign(new Error(),
          { code: safeCode(result) === 'WORKER_FAILED' ? 'PYTHON_PREFLIGHT_FAILED' : safeCode(result) }));
        if (!/^\d+\.\d+\.\d+$/.test(result.pythonVersion)
            || [7, 14].some(h => !['READY', 'NO_PROMOTION_INSUFFICIENT_HISTORY'].includes(result.promotionReadiness?.[h]?.status)
              || !Number.isSafeInteger(result.promotionReadiness[h].availableOrigins)
              || result.promotionReadiness[h].availableOrigins < 0 || result.promotionReadiness[h].requiredOrigins !== 107)) {
          throw new Error();
        }
        resolve(result);
      } catch { reject(Object.assign(new Error(), { code: 'PYTHON_PREFLIGHT_FAILED' })); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function assertIndexes(models) {
  for (const model of models) {
    let indexes;
    try { indexes = await model.collection.indexes(); }
    catch (error) {
      if (error.code === 26 || error.codeName === 'NamespaceNotFound') fail('ML_COLLECTIONS_NOT_READY');
      throw error;
    }
    if (!indexes.some(row => row.name === '_id_')) fail('ML_INDEXES_NOT_READY');
    for (const [keys, spec] of model.schema.indexes()) {
      const actual = indexes.find(row => row.name === spec.name);
      if (!actual || JSON.stringify(actual.key) !== JSON.stringify(keys)
          || Boolean(actual.unique) !== Boolean(spec.unique)
          || JSON.stringify(actual.partialFilterExpression) !== JSON.stringify(spec.partialFilterExpression)) {
        fail('ML_INDEXES_NOT_READY');
      }
    }
  }
}

function productionDependencies(settings, overrides = {}) {
  const mongoose = overrides.mongoose || require('mongoose');
  // Set these BEFORE importing any model, including imports by the coordinator.
  mongoose.set('autoCreate', false);
  mongoose.set('autoIndex', false);
  const models = overrides.models || require('../src/models');
  const update = overrides.update || require('../src/services/forecastMlUpdateCoordinator');
  const registry = overrides.registry || require('../src/services/forecastModelRegistryService').createForecastModelRegistryService();
  const pythonCheck = overrides.checkPython || checkPython;
  let worker;
  const connect = async () => {
    if (mongoose.connection.readyState === 1) return;
    await mongoose.connect(settings.uri, { dbName: settings.database, autoCreate: false, autoIndex: false,
      serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 15000,
      maxPoolSize: 3, readPreference: 'primary' });
  };
  const readState = horizonDays => models.ForecastMlUpdateState.findOne({ businessId: settings.businessId,
    scenarioId: settings.scenarioId, horizonDays }).setOptions({ useBigInt64: true }).lean().maxTimeMS(5000);
  const historyService = require('../src/services/forecastMlUpdateExecutionService').createForecastMlUpdateExecutionService({
    repository: require('../src/services/forecastMlUpdateExecutionService').productionRepository(models.ForecastMlUpdateExecution) });
  const executionHistory = overrides.executionHistory || require('../src/services/forecastExecutionHistory').createExecutionHistory({
    service: historyService, scope: { businessId: settings.businessId, scenarioId: settings.scenarioId },
    identity: settings.executionIdentity, readState, registry, update,
    prepare: async () => {
      await connect();
      if (mongoose.connection.db.databaseName !== settings.database) fail('CLOUD_DATABASE_MISMATCH');
      const hello = await mongoose.connection.db.admin().command({ hello: 1 });
      if (!hello.setName || !hello.isWritablePrimary) fail('CLOUD_REPLICA_SET_REQUIRED');
      await require('../src/services/forecastExecutionIndexes').verifyExecutionIndexes(models.ForecastMlUpdateExecution);
    } });
  const preflight = async () => {
    try {
      await connect();
    } catch { fail('CLOUD_CONNECTION_FAILED'); }
    if (mongoose.connection.db.databaseName !== settings.database) fail('CLOUD_DATABASE_MISMATCH');
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName || !hello.isWritablePrimary) fail('CLOUD_REPLICA_SET_REQUIRED');
    await assertIndexes([models.V3OperationalRevision, models.V3OperationalChange, models.ForecastMlUpdateEvent,
      models.ForecastMlUpdateState, models.ForecastTrainingJob, models.ForecastModelRegistry, models.ForecastModelArtifact,
      models.ForecastMlUpdateExecution]);
    const revision = await models.V3OperationalRevision.findById(settings.businessId)
      .setOptions({ useBigInt64: true }).lean().maxTimeMS(5000);
    if (!revision || revision._id !== settings.businessId || revision.bootstrapStatus !== 'VERIFIED'
        || revision.historicalDatasetVersion !== config.datasetVersion
        || revision.historicalDatasetSha256 !== config.sourceSha256) fail('BOOTSTRAP_LINEAGE_INVALID');
    const activeModels = [], envelopes = [];
    for (const horizonDays of [7, 14]) {
      const active = await registry.getActiveModelArtifact({ businessId: settings.businessId,
        scenarioId: settings.scenarioId, horizonDays });
      if (!active) fail('ACTIVE_MODEL_REQUIRED');
      const metadata = active.metadata;
      if (!/^(0|[1-9]\d*)$/.test(metadata.trainedDataVersion)
          || BigInt(metadata.trainedDataVersion) > revision.revision) fail('ACTIVE_METADATA_INVALID');
      activeModels.push({ horizonDays, modelVersion: metadata.modelVersion, trainedDataVersion: metadata.trainedDataVersion });
      const fields = ['businessId', 'scenarioId', 'horizonDays', 'status', 'modelFamily', 'recipeId',
        'featureVersion', 'featureHash', 'promotionPolicyVersion', 'promotionPolicyHash',
        'artifactBytes', 'artifactHash', 'modelVersion'];
      envelopes.push({ metadata: Object.fromEntries(fields.map(key => [key, metadata[key]])),
        artifactBase64: active.artifactData.toString('base64') });
    }
    const python = await pythonCheck(settings.python, { businessId: settings.businessId, scenarioId: settings.scenarioId,
      closedThrough: update.watermark(new Date()), models: envelopes });
    return { dataVersion: String(revision.revision), activeModels, promotionReadiness: python.promotionReadiness };
  };
  return {
    update, preflight, executionHistory,
    completeManualEvaluation: input => update.completeManualEvaluation({ ...input,
      businessId: settings.businessId, scenarioId: settings.scenarioId }),
    readState,
    runEligible: input => {
      if (!worker) {
        const implementation = overrides.workerImplementation || require('../src/services/forecastRidgeTrainingWorker');
        worker = implementation.createForecastRidgeTrainingWorker({ registry, executionHistory: historyService,
          runTraining: request => implementation.runPython(request, { executable: settings.python, timeoutMs: TRAINING_TIMEOUT_MS }),
          log: () => {} });
      }
      return worker.runEligible(input);
    },
    close: () => mongoose.disconnect(),
  };
}

async function main(argv = process.argv.slice(2), env = process.env, createDependencies = productionDependencies) {
  let dependencies, mode, report, watchdog, writesMayHaveOccurred = false;
  const signalHandlers = [];
  try {
    mode = parseMode(argv);
    const settings = { ...validateEnvironment(env), ...(mode === 'RUN' ? {
      executionIdentity: require('../src/services/forecastExecutionHistory').executionIdentityFromEnv(env) } : {}) };
    // Final process bound. Python itself is limited to 120s/job; on a hard
    // process stop the durable claim expires and is recovered using fencing.
    watchdog = setTimeout(async () => {
      const forcedExit = setTimeout(() => process.exit(1), 2000);
      try { await dependencies?.executionHistory?.interrupt(); } catch { /* Hard kill recovery is explicit on a later attempt. */ }
      process.stdout.write(`${JSON.stringify({ status: 'FAILED', mode, code: 'WORKER_CYCLE_TIMEOUT',
        writesPerformed: mode === 'RUN' ? null : 0, writesMayHaveOccurred: mode === 'RUN' })}\n`);
      clearTimeout(forcedExit);
      process.exit(1);
    }, CYCLE_TIMEOUT_MS);
    dependencies = createDependencies(settings);
    if (mode === 'RUN' && dependencies.executionHistory) {
      for (const signal of ['SIGTERM', 'SIGINT']) {
        const handler = async () => {
          const deadline = setTimeout(() => process.exit(1), 2000);
          try { await dependencies.executionHistory.interrupt(); } catch { /* Later attempt recovery remains explicit. */ }
          clearTimeout(deadline); process.exit(1);
        };
        process.once(signal, handler); signalHandlers.push([signal, handler]);
      }
    }
    if (mode === 'RUN' && dependencies.executionHistory) writesMayHaveOccurred = true;
    report = await createCloudWorker({ ...dependencies,
      completeManualEvaluation: async input => {
        writesMayHaveOccurred = true;
        return dependencies.completeManualEvaluation(input);
      }, runEligible: input => {
      writesMayHaveOccurred = true;
      return dependencies.runEligible(input);
    } }).run(mode);
  } catch (error) {
    report = { status: 'FAILED', mode: mode || null, code: safeCode(error),
      writesPerformed: writesMayHaveOccurred ? null : 0, writesMayHaveOccurred };
  } finally {
    if (dependencies) {
      try { await dependencies.close(); }
      catch { report.status = 'FAILED'; report.code = 'CLOUD_CONNECTION_FAILED'; }
    }
    clearTimeout(watchdog);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
  return report;
}

if (require.main === module) {
  // The coordinator's existing informational logs are safe, but the CLI emits
  // just one summary JSON. No dependency exception text is printed.
  console.info = () => {};
  main().then(report => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === 'FAILED' ? 1 : 0;
  }).catch(() => {
    process.stdout.write('{"status":"FAILED","code":"WORKER_FAILED"}\n'); process.exitCode = 1;
  });
}

module.exports = { main, productionDependencies, assertIndexes, checkPython, PYTHON_PREFLIGHT };
