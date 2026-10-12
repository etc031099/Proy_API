// Audit-only seams: evaluate existing unit-test fixtures without registering tests.
// No network/database implementation or production file is replaced or modified.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const load = (file, exports) => {
  const filename = path.resolve(__dirname, '..', file);
  const localRequire = createRequire(filename);
  const auditModule = { exports: {} };
  const auditRequire = id => id === 'node:test' ? Object.assign(() => {}, { skip() {}, todo() {} }) : localRequire(id);
  // Same realm is required by the production plain-object validator.
  const evaluate = vm.runInThisContext(`(function(require, module) {\n${fs.readFileSync(filename, 'utf8')}\nmodule.exports = { ${exports.join(', ')} };\n})`, { filename });
  evaluate(auditRequire, auditModule);
  return auditModule.exports;
};
const read = load('agentOrchestrator.test.js', ['fixture', 'req', 'id', 'product']);
const write = load('guidedActions.test.js', ['fixture', 'request']);
const transactional = load('automations.test.js', ['fixture', 'ctx', 'product']);
let observer = () => {};
const setObserver = callback => { observer = callback || (() => {}); };
const vendors = Array.from({ length: 25 }, (_, n) => ({ _id: read.id(700 + n), businessId: 'A', type: 'vendor', isActive: true,
  name: `Proveedor sintético ${String(n + 1).padStart(3, '0')} FOODS` }));
const products = [[2, '096', 12], [2, '210', 1], [3, '210', 8], [1, '212', 15], [3, '511', 4], [3, '491', 6]].map(([group, item, stock], n) => ({
  ...read.product(n + 1), sku: `M5-FOODS_${group}_${item}`, name: `Alimentos M5 · FOODS_${group} · Ítem ${item}`,
  price: 29.45, stock, minStockLevel: 5,
  supplierPrices: vendors.map(vendor => ({ supplierId: vendor._id, purchasePrice: 15.67 })), preferredSupplierId: vendors[0]._id
}));
const foreign = { ...read.product(999, 'B'), sku: 'M5-FOODS_3_196', name: 'Alimentos M5 · FOODS_3 · Ítem 196', stock: 90 };
const forecast = { status: 'READY', anchorOperationalDate: '2026-05-17', scenarioId: 'audit-synthetic',
  model: { featuresCount: 31, horizonDays: 7 }, products: products.map((row, n) => ({ productId: row._id, sku: row.sku,
    name: row.name, mlStatus: 'READY', stockAtAnchor: row.stock, predictedDemand7d: n === 4 ? 73.13 : 10 + n,
    salesLast7Days: 3, safetyStock: 5, recommendedQty: n === 4 ? 88 : 3 + n, inventoryStatus: 'REPONER' })) };
const readFixture = () => {
  const events = [];
  const fixture = read.fixture({ products: [...products, foreign], contacts: vendors, onEvent: event => events.push(event),
    forecastService: { getDemandForecast: async ({ businessId, productId }) => {
      if (businessId !== 'A') return { status: 'ML_NOT_READY', products: [] };
      return { ...structuredClone(forecast), products: structuredClone(forecast.products.filter(row => !productId || row.productId === String(productId))) };
    } }, now: () => new Date('2026-10-09T12:00:00Z') });
  const run = fixture.run;
  fixture.events = events;
  fixture.run = async (...args) => { const response = await run(...args); observer(response); return response; };
  return fixture;
};
const writeFixture = (options = {}) => {
  const contacts = vendors.map(row => ({ ...row, businessId: 'SYNTHETIC' }));
  const rows = products.map(row => ({ ...row, businessId: 'SYNTHETIC' }));
  const f = write.fixture({ products: rows, suppliers: contacts, configured: [contacts[0]], ...options });
  const argsByPending = new Map();
  const prepare = f.service.prepare;
  f.service.prepare = async input => {
    const pending = await prepare(input);
    argsByPending.set(pending.pendingActionId, structuredClone(input.args));
    pending.items = (input.args.products || []).map(item => {
      const product = rows.find(row => row._id === item.productId);
      const price = input.skillId === 'create_purchase' ? 15.67 : product.price;
      return { name: product.name, sku: product.sku, quantity: item.quantity, stock: product.stock,
        resultingStock: product.stock + (input.skillId === 'create_purchase' ? 1 : -1) * item.quantity,
        price, total: Number((price * item.quantity).toFixed(2)) };
    });
    pending.fields = { currency: 'PEN', total: pending.items.reduce((total, item) => total + item.total, 0), contact: contacts[0].name };
    return pending;
  };
  const confirm = f.service.confirmPendingAction;
  f.service.confirmPendingAction = async (context, id) => {
    const pending = await confirm(context, id), args = argsByPending.get(id);
    if (['create_sale', 'create_purchase'].includes(pending.action)) pending.result = {
      id: 'mock-result-only', type: pending.action === 'create_sale' ? 'sale' : 'purchase', currency: 'PEN', total: pending.fields.total,
      items: pending.items.map(item => ({ name: item.name, sku: item.sku, quantity: item.quantity, stock: item.resultingStock })) };
    else if (pending.action === 'create_stock_alert_rule') {
      const product = rows.find(row => row._id === args.productId);
      pending.result = { id: 'mock-result-only', ruleConfigured: true, name: product.name, sku: product.sku, operator: args.operator, threshold: args.threshold };
    }
    return pending;
  };
  const send = f.send;
  f.send = async message => { const response = await send(message); observer(response); return response; };
  return f;
};
module.exports = { readFixture, writeFixture, products, vendors, foreign, forecast, read, write, transactional, setObserver };
