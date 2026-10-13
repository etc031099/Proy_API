'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const models = require('../src/models');
const { validateDataset } = require('../../scripts/validate-minimarket-v3-dataset');
const {
  ATLAS_HOST, DATABASE, DEFAULT_DATASET, BUSINESS_ID, SCENARIO_ID, RESET_MODELS,
  assertAtlasMongoUri, assertImportConnection, assertAtlasRollback, importPackage, loadPackage, resetScenario, scenarioFilter,
} = require('./lib/minimarketV3Mongo');
const { captureAtlasSnapshot, compareProtectedSnapshots, preflightAtlas } = require('./lib/minimarketV3Atlas');
const { verifyParity } = require('./lib/minimarketV3Parity');

function parseArgs(args) {
  const allowed = new Set(['--atlas', '--scenario-id', '--dry-run', '--apply', '--verify', '--rollback', '--confirm-v3-import', '--confirm-v3-rollback', SCENARIO_ID]);
  if (args.some((arg) => !allowed.has(arg)) || !args.includes('--atlas')
      || args[args.indexOf('--scenario-id') + 1] !== SCENARIO_ID || !args.includes('--scenario-id')) throw new Error('Atlas/scenario exactos requeridos.');
  const modes = ['dry-run', 'apply', 'verify', 'rollback'].filter((mode) => args.includes(`--${mode}`));
  if (modes.length !== 1) throw new Error('Se requiere un único modo explícito.');
  const mode = modes[0];
  if (mode === 'apply' && !args.includes('--confirm-v3-import')) throw new Error('Apply requiere --confirm-v3-import.');
  if (mode === 'rollback') assertAtlasRollback({ atlas: true, scenarioId: SCENARIO_ID, businessId: BUSINESS_ID, confirmed: args.includes('--confirm-v3-rollback') });
  return { mode };
}

async function querySmokes(pkg) {
  const filter = scenarioFilter();
  const product = await models.Product.collection.findOne({ ...filter, name: pkg.products[0].name }, { projection: { _id: 0, name: 1, sku: 1, stock: 1 } });
  const periods = {};
  for (const [label, start, end] of [
    ['2026-10-12', '2026-10-12', '2026-10-12'], ['2026-10-11', '2026-10-11', '2026-10-11'],
    ['last7Days', '2026-10-06', '2026-10-12'], ['last30Days', '2026-09-13', '2026-10-12'],
  ]) {
    const from = new Date(`${start}T00:00:00-05:00`);
    const until = new Date(new Date(`${end}T00:00:00-05:00`).getTime() + 86400000);
    const dates = { $gte: from, $lt: until };
    periods[label] = { start, end, timezone: 'America/Lima',
      completedSales: await models.Transaction.collection.countDocuments({ ...filter, type: 'sale', status: 'completed', date: dates }),
      purchases: await models.Transaction.collection.countDocuments({ ...filter, type: 'purchase', date: dates }),
    };
  }
  const lowStock = await models.Product.collection.countDocuments({ ...filter, $expr: { $lte: ['$stock', '$minStockLevel'] } });
  if (!product || product.stock !== pkg.products[0].endingStock) throw new Error('Human product/stock smoke failed.');
  return { product, periods, lowStock };
}

async function assertSafeRollback() {
  const f = scenarioFilter();
  const ps = (await models.Product.collection.find(f, { projection: { _id: 1 } }).toArray()).map((row) => row._id);
  const cs = (await models.Contact.collection.find(f, { projection: { _id: 1 } }).toArray()).map((row) => row._id);
  const ts = (await models.Transaction.collection.find(f, { projection: { _id: 1 } }).toArray()).map((row) => row._id);
  const external = { businessId: { $ne: BUSINESS_ID } };
  const refs = await models.Transaction.collection.countDocuments({ ...external, $or: [{ 'products.productId': { $in: ps } }, { customerId: { $in: cs } }, { vendorId: { $in: cs } }, { supplierId: { $in: cs } }] })
    + await models.InventoryMovement.collection.countDocuments({ ...external, $or: [{ productId: { $in: ps } }, { transactionId: { $in: ts } }] })
    + await models.Product.collection.countDocuments({ ...external, $or: [{ 'supplierPrices.supplierId': { $in: cs } }, { preferredSupplierId: { $in: cs } }] });
  if (refs) throw new Error('Rollback bloqueado por referencias externas; no borrar.');
}

async function main(args = process.argv.slice(2)) {
  const { mode } = parseArgs(args);
  const started = Date.now();
  dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
  const atlasUri = assertAtlasMongoUri(process.env.MONGODB_URI || '').toString();
  console.log(JSON.stringify({ target: ATLAS_HOST, database: DATABASE, businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, mode }));
  const validation = await validateDataset(DEFAULT_DATASET);
  if (!validation.valid) throw new Error('Canonical package validation failed.');
  const pkg = loadPackage();
  const reportPath = path.join(DEFAULT_DATASET, 'm6.4b-atlas-report.json');
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { target: ATLAS_HOST, database: DATABASE, logicalSha256: pkg.manifest.hashes.logicalDatasetSha256, runs: [] };
  if (report.target !== ATLAS_HOST || report.logicalSha256 !== pkg.manifest.hashes.logicalDatasetSha256) throw new Error('Reporte previo no corresponde al target/dataset.');
  await mongoose.connect(atlasUri, { serverSelectionTimeoutMS: 15000, maxPoolSize: 3, autoIndex: false, autoCreate: false, readPreference: 'primary', retryWrites: true });
  const run = { mode, at: new Date().toISOString(), packageValid: true };
  try {
    assertImportConnection(mongoose.connection, { target: 'atlas', atlasUri });
    run.preflight = await preflightAtlas(pkg);
    run.before = await captureAtlasSnapshot();
    // Persist only counts/stats/digests before mutations, never documents or credentials.
    report.runs.push(run);
    const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    save();
    run.dryRun = { logicalDocuments: 55776, batchLimit: 500,
      collections: { products: 80, contacts: 50, transactions: 15008, inventorymovements: 40445, minimarketv3records: 192, historicalscenarios: 1 },
      canonicalReferencesValid: true, productDayRowsImported: false, collisions: run.preflight.collisions };
    save();
    if (mode === 'apply') {
      if (!run.preflight.existingApprovedRun) {
        // Existing operational indexes are already installed; only initialize the new V3 auxiliary collection.
        await models.MinimarketV3Record.createIndexes();
      }
      run.importResult = await importPackage({ target: 'atlas', atlasUri });
    } else if (mode === 'rollback') {
      await assertSafeRollback();
      await resetScenario();
      for (const model of [...RESET_MODELS, models.HistoricalScenario]) {
        if (await model.collection.countDocuments(scenarioFilter())) throw new Error('Rollback V3 incompleto; detener.');
      }
    }
    if (mode === 'apply' || mode === 'verify') {
      const parity = await verifyParity(pkg);
      run.parity = { valid: parity.pass, errors: parity.errors, ...parity.summary };
      save();
      if (!parity.pass) throw new Error('Canonical Atlas parity failed.');
      run.querySmokes = await querySmokes(pkg);
    }
    run.after = await captureAtlasSnapshot();
    run.protectedComparison = compareProtectedSnapshots(run.before, run.after);
    run.growth = Object.fromEntries(['dataSize', 'storageSize', 'indexSize', 'documents', 'collections'].map((key) => [key, run.after.database[key] - run.before.database[key]]));
    if (run.growth.dataSize + run.growth.indexSize > 160 * 1024 * 1024) throw new Error('Crecimiento anormal; detener sin limpieza automática.');
    run.status = 'PASS'; run.durationMs = Date.now() - started; save();
    console.log(JSON.stringify({ status: run.status, mode, durationMs: run.durationMs, preflight: run.preflight, dryRun: run.dryRun,
      alreadyImported: run.importResult?.alreadyImported, before: run.before.database, after: run.after.database, growth: run.growth,
      canonicalAtlasParity: run.parity?.valid ? 'PASS' : undefined, hashParity: run.parity?.hashParity,
      protectedComparison: run.protectedComparison, querySmokes: run.querySmokes }, null, 2));
  } catch (error) {
    run.status = 'STOP'; run.failure = { name: error.name, code: error.code || 'CONTROLLED_IMPORT_STOP' }; run.durationMs = Date.now() - started;
    if (!report.runs.includes(run)) report.runs.push(run);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    throw error;
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main().catch((error) => { console.error(JSON.stringify({ status: 'STOP', name: error.name, code: error.code || 'CONTROLLED_IMPORT_STOP' })); process.exitCode = 1; });
module.exports = { main, parseArgs, querySmokes, assertSafeRollback };
