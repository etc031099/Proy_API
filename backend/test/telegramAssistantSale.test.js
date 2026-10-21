const test = require('node:test');
const assert = require('node:assert/strict');
const writeService = require('../src/services/transactionWriteService');
const ActionDomainEvent = require('../src/models/ActionDomainEvent');
const telegram = require('../src/services/telegramService');

test('assistant sale registers a low-stock notification only for after commit', async (t) => {
  const product = { sku: 'ABA-SAZ-003', name: 'Caldo de Gallina Maggi caja 6 cubos', stock: 2, minStockLevel: 2 };
  const calls = [];
  t.mock.method(writeService, 'writeTransaction', async () => ({
    transaction: { _id: 'transaction-id' },
    snapshot: { currency: 'PEN', totalAmount: 1, items: [{ sku: product.sku, name: product.name, quantity: 1, resultingStock: 2 }] },
    lowStockNotifications: [{ product, previousStock: 3 }]
  }));
  t.mock.method(ActionDomainEvent, 'insertMany', async () => {});
  t.mock.method(telegram, 'notifyLowStock', async (...args) => { calls.push(args); });
  delete require.cache[require.resolve('../src/automations/executors')];
  const executor = require('../src/automations/executors').createActionExecutors().create_sale;
  const afterCommit = [];
  await executor.execute({}, { businessId: 'tenant-a' }, {}, 'action-id', {}, callback => afterCommit.push(callback));
  assert.equal(calls.length, 0);
  assert.equal(afterCommit.length, 1);
  await afterCommit[0]();
  assert.deepEqual(calls[0], ['tenant-a', product, 3]);
});
