const { Product, Contact } = require('../models');
const InventoryAlert = require('../models/InventoryAlert');
const StockAlertRule = require('../models/StockAlertRule');
const { normalizeSku } = require('../utils/sku');
const { createProductRecord } = require('../services/productCreationService');
const { fail } = require('./contracts');
const { redact } = require('../services/agentHistoryProjection');
const { writeTransaction } = require('../services/transactionWriteService');
const ActionDomainEvent = require('../models/ActionDomainEvent');
const recordEvents = (context, actionId, entityId, types, session) => ActionDomainEvent.create(types.map(type => ({
  businessId: context.businessId, actionId, entityId: String(entityId), type
})), { session, ordered: true });
const transactionExecutor = type => ({
  async preview(args, context) {
    try {
      const { snapshot } = await writeTransaction({ input: { ...args, type }, businessId: context.businessId, preview: true });
      return { snapshot, summary: `Registrar ${type === 'sale' ? 'venta' : 'compra'} de ${snapshot.items.length} producto(s).`,
        fields: { currency: snapshot.currency, total: snapshot.totalAmount, paymentMethod: snapshot.paymentMethod,
          contact: redact(snapshot.contactName || 'Consumidor final') },
        items: snapshot.items.map(item => ({ sku: item.sku, name: redact(item.name), quantity: item.quantity,
          stock: item.stock, resultingStock: item.resultingStock, price: item.convertedPrice,
          total: Number((item.quantity * item.convertedPrice).toFixed(2)) })) };
    } catch { fail('ACTION_VALIDATION_FAILED'); }
  },
  async execute(args, context, session, actionId, expectedSnapshot) {
    if (!expectedSnapshot) fail('ACTION_CONFLICT');
    let result;
    try {
      result = await writeTransaction({ input: { ...args, type }, businessId: context.businessId, session, expectedSnapshot });
    } catch (error) {
      if (error.statusCode === 400 || error.statusCode === 404 || error.code === 'ACTION_CONFLICT') fail('ACTION_CONFLICT');
      throw error;
    }
    await recordEvents(context, actionId, result.transaction._id, [type === 'sale' ? 'SALE_CREATED' : 'PURCHASE_CREATED', 'INVENTORY_CHANGED'], session);
    return { id: String(result.transaction._id), type, currency: result.snapshot.currency, total: result.snapshot.totalAmount,
      items: result.snapshot.items.map(item => ({ sku: item.sku, name: redact(item.name), quantity: item.quantity, stock: item.resultingStock })) };
  }
});
const createActionExecutors = () => ({
  create_sale: transactionExecutor('sale'),
  create_purchase: transactionExecutor('purchase'),
  create_stock_alert_rule: {
    async preview(args, context) {
      const product = await ruleProduct(args, context);
      return { summary: `Configurar regla para ${redact(product.sku)}: stock ${args.operator} ${args.threshold} unidades.`,
        fields: { sku: redact(product.sku), name: redact(product.name),
          description: `Condición: stock ${args.operator} ${args.threshold} unidades. Solo configuración; no envía avisos automáticos todavía.` } };
    },
    async execute(args, context, session) {
      const product = await ruleProduct(args, context, session);
      const filter = { businessId: context.businessId, productId: args.productId,
        operator: args.operator, threshold: args.threshold, enabled: true };
      // The unique partial index is essential: lookup alone cannot prevent races.
      const existing = await StockAlertRule.findOne(filter).session(session).lean().maxTimeMS(5000);
      const rule = existing || await StockAlertRule.findOneAndUpdate(filter,
        { $setOnInsert: { ...filter, createdBy: context.userId } },
        { upsert: true, new: true, session, runValidators: true }).lean().maxTimeMS(5000);
      return { id: String(rule._id), sku: redact(product.sku), name: redact(product.name),
        operator: args.operator, threshold: args.threshold, alreadyExists: Boolean(existing), ruleConfigured: true };
    }
  },
  create_product: {
    async preview(args, context) {
      const suppliers = await validateSuppliers(args, context);
      const sku = normalizeSku(args.sku);
      if (!sku || await Product.exists({ businessId: context.businessId, sku }).maxTimeMS(5000)) fail('ACTION_CONFLICT');
      // Same model validation as CRUD, plus stricter bounded action input schemas.
      try { await new Product({ ...args, sku, businessId: context.businessId }).validate(); }
      catch { fail('ACTION_VALIDATION_FAILED'); }
      return { summary: `Crear producto ${redact(args.name)} (${redact(sku)}).`, fields: {
        name: redact(args.name), sku: redact(sku), price: args.price, currency: args.currency,
        stock: args.stock, resultingStock: args.stock, minStockLevel: args.minStockLevel, category: args.category,
        ...(args.costPrice !== undefined ? { costPrice: args.costPrice } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.supplierPrices?.length ? { supplierCosts: args.supplierPrices.map(row => `${redact(suppliers.find(supplier => String(supplier._id) === row.supplierId).name)}: ${row.purchasePrice} ${args.currency}`).join(', ') } : {}) } };
    },
    async execute(args, context, session, actionId) {
      await validateSuppliers(args, context, session);
      const product = await createProductRecord({ productData: { ...args, sku: normalizeSku(args.sku), businessId: context.businessId },
        initialStock: args.stock, session });
      await recordEvents(context, actionId, product._id, ['PRODUCT_CREATED', ...(args.stock > 0 ? ['INVENTORY_CHANGED'] : [])], session);
      return { id: product._id.toString(), sku: product.sku, name: redact(product.name), stock: product.stock, needsSupplierSetup: !args.supplierPrices?.length };
    }
  },
  create_inventory_alert: {
    async preview(args, context) {
      if (args.productId && !await Product.exists({ _id: args.productId, businessId: context.businessId, isActive: true }).maxTimeMS(5000)) fail('ACTION_VALIDATION_FAILED');
      return { summary: `Registrar alerta interna ${args.type}.`, fields: { type: args.type, label: redact(args.label), ...(args.productId ? { productId: args.productId } : {}) } };
    },
    async execute(args, context, session, actionId) {
      await this.preview(args, context); // Recheck product ownership immediately before insertion.
      const [alert] = await InventoryAlert.create([{ ...args, label: redact(args.label), businessId: context.businessId, actionId }], { session });
      return { id: alert._id.toString(), type: alert.type, status: alert.status };
    }
  }
});
async function validateSuppliers(args, context, session) {
  if (!args.supplierPrices) return;
  const ids = args.supplierPrices.map(row => row.supplierId);
  if (new Set(ids).size !== ids.length) fail('ACTION_VALIDATION_FAILED');
  const suppliers = await Contact.find({ businessId: context.businessId, type: 'vendor', isActive: true, _id: { $in: ids } }).select('_id name').session(session || null).lean().maxTimeMS(5000);
  if (suppliers.length !== ids.length) fail('ACTION_VALIDATION_FAILED');
  return suppliers;
}
async function ruleProduct(args, context, session) {
  const product = await Product.findOne({ _id: args.productId, businessId: context.businessId, isActive: true })
    .select('_id sku name').session(session || null).lean().maxTimeMS(5000);
  if (!product) fail('ACTION_VALIDATION_FAILED');
  return product;
}
module.exports = { createActionExecutors };
