'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.resolve(__dirname, '../data/minimarket-pasco-v3');

function commercialPresentationKey(product) {
  const normalize = (value) => String(value ?? '')
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('es-PE')
    .replace(/\s+/g, ' ');
  return [
    product.brand,
    product.name,
    product.presentation,
    product.sizeValue,
    product.sizeUnit,
    product.unit,
    product.containedUnits,
  ].map(normalize).join('|');
}

function validateDefinitions(definitions) {
  const errors = [];
  const { scenario, categories, products, suppliers, offers, customers, profiles, simulation, forecast, promotions, stableKeys } = definitions;
  const add = (condition, message) => { if (!condition) errors.push(message); };
  const unique = (items, key, label) => {
    const seen = new Set();
    for (const item of items) {
      const value = String(item?.[key] ?? '').normalize('NFC').trim().toLocaleLowerCase('es-PE');
      add(Boolean(value), `${label} vacío`);
      add(!seen.has(value), `${label} duplicado: ${value}`);
      seen.add(value);
    }
  };
  const categoryByCode = new Map((categories?.categories ?? []).map((category) => [category.code, category]));
  const subcategoryByCode = new Map((categories?.categories ?? []).flatMap((category) =>
    (category.subcategories ?? []).map((subcategory) => [subcategory.code, { ...subcategory, categoryCode: category.code }])));
  const supplierByCode = new Map((suppliers?.suppliers ?? []).map((supplier) => [supplier.supplierCode, supplier]));
  const productBySku = new Map((products?.catalog ?? []).map((product) => [product.sku, product]));
  const demandKeys = new Set((profiles?.demandProfiles ?? []).map((profile) => profile.key));
  const customerProfileKeys = new Set((profiles?.customerProfiles ?? []).map((profile) => profile.key));
  const associationKeys = new Set((profiles?.associationProfiles ?? []).map((profile) => profile.key));

  add(scenario?.scenarioId === 'minimarket-pasco-v3', 'scenarioId inválido');
  add(scenario?.scenarioVersion === '3.0.0', 'scenarioVersion inválida');
  add(scenario?.datasetVersion === 'minimarket-pasco-v3-seed2026-v1', 'datasetVersion inválida');
  add(scenario?.seed === 2026, 'seed inválida');
  add(scenario?.referenceDate === '2026-10-12' && scenario?.historyStart === '2025-10-13' && scenario?.historyEnd === '2026-10-12', 'rango de fechas del escenario inválido');
  add(scenario?.timezone === 'America/Lima' && scenario?.currency === 'PEN' && scenario?.country === 'PE' && scenario?.region === 'Pasco' && scenario?.city === 'Cerro de Pasco', 'geografía/moneda del escenario inválida');
  add(scenario?.definitionsOnly === true && scenario?.transactionsGenerated === false && scenario?.mongoLoaded === false && scenario?.modelTrained === false, 'M6.2 debe contener definiciones sin transacciones, Mongo ni entrenamiento');

  const historyStart = Date.parse(`${scenario?.historyStart}T00:00:00Z`);
  const historyEnd = Date.parse(`${scenario?.historyEnd}T00:00:00Z`);
  const inclusiveDays = (historyEnd - historyStart) / 86400000 + 1;
  add(Number.isInteger(inclusiveDays) && inclusiveDays === 365, 'el rango histórico debe contener 365 días inclusive');
  add(simulation?.generationEnabled === false && simulation?.generateTransactionsInM62 === false, 'generación masiva debe permanecer deshabilitada en M6.2');
  add(simulation?.seed === scenario?.seed && simulation?.referenceDate === scenario?.referenceDate && simulation?.historyStart === scenario?.historyStart && simulation?.historyEnd === scenario?.historyEnd, 'simulation-config no coincide con scenario');
  add(simulation?.volume?.dailyProductRows === 29200 && forecast?.expectedRows === 29200, 'contrato diario debe anticipar exactamente 80 × 365 filas');
  add(scenario?.consumerFinal?.customerCode === null && scenario?.consumerFinal?.customerKey === null && scenario?.consumerFinal?.materializeContact === false && scenario?.consumerFinal?.transactionProjection?.customerId === null, 'consumidor final debe permanecer como grupo anónimo, no contacto');
  add(scenario?.consumerFinal?.targetCompletedTicketSharePct === 80, 'participación objetivo de consumidor final debe ser 80%');

  const catalog = products?.catalog ?? [];
  const categoryRows = categories?.categories ?? [];
  const subcategoryRows = categoryRows.flatMap((category) => category.subcategories ?? []);
  const supplierRows = suppliers?.suppliers ?? [];
  const customerRows = customers?.customers ?? [];
  add(catalog.length === 80, `se esperaban 80 productos, se recibieron ${catalog.length}`);
  add(categoryRows.length === 10, `se esperaban 10 categorías, se recibieron ${categoryRows.length}`);
  add(subcategoryRows.length === 42, `se esperaban 42 subcategorías, se recibieron ${subcategoryRows.length}`);
  add(supplierRows.length === 10, `se esperaban 10 proveedores, se recibieron ${supplierRows.length}`);
  add(customerRows.length === 40, `se esperaban 40 clientes, se recibieron ${customerRows.length}`);
  add(scenario?.counts?.products === catalog.length && scenario?.counts?.categories === categoryRows.length && scenario?.counts?.subcategories === subcategoryRows.length && scenario?.counts?.suppliers === supplierRows.length && scenario?.counts?.registeredCustomers === customerRows.length, 'counts de scenario no coinciden con definiciones');

  unique(catalog, 'sku', 'SKU');
  unique(catalog, 'productKey', 'productKey');
  unique(categoryRows, 'code', 'categoryCode');
  unique(subcategoryRows, 'code', 'subcategoryCode');
  unique(categoryRows, 'name', 'nombre de categoría');
  unique(subcategoryRows.map((row) => ({ ...row, name: `${row.parentCode}|${row.name}` })), 'name', 'nombre de subcategoría por categoría');
  unique(supplierRows, 'supplierCode', 'supplierCode');
  unique(customerRows, 'customerCode', 'customerCode');
  unique(customerRows, 'displayName', 'nombre de cliente');
  unique(supplierRows, 'displayName', 'nombre visible de proveedor');

  const presentationKeys = new Set();
  for (const product of catalog) {
    add(product.productKey === `v3.${product.sku}`, `productKey no corresponde al SKU: ${product.sku}`);
    add(/^[A-Z]{3}-[A-Z]{3}-\d{3}$/.test(product.sku ?? ''), `SKU fuera del formato estable: ${product.sku}`);
    add(Boolean(product.brand?.trim() && product.name?.trim() && product.presentation?.trim()), `falta identidad comercial/presentación: ${product.sku}`);
    add(product.name?.includes(product.sizeValue) || product.name?.toLocaleLowerCase('es-PE').includes(product.sizeUnit), `el nombre visible no distingue tamaño/presentación: ${product.sku}`);
    const presentationKey = commercialPresentationKey(product);
    add(!presentationKeys.has(presentationKey), `presentación comercial duplicada en otro SKU: ${product.sku}`);
    presentationKeys.add(presentationKey);
    const category = categoryByCode.get(product.categoryCode);
    const subcategory = subcategoryByCode.get(product.subcategoryCode);
    add(Boolean(category), `categoría inexistente en ${product.sku}: ${product.categoryCode}`);
    add(Boolean(subcategory) && subcategory.categoryCode === product.categoryCode, `subcategoría inexistente o de otra categoría en ${product.sku}: ${product.subcategoryCode}`);
    add(Number.isFinite(product.salePriceDemo) && product.salePriceDemo > 0, `salePriceDemo inválido en ${product.sku}`);
    add(Number.isFinite(product.purchaseCostDemo) && product.purchaseCostDemo > 0, `purchaseCostDemo inválido en ${product.sku}`);
    add(product.salePriceDemo > product.purchaseCostDemo, `costo no menor que precio de venta en ${product.sku}`);
    add(product.currency === scenario?.currency, `moneda incorrecta en ${product.sku}`);
    add(Number.isInteger(product.minStockInitial) && product.minStockInitial >= 0, `minStock inválido en ${product.sku}`);
    add(Number.isInteger(product.safetyStockInitial) && product.safetyStockInitial >= 0, `safetyStock inválido en ${product.sku}`);
    add(Number.isInteger(product.reorderPointInitial) && product.reorderPointInitial >= product.safetyStockInitial, `reorderPoint debe ser >= safetyStock en ${product.sku}`);
    add(Number.isFinite(product.baseUnitsPerDay) && product.baseUnitsPerDay > 0, `demanda base inválida en ${product.sku}`);
    add(Number.isFinite(product.baseWeightPrior) && product.baseWeightPrior > 0, `baseWeightPrior inválido en ${product.sku}`);
    add(Number.isInteger(product.leadTimeDays) && product.leadTimeDays > 0, `leadTimeDays inválido en ${product.sku}`);
    add(demandKeys.has(product.demandProfileKey), `demandProfile inexistente en ${product.sku}`);
    add(product.associationProfileKey == null || associationKeys.has(product.associationProfileKey), `associationProfile inexistente en ${product.sku}`);
    add(supplierByCode.has(product.preferredSupplierCode), `proveedor preferido inexistente en ${product.sku}`);
    add(supplierByCode.get(product.preferredSupplierCode)?.active === true, `proveedor preferido inactivo en ${product.sku}`);
    add(product.verificationStatus === 'verified_reference' || product.verificationStatus === 'pending_presentation_verification' || product.verificationStatus === 'generic_demo', `verificationStatus desconocido en ${product.sku}`);
    const grossMarginPct = 100 * (product.salePriceDemo - product.purchaseCostDemo) / product.salePriceDemo;
    add(grossMarginPct > 0 && grossMarginPct < 80, `margen demo absurdo en ${product.sku}`);
    add(product.reorderPointInitial <= Math.ceil(product.baseUnitsPerDay * (product.leadTimeDays + 30) + product.safetyStockInitial), `reorderPoint desproporcionado en ${product.sku}`);
  }

  const offerRows = [];
  for (const product of catalog) {
    offerRows.push({ sku: product.sku, supplierCode: product.preferredSupplierCode, purchasePrice: product.purchaseCostDemo, active: supplierByCode.get(product.preferredSupplierCode)?.active === true, preferred: true, leadTimeDays: product.leadTimeDays });
  }
  for (const assignment of offers?.secondaryAssignments ?? []) {
    const product = productBySku.get(assignment.sku);
    const cents = Math.round((product?.purchaseCostDemo ?? 0) * 100 * assignment.priceFactor);
    offerRows.push({ sku: assignment.sku, supplierCode: assignment.supplierCode, purchasePrice: cents / 100, active: true, preferred: false, leadTimeDays: supplierByCode.get(assignment.supplierCode)?.leadTimeMeanDays });
  }
  const offerKeys = new Set();
  for (const offer of offerRows) {
    const key = `${offer.sku}|${offer.supplierCode}`;
    add(productBySku.has(offer.sku), `oferta referencia SKU inexistente: ${offer.sku}`);
    add(supplierByCode.has(offer.supplierCode), `oferta referencia proveedor inexistente: ${offer.supplierCode}`);
    add(supplierByCode.get(offer.supplierCode)?.active === true || offer.active !== true, `oferta activa de proveedor inactivo: ${key}`);
    add(!offerKeys.has(key), `oferta duplicada: ${key}`);
    offerKeys.add(key);
    add(Number.isFinite(offer.purchasePrice) && offer.purchasePrice > 0, `precio de oferta inválido: ${key}`);
    add(offer.purchasePrice < (productBySku.get(offer.sku)?.salePriceDemo ?? 0), `costo de oferta sin margen bruto positivo: ${key}`);
  }
  for (const product of catalog) {
    const productOffers = offerRows.filter((offer) => offer.sku === product.sku && offer.active);
    const preferred = productOffers.filter((offer) => offer.preferred && offer.supplierCode === product.preferredSupplierCode);
    add(productOffers.length >= 1, `producto sin proveedor activo: ${product.sku}`);
    add(preferred.length === 1, `producto debe tener exactamente una oferta preferida activa: ${product.sku}`);
  }
  for (const assignment of offers?.secondaryAssignments ?? []) {
    add(productBySku.has(assignment.sku), `asignación secundaria SKU inexistente: ${assignment.sku}`);
    add(supplierByCode.has(assignment.supplierCode), `asignación secundaria proveedor inexistente: ${assignment.supplierCode}`);
    add(Number.isFinite(assignment.priceFactor) && assignment.priceFactor > 0, `factor de precio inválido: ${assignment.sku}`);
    add(productBySku.get(assignment.sku)?.preferredSupplierCode !== assignment.supplierCode, `proveedor alternativo coincide con preferido: ${assignment.sku}`);
  }

  for (const supplier of supplierRows) {
    add(/^sup\d+@pasco-demo\.example\.com$/i.test(supplier.emailDemo ?? ''), `email no cumple política demo: ${supplier.supplierCode}`);
    add((supplier.phoneDemo ?? '').startsWith('DEMO-'), `teléfono debe ser ficticio/DEMO: ${supplier.supplierCode}`);
    add(supplier.document === null, `no almacenar documento/RUC en ${supplier.supplierCode}`);
    add(Number.isFinite(supplier.leadTimeMeanDays) && supplier.leadTimeMeanDays > 0, `leadTimeMeanDays inválido: ${supplier.supplierCode}`);
    add(Number.isFinite(supplier.leadTimeStdDays) && supplier.leadTimeStdDays >= 0, `leadTimeStdDays inválido: ${supplier.supplierCode}`);
    add(Number.isFinite(supplier.onTimeProbabilityDemo) && supplier.onTimeProbabilityDemo >= 0 && supplier.onTimeProbabilityDemo <= 1, `probabilidad demo inválida: ${supplier.supplierCode}`);
  }
  for (const customer of customerRows) {
    add(customer.customerType === 'registered' && customer.identityIsSynthetic === true, `cliente no marcado como sintético: ${customer.customerCode}`);
    add(customer.document === null, `documento de cliente debe ser null: ${customer.customerCode}`);
    add(/^demo-cli-\d+$/i.test(customer.phoneDemo ?? ''), `teléfono debe ser ficticio/DEMO: ${customer.customerCode}`);
    add(/^cli\d+@pasco-demo\.example\.com$/i.test(customer.emailDemo ?? ''), `email no cumple política demo: ${customer.customerCode}`);
    add(customerProfileKeys.has(customer.customerProfileKey), `customerProfile inexistente: ${customer.customerCode}`);
    add(Number.isFinite(Date.parse(`${customer.registrationDate}T00:00:00Z`)) && customer.registrationDate <= scenario.referenceDate, `registrationDate inválida: ${customer.customerCode}`);
  }

  const declaredCustomerCounts = new Map((profiles?.customerProfiles ?? []).map((profile) => [profile.key, profile.count]));
  for (const profile of profiles?.customerProfiles ?? []) {
    add(Number.isInteger(profile.count) && profile.count >= 0, `count inválido en customerProfile ${profile.key}`);
  }
  const actualCustomerCounts = new Map();
  for (const customer of customerRows) actualCustomerCounts.set(customer.customerProfileKey, (actualCustomerCounts.get(customer.customerProfileKey) ?? 0) + 1);
  for (const [key, count] of declaredCustomerCounts) add((actualCustomerCounts.get(key) ?? 0) === count, `distribución de customerProfile no coincide: ${key}`);
  add([...declaredCustomerCounts.values()].reduce((sum, count) => sum + count, 0) === customerRows.length, 'customerProfile counts no suman 40');

  for (const profile of profiles?.demandProfiles ?? []) {
    add(profile.dispersionK > 0, `dispersionK inválido: ${profile.key}`);
    add(Object.values(profile.weekdayMultipliers ?? {}).every((value) => Number.isFinite(value) && value > 0), `weekday multiplier inválido: ${profile.key}`);
    add(Object.values(profile.hourWeights ?? {}).every((value) => Number.isFinite(value) && value >= 0), `hour weight inválido: ${profile.key}`);
  }
  const subcategoryCodes = new Set(subcategoryRows.map((row) => row.code));
  for (const profile of profiles?.associationProfiles ?? []) {
    for (const rule of profile.rules ?? []) {
      add(categoryByCode.has(rule.sourceCategoryCode), `association source category inexistente: ${profile.key}`);
      for (const code of rule.sourceSubcategoryCodes ?? []) add(subcategoryCodes.has(code), `association source subcategory inexistente: ${profile.key}/${code}`);
      for (const code of rule.targetCategoryCodes ?? []) add(categoryByCode.has(code), `association target category inexistente: ${profile.key}/${code}`);
      for (const code of rule.targetSubcategoryCodes ?? []) add(subcategoryCodes.has(code), `association target subcategory inexistente: ${profile.key}/${code}`);
      add(Number.isFinite(rule.probabilityUplift) && rule.probabilityUplift > 0 && rule.probabilityUplift < 1, `association uplift debe ser probabilístico y < 1: ${profile.key}`);
    }
  }

  add(forecast?.primaryTarget === 'unitsSold', 'forecast target debe ser unitsSold');
  add(forecast?.fields?.every((field) => ['AVAILABLE_AT_PREDICTION', 'DERIVED_ONLY_AFTER_DAY', 'TARGET'].includes(field.availability)), 'forecast field sin clasificación de leakage');
  add(forecast?.fields?.find((field) => field.name === 'unitsSold')?.availability === 'TARGET', 'unitsSold debe etiquetarse TARGET');
  add(forecast?.fields?.find((field) => field.name === 'lostDemandSynthetic')?.availability === 'DERIVED_ONLY_AFTER_DAY', 'lostDemandSynthetic debe quedar post-día');
  add(promotions?.instancesGenerated === false, 'M6.2 no debe materializar instancias de promoción');
  for (const promotion of promotions?.templates ?? []) {
    for (const code of promotion.categoryCodes ?? []) add(categoryByCode.has(code), `promotion category inexistente: ${promotion.key}/${code}`);
    add(promotion.associationProfileKey == null || associationKeys.has(promotion.associationProfileKey), `promotion association profile inexistente: ${promotion.key}`);
    add(promotion.minimumEffectivePriceAboveCost === true, `promoción no protege costo: ${promotion.key}`);
  }
  add(definitions?.manifestSchema?.properties?.scenarioId?.const === scenario?.scenarioId, 'manifest schema no coincide con scenario');
  add(Boolean(definitions?.canonicalization?.hashAlgorithm === 'SHA-256' && definitions?.canonicalization?.unicodeNormalization === 'NFC'), 'contrato de canonicalización/hash incompleto');
  add(stableKeys?.templates?.productKey === 'v3.{sku}' && stableKeys?.templates?.supplierCode === 'SUP-{NN}' && stableKeys?.templates?.customerCode === 'CLI-{NNN}', 'plantillas de stable keys canónicas incompletas');
  add(stableKeys?.rules?.keysIndependentOfMongoObjectId === true && stableKeys?.rules?.skuUniqueWithinTenant === true, 'stable keys no deben depender de ObjectId y SKU debe ser único');

  const counts = {
    Products: catalog.length,
    Categories: categoryRows.length,
    Subcategories: subcategoryRows.length,
    Suppliers: supplierRows.length,
    Customers: customerRows.length,
    'Supplier offers': offerRows.length,
    'Demand profiles': profiles?.demandProfiles?.length ?? 0,
    'Customer profiles': profiles?.customerProfiles?.length ?? 0,
    'Association profiles': profiles?.associationProfiles?.length ?? 0,
  };
  return { valid: errors.length === 0, errors, counts, commercialPresentationCount: presentationKeys.size };
}

function readJson(filename) {
  const buffer = fs.readFileSync(path.join(DATA_DIR, filename));
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  return JSON.parse(decoded);
}

function loadDefinitions() {
  return {
    scenario: readJson('scenario.json'),
    categories: readJson('categories.json'),
    products: readJson('products.json'),
    suppliers: readJson('suppliers.json'),
    offers: readJson('supplier-offers.json'),
    customers: readJson('customers.json'),
    profiles: readJson('profiles.json'),
    simulation: readJson('simulation-config.json'),
    forecast: readJson('forecast-daily-row-contract.json'),
    promotions: readJson('promotions.json'),
    canonicalization: readJson('canonicalization.json'),
    manifestSchema: readJson('v3-manifest.schema.json'),
    stableKeys: readJson('stable-keys.json'),
  };
}

if (require.main === module) {
  const result = validateDefinitions(loadDefinitions());
  for (const [name, count] of Object.entries(result.counts)) console.log(`${name}: ${count}`);
  console.log(`Commercial presentations: ${result.commercialPresentationCount}`);
  console.log(`Validation: ${result.valid ? 'PASS' : 'FAIL'}`);
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = result.valid ? 0 : 1;
}

module.exports = { commercialPresentationKey, loadDefinitions, validateDefinitions };
