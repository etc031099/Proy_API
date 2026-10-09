const { Product, Contact } = require('../models');
const { fail } = require('./contracts');
const { normalizeSku } = require('../utils/sku');
const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/litro y medio/g, '1.5 l').replace(/\blitros?\b/g, 'l')
  .replace(/([a-z])(\d)/g, '$1 $2')
  .replace(/(\d)\s*(ml|kg|l)\b/g, '$1 $2').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const compact = value => normalize(value).replace(/\s/g, '');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const distance = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
};
// Conservative suffix handling is matching-only, never a persistent alias.
const stem = token => token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token;
function createRanking(ref, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 5 !== 0) fail('ACTION_VALIDATION_FAILED');
  const query = compact(ref), words = normalize(ref).split(' ').map(stem);
  let total = 0, exactCount = 0;
  const ranked = [], exactRows = [];
  const compare = (a, b) => b.score - a.score || String(a.value._id).localeCompare(String(b.value._id));
  const retain = (list, item) => {
    list.push(item); list.sort(compare);
    if (list.length > offset + 5) list.pop();
  };
  return {
    add(value) {
      if (!query) return;
      const name = compact(value.name), sku = compact(value.sku || '');
      const exact = query === name || query === sku;
      const tokens = normalize(value.name).split(' ').map(stem);
      const coverage = words.filter(word => tokens.some(token => token === word || (word.length >= 4 && distance(word, token) <= 1))).length / words.length;
      const similarity = 1 - distance(query, name) / Math.max(query.length, name.length, 1);
      const score = exact ? 1 : name.includes(query) || sku.includes(query) ? 0.9 : Math.max(coverage * 0.85, similarity);
      if (score < 0.72) return;
      const item = { value, exact, score };
      total++; retain(ranked, item);
      if (exact) { exactCount++; retain(exactRows, item); }
    },
    result() {
      if (exactCount === 1) return { confidence: 'EXACT', value: exactRows[0].value };
      const totalMatches = exactCount || total;
      // Clamp a page when products changed since the preceding turn.
      const currentOffset = Math.min(offset, Math.max(0, Math.ceil(totalMatches / 5) - 1) * 5);
      const candidates = (exactCount ? exactRows : ranked).slice(currentOffset, currentOffset + 5).map(item => item.value);
      // >= .72 is only a candidate; >= .85 with exactly one match is high confidence.
      // Both fuzzy levels still require a human selection, never write authority.
      return { confidence: totalMatches === 0 ? 'NOT_FOUND' : totalMatches === 1 && ranked[0].score >= 0.85 ? 'HIGH_CONFIDENCE' : 'AMBIGUOUS', candidates,
        pagination: { query: ref, offset: currentOffset, limit: 5, totalMatches, hasMore: currentOffset + 5 < totalMatches, hasPrevious: currentOffset > 0 } };
    }
  };
}
function rankEntities(rows, ref, offset = 0) {
  const ranking = createRanking(ref, offset);
  rows.forEach(value => ranking.add(value));
  return ranking.result();
}
async function resolveReference(model, context, ref, type, offset = 0) {
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 100 || /[\x00-\x1f]/.test(ref)) fail('ACTION_VALIDATION_FAILED');
  const fields = model === Product ? '_id sku name currency stock isActive supplierPrices' : '_id name isActive';
  const scope = { businessId: context.businessId, ...(type ? { type } : {}) };
  const identity = /^[a-f\d]{24}$/i.test(ref) ? [{ _id: ref }] : [
    ...(model === Product ? [{ sku: normalizeSku(ref) }] : []), { name: new RegExp(`^${escapeRegex(ref.trim())}$`, 'i') }];
  const exact = await model.find({ ...scope, $or: identity }).select(fields).limit(2).lean().maxTimeMS(5000);
  const sku = model === Product && exact.find(row => row.sku === normalizeSku(ref));
  if (sku) return { confidence: 'EXACT', value: sku };
  if (model === Product && exact.length === 2) {
    const skuRows = await model.find({ ...scope, sku: normalizeSku(ref) }).select(fields).limit(1).lean().maxTimeMS(5000);
    if (skuRows.length) return { confidence: 'EXACT', value: skuRows[0] };
  }
  if (exact.length === 1 && /^[a-f\d]{24}$/i.test(ref)) return { confidence: 'EXACT', value: exact[0] };
  if (/^[a-f\d]{24}$/i.test(ref)) return { confidence: 'NOT_FOUND', candidates: [], clarification: 'No encontré ese identificador en este negocio.' };
  // Fuzzy normalization requires a tenant-scoped cursor. Count matches in one
  // pass and retain only the ranked prefix needed for this page, never all docs.
  const ranking = createRanking(ref, offset);
  const candidateFields = model === Product ? '_id sku name currency stock isActive' : fields;
  for await (const value of model.find(scope).select(candidateFields).sort({ _id: 1 }).maxTimeMS(5000).cursor()) {
    ranking.add(value.toObject ? value.toObject() : value);
  }
  const result = ranking.result();
  if (result.value && model === Product) {
    // Load supplier costs only for the single resolved product, not every match.
    const selected = await model.find({ ...scope, _id: result.value._id }).select(fields).limit(1).lean().maxTimeMS(5000);
    if (!selected.length) return { confidence: 'NOT_FOUND', candidates: [], clarification: 'El producto ya no está disponible en este negocio.' };
    result.value = selected[0];
  }
  return result.value ? result : { ...result, clarification: result.candidates.length
    ? result.candidates.length === 1 ? `Creo que te refieres a ${result.candidates[0].name}. ¿Es correcto?`
      : 'Encontré varias coincidencias. Elige la opción correcta.'
    : `No encontré ${model === Product ? 'un producto' : type === 'vendor' ? 'un proveedor' : 'un cliente'} parecido a «${ref}» en este negocio. Prueba otra parte del nombre${model === Product ? ' o su SKU' : ''}.` };
}
async function configuredSuppliers(products, context) {
  const lists = products.map(product => (product.supplierPrices || []).filter(row => Number.isFinite(row.purchasePrice)));
  const ids = lists[0]?.map(row => String(row.supplierId)).filter(id => lists.every(list => list.some(row => String(row.supplierId) === id))) || [];
  const suppliers = await Contact.find({ businessId: context.businessId, type: 'vendor', isActive: true, _id: { $in: ids } })
    .select('_id name').sort({ name: 1, _id: 1 }).limit(5).lean().maxTimeMS(5000);
  return suppliers.map(supplier => ({ ...supplier, costs: products.map(product => ({ sku: product.sku,
    currency: product.currency, purchasePrice: product.supplierPrices.find(row => String(row.supplierId) === String(supplier._id)).purchasePrice })) }));
}
module.exports = { normalize, rankEntities, resolveReference, configuredSuppliers };
