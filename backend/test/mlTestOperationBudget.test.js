'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/services/mlTestOperationBudget');

test('capture budgets use bounded local and explicit cloud defaults, with a validated hard maximum', () => {
  assert.equal(B.captureBudgetMs(), 120000);
  assert.equal(B.captureBudgetMs({ operational: false }), 120000);
  assert.equal(B.captureBudgetMs({ operational: true }), 240000);
  assert.equal(B.captureBudgetMs({ operational: true, env: { [B.CLOUD_CAPTURE_TIMEOUT_ENV]: '180000' } }), 180000);
  assert.equal(B.captureBudgetMs({ operational: true, env: { [B.CLOUD_CAPTURE_TIMEOUT_ENV]: '300000' } }), 300000);
  for (const value of ['', 'fast', '119999', '300001', '99999999999999999']) {
    assert.throws(() => B.captureBudgetMs({ operational: true, env: { [B.CLOUD_CAPTURE_TIMEOUT_ENV]: value } }),
      { code: 'CHECKPOINT_OPERATION_TIMEOUT_CONFIG_INVALID' });
  }
});

test('one monotonic wall-clock budget reports phase, checkpoint, elapsed and remaining time and fails closed', () => {
  let now = 1000; const progress = [];
  const check = B.checkpointBudget(120000, { now: () => now, memory: () => ({ rss: 1 }),
    checkpointId: 'safe-checkpoint-id', onPhase: row => progress.push(row) });
  assert.equal(check('DRAIN'), 120000);
  now += 40000;
  assert.equal(check('SNAPSHOT_READ'), 80000);
  assert.deepEqual(progress.map(row => [row.phase, row.elapsedMs, row.remainingBudgetMs]),
    [['DRAIN', 0, 120000], ['SNAPSHOT_READ', 40000, 80000]]);
  assert.equal(check.phaseMetrics().DRAIN, 40000);
  now += 80000;
  assert.throws(() => check('CHUNK_WRITE'), error => error.code === 'CHECKPOINT_OPERATION_TIMEOUT'
    && error.phase === 'CHUNK_WRITE' && error.checkpointId === 'safe-checkpoint-id'
    && error.elapsedMs === 120000 && error.remainingBudgetMs === 0 && error.budgetMs === 120000);
});

