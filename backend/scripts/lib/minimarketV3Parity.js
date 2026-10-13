'use strict';

const { BSON } = require('bson');
const { canonicalJson, sha256 } = require('../../../scripts/lib/minimarket-v3-generator');
const { Product, Contact, Transaction, InventoryMovement, HistoricalScenario, MinimarketV3Record } = require('../../src/models');
const { auxiliaryStableKey, BUSINESS_ID, SCENARIO_ID, loadPackage, scenarioFilter } = require('./minimarketV3Mongo');

function logicalHash(rows, keyFn) {
  return sha256(Buffer.from(canonicalJson([...rows].sort((a, b) => keyFn(a).localeCompare(keyFn(b))))));
}
function cents(value) { return Math.round(Number(value || 0) * 100); }
function recordProjection(doc) { return doc.canonicalData; }

async function measureMongo() {
  const db = Product.db.db;
  const fs = require('node:fs');
  const path = require('node:path');
  const collections = {};
  let v3BsonBytes = 0;
  let v3StorageEstimate = 0;
  for (const model of [Product, Contact, Transaction, InventoryMovement, MinimarketV3Record, HistoricalScenario]) {
    const collection = model.collection.collectionName;
    const stats = await db.command({ collStats: collection });
    const docs = await model.collection.find({ businessId: BUSINESS_ID, scenarioId: SCENARIO_ID }).toArray();
    const bsonBytes = docs.reduce((sum, doc) => sum + BSON.calculateObjectSize(doc), 0);
    v3BsonBytes += bsonBytes;
    const storageEstimateBytes = stats.size ? Math.round(stats.storageSize * bsonBytes / stats.size) : 0;
    v3StorageEstimate += storageEstimateBytes;
    collections[collection] = { collectionDocuments: stats.count, dataSize: stats.size, storageSize: stats.storageSize, indexSize: stats.totalIndexSize, v3Documents: docs.length, v3BsonBytes: bsonBytes, v3StorageEstimateBytes: storageEstimateBytes };
    collections[collection].v3BsonBytes = bsonBytes;
  }
  const total = await db.stats();
  const attributedIndexEstimate = Object.values(collections).reduce((sum, row) => sum + (row.collectionDocuments ? row.indexSize * row.v3Documents / row.collectionDocuments : 0), 0);
  return {
    database: total.db, totalDataSize: total.dataSize, totalStorageSize: total.storageSize, totalIndexSize: total.indexSize,
    collections, v3LogicalBsonBytes: v3BsonBytes, v3IndexEstimateBytes: Math.round(attributedIndexEstimate),
    v3StorageEstimateBytes: v3StorageEstimate,
    v3ApproxPhysicalFootprintBytes: v3StorageEstimate + Math.round(attributedIndexEstimate),
    v3ApproxLogicalFootprintBytes: v3BsonBytes + Math.round(attributedIndexEstimate),
    packageBytes: fs.readdirSync(path.resolve(__dirname, '../../../data/minimarket-pasco-v3/generated'))
      .reduce((sum, file) => sum + fs.statSync(path.resolve(__dirname, '../../../data/minimarket-pasco-v3/generated', file)).size, 0),
  };
}

async function verifyParity(pkg = loadPackage()) {
  const filter = scenarioFilter();
  const errors = [];
  const assert = (ok, message) => { if (!ok) errors.push(message); };
  const [products, contacts, transactions, movements, aux, scenario] = await Promise.all([
    Product.collection.find(filter).toArray(), Contact.collection.find(filter).toArray(),
    Transaction.collection.find(filter).toArray(), InventoryMovement.collection.find(filter).toArray(),
    MinimarketV3Record.collection.find(filter).toArray(), HistoricalScenario.collection.findOne(filter),
  ]);
  const productBySku = new Map(products.map((row) => [row.sku, row]));
  const contactById = new Map(contacts.map((row) => [String(row._id), row]));
  const transactionById = new Map(transactions.map((row) => [String(row._id), row]));
  const canonicalContacts = [...pkg.suppliers, ...pkg.customers].sort((a, b) => (a.supplierCode || a.customerCode).localeCompare(b.supplierCode || b.customerCode));
  const linesByTransaction = new Map();
  for (const line of [...pkg.saleItems, ...pkg.purchaseItems]) {
    const code = line.saleCode || line.purchaseCode;
    if (!linesByTransaction.has(code)) linesByTransaction.set(code, []);
    linesByTransaction.get(code).push(line);
  }
  const canonicalTransactions = [
    ...pkg.sales.map((parent) => ({ parent, lines: (linesByTransaction.get(parent.saleCode) || []).sort((a, b) => a.saleLineKey.localeCompare(b.saleLineKey)) })),
    ...pkg.purchases.map((parent) => ({ parent, lines: (linesByTransaction.get(parent.purchaseCode) || []).sort((a, b) => a.purchaseLineKey.localeCompare(b.purchaseLineKey)) })),
  ].sort((a, b) => (a.parent.saleCode || a.parent.purchaseCode).localeCompare(b.parent.saleCode || b.parent.purchaseCode));
  const actualTransactions = transactions.map((row) => row.scenarioData?.canonicalRecord
    ? { parent: row.scenarioData.canonicalRecord, lines: row.scenarioData.canonicalLines }
    : null).filter(Boolean).sort((a, b) => (a.parent.saleCode || a.parent.purchaseCode).localeCompare(b.parent.saleCode || b.parent.purchaseCode));
  const canonicalAux = [
    ...pkg.definitions.categories.categories.map((row) => ({ recordType: 'category', stableKey: row.code, canonicalData: row })),
    ...pkg.promotions.map((row) => ({ recordType: 'promotion', stableKey: row.promotionCode, canonicalData: row })),
    ...pkg.priceHistory.map((row) => ({ recordType: 'price_history', stableKey: auxiliaryStableKey('price_history', row), canonicalData: row })),
    ...pkg.supplierCostHistory.map((row) => ({ recordType: 'supplier_cost_history', stableKey: auxiliaryStableKey('supplier_cost_history', row), canonicalData: row })),
  ];
  const stableRows = (rows, key) => [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  const hashes = {
    products: logicalHash(pkg.products, (row) => row.sku) === logicalHash(products.map(recordProjection), (row) => row.sku),
    contacts: logicalHash(canonicalContacts, (row) => row.supplierCode || row.customerCode) === logicalHash(contacts.map(recordProjection), (row) => row.supplierCode || row.customerCode),
    transactions: logicalHash(canonicalTransactions, (row) => row.parent.saleCode || row.parent.purchaseCode) === logicalHash(actualTransactions, (row) => row.parent.saleCode || row.parent.purchaseCode),
    movements: logicalHash(pkg.movements, (row) => row.movementCode) === logicalHash(movements.map((row) => row.scenarioData), (row) => row.movementCode),
    auxiliary: logicalHash(canonicalAux.map(({ recordType, stableKey, canonicalData }) => ({ recordType, stableKey, canonicalData })), (row) => `${row.recordType}|${row.stableKey}`)
      === logicalHash(aux.map(({ recordType, stableKey, canonicalData }) => ({ recordType, stableKey, canonicalData })), (row) => `${row.recordType}|${row.stableKey}`),
  };
  const expectedAuxByKey = new Map(canonicalAux.map((row) => [`${row.recordType}|${row.stableKey}`, row.canonicalData]));
  const actualAuxByKey = new Map(aux.map((row) => [`${row.recordType}|${row.stableKey}`, row.canonicalData]));
  const auxiliaryParity = { expected: expectedAuxByKey.size, actual: actualAuxByKey.size, mismatches: [] };
  for (const [key, expected] of expectedAuxByKey) {
    if (!actualAuxByKey.has(key) || canonicalJson(actualAuxByKey.get(key)) !== canonicalJson(expected)) auxiliaryParity.mismatches.push(key);
  }
  for (const key of actualAuxByKey.keys()) if (!expectedAuxByKey.has(key)) auxiliaryParity.mismatches.push(`unexpected:${key}`);
  if (auxiliaryParity.mismatches.length) errors.push(`logical auxiliary mismatch: ${auxiliaryParity.mismatches.slice(0, 5).join(',')}`);
  for (const [key, pass] of Object.entries(hashes)) assert(pass, `logical hash mismatch: ${key}`);

  assert(products.length === 80 && productBySku.size === 80, 'product/SKU count mismatch');
  assert(contacts.filter((row) => row.type === 'customer').length === 40, 'registered customer count mismatch');
  assert(contacts.filter((row) => row.type === 'vendor').length === 10, 'supplier count mismatch');
  assert(transactions.filter((row) => row.type === 'sale').length === pkg.sales.length, 'sales ticket count mismatch');
  assert(transactions.filter((row) => row.type === 'purchase').length === pkg.purchases.length, 'purchase count mismatch');
  assert(transactions.reduce((sum, row) => sum + (row.products || []).length, 0) === pkg.saleItems.length + pkg.purchaseItems.length, 'embedded line count mismatch');
  assert(movements.length === pkg.movements.length, 'inventory movement count mismatch');
  assert(aux.length === canonicalAux.length, 'auxiliary logical record count mismatch');
  assert(aux.filter((row) => row.recordType === 'category').length === 10, 'category count mismatch');
  assert(aux.filter((row) => row.recordType === 'promotion').length === pkg.promotions.length, 'promotion count mismatch');
  assert(products.reduce((sum, row) => sum + row.supplierPrices.length, 0) === 103, 'embedded supplier offer count mismatch');

  let orphanProductRefs = 0; let crossTenantRefs = 0;
  for (const product of products) for (const offer of product.supplierPrices || []) {
    const contact = contactById.get(String(offer.supplierId));
    if (!contact) orphanProductRefs += 1;
    else if (contact.businessId !== BUSINESS_ID) crossTenantRefs += 1;
  }
  for (const row of transactions) {
    for (const item of row.products || []) {
      const product = productBySku.get(item.sku);
      if (!product || String(product._id) !== String(item.productId)) orphanProductRefs += 1;
      else if (product.businessId !== row.businessId) crossTenantRefs += 1;
    }
    for (const id of [row.customerId, row.vendorId, row.supplierId].filter(Boolean)) {
      const contact = contactById.get(String(id));
      if (!contact) orphanProductRefs += 1;
      else if (contact.businessId !== row.businessId) crossTenantRefs += 1;
    }
  }
  for (const row of movements) {
    const product = products.find((item) => String(item._id) === String(row.productId));
    if (!product) orphanProductRefs += 1;
    else if (product.businessId !== row.businessId) crossTenantRefs += 1;
    if (row.transactionId && !transactionById.has(String(row.transactionId))) orphanProductRefs += 1;
  }
  const productIds = products.map((row) => row._id);
  const contactIds = contacts.map((row) => row._id);
  const externalProductReferences = await Transaction.collection.countDocuments({ businessId: { $ne: BUSINESS_ID }, 'products.productId': { $in: productIds } });
  const externalContactReferences = await Transaction.collection.countDocuments({ businessId: { $ne: BUSINESS_ID }, $or: [{ customerId: { $in: contactIds } }, { vendorId: { $in: contactIds } }, { supplierId: { $in: contactIds } }] });
  const externalMovementReferences = await InventoryMovement.collection.countDocuments({ businessId: { $ne: BUSINESS_ID }, productId: { $in: productIds } });
  const transactionIds = transactions.map((row) => row._id);
  const externalTransactionMovementReferences = await InventoryMovement.collection.countDocuments({ businessId: { $ne: BUSINESS_ID }, transactionId: { $in: transactionIds } });
  const externalOfferReferences = await Product.collection.countDocuments({ businessId: { $ne: BUSINESS_ID }, 'supplierPrices.supplierId': { $in: contactIds } });
  crossTenantRefs += externalProductReferences + externalContactReferences + externalMovementReferences + externalTransactionMovementReferences + externalOfferReferences;
  assert(orphanProductRefs === 0, `orphan refs=${orphanProductRefs}`);
  assert(crossTenantRefs === 0, `cross-tenant refs=${crossTenantRefs}`);

  const snapshot = new Map(pkg.snapshots.map((row) => [row.sku, row.onHandUsable]));
  const deltaBySku = new Map();
  for (const row of pkg.movements) deltaBySku.set(row.sku, (deltaBySku.get(row.sku) || 0) + row.quantityDelta);
  const stockMismatch = products.filter((row) => row.stock !== snapshot.get(row.sku) || row.stock !== deltaBySku.get(row.sku));
  assert(stockMismatch.length === 0, `closing stock mismatch for ${stockMismatch.length} SKUs`);

  const saleDocs = transactions.filter((row) => row.type === 'sale' && row.status === 'completed');
  const salesRevenueCents = saleDocs.reduce((sum, row) => sum + cents(row.totalAmount), 0);
  const soldUnits = saleDocs.reduce((sum, row) => sum + row.products.reduce((sub, line) => sub + Number(line.unitsSold || 0), 0), 0);
  const cogsCents = saleDocs.reduce((sum, row) => sum + row.products.reduce((sub, line) => sub + Number(line.costCents || 0) * Number(line.unitsSold || 0), 0), 0);
  assert(salesRevenueCents === pkg.manifest.aggregates.revenueCents, 'sales revenue aggregate mismatch');
  assert(soldUnits === pkg.manifest.aggregates.unitsSold, 'units sold aggregate mismatch');
  assert(cogsCents === pkg.manifest.aggregates.cogsCents, 'COGS aggregate mismatch');
  const purchaseDocs = transactions.filter((row) => row.type === 'purchase');
  const purchaseValueCents = purchaseDocs.reduce((sum, row) => sum + cents(row.totalAmount), 0);
  const receivedPurchaseValueCents = purchaseDocs.reduce((sum, row) => sum + row.scenarioData.canonicalLines.reduce((lineSum, line) => lineSum + line.quantityReceived * line.purchasePriceCents, 0), 0);
  const pendingPurchases = purchaseDocs.filter((row) => row.status === 'pending').length;
  assert(pendingPurchases === 29, 'pending purchase count mismatch');
  assert(purchaseDocs.length === 2155, 'purchase logical count mismatch');
  assert(purchaseValueCents === pkg.purchases.reduce((sum, row) => sum + row.totalCostCents, 0), 'purchase total aggregate mismatch');
  assert(receivedPurchaseValueCents === pkg.manifest.aggregates.purchaseValueReceivedCents, 'received purchase value aggregate mismatch');
  const dateRows = transactions.map((row) => row.localDate).filter(Boolean).sort();
  assert(dateRows[0] === '2025-10-13' && dateRows.at(-1) === '2026-10-12', 'operational local date range mismatch');
  const monthlyTotals = {};
  const canonicalMonthlyTotals = {};
  for (const row of pkg.sales.filter((sale) => sale.status === 'completed')) {
    const month = row.localDate.slice(0, 7);
    canonicalMonthlyTotals[month] = (canonicalMonthlyTotals[month] || 0) + row.totalCents;
  }
  for (const row of saleDocs) {
    const month = row.localDate.slice(0, 7);
    monthlyTotals[month] = (monthlyTotals[month] || 0) + cents(row.totalAmount);
  }
  assert(canonicalJson(monthlyTotals) === canonicalJson(canonicalMonthlyTotals), 'monthly revenue totals differ from canonical');
  const categoryBySku = new Map(pkg.products.map((row) => [row.sku, row.categoryCode]));
  const canonicalCategoryTotals = {};
  for (const sale of pkg.sales.filter((row) => row.status === 'completed')) {
    const lines = linesByTransaction.get(sale.saleCode) || [];
    for (const line of lines) {
      const category = categoryBySku.get(line.sku);
      const bucket = canonicalCategoryTotals[category] ||= { revenueCents: 0, unitsSold: 0 };
      bucket.revenueCents += line.lineTotalCents;
      bucket.unitsSold += line.unitsSold;
    }
  }
  const actualCategoryTotals = {};
  for (const sale of saleDocs) for (const line of sale.products) {
    const category = categoryBySku.get(line.sku);
    const bucket = actualCategoryTotals[category] ||= { revenueCents: 0, unitsSold: 0 };
    bucket.revenueCents += cents(line.total);
    bucket.unitsSold += Number(line.unitsSold || 0);
  }
  assert(canonicalJson(actualCategoryTotals) === canonicalJson(canonicalCategoryTotals), 'category revenue/units totals differ from canonical');
  const lowStockCount = products.filter((row) => row.stock <= row.minStockLevel).length;
  const recentPurchases = purchaseDocs.filter((row) => row.localDate >= '2026-10-05' && row.localDate <= '2026-10-12').length;
  const recent30DayPurchases = purchaseDocs.filter((row) => row.localDate >= '2026-09-13' && row.localDate <= '2026-10-12').length;
  const todaySales = saleDocs.filter((row) => row.localDate === '2026-10-12').length;
  const yesterdaySales = saleDocs.filter((row) => row.localDate === '2026-10-11').length;
  const last7Sales = saleDocs.filter((row) => row.localDate >= '2026-10-06' && row.localDate <= '2026-10-12').length;
  const customerTotals = new Map();
  const supplierTotals = new Map();
  for (const row of saleDocs) if (row.customerId) {
    const key = String(row.customerId);
    const prior = customerTotals.get(key) || { tickets: 0, revenueCents: 0 };
    prior.tickets += 1; prior.revenueCents += cents(row.totalAmount); customerTotals.set(key, prior);
  }
  for (const row of purchaseDocs) {
    const key = String(row.vendorId);
    const prior = supplierTotals.get(key) || { purchases: 0, orderedValueCents: 0 };
    prior.purchases += 1; prior.orderedValueCents += cents(row.totalAmount); supplierTotals.set(key, prior);
  }
  const topCustomers = [...customerTotals.entries()].map(([id, totals]) => ({ name: contactById.get(id)?.name, ...totals }))
    .sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 5);
  const topSuppliers = [...supplierTotals.entries()].map(([id, totals]) => ({ name: contactById.get(id)?.name, ...totals }))
    .sort((a, b) => b.orderedValueCents - a.orderedValueCents).slice(0, 5);
  const nonV3CollectionCounts = {};
  for (const model of [Product, Contact, Transaction, InventoryMovement, MinimarketV3Record, HistoricalScenario]) {
    nonV3CollectionCounts[model.collection.collectionName] = await model.collection.countDocuments({ businessId: { $ne: BUSINESS_ID } });
  }
  const sourceScenario = scenario?.sourceSha256 === pkg.manifest.hashes.logicalDatasetSha256 && scenario.status === 'completed';
  assert(sourceScenario || scenario?.status === 'importing', 'HistoricalScenario does not record canonical source');
  const size = await measureMongo();
  return {
    pass: errors.length === 0, errors,
    summary: {
      scenarioId: SCENARIO_ID, businessId: BUSINESS_ID, logicalSha256: pkg.manifest.hashes.logicalDatasetSha256,
      hashParity: hashes, products: products.length, categories: pkg.definitions.categories.categories.length,
      subcategories: pkg.definitions.categories.categories.reduce((sum, category) => sum + category.subcategories.length, 0),
      customers: 40, consumerFinal: 'anonymous_group_not_a_contact', suppliers: 10, offers: 103,
      auxiliaryParity,
      sales: saleDocs.length + transactions.filter((row) => row.type === 'sale' && row.status !== 'completed').length,
      completedSales: saleDocs.length, saleItems: pkg.saleItems.length, purchases: purchaseDocs.length,
      pendingPurchases, purchaseItems: pkg.purchaseItems.length, movements: movements.length,
      revenueCents: salesRevenueCents, unitsSold: soldUnits, cogsCents,
      purchaseValueCents, receivedPurchaseValueCents, stockMismatch: stockMismatch.length, orphanRefs: orphanProductRefs, crossTenantRefs,
      categoryTotals: actualCategoryTotals,
      dateRange: { min: dateRows[0], max: dateRows.at(-1) }, monthlySalesRevenueCents: monthlyTotals,
      querySmokes: { todaySales, yesterdaySales, last7DaysSales: last7Sales, recentPurchases7d: recentPurchases, recentPurchases30d: recent30DayPurchases, lowStockProducts: lowStockCount, topCustomers, topSuppliers, productNameLookup: Boolean(products.find((row) => row.name === pkg.products[0].name)) },
      nonV3CollectionCounts,
      productDailyRowsStoredOperationally: false, mongoSize: size,
    },
  };
}

async function main() {
  const dotenv = require('dotenv');
  const mongoose = require('mongoose');
  const { assertLocalMongoUri, buildLocalDockerUri } = require('./minimarketV3Mongo');
  dotenv.config({ path: require('node:path').resolve(__dirname, '../../.env'), quiet: true });
  const uri = assertLocalMongoUri(buildLocalDockerUri(process.env.MONGODB_URI_DOCKER || ''));
  await mongoose.connect(uri.toString(), { serverSelectionTimeoutMS: 7000, autoIndex: false });
  try {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.name !== 'inventory_billing') throw new Error('Parity abortada: conexión no local.');
    const pkg = loadPackage();
    const result = await verifyParity(pkg);
    console.log(JSON.stringify({ valid: result.pass, errors: result.errors, canonicalLocalParity: result.pass ? 'PASS' : 'FAIL', ...result.summary }, null, 2));
    if (!result.pass) process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { logicalHash, measureMongo, verifyParity };
