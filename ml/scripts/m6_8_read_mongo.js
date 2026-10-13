'use strict';

// Exact-scope read-only M6.8 extractor. Never logs records, URI, or driver errors.
const path = require('node:path');
const dotenv = require(path.resolve(__dirname, '../../backend/node_modules/dotenv'));
const mongoose = require(path.resolve(__dirname, '../../backend/node_modules/mongoose'));
const models = require(path.resolve(__dirname, '../../backend/src/models'));
const {
  BUSINESS_ID, SCENARIO_ID, DATABASE, ATLAS_HOST, assertAtlasMongoUri,
} = require(path.resolve(__dirname, '../../backend/scripts/lib/minimarketV3Mongo'));

const ROOT = path.resolve(__dirname, '../..');

async function readAtlas() {
  dotenv.config({ path: path.join(ROOT, 'backend/.env'), quiet: true });
  const uri = assertAtlasMongoUri(process.env.MONGODB_URI || '').toString();
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000, maxPoolSize: 3, autoIndex: false, autoCreate: false,
    readPreference: 'primary', retryWrites: false,
  });
  try {
    const connection = mongoose.connection;
    if (connection.name !== DATABASE || connection.getClient().options.srvHost !== ATLAS_HOST) throw new Error('scope');
    const filter = { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID };
    const [scenario, transactionDocs, productDocs, supplierCostDocs] = await Promise.all([
      models.HistoricalScenario.collection.findOne(filter, { projection: { _id: 0, businessId: 1, scenarioId: 1,
        sourceSha256: 1, status: 1, 'metadata.datasetVersion': 1, 'metadata.referenceDate': 1 } }),
      models.Transaction.collection.find(filter, { projection: { _id: 0, type: 1, scenarioData: 1 } }).toArray(),
      models.Product.collection.find(filter, { projection: { _id: 0, canonicalData: 1 } }).toArray(),
      models.MinimarketV3Record.collection.find({ ...filter, recordType: 'supplier_cost_history' },
        { projection: { _id: 0, canonicalData: 1 } }).toArray(),
    ]);
    const contacts = await models.Contact.collection.find(filter, { projection: { _id: 0, type: 1, canonicalData: 1 } }).toArray();
    if (!scenario || transactionDocs.some((row) => !row.scenarioData?.canonicalRecord)
        || productDocs.some((row) => !row.canonicalData) || contacts.some((row) => !row.canonicalData)
        || supplierCostDocs.some((row) => !row.canonicalData)) throw new Error('incomplete');

    const sales = transactionDocs.filter((row) => row.type === 'sale');
    const purchases = transactionDocs.filter((row) => row.type === 'purchase');
    const saleLines = sales.flatMap((row) => row.scenarioData.canonicalLines || []);
    const purchaseLines = purchases.flatMap((row) => row.scenarioData.canonicalLines || []);
    const readNdjson = (name) => {
      const fs = require('node:fs');
      return fs.readFileSync(path.join(ROOT, 'data/minimarket-pasco-v3/generated', name), 'utf8')
        .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    };
    const records = {
      source: 'atlas',
      scenario: { scenarioId: scenario.scenarioId, sourceSha256: scenario.sourceSha256,
        datasetVersion: scenario.metadata?.datasetVersion, referenceDate: scenario.metadata?.referenceDate, status: scenario.status },
      sales: sales.map((row) => row.scenarioData.canonicalRecord), saleItems: saleLines,
      purchases: purchases.map((row) => row.scenarioData.canonicalRecord), purchaseLines,
      products: productDocs.map((row) => row.canonicalData),
      suppliers: contacts.filter((row) => row.type === 'vendor').map((row) => row.canonicalData),
      customers: contacts.filter((row) => row.type === 'customer').map((row) => row.canonicalData),
      movements: (await models.InventoryMovement.collection.find(filter, { projection: { _id: 0, scenarioData: 1 } }).toArray())
        .map((row) => row.scenarioData),
      // Snapshot rows are a canonical derivative; stock itself is rebuilt and reconciled from Atlas movements.
      inventorySnapshot: readNdjson('inventory-snapshot.ndjson'),
      supplierCostHistory: supplierCostDocs.map((row) => row.canonicalData),
    };
    process.stdout.write(JSON.stringify({ source: 'atlas', counts: {
      customers: records.customers.length, suppliers: records.suppliers.length,
      sales: records.sales.length, saleItems: records.saleItems.length,
      purchases: records.purchases.length, purchaseLines: records.purchaseLines.length,
      products: records.products.length, movements: records.movements.length,
    }, records }));
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv.includes('--target') && process.argv[process.argv.indexOf('--target') + 1] === 'atlas') {
readAtlas().catch(async (error) => {
    try { await mongoose.disconnect(); } catch { /* sanitized */ }
  const message = String(error?.message || '');
  const category = error?.name === 'MongooseServerSelectionError' ? 'ATLAS_CONNECTION_FAILED'
    : /Atlas target/.test(message) ? 'ATLAS_URI_REJECTED'
      : /scope/.test(message) ? 'ATLAS_SCOPE_MISMATCH'
        : /incomplete/.test(message) ? 'ATLAS_CANONICAL_DATA_INCOMPLETE'
          : 'ATLAS_READ_FAILED';
  process.stderr.write(`${category}\n`);
    process.exitCode = 1;
  });
} else {
  process.stderr.write('ATLAS_READ_FAILED\n');
  process.exitCode = 1;
}
