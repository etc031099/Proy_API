const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const productListFollowupType = message => {
  const text = normalize(message);
  const refersToList = /\b(?:esos|esas|estos|estas|los anteriores|las anteriores|los que mostraste|las que mostraste|esa lista|esos productos|estas recomendaciones)\b/.test(text);
  if (/\b(?:explicame|explica)\b/.test(text) && /\b(?:ese|este) producto\b/.test(text)) return 'explain_selected';
  if (/\b(?:cual|que producto)\b/.test(text) && /\b(?:menos|menor) stock\b/.test(text)) return 'min_stock';
  if (/\b(?:cual|que producto)\b/.test(text) && /\b(?:mas|mayor) stock\b/.test(text)) return 'max_stock';
  if (/\b(?:cual|que producto)\b/.test(text) && /\b(?:mayor|mas) demanda\b/.test(text)) return 'max_demand';
  if (/\b(?:cual|que producto)\b/.test(text) && /\b(?:mas|mayor) reposicion\b/.test(text)) return 'max_replenishment';
  if (refersToList && /\bcuantos\b/.test(text) && /\breponer\b/.test(text)) return 'count_replenish';
  if (refersToList && /\bcuales\b/.test(text) && /\breponer\b/.test(text)) return 'filter_replenish';
  return null;
};

const fieldFor = Object.freeze({ min_stock: 'stock', max_stock: 'stock', max_demand: 'predictedDemand',
  max_replenishment: 'recommendedQty', count_replenish: 'status', filter_replenish: 'status' });
const format = value => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2))).replace('.', ',');
const labelOf = row => row.sku || row.label || 'Producto';

const resolveProductListFollowup = (type, selection) => {
  if (!selection || selection.semanticReference !== 'last_product_list' || !Array.isArray(selection.items)
    || !selection.items.length || selection.items.length > 5) {
    return { clarificationQuestion: 'No tengo una lista de productos previa en esta conversación. Muéstrame una lista y podré compararlos.' };
  }
  const rows = selection.items;
  if (type === 'explain_selected') {
    const selected = selection.selectedProductReference;
    if (!selected) return { clarificationQuestion: 'Aún no hay un producto seleccionado de esa lista. Dime cuál quieres revisar.' };
    return { selectedProduct: selected, clarificationQuestion: null };
  }
  if (type === 'count_replenish' || type === 'filter_replenish') {
    if (rows.some(row => !row.status)) return { needsLookup: 'status' };
    const matches = rows.filter(row => row.status === 'REPONER');
    if (type === 'count_replenish') return { answer: `${matches.length} de ${rows.length} productos de esa lista están en estado REPONER.` };
    if (!matches.length) return { answer: 'Ninguno de los productos de esa lista está en estado REPONER.' };
    return { answer: `De esa lista están en REPONER: ${matches.map(row => `${labelOf(row)} (${row.name || row.label || 'sin nombre'})`).join(', ')}.` };
  }
  const field = fieldFor[type];
  if (!field || rows.some(row => !Number.isFinite(row[field]))) return { needsLookup: field || null };
  const targetValue = (type === 'min_stock' ? Math.min : Math.max)(...rows.map(row => row[field]));
  const winners = rows.filter(row => row[field] === targetValue);
  if (winners.length > 1) return { answer: `Hay un empate: ${winners.map(labelOf).join(', ')} tienen ${format(targetValue)}${field === 'stock' ? ' unidades de stock' : field === 'predictedDemand' ? ' unidades de demanda prevista' : ' unidades de reposición sugerida'}.` };
  const selectedProduct = winners[0];
  const metric = field === 'stock' ? 'unidades disponibles' : field === 'predictedDemand' ? 'unidades de demanda prevista' : 'unidades de reposición sugerida';
  return { selectedProduct, answer: `${labelOf(selectedProduct)} (${selectedProduct.name || selectedProduct.label || 'producto'}) es el que ${type === 'min_stock' ? 'tiene menos stock' : type === 'max_stock' ? 'tiene más stock' : type === 'max_demand' ? 'tiene mayor demanda prevista' : 'necesita más reposición'}, con ${format(targetValue)} ${metric}.` };
};

module.exports = { productListFollowupType, resolveProductListFollowup };
