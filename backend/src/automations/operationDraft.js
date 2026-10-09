const { Contact } = require('../models');
const { schema, string, integer, number, objectId, validateArgs } = require('./contracts');
const { getActionSkill } = require('./skills');
const { resolveAction, numericWords } = require('./actionInput');
const { normalize, configuredSuppliers, resolveReference } = require('./entityResolution');
const TTL_MS = 20 * 60 * 1000;
// REQUIRED comes from the write contract. Only supplierPrices is RECOMMENDED;
// description/costPrice are OPTIONAL and do not trigger extra questions.
const candidateSchema = schema({ _id: objectId, name: string(100), sku: string(100), currency: string(3), stock: integer(1000000), isActive: { type: 'boolean' },
  costs: { type: 'array', maxItems: 20, items: schema({ sku: string(100), currency: string(3), purchasePrice: number() }) } }, ['_id', 'name']);
const draftSchema = schema({ action: { ...string(30), enum: ['create_product', 'create_sale', 'create_purchase'] },
  product: schema(getActionSkill('create_product').inputSchema.properties, []),
  items: { type: 'array', maxItems: 20, items: schema({ ref: string(100), quantity: { ...integer(1000000), minimum: 1 } }, ['ref']) },
  currency: { ...string(3), enum: ['PEN', 'USD', 'EUR'] }, paymentMethod: { ...string(20), enum: ['cash', 'credit', 'card', 'bank_transfer', 'wallet', 'other'] },
  customerRef: string(100), supplierRef: string(100), supplierId: objectId, purchasePrice: number(), enrichment: string(20),
  selection: schema({ slot: { ...string(20), enum: ['product', 'supplier', 'customer', 'productSupplier'] }, index: integer(20),
    candidates: { type: 'array', maxItems: 5, items: candidateSchema } }, ['slot', 'candidates']),
  missingFields: { type: 'array', maxItems: 10, items: string(30) }, itemIndex: integer(20),
  pendingActionId: string(36), updatedAt: number(Number.MAX_SAFE_INTEGER), expiresAt: number(Number.MAX_SAFE_INTEGER) }, ['action', 'updatedAt', 'expiresAt']);
function compactDraft(value, now = Date.now()) {
  if (!value || value.expiresAt <= now || value.expiresAt > now + TTL_MS || value.updatedAt > now) return null;
  try {
    const { direct, ...state } = value;
    if (!state.selection?.candidates.length) delete state.selection;
    const draft = structuredClone(validateArgs(draftSchema, state));
    if (direct) draft.direct = structuredClone(validateArgs(getActionSkill(draft.action).inputSchema, direct));
    return draft;
  } catch { return null; }
}
const compactCandidate = value => Object.fromEntries(Object.entries({ _id: String(value._id), name: value.name, sku: value.sku,
  currency: value.currency, stock: value.stock, isActive: value.isActive, costs: value.costs }).filter(([, v]) => v !== undefined));
const suggestionsFor = selection => (selection?.candidates || []).map((candidate, index) => ({ label: `${index + 1}. ${candidate.name}${candidate.sku ? ` — ${candidate.sku}` : ''}`,
  message: `Opción ${index + 1}`, detail: candidate.costs?.map(cost => `${cost.sku}: ${cost.purchasePrice} ${cost.currency}`).join('; ') }));
function choose(selection, message) {
  const text = normalize(message).replace(/^(?:el|la|opcion)\s+/, '');
  const ordinals = ['primero', 'segundo', 'tercero', 'cuarto', 'quinto'];
  let index = /^\d+$/.test(text) ? Number(text) - 1 : ordinals.indexOf(text.replace(/a$/, 'o'));
  if (/^(?:si|correcto|ese|esa|es ese|es esa)$/.test(text) && selection.candidates.length === 1) index = 0;
  if (index >= 0) return selection.candidates[index] || null;
  const query = text.replace(/^de\s+/, '');
  const hits = selection.candidates.filter(row => normalize(`${row.name} ${row.sku || ''}`).includes(query));
  return query.length >= 2 && hits.length === 1 ? hits[0] : null;
}
function updateDraft(previous, extracted, message) {
  const draft = previous ? structuredClone(previous) : { action: extracted.action };
  const text = normalize(numericWords(message));
  if (draft.selection) {
    const selected = choose(draft.selection, message);
    if (selected) {
      const { slot, index } = draft.selection;
      if (slot === 'product') draft.items[index].ref = selected._id;
      else if (slot === 'productSupplier') {
        draft.supplierId = selected._id; draft.enrichment = 'price';
        if (draft.purchasePrice !== undefined) { draft.product.supplierPrices = [{ supplierId: selected._id, purchasePrice: draft.purchasePrice }]; draft.enrichment = 'done'; }
      }
      else draft[slot === 'supplier' ? 'supplierRef' : 'customerRef'] = selected._id;
      delete draft.selection;
      return draft;
    }
    // Raw IDs cannot bypass the displayed selection. Chosen candidates are
    // resolved again under the authenticated tenant before preparation.
    if (/^[a-f\d]{24}$/i.test(text) || /^(?:opcion\s+)?\d+$/.test(text) || /^(?:el|la)\s+(?:primer|segund|tercer|cuart|quint)/.test(text)) return draft;
    if (!/que|datos|falta|cambia|cantidad|mejor/.test(text)) {
      if (draft.selection.slot === 'product') draft.items[draft.selection.index].ref = message.trim().replace(/^SKU\s+/i, '');
      else draft.supplierRef = message.trim();
      delete draft.selection;
    }
  }
  if (draft.action === 'create_product') {
    if (draft.enrichment === 'price' && draft.product?.currency && !/moneda/.test(text)) delete extracted.product.currency;
    draft.product = { ...(draft.product || {}), ...(extracted.product || {}) };
    if (extracted.supplierRef) { draft.supplierRef = extracted.supplierRef; draft.enrichment = 'supplier'; delete draft.product.supplierPrices; }
    if (extracted.purchasePrice !== undefined) draft.purchasePrice = extracted.purchasePrice;
    const missing = getActionSkill('create_product').inputSchema.required.filter(key => draft.product[key] === undefined);
    if (previous && missing.length === 1 && !Object.keys(extracted.product || {}).length) {
      const key = missing[0], value = message.trim();
      if (['name', 'sku', 'category', 'currency'].includes(key)) draft.product[key] = key === 'currency' ? value.toUpperCase() : value;
      else if (/^\d+(?:[.,]\d+)?$/.test(value)) draft.product[key] = Number(value.replace(',', '.'));
    }
    if (/sin proveedor|continuar sin|hacerlo manual|mas tarde/.test(text)) draft.enrichment = 'skip';
    if (/crear (?:un )?proveedor/.test(text)) { draft.enrichment = 'offer'; delete draft.supplierRef; delete draft.selection; }
    if (/elegir proveedor|proveedor existente/.test(text)) { draft.enrichment = 'supplier'; delete draft.selection; }
    if (draft.enrichment === 'price') {
      const price = /^(?:precio de compra\s*[:=]?\s*)?(?:S\/|PEN|USD|EUR)?\s*(\d+(?:[.,]\d+)?)\s*$/i.exec(message);
      const explicitCurrency = /USD/i.test(message) ? 'USD' : /EUR/i.test(message) ? 'EUR' : /PEN|S\//i.test(message) ? 'PEN' : undefined;
      if (price && (!explicitCurrency || explicitCurrency === draft.product.currency)) { draft.product.supplierPrices = [{ supplierId: draft.supplierId, purchasePrice: Number(price[1].replace(',', '.')) }]; draft.enrichment = 'done'; }
    }
  } else {
    const correction = /(?:mejor(?: que)?(?: sean)?|pon|cantidad(?: del producto (\d+))? a|cantidad)\s+(\d+)\b/.exec(text);
    if (correction && draft.items?.length) {
      const index = correction[1] ? Number(correction[1]) - 1 : draft.items.length === 1 ? 0 : -1;
      if (draft.items[index]) draft.items[index].quantity = Number(correction[2]);
    } else if (previous?.missingFields?.includes('quantity') && /^\d+(?: unidades?)?$/.test(text)) draft.items[previous.itemIndex || 0].quantity = Number(text.split(' ')[0]);
    else if (!previous || /^(?:vende|vender|compre|compra|comprar|registra)/.test(text)) draft.items = extracted.items;
    const changeProduct = /^(?:no es .+?,? es|cambia (?:el )?producto (?:a|por)|producto|sku)\s+(.+)$/.exec(text);
    if (changeProduct && draft.items?.length === 1) { draft.items[0].ref = changeProduct[1].replace(/^la de /, ''); delete draft.selection; }
    if (previous?.missingFields?.includes('product') && !changeProduct && !/que|datos|falta/.test(text)) draft.items[previous.itemIndex || 0].ref = message.trim();
    if (extracted.supplierRef) { draft.supplierRef = extracted.supplierRef; delete draft.selection; }
    if (extracted.customerRef && (!previous || /^(?:vende|vender|registra)/.test(text) || /cliente/.test(text))) draft.customerRef = extracted.customerRef;
    if (previous?.missingFields?.includes('customer') && !extracted.customerRef) draft.customerRef = message.trim();
    const changeSupplier = /^(?:cambia (?:el )?proveedor a|proveedor)\s+(.+)$/.exec(text);
    if (changeSupplier) { draft.supplierRef = changeSupplier[1]; delete draft.selection; }
    else if (previous?.selection?.slot === 'supplier' && !choose(previous.selection, message) && !/que|datos|falta|cantidad|mejor|cambia|en vez/.test(text)) {
      draft.supplierRef = message.trim(); delete draft.selection;
    }
    else if (previous?.missingFields?.includes('supplier') && !draft.supplierRef && !/que|datos|falta/.test(text)) draft.supplierRef = message.trim();
    if (extracted.currency) draft.currency = extracted.currency;
    if (!previous || /credito|fiado|contado/.test(text)) draft.paymentMethod = extracted.paymentMethod;
  }
  return draft;
}
async function resolveDraft(draft, context, options = {}) {
  const resolver = options.resolver || resolveReference;
  if (draft.direct && draft.action !== 'create_product') {
    const missing = getActionSkill(draft.action).inputSchema.required.filter(key => draft.direct[key] === undefined);
    if (missing.length) return { clarification: `Para preparar la operación faltan: ${missing.join(', ')}.` };
  }
  if (draft.action === 'create_product') {
    if (draft.direct) { draft.product = { ...draft.direct }; delete draft.direct; }
    const result = await resolveAction(draft, context, resolver);
    if (result.clarification) return result;
    if (draft.product.supplierPrices?.length || ['skip', 'done'].includes(draft.enrichment)) return { args: draft.product };
    if (!draft.enrichment) { draft.enrichment = 'offer'; return { clarification: 'Ya tengo los datos mínimos. ¿Quieres asociar un proveedor y su precio de compra antes de crear el producto?', suggestions: [
      { label: 'Elegir proveedor existente', message: 'Elegir proveedor' }, { label: 'Crear proveedor nuevo', message: 'Crear proveedor nuevo' },
      { label: 'Continuar sin proveedor', message: 'Continuar sin proveedor' }] }; }
    if (draft.enrichment === 'price') return { clarification: `¿Cuál es el precio de compra en ${draft.product.currency} para ese proveedor?`, missingFields: ['purchasePrice'] };
    if (draft.enrichment === 'supplier') {
      if (draft.supplierRef) {
        const result = await resolver(Contact, context, draft.supplierRef, 'vendor');
        if (result.value) { draft.supplierId = String(result.value._id); draft.enrichment = 'price';
          if (draft.purchasePrice !== undefined) { draft.product.supplierPrices = [{ supplierId: draft.supplierId, purchasePrice: draft.purchasePrice }]; draft.enrichment = 'done'; return { args: draft.product }; }
          return { clarification: `¿Cuál es el precio de compra en ${draft.product.currency} para ${result.value.name}?`, missingFields: ['purchasePrice'] }; }
        return { ...result, selection: { slot: 'productSupplier', candidates: result.candidates || [] } };
      }
      const suppliers = await (options.listSuppliers ? options.listSuppliers(context) : Contact.find({ businessId: context.businessId, type: 'vendor', isActive: true }).select('_id name').sort({ name: 1, _id: 1 }).limit(5).lean().maxTimeMS(5000));
      return { clarification: 'Elige un proveedor existente o escribe parte de su nombre.', selection: { slot: 'productSupplier', candidates: suppliers } };
    }
    return { clarification: 'Puedes elegir un proveedor existente o continuar sin proveedor. Crear proveedores desde el asistente todavía no está habilitado.', suggestions: [
      { label: 'Elegir proveedor', message: 'Elegir proveedor' }, { label: 'Continuar sin proveedor', message: 'Continuar sin proveedor' }] };
  }
  if (draft.selection?.candidates?.length) return { clarification: 'Elige una opción de la lista; también puedes indicar el SKU o corregir la búsqueda.', selection: draft.selection };
  return resolveAction(draft, context, resolver, options.supplierLookup || configuredSuppliers);
}
function applyResolution(draft, result, now) {
  delete draft.missingFields; delete draft.itemIndex;
  if (result.selection) {
    draft.selection = { ...result.selection, candidates: result.selection.candidates.map(compactCandidate) };
    draft.missingFields = [result.selection.slot];
    if (result.selection.index !== undefined) draft.itemIndex = result.selection.index;
  }
  if (result.missingFields) draft.missingFields = result.missingFields;
  if (result.itemIndex !== undefined) draft.itemIndex = result.itemIndex;
  draft.updatedAt = now; draft.expiresAt = now + TTL_MS;
  const candidates = suggestionsFor(draft.selection);
  return { ...result,
    ...(candidates.length && result.clarification ? { clarification: `${result.clarification}\n${candidates.map(option => option.label).join('\n')}` } : {}),
    suggestions: [...candidates, ...(result.suggestions || [])] };
}
module.exports = { TTL_MS, compactDraft, updateDraft, resolveDraft, applyResolution };
