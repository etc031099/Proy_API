const assert = require('node:assert/strict');
const test = require('node:test');

test('transactions routes load and register without starting the application', () => {
  const transactionsRouter = require('../src/routes/transactions');

  assert.equal(typeof transactionsRouter, 'function');
});
