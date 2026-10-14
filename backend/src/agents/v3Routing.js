'use strict';

const { V3_SKILLS } = require('./v3Skills');
const { isObjectId, isDate, validateSkillArgs } = require('./contracts');
const { ordinalSelection } = require('./ordinalSelection');
const { normalize } = require('../automations/entityResolution');
const { resolveOperationalPeriod } = require('./intentRouting');
const { addCalendarDays } = require('../utils/operationalClock');
const { contextBinding, TTL_MS } = require('./memory');
const clean = text => normalize(text).replace(/\bq\b/g, 'que').replace(/\bd\b/g, 'de')
  .replace(/\bprodcutos\b/g, 'productos').replace(/\bstan\b/g, 'estan').replace(/\breposision\b/g, 'reposicion');
const trimRef = text => {
  const ref = String(text || '').replace(/[¿?¡!]/g, '').trim()
    .replace(/\s+(?:para\s+(?:los\s+)?pr[oó]ximos?\s+\d+\s+d[ií]as?|hoy|ayer|anteayer|esta semana|este mes|el mes pasado|los proximos|los próximos|los ultimos|los últimos|en los|durante|para mañana|manana|mañana|por favor|el \d+ de).*$/i, '').trim();
  return /^(?:el|ella|ellos|eso|ayer|hoy|anteayer|manana)$/.test(normalize(ref)) ? null : ref;
};
const productRef = message => message.match(/\b(?:[A-Z]{2,}(?:-[A-Z0-9]+){1,5}|M5-[A-Z]+_\d+_\d+)\b/)?.[0]
  || trimRef(message.match(/(?:\bde(?:l)?|junto con|junto a|con)\s+(.+?)(?:\s+y\s+|$)/i)?.[1]);
const task = (skillId, args = {}, extra = {}) => ({ skillId, agent: V3_SKILLS[skillId].agents[0], args: { limit: 5, ...args }, ...extra });
const operationalDateOf = binding => binding.operationalDate || binding.asOfDate;
const queryPeriod = (message, binding, memory, followup = false) => {
  const operationalDate = operationalDateOf(binding);
  const parsed = resolveOperationalPeriod(message, operationalDate);
  if (parsed.clarificationQuestion) return parsed;
  if (followup && !parsed.explicit && memory.selectedPeriod) parsed.period = memory.selectedPeriod;
  if (parsed.period.endDate > operationalDate || parsed.period.startDate < '2025-10-13') return { clarificationQuestion: 'El periodo debe estar dentro del histórico disponible y no superar la fecha operativa actual.' };
  return { startDate: parsed.period.startDate, endDate: parsed.period.endDate };
};

const routeV3 = (message, state, binding) => {
  const text = clean(message), memory = state || {};
  const horizonFollowup = /^(?:y )?(?:para )?(?:los )?proximos? \d+ dias?$/.test(text);
  if (horizonFollowup && memory.lastFamily !== 'get_product_forecast') {
    return { clarificationQuestion: '¿De qué producto deseas consultar el pronóstico? No hay un pronóstico previo en esta conversación.' };
  }
  if (/confianza|confidence|intervalo.*prediccion/.test(text)) return { clarificationQuestion: 'El pronóstico V3 no expone una confianza exacta ni un intervalo de predicción. WAPE no es una probabilidad de acierto individual.' };
  if (/^(?:y )?(?:hoy|ayer|anteayer)$/.test(text) && memory.lastFamily === 'get_business_analytics') {
    const period = queryPeriod(message, binding, memory, true);
    return period.clarificationQuestion ? period : { tasks: [task('get_business_analytics', { mode: 'summary', metric: 'revenue', ...period })] };
  }
  if (/(?:proveedor.*(?:vende|provee)|quien.*(?:provee|abastece))/.test(text)) {
    const ref = productRef(message) || (/\blo\b/.test(text) ? memory.selectedProduct?.key : null);
    if (ref) return { tasks: [task('get_supplier_intelligence', { mode: 'rank', productRef: ref })] };
    if (/\blo\b/.test(text)) return { clarificationQuestion: '¿De qué producto deseas consultar los proveedores?' };
  }
  if (/^por que/.test(text) && /proveedor/.test(text)) return null;
  if (/alternativas|alternativo/.test(text) && /proveedor/.test(text)) {
    const ref = productRef(message) || trimRef(message.match(/para\s+(.+)$/i)?.[1]) || memory.selectedProduct?.key;
    return ref ? { tasks: [task('get_supplier_intelligence', { mode: 'alternatives', productRef: ref })] }
      : { clarificationQuestion: '¿De qué producto deseas conocer los proveedores alternativos?' };
  }
  if (/cuesta|costo|presupuesto/.test(text) && /reponer|reposicion/.test(text)) return { clarificationQuestion: 'Puedo mostrar la recomendación de reposición al corte V3. El cálculo comercial de costo/presupuesto V3 aún no está habilitado; consulta las ofertas configuradas del producto.' };
  if (/^(?:vende|vender|compra|comprar|crea|crear|avisa|avisame|actualiza|ajusta|confirma|confirmar|cancela|cancelar|si hazlo|procede|adelante|no lo hagas|mejor no)\b/.test(text)) return null;
  if (/^(?:haz|hacer|realiza) (?:el pedido|la compra)$/.test(text)) return { clarificationQuestion: 'Indica la cantidad y el proveedor del pedido. Prepararé el preview para que lo revises y confirmes; la recomendación no ejecuta una compra.' };
  if (/^por que (?:ocurre|pasa) (?:esto|eso)$/.test(text) && memory.lastFamily) return { clarificationQuestion: 'Estos datos muestran hechos y asociaciones observadas; no permiten demostrar su causa. Puedo comparar periodos o ampliar un dominio.' };
  // Only the three approved compound forms; no unbounded general planner.
  if (/ y /.test(text)) {
    if (/stock/.test(text) && /pronostic|prediccion|forecast|demanda|vendere/.test(text)) {
      const ref = productRef(message) || memory.selectedProduct?.key;
      if (!ref) return { clarificationQuestion: '¿De qué producto deseas consultar el stock y el pronóstico?' };
      const forecast = routeV3(message, memory, binding);
      if (!forecast?.tasks?.some(row => row.skillId === 'get_product_forecast')) return { clarificationQuestion: 'Indica si deseas el pronóstico de 1, 7 o 14 días.' };
      return { tasks: [task('get_inventory_intelligence', { mode: 'detail', productRef: ref }), ...forecast.tasks] };
    }
    if (/vend[ií]|ventas/.test(text) && /riesgo|critic|agot/.test(text)) {
      const parts = message.split(/\s+y\s+/i);
      const first = routeV3(parts[0], memory, binding), second = routeV3(parts.slice(1).join(' y '), memory, binding);
      if (first?.tasks && second?.tasks) return { tasks: [...first.tasks, ...second.tasks] };
    }
    if (/vend[ií]|ventas/.test(text) && /reponer|reposicion/.test(text)) {
      const parts = message.split(/\s+y\s+/i);
      const first = routeV3(parts[0], memory, binding), second = routeV3(parts.slice(1).join(' y '), memory, binding);
      if (first?.tasks && second?.tasks) return { tasks: [...first.tasks, ...second.tasks] };
    }
    if (/proveedor/.test(text) && /tarda|demora/.test(text) && /critic/.test(text)) return { tasks: [task('get_supplier_intelligence', { mode: 'rank', metric: /tarda/.test(text) ? 'lead_time' : 'delays', sortDirection: 'desc', limit: 1 }),
      task('get_inventory_intelligence', { mode: 'rank', risk: 'CRITICAL' }, { fromPrevious: 'supplier' })] };
    if (/mejor cliente|cliente.*compra mas/.test(text) && /suele comprar|preferencia/.test(text)) return { tasks: [task('get_customer_intelligence', { mode: 'rank', metric: 'spend', limit: 1 }),
      task('get_customer_intelligence', { mode: 'preferences' }, { fromPrevious: 'customer' })] };
  }
  if (/como (?:esta|va) (?:mi|el) negocio|como va el negocio|resumen general|diagnostico general|que deberia revisar hoy|salud (?:de|del)|principales problemas/.test(text)) {
    const period = queryPeriod(message, binding, memory);
    return period.clarificationQuestion ? period : { tasks: [task('get_business_health', period)] };
  }
  if (/amplia (?:el )?inventario/.test(text)) return { tasks: [task('get_inventory_intelligence', { mode: 'rank', metric: 'stockout_risk' })] };
  if (/amplia (?:los )?clientes/.test(text)) return { tasks: [task('get_customer_intelligence', { mode: 'rank', metric: 'spend' })] };
  const customerLanguage = /clientes?|gast[oó]|gasto|suele comprar|suelen comprar|preferencias|recencia|frecuencia|quien me compra|que compra /.test(text);
  if (customerLanguage && !/negocio|categoria|producto.*vendido|proveedor|sup \d+/.test(text)) {
    const ref = message.match(/\bCLI-\d+\b/i)?.[0] || trimRef(message.match(/(?:busca a|cliente|gasto|gastó|comprar|compra)\s+([A-ZÁÉÍÓÚÑ][\p{L}\s]+?)(?:\s+(?:en|este|el mes|los últimos)|[?]|$)/u)?.[1]);
    const general = /clientes|quienes|quien.*compra mas|mejor cliente/.test(text);
    const selected = ref || (!general && memory.lastFamily === 'get_customer_intelligence' && /\bsu\b|que suele|cuanto gasto|que compra|que prefiere/.test(text) ? memory.selectedCustomer?.key : null);
    const mode = /prefer|suele comprar|suelen comprar|que compra/.test(text) ? 'preferences' : selected ? 'detail' : 'rank';
    const args = { mode, metric: /frecuencia|frecuente/.test(text) ? 'tickets' : /recencia/.test(text) ? 'recency' : 'spend', ...(selected ? { customerRef: selected } : {}) };
    if (/riesgo/.test(text)) args.segment = 'AT_RISK';
    if (/inactiv|dejaron de comprar/.test(text)) args.segment = 'INACTIVE';
    if (/nuevos/.test(text)) args.segment = 'NEW';
    if (/consumidor final/.test(text)) return { clarificationQuestion: 'Consumidor Final es un agregado anónimo; no tiene un perfil RFM individual.' };
    if (mode === 'preferences' && !selected) return { clarificationQuestion: '¿De qué cliente deseas conocer las preferencias?' };
    if (/gasto|gastó|gastaron|gastado/.test(message) || /este mes|ultimos|ayer|hoy/.test(text)) {
      const period = queryPeriod(message, binding, memory); if (period.clarificationQuestion) return period; Object.assign(args, period);
    }
    return { tasks: [task('get_customer_intelligence', args)] };
  }
  if (/proveedor|abastece|lead time|puntualidad|retrasos|dependencia|\bsup \d+\b/.test(text)
    || /que productos me vende/.test(text) && memory.selectedSupplier) {
    if (/precio|barato|cuesta|cost[oó]/.test(text)) return null; // existing configured-offer skills
    if (/mejor|peor/.test(text) && !/tarda|demora|gasto|compras|lead time|puntual|depend/.test(text)) return { clarificationQuestion: '¿Qué métrica deseas comparar: gasto, órdenes, lead time, puntualidad o dependencia? No hay un score de mejor proveedor.' };
    const ref = message.match(/\bSUP-\d+\b/i)?.[0] || trimRef(message.match(/(?:lead time|puntualidad|retrasos|gasto)\s+(?:de|del)\s+(?:proveedor\s+)?(.+)$/i)?.[1]);
    if (/critic|alto riesgo/.test(text)) return { tasks: [task('get_inventory_intelligence', { mode: 'rank', risk: /critic/.test(text) ? 'CRITICAL' : 'HIGH',
      ...(ref || memory.selectedSupplier ? { supplierRef: ref || memory.selectedSupplier.key } : {}) })] };
    const general = /que proveedor|proveedores|quien.*abastece|de que proveedor/.test(text);
    const selected = ref || (!general && /\bsu\b|me vende|productos|lead time|puntual/.test(text) ? memory.selectedSupplier?.key : null);
    const args = { mode: selected ? 'detail' : 'rank', metric: /tarda|demora|retras/.test(text) ? 'delays' : /lead time/.test(text) ? 'lead_time' : /puntual/.test(text) ? 'punctuality' : /depend/.test(text) ? 'dependency' : /orden|pedido/.test(text) ? 'orders' : 'spend', ...(selected ? { supplierRef: selected } : {}) };
    if (/tarda/.test(text)) args.metric = 'lead_time';
    if (/tarda mas|demora mas|mas retras/.test(text)) args.sortDirection = 'desc';
    if (/menor|menos|rapido/.test(text)) args.sortDirection = 'asc';
    if (/que productos/.test(text) && !selected) return null; // ordinary supplier product resolution
    const parsed = resolveOperationalPeriod(message, operationalDateOf(binding));
    if (parsed.clarificationQuestion) return parsed;
    if (parsed.explicit) Object.assign(args, parsed.period);
    return { tasks: [task('get_supplier_intelligence', args)] };
  }
  if (/junt[oa]s|junto con|junto a|cross sell|canasta|acompan|asociacion/.test(text)) {
    const ref = productRef(message) || (/\bel\b|\beso\b|\bsu\b/.test(text) ? memory.selectedProduct?.key : null);
    return { tasks: [task('get_cross_sell_recommendations', { mode: ref ? 'recommend' : 'rules', ...(ref ? { productRef: ref } : {}) })] };
  }
  if (horizonFollowup || /pronostic|prediccion|forecast|demanda|cuanto vendere|manana|proxima semana/.test(text)) {
    const ref = productRef(message) || (horizonFollowup || /\bsu\b|^y |manana/.test(text) ? memory.selectedProduct?.key : null);
    const horizon = Number(text.match(/\b(\d+) dias?\b/)?.[1] || (/manana/.test(text) ? 1 : /14|dos semanas/.test(text) ? 14 : 7));
    if (/como calcul|metodo|metodologia/.test(text)) return { tasks: [task('get_product_forecast', { mode: 'method' })] };
    if (![1, 7, 14].includes(horizon) || /proximo mes|28 dias/.test(text)) return { clarificationQuestion: 'El horizonte validado para este escenario llega a 14 días.',
      suggestions: [7, 14].map(days => ({ label: `Consultar ${days} días`, message: ref ? `pronóstico de ${ref} próximos ${days} días` : `pronóstico próximos ${days} días` })) };
    if (/esta semana/.test(text)) return { clarificationQuestion: 'El pronóstico admite horizontes agregados de 1, 7 o 14 días desde el corte del escenario. ¿Cuál deseas?' };
    if (!ref && /ayer/.test(text)) return { clarificationQuestion: '¿De qué producto deseas consultar la predicción de ayer?' };
    const args = { mode: ref ? 'detail' : /mayor|mas|top/.test(text) ? 'rank' : 'summary', horizonDays: horizon, ...(ref ? { productRef: ref } : {}) };
    const compare = /compar/.test(text) && message.match(/(?:demanda|forecast|predicci[oó]n|pron[oó]stico)\s+(?:de\s+)?(.+)\s+y\s+(.+)$/i);
    if (compare) { delete args.productRef; args.mode = 'compare'; args.productRefs = [trimRef(compare[1]), trimRef(compare[2])].join('|'); }
    if (/ayer/.test(text)) args.asOfDate = addCalendarDays(operationalDateOf(binding), -1);
    return { tasks: [task('get_product_forecast', args)] };
  }
  if (/stock|inventario|disponible/.test(text) && /cuant|queda|qued|tiene|hay|disponible|inventario de|stock de|stock del/.test(text)) {
    const ref = productRef(message) || (memory.selectedProduct?.key && /^(?:y |cuanto|que|cual|esta|hay|queda)/.test(text)
      ? memory.selectedProduct.key : null);
    if (!ref && !/bajo|critico|agot|riesgo|sobre/.test(text)) return { clarificationQuestion: '¿De qué producto deseas consultar el stock disponible?' };
    if (ref) return { tasks: [task('get_inventory_intelligence', { mode: 'detail', productRef: ref })] };
  }
  if (/reponer|reposicion|deberia pedir|debo pedir|cuanto pedir|agot|acabando|critic|alto riesgo|riesgo|sobrestock|lento|sin movimiento|\babc\b|\bxyz\b|\baz\b/.test(text)
    || /stock bajo|bajos.*stock/.test(text)) {
    const ref = productRef(message) || (/cuanto|\bsu\b/.test(text) ? memory.selectedProduct?.key : null);
    const args = { mode: ref ? 'detail' : 'rank', metric: 'reorder', ...(ref ? { productRef: ref } : {}) };
    if (/critic/.test(text)) args.risk = 'CRITICAL';
    if (/alto riesgo/.test(text)) args.risk = 'HIGH';
    if (/stock bajo|bajos.*stock/.test(text)) args.flag = 'low_stock';
    if (/sobrestock/.test(text)) args.flag = 'overstock';
    if (/lento/.test(text)) args.flag = 'slow_moving';
    if (/sin movimiento/.test(text)) args.flag = 'dead_stock';
    if (/\baz\b/.test(text)) { args.abc = 'A'; args.xyz = 'Z'; }
    if (/\babc\b/.test(text) && !args.abc) args.mode = 'summary';
    if (/\bxyz\b/.test(text) && !args.xyz) args.mode = 'summary';
    if (/alguno|sus productos/.test(text) && memory.selectedSupplier) args.supplierRef = memory.selectedSupplier.key;
    if (!ref && /cuanto.*pedir/.test(text)) return { clarificationQuestion: '¿De qué producto deseas consultar la cantidad sugerida?' };
    return { tasks: [task('get_inventory_intelligence', args)] };
  }
  if (/ventas|vendi|vendimos|vendio|mas vendido|venta|margen|ticket|ingreso|por categoria/.test(text)) {
    const followup = /^y |por categoria/.test(text);
    const period = queryPeriod(/mas que.*semana pasada/.test(text) ? message.replace(/semana pasada/i, 'esta semana') : message, binding, memory, followup); if (period.clarificationQuestion) return period;
    const args = { mode: /mas vendido|categoria.*margen|por categoria|ranking|top/.test(text) ? 'rank' : /mas que|compar|semana pasada/.test(text) ? 'compare' : 'summary',
      metric: /margen/.test(text) ? 'gross_margin' : /tickets/.test(text) ? 'tickets' : /unidades|mas vendido/.test(text) ? 'units' : 'revenue', ...period };
    if (args.mode === 'rank') args.entityType = /categoria/.test(text) ? 'category' : 'product';
    const category = trimRef(message.match(/\b(?:de|en)\s+(?:la\s+)?categor[ií]a\s+(.+)$/i)?.[1]), subcategory = trimRef(message.match(/\b(?:de|en)\s+(?:la\s+)?subcategor[ií]a\s+(.+)$/i)?.[1]);
    if (category) args.categoryRef = category;
    if (subcategory) args.subcategoryRef = subcategory;
    let ref = !category && !subcategory && /vendi de|ventas de/.test(text) ? productRef(message) : null;
    if (ref && /^(?:los?\s+)?(?:ultimos?\s+\d+\s+dias?|hoy|ayer|anteayer|esta semana|este mes|mes pasado)$/i
      .test(normalize(ref))) ref = null;
    if (ref) args.productRef = ref;
    return { tasks: [task('get_business_analytics', args)] };
  }
  if (/^busca (?:a )?/.test(text) || /^[\p{L}\d .-]{3,100}$/u.test(message.trim()) && !/^(?:y|si|ok|vale|dale|correcto|de acuerdo|no|precio|stock|minimo|que|cuanto|esta|el|la)\b/.test(text)) {
    return { lookup: trimRef(message.replace(/^busca(?: a)?\s+/i, '')) };
  }
  return null;
};

const compactV3State = (value, now = Date.now()) => {
  if (!value || typeof value.binding !== 'string' || !/^[a-f\d]{64}$/.test(value.binding)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + TTL_MS) return null;
  const entity = row => row && ['product', 'customer', 'supplier', 'category', 'subcategory'].includes(row.type) && isObjectId(row.id)
    && typeof row.key === 'string' && row.key.length <= 100 && typeof row.label === 'string' && row.label.length <= 100
    ? { type: row.type, id: row.id, key: row.key, label: row.label } : null;
  const tasks = (value.pending?.tasks || []).slice(0, 4).map(item => {
    if (!V3_SKILLS[item?.skillId]) return null;
    try { return { skillId: item.skillId, agent: V3_SKILLS[item.skillId].agents[0], args: validateSkillArgs(require('./skills').getSkillDefinition(item.skillId).inputSchema, item.args),
      ...(['customer', 'supplier'].includes(item.fromPrevious) ? { fromPrevious: item.fromPrevious } : {}) }; } catch { return null; }
  }).filter(Boolean);
  return { binding: value.binding, expiresAt: value.expiresAt,
    selectedProduct: entity(value.selectedProduct), selectedCustomer: entity(value.selectedCustomer), selectedSupplier: entity(value.selectedSupplier),
    readRecommendation: value.readRecommendation && typeof value.readRecommendation.sku === 'string' && value.readRecommendation.sku.length <= 100
      && Number.isSafeInteger(value.readRecommendation.quantity) && value.readRecommendation.quantity > 0 && value.readRecommendation.quantity <= 1000000
      ? { sku: value.readRecommendation.sku, quantity: value.readRecommendation.quantity,
        supplierCode: /^SUP-\d{2}$/.test(value.readRecommendation.supplierCode || '') ? value.readRecommendation.supplierCode : null } : null,
    selectedPeriod: value.selectedPeriod && isDate(value.selectedPeriod.startDate) && isDate(value.selectedPeriod.endDate) ? { startDate: value.selectedPeriod.startDate, endDate: value.selectedPeriod.endDate } : null,
    lastFamily: Object.keys(V3_SKILLS).includes(value.lastFamily) ? value.lastFamily : null,
    ranking: value.ranking && ['product', 'customer', 'supplier', 'category', 'subcategory'].includes(value.ranking.type) ? { type: value.ranking.type,
      items: (value.ranking.items || []).slice(0, 5).map(entity).filter(Boolean) } : null,
    pending: tasks.length && ['productRef', 'productRefs', 'customerRef', 'supplierRef', 'categoryRef', 'subcategoryRef'].includes(value.pending?.field) ? {
      tasks, field: value.pending.field, query: String(value.pending.query || '').slice(0, 100), type: value.pending.type,
      selectionIndex: Number.isSafeInteger(value.pending.selectionIndex) && value.pending.selectionIndex >= 0 && value.pending.selectionIndex < 5 ? value.pending.selectionIndex : 0,
      offset: Number.isSafeInteger(value.pending.offset) ? Math.max(0, value.pending.offset) : 0 } : null };
};

const money = cents => Number.isFinite(cents) ? `S/ ${(cents / 100).toFixed(2)}` : 'no disponible';
const num = value => Number.isFinite(value) ? Number(value.toFixed(2)).toString() : 'no disponible';
const units = value => Number.isFinite(value) ? require('../utils/assistantFormatting').units(Number(value.toFixed(2))) : 'unidades no disponibles';
const label = row => row.productName || row.displayName || row.name || row.sku || row.customerCode || row.supplierCode || row.categoryName || row.categoryCode;
const segmentLabel = code => ({ AT_RISK: 'en riesgo según actividad observada', INACTIVE: 'sin compras completadas en los últimos 90 días', NEW: 'nuevo', LOYAL: 'frecuente', TOP_HIGH_VALUE: 'alto valor observado', POTENTIAL: 'potencial' })[code] || 'no disponible';
const reasonLabel = code => ({ LOW_DEMAND: 'ventas observadas bajas', PERISHABLE_CAP: 'cantidad limitada por vida útil', BELOW_REORDER_POINT: 'posición por debajo del punto de reposición', NO_INBOUND: 'sin entradas pendientes', INBOUND_INSUFFICIENT: 'entradas pendientes insuficientes', COVER_BELOW_LEAD_TIME: 'cobertura inferior al plazo observado', LEAD_TIME_EXCEEDS_FORECAST_HORIZON: 'plazo superior al horizonte aprobado', INSUFFICIENT_DEMAND_VARIABILITY_HISTORY: 'historia insuficiente de variabilidad', LOW_STOCK: 'stock bajo', SINGLE_SOURCE: 'un solo proveedor', SLOW_MOVING: 'rotación lenta', DEAD_STOCK: 'sin movimiento observado', OVERSTOCK: 'exceso de stock', STOCKOUT_RISK: 'riesgo de agotamiento' })[code] || 'indicador observado al corte';
const displayMoney = cents => Number.isFinite(cents) ? `S/ ${(cents / 100).toFixed(2)}` : 'no disponible';
const displayNumber = value => Number.isFinite(value) ? Number(value.toFixed(2)) : 'no disponible';
const displayEntityType = (skillId, args) => skillId === 'get_customer_intelligence' ? 'customer'
  : skillId === 'get_supplier_intelligence' ? (args.mode === 'alternatives' ? 'product' : 'supplier')
    : skillId === 'get_cross_sell_recommendations' ? 'product'
    : skillId === 'get_business_analytics' && args.entityType === 'category' ? 'category'
      : ['get_inventory_intelligence', 'get_product_forecast', 'get_business_analytics'].includes(skillId) ? 'product' : null;
const createV3View = async (skillId, result, args, service, context, rankedEntities = []) => {
  const d = result.data || {}, rows = Array.isArray(d.items) ? d.items.slice(0, 5) : [];
  const entityType = displayEntityType(skillId, args), selected = result.metadata.selected?.[entityType];
  const metrics = [], items = [];
  const valueFor = (row, index) => rankedEntities[index] || null;
  const categoryNames = new Map();
  const productNames = new Map();
  for (const row of rows) {
    const code = row.categoryCode || row.subcategoryCode;
    if (entityType === 'category' && code && !row.categoryName && !row.name) {
      const resolved = await service.resolveEntity(row.subcategoryCode ? 'subcategory' : 'category', code, context);
      if (resolved.entity) categoryNames.set(code, resolved.entity.label);
    }
    // Forecast rows carry SKU and quantities, while the backend owns labels.
    if (skillId === 'get_product_forecast' && row.sku && !row.productName && !row.name) {
      if (selected?.key === row.sku) productNames.set(row.sku, selected.label);
      else {
        const resolved = await service.resolveEntity('product', row.sku, context);
        if (resolved.entity) productNames.set(row.sku, resolved.entity.label);
      }
    }
  }
  const itemFor = (row, index, itemMetrics = []) => {
    const resolved = valueFor(row, index), key = resolved?.key || row.sku || row.customerCode || row.supplierCode || row.categoryCode || row.subcategoryCode
      || row.consequentSkus?.[0] || row.recommendedSku;
    const type = resolved?.type || (entityType === 'category' ? 'category' : entityType);
    if (!key || !type) return null;
    const labelText = resolved?.label || row.productName || row.displayName || row.name || row.categoryName || categoryNames.get(key) || productNames.get(key);
    if (!labelText) return null;
    const title = result.metadata.selected?.[type]?.key === key ? result.metadata.selected[type].label : labelText;
    return { type, key, label: title, secondaryLabel: type === 'product' ? key : type === 'category' ? undefined : key,
      metrics: itemMetrics, ...((args.mode === 'rank' || skillId === 'get_cross_sell_recommendations' || skillId === 'get_supplier_intelligence' && args.mode === 'alternatives') ? { selectMessage: key } : {}) };
  };
  let kind = 'business', title = 'Resumen del negocio', subtitle, note;
  if (skillId === 'get_business_analytics') {
    if (d.kpis) {
      const k = d.kpis;
      metrics.push({ label: 'Ventas', value: displayMoney(k.revenueCents) }, { label: 'Unidades', value: Number.isFinite(k.unitsSold) ? k.unitsSold : 'no disponible' },
        { label: 'Tickets', value: Number.isFinite(k.ticketCount) ? k.ticketCount : 'no disponible' },
        { label: 'Ticket promedio', value: Number.isFinite(k.averageTicket) ? displayMoney(k.averageTicket * 100) : 'no disponible' },
        { label: 'Margen bruto', value: Number.isFinite(k.grossMarginPct) ? `${displayNumber(k.grossMarginPct)}%` : 'no disponible' });
      if (args.mode === 'compare' && Number.isFinite(d.trends?.revenue?.percentChange)) metrics.push({ label: 'Variación frente al periodo comparable', value: `${displayNumber(d.trends.revenue.percentChange)}%` });
    }
    if (rows.length) for (let i = 0; i < rows.length; i++) {
      const row = rows[i], metricValue = row.metric ?? row.units ?? row.unitsSold ?? row.revenueCents ?? row.grossMarginCents;
      const metricLabel = args.metric === 'units' ? 'Unidades' : args.metric === 'tickets' ? 'Tickets' : args.metric === 'gross_margin' ? 'Margen' : 'Ventas';
      const metricDisplay = args.metric === 'revenue' || args.metric === 'gross_margin' ? displayMoney(metricValue) : displayNumber(metricValue);
      const item = itemFor(row, i, [{ label: metricLabel, value: metricDisplay }]); if (item) items.push(item);
    }
    subtitle = result.metadata.period ? `${result.metadata.period.startDate} – ${result.metadata.period.endDate}` : undefined;
    note = args.mode === 'compare' ? 'La comparación describe variaciones observadas y no demuestra causalidad.' : undefined;
  } else if (skillId === 'get_inventory_intelligence') {
    kind = 'inventory'; title = selected?.label ? `Inventario · ${selected.label}` : 'Inteligencia de inventario';
    if (d.summary) {
      metrics.push({ label: 'Productos', value: d.summary.products }, { label: 'Críticos', value: d.summary.critical },
        { label: 'Stock bajo', value: d.summary.lowStock }, { label: 'Requieren reposición', value: d.summary.shouldReorder });
      if (d.abcCounts) metrics.push({ label: 'Clasificación ABC', value: Object.entries(d.abcCounts).map(([key, value]) => `${key}: ${value}`).join(' · ') });
      if (d.xyzCounts) metrics.push({ label: 'Variabilidad XYZ', value: Object.entries(d.xyzCounts).map(([key, value]) => `${key}: ${value}`).join(' · ') });
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], item = itemFor(row, i, [
        { label: 'Stock', value: displayNumber(row.stock?.onHand) }, { label: 'Entradas', value: displayNumber(row.stock?.incoming) },
        { label: 'Cobertura', value: Number.isFinite(row.coverage?.daysCover) ? `${displayNumber(row.coverage.daysCover)} días` : 'no disponible' },
        { label: 'Riesgo', value: row.risk?.level || 'no disponible' }, { label: 'Reponer', value: row.recommendation?.shouldReorder ? 'Sí' : 'No' },
        { label: 'Cantidad sugerida', value: displayNumber(row.recommendation?.recommendedQty) },
        { label: 'Motivo', value: (row.risk?.reasonCodes || []).slice(0, 3).map(reasonLabel).join(', ') || 'sin indicador adicional' }
      ]); if (item) items.push(item);
    }
  } else if (skillId === 'get_product_forecast') {
    kind = 'forecast'; title = selected?.label ? `Pronóstico · ${selected.label}` : 'Pronóstico de demanda';
    const horizon = args.horizonDays || d.horizonDays || 7;
    subtitle = d.method ? 'Método validado: media móvil de 28 días · horizontes aprobados: 1, 7 y 14 días.'
      : `${horizon} ${horizon === 1 ? 'día' : 'días'} desde el corte operativo del escenario.`;
    if (d.totalExpectedUnits !== undefined) metrics.push({ label: `Unidades esperadas · ${horizon} ${horizon === 1 ? 'día' : 'días'}`, value: displayNumber(d.totalExpectedUnits) });
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], item = itemFor(row, i, [{ label: `Unidades esperadas · ${horizon} ${horizon === 1 ? 'día' : 'días'}`, value: displayNumber(row[`expectedUnitsNext${horizon}d`]) }]);
      if (item) items.push(item);
    }
    note = d.method ? 'El pronóstico no representa una predicción diaria ni expone una confianza individual.' : 'Fuente: media móvil de 28 días. No es una garantía de ventas.';
  } else if (skillId === 'get_cross_sell_recommendations') {
    kind = 'cross_sell'; title = selected?.label ? `Compras observadas junto con ${selected.label}` : 'Productos que suelen aparecer juntos';
    const sourceRows = rows.slice(0, 5);
    for (let i = 0; i < sourceRows.length; i++) {
      const row = sourceRows[i], names = row.consequentProducts || [row.recommendedProduct], keys = row.consequentSkus || [row.recommendedSku || row.sku];
      const detail = args.mode === 'rules' ? [{ label: 'Frecuencia condicional observada', value: `${displayNumber(row.confidence * 100)}%` },
        { label: 'Lift', value: displayNumber(row.lift) }, { label: 'Estabilidad', value: row.stability?.status || row.stability || 'según artefacto' }]
        : [];
      for (let j = 0; j < Math.min((keys || []).length, 5 - items.length); j++) {
        const key = keys[j], name = names?.[j]; if (!key || !name) continue;
        items.push({ type: 'product', key, label: name, secondaryLabel: key,
          metrics: [{ label: 'Tickets observados', value: row.ticketCount ?? 'no disponible' }, ...detail], selectMessage: key });
      }
    }
    note = `${d.available === false ? 'No hay asociaciones validadas para este corte.' : 'Son compras conjuntas observadas; no demuestran causalidad ni garantizan ventas futuras.'} Artefacto congelado al ${result.metadata.frozenCutoff || result.metadata.asOf}.`;
  } else if (skillId === 'get_customer_intelligence') {
    kind = 'customer'; title = selected?.label ? `Cliente · ${selected.label}` : 'Inteligencia de clientes';
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], prefs = row.preferences || {}, item = itemFor(row, i, [
        { label: 'Segmento', value: segmentLabel(row.segment) }, { label: 'Última compra', value: row.lastPurchaseDate || 'sin compras' },
        { label: 'Tickets', value: row.ticketCount ?? 'no disponible' }, { label: 'Gasto', value: displayMoney(row.totalSpentCents) },
        { label: 'Ticket promedio', value: displayMoney(row.averageTicketCents) },
        ...(args.mode === 'preferences' ? [{ label: 'Categoría preferida', value: prefs.favoriteCategoryName || prefs.categories?.[0]?.name || 'no disponible' },
          { label: 'Productos habituales', value: (prefs.topProducts || []).slice(0, 3).map(p => p.name || p.sku).join(', ') || 'sin datos' }] : [])
      ]); if (item) items.push(item);
    }
    if (d.periodMetrics) metrics.push({ label: 'Gasto del periodo solicitado', value: Object.values(d.periodMetrics).map(row => displayMoney(row.revenueCents)).join(' · ') });
  } else if (skillId === 'get_supplier_intelligence') {
    kind = 'supplier'; title = selected?.label ? `Proveedor · ${selected.label}` : 'Inteligencia de proveedores';
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], item = itemFor(row, i, [
        { label: 'Compras', value: row.purchaseOrderCount ?? 'no disponible' }, { label: 'Gasto recibido', value: displayMoney(row.receivedSpendCents) },
        { label: 'Lead time observado', value: Number.isFinite(row.leadTime?.averageDays) ? `${displayNumber(row.leadTime.averageDays)} días` : 'no disponible' },
        { label: 'Puntualidad', value: Number.isFinite(row.punctuality?.onTimeRatePct) ? `${displayNumber(row.punctuality.onTimeRatePct)}%` : 'no disponible' },
        { label: 'Productos', value: (row.productsSupplied || []).slice(0, 3).map(p => p.name || p.productName || p.sku).join(', ') || `${row.exclusiveOfferedSkuCount ?? 0} exclusivos` }
      ]); if (item) items.push(item);
    }
    if (d.singleSourceCriticalOrHigh) metrics.push({ label: 'Productos de alto riesgo con una sola fuente', value: d.singleSourceCriticalOrHigh.singleSourceCriticalOrHighSkuCount });
    note = 'Métricas descriptivas observadas; no constituyen una calificación de proveedor.';
  } else if (skillId === 'get_business_health') {
    kind = 'health'; title = 'Resumen de salud del negocio';
    const h = d.businessHealth || {};
    metrics.push({ label: 'Ventas', value: displayMoney(h.sales?.kpis?.revenueCents) },
      { label: 'Margen bruto', value: Number.isFinite(h.sales?.kpis?.grossMarginPct) ? `${displayNumber(h.sales.kpis.grossMarginPct)}%` : 'no disponible' },
      { label: 'Clientes en riesgo observado', value: h.customers?.atRiskCount ?? 'no disponible' },
      { label: 'Inventario crítico', value: h.inventory?.critical ?? 'no disponible' },
      { label: 'Proveedores', value: h.suppliers?.summary?.suppliers ?? 'no disponible' },
      { label: 'Asociaciones estables', value: h.marketBasket?.stableCrossSellRuleCount ?? 'no disponible' });
    for (const insight of (d.alerts || []).slice(0, 1)) items.push({ type: 'category', key: String(insight.code || insight.summary || items.length),
      label: insight.summary || insight.code || 'Hallazgo', metrics: [], secondaryLabel: undefined });
    note = `Indicadores descriptivos del corte V3; el resumen no asigna un puntaje global. Market Basket permanece histórico al ${h.marketBasket?.freshness?.analysisCutoff || '2026-10-12'}.`;
  }
  return { kind, title, ...(subtitle ? { subtitle } : {}), metrics: metrics.slice(0, 8), items: items.slice(0, skillId === 'get_business_health' ? 5 : 5),
    ...(note ? { note } : {}) };
};
const renderV3 = (skillId, result, args) => {
  const d = result.data, date = result.metadata.asOf;
  const items = d.items || [];
  const period = result.metadata.period;
  const heading = skillId === 'get_cross_sell_recommendations'
    ? `Escenario V3 · asociaciones históricas al ${result.metadata.frozenCutoff || date}${period ? ` · ${period.startDate} → ${period.endDate}` : ''}.`
    : `Escenario V3 · ${result.metadata.dataMode === 'LIVE' ? 'datos operativos' : 'histórico'} al ${date}${period ? ` · ${period.startDate === period.endDate ? `el ${period.startDate}` : `${period.startDate} → ${period.endDate}`}` : ''}.`;
  const lines = items.slice(0, 5).map((r, i) => {
    if (skillId === 'get_inventory_intelligence') return `${i + 1}. ${label(r)} (${r.sku}) · stock ${num(r.stock?.onHand)} · entradas pendientes ${num(r.stock?.incoming)} · cobertura ${num(r.coverage?.daysCover)} días · riesgo ${r.risk?.level} · cantidad sugerida ${num(r.recommendation?.recommendedQty)} · motivos: ${(r.risk?.reasonCodes || []).map(reasonLabel).join(', ') || 'sin indicador adicional'}.`;
    if (skillId === 'get_product_forecast') return `${i + 1}. ${result.metadata.selected?.product?.label || label(r)} (${r.sku}) · estimación de ventas: ${units(r[`expectedUnitsNext${args.horizonDays || 7}d`])} en ${args.horizonDays || 7} ${args.horizonDays === 1 ? 'día' : 'días'} · media móvil de 28 días.`;
    if (skillId === 'get_customer_intelligence') return `${i + 1}. ${label(r)} · ${segmentLabel(r.segment)} · última compra ${r.lastPurchaseDate || 'sin compras'} · ${num(r.ticketCount)} tickets históricos · gasto histórico ${money(r.totalSpentCents)} · ticket promedio ${money(r.averageTicketCents)}${args.mode === 'preferences' ? ` · categoría preferida: ${r.preferences?.favoriteCategoryName || 'no disponible'} · productos habituales: ${(r.preferences?.topProducts || []).slice(0, 5).map(p => p.name || p.sku).join(', ') || 'sin datos'}` : ''}.`;
    if (skillId === 'get_supplier_intelligence' && args.mode === 'alternatives') return `${i + 1}. ${r.sku} · ${(r.alternatives || []).slice(0, 5).map(offer => `${offer.supplierName || offer.supplierCode}: ${money(offer.unitCostCents)}`).join('; ') || 'sin alternativas configuradas'}.`;
    if (skillId === 'get_supplier_intelligence') return `${i + 1}. ${label(r)} (${r.supplierCode}) · ${num(r.purchaseOrderCount)} compras históricas · gasto histórico recibido ${money(r.receivedSpendCents)} · lead time observado ${num(r.leadTime?.averageDays)} días con ${num(r.leadTime?.sampleSize)} observaciones · puntualidad ${num(r.punctuality?.onTimeRatePct)}% · catálogo exclusivo: ${num(r.exclusiveOfferedSkuCount)} productos · ${(r.productsSupplied || []).slice(0, 5).map(p => p.name || p.productName || p.sku).join(', ')}.`;
    if (skillId === 'get_cross_sell_recommendations') return `${i + 1}. ${(r.consequentProducts || [r.recommendedProduct]).filter(Boolean).join(', ')} (${(r.consequentSkus || [r.recommendedSku || r.sku]).filter(Boolean).join(', ')}) · ${num(r.ticketCount)} tickets · frecuencia condicional observada ${num(Number.isFinite(r.confidence) ? r.confidence * 100 : null)}% · lift ${num(r.lift)} · estabilidad ${r.stability?.status || r.stability || 'según artefacto'}.`;
    return `${i + 1}. ${label(r)} · ${args.metric === 'units' ? units(r.metric ?? r.units ?? r.unitsSold) : args.metric === 'tickets' ? `${num(r.metric ?? r.ticketCount)} tickets` : money(r.metric ?? r[args.metric === 'gross_margin' ? 'grossMarginCents' : 'revenueCents'])}.`;
  });
  if (skillId === 'get_business_analytics' && d.kpis) {
    const k = d.kpis; lines.push(`Ventas ${money(k.revenueCents)} · ${units(k.unitsSold)} · ${num(k.ticketCount)} tickets · ticket promedio ${money(k.averageTicket * 100)} · margen bruto ${num(k.grossMarginPct)}%.`);
    if (args.mode === 'compare') lines.push(`Variación de ventas: ${num(d.trends?.revenue?.percentChange)}% frente al periodo comparable anterior; no demuestra causalidad.`);
  }
  if (skillId === 'get_inventory_intelligence' && d.summary) lines.push(`${num(d.summary.products)} productos · ${num(d.summary.critical)} críticos · ${num(d.summary.lowStock)} con stock bajo · ${num(d.summary.shouldReorder)} requieren reposición. ABC: ${Object.entries(d.abcCounts || {}).map(([key, count]) => `${key}: ${count}`).join(', ')}. XYZ: ${Object.entries(d.xyzCounts || {}).map(([key, count]) => `${key}: ${count}`).join(', ')}.`);
  if (skillId === 'get_product_forecast' && d.method) lines.push('Se usa MOVING_AVERAGE_28: media móvil de 28 días, seleccionada por su generalización en los horizontes operativos de 1, 7 y 14 días del benchmark V3. No expone confianza ni intervalo de predicción.');
  if (skillId === 'get_product_forecast' && d.totalExpectedUnits !== undefined) lines.push(`Estimación agregada: ${units(d.totalExpectedUnits)} en ${d.horizonDays} ${d.horizonDays === 1 ? 'día' : 'días'} desde el corte del escenario.`);
  if (skillId === 'get_customer_intelligence' && d.periodMetrics) lines.push(`Gasto del periodo solicitado: ${Object.entries(d.periodMetrics).map(([code, row]) => `${code}: ${money(row.revenueCents)}`).join('; ')}. El segmento RFM corresponde a su ventana de 90 días.`);
  if (skillId === 'get_supplier_intelligence' && d.singleSourceCriticalOrHigh) lines.push(`Dependencia: ${num(d.singleSourceCriticalOrHigh.singleSourceCriticalOrHighSkuCount)} productos críticos o de alto riesgo con un solo proveedor observado/configurado; no es un score de calidad.`);
  if (skillId === 'get_cross_sell_recommendations') lines.push(d.available === false ? 'No hay asociaciones validadas disponibles para ese corte.' : 'Son compras conjuntas observadas; no demuestran causalidad ni garantizan ventas futuras.');
  if (skillId === 'get_business_health') {
    const h = d.businessHealth;
    if (h) lines.push(`Ventas: ${money(h.sales?.kpis?.revenueCents)}.`, `Margen bruto: ${num(h.sales?.kpis?.grossMarginPct)}%.`,
      `Clientes en riesgo observado: ${num(h.customers?.atRiskCount)}.`, `Inventario: ${num(h.inventory?.critical)} críticos.`,
      `Proveedores: ${num(h.suppliers?.summary?.suppliers)}.`, `Cross-sell: ${num(h.marketBasket?.stableCrossSellRuleCount)} reglas estables.`);
    if (h.marketBasket?.freshness?.analysisCutoff) lines.push(`Market Basket permanece histórico al ${h.marketBasket.freshness.analysisCutoff}.`);
    for (const insight of (d.alerts || []).slice(0, Math.max(0, 7 - lines.length))) lines.push(insight.summary || insight.code);
  }
  if (!lines.length) lines.push('No hay registros que cumplan los filtros solicitados.');
  const horizon = args.horizonDays || 7;
  const forecastDates = skillId === 'get_product_forecast' && !d.method
    ? ` Horizonte del escenario: ${new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10)} → ${new Date(Date.parse(date) + horizon * 86400000).toISOString().slice(0, 10)}.` : '';
  return `${heading}${forecastDates}\n${lines.join('\n')}`;
};

const handleV3 = async ({ message, state, context, service, run, commit }) => {
  let binding;
  try { binding = await service.resolveContext(context); } catch { return { answer: 'El módulo analítico no está disponible en este momento.', intent: 'v3_unavailable', agent: 'coordinator' }; }
  if (!binding) return null;
  const now = Date.now(), saved = compactV3State(state.v3Context, now);
  const memory = saved?.binding === contextBinding(context) ? saved : {};
  const existingProduct = state.selectedProductReference;
  if ((!state.v3Context || state.v3Context.binding === contextBinding(context)) && existingProduct?.sku && existingProduct.sku !== memory.selectedProduct?.key) {
    const resolution = await service.resolveEntity('product', existingProduct.sku, context);
    if (resolution.entity) memory.selectedProduct = resolution.entity;
  }
  if (memory.pending && /^(?:si(?: ese)?|ok|vale|dale|correcto)$/.test(clean(message))) return { answer: 'Elige una entidad por nombre, código o número. Esta selección no confirma una operación.', clarification: true, intent: 'v3_selection', agent: 'coordinator' };
  let plan = routeV3(message, memory, binding);
  const ordinal = ordinalSelection(message), numeric = /^(?:opcion\s+)?([1-5])$/.exec(clean(message));
  const choiceLike = ordinal.matched || Boolean(numeric);
  const candidates = memory.ranking?.items || [];
  const match = candidates.find(row => normalize(row.key) === normalize(message) || normalize(row.label) === normalize(message));
  const index = numeric ? Number(numeric[1]) - 1 : ordinal.index === -1 ? candidates.length - 1 : ordinal.index;
  let selected = match || (choiceLike && index !== null ? candidates[index] : null);
  if (!selected && memory.pending && plan?.lookup) {
    const ranked = require('../automations/entityResolution').rankEntities(candidates.map(row => ({ _id: row.id, name: row.label, sku: row.type === 'product' ? row.key : undefined })), message);
    const value = ranked.value || (ranked.confidence === 'HIGH_CONFIDENCE' && ranked.candidates.length === 1 ? ranked.candidates[0] : null);
    if (value) selected = candidates.find(row => row.id === String(value._id) && row.label === value.name);
  }
  const scope = { ...memory, binding: contextBinding(context), expiresAt: now + TTL_MS };
  const save = () => commit({ v3Context: scope,
    ...(scope.selectedSupplier ? { lastSupplier: { id: scope.selectedSupplier.id, name: scope.selectedSupplier.label } } : {}),
    ...(scope.selectedProduct ? { lastEntity: { id: scope.selectedProduct.id, sku: scope.selectedProduct.key, name: scope.selectedProduct.label },
      selectedProductReference: { id: scope.selectedProduct.id, sku: scope.selectedProduct.key, name: scope.selectedProduct.label } }
      : Object.hasOwn(scope, 'selectedProduct') ? { lastEntity: null, recentEntities: [], selectedProductReference: null } : {}) });
  if (memory.pending && /^(?:ver mas|siguiente|anterior)$/.test(clean(message))) {
    const offset = Math.max(0, memory.pending.offset + (clean(message) === 'anterior' ? -5 : 5));
    const resolution = await service.resolveEntity(memory.pending.type, memory.pending.query, context, offset);
    resolution.selectionIndex = memory.pending.selectionIndex;
    return candidateView(resolution, memory.pending.tasks, memory.pending.field);
  }
  if (selected && (!plan || plan.lookup || choiceLike)) {
    scope[`selected${selected.type[0].toUpperCase()}${selected.type.slice(1)}`] = selected;
    if (memory.pending) plan = { tasks: memory.pending.tasks.map((item, i) => {
      if (i !== 0) return item;
      let reference = selected.key;
      if (memory.pending.field === 'productRefs') { const refs = item.args.productRefs.split('|'); refs[memory.pending.selectionIndex] = selected.key; reference = refs.join('|'); }
      return { ...item, args: { ...item.args, [memory.pending.field]: reference } };
    }) };
    else plan = selected.type === 'category'
      ? { tasks: [task('get_business_analytics', { mode: 'rank', entityType: 'category', categoryRef: selected.key })] }
      : { tasks: [task(selected.type === 'product' ? 'get_inventory_intelligence' : selected.type === 'customer' ? 'get_customer_intelligence' : 'get_supplier_intelligence', { mode: 'detail', [`${selected.type}Ref`]: selected.key })] };
    scope.pending = null; save();
  } else if (choiceLike) return { answer: 'Elige una entidad de la lista vigente o indica su nombre/código.', clarification: true, intent: 'v3_selection', agent: 'coordinator' };
  if (!plan) return null;
  if (plan.lookup) {
    for (const type of ['product', 'customer', 'supplier']) {
      const resolution = await service.resolveEntity(type, plan.lookup, context);
      if (resolution.entity) { plan = { tasks: [task(type === 'product' ? 'get_inventory_intelligence' : type === 'customer' ? 'get_customer_intelligence' : 'get_supplier_intelligence', { mode: 'detail', [`${type}Ref`]: resolution.entity.key })] }; break; }
      if (resolution.candidates?.length) return candidateView(resolution, [task(type === 'product' ? 'get_inventory_intelligence' : type === 'customer' ? 'get_customer_intelligence' : 'get_supplier_intelligence', { mode: 'detail', [`${type}Ref`]: plan.lookup })], `${type}Ref`);
    }
    if (plan.lookup) return { answer: 'No encontré esa referencia en el escenario de tu negocio.', clarification: true, intent: 'v3_lookup', agent: 'coordinator' };
  }
  if (plan.clarificationQuestion) return { answer: plan.clarificationQuestion, clarification: true, intent: 'v3_clarification', agent: 'coordinator',
    ...(plan.suggestions ? { suggestions: plan.suggestions } : {}) };
  if (plan.tasks.length > 4) return { answer: 'Indica qué dominio deseas priorizar.', clarification: true, intent: 'v3_clarification', agent: 'coordinator' };
  const answers = [], v3Views = []; let previous, rankedForResponse = null;
  for (let i = 0; i < plan.tasks.length; i++) {
    const current = plan.tasks[i];
    if (current.fromPrevious) {
      const row = previous?.data?.items?.[0], key = current.fromPrevious === 'supplier' ? row?.supplierCode : row?.customerCode;
      if (!key) { answers.push('No hay una entidad inequívoca para continuar el segundo análisis.'); break; }
      current.args = { ...current.args, [`${current.fromPrevious}Ref`]: key };
    }
    try {
      const result = await run(current.agent, current.skillId, current.args);
      if (result.metadata.resolution) {
        const resolution = result.metadata.resolution;
        return candidateView(resolution, plan.tasks.slice(i), resolution.referenceField || `${resolution.type}Ref`);
      }
      previous = result; answers.push(renderV3(current.skillId, result, current.args));
      let rankedEntities = [];
      scope.lastFamily = current.skillId;
      for (const [type, entity] of Object.entries(result.metadata.selected || {})) scope[`selected${type[0].toUpperCase()}${type.slice(1)}`] = entity;
      if (scope.readRecommendation && scope.readRecommendation.sku !== scope.selectedProduct?.key) scope.readRecommendation = null;
      if (current.skillId === 'get_inventory_intelligence' && result.metadata.selected?.product && result.data.items?.length === 1) {
        const row = result.data.items[0], quantity = row.recommendation?.recommendedQty;
        scope.readRecommendation = Number.isSafeInteger(quantity) && quantity > 0 ? { sku: row.sku, quantity, supplierCode: row.supplier?.preferredSupplierCode || null } : null;
      }
      if (current.skillId === 'get_business_analytics' && current.args.startDate) scope.selectedPeriod = { startDate: current.args.startDate, endDate: current.args.endDate };
      const type = displayEntityType(current.skillId, current.args);
      const ranked = result.data.items || [];
      if (type && ranked.length && (!result.metadata.selected?.[type] || current.skillId === 'get_cross_sell_recommendations')
        && (current.args.mode === 'rank' || current.skillId === 'get_cross_sell_recommendations')) {
        if (current.skillId !== 'get_cross_sell_recommendations') scope[`selected${type[0].toUpperCase()}${type.slice(1)}`] = null;
        if (type === 'product' && current.skillId !== 'get_cross_sell_recommendations') scope.readRecommendation = null;
        const entities = [];
        for (const row of ranked.slice(0, 5)) {
          const key = row.sku || row.customerCode || row.supplierCode || row.categoryCode || row.subcategoryCode || row.consequentSkus?.[0] || row.recommendedSku;
          if (key) { const resolved = await service.resolveEntity(type, key, context); if (resolved.entity) entities.push(resolved.entity); }
        }
        if (entities.length) { scope.ranking = { type, items: entities }; rankedEntities = entities; rankedForResponse = entities; }
      }
      v3Views.push(await createV3View(current.skillId, result, current.args, service, context, rankedEntities));
      scope.pending = null; save();
    } catch (error) {
      const functional = error.functionalCode;
      const message = ({ UNSUPPORTED_HORIZON: 'Los horizontes aprobados son 1, 7 y 14 días.', INVALID_PERIOD: 'Indica un periodo dentro del histórico disponible y no posterior a la fecha operativa actual.',
        PRODUCT_NOT_FOUND: 'No encontré ese producto en tu negocio.', CUSTOMER_NOT_FOUND: 'No encontré ese cliente en tu negocio.', SUPPLIER_NOT_FOUND: 'No encontré ese proveedor en tu negocio.',
        INSUFFICIENT_HISTORY: 'No hay historia suficiente para ese origen del pronóstico.',
        SNAPSHOT_BOOTSTRAP_REQUIRED: 'La analítica operativa todavía no está habilitada para este negocio; no usaré el corte histórico como reemplazo.',
        SNAPSHOT_CONSISTENCY_UNAVAILABLE: 'No pude obtener una lectura operativa consistente. Inténtalo nuevamente; no mostraré datos históricos como si fueran actuales.',
        SNAPSHOT_TOO_LARGE: 'La lectura operativa excede el tamaño admitido y no se completó.',
        LIVE_SNAPSHOT_UNAVAILABLE: 'No pude preparar la lectura operativa actual. No usaré datos del corte histórico como reemplazo.' })[functional]
        || 'El módulo analítico no está disponible en este momento.';
      answers.push(message);
      if (functional === 'UNSUPPORTED_HORIZON') {
        const product = scope.selectedProduct?.key;
        v3Views.push({ kind: 'forecast', title: 'Horizonte no disponible', subtitle: message, metrics: [], items: [],
          note: 'El escenario tiene pronósticos aprobados para 1, 7 y 14 días.' });
        return { answer: answers.join('\n\n'), intent: 'v3_intelligence', agent: 'analyst', v3Views,
          suggestions: [7, 14].map(days => ({ label: `Consultar ${days} días`, message: product ? `pronóstico de ${product} próximos ${days} días` : `pronóstico próximos ${days} días` })) };
      }
    }
  }
  const suggestions = rankedForResponse?.length ? rankedForResponse.slice(0, 5).map(row => ({ label: row.label, message: row.key,
    ...(row.type === 'product' || row.type === 'customer' || row.type === 'supplier' ? { detail: row.key } : {}) })) : undefined;
  return { answer: answers.join('\n\n'), intent: 'v3_intelligence', agent: plan.tasks.length > 1 ? 'coordinator' : plan.tasks[0].agent,
    ...(v3Views.length ? { v3Views } : {}), ...(suggestions ? { suggestions, suggestionsEntityType: rankedForResponse[0].type } : {}) };

  function candidateView(resolution, tasks, field) {
    const items = resolution.candidates || [], pagination = resolution.pagination;
    if (!items.length) return { answer: 'No encontré esa referencia en tu negocio. Indica su nombre o código completo.', clarification: true, intent: 'v3_selection', agent: 'coordinator' };
    scope.pending = { tasks, field, type: resolution.type, query: resolution.query, selectionIndex: resolution.selectionIndex || 0, offset: pagination?.offset || 0 };
    if (resolution.type === 'supplier') scope.expiresAt = now + require('./memory').SUPPLIER_SELECTION_TTL_MS;
    scope.ranking = { type: resolution.type, items }; save();
    return { answer: `Encontré ${pagination?.totalMatches || items.length} coincidencias. Elige una opción por número, nombre o código:\n${items.map((row, i) => `${i + 1}. ${row.label} (${row.key})`).join('\n')}`,
      intent: 'v3_selection', agent: 'coordinator', clarification: true,
      contextProvenance: { sourceType: 'candidate_snapshot', entityType: resolution.type, query: resolution.query,
        page: Math.floor((pagination?.offset || 0) / 5) + 1, pageSize: 5, totalMatches: pagination?.totalMatches || items.length },
      suggestions: items.map(row => ({ label: row.label, detail: row.key, message: row.key })),
      suggestionsEntityType: resolution.type, suggestionsExpiresAt: scope.expiresAt,
      ...(pagination ? { suggestionsPagination: pagination } : {}) };
  }
};
module.exports = { routeV3, handleV3, compactV3State, renderV3 };
