'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const config = require('../src/config/v3Operational');
const update = require('../src/services/forecastMlUpdateCoordinator');
const { parseMode, validateEnvironment, describePending, createCloudWorker } = require('../src/services/forecastCloudWorker');
const { main, assertIndexes, checkPython, productionDependencies, PYTHON_PREFLIGHT } = require('../scripts/run-v3-ridge-worker-cloud');

const NOW = new Date('2026-10-17T17:00:00Z');
const SECRET = 'private-password-never-print';
const environment = () => ({
  FORECAST_CLOUD_MONGO_URI: `mongodb+srv://fixture:${SECRET}@cluster.example.mongodb.net/worker_test?retryWrites=true&w=majority`,
  FORECAST_CLOUD_EXPECTED_DATABASE: 'worker_test',
  FORECAST_CLOUD_EXPECTED_BUSINESS_ID: config.businessId,
  FORECAST_CLOUD_EXPECTED_SCENARIO_ID: config.scenarioId,
  FORECAST_TRAINING_PYTHON: 'configured-python',
  FORECAST_WORKER_INVOCATION_KEY: 'offline-invocation',
});
function state(horizonDays = 7) {
  return { businessId: config.businessId, scenarioId: config.scenarioId, horizonDays,
    status: 'PENDING', latestDataVersion: 84n, lastProcessedDataVersion: 83n,
    initialMatureOrigin: update.matureOrigin('2026-10-15', horizonDays),
    latestMatureOrigin: update.matureOrigin('2026-10-15', horizonDays),
    lastTrainedMatureOrigin: update.matureOrigin('2026-10-15', horizonDays),
    observationsClosedThrough: '2026-10-15', lastDirtyAt: new Date('2026-10-17T15:00:00Z'),
    nextEligibleAt: new Date('2026-10-17T15:15:00Z'), lastAttemptAt: null,
    historicalCorrectionVersion: null, fencingToken: 0 };
}
function fixture({ outcome = 'PROMOTED', rows = [state(7), state(14)], error = null } = {}) {
  const calls = [], active = new Map([[7, 1], [14, 1]]);
  const states = new Map(rows.map(row => [row.horizonDays, row]));
  const preflight = { dataVersion: '84', activeModels: [7, 14].map(horizonDays =>
    ({ horizonDays, modelVersion: 1, trainedDataVersion: '83' })),
  promotionReadiness: Object.fromEntries([7, 14].map(h => [h, {
    status: 'NO_PROMOTION_INSUFFICIENT_HISTORY', availableOrigins: 0, requiredOrigins: 107 }])) };
  const deps = {
    update, clock: () => new Date(NOW),
    preflight: async () => { calls.push('preflight'); return preflight; },
    readState: async h => { calls.push(`read:${h}`); return states.get(h) || null; },
    runEligible: async input => {
      calls.push({ runEligible: input });
      if (error) throw error;
      if (outcome === 'PROMOTED') active.set(input.horizonDays, 2);
      return { status: outcome, modelVersion: outcome === 'NO_PROMOTION_INSUFFICIENT_HISTORY' ? null : 2,
        privateExtra: SECRET };
    },
    close: async () => calls.push('close'),
  };
  return { deps, active, states, calls, preflight, run: mode => createCloudWorker(deps).run(mode) };
}

test('cloud configuration is explicit, bound to scope and never falls back to a local URI', () => {
  assert.equal(validateEnvironment(environment()).database, 'worker_test');
  for (const name of Object.keys(environment()).filter(key => key !== 'FORECAST_WORKER_INVOCATION_KEY')) {
    const env = environment(); delete env[name]; env.MONGODB_URI = 'mongodb://localhost/local';
    assert.throws(() => validateEnvironment(env), { code: 'CLOUD_ENV_REQUIRED' });
  }
  for (const uri of ['mongodb://localhost/worker_test', 'mongodb+srv://u:p@cluster.mongodb.net/other',
    'mongodb+srv://u:p@cluster.mongodb.net/worker_test?tls=false',
    'mongodb+srv://u:p@cluster.mongodb.net/worker_test?tlsInsecure=true']) {
    assert.throws(() => validateEnvironment({ ...environment(), FORECAST_CLOUD_MONGO_URI: uri }), { code: 'INVALID_CLOUD_TARGET' });
  }
  for (const name of ['FORECAST_CLOUD_EXPECTED_BUSINESS_ID', 'FORECAST_CLOUD_EXPECTED_SCENARIO_ID']) {
    assert.throws(() => validateEnvironment({ ...environment(), [name]: 'other' }), { code: 'CLOUD_SCOPE_MISMATCH' });
  }
});

test('only check/status/run are accepted, without 1d, dates, force or bootstrap switches', () => {
  for (const mode of ['check', 'status', 'run']) assert.equal(parseMode([`--${mode}`]), mode.toUpperCase());
  for (const argv of [[], ['--bootstrap'], ['--run', '1'], ['--run', '--force'], ['--run', '--as-of', '2030-01-01']]) {
    assert.throws(() => parseMode(argv), { code: 'INVALID_CLOUD_ARGUMENTS' });
  }
});

test('--check only preflights, --status projects readiness without refreshing or writing state', async () => {
  const harness = fixture(), before = structuredClone([...harness.states]);
  const check = await harness.run('CHECK');
  assert.equal(check.writesPerformed, 0);
  assert.deepEqual(harness.calls, ['preflight']);
  const status = await harness.run('STATUS');
  assert.equal(status.writesPerformed, 0);
  assert.equal(status.horizons[0].eligibility, 'ELIGIBLE');
  assert.equal(status.horizons[0].promotionReadiness.status, 'NO_PROMOTION_INSUFFICIENT_HISTORY');
  assert.deepEqual([...harness.states], before);
  assert.equal(harness.calls.some(value => typeof value === 'object'), false);
});

test('absent or settled state returns NO_PENDING_WORK without calling the worker', async () => {
  for (const rows of [[], [Object.assign(state(), { status: 'IDLE', lastProcessedDataVersion: 84n,
    lastTrainedMatureOrigin: update.matureOrigin(update.watermark(NOW), 7) })]]) {
    const harness = fixture({ rows }), result = await harness.run('RUN');
    assert.equal(result.writesPerformed, 0);
    assert.ok(result.horizons.every(row => row.result === 'NO_PENDING_WORK'));
    assert.deepEqual([...harness.active.values()], [1, 1]);
  }
});

for (const [reason, change] of [
  ['DEBOUNCE_NOT_ELAPSED', row => { row.nextEligibleAt = new Date(+NOW + 60000); }],
  ['NOT_MATURE', row => { row.latestMatureOrigin = row.initialMatureOrigin = row.lastTrainedMatureOrigin = update.matureOrigin(update.watermark(NOW), 7); }],
  ['COOLDOWN_ACTIVE', row => { row.lastAttemptAt = new Date(+NOW - 60000); }],
]) test(`${reason} is reported with no worker call or writes`, async () => {
  const row = state(); change(row);
  const harness = fixture({ rows: [row] }), result = await harness.run('RUN');
  assert.equal(result.horizons[0].result, reason);
  assert.equal(result.writesPerformed, 0);
  assert.equal(result.writesMayHaveOccurred, false);
});

test('historical corrections bypass cooldown, but still respect debounce', () => {
  const row = { ...state(), historicalCorrectionVersion: 84n, lastAttemptAt: new Date(+NOW - 60000) };
  assert.equal(describePending(row, 7, update, NOW).eligibility, 'ELIGIBLE');
  row.nextEligibleAt = new Date(+NOW + 60000);
  assert.equal(describePending(row, 7, update, NOW).eligibility, 'DEBOUNCE_NOT_ELAPSED');
});

test('non-retryable failure remains blocked for the same revision/origin', () => {
  const row = { ...state(), lastFailureRetryable: false, lastFailedDataVersion: 84n,
    lastFailedMatureOrigin: update.matureOrigin(update.watermark(NOW), 7) };
  assert.equal(describePending(row, 7, update, NOW).eligibility, 'PREVIOUS_FAILURE_NOT_RETRYABLE');
});

test('at most one runEligible per 7/14 horizon, always through the existing worker contract', async () => {
  const harness = fixture(), result = await harness.run('RUN');
  const runs = harness.calls.filter(value => typeof value === 'object');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(value => value.runEligible.horizonDays), [7, 14]);
  for (const { runEligible: input } of runs) {
    assert.equal(input.businessId, config.businessId);
    assert.equal(input.scenarioId, config.scenarioId);
    assert.match(input.leaseOwner, /^cloud-[a-f0-9-]+$/);
    assert.equal('force' in input, false);
  }
  assert.ok(result.horizons.every(row => row.result === 'CANDIDATE_PROMOTED'));
  assert.deepEqual([...harness.active.values()], [2, 2]);
  assert.equal(result.writesPerformed, null); // No fabricated internal write count.
  assert.equal(result.writesMayHaveOccurred, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});

test('insufficient history is a successful evaluation outcome without candidate/promotion', async () => {
  const harness = fixture({ outcome: 'NO_PROMOTION_INSUFFICIENT_HISTORY' });
  const result = await harness.run('RUN');
  assert.equal(result.status, 'OK');
  assert.ok(result.horizons.every(row => row.result === 'NO_PROMOTION_INSUFFICIENT_HISTORY' && row.candidateModelVersion === null));
  assert.deepEqual([...harness.active.values()], [1, 1]);
});

test('rejection delegates to the worker and leaves the simulated ACTIVE pointer unchanged', async () => {
  const harness = fixture({ outcome: 'REJECTED' }), result = await harness.run('RUN');
  assert.ok(result.horizons.every(row => row.result === 'CANDIDATE_REJECTED'));
  assert.deepEqual([...harness.active.values()], [1, 1]);
});

test('worker failure is sanitized and the entrypoint never replaces ACTIVE', async () => {
  const harness = fixture({ error: Object.assign(new Error(`mongodb+srv://${SECRET}/customerData`), { code: SECRET }) });
  const result = await harness.run('RUN');
  assert.equal(result.status, 'FAILED');
  assert.ok(result.horizons.every(row => row.code === 'WORKER_FAILED'));
  assert.deepEqual([...harness.active.values()], [1, 1]);
  assert.doesNotMatch(JSON.stringify(result), /mongodb|private-password|customerData/);
});

test('active lease blocks a second caller; expired lease is recoverable without a second lock', async () => {
  const row = { ...state(), status: 'CLAIMED', leaseUntil: new Date(+NOW + 10000), lastAttemptAt: NOW };
  assert.equal(describePending(row, 7, update, NOW).eligibility, 'LEASE_ACTIVE');
  row.leaseUntil = new Date(+NOW - 1);
  const expired = describePending(row, 7, update, NOW);
  assert.equal(expired.eligibility, 'ELIGIBLE');
  assert.equal(expired.expiredLease, true);
  const harness = fixture({ rows: [state()] });
  let executions = 0, claimed = false;
  harness.deps.runEligible = async () => {
    if (claimed) return null; // Simulated coordinator CAS, not an entrypoint lock.
    claimed = true; executions++;
    harness.states.get(7).status = 'CLAIMED';
    harness.states.get(7).leaseUntil = new Date(+NOW + 10000);
    await new Promise(resolve => setImmediate(resolve));
    return { status: 'REJECTED', modelVersion: 2 };
  };
  const reports = await Promise.all([harness.run('RUN'), harness.run('RUN')]);
  assert.equal(executions, 1);
  assert.equal(reports.flatMap(report => report.horizons).filter(row => row.result === 'CANDIDATE_REJECTED').length, 1);
});

test('index preflight inspects existing collections and refuses missing/mismatched indexes without creating them', async () => {
  let reads = 0;
  const model = { collection: { indexes: async () => { reads++; return [{ name: '_id_', key: { _id: 1 } },
    { name: 'scope', key: { businessId: 1 }, unique: true }]; } },
  schema: { indexes: () => [[{ businessId: 1 }, { name: 'scope', unique: true }]] },
  init: () => assert.fail('must not initialize') };
  await assertIndexes([model]); assert.equal(reads, 1);
  model.collection.indexes = async () => [{ name: '_id_', key: { _id: 1 } }];
  await assert.rejects(assertIndexes([model]), { code: 'ML_INDEXES_NOT_READY' });
  model.collection.indexes = async () => { throw { code: 26 }; };
  await assert.rejects(assertIndexes([model]), { code: 'ML_COLLECTIONS_NOT_READY' });
});

function fakePython(result, observe) {
  return (executable, args, options) => {
    observe(executable, args, options);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on('finish', () => { child.stdout.write(JSON.stringify(result)); child.emit('close', 0); });
    return child;
  };
}
test('Python preflight uses the configured executable, actual Ridge modules/loader and repository root', async () => {
  const result = { ok: true, pythonVersion: '3.12.10', promotionReadiness: fixture().preflight.promotionReadiness };
  const actual = await checkPython('specific-venv-python', {}, fakePython(result, (executable, args, options) => {
    assert.equal(executable, 'specific-venv-python');
    assert.equal(options.cwd, path.resolve(__dirname, '../..'));
    assert.equal(options.windowsHide, true);
    assert.equal(args[0], '-c');
    assert.match(args[1], /v3_ridge_training, v3_live_ridge, v3_ridge_policy/);
    assert.match(args[1], /load_verified_ridge_artifact/);
    assert.doesNotMatch(args[1], /\.fit\(/);
  }));
  assert.equal(actual.ok, true);
  await assert.rejects(checkPython('specific-venv-python', {}, fakePython({ ok: false, code: SECRET }, () => {})),
    { code: 'PYTHON_PREFLIGHT_FAILED' });
});

test('main closes dependencies and --status remains read-only after the complete orchestration', async () => {
  const harness = fixture();
  const result = await main(['--status'], environment(), settings => {
    assert.equal(settings.python, 'configured-python'); return harness.deps;
  });
  assert.equal(result.status, 'OK'); assert.equal(result.writesPerformed, 0);
  assert.equal(harness.calls.at(-1), 'close');
});

test('missing configuration aborts before constructing any cloud dependency; CLI emits only sanitized JSON', async () => {
  const result = await main(['--run'], { MONGODB_URI: `mongodb://${SECRET}/local` }, () => assert.fail('must not connect'));
  assert.equal(result.code, 'CLOUD_ENV_REQUIRED');
  const env = { ...process.env, MONGODB_URI: SECRET };
  for (const key of Object.keys(environment())) delete env[key];
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/run-v3-ridge-worker-cloud.js'), '--check'],
    { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).code, 'CLOUD_ENV_REQUIRED');
  assert.equal(child.stderr, '');
  assert.doesNotMatch(child.stdout, new RegExp(SECRET));
});

test('preflight failure aborts before any pending read/claim and never echoes private diagnostics', async () => {
  const harness = fixture();
  harness.deps.preflight = async () => { throw Object.assign(new Error(SECRET), { code: 'ACTIVE_MODEL_REQUIRED' }); };
  const result = await main(['--run'], environment(), () => harness.deps);
  assert.equal(result.code, 'ACTIVE_MODEL_REQUIRED');
  assert.equal(result.writesPerformed, 0);
  assert.deepEqual(harness.calls, ['close']);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});

function productionFixture() {
  const realModels = require('../src/models');
  const calls = [], settings = validateEnvironment(environment());
  const control = { database: settings.database, primary: true, activeMissing: false,
    executionIndexMissing: false,
    revision: { _id: config.businessId, revision: 84n, bootstrapStatus: 'VERIFIED',
      historicalDatasetVersion: config.datasetVersion, historicalDatasetSha256: config.sourceSha256 } };
  const query = value => ({ setOptions() { return this; }, lean() { return this; },
    maxTimeMS: async () => value });
  const modelNames = ['V3OperationalRevision', 'V3OperationalChange', 'ForecastMlUpdateEvent',
    'ForecastMlUpdateState', 'ForecastTrainingJob', 'ForecastModelRegistry', 'ForecastModelArtifact', 'ForecastMlUpdateExecution'];
  const models = Object.fromEntries(modelNames.map(name => [name, {
    schema: realModels[name].schema,
    collection: { indexes: async () => { calls.push(`indexes:${name}`);
      const declared = realModels[name].schema.indexes().map(([key, spec]) => ({ key, ...spec }));
      return [{ name: '_id_', key: { _id: 1 } }, ...(name === 'ForecastMlUpdateExecution' && control.executionIndexMissing
        ? declared.slice(0, -1) : declared)]; } },
    init: () => assert.fail('implicit init is forbidden'),
    create: () => assert.fail('preflight must not create'),
    updateOne: () => assert.fail('preflight must not update'),
  }]));
  models.V3OperationalRevision.findById = businessId => {
    assert.equal(businessId, config.businessId); return query(control.revision);
  };
  models.ForecastMlUpdateState.findOne = filter => {
    assert.equal(filter.businessId, config.businessId); assert.equal(filter.scenarioId, config.scenarioId);
    return query(state(filter.horizonDays));
  };
  const mongoose = {
    set: (key, value) => { calls.push({ option: key, value }); },
    connect: async (_uri, options) => { calls.push({ connectionOptions: options }); },
    disconnect: async () => calls.push('disconnect'),
    connection: { db: { get databaseName() { return control.database; },
      collection: () => ({ findOne: async () => null }),
      admin: () => ({ command: async command => {
        assert.deepEqual(command, { hello: 1 }); return { setName: 'atlas-fixture', isWritablePrimary: control.primary };
      } }) } },
  };
  const overrides = { models, mongoose, update,
    executionHistory: { begin: async () => ({ duplicate: false }), preflight: async () => {},
      horizon: async () => {}, finish: async () => {}, fail: async () => {} },
    registry: { getActiveModelArtifact: async scope => {
      calls.push({ activeRead: scope });
      if (control.activeMissing) return null;
      return { metadata: { ...scope, modelVersion: 1, trainedDataVersion: '83', status: 'ACTIVE' },
        artifactData: Buffer.from('offline-fixture') };
    } },
    checkPython: async (executable, payload) => {
      assert.equal(executable, settings.python); assert.equal(payload.models.length, 2);
      assert.deepEqual(payload.models.map(row => row.metadata.horizonDays), [7, 14]);
      calls.push('python'); return { promotionReadiness: fixture().preflight.promotionReadiness };
    },
    workerImplementation: {
      createForecastRidgeTrainingWorker: options => {
        calls.push('createWorker');
        return { runEligible: async input => {
          calls.push({ workerInput: input });
          await options.runTraining({ marker: 'offline-only' });
          return { status: 'NO_PROMOTION_INSUFFICIENT_HISTORY', modelVersion: null };
        } };
      },
      runPython: async (_request, options) => {
        assert.deepEqual(options, { executable: settings.python, timeoutMs: 120000 });
        calls.push('training-adapter-stub');
      },
    },
  };
  return { settings, overrides, calls, control };
}

test('actual preflight adapter disables implicit writes, validates every collection, scope and ACTIVE before processing', async () => {
  for (const mode of ['CHECK', 'STATUS']) {
    const harness = productionFixture();
    const deps = productionDependencies(harness.settings, harness.overrides);
    const result = await createCloudWorker({ ...deps, clock: () => new Date(NOW) }).run(mode);
    assert.equal(result.writesPerformed, 0);
    assert.equal(harness.calls.filter(value => typeof value === 'string' && value.startsWith('indexes:')).length, 8);
    assert.deepEqual(harness.calls.slice(0, 2), [{ option: 'autoCreate', value: false }, { option: 'autoIndex', value: false }]);
    const connection = harness.calls.find(value => value.connectionOptions)?.connectionOptions;
    assert.equal(connection.dbName, 'worker_test'); assert.equal(connection.autoCreate, false); assert.equal(connection.autoIndex, false);
    assert.equal(harness.calls.includes('createWorker'), false);
    assert.equal(harness.calls.includes('training-adapter-stub'), false);
    await deps.close();
  }
});

test('actual adapter lazily calls the existing runEligible with the explicitly configured Python and bounded timeout', async () => {
  const harness = productionFixture();
  const deps = productionDependencies(harness.settings, harness.overrides);
  const result = await createCloudWorker({ ...deps, clock: () => new Date(NOW) }).run('RUN');
  assert.equal(harness.calls.filter(value => value === 'createWorker').length, 1);
  assert.deepEqual(harness.calls.filter(value => value.workerInput).map(value => value.workerInput.horizonDays), [7, 14]);
  assert.ok(result.horizons.every(row => row.result === 'NO_PROMOTION_INSUFFICIENT_HISTORY'));
  await deps.close();
});

test('database, primary, revision lineage and existing ACTIVE are mandatory preflight gates', async () => {
  for (const [field, value, code] of [
    ['database', 'wrong_database', 'CLOUD_DATABASE_MISMATCH'],
    ['primary', false, 'CLOUD_REPLICA_SET_REQUIRED'],
    ['revision', null, 'BOOTSTRAP_LINEAGE_INVALID'],
    ['activeMissing', true, 'ACTIVE_MODEL_REQUIRED'],
  ]) {
    const harness = productionFixture(); harness.control[field] = value;
    const deps = productionDependencies(harness.settings, harness.overrides);
    await assert.rejects(deps.preflight(), { code });
    assert.equal(harness.calls.includes('createWorker'), false);
    await deps.close();
  }
});

test('missing execution-history index fails preflight before Python or worker construction', async () => {
  const harness = productionFixture(); harness.control.executionIndexMissing = true;
  const deps = productionDependencies(harness.settings, harness.overrides);
  await assert.rejects(deps.preflight(), { code: 'ML_HISTORY_INDEX_MISSING' });
  assert.equal(harness.calls.includes('python'), false);
  assert.equal(harness.calls.includes('createWorker'), false);
  await deps.close();
});

test('offline Python preflight imports the real trainer and verifies synthetic JSON artifacts without fit',
  { skip: !process.env.FORECAST_WORKER_TEST_PYTHON }, () => {
    const driver = `
import sys, io, json, hashlib, base64
sys.path.insert(0, '.venv/Lib/site-packages')
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from ml.service import v3_live_ridge as l
program = sys.stdin.read()
models = []
for h in (7, 14):
    a = dict(schemaVersion=l.ARTIFACT_SCHEMA_VERSION, businessId='MINIMARKET-PASCO-V3',
        scenarioId='minimarket-pasco-v3', horizonDays=h, modelFamily=l.MODEL_FAMILY, recipeId=l.RECIPE_ID,
        featureVersion=l.FEATURE_VERSION, featureHash=l.FEATURE_HASH, modelVersion=1,
        categoricalFeatures=list(l.CATEGORICAL_FEATURES), numericFeatures=list(l.NUMERIC_FEATURES),
        categories={k:['fixture'] for k in l.CATEGORICAL_FEATURES}, scalerMean=[0.0]*21,
        scalerScale=[1.0]*21, coefficients=[0.0]*27, intercept=0.0, alpha=10.0, solver='lsqr', tol=0.0001)
    raw = json.dumps(a).encode()
    m = {k:a[k] for k in ('businessId','scenarioId','horizonDays','modelFamily','recipeId','featureVersion','featureHash','modelVersion')}
    m.update(status='ACTIVE', promotionPolicyVersion=l.PROMOTION_POLICY_VERSION,
        promotionPolicyHash=l.PROMOTION_POLICY_HASH, artifactBytes=len(raw), artifactHash=hashlib.sha256(raw).hexdigest())
    models.append(dict(metadata=m, artifactBase64=base64.b64encode(raw).decode()))
payload = dict(businessId='MINIMARKET-PASCO-V3', scenarioId='minimarket-pasco-v3',
    closedThrough=(datetime.now(ZoneInfo('America/Lima')).date()-timedelta(days=1)).isoformat(), models=models)
sys.stdin = io.StringIO(json.dumps(payload))
exec(compile(program, 'offline_preflight', 'exec'))
`;
    const child = spawnSync(process.env.FORECAST_WORKER_TEST_PYTHON, ['-B', '-c', driver],
      { cwd: path.resolve(__dirname, '../..'), input: PYTHON_PREFLIGHT, encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(child.status, 0, 'offline Python preflight failed');
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.promotionReadiness['7'].requiredOrigins, 107);
    assert.equal(result.promotionReadiness['14'].requiredOrigins, 107);
  });
