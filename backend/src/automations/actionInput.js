const { Product, Contact } = require('../models');
const { schema, string, integer, validateArgs, fail } = require('./contracts');
const { normalizeSku } = require('../utils/sku');
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const itemSchema = schema({ ref: string(100), quantity: { ...integer(1000000), minimum: 1 } });
const extractionSchema = schema({
  action: { ...string(30), enum: ['create_product', 'create_sale', 'create_purchase'] },
  items: { type: 'array', maxItems: 20, items: itemSchema },
  customerRef: string(100), supplierRef: string(100), currency: { ...string(3), enum: ['PEN', 'USD', 'EUR'] },
  paymentMethod: { ...string(20), enum: ['cash', 'credit', 'card', 'bank_transfer', 'wallet', 'other'] },
  product: schema(require('./skills').getActionSkill('create_product').inputSchema.properties, [])
}, ['action']);
const actionIntent = message => {
  const value = normalize(message.trim());
  if (/^(?:crea(?:r)?|agrega|anade|registra)(?: un)? producto\b/.test(value)) return 'create_product';
  if (/^(?:vende|vender|registra(?:r)?(?: una)? venta)\b/.test(value)) return 'create_sale';
  if (/^(?:compre|comprar|compra|registra(?:r)?(?: una)? compra)\b/.test(value)) return 'create_purchase';
  return null;
};
const commandLength = message => (/^(?:crea(?:r)?|agrega|añade|registra)(?: un)? producto\b|^registra(?:r)?(?: una)? (?:venta|compra)\b/iu.exec(message.trim()) || [''])[0].length;
const money = text => /(?:USD|d[oó]lares|\$)/i.test(text) ? 'USD' : /(?:EUR|euros|€)/i.test(text) ? 'EUR' : /(?:PEN|S\/|soles)/i.test(text) ? 'PEN' : undefined;
function parseAction(message, action) {
  const tail = message.trim().slice(commandLength(message));
  if (tail.trim().startsWith('{')) { try { return { direct: JSON.parse(tail), action }; } catch { fail('ACTION_VALIDATION_FAILED'); } }
  if (action === 'create_product') {
    const product = {};
    const name = /(?:producto)\s+([^,]+?)(?=,|\s+SKU\b|$)/i.exec(message);
    const sku = /\bSKU\s*[:=]?\s*([\w-]+)/i.exec(message);
    const price = /precio\s*[:=]?\s*(?:S\/|USD|PEN|EUR|\$|€)?\s*(\d+(?:[.,]\d+)?)/i.exec(message);
    const stock = /\bstock\s*(?:inicial)?\s*[:=]?\s*(\d+)/i.exec(message);
    const minimum = /m[ií]nimo\s*[:=]?\s*(\d+)/i.exec(message);
    const category = /categor[ií]a\s*[:=]?\s*([^,.]+)/i.exec(message);
    if (name) product.name = name[1].trim(); if (sku) product.sku = sku[1];
    if (price) product.price = Number(price[1].replace(',', '.')); if (stock) product.stock = Number(stock[1]);
    if (minimum) product.minStockLevel = Number(minimum[1]); if (category) product.category = category[1].trim();
    if (money(message)) product.currency = money(message);
    return { action, product };
  }
  if (/(?:^|\s)-\d+\s*(?:unidades?|de|del)/i.test(message)) fail('ACTION_VALIDATION_FAILED');
  const supplier = /(?:(?:al|del|con el)\s+|^)proveedor\s+(.+?)(?=,|\s+(?:en|a)\s+(?:cr[eé]dito|contado)|$)/i.exec(message);
  const customer = /(?:al|para el|para|cliente)\s+(?:cliente\s+)?(.+?)(?=,|\s+(?:en|a)\s+(?:cr[eé]dito|contado)|$)/i.exec(message.replace(/al\s+proveedor.*/i, ''));
  const itemText = message.replace(/\s+(?:al|del|con el)\s+proveedor\s+.*/i, '').replace(/\s+(?:al|para el|para)\s+(?:cliente\s+)?[A-Za-z].*/i, '')
    .replace(/\s+(?:en|a)\s+(?:cr[eé]dito|contado).*/i, '').replace(/\s+(?:moneda|en)\s+(?:PEN|USD|EUR|soles|d[oó]lares|euros).*/i, '');
  const items = [...itemText.matchAll(/(?:^|\b)(\d+)\s+(?:unidades?\s+)?(?:de(?:l)?\s+)?(?:SKU\s+|producto\s+)?(.+?)(?=\s*(?:,|\by\s+\d+)|[.!?]*$)/gi)]
    .map(match => ({ quantity: Number(match[1]), ref: match[2].trim().replace(/[.!?]+$/, '') }));
  return { action, items, ...(supplier ? { supplierRef: supplier[1].trim().replace(/[.!?]+$/, '') } : {}),
    ...(customer && action === 'create_sale' ? { customerRef: customer[1].trim().replace(/[.!?]+$/, '') } : {}),
    ...(money(message) ? { currency: money(message) } : {}),
    paymentMethod: /cr[eé]dito/i.test(message) ? 'credit' : 'cash' };
}
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function resolveReference(model, context, ref, type) {
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 100) fail('ACTION_VALIDATION_FAILED');
  const identity = /^[a-f\d]{24}$/i.test(ref) ? [{ _id: ref }] : [
    ...(model === Product ? [{ sku: normalizeSku(ref) }] : []), { name: new RegExp(`^${escapeRegex(ref.trim())}$`, 'i') }
  ];
  const rows = await model.find({ businessId: context.businessId, isActive: true, ...(type ? { type } : {}), $or: identity })
    .select(model === Product ? '_id sku name currency' : '_id name').limit(2).lean().maxTimeMS(5000);
  return rows.length === 1 ? { value: rows[0] } : { clarification: rows.length ? `Hay varias coincidencias para «${ref}». Indica el SKU o identificador exacto.` : `No encontré «${ref}» en este negocio. Indica su SKU o identificador.` };
}
async function resolveAction(extracted, context, resolver = resolveReference) {
  if (extracted.direct) return { args: extracted.direct };
  if (extracted.action === 'create_product') {
    const args = extracted.product || {};
    const missing = require('./skills').getActionSkill(extracted.action).inputSchema.required.filter(key => args[key] === undefined);
    return missing.length ? { clarification: `Para preparar el producto faltan: ${missing.join(', ')}.` } : { args };
  }
  if (!extracted.items?.length) return { clarification: 'Indica el producto (SKU o nombre) y la cantidad.' };
  const args = { products: [], paymentMethod: extracted.paymentMethod || 'cash' }, currencies = new Set();
  for (const item of extracted.items) {
    const result = await resolver(Product, context, item.ref);
    if (result.clarification) return result;
    args.products.push({ productId: String(result.value._id), quantity: item.quantity }); currencies.add(result.value.currency);
  }
  args.currency = extracted.currency || (currencies.size === 1 ? [...currencies][0] : undefined);
  if (!args.currency) return { clarification: 'Los productos tienen distintas monedas. Indica PEN, USD o EUR para la operación.' };
  const contactRef = extracted.action === 'create_purchase' ? extracted.supplierRef : extracted.customerRef;
  if (extracted.action === 'create_purchase' && !contactRef) return { clarification: 'Indica el proveedor existente de esta compra.' };
  if (args.paymentMethod === 'credit' && extracted.action === 'create_sale' && !contactRef) return { clarification: 'Para una venta a crédito, indica el cliente registrado.' };
  if (contactRef) {
    const result = await resolver(Contact, context, contactRef, extracted.action === 'create_purchase' ? 'vendor' : 'customer');
    if (result.clarification) return result;
    args[extracted.action === 'create_purchase' ? 'vendorId' : 'customerId'] = String(result.value._id);
  }
  return { args };
}
module.exports = { actionIntent, parseAction, resolveAction, resolveReference, extractionSchema, validateExtraction: value => validateArgs(extractionSchema, value) };
