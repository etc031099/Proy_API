const { isDate } = require('./contracts');
const { productListFollowupType, resolveProductListFollowup } = require('./productListFollowups');
const { parseRequestedDate, routeForecastTemporalQuery, isTemporalOnlyReference } = require('./forecastRouting');
const { ordinalSelection } = require('./ordinalSelection');

const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const currentMemoryAgent = memory => {
  if (['operations', 'analyst'].includes(memory?.lastAgent)) return memory.lastAgent;
  return ['low_stock', 'recent_transactions', 'search_product', 'product_details', 'supplier_products',
    'inventory_alert_events', 'inventory_alert_deliveries', 'inventory_alert_channel_deliveries', 'stock_alert_rules']
    .includes(memory?.lastIntent) ? 'operations' : 'analyst';
};
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
  || /\bproductos?\b.*\b(?:baj[oa]s?\s+(?:de\s+)?stock|por\s+debajo\s+(?:del\s+)?minimo)\b/.test(text)
  || /^que esta bajo de stock[?!.]*$/.test(text.replace(/[¿¡]/g, '').trim());
const isProductCountQuery = text => {
  if (/\b(?:unidades?|stock|existencias)\b/.test(text)) return false;
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
  // Consume compound expressions before single-day tokens. Residual temporal
  // expressions indicate a conflict rather than authority to pick one period.
  const range = /\bdesde\s+(anteayer|ayer|hoy)\s+hasta\s+(anteayer|ayer|hoy)\b/.exec(text);
  const rolling = /\b(?:(?:ultim[oa]s?|de|en|durante)\s+)?(\d+|siete|treinta)\s+dias(?:\s+hasta\s+hoy)?\b/.exec(text);
  const tokens = value => [...value.matchAll(/\b(?:(?:ultim[oa]s?|de|en|durante)\s+)?(?:\d+|siete|treinta)\s+dias(?:\s+hasta\s+hoy)?\b|\banteayer\b|\bayer\b|\bhoy\b|\b(?:esta semana|semana pasada|semana anterior|este mes|mes actual|mes pasado|mes anterior)\b/g)];
  const invalid = () => ({ clarificationQuestion: 'Indica un único periodo o un rango completo con inicio y fin claros.' });
  if (range) {
    if (tokens(text.replace(range[0], '')).length) return invalid();
    const days = { hoy: 0, ayer: 1, anteayer: 2 };
    const startDate = dayPeriod(now, days[range[1]]).startDate, endDate = dayPeriod(now, days[range[2]]).endDate;
    return startDate <= endDate ? { startDate, endDate } : invalid();
  }
  if (rolling) {
    if (tokens(text.replace(rolling[0], '')).length) return invalid();
    const days = ({ siete: 7, treinta: 30 })[rolling[1]] || Number(rolling[1]);
    return Number.isSafeInteger(days) && days >= 1 && days <= 365 ? rollingPeriod(now, days) : invalid();
  }
  if (tokens(text).length > 1 || /\b(?:desde|hasta)\s+(?:ayer|hoy|anteayer)\b/.test(text)
    || /\b(?:del?\s+\d{1,2}\s+al\s+\d{1,2}|entre\s+(?:el\s+)?\d{1,2}\s+y\s+(?:el\s+)?\d{1,2})\b/.test(text)) return invalid();
  if (/\banteayer\b/.test(text)) return dayPeriod(now, 2);
  if (/\bayer\b/.test(text)) return dayPeriod(now, 1);
  if (/\bhoy\b/.test(text)) return dayPeriod(now);
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
// Remove complete temporal expressions before interpreting the remaining entity.
// Calendar dates use the same UTC validation as the existing explicit-date parser.
const salesCalendarPeriod = (text, now) => {
  const months = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
  const days = [...text.matchAll(new RegExp(`\\b(?:20\\d{2}-\\d{2}-\\d{2}|\\d{1,2} de (?:${months})(?: de 20\\d{2})?)\\b`, 'g'))];
  if (days.length) {
    const dates = days.map(row => parseRequestedDate(/20\d{2}/.test(row[0]) ? row[0] : `${row[0]} de ${now.getUTCFullYear()}`));
    if (dates.some(value => !value) || dates.length > 2 || dates.length === 2 && dates[0] > dates[1])
      return { clarificationQuestion: 'Indica un periodo válido con fechas completas y ordenadas.' };
    return { period: { startDate: dates[0], endDate: dates[1] || dates[0] },
      remainder: days.reduce((value, row) => value.replace(row[0], ''), text) };
  }
  const month = text.match(new RegExp(`\\b(${months})(?: (?:de )?(20\\d{2}))?\\b`));
  if (!month) return null;
  const monthIndex = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'].indexOf(month[1] === 'setiembre' ? 'septiembre' : month[1]);
  const year = Number(month[2] || now.getUTCFullYear());
  return { period: monthPeriod(new Date(Date.UTC(year, monthIndex, 1))), remainder: text.replace(month[0], '') };
};
const salesEntityReference = (text, calendar) => {
  const remainder = (calendar?.remainder || text)
    .replace(/\b(?:(?:desde|hasta|en|el|la|los|del|de)\s+)*(?:anteayer|ayer|hoy|este mes|mes (?:pasado|anterior|actual)|esta semana|semana (?:pasada|anterior)|ultim[oa]s?\s+(?:\d+|siete|treinta)\s+dias(?:\s+hasta hoy)?)\b/g, '')
    .replace(/\b(?:desde|hasta|entre)\s*$/g, '').replace(/\s+/g, ' ').trim();
  const reference = remainder.match(/\b(?:vendi|vendimos|vendio|vendido|ventas|unidades vendidas)\s+(?:(?:de|del|tuvo)\s+)(?:el\s+)?(?:producto\s+)?(.+)$/)?.[1];
  return reference?.replace(/[¿?¡!.]/g, '').replace(/(?:\s+(?:desde|hasta|entre|en|el|de|y))+\s*$/g, '').trim();
};
const clarify = question => ({ intent: 'ambiguous_query', agent: 'coordinator', clarificationQuestion: question });
const canonicalProductSku = message => message.match(/\bM5-[A-Z]+_\d+_\d+\b/i)?.[0]
  || message.match(/\bSKU\s+([\w.-]{1,100})\b/i)?.[1];
// Product names shown in assistant choices contain a stable structured SKU
// fragment. Resolve that exact catalog identity instead of searching the whole
// display label as free text.
const structuredProductDisplaySku = message => {
  const match = normalize(message).match(/\b(foods|hobbies|household)_(\d+)\s+(?:[·•]\s*)?item\s+(\d+)\b/i);
  return match ? `M5-${match[1].toUpperCase()}_${match[2].replace(/^0+(?=\d)/, '')}_${match[3].replace(/^0+(?=\d)/, '').padStart(3, '0')}` : null;
};
const explicitProductDetailQuery = message => {
  const text = normalize(message).replace(/[¿?¡!]/g, '').trim();
  if (structuredProductDisplaySku(message)) return null;
  // Bounded single-attribute aliases. Commercial/open questions and multiple
  // references must keep their existing routes rather than becoming details.
  const commonTarget = text.match(/^(?:dime|muestrame)\s+(?:el\s+)?(?:stock|precio|minimo|estado)\s+(?:(?:de|del)\s+)?(.+)$/)?.[1]
    || text.match(/^(?:que|q)\s+(?:stock|precio|minimo|estado)\s+tiene\s+(.+)$/)?.[1]
    || text.match(/^(?:cuanto\s+(?:cuesta|vale)|a cuanto esta)\s+(.+)$/)?.[1]
    || text.match(/^dime si\s+(.+?)\s+esta\s+activ[oa]$/)?.[1]
    || text.match(/^(?:dame|dime)\s+(?:los\s+)?(?:detalles|informacion)\s+(?:de|del)\s+(.+)$/)?.[1];
  if (commonTarget && !/\b(?:y|proveedor|oferta|compra|repon\w*|recomendad\w*|bajo|minimo)\b/.test(commonTarget)
    && !isTemporalOnlyReference(commonTarget) && !/^(?:ese|este|su)\b/.test(commonTarget)) return commonTarget;
  const minimumSuffix = text.match(/^(.+?)\s+stock\s+minimo\s*$/)?.[1];
  const target = text.match(/\b(?:cuanto|cuanta)\s+(?:stock|inventario|precio|minimo)\s+(?:tiene|cuesta|es)\s+(?:el\s+)?(?:producto\s+)?(.+?)\s*$/)?.[1]
    || text.match(/\b(?:cuanto|cual)\s+(?:es\s+)?(?:el\s+)?stock\s+minimo\s+(?:de|del|para)\s+(.+?)\s*$/)?.[1]
    || (minimumSuffix && /\d/.test(minimumSuffix) ? minimumSuffix : null)
    || text.match(/^(?:y\s+)?(?:cual\s+es\s+)?(?:el\s+|la\s+)?(?:stock\s+minimo|precio|stock|minimo|prediccion|forecast|esta\s+activ[oa])\s+(?:(?:de|del|para)\s+)?(?:el\s+)?(?:producto\s+)?(.+?)\s*$/)?.[1];
  if (!target || canonicalProductSku(message)) return null;
  const cleaned = target.replace(/[.,;:]+$/, '').trim();
  if (!cleaned || isTemporalOnlyReference(cleaned) || /^(?:bajo|actual|minimo)$/.test(cleaned) || ordinalSelection(cleaned).matched || /^(?:ese|este|aquel|su|mismo|misma)\b/.test(cleaned)
    || /\b(?:ayer|hoy|manana|anteayer)\b/.test(cleaned)
    || /^(?:esta|este|la|el|proxima|proximo|pasada|pasado)\s+(?:semana|mes|ano)\b/.test(cleaned)) return null;
  return cleaned;
};
// Only single-purpose, current-stock reads bypass analytical routing.
const routeOperationalStock = (message, memory = {}) => {
  const text = normalize(message).replace(/[¿?¡!]/g, '').trim();
  if (/\d{4}-\d{2}-\d{2}|[;\n]|\b(?:fecha|desde|hasta|entre|semana|mes|ano|periodo|ultim\w*|corte)\b/.test(text)) return null;
  if (tenantScopeViolation(message) || /\b(?:y|ademas|riesgos?|agot\w*|cobertura|dias|repon\w*|reposicion|escenario|v3|pronostic\w*|prediccion|demanda|forecast|analisis|minimo|bajo|ayer|hoy|manana|historic\w*|venta\w*|vend\w*|compra\w*|precio|costo|proveedor\w*|entradas?|pendientes?)\b/.test(text.replace(/^y\s+/, ''))) return null;
  const input = text.replace(/^y\s+/, '');
  const target = input.match(/^(?:cuantas?\s+unidades?|que\s+cantidad)(?:\s+disponibles?)?\s+(?:tengo|hay|quedan?|tiene)(?:\s+disponibles?)?\s+(?:(?:del|de)\s+)?(.+?)\.?$/)?.[1]
    || input.match(/^(?:(?:cual|cuanto|que)\s+(?:es\s+)?(?:el\s+)?stock(?:\s+actual)?\s+(?:de|del|tiene)|cuanto\s+stock(?:\s+actual)?\s+tengo\s+(?:de|del)|(?:dime|muestrame)\s+(?:el\s+)?stock(?:\s+actual)?\s+(?:de|del))\s+(.+?)\.?$/)?.[1];
  const contextual = /^(?:su\s+stock|(?:el\s+)?stock\s+actual|cuantas?\s+unidades?\s+quedan?)\.?$/.test(input);
  if (!target && !contextual) return null;
  const reference = target?.replace(/^(?:el\s+)?producto\s+/, '').replace(/^el\s+/, '').trim();
  const usesContext = contextual || /^(?:(?:este|ese|el mismo)\s+producto|(?:el\s+)?producto que consulte antes|que consulte antes)$/.test(target || '');
  if (!usesContext && /\b(?:este|ese|anterior|antes|su)\b/.test(reference || '')) return null;
  const plan = { intent: 'product_details', agent: 'operations', limit: 1 };
  const sku = !usesContext && canonicalProductSku(message);
  if (sku) return { ...plan, selector: { sku } };
  if (!usesContext && /\d/.test(reference || '') && /^[a-z]{2,}(?:-[a-z0-9]+){1,5}$/i.test(reference || ''))
    return { ...plan, selector: { sku: reference.toUpperCase() } };
  return scopeReadProduct(plan, usesContext ? undefined : reference, memory, usesContext);
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
  if (/\b(?:productos?|ofertas?)\b.*\b(?:ofrece|proveedor)\b|\b(?:sus productos|sus ofertas)\b/i.test(message)) return null;
  const humanProduct = normalize(message).match(/^(?:quien|quienes)\s+provee[n]?\s+((?:foods?|item)\s+(?:\d+\s+)?\d+)[?!.]*$/)?.[1];
  const sku = canonicalProductSku(message) || humanProduct || memory.selectedProductReference?.sku;
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
  const { supplierLanguage, contextualSupplier } = require('./supplierReference');
  message = supplierLanguage(message);
  const text = normalize(message).replace(/[¿¡?!.]/g, '').trim();
  const contextual = /\b(?:(?:ese|este)(?: mismo)? proveedor|el mismo proveedor|el anterior)\b/.test(text);
  const implicit = /^(?:y )?(?:que productos ofrece|sus productos|sus ofertas|que otr[oa]s? (?:productos|ofertas) ofrece)$/.test(text);
  const asksSupplierPrice = /\b(?:precio|cuesta)\b/.test(text) && /\b(?:su precio|proveedor|con ese|con este)\b/.test(text)
    && !/\b(?:reponer|reposicion)\b/.test(text);
  const supplierDetails = /\b(?:telefono|direccion|correo|detalles)\b/.test(text) && /\bproveedor\b/.test(text);
  if (supplierDetails && contextual && !memory.lastSupplier)
    return clarify('Puedo consultar los productos y ofertas configurados de un proveedor, pero todavía no sus detalles completos.');
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
  if (!supplierDetails && !asksOfferRelationship && !asksSupplierInventory && !productsOf && !shortSupplierQuestion && !implicit && !asksSupplierPrice) return null;

  const sku = message.match(/\b(?:M5-[A-Z]+_\d+_\d+|SKU\s+[\w.-]{1,100})\b/i)?.[0]?.replace(/^SKU\s+/i, '');
  const explicitSupplier = message.match(/\bproveedor\s+(.+?)(?=\s+(?:q|que)\s+productos?|\s+(?:producto|productos|provee|proveen|vende|ofrece)\b|[?!.]|$)/i)?.[1]?.trim()
    || message.match(/\bq\s+vende\s+(.+?)[?!.]*$/i)?.[1]?.trim()
    || message.match(/\bproductos?\s+(?:que\s+)?(?:provee|proveen|vende|ofrece|ofrecen)\s+(?:(?:el|la)\s+)?(?:proveedor\s+)?(.+?)(?=[?!.]|$)/i)?.[1]?.trim()
    || message.match(/\b(?:ofrece|vende)\s+(?:el\s+)?proveedor\s+(.+?)(?=[?!.]|$)/i)?.[1]?.trim()
    || message.match(/\bproductos?\s+de\s+(?:(?:el|la)\s+)?(?:proveedor\s+)?(.+?)(?=[?!.]|$)/i)?.[1]?.trim();
  const name = explicitSupplier?.replace(/\s+(?:q|que)\s+$/, '').trim();
  const explicitName = name && !contextualSupplier(name) ? name : null;
  const remembered = !memory.supplierResolution && (contextual || implicit || asksSupplierPrice && /\bsu precio\b/.test(text)) ? memory.lastSupplier : null;
  const supplierRef = explicitName || remembered?.id;
  if (!supplierRef) return clarify('¿Qué proveedor deseas consultar? Indica su nombre o una parte para buscar coincidencias.');
  const plan = { intent: 'supplier_products', agent: 'operations', skillId: 'get_supplier_products',
    ...(supplierDetails ? { supplierDetails: true } : {}),
    args: { supplierRef, limit: 5, offset: 0, ...(sku ? { productRef: sku } : {}) }, limit: 5 };
  if (asksSupplierPrice) {
    const productRef = sku || message.match(/\bpara\s+(.+?)[?!.]*$/i)?.[1]?.trim()
      || message.match(/\bcuesta\s+(.+?)(?=\s+con\b)/i)?.[1]?.trim();
    return scopeReadProduct(plan, productRef, memory, !productRef);
  }
  return plan;
};
const routeCommercial = (message, memory = {}) => {
  const { supplierLanguage, contextualSupplier } = require('./supplierReference');
  message = supplierLanguage(message);
  const text = normalize(message).replace(/[¿¡?!.]/g, '').trim();
  if (/^(?:y )?con (?:ese|este|el mismo|ese mismo) proveedor[?!.]*$/.test(text)) {
    const productRef = memory.selectedProductReference?.sku || memory.lastEntity?.sku;
    if (!memory.lastSupplier || memory.supplierResolution || !productRef) return clarify('Indica el producto y el proveedor que deseas comparar.');
    return { intent: 'replenishment_commercial', agent: 'analyst', skillId: 'compare_supplier_costs',
      args: { productRef, supplierRef: memory.lastSupplier.id } };
  }
  if (/shell|ejecuta codigo|mongo query|ignora.*instruccion|api.?key|password|jwt|system prompt/.test(text)) return null;
  const sku = message.match(/\bM5-[A-Z]+_\d+_\d+\b/i)?.[0];
  const humanProduct = !/\by\b/.test(text) ? text.match(/\b(?:foods?|item)\s+(?:\d+\s+)?\d+\b/)?.[0] : undefined;
  const offerAlias = text.match(/^(?:costo|oferta) de ((?:foods?|item)\s+(?:\d+\s+)?\d+) con (?:el )?proveedor (.+)$/);
  if (offerAlias) return { intent: 'replenishment_commercial', agent: 'analyst', skillId: 'compare_supplier_costs',
    args: { productRef: offerAlias[1], supplierRef: offerAlias[2] } };
  const asksSupplierComparison = /proveedor/.test(text)
    && /que proveedor|cual proveedor|usar|conviene|barat|compar|mas economico/.test(text);
  const asksCheapestSupplier = asksSupplierComparison && /barat|menor costo|mas economico/.test(text);
  const supplierName = message.match(/\b(?:con|usando)\s+(?:el\s+)?(?:proveedor|supplier)\s+(.+?)(?=\s+(?:para|por)\s+(?:reponer|el producto)|[?!.]|$)/i)?.[1]?.trim()
    || (!asksSupplierComparison ? message.match(/\bproveedor\s+(?!deber[ií]a\b|debe\b|usar\b|conviene\b)(.+?)(?=\s+(?:para|por)\s+(?:reponer|el producto)|[?!.]|$)/i)?.[1]?.trim() : null)
    || message.match(/\b(?:con|usando)\s+(?:el|la)\s+(.+?)(?=\s+(?:para|por)\s+(?:reponer|el producto)|[?!.]|$)/i)?.[1]?.trim();
  const usesContext = /\b(?:ese|este|el mismo|ese mismo) proveedor\b/.test(text) || contextualSupplier(supplierName || '');
  const explicitSupplier = supplierName && !contextualSupplier(supplierName) ? supplierName
    : usesContext && !memory.supplierResolution ? memory.lastSupplier?.id : null;
  if (usesContext && !explicitSupplier) return clarify('¿Qué proveedor deseas usar? No tengo uno seleccionado en esta conversación.');
  const currency = /\bUSD|\$|dolares?\b/i.test(message) ? 'USD'
    : /\bEUR|€|euros?\b/i.test(message) ? 'EUR' : /\bS\s*\/|\bPEN\b/i.test(message) ? 'PEN' : null;
  const department = message.match(/\b(?:FOODS|HOBBIES|HOUSEHOLD)_\d+\b/i)?.[0]?.toUpperCase();
  const make = (skillId, args) => ({ intent: 'replenishment_commercial', agent: 'analyst', skillId, args });
  if (asksSupplierComparison) {
    const hasContextualProductReference = /\b(?:este|ese) producto\b|\beste sku\b|\bsu proveedor\b/.test(text);
    const productRef = sku || humanProduct || (hasContextualProductReference
      ? memory.selectedProductReference?.sku || memory.lastEntity?.sku : null);
    if (!productRef) return { intent: 'replenishment_budget_required', agent: 'coordinator',
      clarificationQuestion: 'Indica el SKU del producto para comparar sus proveedores configurados.' };
    return { ...make('compare_supplier_costs', { productRef, ...(explicitSupplier ? { supplierRef: explicitSupplier } : {}) }),
      ...(asksCheapestSupplier ? { intent: 'cheapest_supplier' } : {}) };
  }
  const amountMatch = message.match(/(?:S\s*\/|PEN|USD|EUR|\$|€)\s*([\d.,]+)/i);
  const hasBudgetIntent = /tengo|presupuesto|que puedo reponer|que puedo comprar|que productos deberia comprar|que debo comprar/.test(text);
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
const scopeReadProduct = (plan, reference, memory, contextual = false) => {
  const sku = reference && (canonicalProductSku(reference) || reference.match(/\bSKU-[\w.-]{1,100}\b/i)?.[0]);
  if (sku) return { ...plan, selector: { ...plan.selector, sku } };
  if (reference && !/^(?:ese|este|el mismo|su)\s+producto$/.test(reference)) {
    if (/^[a-f\d]{24}$/i.test(reference) || isTemporalOnlyReference(reference)) return clarify('Indica el nombre o SKU del producto que deseas consultar.');
    return { ...plan, lookupQuery: reference, explicitEntity: true };
  }
  if (contextual || reference) {
    const product = memory.selectedProductReference;
    if (!product?.sku) return clarify('¿Qué producto deseas consultar? Indica su SKU o selecciónalo de la lista.');
    return { ...plan, selector: { ...plan.selector, sku: product.sku } };
  }
  return plan;
};
const routeAlertRead = (message, memory, now) => {
  const text = normalize(message);
  if (/\b(?:crea|crear|activa|activar|desactiva|desactivar|deshabilita|habilita|elimina|borra|modifica|edita)\b/.test(text)) return null;
  const telegram = /\btelegram\b/.test(text);
  const alerts = /\balertas?\b/.test(text);
  let plan;
  if (telegram && (alerts || /\b(?:envio|enviaron|enviadas?|omitidas?|omitio|entregas?|notificaciones?)\b/.test(text))) {
    plan = { intent: 'inventory_alert_channel_deliveries', agent: 'operations', selector: { limit: 20,
      ...(/\bpendientes?\b/.test(text) ? { status: 'PENDING' }
        : /\b(?:fallaron|fallidas?)\b/.test(text) ? { status: 'FAILED' }
          : /\b(?:omitidas?|omitio)\b/.test(text) ? { status: 'SKIPPED' }
            : /\b(?:envio|enviaron|enviadas?|entregadas?)\b/.test(text) ? { status: 'DELIVERED' } : {}) } };
  } else if (/\b(?:entrega|entregas|entrego)\b/.test(text)
    && (alerts || /\b(?:pendientes?|completad[oa]s?|entregad[oa]s?|fallid[oa]s?|fallaron|en proceso|procesando)\b/.test(text)
      || /^estado de entrega para\b/.test(text.replace(/[¿?¡!]/g, '').trim()))) {
    plan = { intent: 'inventory_alert_deliveries', agent: 'operations', selector: { limit: 20,
      ...(/\b(?:completad[oa]s?|entregad[oa]s?|entrego)\b/.test(text) ? { status: 'DELIVERED' }
        : /\b(?:fallid[oa]s?|fallaron)\b/.test(text) ? { status: 'FAILED' }
          : /\b(?:en proceso|procesando)\b/.test(text) ? { status: 'IN_FLIGHT' }
            : /\bpendientes?\b/.test(text) ? { status: 'PENDING' } : {}) } };
  } else if ((alerts || /\boutbox\b/.test(text))
    && /\b(?:outbox|reintentos?|reintentar|reintento|pendientes?\s+de\s+reintento|entregas?|entrega)\b/.test(text)) {
    plan = { intent: 'inventory_alert_deliveries', agent: 'operations', selector: { limit: 20,
      ...(/\b(?:pendientes?|reintentos?|reintentar)\b/.test(text) ? { status: 'PENDING' }
        : /\b(?:fallaron|fallidas?)\b/.test(text) ? { status: 'FAILED' }
          : /\b(?:completad[oa]s?|entregad[oa]s?)\b/.test(text) ? { status: 'DELIVERED' } : {}) } };
  } else if (alerts && /\b(?:generad[oa]s?|generaron|produjeron|producid[oa]s?|ocurrid[oa]s?|abiertas?|open|resueltas?|resolvieron)\b/.test(text)) {
    plan = { intent: 'inventory_alert_events', agent: 'operations', selector: {
      ...(/\breglas?\s+de\s+stock\b/.test(text) ? { source: 'stock_alert_rule' } : {}),
      ...(/\b(?:abiertas?|open)\b/.test(text) ? { status: 'OPEN' } : /\b(?:resueltas?|resolvieron)\b/.test(text) ? { status: 'RESOLVED' } : {}) } };
  } else if ((alerts && /\b(?:reglas?|configuradas?|configurados?|tengo|stock)\b/.test(text))
    || /^lista mis reglas de stock[?!.]*$/.test(text.trim())
    || (memory.lastIntent === 'stock_alert_rules' && /^[¿?\s]*y\s+para\b/.test(text))) {
    plan = { intent: 'stock_alert_rules', agent: 'operations' };
  } else if (alerts) plan = { intent: 'inventory_alert_events', agent: 'operations', selector: {} };
  if (!plan) return null;
  // These existing skills expose recent records, but accept no date arguments.
  if (relativeSalesPeriod(text, now) || parseRequestedDate(text)
    || /\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|20\d{2}-\d{2}-\d{2})\b/.test(text)
    || /\b(?:en|de|del)\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/.test(text))
    return clarify('Estas consultas de alertas no admiten un filtro por periodo. Puedo mostrar los registros recientes y filtrar por producto y estado.');
  const sku = canonicalProductSku(message) || message.match(/\bSKU-[\w.-]{1,100}\b/i)?.[0];
  const targetText = text.replace(/[¿?¡!]/g, '').trim();
  const target = targetText.match(/\bproducto\s+(.+)$/)?.[1]
    || targetText.match(/\b(?:del|para|de)\s+(?:el\s+)?((?:(?!\b(?:de|del|para)\b).)+)$/)?.[1];
  const reference = sku || (target && !/^(?:inventario|stock|entrega|entregas|outbox|reintentos?|reintentar|reintento|alertas?|mis\s+alertas?|reglas?\s+de\s+stock)\b/.test(target)
    ? target.replace(/\s+(?:abiertas?|resueltas?|pendientes?|entregadas?|enviadas?|omitidas?|fallidas?)$/, '').trim() : undefined);
  const contextual = /\b(?:sus|su|ese producto|este producto)\b/.test(text);
  return scopeReadProduct(plan, reference, memory, contextual);
};
const routeTemporalGuard = (message, memory = {}, now = new Date(), businessId) => {
  const text = normalize(message);
  const relative = relativeSalesPeriod(text, now);
  if (relative?.clarificationQuestion) return clarify(relative.clarificationQuestion);
  const isoDates = message.match(/\d{4}-\d{2}-\d{2}/g) || [];
  const naturalDates = [...text.matchAll(/\b\d{1,2}\s+de\s+[a-z]+\s+de\s+20\d{2}\b/g)];
  if (relative && (isoDates.length || naturalDates.length))
    return clarify('Indica un único periodo; la fecha explícita y el periodo relativo son distintos.');
  const forecast = routeForecastTemporalQuery(message, memory, now, businessId);
  if (forecast) return forecast;
  if (/\b\d{1,2}[/-]\d{1,2}[/-]20\d{2}\b/.test(text))
    return clarify('Indica la fecha con formato YYYY-MM-DD o con día, mes y año escritos completos.');
  const temporalTarget = text.replace(/[¿?¡!]/g, '').trim()
    .match(/^(?:y\s+)?(?:(?:cual es|cuanto tiene)\s+)?(?:el\s+|la\s+)?(?:stock|minimo|precio|proveedor)\s+(?:(?:de|del|para)\s+)?(.+)$/)?.[1]
    || text.replace(/[¿?¡!]/g, '').trim().match(/\b(?:cuanto|cuanta)\s+(?:stock|inventario|precio|minimo)\s+(?:tiene|cuesta|es)\s+(.+)$/)?.[1]
    || text.replace(/[¿?¡!]/g, '').trim().match(/\bproveedor\s+(.+)$/)?.[1];
  if (temporalTarget && isTemporalOnlyReference(temporalTarget))
    return clarify('Indica el producto o proveedor que deseas consultar; esa expresión corresponde a una fecha o periodo.');
  if (!relative && isTemporalOnlyReference(text.replace(/^[¿?\s]*y\s+/, '')))
    return clarify('Indica qué información deseas consultar y una fecha completa; no usaré un día o mes como nombre de producto.');
  const salesCalendar = /\b(?:ventas?|vendi|vendimos|vendio|vendido)\b/.test(text) ? salesCalendarPeriod(text, now) : null;
  if (salesCalendar?.clarificationQuestion) return clarify(salesCalendar.clarificationQuestion);
  if (salesCalendar && relative) return clarify('Indica un único periodo; el mes o fecha explícita y el periodo relativo son distintos.');
  if (!salesCalendar && (naturalDates.length > 1 || /\b(?:desde|hasta)\b/.test(text) && !relative && isoDates.length !== 2))
    return clarify('Indica el rango completo con dos fechas YYYY-MM-DD; no puedo inferir los límites de ese rango.');
  return null;
};

const routeUnsupportedClaim = message => {
  const text = normalize(message);
  const sku = canonicalProductSku(message);
  if (/\bproveedor(?:es)?\b/.test(text) && /\b(?:retras|atras|demor|incumpl|llego tarde|llegaron tarde)\w*\b/.test(text)
    && /\b(?:por que|que proveedor|caus|motivo|incumpl)\w*\b/.test(text))
    return { intent: 'unsupported_supplier_causality', agent: 'coordinator' };
  if (/\b(?:confianza|confidence|precision|seguridad|segur[oa]|intervalo de confianza|probabilidad de acertar|incertidumbre)\b/.test(text)
    && /\b(?:prediccion|forecast|demanda|modelo)\b/.test(text))
    return { intent: 'forecast_confidence', agent: 'coordinator', ...(sku ? { sku } : {}) };
  if (/\b(?:perder|perdere|perderia|perdido|perdida|perdidas|costar\w*|costo de quedarme sin stock|ventas perdidas)\b/.test(text)
    && /\b(?:si no|sin|no compro|no repongo|no repon|quedarme sin stock)\b/.test(text))
    return { intent: 'unsupported_financial_impact', agent: 'coordinator', ...(sku ? { sku } : {}) };
  return null;
};
/** High-confidence routing only. Unrecognized language is delegated, never guessed. */
const routeOperationalPurchases = (message, now = new Date()) => {
  const text = normalize(message);
  if (!/\bcompras\b/.test(text)
    || /\b(?:vende|vender|compra|comprar|crea|crear|prepara|preparar|registra|registrar|modifica|modificar|edita|editar|actualiza|actualizar|ajusta|ajustar|agrega|agregar|anade|anadir|cancela|cancelar|elimina|eliminar|borra|borrar|confirma|confirmar|confirmo|procede|hazlo)\b/.test(text)
    || /\b(?:ventas|clientes|stock|salud|ordenes|orden|proveedores?|repon|reposicion|recomienda|deberia|pronostico|forecast|demanda|riesgo|presupuesto|plan)\b/.test(text)) return null;
  if (!/\b(?:resumen|resume|registradas|recientes|ultimas|completadas|pendientes|canceladas|cuantas)\b/.test(text)
    && !/\bcompras\s+de\b/.test(text)) return null;
  if (require('./compositeRouting').splitRequests(message).length > 1) return null;
  // Existing procurement questions use "compras pendientes" for supplier orders.
  // Only an explicit ledger reference authorizes interpreting them as transactions.
  if (/\bpendientes\b/.test(text) && !/\b(?:transacciones|registradas)\b/.test(text)) return null;
  const parsed = resolveOperationalPeriod(message, now.toISOString().slice(0, 10));
  if (parsed.clarificationQuestion) return clarify(parsed.clarificationQuestion);
  const statuses = ['completadas', 'pendientes', 'canceladas'].filter(word => text.includes(word));
  if (statuses.length > 1) return clarify('Indica un único estado de las compras: completadas, pendientes o canceladas.');
  const status = ({ completadas: 'completed', pendientes: 'pending', canceladas: 'cancelled' })[statuses[0]];
  const summary = /\b(?:resumen|resume|cuantas)\b/.test(text) && status !== 'pending' && status !== 'cancelled';
  if (summary) {
    if (/\b(?:historial|historico|todas|siempre)\b/.test(text)
      || parsed.explicit && !/\b(?:este mes|mes actual)\b/.test(text))
      return clarify('Puedo resumir las compras completadas del mes actual o listar compras por fechas; no dispongo de un agregado exclusivo de compras para todo el historial.');
    return { intent: 'business_summary', agent: 'analyst', purchasesOnly: true, periodExplicit: true,
      period: monthPeriod(now), limit: 5 };
  }
  return { intent: 'recent_transactions', agent: 'procurement', type: 'purchase', status,
    periodRequested: parsed.explicit, periodExplicit: parsed.explicit, period: parsed.period, limit: 5, purchasesOnly: true };
};
const routeDeterministically = (message, memory = {}, now = new Date(), conversationId, scopeBinding, businessId) => {
  const operationalStock = routeOperationalStock(message, memory);
  if (operationalStock) return operationalStock;
  const tenantGuard = tenantScopeViolation(message);
  if (tenantGuard) return tenantGuard;
  const purchases = routeOperationalPurchases(message, now);
  if (purchases) return purchases;
  if (require('./domainGate').isOutOfDomain(message)) return { intent: 'unsupported', agent: 'coordinator' };
  const alertText = normalize(message);
  const recognizedRelativePeriod = relativeSalesPeriod(alertText, now);
  // Forecast dates must win before a product/context route can request replay.
  const temporalGuard = routeTemporalGuard(message, memory, now, businessId);
  if (temporalGuard) return temporalGuard;
  const alertRead = routeAlertRead(message, memory, now);
  if (alertRead) return alertRead;
  // Supplier offer references must precede the generic product-pronoun route.
  const supplierText = normalize(require('./supplierReference').supplierLanguage(message));
  if (/\b(?:sus productos|sus ofertas|su precio para|que productos ofrece)\b/.test(supplierText)
    || /\b(?:ese|este|el mismo|ese mismo) proveedor\b/.test(supplierText)
    || /\bcuesta\b.*\bcon\b.*\bproveedor\b/.test(supplierText) && !/\breponer\b/.test(supplierText)) {
    const supplierPlan = /\b(?:reponer|reposicion)\b/.test(supplierText)
      ? routeCommercial(message, memory) : routeSupplierProducts(message, memory) || routeCommercial(message, memory);
    if (supplierPlan) return supplierPlan;
  }
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
  const structuredDisplaySku = structuredProductDisplaySku(message);
  const standaloneSku = /^(?:sku\s+)?M5-[A-Z]+_\d+_\d+$/i.test(message.trim()) ? canonicalProductSku(message) : null;
  const bareDisplayName = /^(?:[\p{L}]+\s+)*m5\s+(?:foods|hobbies|household)_\d+\s+item\s+\d+$/u
    .test(alertText.replace(/[·•]/g, ' ').replace(/\s+/g, ' ').trim());
  const asksBasicProductDetail = /\b(?:stock|precio|minimo|activo|estado)\b/.test(alertText)
    && /\b(?:cuanto|cuanta|cual|dime|muestrame|esta|tiene)\b/.test(alertText)
    && !/\b(?:reponer|reposicion|proveedor|oferta|compra|costo)\b/.test(alertText);
  if (structuredDisplaySku && (asksBasicProductDetail || bareDisplayName)) return { intent: 'product_details', agent: 'operations',
    selector: { sku: structuredDisplaySku }, limit: 1 };
  if (standaloneSku) return { intent: 'product_details', agent: 'operations', selector: { sku: standaloneSku }, limit: 1 };
  const unsupportedClaim = routeUnsupportedClaim(message);
  if (unsupportedClaim) return unsupportedClaim;
  const specificForecast = require('./forecastRouting').routeForecastProductQuery(message, memory);
  if (specificForecast) return specificForecast;
  if (explicitProductQuery) return scopeReadProduct({ intent: /prediccion|forecast/.test(normalize(message)) ? 'demand_forecast' : 'product_details',
    agent: /prediccion|forecast/.test(normalize(message)) ? 'analyst' : 'operations', lookupQuery: explicitProductQuery, limit: 1,
    explicitEntity: true }, explicitProductQuery, memory);
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
  const asksSalesCausality = /\b(?:por que|caus|motivo)\w*\b/.test(text)
    && /\b(?:baj|disminu|cayer|caid|descend|menor)\w*\b/.test(text) && /\b(?:venta|vend)\w*\b/.test(text);
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
  if (explicitProductSku && asksBasicProductDetail) return { intent: 'product_details', agent: 'operations',
    selector: { sku: explicitProductSku }, limit: 1 };
  const inventoryText = normalizeBasicInventory(message);
  if (/\b(?:forecast|prediccion|demanda|ready|modelo historico)\b/.test(text)) {
    const analytics = require('./forecastRouting').routeForecastAnalytics(message, memory, now, businessId);
    if (analytics) return analytics;
  }
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
  const explicitRelativePeriod = recognizedRelativePeriod;
  if ((dates || parsedNaturalDate) && explicitRelativePeriod) return clarify('Indica un único periodo; la fecha explícita y el periodo relativo son distintos.');
  const periodFollowupText = text.replace(/[¿?¡!.]/g, '').trim();
  const periodOnlyFollowup = /^(?:y\s+)?(?:en\s+)?(?:los\s+)?(?:hoy|ayer|anteayer|esta semana|ultimos?\s+(?:7|30)\s+dias)$/.test(periodFollowupText);
  const contextualPeriodFollowup = periodOnlyFollowup || /^que paso (?:hoy|ayer|anteayer|ultimos?\s+(?:7|30)\s+dias)$/.test(periodFollowupText);
  if (contextualPeriodFollowup && ['sales_summary', 'sales_causality', 'recent_transactions', 'product_sales_summary'].includes(memory.lastIntent)) {
    if (memory.lastIntent === 'product_sales_summary' && !memory.lastEntity) return clarify('¿Qué producto deseas consultar en ese periodo?');
    return { intent: memory.lastIntent === 'sales_causality' ? 'sales_summary' : memory.lastIntent,
      agent: currentMemoryAgent(memory), period: explicitRelativePeriod,
      ...(memory.lastIntent === 'product_sales_summary' ? { selector: { productId: memory.lastEntity.id } } : {}),
      ...(memory.lastIntent === 'recent_transactions' ? { ...memory.lastTransactionFilters, periodRequested: true } : {}),
      periodExplicit: true, limit: memory.listLimit || 5 };
  }
  if (contextualPeriodFollowup) return clarify('¿Qué información deseas consultar para ese periodo? Por ejemplo, ventas o transacciones.');
  if (!dates && /\b(?:ayer|anteayer|semana|ano pasado|hoy|ultimos?\s+(?:7|30)\s+dias)\b/.test(text)
    && /\b(?:venta\w*|vendi\w*)\b/.test(text) && !explicitRelativePeriod) {
    return clarify('Indica un periodo válido, como hoy, ayer, anteayer, últimos 7 días, esta semana o este mes.');
  }
  if (dates && (dates.length > 2 || !dates.every(isDate) || dates.length === 2 && dates[0] > dates[1])) return clarify('Indica un periodo válido con una fecha o dos fechas YYYY-MM-DD ordenadas.');
  if (!dates && /\b\d{1,2}\s+de\s+[a-z]+\s+de\s+20\d{2}\b/i.test(text) && !parsedNaturalDate) return clarify('No pude validar esa fecha. Indícala con día, mes y año.');
  const salesCalendar = /\b(?:ventas?|vendi|vendimos|vendio|vendido)\b/.test(text) ? salesCalendarPeriod(text, now) : null;
  if (salesCalendar?.clarificationQuestion) return clarify(salesCalendar.clarificationQuestion);
  const explicitPeriod = salesCalendar?.period || (dates ? { startDate: dates[0], endDate: dates[1] || dates[0] }
    : parsedNaturalDate ? { startDate: parsedNaturalDate, endDate: parsedNaturalDate } : explicitRelativePeriod);
  const period = explicitPeriod || (memory.lastPeriodExplicit === true ? memory.lastPeriod : undefined) || monthPeriod(now);
  const newSalesProduct = memory.lastIntent === 'product_sales_summary'
    && text.replace(/[¿?¡!.]/g, '').trim().match(/^y\s+((?:foods?|item|M5-)[\w\s-]+)$/i)?.[1];
  if ((/\b(?:vendi|vendimos|vendio|vendido|ventas|unidades vendidas)\b/.test(text) || newSalesProduct) && !/\b(?:compra|compras)\b/.test(text)) {
    const salesReference = canonicalProductSku(message) || message.match(/\bSKU-[\w.-]{1,100}\b/i)?.[0]
      || salesEntityReference(text.replace(/[¿?¡!]/g, ''), salesCalendar)
      || (newSalesProduct ? salesEntityReference(`ventas de ${newSalesProduct}`, salesCalendar) : undefined);
    const contextualSales = memory.lastIntent === 'product_sales_summary'
      && /^(?:y\s+)?cuanto\s+(?:vendi|vendio|vendimos)[?.!\s]*$/.test(text.replace(/[¿?]/g, '').trim());
    const explicitProductSales = salesReference && !isTemporalOnlyReference(salesReference)
      && !/^(?:mi|nuestro|el|este)?\s*negocio\b|^(?:la|las)?\s*empresa\b/.test(salesReference);
    if (explicitProductSales || contextualSales) {
      return scopeReadProduct({ intent: 'product_sales_summary', agent: 'operations', period,
        periodExplicit: Boolean(explicitPeriod || memory.lastPeriodExplicit === true), limit: 1 }, salesReference, memory, contextualSales);
    }
  }
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
    return { intent: memory.lastIntent, agent: currentMemoryAgent(memory), period,
      ...(memory.lastIntent === 'recent_transactions' ? memory.lastTransactionFilters || {} : {}),
      limit: Math.min(limits[memory.lastIntent], (memory.listLimit || 5) * 2), more: true };
  }
  if (/^(y )?(el )?mes (pasado|anterior)[?.!\s]*$/.test(text.replace(/[¿?]/g, '').trim())) {
    if (!PERIOD_INTENTS.includes(memory.lastIntent)) return clarify('¿Qué información deseas consultar del mes pasado?');
    if (memory.lastIntent === 'product_sales_summary' && !memory.lastEntity) return clarify('¿Qué producto deseas consultar del mes pasado?');
    return { intent: memory.lastIntent, agent: currentMemoryAgent(memory), period,
      ...(memory.lastIntent === 'recent_transactions' ? { ...memory.lastTransactionFilters, periodRequested: true } : {}),
      ...(memory.lastIntent === 'product_sales_summary' ? { selector: { productId: memory.lastEntity.id } } : {}), limit: memory.listLimit || 5 };
  }
  let plan;
  if (isLowStockQuery(inventoryText)) plan = { intent: 'low_stock', agent: 'operations' };
  else if (/transacciones.*(ultim|recient|completad|pendient|cancelad)|(ultim|recient).*transacciones|ventas recientes|ultimas ventas/.test(text)
    || /\b(?:ultimas compras|compras (?:pendientes|canceladas))\b|\bdame \d+ compras recientes\b/.test(text)
    || /^dame movimientos de ventas y compras[?!.]*$/.test(text.trim())
    || /\btransacciones\b/.test(text) && explicitPeriod
    || /\bcompras?\b/.test(text) && explicitPeriod) plan = { intent: 'recent_transactions', agent: 'operations' };
  else if (/mas vendidos|mayores ventas|se venden mas|\branking por unidades vendidas\b|\btop\s+(?:\d+\s+)?productos\s+(?:vendidos|por ventas)\b/.test(text))
    plan = { intent: 'top_selling_products', agent: 'analyst', ...(/\btop\s+(\d+)\b/.test(text) ? { limit: Math.min(20, Number(text.match(/\btop\s+(\d+)\b/)[1])) } : {}) };
  else if (/\b(?:vendimos|ventas?|vendi|cuantas? ventas?|cuanto.*vendid[oa]|total vendido)\b/.test(text)
    && !/\bcompras?\b/.test(text)
    && (explicitPeriod || /\b(?:vendi|vendimos|ventas)\b/.test(text))) plan = { intent: 'sales_summary', agent: 'operations' };
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
    plan.periodRequested = Boolean(explicitPeriod);
    plan.type = /\bventas?\b/.test(text) && /\bcompras?\b/.test(text) ? undefined
      : /\bventas?\b/.test(text) ? 'sale' : /\bcompras?\b/.test(text) ? 'purchase' : undefined;
    plan.status = /completad/.test(text) ? 'completed' : /pendient/.test(text) ? 'pending' : /cancelad/.test(text) ? 'cancelled' : undefined;
  }
  if (sku && plan.intent === 'replenishment_candidates') { plan.intent = 'demand_forecast'; plan.needsProduct = true; }
  const nameTarget = message.match(/(?:demanda\s+(?:tendr[aá]|de|para)|predicci[oó]n\s+(?:de|para))\s+(.+?)[?.!]*$/i)?.[1];
  if (plan.intent === 'demand_forecast' && nameTarget && isTemporalOnlyReference(nameTarget))
    return clarify('Indica el producto y una fecha completa. El modelo disponible ofrece un replay histórico agregado, no una predicción diaria.');
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
  if (['sales_summary', 'product_sales_summary', 'top_selling_products'].includes(plan.intent)) plan.agent = 'sales';
  if (plan.intent === 'recent_transactions' && /ventas|\bsale\b/.test(text) && !/compras/.test(text)) {
    plan.agent = 'sales'; plan.type = 'sale';
  }
  if (plan.intent === 'recent_transactions' && plan.type === 'purchase') plan.agent = 'procurement';
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

// Date-only analytics adapters reuse the hardened parser with a caller-owned
// operational calendar. Existing operational routes retain their UTC clock.
const resolveOperationalPeriod = (message, operationalDate) => {
  const text = normalize(message), now = new Date(`${operationalDate}T12:00:00Z`);
  const iso = text.match(/\d{4}-\d{2}-\d{2}/g);
  if (iso) {
    if (relativeSalesPeriod(text, now)) return { clarificationQuestion: 'Indica un único periodo; no mezcles fechas explícitas con otro periodo relativo.' };
    if (iso.length > 2 || !iso.every(isDate) || (iso[1] && iso[0] > iso[1])) return { clarificationQuestion: 'Indica fechas completas y ordenadas.' };
    return { period: { startDate: iso[0], endDate: iso[1] || iso[0] }, explicit: true };
  }
  const calendar = salesCalendarPeriod(`ventas ${text}`, now);
  if (calendar?.clarificationQuestion) return calendar;
  const relative = relativeSalesPeriod(text, now);
  if (relative?.clarificationQuestion) return relative;
  const natural = /\b\d{1,2}\s+de\s+[a-z]+\s+de\s+20\d{2}\b/.test(text) ? parseRequestedDate(text) : null;
  const period = calendar?.period || relative || (natural ? { startDate: natural, endDate: natural } : null);
  if (/\b(?:desde|hasta|entre)\b/.test(text) && !period) return { clarificationQuestion: 'Indica un rango completo con día, mes y año.' };
  if (period) return { period: { ...period, endDate: /este mes/.test(text) ? operationalDate : period.endDate }, explicit: true };
  return { period: rollingPeriod(now, 30), explicit: false };
};
module.exports = { routeDeterministically, routeOperationalStock, routeOperationalPurchases, isProductCountQuery, routeCommercial, routeSupplierProducts, monthPeriod, weekPeriod, clarify, resolveOperationalPeriod,
  budgetPlanFollowupType, tenantScopeViolation, routeCompoundProductList, canonicalProductSku, explicitProductDetailQuery, routeTemporalGuard };
