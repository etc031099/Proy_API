const test = require('node:test');
const assert = require('node:assert/strict');
const { view } = require('../src/automations/execution');
const { publicResponse } = require('../src/services/agentHistoryProjection');

const customerId = '507f1f77bcf86cd799439011';
const occurredAt = new Date('2026-10-22T15:30:00.000Z');

test('sale action projection exposes only the scoped customer reference and persisted transaction metadata', () => {
  const row = { pendingActionId: '11111111-1111-4111-8111-111111111111', actionSkillId: 'create_sale',
    validatedArgs: { customerId, secretLikeField: 'must-not-project' }, summary: 'Venta', expiresAt: occurredAt,
    requiresConfirmation: true, status: 'EXECUTED', preview: { fields: { currency: 'PEN' }, items: [
      { sku: 'PAN-FRE-001', name: 'Pan Francés', quantity: 2, stock: 20, resultingStock: 18, price: 2, total: 4, productId: customerId }
    ] }, result: { id: 'transaction-1', type: 'sale', customerId, occurredAt: occurredAt.toISOString(), currency: 'PEN', total: 4,
      items: [{ sku: 'PAN-FRE-001', name: 'Pan Francés', quantity: 2, stock: 18 }] } };

  const projected = publicResponse({ pendingAction: view(row) }).pendingAction;
  assert.equal(projected.customerId, customerId);
  assert.deepEqual(projected.result, { id: 'transaction-1', type: 'sale', customerId, occurredAt: occurredAt.toISOString(),
    currency: 'PEN', total: 4, items: [{ sku: 'PAN-FRE-001', name: 'Pan Francés', quantity: 2, stock: 18 }] });
  assert.equal('validatedArgs' in projected, false);
  assert.equal('secretLikeField' in projected, false);
  assert.equal('productId' in projected.items[0], false);
});

test('unassociated sale exposes null customer and non-sale actions expose no customer metadata', () => {
  const base = { pendingActionId: '22222222-2222-4222-8222-222222222222', summary: 'Acción', expiresAt: occurredAt,
    requiresConfirmation: true, status: 'PENDING', preview: { fields: {} }, validatedArgs: {} };
  assert.equal(view({ ...base, actionSkillId: 'create_sale' }).customerId, null);
  assert.equal(Object.hasOwn(view({ ...base, actionSkillId: 'create_purchase' }), 'customerId'), false);
});
