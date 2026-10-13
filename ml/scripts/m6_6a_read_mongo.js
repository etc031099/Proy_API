'use strict';

// Read-only, exact-scope extractor for M6.6A. JSON is piped only to the local
// Python parent process; this program never writes files or logs record payloads.
const path = require('node:path');
const dotenv = require(path.resolve(__dirname, '../../backend/node_modules/dotenv'));
const mongoose = require(path.resolve(__dirname, '../../backend/node_modules/mongoose'));
const models = require(path.resolve(__dirname, '../../backend/src/models'));
const {
  BUSINESS_ID, SCENARIO_ID, DATABASE, ATLAS_HOST,
  assertAtlasMongoUri, assertLocalMongoUri, buildLocalDockerUri,
} = require(path.resolve(__dirname, '../../backend/scripts/lib/minimarketV3Mongo'));

const ROOT = path.resolve(__dirname, '../..');
const ENV_PATH = path.join(ROOT, 'backend/.env');
async function readTarget(target) {
  dotenv.config({ path: ENV_PATH, quiet: true });
  let uri;
  if (target === 'local') {
    uri = assertLocalMongoUri(buildLocalDockerUri(process.env.MONGODB_URI_DOCKER || '')).toString();
  } else if (target === 'atlas') {
    uri = assertAtlasMongoUri(process.env.MONGODB_URI || '').toString();
  } else {
    throw new Error('Unsupported read target');
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: target === 'local' ? 7000 : 15000,
    maxPoolSize: 3,
    autoIndex: false,
    autoCreate: false,
    readPreference: 'primary',
    retryWrites: false,
  });
  try {
    const connection = mongoose.connection;
    if (connection.name !== DATABASE) throw new Error('Unexpected database');
    if (target === 'local' && connection.host !== '127.0.0.1') throw new Error('Unexpected local host');
    if (target === 'atlas' && connection.getClient().options.srvHost !== ATLAS_HOST) throw new Error('Unexpected Atlas host');

    const filter = { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID };
    const scenarioDoc = await models.HistoricalScenario.collection.findOne(filter, {
      projection: { _id: 0, businessId: 1, scenarioId: 1, sourceSha256: 1, status: 1,
        'metadata.datasetVersion': 1, 'metadata.referenceDate': 1 },
    });
    const [products, purchaseTransactions, movementDocs] = await Promise.all([
      models.Product.collection.find(filter, { projection: { _id: 0, sku: 1, canonicalData: 1 } }).toArray(),
      models.Transaction.collection.find({ ...filter, type: 'purchase' }, {
        projection: { _id: 0, stableCode: 1, scenarioData: 1 },
      }).toArray(),
      models.InventoryMovement.collection.find(filter, { projection: { _id: 0, scenarioData: 1 } }).toArray(),
    ]);

    const canonicalProducts = products.map((row) => row.canonicalData);
    const purchases = purchaseTransactions.map((row) => row.scenarioData?.canonicalRecord);
    const purchaseLines = purchaseTransactions.flatMap((row) => row.scenarioData?.canonicalLines || []);
    const movements = movementDocs.map((row) => row.scenarioData);
    if (!scenarioDoc || !scenarioDoc.businessId || products.some((row) => !row.canonicalData)
        || purchases.some((row) => !row) || purchaseLines.length !== 3408 || movements.some((row) => !row)) {
      throw new Error('V3 canonical projections are incomplete');
    }

    const output = {
      source: target,
      database: connection.name,
      scenario: {
        businessId: scenarioDoc.businessId,
        scenarioId: scenarioDoc.scenarioId,
        sourceSha256: scenarioDoc.sourceSha256,
        status: scenarioDoc.status,
        datasetVersion: scenarioDoc.metadata?.datasetVersion,
        referenceDate: scenarioDoc.metadata?.referenceDate,
      },
      operationalRecords: {
        products: canonicalProducts,
        purchases,
        purchaseLines,
        movements,
        scenario: {
          scenarioId: scenarioDoc.scenarioId,
          sourceSha256: scenarioDoc.sourceSha256,
          status: scenarioDoc.status,
          datasetVersion: scenarioDoc.metadata?.datasetVersion,
          referenceDate: scenarioDoc.metadata?.referenceDate,
        },
      },
      counts: { products: products.length, purchases: purchases.length,
        purchaseLines: purchaseLines.length, movements: movements.length },
    };
    process.stdout.write(JSON.stringify(output));
  } finally {
    await mongoose.disconnect();
  }
}

const targetIndex = process.argv.indexOf('--target');
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : null;
readTarget(target).catch(async () => {
  try { await mongoose.disconnect(); } catch { /* sanitized failure */ }
  process.stderr.write(`${target === 'local' ? 'LOCAL' : 'ATLAS'}_READ_FAILED\n`);
  process.exitCode = 1;
});
