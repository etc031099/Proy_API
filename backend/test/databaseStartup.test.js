'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseStorageStatus, initializeDatabaseBackedServices, isAtlasStorageQuotaError } = require('../src/services/databaseStartup');

const tasks = overrides => {
  const calls = [];
  return {
    calls,
    options: {
      initializeCollections: async () => { calls.push('collections'); },
      provisionIndexes: async () => { calls.push('indexes'); },
      refreshWatermarks: async () => { calls.push('watermarks'); },
      startPolling: () => { calls.push('polling'); },
      onStorageDegraded: detail => calls.push(`degraded:${detail.reasonCode}:${detail.stage}`),
      onRefreshFailure: () => calls.push('refresh-warning'),
      ...overrides
    }
  };
};

test('Atlas code 8000 enters degraded startup and skips later writes and polling', async () => {
  const setup = tasks({ initializeCollections: async () => { setup.calls.push('collections'); throw { code: 8000, codeName: 'AtlasError' }; } });
  const result = await initializeDatabaseBackedServices(setup.options);
  assert.deepEqual(result, { mode: 'STORAGE_DEGRADED', reasonCode: 'DATABASE_WRITE_BLOCKED_STORAGE', stage: 'COLLECTION_INITIALIZATION' });
  assert.deepEqual(setup.calls, ['collections', 'degraded:DATABASE_WRITE_BLOCKED_STORAGE:COLLECTION_INITIALIZATION']);
});

test('unexpected collection initialization errors still reject for fail-fast startup', async () => {
  const setup = tasks({ initializeCollections: async () => { setup.calls.push('collections'); throw Object.assign(new Error('index failure'), { code: 123 }); } });
  await assert.rejects(initializeDatabaseBackedServices(setup.options), /index failure/);
  assert.deepEqual(setup.calls, ['collections']);
});

test('normal startup preserves initialization, watermark refresh, then polling order', async () => {
  const setup = tasks();
  const result = await initializeDatabaseBackedServices(setup.options);
  assert.deepEqual(result, { mode: 'NORMAL', reasonCode: null, stage: null });
  assert.deepEqual(setup.calls, ['collections', 'indexes', 'watermarks', 'polling']);
});

test('Atlas quota during watermark refresh also leaves polling stopped', async () => {
  const setup = tasks({ refreshWatermarks: async () => { setup.calls.push('watermarks'); throw { code: 8000 }; } });
  const result = await initializeDatabaseBackedServices(setup.options);
  assert.equal(result.mode, 'STORAGE_DEGRADED');
  assert.equal(result.stage, 'WATERMARK_REFRESH');
  assert.deepEqual(setup.calls, ['collections', 'indexes', 'watermarks', 'degraded:DATABASE_WRITE_BLOCKED_STORAGE:WATERMARK_REFRESH']);
});

test('quota detection recognizes nested driver errors and ignores unrelated errors', () => {
  assert.equal(isAtlasStorageQuotaError({ cause: { code: 8000 } }), true);
  assert.equal(isAtlasStorageQuotaError({ code: 11000, message: 'quota' }), false);
});

test('health database status distinguishes connected/readable storage degradation', () => {
  assert.deepEqual(databaseStorageStatus(false), {
    connected: true, readable: true, writesBlocked: false, storageDegraded: false
  });
  assert.deepEqual(databaseStorageStatus(true), {
    connected: true, readable: true, writesBlocked: true, storageDegraded: true,
    reasonCode: 'DATABASE_WRITE_BLOCKED_STORAGE'
  });
});
