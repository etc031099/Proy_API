const { isDate } = require('./contracts');
const { productListFollowupType, resolveProductListFollowup } = require('./productListFollowups');

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
  .replace(/\bq(?=\s+(?:productos?|stock)\b)/g, 'que')
  .replace(/\bd(?=\s+stock\b)/g, 'de')
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
const clarify = question => ({ intent: 'ambiguous_query', agent: 'coordinator', clarificationQuestion: question });
const canonicalProductSku = message => message.match(/\bM5-[A-Z]+_\d+_\d+\b/i)?.[0]
  || message.match(/\bSKU\s+([\w.-]{1,100})\b/i)?.[1];
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
    const productRef = sku || (/este producto|ese producto|este sku/.test(text) ? memory.lastEntity?.sku : null);
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
const routeDeterministically = (message, memory, now, conversationId, scopeBinding) => {
  const tenantGuard = tenantScopeViolation(message);
  if (tenantGuard) return tenantGuard;
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
  const listFollowup = productListFollowupType(message);
  if (listFollowup) {
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
    if (!/\b(?:esta semana|semana pasada|semana anterior)\b/.test(text)) {
      return { intent: 'sales_causality', agent: 'operations', clarificationQuestion:
        'Puedo comparar las ventas registradas entre periodos, pero esa comparación no demuestra la causa. Indícame un periodo, como esta semana o este mes.' };
    }
    const weeksAgo = /\b(?:semana pasada|semana anterior)\b/.test(text) ? 1 : 0;
    const requestedPeriod = weekPeriod(now, weeksAgo);
    const comparisonPeriod = weekPeriod(now, weeksAgo + 1, weekElapsedDays(requestedPeriod));
    return { intent: 'sales_causality', agent: 'operations', period: requestedPeriod, comparisonPeriod, periodExplicit: true };
  }
  const commercialPlan = routeCommercial(message, memory);
  if (commercialPlan) return commercialPlan;
  const productSupplierLookup = routeProductSupplierLookup(message, memory);
  if (productSupplierLookup) return productSupplierLookup;
  const supplierProducts = routeSupplierProducts(message, memory);
  if (supplierProducts) return supplierProducts;
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
  if (/analiza|analizar|preocupar/.test(text) && /inventario|stock/.test(text)) {
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
  const forecastPlan = require('./forecastRouting').routeForecastAnalytics(message, memory);
  if (forecastPlan) return forecastPlan;
  const dates = message.match(/\d{4}-\d{2}-\d{2}/g);
  const naturalWeek = /\b(?:esta semana|semana pasada|semana anterior)\b/.test(text);
  if (!dates && /ayer|semana|ano pasado|hoy/.test(text) && /venta|vendi/.test(text) && !naturalWeek) return clarify('Indica un periodo como esta semana, semana pasada, este mes o mes pasado.');
  if (dates && (dates.length !== 2 || !dates.every(isDate) || dates[0] > dates[1])) return clarify('Indica un periodo válido con dos fechas YYYY-MM-DD.');
  const explicitPeriod = dates ? { startDate: dates[0], endDate: dates[1] }
    : /semana pasada|semana anterior/.test(text) ? weekPeriod(now, 1)
      : /esta semana/.test(text) ? weekPeriod(now)
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
  else if (/vendimos|ventas del mes|ventas?.*(?:esta semana|semana pasada|semana anterior|este mes|mes pasado|mes anterior)/.test(text)) plan = { intent: 'sales_summary', agent: 'operations' };
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

module.exports = { routeDeterministically, routeCommercial, routeSupplierProducts, monthPeriod, weekPeriod, clarify, budgetPlanFollowupType, tenantScopeViolation };
