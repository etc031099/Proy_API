const { isDate } = require('./contracts');

const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const monthPeriod = (now, previous = false) => {
  const month = now.getUTCMonth() - (previous ? 1 : 0);
  return { startDate: new Date(Date.UTC(now.getUTCFullYear(), month, 1)).toISOString().slice(0, 10),
    endDate: new Date(Date.UTC(now.getUTCFullYear(), month + 1, 0)).toISOString().slice(0, 10) };
};
const clarify = question => ({ intent: 'ambiguous_query', agent: 'coordinator', clarificationQuestion: question });
const routeCommercial = (message, memory = {}) => {
  const text = normalize(message);
  if (/shell|ejecuta codigo|mongo query|ignora.*instruccion|api.?key|password|jwt|system prompt/.test(text)) return null;
  const sku = message.match(/\bM5-[A-Z]+_\d+_\d+\b/i)?.[0];
  const explicitSupplier = message.match(/\b(?:con|usando)\s+(?:el\s+)?(?:proveedor|supplier)\s+(.+?)(?=\s+(?:para|por)\s+(?:reponer|el producto)|[?!.]|$)/i)?.[1]?.trim()
    || message.match(/\bproveedor\s+(?!deber[ií]a\b|debe\b|usar\b|conviene\b)(.+?)(?=\s+(?:para|por)\s+(?:reponer|el producto)|[?!.]|$)/i)?.[1]?.trim()
    || message.match(/\b(?:con|usando)\s+(?:el|la)\s+(.+?)(?=\s+(?:para|por)\s+(?:reponer|el producto)|[?!.]|$)/i)?.[1]?.trim();
  const currency = /\bUSD|\$|dolares?\b/i.test(message) ? 'USD'
    : /\bEUR|€|euros?\b/i.test(message) ? 'EUR' : /\bS\s*\/|\bPEN\b/i.test(message) ? 'PEN' : null;
  const department = message.match(/\b(?:FOODS|HOBBIES|HOUSEHOLD)_\d+\b/i)?.[0]?.toUpperCase();
  const make = (skillId, args) => ({ intent: 'replenishment_commercial', agent: 'analyst', skillId, args });
  const asksSupplierComparison = /proveedor/.test(text)
    && /que proveedor|cual proveedor|usar|conviene|barat|compar/.test(text);
  if (asksSupplierComparison) {
    const productRef = sku || (/este producto|ese producto|este sku/.test(text) ? memory.lastEntity?.sku : null);
    if (!productRef) return { intent: 'replenishment_budget_required', agent: 'coordinator',
      clarificationQuestion: 'Indica el SKU del producto para comparar sus proveedores configurados.' };
    return make('compare_supplier_costs', { productRef, ...(explicitSupplier ? { supplierRef: explicitSupplier } : {}) });
  }
  const amountMatch = message.match(/(?:S\s*\/|PEN|USD|EUR|\$|€)\s*([\d.,]+)/i);
  const hasBudgetIntent = /tengo|presupuesto|que puedo reponer|que productos deberia comprar|que debo comprar/.test(text);
  if (amountMatch && hasBudgetIntent) {
    const raw = amountMatch[1];
    const normalizedAmount = raw.includes(',') && raw.includes('.') && raw.lastIndexOf(',') > raw.lastIndexOf('.')
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.includes(',') && !raw.includes('.') && /,\d{1,2}$/.test(raw) ? raw.replace(',', '.') : raw.replace(/,/g, '');
    const budget = Number(normalizedAmount);
    if (!Number.isFinite(budget) || budget <= 0) return { intent: 'replenishment_budget_required', agent: 'coordinator',
      clarificationQuestion: 'Indica un presupuesto positivo en soles para preparar una propuesta.' };
    if (currency !== 'PEN') return { intent: 'replenishment_budget_required', agent: 'coordinator',
      clarificationQuestion: 'La planificación inicial solo admite presupuestos en PEN (S/). No convertiré monedas automáticamente.' };
    return make('plan_replenishment_budget', { budget, currency: 'PEN', ...(department ? { department } : {}) });
  }
  if (/prioriza.*(compras|reponer)|que comprar primero/.test(text)) return {
    intent: 'replenishment_budget_required', agent: 'coordinator',
    clarificationQuestion: 'Puedo priorizar una propuesta de compra. ¿Qué presupuesto tienes disponible en soles (S/)?'
  };
  const total = /todo|todos|todas|total|cubrir|presupuesto necesito/.test(text);
  const costIntent = /cuanto|costaria|costo|cuesta|presupuesto/.test(text)
    && /reponer|reposicion|rep(o|u)ner|recomendad|reponer todo|productos reponer/.test(text);
  if (costIntent) {
    if (sku || /este producto|ese producto/.test(text)) {
      const productRef = sku || memory.lastEntity?.sku;
      if (!productRef) return { intent: 'replenishment_budget_required', agent: 'coordinator',
        clarificationQuestion: 'Indica el SKU del producto para calcular su costo de reposición.' };
      return make('get_replenishment_cost', { mode: 'single', productRef, ...(explicitSupplier ? { supplierRef: explicitSupplier } : {}) });
    }
    if (total) return make('get_replenishment_cost', { mode: 'total', ...(department ? { department } : {}) });
    return { intent: 'replenishment_budget_required', agent: 'coordinator',
      clarificationQuestion: '¿Quieres calcular el costo de un producto? Indica su SKU, o dime si deseas el total de toda la reposición recomendada.' };
  }
  return null;
};
const PERIOD_INTENTS = ['sales_summary', 'top_selling_products', 'product_sales_summary', 'recent_transactions'];
const ordinalReference = text => {
  if (/\bel de arriba\b/.test(text)) return { matched: true, index: 0 };
  const ordinalPattern = '(primer(?:o|a)?|segund[oa]|tercer(?:o|a)?|cuart[oa]|quint[oa]|sext[oa]|ultim[oa])';
  const match = text.match(new RegExp(`\\b(?:el|la|ese|esa)\\s+${ordinalPattern}(?:\\s+(?:producto|de la lista))?\\b`))
    || text.match(new RegExp(`\\b${ordinalPattern}\\s+(?:producto|de la lista)\\b`));
  if (!match) return { matched: false };
  const ordinal = match[1];
  const indices = { primer: 0, primero: 0, primera: 0, segundo: 1, segunda: 1,
    tercer: 2, tercero: 2, tercera: 2, cuarto: 3, cuarta: 3, quinto: 4, quinta: 4,
    sexto: 5, sexta: 5, ultimo: -1, ultima: -1 };
  return { matched: true, index: indices[ordinal] };
};

/** High-confidence routing only. Unrecognized language is delegated, never guessed. */
const routeDeterministically = (message, memory, now) => {
  const commercialPlan = routeCommercial(message, memory);
  if (commercialPlan) return commercialPlan;
  const forecastPlan = require('./forecastRouting').routeForecastAnalytics(message, memory);
  if (forecastPlan) return forecastPlan;
  const text = normalize(message);
  const dates = message.match(/\d{4}-\d{2}-\d{2}/g);
  if (!dates && /ayer|semana|ano pasado|hoy/.test(text) && /venta|vendi/.test(text)) return clarify('Indica el periodo con dos fechas YYYY-MM-DD o usa este mes / mes pasado.');
  if (dates && (dates.length !== 2 || !dates.every(isDate) || dates[0] > dates[1])) return clarify('Indica un periodo válido con dos fechas YYYY-MM-DD.');
  const explicitPeriod = dates ? { startDate: dates[0], endDate: dates[1] }
    : /mes pasado|mes anterior/.test(text) ? monthPeriod(now, true)
      : /este mes|mes actual/.test(text) ? monthPeriod(now) : undefined;
  const period = explicitPeriod || (memory.lastPeriodExplicit === true ? memory.lastPeriod : undefined) || monthPeriod(now);
  if (/\b(crea|crear|compra|comprar|borra|elimina|editar|actualiza|cancelar)\b|shell|ejecuta codigo|mongo query|ignora.*instruccion|api.?key|password|jwt/.test(text)) {
    return { intent: 'unsupported', agent: 'coordinator' };
  }
  const ordinal = ordinalReference(text);
  if (ordinal.matched) {
    const selection = memory.lastProductSelection;
    const index = ordinal.index === -1 ? (selection?.items?.length || 0) - 1 : ordinal.index;
    const selected = selection?.items?.[index];
    if (!selected) return clarify('No encuentro ese producto en la última lista. ¿Puedes indicarme su SKU o elegir otro de los productos mostrados?');
    const selector = { productId: selected.id };
    const hasSalesIntent = /vendio|vendido|ventas/.test(text);
    if (hasSalesIntent) return { intent: 'product_sales_summary', agent: 'operations', selector,
      period: explicitPeriod || (memory.lastPeriodExplicit === true ? memory.lastPeriod : undefined) || monthPeriod(now),
      periodExplicit: Boolean(explicitPeriod || memory.lastPeriodExplicit === true), limit: 1 };
    if (/explica|por que/.test(text) && /repon|reposicion/.test(text)) {
      return { intent: 'explain_replenishment', agent: 'analyst', selector, synthesize: true, limit: 1 };
    }
    if (/demanda|prediccion|forecast/.test(text)) return { intent: 'demand_forecast', agent: 'analyst', selector, limit: 1 };
    return { intent: 'product_details', agent: 'operations', selector, limit: 1 };
  }
  if (/muestrame mas|mostrar mas/.test(text)) {
    const limits = { low_stock: 20, recent_transactions: 20, search_product: 20, top_selling_products: 10, replenishment_candidates: 20 };
    if (!limits[memory.lastIntent] || (memory.listLimit || 5) >= limits[memory.lastIntent]) return clarify('Indica un filtro más específico; no puedo ampliar esta lista más allá de su límite.');
    return { intent: memory.lastIntent, agent: memory.lastAgent, period,
      ...(memory.lastIntent === 'recent_transactions' ? memory.lastTransactionFilters || {} : {}),
      limit: Math.min(limits[memory.lastIntent], (memory.listLimit || 5) * 2), more: true };
  }
  if (/^(y )?(el )?mes (pasado|anterior)[?.!\s]*$/.test(text.replace(/[¿?]/g, '').trim())) {
    if (!PERIOD_INTENTS.includes(memory.lastIntent)) return clarify('¿Qué información deseas consultar del mes pasado?');
    if (memory.lastIntent === 'product_sales_summary' && !memory.lastEntity) return clarify('¿Qué producto deseas consultar del mes pasado?');
    return { intent: memory.lastIntent, agent: memory.lastAgent, period,
      ...(memory.lastIntent === 'recent_transactions' ? { ...memory.lastTransactionFilters, periodRequested: true } : {}),
      ...(memory.lastIntent === 'product_sales_summary' ? { selector: { productId: memory.lastEntity.id } } : {}), limit: memory.listLimit || 5 };
  }
  let plan;
  if (/stock bajo|poco stock|bajo stock|stock minimo/.test(text)) plan = { intent: 'low_stock', agent: 'operations' };
  else if (/transacciones.*(ultim|recient)|(ultim|recient).*transacciones/.test(text)) plan = { intent: 'recent_transactions', agent: 'operations' };
  else if (/mas vendidos|mayores ventas|se venden mas/.test(text)) plan = { intent: 'top_selling_products', agent: 'analyst' };
  else if (/vendimos|ventas del mes/.test(text)) plan = { intent: 'sales_summary', agent: 'operations' };
  else if (/vendio|cuanto.*vendido/.test(text)) plan = { intent: 'product_sales_summary', agent: 'operations', needsProduct: true };
  else if (/explica|por que/.test(text) && /repon|reposicion/.test(text)) plan = { intent: 'explain_replenishment', agent: 'analyst', needsProduct: true, synthesize: true };
  else if (/repon|reposicion/.test(text)) plan = { intent: 'replenishment_candidates', agent: 'analyst', limit: /mayor|mas reposicion/.test(text) ? 1 : 5 };
  else if (/prediccion|demanda|forecast/.test(text)) plan = { intent: 'demand_forecast', agent: 'analyst', needsProduct: /producto|\bsu\b|ese|sku/.test(text) };
  else if (/resume|resumen|estado.*negocio/.test(text)) plan = { intent: 'business_summary', agent: 'analyst', multi: /vigilar|atencion/.test(text), synthesize: /vigilar|atencion/.test(text) };
  else if (/busca|buscar/.test(text) && /producto|sku/.test(text)) plan = { intent: 'search_product', agent: 'operations' };
  else if (/producto|sku/.test(text)) plan = { intent: 'product_details', agent: 'operations', needsProduct: true };
  else return null;
  const sku = message.match(/\bSKU\s+([\w.-]{1,100})/i)?.[1]
    || message.match(/\b((?:SKU|M5)-[\w.-]{1,96})\b/i)?.[1];
  const productId = message.match(/\b[a-f\d]{24}\b/i)?.[0];
  const query = message.replace(/^.*?(?:producto[s]?|sku)\s*/i, '').trim().replace(/[?!.]+$/, '').slice(0, 100);
  if (plan.intent === 'search_product') {
    if (!query) return clarify('¿Qué nombre o SKU deseas buscar?');
    plan.query = query;
  }
  if (plan.intent === 'recent_transactions') {
    plan.periodRequested = Boolean(dates || /este mes|mes actual|mes pasado|mes anterior/.test(text));
    plan.type = /\bventas?\b/.test(text) ? 'sale' : /\bcompras?\b/.test(text) ? 'purchase' : undefined;
    plan.status = /completad/.test(text) ? 'completed' : /pendient/.test(text) ? 'pending' : /cancelad/.test(text) ? 'cancelled' : undefined;
  }
  if (sku && plan.intent === 'replenishment_candidates') { plan.intent = 'demand_forecast'; plan.needsProduct = true; }
  const nameTarget = message.match(/(?:demanda\s+(?:tendr[aá]|de|para)|predicci[oó]n\s+(?:de|para))\s+(.+?)[?.!]*$/i)?.[1];
  if (!sku && !productId && plan.intent === 'demand_forecast' && nameTarget && !/^(ese|este|su|el) producto/i.test(nameTarget)) {
    return { ...plan, lookupQuery: nameTarget.slice(0, 100).replace(/[?!.]+$/, ''), period, limit: 5 };
  }
  if (productId) plan.selector = { productId };
  else if (sku) plan.selector = { sku };
  else if (plan.needsProduct) {
    if (plan.intent === 'product_details' && query && !/\b(ese|este) producto\b|\bsu producto\b/.test(text)) {
      return { intent: 'search_product', agent: 'operations', query, period, limit: 5 };
    }
    if (/producto\s+\S+/.test(text) && !/\b(ese|este) producto\b|\bsu producto\b/.test(text)) return clarify('¿A qué producto te refieres? Puedes indicarme su SKU o elegirlo de la lista anterior.');
    if (memory.lastEntity) plan.selector = { productId: memory.lastEntity.id };
    else return clarify('¿A qué producto te refieres? Puedes indicarme su SKU o elegirlo de la lista anterior.');
  }
  if (plan.intent === 'top_selling_products') {
    const continuesPeriod = /^(y ahora|ahora|y tambien|tambien)\b/.test(text) && memory.lastPeriodExplicit === true;
    const rankingPeriod = explicitPeriod || (continuesPeriod ? memory.lastPeriod : undefined);
    return { ...plan, ...(rankingPeriod ? { period: rankingPeriod } : {}),
      periodExplicit: Boolean(explicitPeriod || continuesPeriod), periodMode: rankingPeriod ? 'bounded' : 'all_history',
      limit: plan.limit || 5 };
  }
  return { ...plan, period, periodExplicit: Boolean(explicitPeriod), limit: plan.limit || 5 };
};

module.exports = { routeDeterministically, routeCommercial, monthPeriod, clarify };
