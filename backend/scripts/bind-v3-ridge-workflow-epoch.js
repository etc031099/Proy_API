'use strict';
// READ ONLY. Bind a queued GitHub run to the durable tenant epoch BEFORE --check
// and --run start in separate processes. No dotenv, models/init, training/writes.
const { appendFileSync } = require('node:fs');
const { MongoClient } = require('mongoose').mongo;
const { validateEnvironment } = require('../src/services/forecastCloudWorker');
const { bindLaunch } = require('../src/services/mlTestWorkIdentity');
const F = require('../src/services/mlTestFence');
async function githubQueuedAt(env, fetchImpl = globalThis.fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '')
      || !/^[1-9]\d{0,24}$/.test(env.GITHUB_RUN_ID || '') || !env.GITHUB_TOKEN) F.fail('TEST_QUEUE_IDENTITY_REQUIRED');
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, {
      redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GITHUB_TOKEN}` } });
    if (response.status !== 200) throw new Error();
    const run = await response.json();
    if (String(run.id) !== env.GITHUB_RUN_ID || run.repository?.full_name?.toLowerCase() !== env.GITHUB_REPOSITORY.toLowerCase()
        || !['schedule', 'workflow_dispatch'].includes(run.event) || !Number.isFinite(Date.parse(run.created_at))) throw new Error();
    return new Date(run.created_at).toISOString();
  } catch { F.fail('TEST_QUEUE_IDENTITY_REQUIRED'); }
}
async function main(env = process.env) {
  const settings = validateEnvironment(env), queuedAt = await githubQueuedAt(env);
  if (!env.GITHUB_ENV) F.fail('TEST_QUEUE_IDENTITY_REQUIRED');
  const client = new MongoClient(settings.uri, { retryWrites: false,
    serverSelectionTimeoutMS: 10000, socketTimeoutMS: 15000, maxPoolSize: 2 });
  try {
    await client.connect();
    const token = await bindLaunch(client.db(settings.database), { ...settings, github: true, queuedAt });
    appendFileSync(env.GITHUB_ENV, `FORECAST_TEST_EPOCH=${JSON.stringify(token)}\nFORECAST_WORKER_QUEUED_AT=${queuedAt}\n`);
    return { status: 'OK', mode: 'BIND_EPOCH_READ_ONLY', writes: 0 };
  } finally { await client.close(); }
}
if (require.main === module) main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
  process.stdout.write(`${JSON.stringify({ status: 'FAILED', code: ['STALE_TEST_EPOCH', 'TEST_EPOCH_REQUIRED', 'TEST_EPOCH_INVALID',
    'TEST_QUEUE_IDENTITY_REQUIRED'].includes(error.code) ? error.code : 'TEST_EPOCH_BIND_FAILED', writes: 0 })}\n`);
  process.exitCode = 1;
});
module.exports = { main, githubQueuedAt };
