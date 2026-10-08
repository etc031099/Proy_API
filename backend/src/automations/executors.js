const { Product } = require('../models');
const InventoryAlert = require('../models/InventoryAlert');
const { normalizeSku } = require('../utils/sku');
const { createProductRecord } = require('../services/productCreationService');
const { fail } = require('./contracts');
const { redact } = require('../services/agentHistoryProjection');
const createActionExecutors = () => ({
  create_product: {
    async preview(args, context) {
      const sku = normalizeSku(args.sku);
      if (!sku || await Product.exists({ businessId: context.businessId, sku }).maxTimeMS(5000)) fail('ACTION_CONFLICT');
      // Same model validation as CRUD, plus stricter bounded action input schemas.
      try { await new Product({ ...args, sku, businessId: context.businessId }).validate(); }
      catch { fail('ACTION_VALIDATION_FAILED'); }
      return { summary: `Crear producto ${redact(args.name)} (${redact(sku)}).`, fields: {
        name: redact(args.name), sku: redact(sku), price: args.price, currency: args.currency,
        stock: args.stock, resultingStock: args.stock, minStockLevel: args.minStockLevel, category: args.category,
        ...(args.costPrice !== undefined ? { costPrice: args.costPrice } : {}),
        ...(args.description ? { description: args.description } : {}) } };
    },
    async execute(args, context, session) {
      const product = await createProductRecord({ productData: { ...args, sku: normalizeSku(args.sku), businessId: context.businessId },
        initialStock: args.stock, session });
      return { id: product._id.toString(), sku: product.sku, name: redact(product.name), stock: product.stock };
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
module.exports = { createActionExecutors };
