'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { formatReport } = require('../scripts/forecast-ridge-actions-summary');
const root = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/forecast-ridge-auto-update.yml'), 'utf8');

test('workflow preserves schedule, manual check/run, concurrency and existing CLI', () => {
  assert.match(workflow, /cron: '17 \*\/6 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /manualRequestKey:/);
  assert.match(workflow, /FORECAST_MANUAL_REQUEST_KEY: \$\{\{ inputs.manualRequestKey \}\}/);
  assert.doesNotMatch(workflow, /run:.*inputs\.manualRequestKey/);
  assert.match(workflow, /default: check/);
  assert.match(workflow, /group: forecast-ridge-production-minimarket-pasco-v3/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /python-version: '3\.12'/);
  assert.match(workflow, /sys\.executable/);
  assert.ok(workflow.indexOf('--check >') < workflow.indexOf('--run >'));
  assert.match(workflow, /if: github\.event_name == 'schedule' \|\| inputs\.mode == 'run'/);
  assert.doesNotMatch(workflow, /continue-on-error|bootstrap|seed|--force|--horizon|--1d|--status/);
  assert.equal((workflow.match(/run-v3-ridge-worker-cloud\.js/g) || []).length, 2);
});

test('cloud secrets occur only as env values, never in shell commands', () => {
  const lines = workflow.split('\n');
  const names = ['FORECAST_CLOUD_MONGO_URI', 'FORECAST_CLOUD_EXPECTED_DATABASE',
    'FORECAST_CLOUD_EXPECTED_BUSINESS_ID', 'FORECAST_CLOUD_EXPECTED_SCENARIO_ID'];
  for (const name of names) {
    const occurrences = lines.filter(line => line.includes(`secrets.${name}`));
    assert.equal(occurrences.length, 2);
    for (const line of occurrences) assert.equal(line.trim(), `${name}: $` + `{{ secrets.${name} }}`);
  }
  assert.equal(lines.filter(line => line.includes('secrets.')).length, 8);
  assert.doesNotMatch(workflow, /secrets\.FORECAST_TRAINING_PYTHON/);
});

test('minimal Python worker requirements retain canonical pins', () => {
  const pins = file => fs.readFileSync(path.join(root, 'ml', file), 'utf8')
    .split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  const canonical = pins('requirements.txt');
  const worker = pins('requirements-forecast-worker.txt');
  assert.equal(worker.length, 6);
  for (const pin of worker) assert.ok(canonical.includes(pin), pin);
  for (const module of ['joblib', 'numpy', 'pandas', 'pydantic', 'scikit-learn', 'scipy']) {
    assert.ok(worker.some(pin => pin.startsWith(`${module}==`)));
  }
});

for (const result of ['NO_PENDING_WORK', 'DEBOUNCE_NOT_ELAPSED', 'NOT_MATURE',
  'COOLDOWN_ACTIVE', 'NO_PROMOTION_INSUFFICIENT_HISTORY', 'CANDIDATE_REJECTED',
  'CANDIDATE_PROMOTED', 'FAILED']) {
  test(`summary projects ${result} without private report fields`, () => {
    const text = formatReport({ status: result === 'FAILED' ? 'FAILED' : 'OK', mode: 'RUN',
      dataVersion: '83', closedThrough: '2026-10-16', private: 'SECRET',
      horizons: [7, 14].map(horizonDays => ({ horizonDays, pending: false, result,
        activeModelVersionAtPreflight: 1, activeTrainedDataVersionAtPreflight: '83',
        promotionReadiness: { availableOrigins: 0, requiredOrigins: 107 },
        error: 'SECRET', artifactData: 'SECRET' })) });
    assert.ok(text.includes(result));
    assert.match(text, /0\/107/);
    assert.match(text, /2026-10-16/);
    assert.doesNotMatch(text, /SECRET|artifactData/);
  });
}

test('malicious and missing fields cannot enter the summary', () => {
  const secret = 'mongodb+srv://user:password@private/secret';
  const text = formatReport({ status: 'OK', mode: secret, dataVersion: secret, closedThrough: secret,
    horizons: [{ horizonDays: 7, result: secret, pending: secret,
      promotionReadiness: { availableOrigins: secret, requiredOrigins: secret } }] });
  assert.doesNotMatch(text, /mongodb|password|private|secret/);
  assert.match(text, /NOT_REPORTED/);
  assert.match(formatReport(null), /ausente/);
});

test('summary CLI writes only a sanitized summary, including after invalid output', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ridge-summary-'));
  const files = ['forecast-ridge-check.json', 'forecast-ridge-run.json', 'summary.md'];
  t.after(() => {
    for (const file of files) fs.rmSync(path.join(temporary, file), { force: true });
    fs.rmdirSync(temporary);
  });
  fs.writeFileSync(path.join(temporary, files[0]), JSON.stringify({ status: 'OK', mode: 'CHECK',
    dataVersion: '83', closedThrough: '2026-10-16', secret: 'NEVER_EXPOSE' }));
  fs.writeFileSync(path.join(temporary, files[1]), 'INVALID_JSON_NEVER_EXPOSE');
  const child = spawnSync(process.execPath, [path.join(root, 'backend/scripts/forecast-ridge-actions-summary.js')], {
    env: { ...process.env, RUNNER_TEMP: temporary, GITHUB_STEP_SUMMARY: path.join(temporary, files[2]) },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
  const summary = fs.readFileSync(path.join(temporary, files[2]), 'utf8');
  assert.match(summary, /Ejecución UTC:/);
  assert.match(summary, /## CHECK/);
  assert.match(summary, /## RUN/);
  assert.match(summary, /ausente o inválido/);
  assert.doesNotMatch(summary, /NEVER_EXPOSE|INVALID_JSON/);
});
