'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { canonicalJson, dateRange, loadDefinitions, sha256 } = require('./lib/minimarket-v3-generator');

async function eachRecord(file, callback) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let rowNumber = 0;
  for await (const line of lines) {
    rowNumber += 1;
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch (error) { throw new Error(`${path.basename(file)}:${rowNumber} JSON inválido: ${error.message}`); }
    await callback(record, rowNumber);
  }
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function validateDataset(directory, definitions = loadDefinitions()) {
  const root = path.resolve(directory);
  const errors = [];
  const warnings = [];
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`No existe ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const expectedDailyDates = dateRange(definitions.scenario.historyStart, definitions.scenario.historyEnd);
  const productBySku = new Map(definitions.products.map((product) => [product.sku, product]));
  const supplierCodes = new Set(definitions.suppliers.map((supplier) => supplier.supplierCode));
  const customerCodes = new Set(definitions.customers.map((customer) => customer.customerCode));
  const sales = new Map();
  const saleItemsBySale = new Map();
  const purchases = new Map();
  const purchaseItemsByOrder = new Map();
  const receiptsByOrder = new Map();
  const receivedItemsByOrder = new Map();
  const dailyKeys = new Set();
  const dailyCountBySku = new Map();
  const dailyTotalsBySku = new Map();
  const saleUnitsBySku = new Map();
  const movementStock = new Map();
  const movementTotals = new Map();
  const movementValue = new Map();
  const rowCounts = new Map();
  const uniqueIds = new Map();
  let saleItemRevenueCents = 0;
  let completedUnits = 0;
  let receivedPurchaseValueCents = 0;
  let lostDemand = 0;
  let stockoutProductDays = 0;
  let finalSnapshotCount = 0;
  const snapshotStocks = new Map();
  const snapshotValues = new Map();
  const categoryCodes = new Set(definitions.categories.categories.map((category) => category.code));
  const subcategoryCodes = new Set(definitions.categories.categories.flatMap((category) => category.subcategories.map((subcategory) => subcategory.code)));
  const demandProfileKeys = new Set(definitions.profiles.demandProfiles.map((profile) => profile.key));
  const customerProfileKeys = new Set(definitions.profiles.customerProfiles.map((profile) => profile.key));
  const offerKeys = new Set(definitions.products.map((product) => `${product.sku}|${product.preferredSupplierCode}`));
  for (const offer of definitions.offers.secondaryAssignments) offerKeys.add(`${offer.sku}|${offer.supplierCode}`);

  const require = (condition, message) => { if (!condition) errors.push(message); };
  const checkTenantScenario = (record, label) => {
    if (record.scenarioId != null) require(record.scenarioId === definitions.scenario.scenarioId, `${label}: scenarioId incorrecto`);
    if (record.businessKey != null) require(record.businessKey === 'MINIMARKET-PASCO-V3', `${label}: businessKey incorrecto`);
  };
  const addUnique = (type, id, label) => {
    if (!id) { errors.push(`${label}: id estable vacío`); return; }
    const key = `${type}|${id}`;
    if (uniqueIds.has(key)) errors.push(`${label}: id estable duplicado ${id}`);
    uniqueIds.set(key, true);
  };
  const fileSpecs = [
    ['products.ndjson', async (row) => {
      checkTenantScenario(row, `product ${row.sku}`);
      require(productBySku.get(row.sku)?.productKey === row.productKey, `product master ${row.sku}: SKU/productKey inválido`);
      require(categoryCodes.has(row.categoryCode) && subcategoryCodes.has(row.subcategoryCode), `product ${row.sku}: categoría/subcategoría inválida`);
      require(demandProfileKeys.has(row.demandProfileKey), `product ${row.sku}: demand profile inválido`);
      require(Number.isInteger(row.endingStock) && row.endingStock >= 0, `product ${row.sku}: stock final inválido`);
    }],
    ['categories.ndjson', async (row) => {
      require(categoryCodes.has(row.code), `category ${row.code}: desconocida`);
    }],
    ['suppliers.ndjson', async (row) => {
      checkTenantScenario(row, `supplier ${row.supplierCode}`);
      require(supplierCodes.has(row.supplierCode), `supplier ${row.supplierCode}: desconocido`);
    }],
    ['customers.ndjson', async (row) => {
      checkTenantScenario(row, `customer ${row.customerCode}`);
      require(customerCodes.has(row.customerCode), `customer ${row.customerCode}: desconocido`);
      require(customerProfileKeys.has(row.customerProfileKey), `customer ${row.customerCode}: perfil inválido`);
    }],
    ['sales.ndjson', async (row) => {
      checkTenantScenario(row, `sale ${row.saleCode}`);
      addUnique('sale', row.saleCode, 'sale');
      addUnique('sourceEvent', row.sourceEventId, 'sale sourceEventId');
      require(['completed', 'cancelled', 'pending'].includes(row.status), `sale ${row.saleCode}: status inválido`);
      require(expectedDailyDates.includes(row.localDate), `sale ${row.saleCode}: fecha fuera del rango`);
      const utc = new Date(row.occurredAt);
      utc.setUTCHours(utc.getUTCHours() - 5);
      require(utc.toISOString().slice(0, 10) === row.localDate, `sale ${row.saleCode}: timestamp UTC no coincide con fecha Lima declarada`);
      require(row.totalCents === row.subtotalAfterDiscountCents, `sale ${row.saleCode}: total/subtotal no concuerda`);
      if (row.customerCode != null) require(customerCodes.has(row.customerCode), `sale ${row.saleCode}: cliente desconocido`);
      sales.set(row.saleCode, row);
    }],
    ['sale-items.ndjson', async (row) => {
      checkTenantScenario(row, `sale item ${row.saleCode}`);
      addUnique('saleLine', row.saleLineKey, 'saleLineKey');
      addUnique('sourceEvent', row.sourceEventId, 'sale line sourceEventId');
      const product = productBySku.get(row.sku);
      require(Boolean(product) && product.productKey === row.productKey, `sale item ${row.saleCode}/${row.sku}: producto inválido`);
      const sale = sales.get(row.saleCode);
      require(Boolean(sale), `sale item sin venta ${row.saleCode}`);
      require(row.transactionStatus === sale?.status, `sale item ${row.saleCode}: status no coincide`);
      require(Number.isInteger(row.quantity) && row.quantity >= 0, `sale item ${row.saleCode}/${row.sku}: quantity inválida`);
      require(Number.isInteger(row.unitsSold) && row.unitsSold >= 0, `sale item ${row.saleCode}/${row.sku}: unitsSold inválida`);
      const billableQuantity = sale?.status === 'completed' ? row.unitsSold : row.quantity;
      require(row.lineTotalCents === row.effectiveUnitPriceCents * billableQuantity, `sale item ${row.saleCode}/${row.sku}: total de línea inválido`);
      require(row.lineDiscountCents === (row.baseUnitPriceCents - row.effectiveUnitPriceCents) * (sale?.status === 'completed' ? row.unitsSold : row.quantity), `sale item ${row.saleCode}/${row.sku}: descuento inválido`);
      const group = saleItemsBySale.get(row.saleCode) ?? { count: 0, totalCents: 0, units: 0 };
      group.count += 1;
      group.totalCents += row.lineTotalCents;
      group.units += row.unitsSold;
      saleItemsBySale.set(row.saleCode, group);
      if (sale?.status === 'completed') {
        saleItemRevenueCents += row.lineTotalCents;
        completedUnits += row.unitsSold;
        saleUnitsBySku.set(row.sku, (saleUnitsBySku.get(row.sku) ?? 0) + row.unitsSold);
      }
    }],
    ['purchases.ndjson', async (row) => {
      checkTenantScenario(row, `purchase ${row.purchaseCode}`);
      addUnique('purchase', row.purchaseCode, 'purchase');
      addUnique('sourceEvent', row.sourceEventId, 'purchase sourceEventId');
      require(supplierCodes.has(row.supplierCode), `purchase ${row.purchaseCode}: proveedor desconocido`);
      require(row.orderedLocalDate <= row.promisedLocalDate, `purchase ${row.purchaseCode}: expectedAt precede order`);
      if (row.receivedLocalDate) require(row.receivedLocalDate >= row.promisedLocalDate && row.receivedLocalDate >= row.orderedLocalDate, `purchase ${row.purchaseCode}: receipt date inválida`);
      purchases.set(row.purchaseCode, row);
    }],
    ['purchase-items.ndjson', async (row) => {
      checkTenantScenario(row, `purchase item ${row.purchaseCode}`);
      addUnique('purchaseLine', row.purchaseLineKey, 'purchaseLineKey');
      addUnique('sourceEvent', row.sourceEventId, 'purchase line sourceEventId');
      require(productBySku.has(row.sku) && productBySku.get(row.sku).productKey === row.productKey, `purchase item ${row.purchaseCode}/${row.sku}: producto inválido`);
      require(supplierCodes.has(row.supplierCode), `purchase item ${row.purchaseCode}/${row.sku}: proveedor desconocido`);
      require(purchases.get(row.purchaseCode)?.supplierCode === row.supplierCode, `purchase item ${row.purchaseCode}/${row.sku}: proveedor no coincide con la orden`);
      require(offerKeys.has(`${row.sku}|${row.supplierCode}`), `purchase item ${row.purchaseCode}/${row.sku}: no existe supplier offer`);
      require(purchases.has(row.purchaseCode), `purchase item huérfano ${row.purchaseCode}`);
      require(Number.isInteger(row.quantityOrdered) && row.quantityOrdered > 0, `purchase item ${row.purchaseCode}/${row.sku}: quantityOrdered inválida`);
      require(Number.isInteger(row.quantityReceived) && row.quantityReceived >= 0 && row.quantityReceived <= row.quantityOrdered, `purchase item ${row.purchaseCode}/${row.sku}: quantityReceived inválida`);
      require(row.lineTotalCents === row.quantityOrdered * row.purchasePriceCents, `purchase item ${row.purchaseCode}/${row.sku}: total de línea inválido`);
      if (row.receivedAt) require(row.receivedAt >= row.orderedAt && row.receivedAt >= row.promisedAt, `purchase item ${row.purchaseCode}/${row.sku}: receipt timestamp inválido`);
      const group = purchaseItemsByOrder.get(row.purchaseCode) ?? { count: 0, totalCents: 0 };
      group.count += 1; group.totalCents += row.lineTotalCents;
      purchaseItemsByOrder.set(row.purchaseCode, group);
      receivedItemsByOrder.set(row.purchaseCode, (receivedItemsByOrder.get(row.purchaseCode) ?? 0) + row.quantityReceived);
      if (row.quantityReceived > 0) receivedPurchaseValueCents += row.quantityReceived * row.purchasePriceCents;
    }],
    ['inventory-movements.ndjson', async (row) => {
      checkTenantScenario(row, `movement ${row.movementCode}`);
      addUnique('movement', row.movementCode, 'movement');
      addUnique('sourceEvent', row.sourceEventId, 'movement sourceEventId');
      require(productBySku.has(row.sku) && productBySku.get(row.sku).productKey === row.productKey, `movement ${row.movementCode}: producto inválido`);
      require(Number.isInteger(row.quantityDelta) && Number.isInteger(row.stockBefore) && Number.isInteger(row.stockAfter), `movement ${row.movementCode}: stock/cantidad no enteros`);
      require(Number.isInteger(row.unitCostCents) && Number.isInteger(row.valueDeltaCents), `movement ${row.movementCode}: costo/valor inválido`);
      require(row.stockBefore === (movementStock.get(row.sku) ?? 0), `movement ${row.movementCode}: ledger discontinuo`);
      require(row.stockAfter === row.stockBefore + row.quantityDelta && row.stockAfter >= 0, `movement ${row.movementCode}: stock negativo o balance inválido`);
      if (row.type === 'valuation_adjustment') {
        require(row.quantityDelta === 0 && row.reason === 'moving_average_rounding', `movement ${row.movementCode}: ajuste de valuación inválido`);
        require(sales.get(row.transactionCode)?.status === 'completed', `movement ${row.movementCode}: ajuste sin venta completada`);
      } else require(row.valueDeltaCents === row.quantityDelta * row.unitCostCents, `movement ${row.movementCode}: valor no coincide con cantidad/costo`);
      if (row.type === 'sale') require(sales.get(row.transactionCode)?.status === 'completed', `movement ${row.movementCode}: venta referenciada no completada`);
      if (row.type === 'purchase_receipt') require(purchases.has(row.transactionCode), `movement ${row.movementCode}: compra recibida inexistente`);
      movementStock.set(row.sku, row.stockAfter);
      movementTotals.set(row.sku, (movementTotals.get(row.sku) ?? 0) + row.quantityDelta);
      movementValue.set(row.sku, (movementValue.get(row.sku) ?? 0) + row.valueDeltaCents);
      if (row.type === 'purchase_receipt') receiptsByOrder.set(row.transactionCode, (receiptsByOrder.get(row.transactionCode) ?? 0) + row.quantityDelta);
    }],
    ['product-daily.ndjson', async (row) => {
      checkTenantScenario(row, `daily ${row.sku}/${row.localDate}`);
      require(productBySku.has(row.sku) && productBySku.get(row.sku).productKey === row.productKey, `daily row ${row.sku}: producto inválido`);
      const key = `${row.scenarioId}|${row.sku}|${row.localDate}`;
      require(row.dailyRowKey === key, `daily row ${key}: dailyRowKey incorrecta`);
      require(!dailyKeys.has(key), `daily key duplicada ${key}`);
      dailyKeys.add(key);
      dailyCountBySku.set(row.sku, (dailyCountBySku.get(row.sku) ?? 0) + 1);
      dailyTotalsBySku.set(row.sku, (dailyTotalsBySku.get(row.sku) ?? 0) + row.unitsSold);
      require(expectedDailyDates.includes(row.localDate), `daily row ${key}: fuera del periodo`);
      require(Number.isInteger(row.unitsSold) && row.unitsSold >= 0 && Number.isInteger(row.unitsDemandedSynthetic) && row.unitsDemandedSynthetic >= row.unitsSold, `daily row ${key}: demanda/unidades inválidas`);
      require(row.lostDemandSynthetic === row.unitsDemandedSynthetic - row.unitsSold, `daily row ${key}: lost demand incoherente`);
      require(Number.isInteger(row.onHandUsableAtOrigin) && row.onHandUsableAtOrigin >= 0, `daily row ${key}: stock al origen inválido`);
      require(Number.isInteger(row.knownInboundAtOrigin) && row.knownInboundAtOrigin >= 0, `daily row ${key}: inbound inválido`);
      require(Number.isFinite(row.availableHours) && row.availableHours >= 0 && row.availableHours <= 15, `daily row ${key}: availableHours inválido`);
      require(!Object.hasOwn(row, 'unitsDemanded') && !Object.hasOwn(row, 'futureSales'), `daily row ${key}: feature con leakage`);
      lostDemand += row.lostDemandSynthetic;
      if (row.stockoutFlag) stockoutProductDays += 1;
    }],
    ['inventory-snapshot.ndjson', async (row) => {
      finalSnapshotCount += 1;
      checkTenantScenario(row, `inventory snapshot ${row.sku}`);
      require(row.snapshotLocalDate === definitions.scenario.historyEnd, `inventory snapshot ${row.sku}: fecha final incorrecta`);
      require(productBySku.has(row.sku), `inventory snapshot ${row.sku}: producto desconocido`);
      require(Number.isInteger(row.onHandUsable) && row.onHandUsable >= 0, `inventory snapshot ${row.sku}: stock inválido`);
      snapshotStocks.set(row.sku, row.onHandUsable);
      snapshotValues.set(row.sku, row.inventoryValueCents);
    }],
    ['promotions.ndjson', async (row) => {
      addUnique('promotion', row.promotionCode, 'promotion');
      require(row.startDate <= row.endDate, `promotion ${row.promotionCode}: rango inválido`);
      require(row.discountPct >= 5 && row.discountPct <= 15, `promotion ${row.promotionCode}: descuento fuera del rango definido`);
      for (const sku of row.skus) require(productBySku.has(sku), `promotion ${row.promotionCode}: SKU desconocido ${sku}`);
    }],
    ['price-history.ndjson', async (row) => {
      require(productBySku.has(row.sku), `price history: SKU desconocido ${row.sku}`);
      require(row.priorPriceCents > 0 && row.priceCents >= row.priorPriceCents, `price history ${row.sku}: cambio inválido`);
      require(row.announcedAt <= row.effectiveFrom, `price history ${row.sku}: precio no anunciado`);
    }],
    ['supplier-cost-history.ndjson', async (row) => {
      require(productBySku.has(row.sku) && supplierCodes.has(row.supplierCode), `supplier cost history: referencia inválida ${row.sku}/${row.supplierCode}`);
      require(offerKeys.has(`${row.sku}|${row.supplierCode}`), `supplier cost history: offer inexistente ${row.sku}/${row.supplierCode}`);
      require(row.priorCostCents > 0 && row.purchaseCostCents >= row.priorCostCents, `supplier cost history ${row.sku}: cambio inválido`);
      require(row.announcedAt <= row.effectiveFrom, `supplier cost history ${row.sku}: costo no anunciado`);
    }],
    ['calendar.ndjson', async (row) => {
      require(expectedDailyDates.includes(row.localDate), `calendar: fecha fuera de periodo ${row.localDate}`);
      require(Number.isInteger(row.arrivedTickets) && row.arrivedTickets >= 0, `calendar ${row.localDate}: arrivedTickets inválido`);
    }],
  ];

  for (const [fileName, check] of fileSpecs) {
    const file = path.join(root, fileName);
    if (!fs.existsSync(file)) { errors.push(`Falta archivo requerido ${fileName}`); continue; }
    let count = 0;
    await eachRecord(file, async (record) => { count += 1; await check(record); });
    rowCounts.set(fileName, count);
  }

  for (const [saleCode, sale] of sales) {
    const items = saleItemsBySale.get(saleCode);
    require(Boolean(items), `sale ${saleCode}: no tiene líneas`);
    if (items) {
      require(items.count === sale.lineCount, `sale ${saleCode}: lineCount no coincide`);
      require(items.totalCents === sale.totalCents, `sale ${saleCode}: total no coincide con líneas`);
    }
  }
  for (const [purchaseCode, purchase] of purchases) {
    const items = purchaseItemsByOrder.get(purchaseCode);
    require(Boolean(items), `purchase ${purchaseCode}: no tiene líneas`);
    if (items) {
      require(items.count === purchase.itemCount, `purchase ${purchaseCode}: itemCount no coincide`);
      require(items.totalCents === purchase.totalCostCents, `purchase ${purchaseCode}: total no coincide con líneas`);
    }
    require((receivedItemsByOrder.get(purchaseCode) ?? 0) === (receiptsByOrder.get(purchaseCode) ?? 0), `purchase ${purchaseCode}: unidades recibidas no coinciden con movimientos`);
  }
  for (const [sku, product] of productBySku) {
    require(dailyCountBySku.get(sku) === expectedDailyDates.length, `${sku}: no tiene 365 daily rows`);
    const closing = snapshotStocks.get(sku);
    require(closing === movementStock.get(sku), `${sku}: snapshot final no coincide con ledger`);
    require(closing === (movementTotals.get(sku) ?? 0), `${sku}: stock final no coincide con suma de movimientos`);
    require(snapshotValues.get(sku) === (movementValue.get(sku) ?? 0), `${sku}: valor final no coincide con ledger valorizado`);
    require(dailyTotalsBySku.get(sku) === (saleUnitsBySku.get(sku) ?? 0), `${sku}: unidades daily no coinciden con líneas de venta`);
  }
  require(rowCounts.get('product-daily.ndjson') === definitions.dailyContract.expectedRows, 'product-daily rows no coincide con contrato');
  require(manifest.counts.products === definitions.products.length, 'manifest products incorrecto');
  require(rowCounts.get('products.ndjson') === manifest.counts.products, 'manifest products no coincide con archivo');
  require(rowCounts.get('categories.ndjson') === manifest.counts.categories, 'manifest categories no coincide con archivo');
  require(rowCounts.get('suppliers.ndjson') === manifest.counts.suppliers, 'manifest suppliers no coincide con archivo');
  require(rowCounts.get('customers.ndjson') === manifest.counts.customers, 'manifest customers no coincide con archivo');
  require(manifest.counts.sales === sales.size, 'manifest sales incorrecto');
  require(manifest.counts.completedSales === [...sales.values()].filter((sale) => sale.status === 'completed').length, 'manifest completedSales incorrecto');
  require(manifest.counts.saleItems === rowCounts.get('sale-items.ndjson'), 'manifest saleItems incorrecto');
  require(manifest.counts.purchases === purchases.size, 'manifest purchases incorrecto');
  require(manifest.counts.purchaseItems === rowCounts.get('purchase-items.ndjson'), 'manifest purchaseItems incorrecto');
  require(manifest.counts.movements === rowCounts.get('inventory-movements.ndjson'), 'manifest movements incorrecto');
  require(manifest.counts.productDailyRows === rowCounts.get('product-daily.ndjson'), 'manifest productDailyRows incorrecto');
  require(manifest.counts.inventorySnapshotRows === finalSnapshotCount, 'manifest inventorySnapshotRows incorrecto');
  require(manifest.counts.promotions === rowCounts.get('promotions.ndjson'), 'manifest promotions incorrecto');
  require(manifest.counts.priceChanges === rowCounts.get('price-history.ndjson'), 'manifest priceChanges incorrecto');
  require(manifest.counts.supplierCostChanges === rowCounts.get('supplier-cost-history.ndjson'), 'manifest supplierCostChanges incorrecto');
  require(finalSnapshotCount === definitions.products.length, 'inventory snapshot no tiene 80 productos');
  require(manifest.aggregates.unitsSold === completedUnits, 'manifest unitsSold no coincide con ventas');
  require(manifest.aggregates.revenueCents === saleItemRevenueCents, 'manifest revenueCents no coincide con líneas');
  require(manifest.aggregates.lostDemandSynthetic === lostDemand, 'manifest lostDemand no coincide con daily rows');
  require(manifest.aggregates.purchaseValueReceivedCents === receivedPurchaseValueCents, 'manifest purchaseValue no coincide con recepciones');
  require(manifest.aggregates.stockoutProductDayPct <= 5, 'stockout product-day excede 5%');
  require(manifest.dateRange.historyStart === definitions.scenario.historyStart && manifest.dateRange.historyEnd === definitions.scenario.historyEnd, 'manifest date range incorrecto');
  require(manifest.seed === definitions.scenario.seed && manifest.scenarioId === definitions.scenario.scenarioId, 'manifest scenario/seed incorrecto');
  require(manifest.timezone === 'America/Lima', 'manifest timezone incorrecta');
  require(/^[a-f0-9]{64}$/.test(manifest.configSha256 ?? ''), 'manifest configSha256 inválido');
  require(/^\d{4}-\d\d-\d\dT/.test(manifest.generatedAt ?? ''), 'manifest generatedAt inválido');
  require(manifest.integrity.orphanReferences === 0 && manifest.integrity.crossTenantReferences === 0 && manifest.integrity.duplicateStableKeys === 0 && manifest.integrity.invalidStockBalances === 0, 'manifest integrity no está en cero');

  const fileHashes = {};
  for (const [relative, expectedHash] of Object.entries(manifest.hashes.files ?? {})) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) { errors.push(`Hash referencia archivo ausente ${relative}`); continue; }
    const actualHash = await hashFile(file);
    fileHashes[relative] = actualHash;
    require(actualHash === expectedHash, `hash incorrecto ${relative}`);
  }
  require(sha256(Buffer.from(canonicalJson(fileHashes))) === manifest.hashes.logicalDatasetSha256, 'logicalDatasetSha256 no coincide con los archivos');
  const expectedManifestBytes = fs.readFileSync(manifestFile);
  require(expectedManifestBytes.toString('utf8').endsWith('\n'), 'manifest no termina con LF UTF-8');
  if (stockoutProductDays > 0) warnings.push(`${stockoutProductDays} product-days con demanda latente no satisfecha; es truth sintético y no venta real perdida.`);
  if (errors.length) return { valid: false, errors, warnings, counts: Object.fromEntries(rowCounts), measured: { completedUnits, saleItemRevenueCents, receivedPurchaseValueCents, lostDemand, stockoutProductDays } };
  return {
    valid: true,
    errors,
    warnings,
    counts: Object.fromEntries(rowCounts),
    measured: { completedUnits, saleItemRevenueCents, receivedPurchaseValueCents, lostDemand, stockoutProductDays, finalSnapshotCount },
    logicalDatasetSha256: manifest.hashes.logicalDatasetSha256,
    manifest,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf('--directory');
  const directory = dirIndex >= 0 ? args[dirIndex + 1] : path.join(__dirname, '../data/minimarket-pasco-v3/generated');
  const result = await validateDataset(directory);
  console.log(JSON.stringify({ valid: result.valid, errors: result.errors, warnings: result.warnings, counts: result.counts, measured: result.measured, logicalDatasetSha256: result.logicalDatasetSha256 }, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { validateDataset };
