const { llmObservation, safeText } = require('./responses');

const SYNTHESIS_SCHEMA = { type: 'OBJECT', additionalProperties: false,
  properties: { sections: { type: 'ARRAY', items: { type: 'INTEGER' } } }, required: ['sections'] };
const SYNTHESIS_INSTRUCTION = 'Ordena todas las secciones verificadas para un resumen breve en español con 2–4 prioridades. Actual e histórico separados; catálogo primero. No inventes ni repitas DTOs. Devuelve solo sections; en reposición incluye forecast.';

const fieldCount = value => value && typeof value === 'object'
  ? Object.values(value).reduce((sum, item) => sum + fieldCount(item), 0) : 1;

/** Only verified aggregates and up to three relevant products, never conversation history.
 * Section indices preserve the existing grounded response contract (no free-form facts).
 */
const buildSynthesisInput = (intent, message, results) => {
  let payload;
  let selectedItemsCount = 0;
  if (intent === 'business_summary') {
    payload = {};
    results.forEach(({ skillId, result }, section) => {
      const { data, metadata } = result;
      if (skillId === 'get_business_summary') {
        const amounts = rows => rows.map(({ currency, amount }) => ({ currency, amount }));
        const activity = { section, period: metadata.period,
          completedSalesCount: data.sales.completedTransactionsCount,
          salesByCurrency: amounts(data.sales.amountsByCurrency),
          completedPurchasesCount: data.purchases.completedTransactionsCount,
          purchasesByCurrency: amounts(data.purchases.amountsByCurrency) };
        if (metadata.periodMode === 'latest') payload.historicalContext = activity;
        else {
          payload.catalog = { activeProducts: data.activeProducts, lowStockCount: data.lowStockProducts };
          payload.activity = activity;
        }
      } else if (skillId === 'get_low_stock_products') {
        const items = data.slice(0, 3).map(row => ({ sku: safeText(row.sku).slice(0, 60),
          label: safeText(row.name).slice(0, 60), stock: row.stock, minStock: row.minStockLevel, deficit: row.shortage }));
        selectedItemsCount = items.length;
        payload.lowStock = { section, items };
      }
    });
  } else {
    payload = results.map(({ skillId, result }, section) => ({ section, ...llmObservation(skillId, result) }));
    selectedItemsCount = results.reduce((sum, { result }) => sum + (Array.isArray(result.data) ? Math.min(3, result.data.length) : 0), 0);
  }
  const messages = intent === 'business_summary' ? [] : [{ role: 'user', text: safeText(message) }];
  messages.push({ role: 'user', text: JSON.stringify(payload) });
  return { schema: SYNTHESIS_SCHEMA, systemInstruction: SYNTHESIS_INSTRUCTION, messages,
    diagnostics: { evidenceCount: results.length, selectedItemsCount, dtoFieldCount: fieldCount(payload) } };
};

module.exports = { buildSynthesisInput };
