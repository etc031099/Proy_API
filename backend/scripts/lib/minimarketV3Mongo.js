'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { canonicalJson, sha256 } = require('../../../scripts/lib/minimarket-v3-generator');
const { Product, Contact, Transaction, InventoryMovement, HistoricalScenario, MinimarketV3Record } = require('../../src/models');

const SCENARIO_ID = 'minimarket-pasco-v3';
const BUSINESS_ID = 'MINIMARKET-PASCO-V3';
const DATABASE = 'inventory_billing';
const ATLAS_HOST = 'cluster0.e2a81nq.mongodb.net';
const DEFAULT_DATASET = path.resolve(__dirname, '../../../data/minimarket-pasco-v3/generated');
const RESET_MODELS = [Product, Contact, Transaction, InventoryMovement, MinimarketV3Record];

function assertAtlasMongoUri(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('Atlas target inválido.'); }
  if (parsed.protocol !== 'mongodb+srv:' || parsed.hostname !== ATLAS_HOST || parsed.port
      || parsed.pathname !== `/${DATABASE}` || parsed.searchParams.get('tls') === 'false'
      || parsed.searchParams.get('ssl') === 'false') throw new Error('Atlas target no coincide con host/base aprobados.');
  return parsed;
}

function assertImportConnection(connection, { target = 'local', atlasUri } = {}) {
  if (connection.name !== DATABASE) throw new Error('Importación abortada: base incorrecta.');
  if (target === 'local' && connection.host === '127.0.0.1') return;
  if (target === 'atlas') {
    assertAtlasMongoUri(atlasUri);
    if (connection.getClient().options.srvHost === ATLAS_HOST && connection.host?.endsWith('.mongodb.net')) return;
  }
  throw new Error('Importación abortada: conexión no coincide con target explícito.');
}

function assertV3Write(doc, filter) {
  for (const row of [doc, filter]) {
    if (row.businessId !== BUSINESS_ID || row.scenarioId !== SCENARIO_ID) throw new Error('Escritura fuera del scope V3 abortada.');
  }
}

function assertAtlasRollback({ atlas, scenarioId, businessId, confirmed }) {
  if (atlas !== true || confirmed !== true || scenarioId !== SCENARIO_ID || businessId !== BUSINESS_ID) {
    throw new Error('Rollback requiere Atlas explícito, scenario/business V3 exactos y confirmación.');
  }
  return scenarioFilter();
}

function assertLocalMongoUri(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error('M6.4 requiere una URI Mongo local válida.'); }
  if (parsed.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || (parsed.port && parsed.port !== '27017') || parsed.pathname !== `/${DATABASE}`
      || parsed.searchParams.get('directConnection') !== 'true' || parsed.searchParams.has('replicaSet')) {
    throw new Error('M6.4 abortado: solo se permite Mongo local 127.0.0.1:27017/inventory_billing con directConnection=true.');
  }
  return parsed;
}

function buildLocalDockerUri(dockerUri) {
  let parsed;
  try { parsed = new URL(dockerUri); } catch { throw new Error('M6.4 requiere MONGODB_URI_DOCKER válida.'); }
  if (parsed.protocol !== 'mongodb:' || parsed.hostname !== 'mongodb' || parsed.pathname !== `/${DATABASE}`) {
    throw new Error('M6.4 abortado: MONGODB_URI_DOCKER no apunta al Mongo local esperado.');
  }
  parsed.hostname = '127.0.0.1';
  parsed.searchParams.delete('replicaSet');
  parsed.searchParams.set('directConnection', 'true');
  return parsed.toString();
}

function loadNdjson(directory, name) {
  const file = path.join(directory, name);
  if (!fs.existsSync(file)) throw new Error(`Falta archivo canónico ${name}.`);
  const text = fs.readFileSync(file, 'utf8').trim();
  return text ? text.split(/\r?\n/).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`${name}:${index + 1} contiene JSON inválido.`); }
  }) : [];
}

function loadPackage(directory = DEFAULT_DATASET) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.scenarioId !== SCENARIO_ID || manifest.seed !== 2026
      || manifest.referenceDate !== '2026-10-12'
      || manifest.hashes?.logicalDatasetSha256 !== 'a90b913b6ee83174165b39eaab1526525b3aacc53cae1abe6c3f5a54a469cac8') {
    throw new Error('Paquete no coincide con el escenario canónico aprobado.');
  }
  const read = (name) => loadNdjson(root, name);
  const definitions = {
    scenario: JSON.parse(fs.readFileSync(path.resolve(root, '../scenario.json'), 'utf8')),
    categories: JSON.parse(fs.readFileSync(path.resolve(root, '../categories.json'), 'utf8')),
    offers: JSON.parse(fs.readFileSync(path.resolve(root, '../supplier-offers.json'), 'utf8')),
  };
  return {
    root, manifest, definitions,
    products: read('products.ndjson'), suppliers: read('suppliers.ndjson'), customers: read('customers.ndjson'),
    sales: read('sales.ndjson'), saleItems: read('sale-items.ndjson'),
    purchases: read('purchases.ndjson'), purchaseItems: read('purchase-items.ndjson'),
    movements: read('inventory-movements.ndjson'), snapshots: read('inventory-snapshot.ndjson'),
    promotions: read('promotions.ndjson'), priceHistory: read('price-history.ndjson'),
    supplierCostHistory: read('supplier-cost-history.ndjson'),
  };
}

function indexBy(items, key) { return new Map(items.map((item) => [item[key], item])); }
function dollars(cents) { return Number((Number(cents || 0) / 100).toFixed(2)); }
function auxiliaryStableKey(recordType, row) {
  if (recordType === 'category') return row.code;
  if (recordType === 'promotion') return row.promotionCode;
  if (recordType === 'price_history') return `${row.sku}|${row.effectiveFrom}`;
  if (recordType === 'supplier_cost_history') return `${row.sku}|${row.supplierCode}|${row.effectiveFrom}`;
  throw new Error(`Auxiliar M6.4 no soportado: ${recordType}`);
}
function batches(items, size = 500) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}
async function writeUpserts(model, documents, filterFor, batchSize = 500) {
  let count = 0;
  for (const group of batches(documents, batchSize)) {
    const filters = group.map(filterFor);
    group.forEach((doc, index) => assertV3Write(doc, filters[index]));
    const existing = filters.length ? await model.collection.find({ $or: filters }).toArray() : [];
    const existingByIdentity = new Map(existing.map((row) => [canonicalJson(filterFor(row)), row]));
    const canonical = (row) => row.canonicalData ?? row.scenarioData ?? null;
    const operations = group.flatMap((doc, index) => {
      const previous = existingByIdentity.get(canonicalJson(filters[index]));
      if (previous && canonicalJson(canonical(previous)) === canonicalJson(canonical(doc))) return [];
      return [{ updateOne: { filter: filters[index], update: { $set: doc }, upsert: true } }];
    });
    if (operations.length) await model.collection.bulkWrite(operations, { ordered: true });
    count += group.length;
  }
  return count;
}

function logicalFileSha256(rows, key) {
  const sorted = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  return sha256(Buffer.from(canonicalJson(sorted)));
}

function scenarioFilter() { return { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID }; }
function stableIdentity(kind, row) {
  if (kind === 'product') return { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, sku: row.sku };
  if (kind === 'contact') return { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, sourceEventId: row.sourceEventId };
  if (kind === 'transaction') return { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, stableCode: row.stableCode };
  if (kind === 'movement') return { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, sourceEventId: row.sourceEventId };
  if (kind === 'auxiliary') return { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, recordType: row.recordType, stableKey: row.stableKey };
  throw new Error(`Entidad M6.4 no soportada: ${kind}`);
}
function reconcileStock(products, snapshots, movements) {
  const closing = new Map(snapshots.map((row) => [row.sku, row.onHandUsable]));
  const deltas = new Map();
  for (const movement of movements) deltas.set(movement.sku, (deltas.get(movement.sku) || 0) + movement.quantityDelta);
  return products.filter((row) => row.endingStock !== closing.get(row.sku) || row.endingStock !== deltas.get(row.sku)).map((row) => row.sku);
}

async function resetScenario() {
  for (const model of RESET_MODELS) await model.collection.deleteMany(scenarioFilter());
  await HistoricalScenario.collection.deleteMany({ businessId: BUSINESS_ID, scenarioId: SCENARIO_ID });
}

async function collectionCountsOutsideScenario() {
  const result = {};
  for (const model of [...RESET_MODELS, HistoricalScenario]) {
    result[model.collection.collectionName] = await model.collection.countDocuments({ businessId: { $ne: BUSINESS_ID } });
  }
  return result;
}

function assertSameCounts(before, after) {
  for (const [collection, count] of Object.entries(before)) {
    if (after[collection] !== count) throw new Error(`Guard de aislamiento falló en ${collection}.`);
  }
}

function buildContactDocuments(pkg) {
  return [
    ...pkg.suppliers.map((row) => ({
      businessId: BUSINESS_ID, scenarioId: SCENARIO_ID,
      sourceEventId: `${pkg.manifest.datasetVersion}|supplier|${row.supplierCode}|1`,
      stableCode: row.supplierCode, stableKey: row.supplierKey,
      name: row.displayName, phone: row.phoneDemo, email: row.emailDemo,
      address: { city: 'Cerro de Pasco', state: 'Pasco', country: 'Perú' },
      type: 'vendor', isActive: row.active, notes: row.purchaseTermsDemo,
      canonicalData: row,
    })),
    ...pkg.customers.map((row) => ({
      businessId: BUSINESS_ID, scenarioId: SCENARIO_ID,
      sourceEventId: `${pkg.manifest.datasetVersion}|customer|${row.customerCode}|1`,
      stableCode: row.customerCode, stableKey: row.customerKey,
      name: row.displayName, phone: row.phoneDemo, email: row.emailDemo,
      address: { city: 'Cerro de Pasco', state: 'Pasco', country: 'Perú' },
      type: 'customer', isActive: row.active,
      canonicalData: row,
    })),
  ];
}

function prepareDocuments(pkg, suppliers, customers) {
  const categoryByCode = new Map(pkg.definitions.categories.categories.map((row) => [row.code, row]));
  const contacts = buildContactDocuments(pkg);

  const costByOffer = new Map();
  for (const product of pkg.products) costByOffer.set(`${product.sku}|${product.preferredSupplierCode}`, Math.round(product.purchaseCostDemo * 100));
  for (const offer of pkg.definitions.offers.secondaryAssignments) {
    const product = pkg.products.find((row) => row.sku === offer.sku);
    costByOffer.set(`${offer.sku}|${offer.supplierCode}`, Math.round(product.purchaseCostDemo * 100 * offer.priceFactor));
  }
  const latestCosts = new Map();
  for (const change of pkg.supplierCostHistory) {
    if (change.effectiveFrom <= pkg.manifest.referenceDate) {
      const key = `${change.sku}|${change.supplierCode}`;
      if (!latestCosts.has(key) || latestCosts.get(key).effectiveFrom < change.effectiveFrom) latestCosts.set(key, change);
    }
  }
  for (const [key, change] of latestCosts) costByOffer.set(key, change.purchaseCostCents);
  const latestPrices = new Map();
  for (const change of pkg.priceHistory) {
    if (change.effectiveFrom <= pkg.manifest.referenceDate
        && (!latestPrices.has(change.sku) || latestPrices.get(change.sku).effectiveFrom < change.effectiveFrom)) latestPrices.set(change.sku, change);
  }
  const products = pkg.products.map((row) => {
    const category = categoryByCode.get(row.categoryCode);
    const supplierCodes = [row.preferredSupplierCode, ...pkg.definitions.offers.secondaryAssignments.filter((offer) => offer.sku === row.sku).map((offer) => offer.supplierCode)];
    const supplierPrices = [...new Set(supplierCodes)].map((code) => ({ supplierId: suppliers.get(code), purchasePrice: dollars(costByOffer.get(`${row.sku}|${code}`)) }));
    return {
      businessId: BUSINESS_ID, scenarioId: SCENARIO_ID,
      sourceEventId: `${pkg.manifest.datasetVersion}|product|${row.sku}|1`,
      sku: row.sku, productKey: row.productKey, name: row.name,
      description: `${row.brand} · ${row.presentation} ${row.sizeValue}${row.sizeUnit}`,
      brand: row.brand, presentation: row.presentation, sizeValue: row.sizeValue, sizeUnit: row.sizeUnit,
      containedUnits: row.containedUnits, unit: row.unit, perishable: row.perishable, shelfLifeDays: row.shelfLifeDays,
      price: dollars(latestPrices.get(row.sku)?.priceCents ?? Math.round(row.salePriceDemo * 100)),
      costPrice: dollars(costByOffer.get(`${row.sku}|${row.preferredSupplierCode}`)), currency: row.currency,
      supplierPrices, preferredSupplierId: suppliers.get(row.preferredSupplierCode),
      stock: row.endingStock, minStockLevel: row.minStockInitial, safetyStock: row.safetyStockInitial,
      reorderPoint: row.reorderPointInitial, category: category?.name ?? row.categoryCode,
      categoryCode: row.categoryCode, subcategoryCode: row.subcategoryCode,
      isActive: row.active, demandProfileKey: row.demandProfileKey, associationProfileKey: row.associationProfileKey,
      canonicalData: row,
    };
  });
  if (!pkg.productIds?.size) return { contacts, products };

  const saleLines = new Map();
  for (const row of pkg.saleItems) {
    if (!saleLines.has(row.saleCode)) saleLines.set(row.saleCode, []);
    saleLines.get(row.saleCode).push(row);
  }
  const purchaseLines = new Map();
  for (const row of pkg.purchaseItems) {
    if (!purchaseLines.has(row.purchaseCode)) purchaseLines.set(row.purchaseCode, []);
    purchaseLines.get(row.purchaseCode).push(row);
  }
  const saleCanonicalByCode = indexBy(pkg.sales, 'saleCode');
  const purchaseCanonicalByCode = indexBy(pkg.purchases, 'purchaseCode');
  const transactions = [
    ...pkg.sales.map((row) => {
      const lines = (saleLines.get(row.saleCode) ?? []).sort((a, b) => a.saleLineKey.localeCompare(b.saleLineKey));
      return {
        businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, sourceEventId: row.sourceEventId,
        stableCode: row.saleCode, invoiceNumber: row.saleCode, localDate: row.localDate,
        type: 'sale', customerId: row.customerCode ? customers.get(row.customerCode) : undefined,
        customerName: row.customerName, date: new Date(row.occurredAt), status: row.status,
        cancelledAt: row.cancelledAt ? new Date(row.cancelledAt) : null,
        products: lines.map((line) => ({
          productId: pkg.productIds.get(line.sku), productName: pkg.productBySku.get(line.sku).name,
          sku: line.sku, productKey: line.productKey, stableLineKey: line.saleLineKey, sourceEventId: line.sourceEventId,
          quantity: row.status === 'completed' ? line.unitsSold : line.quantity,
          requestedQuantity: line.requestedQuantity, unitsSold: line.unitsSold,
          price: dollars(line.effectiveUnitPriceCents), costPrice: dollars(line.costAtSaleCents),
          costCents: line.costAtSaleCents, discountCents: line.lineDiscountCents,
          total: dollars(line.lineTotalCents),
        })),
        totalAmount: dollars(row.totalCents), currency: row.currency, paymentMethod: row.paymentMethod,
        originalAmount: dollars(row.grossBeforeDiscountCents),
        scenarioData: { canonicalRecord: row, canonicalLines: lines },
      };
    }),
    ...pkg.purchases.map((row) => {
      const lines = (purchaseLines.get(row.purchaseCode) ?? []).sort((a, b) => a.purchaseLineKey.localeCompare(b.purchaseLineKey));
      const vendorId = suppliers.get(row.supplierCode);
      const vendorName = pkg.supplierByCode.get(row.supplierCode).displayName;
      return {
        businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, sourceEventId: row.sourceEventId,
        stableCode: row.purchaseCode, invoiceNumber: row.purchaseCode, localDate: row.orderedLocalDate,
        type: 'purchase', vendorId, supplierId: vendorId, vendorName,
        date: new Date(row.orderedAt), status: row.status, totalAmount: dollars(row.totalCostCents),
        currency: row.currency, paymentMethod: 'other',
        products: lines.map((line) => ({
          productId: pkg.productIds.get(line.sku), productName: pkg.productBySku.get(line.sku).name,
          sku: line.sku, productKey: line.productKey, stableLineKey: line.purchaseLineKey, sourceEventId: line.sourceEventId,
          quantity: line.quantityOrdered, requestedQuantity: line.quantityOrdered, unitsSold: 0,
          price: dollars(line.purchasePriceCents), costPrice: dollars(line.purchasePriceCents), costCents: line.purchasePriceCents * line.quantityReceived,
          discountCents: 0, total: dollars(line.lineTotalCents),
        })),
        scenarioData: { canonicalRecord: row, canonicalLines: lines },
      };
    }),
  ];
  const movements = pkg.movements.map((row) => ({
    businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, source: 'historical_import',
    sourceEventId: row.sourceEventId, stableCode: row.movementCode, localDate: row.localDate,
    productId: pkg.productIds.get(row.sku), transactionId: row.transactionCode ? pkg.transactionIds.get(row.transactionCode) ?? null : null,
    type: ({ purchase_receipt: 'purchase' })[row.type] ?? row.type,
    quantityDelta: row.quantityDelta, stockBefore: row.stockBefore, stockAfter: row.stockAfter,
    occurredAt: new Date(row.occurredAt), reason: row.reason, currency: row.currency,
    unitCostCents: row.unitCostCents, valueDeltaCents: row.valueDeltaCents, scenarioData: row,
  }));
  const aux = [];
  for (const category of pkg.definitions.categories.categories) aux.push({ recordType: 'category', stableKey: category.code, canonicalData: category });
  for (const row of pkg.promotions) aux.push({ recordType: 'promotion', stableKey: row.promotionCode, localDate: row.startDate, canonicalData: row });
  for (const [recordType, rows, dateKey] of [
    ['price_history', pkg.priceHistory, 'effectiveFrom'],
    ['supplier_cost_history', pkg.supplierCostHistory, 'effectiveFrom'],
  ]) for (const row of rows) aux.push({ recordType, stableKey: auxiliaryStableKey(recordType, row), localDate: row[dateKey], canonicalData: row });
  const records = aux.map((row) => ({
    businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, recordType: row.recordType,
    stableKey: row.stableKey, sourceEventId: `${pkg.manifest.datasetVersion}|${row.recordType}|${row.stableKey}|1`,
    localDate: row.localDate ?? null, canonicalData: row.canonicalData,
  }));
  return { contacts, products, transactions, movements, records, saleCanonicalByCode, purchaseCanonicalByCode };
}

async function seedStableIdMaps(pkg) {
  const products = await Product.collection.find(scenarioFilter(), { projection: { _id: 1, sku: 1 } }).toArray();
  const contacts = await Contact.collection.find(scenarioFilter(), { projection: { _id: 1, stableCode: 1 } }).toArray();
  const transactions = await Transaction.collection.find(scenarioFilter(), { projection: { _id: 1, stableCode: 1 } }).toArray();
  pkg.productIds = new Map(products.map((row) => [row.sku, row._id]));
  pkg.productBySku = indexBy(pkg.products, 'sku');
  pkg.supplierByCode = indexBy(pkg.suppliers, 'supplierCode');
  pkg.supplierIds = new Map(contacts.filter((row) => row.stableCode.startsWith('SUP-')).map((row) => [row.stableCode, row._id]));
  pkg.customerIds = new Map(contacts.filter((row) => row.stableCode.startsWith('CLI-')).map((row) => [row.stableCode, row._id]));
  pkg.transactionIds = new Map(transactions.map((row) => [row.stableCode, row._id]));
}

async function upsertAuxiliary(pkg, docs) {
  return writeUpserts(MinimarketV3Record, docs, (row) => stableIdentity('auxiliary', row));
}

async function importPackage({ directory = DEFAULT_DATASET, reset = false, scenarioId = SCENARIO_ID, target = 'local', atlasUri } = {}) {
  if (scenarioId !== SCENARIO_ID || scenarioId.includes('*')) throw new Error('El scenarioId de import/reset debe ser exactamente minimarket-pasco-v3.');
  const pkg = loadPackage(directory);
  const db = mongoose.connection.db;
  assertImportConnection(mongoose.connection, { target, atlasUri });
  if (target === 'atlas' && reset) throw new Error('Atlas reset requiere el comando rollback explícito.');
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.isWritablePrimary || !hello.setName) throw new Error('Importación abortada: Mongo no está en PRIMARY de un replica set.');
  if (target === 'atlas') await require('./minimarketV3Atlas').preflightAtlas(pkg);
  const existingScenario = await HistoricalScenario.collection.findOne({ businessId: BUSINESS_ID, scenarioId: SCENARIO_ID });
  if (reset) await resetScenario();
  else if (existingScenario && existingScenario.sourceSha256 !== pkg.manifest.hashes.logicalDatasetSha256) {
    throw new Error('Ya existe V3 con otro hash; solicita reset exacto minimarket-pasco-v3 antes de reemplazarlo.');
  } else if (!existingScenario) {
    const residue = await Promise.all(RESET_MODELS.map((model) => model.collection.countDocuments(scenarioFilter())));
    if (residue.some(Boolean)) throw new Error('Hay documentos V3 sin control HistoricalScenario; requiere reset exacto y auditado.');
  }
  if (!reset && existingScenario?.status === 'completed' && existingScenario.sourceSha256 === pkg.manifest.hashes.logicalDatasetSha256) {
    const parity = await require('./minimarketV3Parity').verifyParity(pkg);
    if (!parity.pass) throw new Error('Escenario completo no supera paridad; se detuvo sin escrituras.');
    return { alreadyImported: true, businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, logicalSha256: pkg.manifest.hashes.logicalDatasetSha256 };
  }
  const outsideBefore = await collectionCountsOutsideScenario();
  await HistoricalScenario.collection.updateOne(
    { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID },
    { $set: { businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, sourceSha256: pkg.manifest.hashes.logicalDatasetSha256, status: 'importing', importedRecords: 0, failureMessage: null, metadata: { importTarget: target, datasetVersion: pkg.manifest.datasetVersion, seed: pkg.manifest.seed, referenceDate: pkg.manifest.referenceDate, timezone: pkg.manifest.timezone, counts: pkg.manifest.counts, aggregates: pkg.manifest.aggregates } } },
    { upsert: true },
  );
  let importedRecords = 0;
  try {
    const contactDocs = buildContactDocuments(pkg);
    await writeUpserts(Contact, contactDocs, (row) => stableIdentity('contact', row));
    const savedContacts = await Contact.collection.find(scenarioFilter(), { projection: { _id: 1, stableCode: 1, type: 1 } }).toArray();
    const suppliers = new Map(savedContacts.filter((row) => row.type === 'vendor').map((row) => [row.stableCode, row._id]));
    const customers = new Map(savedContacts.filter((row) => row.type === 'customer').map((row) => [row.stableCode, row._id]));
    if (suppliers.size !== pkg.suppliers.length || customers.size !== pkg.customers.length) throw new Error('No se pudieron resolver todas las claves estables de contactos.');
    await seedStableIdMaps(pkg);
    let docs = prepareDocuments(pkg, suppliers, customers);
    await writeUpserts(Product, docs.products, (row) => stableIdentity('product', row));
    await seedStableIdMaps(pkg);
    docs = prepareDocuments(pkg, suppliers, customers);
    await writeUpserts(Transaction, docs.transactions, (row) => stableIdentity('transaction', row));
    await seedStableIdMaps(pkg);
    const resolved = prepareDocuments(pkg, suppliers, customers);
    await writeUpserts(InventoryMovement, resolved.movements, (row) => stableIdentity('movement', row));
    await upsertAuxiliary(pkg, resolved.records);
    importedRecords = contactDocs.length + docs.products.length + docs.transactions.length + resolved.movements.length + resolved.records.length;
    const outsideAfter = await collectionCountsOutsideScenario();
    assertSameCounts(outsideBefore, outsideAfter);
    const { verifyParity } = require('./minimarketV3Parity');
    const parity = await verifyParity(pkg);
    if (!parity.pass) throw new Error(`Paridad falló: ${parity.errors.slice(0, 5).join('; ')}`);
    parity.summary.nonV3CollectionCountsBeforeAfter = { before: outsideBefore, after: outsideAfter };
    await HistoricalScenario.collection.updateOne({ businessId: BUSINESS_ID, scenarioId: SCENARIO_ID }, { $set: { status: 'completed', importedRecords, failureMessage: null, metadata: { importTarget: target, datasetVersion: pkg.manifest.datasetVersion, seed: pkg.manifest.seed, referenceDate: pkg.manifest.referenceDate, timezone: pkg.manifest.timezone, counts: pkg.manifest.counts, aggregates: pkg.manifest.aggregates, parity: parity.summary } } });
    return { alreadyImported: false, businessId: BUSINESS_ID, scenarioId: SCENARIO_ID, importedRecords, logicalSha256: pkg.manifest.hashes.logicalDatasetSha256, parity: parity.summary };
  } catch (error) {
    await HistoricalScenario.collection.updateOne({ businessId: BUSINESS_ID, scenarioId: SCENARIO_ID }, { $set: { status: 'failed', importedRecords, failureMessage: 'Import/parity failed; inspect the sanitized execution report.' } });
    throw error;
  }
}

module.exports = {
  BUSINESS_ID, DATABASE, DEFAULT_DATASET, SCENARIO_ID,
  ATLAS_HOST, assertAtlasMongoUri, assertImportConnection, assertV3Write, assertAtlasRollback,
  RESET_MODELS, assertSameCounts, writeUpserts, prepareDocuments,
  assertLocalMongoUri, buildLocalDockerUri, collectionCountsOutsideScenario,
  auxiliaryStableKey, importPackage, loadPackage, logicalFileSha256, reconcileStock, resetScenario, scenarioFilter, stableIdentity,
};
