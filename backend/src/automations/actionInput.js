const { Product, Contact } = require('../models');
const { schema, string, integer, validateArgs, fail } = require('./contracts');
const { resolveReference, configuredSuppliers } = require('./entityResolution');
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const quantityWords = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, veinte: 20, treinta: 30, cincuenta: 50, cien: 100 };
const numericWords = text => text.replace(/\b(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|veinte|treinta|cincuenta|cien)\b/gi,
  word => String(quantityWords[word.toLowerCase()]));
const itemSchema = schema({ ref: string(100), quantity: { ...integer(1000000), minimum: 1 } });
const extractionSchema = schema({
  action: { ...string(30), enum: ['create_product', 'create_sale', 'create_purchase'] },
  items: { type: 'array', maxItems: 20, items: itemSchema },
  customerRef: string(100), supplierRef: string(100), purchasePrice: require('./contracts').number(), currency: { ...string(3), enum: ['PEN', 'USD', 'EUR'] },
  paymentMethod: { ...string(20), enum: ['cash', 'credit', 'card', 'bank_transfer', 'wallet', 'other'] },
  product: schema(require('./skills').getActionSkill('create_product').inputSchema.properties, [])
}, ['action']);
const actionIntent = message => {
  const value = normalize(message.trim());
  if (/^(?:crea(?:r)?|agrega|anade|registra)(?: un)? producto\b/.test(value) || /^(?:agrega|anade)\s+/.test(value)) return 'create_product';
  if (/^(?:vende|vender|registra(?:r)?(?: una)? venta)\b/.test(value)) return 'create_sale';
  if (/^(?:compre|comprar|compra|registra(?:r)?(?: una)? compra)\b/.test(value)) return 'create_purchase';
  return null;
};
const commandLength = message => (/^(?:crea(?:r)?|agrega|añade|registra)(?: un)? producto\b|^registra(?:r)?(?: una)? (?:venta|compra)\b/iu.exec(message.trim()) || [''])[0].length;
const money = text => /(?:USD|d[oó]lares|\$)/i.test(text) ? 'USD' : /(?:EUR|euros|€)/i.test(text) ? 'EUR' : /(?:PEN|S\/|soles)/i.test(text) ? 'PEN' : undefined;
function parseAction(message, action) {
  message = message.replace(/\b(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|veinte|treinta|cincuenta|cien)\b(?=\s+(?:unidades?\b|de\b))/gi,
    word => String(quantityWords[word.toLowerCase()]));
  const tail = message.trim().slice(commandLength(message));
  if (tail.trim().startsWith('{')) { try { return { direct: JSON.parse(tail), action }; } catch { fail('ACTION_VALIDATION_FAILED'); } }
  if (action === 'create_product') {
    const product = {};
    const name = /(?:producto)\s+([^,]+?)(?=,|\s+SKU\b|\s+a\s+\d|$)/i.exec(message)
      || /^(?:agrega|añade)\s+([^,]+?)(?=,|\s+a\s+\d|$)/i.exec(message);
    const sku = /\bSKU\s*[:=]?\s*([\w-]+)/i.exec(message);
    const price = /(?:precio\s*[:=]?|\ba)\s*(?:S\/|USD|PEN|EUR|\$|€)?\s*(\d+(?:[.,]\d+)?)/i.exec(message);
    const stock = /\bstock\s*(?:inicial)?\s*[:=]?\s*(\d+)/i.exec(message);
    const minimum = /m[ií]nimo\s*[:=]?\s*(\d+)/i.exec(message);
    const category = /categor[ií]a\s*[:=]?\s*([^,.]+)/i.exec(message);
    const supplier = /\bprove(?:edor|edro)\s+(.+?)(?=,|\s+precio de compra|$)/i.exec(message);
    const purchasePrice = /precio de compra\s*[:=]?\s*(?:S\/|USD|PEN|EUR|\$|€)?\s*(\d+(?:[.,]\d+)?)/i.exec(message);
    if (name) product.name = name[1].trim(); if (sku) product.sku = sku[1];
    if (price) product.price = Number(price[1].replace(',', '.')); if (stock) product.stock = Number(stock[1]);
    if (minimum) product.minStockLevel = Number(minimum[1]); if (category) product.category = category[1].trim();
    if (money(price?.[0] || '') || money(message)) product.currency = money(price?.[0] || '') || money(message);
    return { action, product, ...(supplier ? { supplierRef: supplier[1].trim() } : {}),
      ...(purchasePrice ? { purchasePrice: Number(purchasePrice[1].replace(',', '.')) } : {}) };
  }
  message = message.replace(/^(vende|vender|compre|compré|comprar|compra)\s+(\w+)\b/i,
    (match, command, word) => Object.hasOwn(quantityWords, word.toLowerCase()) ? `${command} ${quantityWords[word.toLowerCase()]}` : match);
  if (/(?:^|\s)-\d+\s*(?:unidades?|de|del)/i.test(message)) fail('ACTION_VALIDATION_FAILED');
  const supplier = /\bprove(?:edor|edro)\s+(.+?)(?=,|\s+(?:en|a)\s+(?:cr[eé]dito|contado)|$)/i.exec(message);
  const customer = /\b(?:al|para el|para|cliente|a)\s+(?:cliente\s+)?([a-záéíóúñ].+?)(?=,|\s+(?:en|a)\s+(?:cr[eé]dito|contado)|$)/i.exec(message.replace(/(?:al|de)\s+prove(?:edor|edro).*/i, '').replace(/a\s+cr[eé]dito.*/i, ''));
  const itemText = message.replace(/\s+(?:(?:al|del|de|con el)\s+)?prove(?:edor|edro)\s+.*/i, '').replace(/\s+(?:al|para el|para|a)\s+(?:cliente\s+)?[A-Za-z].*/i, '')
    .replace(/\s+(?:fiado|(?:en|a|al)\s+(?:cr[eé]dito|contado)).*/i, '').replace(/\s+(?:moneda|en)\s+(?:PEN|USD|EUR|soles|d[oó]lares|euros).*/i, '');
  const items = [...itemText.matchAll(/(?:^|\b)(\d+)\s+(?:unidades?\s+)?(?:de(?:l)?\s+)?(?:SKU\s+|producto\s+)?(.+?)(?=\s*(?:,|\by\s+\d+)|[.!?]*$)/gi)]
    .map(match => ({ quantity: Number(match[1]), ref: match[2].trim().replace(/[.!?]+$/, '').replace(/^(?:la|el)\s+/i, '') }));
  if (!items.length) {
    const ref = message.replace(/^(?:vende|vender|compre|compré|comprar|compra|registra(?:r)?(?: una)? (?:venta|compra))\s*(?:de\s+)?/i, '').trim();
    if (ref) items.push({ ref });
  }
  return { action, items, ...(supplier ? { supplierRef: supplier[1].trim().replace(/[.!?]+$/, '') } : {}),
    ...(customer && action === 'create_sale' ? { customerRef: customer[1].trim().replace(/[.!?]+$/, '') } : {}),
    ...(money(message) ? { currency: money(message) } : {}),
    paymentMethod: /cr[eé]dito|fiado/i.test(message) ? 'credit' : 'cash' };
}
async function resolveAction(extracted, context, resolver = resolveReference, supplierLookup = configuredSuppliers) {
  if (extracted.direct) return { args: extracted.direct };
  if (extracted.action === 'create_product') {
    const args = extracted.product || {};
    const missing = require('./skills').getActionSkill(extracted.action).inputSchema.required.filter(key => args[key] === undefined);
    const labels = { name: 'nombre', sku: 'SKU', price: 'precio de venta', currency: 'moneda (PEN, USD o EUR)', stock: 'stock inicial', minStockLevel: 'stock mínimo', category: 'categoría' };
    return missing.length ? { missingFields: missing, clarification: `Para preparar el producto faltan: ${missing.map(key => labels[key]).join(', ')}.` } : { args };
  }
  if (!extracted.items?.length) return { clarification: 'Indica el producto (SKU o nombre) y la cantidad.' };
  const args = { products: [], paymentMethod: extracted.paymentMethod || 'cash' }, currencies = new Set();
  const products = [], quantities = new Map();
  for (const [index, item] of extracted.items.entries()) {
    const result = await resolver(Product, context, item.ref);
    if (!result.value) return { ...result, selection: { slot: 'product', index, candidates: result.candidates || [], ...(result.pagination || {}) } };
    if (result.value.isActive === false) return { clarification: `Encontré ${result.value.name}, pero está inactivo. Elige otro producto.` };
    // Keep previously resolved slots; later ambiguous items must not discard them.
    item.ref = String(result.value._id);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) return { missingFields: ['quantity'], itemIndex: index, clarification: `¿Cuántas unidades de ${result.value.name || item.ref}?` };
    const id = String(result.value._id), previousQuantity = quantities.get(id) || 0, requested = previousQuantity + item.quantity;
    quantities.set(id, requested);
    if (extracted.action === 'create_sale' && Number.isFinite(result.value.stock) && requested > result.value.stock)
      return { clarification: `Solo hay ${result.value.stock} unidades disponibles de ${result.value.name}. Puedes cambiar la cantidad o cancelar.`,
        suggestions: result.value.stock > previousQuantity ? [{ label: `Vender ${result.value.stock - previousQuantity} de este ítem`, message: `Cambiar cantidad del producto ${index + 1} a ${result.value.stock - previousQuantity}` }] : [] };
    products.push(result.value);
    args.products.push({ productId: String(result.value._id), quantity: item.quantity }); currencies.add(result.value.currency);
  }
  args.currency = extracted.currency || (currencies.size === 1 ? [...currencies][0] : undefined);
  if (!args.currency) return { clarification: 'Los productos tienen distintas monedas. Indica PEN, USD o EUR para la operación.' };
  const contactRef = extracted.action === 'create_purchase' ? extracted.supplierRef : extracted.customerRef;
  if (extracted.action === 'create_purchase' && !contactRef) {
    const candidates = await supplierLookup(products, context);
    return { clarification: candidates.length ? 'Elige el proveedor configurado y su costo de compra.'
      : 'Estos productos no tienen un proveedor común con precio de compra configurado. Configúralo desde Productos; puedes elegir un proveedor existente, crear uno desde Proveedores o cancelar.',
      selection: { slot: 'supplier', candidates }, missingFields: ['supplier'] };
  }
  if (args.paymentMethod === 'credit' && extracted.action === 'create_sale' && !contactRef) return { missingFields: ['customer'], clarification: 'Para una venta a crédito, indica el cliente registrado.' };
  if (contactRef) {
    const result = await resolver(Contact, context, contactRef, extracted.action === 'create_purchase' ? 'vendor' : 'customer');
    if (!result.value) return { ...result, selection: { slot: extracted.action === 'create_purchase' ? 'supplier' : 'customer', candidates: result.candidates || [] } };
    if (result.value.isActive === false) return { clarification: `Encontré ${result.value.name}, pero está inactivo. Elige otro contacto.` };
    if (extracted.action === 'create_purchase' && products.some(product => Array.isArray(product.supplierPrices)
      && !product.supplierPrices.some(row => String(row.supplierId) === String(result.value._id) && Number.isFinite(row.purchasePrice))))
      return { clarification: 'Ese proveedor no tiene un precio de compra configurado para todos los productos. Configúralo desde Productos o elige otro proveedor.' };
    args[extracted.action === 'create_purchase' ? 'vendorId' : 'customerId'] = String(result.value._id);
  }
  return { args };
}
module.exports = { actionIntent, parseAction, resolveAction, resolveReference, numericWords, extractionSchema, validateExtraction: value => validateArgs(extractionSchema, value) };
