const { isDate } = require('./contracts');
const { productListFollowupType, resolveProductListFollowup } = require('./productListFollowups');
const { parseRequestedDate } = require('./forecastRouting');
const { ordinalSelection } = require('./ordinalSelection');

const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const tenantScopeViolation = message => {
  const text = normalize(message).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const scopes = '(?:negocio|empresa|usuario|tenant|business|cuenta|cliente|negocios|empresas|usuarios|tenants|businesses|cuentas)';
  const crossTenantTarget = new RegExp(`\\b(?:otro|otra|otros|otras|ajeno|ajena|ajenos|ajenas|distinto|distinta|diferente|demas)\\s+${scopes}\\b`).test(text)
    || new RegExp(`\\b(?:todos|todas|cada|cualquier)\\s+(?:(?:los|las)\\s+)?${scopes}\\b`).test(text)
    || new RegExp(`\\b(?:negocio|empresa|usuario|tenant|business|cuenta)\\s+de\\s+(?:otro|otra|algun\\s+otro|otra persona)\\b`).test(text)
    || new RegExp(`\\b(?:de|del)\\s+(?:(?:negocio|empresa|business|cuenta)\\s+)?(?:otro|otra|otros|otras|todos|todas|cualquier|demas)\\s+${scopes}\\b`).test(text)
    || new RegExp(`\\b(?:ventas?|inventario|datos|informacion|productos?|transacciones?)\\s+(?:de|del)\\s+(?:otro|otra|otros|otras|todos|todas|cualquier|demas)\\s+${scopes}\\b`).test(text);
  if (!crossTenantTarget) return null;
  return { intent: 'tenant_access_denied', agent: 'coordinator' };
};
const normalizeBasicInventory = value => normalize(value)
  .replace(/\bq\b/g, 'que')
  .replace(/\bstan\b/g, 'estan')
  .replace(/\bq(?=\s+(?:productos?|stock)\b)/g, 'que')
  .replace(/\bd(?=\s+(?:stock|stok)\b)/g, 'de')
  .replace(/\bd(?=\s+esos?\b)/g, 'de')
  .replace(/\bvajos\b/g, 'bajos')
  .replace(/\bstok\b/g, 'stock')
  .replace(/\bnesesita\b/g, 'necesita')
  .replace(/\bnesesitan\b/g, 'necesitan')
  .replace(/\breposision\b/g, 'reposicion')
  .replace(/\bprodcutos\b/g, 'productos');
const isLowStockQuery = text => /\b(?:stock\s+bajo|bajo\s+stock|poco\s+stock|stock\s+minimo)\b/.test(text)
  || /\bproductos?\b.*\b(?:baj[oa]s?\s+(?:de\s+)?stock|por\s+debajo\s+(?:del\s+)?minimo)\b/.test(text);
const isProductCountQuery = text => {
  if (/\b(?:busca|buscar|muestrame|lista|listar|categoria|sku|foods|hobbies|household)\b/.test(text)) return false;
  return /\b(?:cuantos|cantidad|total)\b.*\bproductos?\b/.test(text)
    || /\bproductos?\s+(?:activos?\s+)?(?:tengo|hay|registrados?)\b/.test(text);
};
const monthPeriod = (now, previous = false) => {
  const month = now.getUTCMonth() - (previous ? 1 : 0);
  return { startDate: new Date(Date.UTC(now.getUTCFullYear(), month, 1)).toISOString().slice(0, 10),
    endDate: new Date(Date.UTC(now.getUTCFullYear(), month + 1, 0)).toISOString().slice(0, 10) };
};
const weekPeriod = (now, weeksAgo = 0, elapsedDays = null) => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = today - ((now.getUTCDay() + 6) % 7) * 86400000 - weeksAgo * 7 * 86400000;
  const end = monday + Math.max(0, (elapsedDays ?? (weeksAgo === 0 ? Math.floor((today - monday) / 86400000) : 6))) * 86400000;
  return { startDate: new Date(monday).toISOString().slice(0, 10), endDate: new Date(end).toISOString().slice(0, 10) };
};
const weekElapsedDays = period => Math.round((Date.parse(`${period.endDate}T00:00:00Z`) - Date.parse(`${period.startDate}T00:00:00Z`)) / 86400000);
// Operational periods share the UTC calendar-day convention used by existing
// week/month helpers and the sales executor's inclusive UTC date filter.
const dayPeriod = (now, daysAgo = 0) => {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysAgo * 86400000;
  const date = new Date(day).toISOString().slice(0, 10);
  return { startDate: date, endDate: date };
};
const rollingPeriod = (now, days) => {
  const endDate = dayPeriod(now).endDate;
  const startDate = new Date(Date.parse(`${endDate}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { startDate, endDate };
};
const relativeSalesPeriod = (text, now) => {
  if (/\banteayer\b/.test(text)) return dayPeriod(now, 2);
  if (/\bayer\b/.test(text)) return dayPeriod(now, 1);
  if (/\bhoy\b/.test(text)) return dayPeriod(now);
  if (/\bultimos?\s+7\s+dias\b/.test(text)) return rollingPeriod(now, 7);
  if (/\bultimos?\s+30\s+dias\b/.test(text)) return rollingPeriod(now, 30);
  if (/\bsemana pasada|semana anterior\b/.test(text)) return weekPeriod(now, 1);
  if (/\besta semana\b/.test(text)) return weekPeriod(now);
  if (/\bmes pasado|mes anterior\b/.test(text)) return monthPeriod(now, true);
  if (/\beste mes|mes actual\b/.test(text)) return monthPeriod(now);
  return undefined;
};
const previousEqualPeriod = period => {
  const days = Math.round((Date.parse(`${period.endDate}T00:00:00Z`) - Date.parse(`${period.startDate}T00:00:00Z`)) / 86400000) + 1;
  const end = Date.parse(`${period.startDate}T00:00:00Z`) - 86400000;
  return { startDate: new Date(end - (days - 1) * 86400000).toISOString().slice(0, 10),
    endDate: new Date(end).toISOString().slice(0, 10) };
};
const clarify = question => ({ intent: 'ambiguous_query', agent: 'coordinator', clarificationQuestion: question });
const canonicalProductSku = message => message.match(/\bM5-[A-Z]+_\d+_\d+\b/i)?.[0]
  || message.match(/\bSKU\s+([\w.-]{1,100})\b/i)?.[1];
const explicitProductDetailQuery = message => {
  const text = normalize(message).replace(/[¿?¡!]/g, '').trim();
  const target = text.match(/\b(?:cuanto|cuanta)\s+(?:stock|inventario|precio|minimo)\s+(?:tiene|cuesta|es)\s+(?:el\s+)?(?:producto\s+)?(.+?)\s*$/)?.[1]
    || text.match(/^(?:y\s+)?(?:cual\s+es\s+)?(?:el\s+|la\s+)?(?:stock\s+minimo|precio|stock|minimo|prediccion|forecast|esta\s+activ[oa])\s+(?:(?:de|del|para)\s+)?(?:el\s+)?(?:producto\s+)?(.+?)\s*$/)?.[1];
  if (!target || canonicalProductSku(message)) return null;
  const cleaned = target.replace(/[.,;:]+$/, '').trim();
  if (!cleaned || /^(?:bajo|actual|minimo)$/.test(cleaned) || ordinalSelection(cleaned).matched || /^(?:ese|este|aquel|su|mismo|misma)\b/.test(cleaned)
    || /\b(?:ayer|hoy|manana|anteayer)\b/.test(cleaned)
    || /^(?:esta|este|la|el|proxima|proximo|pasada|pasado)\s+(?:semana|mes|ano)\b/.test(cleaned)) return null;
  return cleaned;
};
const productReferenceFollowup = (message, memory = {}) => {
  const text = normalize(message).replace(/[¿?¡!]/g, '').trim();
  if (canonicalProductSku(message) || /\bSKU-[\w.-]{1,100}\b/i.test(message)) return null;
  const referentialLanguage = /\b(?:reponerlo|reponerla|comprarlo|comprarla|venderlo|venderla|ese producto|este producto|este sku|ese sku|el mismo producto|la misma producto|su proveedor|su prediccion|su stock|su precio|su minimo|sus detalles|sus datos)\b/.test(text)
    || /^y\s+(?:cuanto\s+(?:cuesta|costaria)|cual\s+es\s+su\s+proveedor)\b/.test(text)
    || /^(?:y\s+)?(?:cuanto\s+(?:stock|inventario)\s+tiene|(?:el\s+)?precio|(?:el\s+)?minimo|(?:el\s+)?stock\s+minimo|esta\s+activ[oa]?|sus\s+detalles|sus\s+datos)\b/.test(text);
  if (!referentialLanguage) return null;

  const selected = memory.selectedProductReference?.type === 'product' ? memory.selectedProductReference : null;
  const listHasSeveral = (memory.lastProductSelection?.items?.length || 0) > 1;
  const sku = selected?.sku;
  const productId = selected?.id;
  const asksCheapestSupplier = /proveedor/.test(text) && /barat|menor costo|mas economico/.test(text);
  const asksSupplier = /proveedor/.test(text) && !asksCheapestSupplier;
  const asksCost = /cuanto|costaria|costo|cuesta/.test(text) && /repon|reposicion|recomendad/.test(text);
  const asksImplicitCost = /^(?:y\s+)?cuanto\s+(?:cuesta|costaria)\b/.test(text)
    && ['demand_forecast', 'explain_replenishment', 'replenishment_candidates', 'replenishment_commercial'].includes(memory.lastIntent);
  const asksStock = /\bstock\b|\binventario\b/.test(text);
  const asksForecast = /prediccion|forecast|demanda/.test(text);
  const asksPrice = /\bprecio\b/.test(text);
  const asksMinimum = /\bminimo\b/.test(text);
  const asksActive = /\bactiv[oa]?\b/.test(text);
  const asksDetails = /explicame|explica|muestrame|mostrar|detalle|datos|informacion/.test(text)
    && /producto|ese|este|sus/.test(text) || /\bsus\s+(?:detalles|datos)\b/.test(text);
  if (!asksCheapestSupplier && !asksSupplier && !asksCost && !asksImplicitCost && !asksStock
    && !asksForecast && !asksPrice && !asksMinimum && !asksActive && !asksDetails) return null;

  if (!selected) return clarify(listHasSeveral
    ? 'Vimos varios productos y no hay uno seleccionado. ¿Cuál quieres consultar? Indica su SKU o selecciónalo de la lista.'
    : '¿A qué producto te refieres? Indica su SKU o elígelo de la lista anterior.');
  const selector = productId ? { productId } : sku ? { sku } : null;
  const contextProvenance = { sourceType: 'conversation_context', entityType: 'product',
    label: `Producto ${sku || selected.name || 'seleccionado'} resuelto desde el contexto conversacional.` };
  if (asksCheapestSupplier || asksSupplier) {
    if (!sku) return clarify('No tengo el SKU de ese producto para consultar sus proveedores. Indícalo para continuar.');
    return { intent: asksCheapestSupplier ? 'cheapest_supplier' : 'replenishment_commercial', agent: 'analyst',
      skillId: 'compare_supplier_costs', args: { productRef: sku }, entityContextUsed: true };
  }
  if (asksCost || asksImplicitCost) {
    if (!sku) return clarify('No tengo el SKU de ese producto para calcular su costo de reposición. Indícalo para continuar.');
    return { intent: 'replenishment_commercial', agent: 'analyst', skillId: 'get_replenishment_cost',
      args: { mode: 'single', productRef: sku }, entityContextUsed: true };
  }
  if (!selector) return clarify('No puedo identificar de forma segura el producto de esta referencia. Indica su SKU.');
  if (asksForecast) return { intent: 'demand_forecast', agent: 'analyst', selector, limit: 1,
    entityContextUsed: true, contextProvenance };
  return { intent: 'product_details', agent: 'operations', selector, limit: 1,
    entityContextUsed: true, contextProvenance };
};
const budgetPlanFollowupType = message => {
  const text = normalize(message);
  if (/\b(?:cuanto dinero (?:sobra|sobro|me sobra)|cuanto (?:sobro|queda|me queda)|saldo restante|cuanto presupuesto queda)\b/.test(text)) return 'remaining';
  if (/\b(?:cuanto|cuantas) unidades? (?:quedaron|quedo) pendientes?\b|\bcuanto quedo pendiente\b/.test(text)) return 'pending_units';
  if (/\b(?:cuales quedaron pendientes|que quedo pendiente|que productos faltaron|cuales no se pudieron cubrir|que no alcanzo a comprar)\b/.test(text)) return 'pending_items';
  if (/\b(?:cuanto gaste|cuanto se gasto|cuanto se asigno)\b/.test(text)) return 'spent';
  if (/\b(?:cual fue el presupuesto|cuanto fue el presupuesto|que presupuesto teniamos)\b/.test(text)) return 'budget';
  if (/\b(?:cuantas unidades se planificaron|cuantas unidades planificadas|unidades planificadas)\b/.test(text)) return 'planned_units';
  if (/\bque proveedor se usaria para\b/.test(text)) return 'supplier_for_product';
  return null;
};
const routeProductSupplierLookup = (message, memory = {}) => {
  const sku = canonicalProductSku(message) || memory.selectedProductReference?.sku;
  if (!sku) return null;
  const text = normalize(message);
  // An explicitly named supplier followed by "provee SKU" is supplier -> product.
  if (/\bproveedor\s+.+\s+provee\b/.test(text)) return null;
  const asksWhoSupplies = /\b(?:quien|quienes|que proveedores?|cuales proveedores?|proveedor(?:es)? de|provee|proveen|me vende)\b/.test(text);
  if (!asksWhoSupplies) return null;
  return { intent: 'replenishment_commercial', agent: 'analyst', skillId: 'compare_supplier_costs',
    args: { productRef: sku } };
};
const routeSupplierProducts = (message, memory = {}) => {
  const text = normalize(message);
  const shortSupplierQuestion = /^\s*q\s+vende\s+(?=.*[a-z]).+$/i.test(text);
  // Transactional sale language belongs to AUTO-R2.5, even if a product name happens to be “food”.
  if (/\bvende\s+\d+\b/.test(text) && !shortSupplierQuestion) return null;
  const asksOfferRelationship = /\b(?:provee|proveen|ofrece|ofrecen)\b/.test(text)
    && /\b(?:que|q|cual|cuales|producto|productos|sku)\b/.test(text);
  const asksSupplierInventory = /\bproveedor\b/.test(text)
    && (/\b(?:que|q|cual|cuales|producto|productos|vende|provee|ofrece)\b/.test(text)
      || /^\s*(?:el\s+)?proveedor\s+\S+/.test(text));
  const productsOfMatch = text.match(/\b(?:muestrame|mostrar|lista|listar|dime|que|cuales)\b.*\bproductos?\s+de\s+(.+?)[?!.]*$/i);
  const productsOf = Boolean(productsOfMatch && (memory.lastSupplier || /\d/.test(productsOfMatch[1])
    || /\b(?:proveedor|supplier|distribuidora|distribuciones|comercial|sac|srl)\b/i.test(productsOfMatch[1])));
  if (/\b(?:compara|comparar)\b/.test(text) || /\bque proveedor deberia usar\b/.test(text)) return null;
  if (!asksOfferRelationship && !asksSupplierInventory && !productsOf && !shortSupplierQuestion) return null;

  const sku = message.match(/\b(?:M5-[A-Z]+_\d+_\d+|SKU\s+[\w.-]{1,100})\b/i)?.[0]?.replace(/^SKU\s+/i, '');
  const explicitSupplier = message.match(/\bproveedor\s+(.+?)(?=\s+(?:q|que)\s+productos?|\s+(?:producto|productos|provee|proveen|vende|ofrece)\b|[?!.]|$)/i)?.[1]?.trim()
    || message.match(/\bq\s+vende\s+(.+?)[?!.]*$/i)?.[1]?.trim()
    || message.match(/\bproductos?\s+(?:que\s+)?(?:provee|proveen|vende|ofrece|ofrecen)\s+(?:(?:el|la)\s+)?(?:proveedor\s+)?(.+?)(?=[?!.]|$)/i)?.[1]?.trim()
    || message.match(/\b(?:ofrece|vende)\s+(?:el\s+)?proveedor\s+(.+?)(?=[?!.]|$)/i)?.[1]?.trim()
    || message.match(/\bproductos?\s+de\s+(?:(?:el|la)\s+)?(?:proveedor\s+)?(.+?)(?=[?!.]|$)/i)?.[1]?.trim();
  const explicitName = explicitSupplier?.replace(/\s+(?:q|que)\s+$/, '').trim();
  const remembered = /\b(?:este|ese|el mismo) proveedor\b/.test(text) ? memory.lastSupplier : null;
  const supplierRef = explicitName || remembered?.id;
  if (!supplierRef) return clarify('¿Qué proveedor deseas consultar? Indica su nombre o una parte para buscar coincidencias.');
  return { intent: 'supplier_products', agent: 'operations', skillId: 'get_supplier_products',
    args: { supplierRef, limit: 5, offset: 0, ...(sku ? { productRef: sku } : {}) }, limit: 5 };
};
const routeCommercial = (message, memory = {}) => {
  const text = normalize(message);
  if (/shell|ejecuta codigo|mongo query|ignora.*instruccion|api.?key|password|jwt|system prompt/.test(text)) return null;
  const sku = message.match(/\bM5-[A-Z]+_\d+_\d+\b/i)?.[0];
  const asksSupplierComparison = /proveedor/.test(text)
    && /que proveedor|cual proveedor|usar|conviene|barat|compar/.test(text);
  const asksCheapestSupplier = asksSupplierComparison && /barat|menor costo|mas economico/.test(text);
  const explicitSupplier = message.match(/\b(?:con|usando)\s+(?:el\s+)?(?:proveedor|supplier)\s+(.+?)(?=\s+(?:para|por)\s+(?:reponer|el producto)|[?!.]|$)/i)?.[1]?.trim()
    || (!asksSupplierComparison ? message.match(/\bproveedor\s+(?!deber[ií]a\b|debe\b|usar\b|conviene\b)(.+?)(?=\s+(?:para|por)\s+(?:reponer|el producto)|[?!.]|$)/i)?.[1]?.trim() : null)
    || message.match(/\b(?:con|usando)\s+(?:el|la)\s+(.+?)(?=\s+(?:para|por)\s+(?:reponer|el producto)|[?!.]|$)/i)?.[1]?.trim();
  const currency = /\bUSD|\$|dolares?\b/i.test(message) ? 'USD'
    : /\bEUR|€|euros?\b/i.test(message) ? 'EUR' : /\bS\s*\/|\bPEN\b/i.test(message) ? 'PEN' : null;
  const department = message.match(/\b(?:FOODS|HOBBIES|HOUSEHOLD)_\d+\b/i)?.[0]?.toUpperCase();
  const make = (skillId, args) => ({ intent: 'replenishment_commercial', agent: 'analyst', skillId, args });
  if (asksSupplierComparison) {
    const hasContextualProductReference = /\b(?:este|ese) producto\b|\beste sku\b|\bsu proveedor\b/.test(text);
    const productRef = sku || (hasContextualProductReference
      ? memory.selectedProductReference?.sku || memory.lastEntity?.sku : null);
    if (!productRef) return { intent: 'replenishment_budget_required', agent: 'coordinator',
      clarificationQuestion: 'Indica el SKU del producto para comparar sus proveedores configurados.' };
    return { ...make('compare_supplier_costs', { productRef, ...(explicitSupplier ? { supplierRef: explicitSupplier } : {}) }),
      ...(asksCheapestSupplier ? { intent: 'cheapest_supplier' } : {}) };
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
    return { ...make('plan_replenishment_budget', { budget, currency: 'PEN', ...(department ? { department } : {}) }),
      ...( /explica|por que|prioritari|administrador/.test(text)
        ? { intent: 'replenishment_plan_explanation' } : {}) };
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
      const productRef = sku || memory.selectedProductReference?.sku || memory.lastEntity?.sku;
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
const ordinalReference = ordinalSelection;

/** High-confidence routing only. Unrecognized language is delegated, never guessed. */
const routeDeterministically = (message, memory, now, conversationId, scopeBinding, businessId) => {
  const tenantGuard = tenantScopeViolation(message);
  if (tenantGuard) return tenantGuard;
  const alertText = normalize(message);
  const alertSku = canonicalProductSku(message) || message.match(/\bSKU-[\w.-]{1,100}\b/i)?.[0];
  if (/\btelegram\b/.test(alertText) && /\b(?:alertas?|notificaciones?|entregas?)\b/.test(alertText)
    && !/\b(?:crea|crear|activa|activar|desactiva|desactivar)\b/.test(alertText)) {
    return { intent: 'inventory_alert_channel_deliveries', agent: 'operations', selector: {
      ...(alertSku ? { sku: alertSku } : {}), limit: 20,
      ...(/\bpendientes?\b/.test(alertText) ? { status: 'PENDING' }
        : /\b(?:fallaron|fallidas?)\b/.test(alertText) ? { status: 'FAILED' }
          : /\b(?:envio|enviadas?|entregadas?)\b/.test(alertText) ? { status: 'DELIVERED' }
            : /\bomitidas?\b/.test(alertText) ? { status: 'SKIPPED' } : {})
    } };
  }
  const deliveryStatus = /\b(?:pendientes?|en proceso|procesando|completad[oa]s?|entregad[oa]s?|entrego|fallid[oa]s?|fallaron)\b/.test(alertText);
  const alertDelivery = /\b(?:estado|estatus)\s+de\s+(?:la\s+)?entrega\b/.test(alertText)
    || /\bentregas?\b/.test(alertText) && deliveryStatus
    || /\balertas?\b/.test(alertText) && /\b(?:pendientes?|en proceso|procesando|completad[oa]s?|entregad[oa]s?|entrego|fallid[oa]s?|fallaron)\b/.test(alertText)
      && /\b(?:de|para)\s+entrega\b/.test(alertText)
    || /\b(?:se\s+)?entrego\b/.test(alertText) && /\balertas?\b/.test(alertText);
  if (alertDelivery) return { intent: 'inventory_alert_deliveries', agent: 'operations', selector: {
    ...(alertSku ? { sku: alertSku } : {}),
    ...( /\b(?:completad[oa]s?|entregad[oa]s?|entrego)\b/.test(alertText) ? { status: 'DELIVERED' }
      : /\b(?:fallid[oa]s?|fallaron)\b/.test(alertText) ? { status: 'FAILED' }
        : /\b(?:en proceso|procesando)\b/.test(alertText) ? { status: 'IN_FLIGHT' }
          : deliveryStatus ? { status: 'PENDING' } : {}),
    limit: 20
  } };
  const configuredAlerts = /\balertas?\b/.test(alertText)
    && /\b(configuradas?|configurados?|tengo|stock)\b/.test(alertText)
    && !/\b(crea|crear|elimina|borra|modifica|deshabilita|generadas?|generaron|produjeron)\b/.test(alertText);
  const alertFollowup = memory.lastIntent === 'stock_alert_rules'
    && /^\s*[¿?]?\s*y\s+para\b/.test(alertText) && alertSku;
  if (configuredAlerts || alertFollowup) return { intent: 'stock_alert_rules', agent: 'operations',
    ...(alertSku ? { selector: { sku: alertSku } } : {}) };
  const inventoryAlertEvents = /\balertas?\b/.test(alertText)
    && /\b(generad[oa]s?|generaron|producid[oa]s?|ocurrid[oa]s?|abiertas?|resueltas?|resolvieron)\b/.test(alertText);
  if (inventoryAlertEvents) return { intent: 'inventory_alert_events', agent: 'operations', selector: {
    ...(alertSku ? { sku: alertSku } : {}),
    ...( /\breglas?\s+de\s+stock\b/.test(alertText) ? { source: 'stock_alert_rule' } : {}),
    ...( /\babiertas?\b/.test(alertText) ? { status: 'OPEN' } : /\b(?:resueltas?|resolvieron)\b/.test(alertText) ? { status: 'RESOLVED' } : {})
  } };
  const followupType = budgetPlanFollowupType(message);
  if (followupType) {
    const candidate = memory.lastReplenishmentPlan;
    const saved = candidate?.semanticReference === 'last_replenishment_budget_plan'
      && candidate.conversationId === conversationId && candidate.contextBinding === scopeBinding
      && Number.isSafeInteger(candidate.expiresAt) && candidate.expiresAt > now.getTime() ? candidate : null;
    if (!saved) return clarify('No tengo un plan de compras previo en esta conversación. Si quieres, puedo preparar uno con tu presupuesto.');
    const productRef = followupType === 'supplier_for_product'
      ? canonicalProductSku(message) || message.match(/\bpara\s+(?:el\s+)?(.+?)[?.!]*$/i)?.[1]?.trim() : undefined;
    return { intent: 'replenishment_plan_followup', agent: 'coordinator', followupType,
      ...(productRef ? { productRef } : {}) };
  }
  const explicitProductQuery = explicitProductDetailQuery(message);
  if (explicitProductQuery) return { intent: /prediccion|forecast/.test(normalize(message)) ? 'demand_forecast' : 'product_details',
    agent: /prediccion|forecast/.test(normalize(message)) ? 'analyst' : 'operations', lookupQuery: explicitProductQuery, limit: 1,
    explicitEntity: true };
  const productReference = productReferenceFollowup(message, memory);
  if (productReference) return productReference;
  const compound = routeCompoundProductList(message);
  if (compound) return compound;
  const listFollowup = productListFollowupType(message);
  // An explicit SKU always narrows a supplier comparison to that product,
  // rather than expanding it across the remembered list.
  if (listFollowup && !(['cheapest_supplier_for_list', 'cheapest_replenishment_for_list'].includes(listFollowup)
    && canonicalProductSku(message))) {
    const resolved = resolveProductListFollowup(listFollowup, {
      ...memory.lastProductSelection, selectedProductReference: memory.selectedProductReference
    });
    if (resolved.clarificationQuestion) return clarify(resolved.clarificationQuestion);
    if (listFollowup === 'explain_selected') return { intent: 'product_details', agent: 'operations',
      selector: { productId: resolved.selectedProduct.id }, selectedProduct: resolved.selectedProduct };
    if (resolved.needsLookup) return { intent: 'product_list_followup', agent: 'operations', listFollowupType: listFollowup,
      needsLookup: resolved.needsLookup };
    return { intent: 'product_list_followup', agent: 'coordinator', listFollowupType: listFollowup,
      ...(resolved.answer ? { deterministicAnswer: resolved.answer } : {}),
      ...(resolved.selectedProduct ? { selectedProduct: resolved.selectedProduct } : {}) };
  }
  const text = normalize(message);
  const hasSku = Boolean(canonicalProductSku(message));
  if (/\bproveedor(?:es)?\b/.test(text) && /\b(?:retras|atras|demor|incumpl|llego tarde)\w*\b/.test(text)
    && /\b(?:por que|que proveedor|caus|motivo|incumpl)\w*\b/.test(text)) {
    return { intent: 'unsupported_supplier_causality', agent: 'coordinator' };
  }
  if (/\b(?:confianza|segur[oa]|intervalo de confianza|probabilidad de acertar|incertidumbre)\b/.test(text)
    && /\b(?:prediccion|forecast|demanda|modelo)\b/.test(text)) {
    return { intent: 'forecast_confidence', agent: 'coordinator', ...(hasSku ? { sku: canonicalProductSku(message) } : {}) };
  }
  if (/\b(?:perder|perderia|perdida|perdidas|costar\w*|costo de quedarme sin stock|ventas perdidas)\b/.test(text)
    && /\b(?:si no|sin|no compro|no repongo|no repon|quedarme sin stock)\b/.test(text)) {
    return { intent: 'unsupported_financial_impact', agent: 'coordinator', ...(hasSku ? { sku: canonicalProductSku(message) } : {}) };
  }
  const asksSalesCausality = /\b(?:por que|caus|motivo)\w*\b/.test(text)
    && /\b(?:baj|disminu|cayer|caid|descend)\w*\b/.test(text) && /\b(?:venta|vend)\w*\b/.test(text);
  if (asksSalesCausality) {
    const requestedPeriod = relativeSalesPeriod(text, now);
    if (!requestedPeriod) {
      return { intent: 'sales_causality', agent: 'operations', clarificationQuestion:
        'Puedo comparar ventas registradas entre periodos, pero eso no demuestra la causa. Indícame un periodo, como ayer, esta semana o este mes.' };
    }
    const comparisonPeriod = /\b(?:esta semana|semana pasada|semana anterior)\b/.test(text)
      ? weekPeriod(now, /\b(?:semana pasada|semana anterior)\b/.test(text) ? 2 : 1, weekElapsedDays(requestedPeriod))
      : previousEqualPeriod(requestedPeriod);
    return { intent: 'sales_causality', agent: 'operations', period: requestedPeriod, comparisonPeriod, periodExplicit: true };
  }
  const commercialPlan = routeCommercial(message, memory);
  if (commercialPlan) return commercialPlan;
  const productSupplierLookup = routeProductSupplierLookup(message, memory);
  if (productSupplierLookup) return productSupplierLookup;
  const supplierProducts = routeSupplierProducts(message, memory);
  if (supplierProducts) return supplierProducts;
  const explicitProductSku = canonicalProductSku(message);
  const asksBasicProductDetail = /\b(?:stock|precio|minimo|activo|estado)\b/.test(text)
    && /\b(?:cuanto|cuanta|cual|dime|muestrame|esta|tiene)\b/.test(text)
    && !/\b(?:reponer|reposicion|proveedor|oferta|compra|costo)\b/.test(text);
  if (explicitProductSku && asksBasicProductDetail) return { intent: 'product_details', agent: 'operations',
    selector: { sku: explicitProductSku }, limit: 1 };
  const inventoryText = normalizeBasicInventory(message);
  // Specific inventory questions must win before the broad generic product fallback.
  if (isLowStockQuery(inventoryText)) return { intent: 'low_stock', agent: 'operations', limit: 5 };
  if (isProductCountQuery(inventoryText)) return { intent: 'business_summary', agent: 'analyst', inventoryOnly: true,
    inventoryCountOnly: true, periodExplicit: true };
  const referencesBudgetPlan = /estas compras|esas compras|este plan|este presupuesto|productos que acabas de recomendar|explica.*este plan/.test(text);
  const savedBudgetPlan = memory.lastReplenishmentPlan?.semanticReference === 'last_replenishment_budget_plan'
    && memory.lastReplenishmentPlan.conversationId === conversationId
    && memory.lastReplenishmentPlan.contextBinding === scopeBinding
    && Number.isSafeInteger(memory.lastReplenishmentPlan.expiresAt) && memory.lastReplenishmentPlan.expiresAt > now.getTime()
    ? memory.lastReplenishmentPlan : null;
  if (referencesBudgetPlan) {
    if (savedBudgetPlan) {
      return { intent: 'replenishment_plan_explanation', agent: 'analyst', useMemoryPlan: true };
    }
    return clarify('No tengo un plan de compras previo en esta conversación. Si quieres, indícame tu presupuesto y puedo preparar uno.');
  }
  if (/estos productos|estas recomendaciones/.test(text) && !memory.lastProductSelection && !savedBudgetPlan) {
    return clarify('No tengo una referencia clara de cuáles son “estos productos”. ¿Te refieres al último plan o lista que vimos, o a otros productos?');
  }
  const hasForecastLanguage = /prediccion|forecast|demanda|ml/.test(text);
  if (/^por que (?:ocurre|pasa|sucede) (?:esto|eso)$/.test(text.replace(/[¿?¡!.]/g, '').trim())
    && ['inventory_interpretation', 'executive_inventory_summary', 'forecast_risk_explanation'].includes(memory.lastIntent)) {
    return { intent: 'inventory_causality', agent: 'coordinator' };
  }
  const asksOpenInventoryAnalysis = /inventario|stock/.test(text) && hasForecastLanguage
    && /problema|observas|conclusion|analiza|analisis|explicame|explica|preocupar/.test(text);
  if (/riesgo|riesgos|preocupar|alerta/.test(text) && hasForecastLanguage && /stock|inventario|prediccion|forecast|demanda/.test(text)) {
    return { intent: 'forecast_risk_explanation', agent: 'analyst', narrativeSynthesis: true };
  }
  if (asksOpenInventoryAnalysis) return { intent: 'inventory_interpretation', agent: 'analyst',
    narrativeSynthesis: true, inventoryOnly: true, includeForecast: true };
  if (/resumen ejecutivo/.test(text) && /inventario|stock/.test(text)) {
    return { intent: 'executive_inventory_summary', agent: 'analyst', narrativeSynthesis: true, inventoryOnly: true };
  }
  if (/analiza|analizar|preocup|resume.*riesg|riesgos principales/.test(text) && /inventario|stock/.test(text)) {
    return { intent: 'inventory_interpretation', agent: 'analyst', narrativeSynthesis: true,
      inventoryOnly: true, includeForecast: hasForecastLanguage };
  }
  if (/conclusiones|decisiones|presentar.*administrador|explicame.*recomendaciones|explica.*recomendaciones|prioriz/.test(text)
    && /datos|informacion|recomendaciones|productos|plan|estos|estas/.test(text)) {
    const supportedSelection = memory.lastProductSelection
      && ['ml_analytics', 'top_selling_products', 'low_stock', 'replenishment_candidates', 'demand_forecast'].includes(memory.lastProductSelection.sourceIntent);
    const hasContext = Boolean(memory.lastForecastAnalytics || supportedSelection
      || ['replenishment_candidates', 'business_summary', 'inventory_interpretation',
        'executive_inventory_summary', 'forecast_risk_explanation'].includes(memory.lastIntent));
    if (!hasContext) return clarify('No tengo una referencia clara de cuáles son “estos productos”. ¿Te refieres al último plan o lista que vimos, o a otros productos?');
    return { intent: 'evidence_synthesis', agent: 'analyst', narrativeSynthesis: true, fromMemory: true };
  }
  const forecastPlan = require('./forecastRouting').routeForecastAnalytics(message, memory, now, businessId);
  if (forecastPlan) return forecastPlan;
  const bareProductQuery = text.replace(/[¿?¡!]/g, '').trim();
  if (/^[\p{L}]{3,}(?:\s+\d+){1,2}$/u.test(bareProductQuery)
    && !/^(?:top|otros|opcion|pagina|proveedor|cliente|producto|compra|vende|stock|minimo|cantidad|sku)\b/.test(bareProductQuery)) {
    return { intent: 'product_details', agent: 'operations', lookupQuery: bareProductQuery, limit: 1, explicitEntity: true };
  }
  const dates = message.match(/\d{4}-\d{2}-\d{2}/g);
  const parsedNaturalDate = !dates && /\b\d{1,2}\s+de\s+[a-z]+\s+de\s+20\d{2}\b/i.test(text)
    ? parseRequestedDate(text) : null;
  const explicitRelativePeriod = relativeSalesPeriod(text, now);
  const periodFollowupText = text.replace(/[¿?¡!.]/g, '').trim();
  const periodOnlyFollowup = /^(?:y\s+)?(?:hoy|ayer|anteayer|ultimos?\s+(?:7|30)\s+dias)$/.test(periodFollowupText);
  const contextualPeriodFollowup = periodOnlyFollowup || /^que paso (?:hoy|ayer|anteayer|ultimos?\s+(?:7|30)\s+dias)$/.test(periodFollowupText);
  if (contextualPeriodFollowup && ['sales_summary', 'sales_causality', 'recent_transactions', 'product_sales_summary'].includes(memory.lastIntent)) {
    if (memory.lastIntent === 'product_sales_summary' && !memory.lastEntity) return clarify('¿Qué producto deseas consultar en ese periodo?');
    return { intent: memory.lastIntent === 'sales_causality' ? 'sales_summary' : memory.lastIntent,
      agent: memory.lastAgent || 'operations', period: explicitRelativePeriod,
      ...(memory.lastIntent === 'product_sales_summary' ? { selector: { productId: memory.lastEntity.id } } : {}),
      ...(memory.lastIntent === 'recent_transactions' ? { ...memory.lastTransactionFilters, periodRequested: true } : {}),
      periodExplicit: true, limit: memory.listLimit || 5 };
  }
  if (contextualPeriodFollowup) return clarify('¿Qué información deseas consultar para ese periodo? Por ejemplo, ventas o transacciones.');
  if (!dates && /\b(?:ayer|anteayer|semana|ano pasado|hoy|ultimos?\s+(?:7|30)\s+dias)\b/.test(text)
    && /\b(?:venta\w*|vendi\w*)\b/.test(text) && !explicitRelativePeriod) {
    return clarify('Indica un periodo válido, como hoy, ayer, anteayer, últimos 7 días, esta semana o este mes.');
  }
  if (dates && (dates.length !== 2 || !dates.every(isDate) || dates[0] > dates[1])) return clarify('Indica un periodo válido con dos fechas YYYY-MM-DD.');
  if (!dates && /\b\d{1,2}\s+de\s+[a-z]+\s+de\s+20\d{2}\b/i.test(text) && !parsedNaturalDate) return clarify('No pude validar esa fecha. Indícala con día, mes y año.');
  const explicitPeriod = dates ? { startDate: dates[0], endDate: dates[1] }
    : parsedNaturalDate ? { startDate: parsedNaturalDate, endDate: parsedNaturalDate } : explicitRelativePeriod;
  const period = explicitPeriod || (memory.lastPeriodExplicit === true ? memory.lastPeriod : undefined) || monthPeriod(now);
  if (/\b(crea|crear|compra|comprar|borra|elimina|editar|actualiza|cancelar)\b|shell|ejecuta codigo|mongo query|ignora.*instruccion|api.?key|password|jwt/.test(text)) {
    return { intent: 'unsupported', agent: 'coordinator' };
  }
  const ordinal = ordinalReference(text);
  if (ordinal.matched) {
    if (ordinal.index === null) return clarify('No seleccionaré una opción negada. Elige una de las opciones mostradas.');
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
      return { intent: 'explain_replenishment', agent: 'analyst', selector, limit: 1 };
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
  if (isLowStockQuery(inventoryText)) plan = { intent: 'low_stock', agent: 'operations' };
  else if (/transacciones.*(ultim|recient)|(ultim|recient).*transacciones/.test(text)) plan = { intent: 'recent_transactions', agent: 'operations' };
  else if (/mas vendidos|mayores ventas|se venden mas/.test(text)) plan = { intent: 'top_selling_products', agent: 'analyst' };
  else if (/\b(?:vendimos|ventas?|vendi|cuantas? ventas?|cuanto.*vendid[oa])\b/.test(text)
    && (explicitPeriod || /\b(?:vendimos|ventas del mes)\b/.test(text))) plan = { intent: 'sales_summary', agent: 'operations' };
  else if (/vendio|cuanto.*vendido/.test(text)) plan = { intent: 'product_sales_summary', agent: 'operations', needsProduct: true };
  else if (/explica|por que/.test(text) && /repon|reposicion/.test(text)) plan = { intent: 'explain_replenishment', agent: 'analyst', needsProduct: true };
  else if (/repon|reposicion/.test(text)) plan = { intent: 'replenishment_candidates', agent: 'analyst', limit: /mayor|mas reposicion/.test(text) ? 1 : 5 };
  else if (/prediccion|demanda|forecast/.test(text)) plan = { intent: 'demand_forecast', agent: 'analyst', needsProduct: /producto|\bsu\b|ese|sku/.test(text) };
  else if (/resume|resumen|estado.*negocio/.test(text)) plan = { intent: 'business_summary', agent: 'analyst', multi: /vigilar|atencion/.test(text), synthesize: /vigilar|atencion/.test(text) };
  else if (/\b(?:busca|buscar)\b/.test(text)) plan = { intent: 'search_product', agent: 'operations' };
  else if (/producto|sku/.test(text)) plan = { intent: 'product_details', agent: 'operations', needsProduct: true };
  else return null;
  const sku = message.match(/\bSKU\s+([\w.-]{1,100})/i)?.[1]
    || message.match(/\b((?:SKU|M5)-[\w.-]{1,96})\b/i)?.[1];
  const productId = message.match(/\b[a-f\d]{24}\b/i)?.[0];
  const query = message.replace(/^.*?(?:producto[s]?|sku)\s*/i, '').trim().replace(/[?!.]+$/, '').slice(0, 100);
  if (plan.intent === 'search_product') {
    const explicitSearch = message.match(/\b(?:busca|buscar)\s+(?:(?:el|los|la|las)\s+)?(?:productos?\s+|sku\s+)?(.+?)[?!.]*$/i)?.[1];
    if (explicitSearch) plan.query = explicitSearch.trim();
    else plan.query = query;
    if (!plan.query) return clarify('¿Qué nombre o SKU deseas buscar?');
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

// Intentionally bounded: list-producing phrases joined to one known comparison.
const routeCompoundProductList = message => {
  const normalized = normalizeBasicInventory(message).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const parts = normalized.split(/\s+y\s+/);
  if (parts.length !== 2) return null;
  const [source, comparison] = parts;
  const asksList = /\b(?:cual|que producto|quien)\b/.test(comparison)
    && (/\b(?:de esos|de esas|de ellos|de ellas|esos|esas)\b/.test(comparison)
      || /^cual\b/.test(comparison));
  if (!asksList) return null;
  let sourceIntent, limit = 5;
  if (isLowStockQuery(source)) { sourceIntent = 'low_stock'; limit = 60; }
  else if (/\b(?:demanda|prediccion|forecast)\b/.test(source)
    && /\b(?:productos?|cinco|5|mayor|mas|top)\b/.test(source)) {
    sourceIntent = 'demand_top';
    const requested = source.match(/\b(\d{1,2})\b/);
    limit = Math.min(10, Math.max(1, Number(requested?.[1] || 5)));
  } else if (/\b(?:reponer|reposicion|REPONER)\b/.test(source)
    && /\b(?:productos?|candidatos|recomendados?)\b/.test(source)) sourceIntent = 'replenishment_candidates';
  if (!sourceIntent) return null;
  let comparisonType;
  if (/\b(?:menos|menor)\s+stock\b/.test(comparison)) comparisonType = 'min_stock';
  else if (/\b(?:mas|mayor)\s+reposicion\b|\bnecesita mas reposicion\b|\brequiere mas reposicion\b/.test(comparison)) comparisonType = 'max_replenishment';
  else if (/\b(?:mas caro|mas costoso)\s+de\s+reponer\b/.test(comparison)) comparisonType = 'max_replenishment_cost';
  else return null;
  return { intent: 'compound_product_list', agent: 'analyst', sourceIntent, comparisonType, limit };
};

module.exports = { routeDeterministically, routeCommercial, routeSupplierProducts, monthPeriod, weekPeriod, clarify,
  budgetPlanFollowupType, tenantScopeViolation, routeCompoundProductList, canonicalProductSku, explicitProductDetailQuery };
