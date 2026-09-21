// Idempotent database initialization, executed after replica set rs0 has a PRIMARY.
db = db.getSiblingDB('inventory_billing');

function ensureCollection(name) {
  if (!db.getCollectionNames().includes(name)) {
    db.createCollection(name);
  }
}

ensureCollection('users');
db.users.createIndex({ email: 1 }, { unique: true });
db.users.createIndex({ businessId: 1 }, { unique: true });

ensureCollection('products');
db.products.createIndex({ businessId: 1, name: 1 });
db.products.createIndex({ businessId: 1, category: 1 });
db.products.createIndex({ businessId: 1, stock: 1 });
db.products.createIndex({ businessId: 1, scenarioId: 1 });
db.products.createIndex(
  { businessId: 1, scenarioId: 1, sourceEventId: 1 },
  { unique: true, partialFilterExpression: {
    scenarioId: { $type: 'string', $gt: '' },
    sourceEventId: { $type: 'string', $gt: '' }
  } }
);
db.products.createIndex(
  { businessId: 1, sku: 1 },
  {
    name: 'businessId_1_sku_1',
    unique: true,
    partialFilterExpression: { sku: { $type: 'string', $gt: '' } }
  }
);

ensureCollection('contacts');
db.contacts.createIndex({ businessId: 1, type: 1 });
db.contacts.createIndex({ businessId: 1, name: 1 });
db.contacts.createIndex({ phone: 1 });
db.contacts.createIndex({ email: 1 }, { sparse: true });
db.contacts.createIndex({ businessId: 1, scenarioId: 1 });
db.contacts.createIndex(
  { businessId: 1, scenarioId: 1, sourceEventId: 1 },
  { unique: true, partialFilterExpression: {
    scenarioId: { $type: 'string', $gt: '' },
    sourceEventId: { $type: 'string', $gt: '' }
  } }
);

ensureCollection('transactions');
db.transactions.createIndex({ businessId: 1, date: -1 });
db.transactions.createIndex({ businessId: 1, type: 1, date: -1 });
db.transactions.createIndex({ businessId: 1, customerId: 1 });
db.transactions.createIndex({ businessId: 1, vendorId: 1 });
db.transactions.createIndex({ businessId: 1, scenarioId: 1 });
db.transactions.createIndex(
  { businessId: 1, scenarioId: 1, sourceEventId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      scenarioId: { $type: 'string', $gt: '' },
      sourceEventId: { $type: 'string', $gt: '' }
    }
  }
);

ensureCollection('creditpayments');
db.creditpayments.createIndex({ businessId: 1, customerId: 1, date: -1 });
db.creditpayments.createIndex({ businessId: 1, scenarioId: 1 });
db.creditpayments.createIndex(
  { businessId: 1, scenarioId: 1, sourceEventId: 1 },
  { unique: true, partialFilterExpression: {
    scenarioId: { $type: 'string', $gt: '' },
    sourceEventId: { $type: 'string', $gt: '' }
  } }
);

ensureCollection('inventorymovements');
db.inventorymovements.createIndex({ businessId: 1, productId: 1, occurredAt: 1, createdAt: 1 });
db.inventorymovements.createIndex({ businessId: 1, transactionId: 1 });
db.inventorymovements.createIndex({ businessId: 1, scenarioId: 1 });
db.inventorymovements.createIndex(
  { businessId: 1, scenarioId: 1, sourceEventId: 1 },
  {
    name: 'businessId_1_scenarioId_1_sourceEventId_1',
    unique: true,
    partialFilterExpression: {
      scenarioId: { $type: 'string', $gt: '' },
      sourceEventId: { $type: 'string', $gt: '' }
    }
  }
);
db.inventorymovements.createIndex(
  { businessId: 1, sourceEventId: 1 },
  {
    name: 'businessId_1_backfillSourceEventId_1',
    unique: true,
    partialFilterExpression: {
      source: 'backfill',
      sourceEventId: { $type: 'string', $gt: '' }
    }
  }
);

ensureCollection('historicalscenarios');
db.historicalscenarios.createIndex(
  { businessId: 1, scenarioId: 1 },
  { unique: true, name: 'businessId_1_scenarioId_1' }
);

print('Database initialization completed on replica set rs0.');
