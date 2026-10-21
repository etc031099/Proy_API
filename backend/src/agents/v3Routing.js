'use strict';

const { V3_SKILLS } = require('./v3Skills');
const { isObjectId, isDate, validateSkillArgs } = require('./contracts');
const { ordinalSelection } = require('./ordinalSelection');
const { normalize } = require('../automations/entityResolution');
const { resolveOperationalPeriod } = require('./intentRouting');
const { addCalendarDays } = require('../utils/operationalClock');
const { contextBinding, TTL_MS } = require('./memory');
const { extractProductReference, isContextualProductReference } = require('../utils/productReference');
const { specialistPlan, agentForTask, requestedIntent } = require('./specialistRouting');
const clean = text => normalize(text).replace(/\bq\b/g, 'que').replace(/\bd\b/g, 'de')
  .replace(/\bprodcutos\b/g, 'productos').replace(/\bstan\b/g, 'estan').replace(/\breposision\b/g, 'reposicion')
  .replace(/\bclietnes\b/g, 'clientes').replace(/\boy\b/g, 'hoy').replace(/\bstok\b/g, 'stock')
  .replace(/\bcuato\b/g, 'cuanto').replace(/\bqeda\b/g, 'queda').replace(/\bay\b/g, 'hay')
  .replace(/\bfrnaces\b/g, 'frances').replace(/\blehes\b/g, 'leches');
const trimRef = text => {
  const ref = String(text || '').replace(/[¿?¡!]/g, '').trim()
    .replace(/\s+(?:para\s+(?:los\s+)?pr[oó]ximos?\s+\d+\s+d[ií]as?|(?:a|en)\s+\d+\s+d[ií]as?|hoy|ayer|anteayer|esta semana|este mes|el mes pasado|los proximos|los próximos|los ultimos|los últimos|en los|durante|para mañana|manana|mañana|por favor|el \d+ de).*$/i, '').trim();
  return /^(?:el|ella|ellos|eso|ayer|hoy|anteayer|manana|\d+ dias?|los? ultimos? \d+ dias?)$/.test(normalize(ref)) ? null : ref;
};
const productRef = (message, memory = {}) => {
  const reference = extractProductReference(message);
  return isContextualProductReference(reference) ? memory.selectedProduct?.key || reference : reference;
};
const task = (skillId, args = {}, extra = {}) => ({ skillId, agent: agentForTask(skillId, args), args: { limit: 5, ...args },
  requestedIntent: skillId === 'get_product_forecast' ? 'forecast' : args.flag === 'should_reorder' ? 'replenishment' : null, ...extra });
const naturalStockReference = message => {
  const normalized = clean(message).replace(/[¿?¡!.]/g, '').trim().replace(/\s+disponibles?$/, '');
  if (/\b(?:y|ademas)\b/.test(normalized) && /\b(?:ventas?|margen|pronostico|prediccion|forecast|proveedor|pedidos? pendientes?)\b/.test(normalized)) return null;
  const patterns = [
    /^(?:cuanto stock (?:queda|hay|tiene) (?:de )?)(.+)$/,
    /^cuanto stock de (.+?)(?: hay)?$/,
    /^cuant[oa]s? (.+?) quedan$/,
    /^me queda[n]? (.+)$/,
    /^dame (?:el )?stock (?:de )?(.+)$/,
    /^stock (?:de )?(.+)$/,
    /^tengo stock (?:de )?(.+)$/,
    /^tengo (.+)$/
  ];
  const matched = patterns.map(pattern => normalized.match(pattern)).find(Boolean);
  if (!matched) return null;
  let reference = matched[1].trim().replace(/^(?:el|la|los|las|del|de)\s+/, '')
    .replace(/\s+(?:disponible|en stock|por favor)$/, '').trim();
  if (!reference || /^(?:stock|inventario|productos?|unidades?)$/.test(reference)) return null;
  const pluralAliases = { panes: 'pan', gaseosas: 'gaseosa', galletas: 'galleta', leches: 'leche' };
  return pluralAliases[reference] || reference;
};
const naturalProductListReference = message => {
  const normalized = clean(message).replace(/[¿?¡!.]/g, '').trim();
  if (/\b(?:pronostico|prediccion|forecast)\b/.test(normalized)) return null;
  const match = normalized.match(/^(?:que|cuales) (?:productos? )?(?:de )?(.+?) (?:tengo|vendo|quedan|hay|me quedan)$/)
    || normalized.match(/^(?:muestrame|muestra|lista|dame) (?:los |las |el |la )?(.+?)(?: tengo| que tengo)?$/);
  if (!match) return null;
  const reference = match[1].trim().replace(/^(?:productos? (?:de )?|de )/, '');
  if (!reference || /\b(?:resumen|negocio|ventas|clientes|proveedores)\b/.test(reference)
    || /^(?:productos?|inventario|stock)$/.test(reference)) return null;
  const aliases = { gaseosa: 'BEB-GAS', gaseosas: 'BEB-GAS', galleta: 'GAL', galletas: 'GAL',
    leche: 'DES-LEC', leches: 'DES-LEC', pan: 'PAN', pane: 'PAN', panes: 'PAN', 'coca cola': 'coca cola', 'coca colas': 'coca cola' };
  const singular = reference.replace(/s$/, '');
  return aliases[singular] || reference;
};
const naturalInventoryFilter = message => {
  const normalized = clean(message).replace(/[¿?¡!.]/g, '').trim();
  if (!/\b(?:por acabarse|acabando|poco stock|bajos? de stock|bajos?\b|stock bajo|deberia reponer|deberian reponer|debo reponer|deberia pedir|deberian pedir)\b/.test(normalized)) return null;
  const prefix = normalized.match(/^(?:cual(?:es)?|que) (.+?) (?:esta|estan|tiene|tienen|deberia|deberian|debo)\b/);
  if (!prefix) return null;
  let reference = prefix[1].replace(/^(?:los |las |el |la )/, '').trim();
  reference = reference.replace(/^productos? (?:de )?/, '').trim();
  const categoryAliases = { gaseosa: 'BEB-GAS', gaseosas: 'BEB-GAS', galleta: 'GAL', galletas: 'GAL',
    leche: 'DES-LEC', leches: 'DES-LEC', pan: 'PAN', panes: 'PAN' };
  const words = reference.split(/\s+/);
  const categoryIndex = words.findIndex(word => categoryAliases[word]);
  let lookup = reference, brandFilter = null;
  if (categoryIndex >= 0) {
    const category = categoryAliases[words[categoryIndex]];
    const brand = words.filter((_, index) => index !== categoryIndex).join(' ').trim();
    lookup = category;
    brandFilter = brand || null;
  }
  if (!lookup || /^(?:productos?|inventario|stock)$/.test(lookup)) return null;
  const condition = /\b(?:deberia reponer|deberian reponer|debo reponer|deberia pedir|deberian pedir)\b/.test(normalized)
    ? 'should_reorder' : 'low_stock';
  return { lookup, brandFilter, condition, responseMode: 'inventory-filter' };
};
const naturalInventoryConditionList = message => {
  const normalized = clean(message).replace(/[¿?¡!.]/g, '').trim();
  if (/\b(?:mas cerca|mas proximo|menor diferencia)\b/.test(normalized)
    && /(?:stock )?minimo/.test(normalized) && /sin haberlo alcanzado|por encima|sobre el minimo|sin alcanzarlo/.test(normalized)) {
    return { responseMode: 'inventory-nearest-minimum', tasks: [0, 20, 40, 60].map(offset => task('get_inventory_intelligence', {
      mode: 'rank', metric: 'low_stock', limit: 20, offset
    })) };
  }
  // Preserve the existing bounded compound planner for sales + replenishment.
  if (/\b(?:ventas?|vendi|vendimos)\b/.test(normalized) && /\b(?:reponer|reposicion)\b/.test(normalized)) return null;
  if (/\bpedidos? pendientes?\b/.test(normalized) && /\by\b/.test(normalized)) return null;
  const specificReference = /\b(?:coca cola|coca-cola|gloria|inca kola|gaseosas?|galletas?|leches?|pan frances|panes?)\b/.test(normalized);
  const listLanguage = /\bproductos?\b/.test(normalized) && /\b(?:que|cuales|lista|muestrame|dime)\b/.test(normalized)
    || /\bcuales\b/.test(normalized) && /\b(?:reponer|pedir|reabastecer|por debajo del? minimo|por debajo de su minimo)\b/.test(normalized)
    || /^stock bajo$/.test(normalized)
    || /\bque se (?:me )?esta acabando\b/.test(normalized);
  if (!listLanguage || specificReference) return null;
  const condition = /\b(?:deberia reponer|deberian reponer|debo reponer|deberia pedir|deberian pedir|deberia reabastecer)\b/.test(normalized)
    ? 'should_reorder'
    : /\b(?:stock bajo|poco stock|por debajo del minimo|por debajo de su minimo|por debajo del? minimo|por acabarse|acabandose|acabando|se (?:me )?esta acabando|bajos? de stock)\b/.test(normalized)
      ? 'low_stock' : null;
  if (!condition) return null;
  return { responseMode: 'inventory-condition-list', tasks: [task('get_inventory_intelligence', {
    mode: 'rank', metric: condition === 'low_stock' ? 'low_stock' : 'reorder', flag: condition, limit: 20
  })] };
};
const operationalDateOf = binding => binding.operationalDate || binding.asOfDate;
const queryPeriod = (message, binding, memory, followup = false) => {
  const operationalDate = operationalDateOf(binding);
  const parsed = resolveOperationalPeriod(message, operationalDate);
  if (parsed.clarificationQuestion) return parsed;
  if (followup && !parsed.explicit && memory.selectedPeriod) parsed.period = memory.selectedPeriod;
  if (parsed.period.endDate > operationalDate || parsed.period.startDate < '2025-10-13') return { clarificationQuestion: 'El periodo debe estar dentro del histórico disponible y no superar la fecha operativa actual.' };
  return { startDate: parsed.period.startDate, endDate: parsed.period.endDate };
};

const machineLearningPlan = (text, message, binding, memory) => {
  const overview = /(?:que|cuales).{0,45}(?:algoritmos?|tecnicas?|partes|componentes).{0,50}(?:machine learning|\bml\b|aprendizaje)|(?:machine learning|\bml\b).{0,35}(?:utiliza|usa|aplica|sistema)|que partes.{0,30}usan? ml|que partes.{0,30}no usan? ml/.test(text);
  const noMl = /(?:que partes|que areas|que modulos).{0,45}no usan? (?:ml|machine learning)|inventario.{0,30}(?:usa|utiliza).{0,20}(?:ml|machine learning)|proveedores?.{0,30}(?:usa|utiliza).{0,20}(?:ml|machine learning)|por que no.{0,35}(?:ml|machine learning).{0,25}proveedor|proveedores?.{0,35}(?:ml|machine learning).{0,25}no/.test(text);
  const inventoryConcept = /cobertura|\bcoverage\b|safety stock|stock minimo|punto de reposicion|cantidad sugerida|recomendacion operativa|reponer|reposicion/.test(text)
    && /que es|que significa|interpreta|modelo|hgb|ma28|machine learning|\bml\b|confirma una compra|como se calcula/.test(text);
  const supplierConcept = /proveedor/.test(text) && /score|k.?means|machine learning|\bml\b|clasific|probabilidad/.test(text)
    || /lead time|puntualidad|dependencia/.test(text) && /que es|que significa/.test(text);
  const health = /salud|diagnostico/.test(text) && /negocio|sistema|general/.test(text);
  const supervisedIntent = /supervisad/.test(text) && !/no supervisad/.test(text);
  const forecastIntent = !(/fp.?growth/.test(text) && /modelo predictivo/.test(text)) && (/histgradient|\bhgb\b|wape|baseline|media movil|\bma28\b|modelo.{0,24}(?:predic|demanda)|(?:modelo|algoritmo).{0,80}evalu[oa].{0,40}(?:predic|demanda)|algoritmo.{0,24}(?:predic|demanda)|tecnica.{0,24}(?:predic|demanda)|caracteristicas.{0,20}modelo/.test(text)
    || /features?|variables?.{0,20}modelo/.test(text) && /hgb|histgradient|pronostic|predic|demanda|forecast/.test(text) || supervisedIntent);
  const boundedForecastIntent = forecastIntent;
  const unsupervisedIntent = /no supervisad/.test(text) && /modelo|algoritmo|tecnica|machine learning|\bml\b|aprendizaje/.test(text);
  const customerIntent = /k.?means|cluster|clustering|agrupamiento|silhouette|\bari\b|\brfm\b|algoritmo.{0,25}(?:cliente|segment)|como estan segmentados.{0,25}clientes|segmentacion.{0,25}clientes|clientes?.{0,20}grupo mas alto/.test(text)
    || memory.lastFamily === 'get_customer_intelligence' && /(?:como|de que manera).{0,20}(?:los |a los )?segmentaste/.test(text) || unsupervisedIntent;
  const anomalyIntent = /isolation forest|anomali|anomaly|atipic|fuera del patron|fraude|contamination|contaminacion|jaccard|detector|score.{0,20}(?:anomali|anomaly|atipic|negativo)|(?:anomali|anomaly|atipic).{0,20}score|confirma incidentes/.test(text) || unsupervisedIntent;
  const basketIntent = /fp.?growth|support|confidence|\blift\b|asociacion|reglas?.{0,20}(?:productos|ticket|support|confidence)|(?:ticket|evidencia).{0,20}regla|patrones frecuentes|productos.{0,25}relacionados|con que productos se compra|productos.{0,25}compran juntos|productos.{0,25}suelen comprar|compra.{0,20}juntos|(?:se compra|se compran|suelen comprarse).{0,25}(?:con|junto)|causalidad/.test(text);
  const frozenIntent = /congelad|frozen|cutoff|corte historico/.test(text)
    && /modelo|algoritmo|tecnica|artifact|historico/.test(text);
  const tasks = [], add = (id, args = {}) => { if (!tasks.some(row => row.skillId === id && row.args.mode === args.mode)) tasks.push(task(id, args)); };
  if (noMl) {
    if (/inventar|coverage|cobertura|stock|reponer|reposicion/.test(text) || /que partes|que areas|que modulos/.test(text))
      add('get_inventory_intelligence', { mode: 'summary', concept: 'inventory_not_ml' });
    if (/proveedor/.test(text) || /que partes|que areas|que modulos/.test(text))
      add('get_supplier_intelligence', { mode: 'summary', concept: 'supplier_not_ml' });
    return { tasks };
  }
  if (inventoryConcept) {
    const concept = /coverage|cobertura/.test(text) ? 'coverage' : /safety stock|stock minimo/.test(text) ? 'safety_stock'
      : /punto de reposicion|reorder point/.test(text) ? 'reorder_point' : 'inventory_not_ml';
    return { tasks: [task('get_inventory_intelligence', { mode: 'summary', concept })] };
  }
  if (supplierConcept) {
    const concept = /score|k.?means|clasific|probabilidad/.test(text) ? 'supplier_score' : /lead time/.test(text) ? 'lead_time'
      : /puntualidad/.test(text) ? 'punctuality' : /dependencia/.test(text) ? 'dependency' : 'supplier_not_ml';
    return { tasks: [task('get_supplier_intelligence', { mode: 'summary', concept })] };
  }
  if (/cual de esos compra mas|quien de esos compra mas/.test(text)) {
    const topCustomer = memory.lastFamily === 'get_customer_intelligence' && memory.ranking?.type === 'customer'
      ? memory.ranking.items?.[0]?.key : null;
    return topCustomer ? { tasks: [task('get_customer_intelligence', { mode: 'detail', customerRef: topCustomer })] }
      : { clarificationQuestion: 'No tengo una lista de clientes vigente para comparar. ¿Quieres ver clientes en riesgo, frecuentes o por gasto?' };
  }
  if (overview) {
    add('get_product_forecast', { mode: 'evaluation', concept: 'algorithm' });
    add('get_customer_intelligence', { mode: 'clustering', concept: 'kmeans' });
    add('get_business_analytics', { mode: 'anomalies', concept: 'isolation_forest' });
    add('get_cross_sell_recommendations', { mode: 'rules', concept: 'fp_growth' });
    if (health) { tasks.pop(); add('get_business_health', {}); }
    return { tasks };
  }
  if (frozenIntent) return { tasks: [task('get_customer_intelligence', { mode: 'clustering', concept: 'kmeans' }),
    task('get_business_analytics', { mode: 'anomalies', concept: 'isolation_forest' }),
    task('get_cross_sell_recommendations', { mode: 'rules', concept: 'fp_growth' })] };
  const domains = [boundedForecastIntent, customerIntent && !/proveedor/.test(text), anomalyIntent, basketIntent].filter(Boolean).length;
  if (domains > 1) {
    if (boundedForecastIntent) add('get_product_forecast', { mode: 'evaluation', concept: /wape/.test(text) ? 'wape' : 'algorithm' });
    if (customerIntent && !/proveedor/.test(text)) add('get_customer_intelligence', { mode: 'clustering', concept: /silhouette/.test(text) ? 'silhouette' : /\bari\b/.test(text) ? 'ari' : unsupervisedIntent ? 'unsupervised' : 'kmeans' });
    if (anomalyIntent) add('get_business_analytics', { mode: 'anomalies', concept: /fraude/.test(text) ? 'fraud' : /accuracy/.test(text) ? 'accuracy' : unsupervisedIntent ? 'unsupervised' : 'anomaly' });
    if (basketIntent) add('get_cross_sell_recommendations', { mode: 'rules', concept: /support/.test(text) ? 'support' : /confidence/.test(text) ? 'confidence' : /lift/.test(text) ? 'lift' : 'fp_growth' });
    return tasks.length <= 4 ? { tasks } : { clarificationQuestion: 'Puedo comparar hasta cuatro dominios por consulta. Indica cuáles deseas priorizar.' };
  }
  if (boundedForecastIntent) {
    const concept = /wape/.test(text) ? 'wape' : /baseline/.test(text) ? 'baseline' : /supervisad/.test(text) ? 'supervised'
      : /caracteristicas|features?|variables del modelo/.test(text) ? 'features' : /por que|media movil|ma28/.test(text) ? 'why_method' : 'algorithm';
    return { tasks: [task('get_product_forecast', { mode: 'evaluation', concept })] };
  }
  if (customerIntent) {
    if (/consumidor final/.test(text)) return { clarificationQuestion: 'Consumidor Final es un agregado anónimo y no tiene una asignación individual de K-Means.' };
    const customerRef = message.match(/\bCLI-\d+\b/i)?.[0]
      || trimRef(message.match(/cliente\s+(.+?)(?:\s+en (?:el )?cluster|[?]|$)/i)?.[1])
      || (/cluster/.test(text) ? memory.selectedCustomer?.key : null);
    const explicitMemberQuery = /quienes?|que clientes|muestrame|lista|en que cluster|cluster tiene/.test(text);
    const clusterId = Number(text.match(/cluster\s+(?:numero\s+)?(\d+)/)?.[1]);
    const clusterFilter = /inactiv/.test(text) ? 'inactivos' : /gasto bajo/.test(text) ? 'gasto bajo'
      : /gasto moderado|moderado/.test(text) ? 'gasto moderado' : /gasto alto|frecuent|grupo mas alto/.test(text) ? 'gasto alto' : undefined;
    return { tasks: [task('get_customer_intelligence', { mode: 'clustering', concept: /silhouette/.test(text) ? 'silhouette' : /\bari\b/.test(text) ? 'ari' : /rfm/.test(text) ? 'rfm' : unsupervisedIntent ? 'unsupervised' : 'kmeans',
      ...(customerRef ? { customerRef } : {}), ...(clusterFilter ? { clusterFilter } : {}),
      ...(clusterId > 0 ? { clusterId } : {}), ...(explicitMemberQuery && !customerRef && !clusterFilter && !(clusterId > 0) ? { clusterFilter: 'no-exact-match' } : {}) })] };
  }
  if (anomalyIntent) {
    if (/manana|proxima semana|proximo mes|futuro/.test(text)) return { clarificationQuestion: `Isolation Forest está congelado al ${binding.historicalCutoff}; no calcula anomalías futuras.` };
    let period = { startDate: binding.earliestDate, endDate: binding.historicalCutoff };
    if (/(?:ayer|hoy|ultimos|ultimas|desde|entre|periodo|dias|semanas|mes|20\d\d-\d\d-\d\d)/.test(text)) {
      const parsed = queryPeriod(message, binding, memory);
      if (parsed.clarificationQuestion) return parsed;
      if (parsed.endDate > binding.historicalCutoff) return { clarificationQuestion: `Isolation Forest está congelado al ${binding.historicalCutoff}; solicita un periodo dentro de ese histórico.` };
      period = parsed;
    }
    const requestedLimit = Number(text.match(/(?:top|ultimos)\s+(\d+)/)?.[1] || 10);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return { clarificationQuestion: 'Indica un número de días atípicos entre 1 y 20.' };
    const limit = Math.min(requestedLimit, 20);
    return { tasks: [task('get_business_analytics', { mode: 'anomalies', concept: /fraude/.test(text) ? 'fraud' : /accuracy/.test(text) ? 'accuracy' : /score/.test(text) ? 'score' : 'anomaly', ...period, limit })] };
  }
  if (basketIntent) {
    const relatedRef = trimRef(message.match(/(?:con que productos se compra|que productos se compran junto con|productos relacionados (?:a|con)|asociaciones para|cross sell de)\s+(.+)$/i)?.[1]);
    const ref = productRef(message, memory) || relatedRef || (/(?:el|eso|su)/.test(text) ? memory.selectedProduct?.key : null);
    const concept = /causal/.test(text) ? 'causality' : /support/.test(text) ? 'support'
      : /confidence/.test(text) ? 'confidence' : /lift/.test(text) ? 'lift' : 'fp_growth';
    return { tasks: [task('get_cross_sell_recommendations', { mode: ref ? 'recommend' : 'rules', concept, ...(ref ? { productRef: ref } : {}) })] };
  }
  return null;
};

const routeV3 = (message, state, binding) => {
  message = require('./languageNlu').highPrecisionMessage(message);
  const { isOutOfDomain, OUT_OF_DOMAIN_ANSWER } = require('./domainGate');
  if (isOutOfDomain(message)) return { clarificationQuestion: OUT_OF_DOMAIN_ANSWER };
  const text = clean(message), memory = state || {};
  if (/\b(?:que|cuanto) comprara\b/.test(text))
    return { clarificationQuestion: 'No hay un modelo que prediga las compras futuras de una persona. Puedo consultar su historial observado o el pronóstico operativo por producto.' };
  if (/probabilidad/.test(text) && /cliente|se vaya|abandon|agotarse|quiebre/.test(text))
    return { clarificationQuestion: 'No hay una probabilidad calculada de abandono o agotamiento. Puedo mostrar recencia, riesgo observado o cobertura, sin convertirlos en probabilidades.' };
  if (/precision|accuracy/.test(text) && /\bsku\b|de (?:este|ese) producto/.test(text))
    return { clarificationQuestion: 'No hay una precisión individual validada para ese SKU. WAPE describe evaluación agregada y no garantiza un pronóstico individual.' };
  if (/^(?:dame|muestra|muestrame) (?:mi |el )?inventario$/.test(text))
    return { tasks: [task('get_inventory_intelligence', { mode: 'summary' })] };
  if (/^saca\s+(?:\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/.test(text))
    return { clarificationQuestion: '¿Quieres registrar una venta para descontar esas unidades o solo corregir el stock? «Saca» puede referirse a movimientos distintos; no prepararé una operación hasta que lo aclares.' };
  if (/^(?:ajusta|ajustar|corrige|corregir)\s+(?:el\s+)?stock\b/.test(text))
    return { clarificationQuestion: 'No tengo una acción de ajuste de stock habilitada en este asistente. Puedo consultar existencias o preparar una venta/compra; indica qué necesitas.' };
  if (/^(?:quien gano el partido de ayer|cual es la capital de japon|escribeme una historia(?: de .+)?|que laptop me recomiendas)$/.test(text.replace(/[¿?¡!.]/g, '').trim())) return null;
  if (/^(?:vende|vender|compra|comprar|prepara(?:r)? (?:una )?compra|crea|crear|avisa|avisame|actualiza|ajusta|confirma|confirmar|confirmo|hazlo|correcto|cancela|cancelar|si hazlo|procede|adelante|no lo hagas|no hagas nada|mejor no)\b/.test(text)
    || /^el segundo$/.test(text)) return null;
  const specialist = specialistPlan(message, memory);
  if (specialist) return specialist;
  const groundedPlan = require('./groundedRouting').buildGroundedPlan(message, binding);
  if (groundedPlan) return groundedPlan;
  const referenceOnly = /^(?:y )?(?:del?|de la|de ese|de este)\b/.test(text) || isContextualProductReference(message);
  if (isContextualProductReference(message) && !memory.selectedProduct)
    return { clarificationQuestion: '¿A qué producto te refieres? Indica su nombre o código.' };
  if (referenceOnly && memory.lastProductTask) {
    const reference = productRef(message, memory) || (isContextualProductReference(message) ? memory.selectedProduct?.key || message : null);
    if (reference) return { tasks: [task(memory.lastProductTask.skillId, { ...memory.lastProductTask.args, productRef: reference },
      { requestedIntent: memory.lastProductTask.requestedIntent })] };
  }
  if (isContextualProductReference(message) && memory.selectedProduct)
    return { tasks: [task('get_inventory_intelligence', { mode: 'detail', productRef: memory.selectedProduct.key })] };
  if (/^(?:y )?(?:cual|cuales)\b/.test(text) && /\b(?:mas|menos) stock\b/.test(text)
    && memory.ranking?.type === 'product' && memory.ranking.items?.length) {
    const productRefs = memory.ranking.items.map(row => row.key).filter(Boolean).slice(0, 20);
    if (productRefs.length) return { responseMode: 'inventory-context-stock-extreme',
      sortDirection: /\bmenos stock\b/.test(text) ? 'asc' : 'desc',
      tasks: [task('get_inventory_intelligence', { mode: 'summary', productRefs: productRefs.join('|'), limit: productRefs.length })] };
  }
  const coverageQuestion = /\b(?:cobertura|coverage)\b/.test(text)
    && !/que es|que significa|interpreta|como se calcula|modelo|hgb|ma28|machine learning|\bml\b/.test(text);
  if (coverageQuestion) {
    const rawRef = productRef(message, memory);
    const ref = message.match(/\b[A-Z]{2,}(?:-[A-Z0-9]+){1,5}\b|\bM5-[A-Z]+_\d+_\d+\b/)?.[0]
      || (rawRef && !/inventario|stock|cobertura|coverage|producto|los dias|dias/i.test(normalize(rawRef)) ? rawRef : null)
      || (memory.selectedProduct?.key && /\b(?:ese|este|su)\b/.test(text) || memory.selectedProduct?.key && /^(?:y )?cuantos? dias de cobertura/.test(text) ? memory.selectedProduct.key : null);
    return ref ? { tasks: [task('get_inventory_intelligence', { mode: 'detail', productRef: ref })] }
      : { clarificationQuestion: '¿De qué producto deseas consultar los días de cobertura?' };
  }
  const machineLearning = machineLearningPlan(text, message, binding, memory);
  if (machineLearning) return machineLearning;
  if (/\bresumen\b/.test(text) && /\bventas?\b/.test(text)) {
    const period = queryPeriod(message, binding, memory);
    return period.clarificationQuestion ? period : { tasks: [task('get_business_analytics', { mode: 'summary', metric: 'revenue', ...period })] };
  }
  // Small bounded cross-domain combinations used during the business presentation.
  if (/\b(?:mejores? clientes?|clientes? de alto valor|clientes? con mayor gasto)\b/.test(text)
    && /\b(?:ventas?|vendi|vendimos)\b/.test(text)) {
    const period = queryPeriod(message, binding, memory);
    if (period.clarificationQuestion) return period;
    return { tasks: [task('get_customer_intelligence', { mode: 'rank', metric: 'spend', limit: 5 }),
      task('get_business_analytics', { mode: 'summary', metric: 'revenue', ...period })] };
  }
  if (/\bventas?\b/.test(text) && /\bmargen\b/.test(text) && /\bstock\b/.test(text)) {
    const ref = productRef(message, memory) || memory.selectedProduct?.key;
    if (!ref) return { clarificationQuestion: '¿De qué producto deseas consultar ventas, margen y stock?' };
    const period = queryPeriod(message, binding, memory);
    if (period.clarificationQuestion) return period;
    return { tasks: [task('get_business_analytics', { mode: 'summary', metric: 'gross_margin', productRef: ref, ...period }),
      task('get_inventory_intelligence', { mode: 'detail', productRef: ref })] };
  }
  if (/\bpedidos? pendientes?\b/.test(text) && /\bproductos?\b/.test(text) && /\b(?:poco stock|stock bajo|por acabarse|reponer)\b/.test(text)) {
    return { tasks: [task('get_inventory_intelligence', { mode: 'rank', metric: 'low_stock', flag: 'low_stock', limit: 20 }),
      task('get_supplier_intelligence', { mode: 'rank', metric: 'orders', limit: 20 }, { pendingOnly: true })] };
  }
  if (/\b(?:pedidos?|ordenes?|órdenes?)\b/.test(text) && /\bpendient/.test(text))
    return { tasks: [task('get_supplier_intelligence', { mode: 'rank', metric: 'orders', limit: 20 }, { pendingOnly: true })] };
  const inventoryConditionList = naturalInventoryConditionList(message);
  if (inventoryConditionList) return inventoryConditionList;
  const inventoryFilter = naturalInventoryFilter(message);
  if (inventoryFilter) return inventoryFilter;
  if (!productRef(message, memory) && /\b(?:stock cero|stock zero|exactamente (?:su )?minimo|igual a (?:su )?minimo|menor stock|menos stock|mayor stock|mas stock)\b/.test(text))
    return { clarificationQuestion: 'El escenario permite consultar riesgo bajo y reposición, pero no tiene un filtro global aprobado para stock cero, igualdad exacta al mínimo ni extremos de unidades en stock. Indica un producto para consultar su valor.' };
  const stockReference = naturalStockReference(message);
  if (stockReference) return { lookup: stockReference, responseMode: 'minimal' };
  const productListReference = naturalProductListReference(message);
  if (productListReference) return { lookup: productListReference, responseMode: 'list' };
  if (/producto.{0,25}mas importante/.test(text) && !/ventas|vendido|revenue|abc|riesgo|critic/.test(text))
    return { clarificationQuestion: '¿A qué te refieres con “más importante”: más vendido, mayor ingreso, clase ABC o mayor riesgo de inventario?' };
  const horizonFollowup = /^[¿¡ ]*(?:y )?(?:para )?(?:los )?(?:proximos? )?\d+ dias?[?!. ]*$/.test(text);
  if (horizonFollowup && memory.lastFamily !== 'get_product_forecast' && !memory.selectedProduct?.key) {
    return { clarificationQuestion: '¿De qué producto deseas consultar el pronóstico? No hay un pronóstico previo en esta conversación.' };
  }
  if (/confianza|confidence|intervalo.*prediccion/.test(text)) return { clarificationQuestion: 'El pronóstico V3 no expone una confianza exacta ni un intervalo de predicción. WAPE no es una probabilidad de acierto individual.' };
  if (/^(?:y )?(?:hoy|ayer|anteayer)$/.test(text) && memory.lastFamily === 'get_business_analytics') {
    const period = queryPeriod(message, binding, memory, true);
    return period.clarificationQuestion ? period : { tasks: [task('get_business_analytics', { mode: 'summary', metric: 'revenue', ...period })] };
  }
  if (memory.lastFamily === 'get_supplier_intelligence' && /^(?:y )?(?:cual|quien).{0,35}(?:mayor|mas|menor).{0,25}(?:tiempo de entrega|lead time|plazo de entrega)/.test(text))
    return { tasks: [task('get_supplier_intelligence', { mode: 'rank', metric: 'lead_time', sortDirection: /menor/.test(text) ? 'asc' : 'desc', limit: 5 })] };
  if (/(?:proveedor.*(?:vende|provee)|quien.*(?:provee|abastece))/.test(text)) {
    const ref = productRef(message, memory) || (/\blo\b/.test(text) ? memory.selectedProduct?.key : null);
    if (ref) return { tasks: [task('get_supplier_intelligence', { mode: 'rank', productRef: ref })] };
    if (/\blo\b/.test(text)) return { clarificationQuestion: '¿De qué producto deseas consultar los proveedores?' };
  }
  if (/^por que/.test(text) && /proveedor/.test(text) && /peor|mejor/.test(text)
    && !/tarda|demora|gasto|lead time|puntual|retras/.test(text))
    return { clarificationQuestion: 'No hay un score global de mejor o peor proveedor. Indica si deseas comparar puntualidad, retrasos, lead time o gasto observado.' };
  if (/^por que/.test(text) && /proveedor/.test(text)) return null;
  if (/alternativas|alternativo/.test(text) && /proveedor/.test(text)) {
    const ref = productRef(message, memory) || trimRef(message.match(/para\s+(.+)$/i)?.[1]) || memory.selectedProduct?.key;
    return ref ? { tasks: [task('get_supplier_intelligence', { mode: 'alternatives', productRef: ref })] }
      : { clarificationQuestion: '¿De qué producto deseas conocer los proveedores alternativos?' };
  }
  if (/cuesta|costo|presupuesto/.test(text) && /reponer|reposicion/.test(text)) return { clarificationQuestion: 'Puedo mostrar la recomendación de reposición al corte V3. El cálculo comercial de costo/presupuesto V3 aún no está habilitado; consulta las ofertas configuradas del producto.' };
  if (/^(?:vende|vender|compra|comprar|prepara(?:r)? (?:una )?compra|crea|crear|avisa|avisame|actualiza|ajusta|confirma|confirmar|cancela|cancelar|si hazlo|procede|adelante|no lo hagas|mejor no)\b/.test(text)) return null;
  if (/^(?:haz|hacer|realiza) (?:el pedido|la compra)$/.test(text)) return { clarificationQuestion: 'Indica la cantidad y el proveedor del pedido. Prepararé el preview para que lo revises y confirmes; la recomendación no ejecuta una compra.' };
  if (/^por que (?:ocurre|pasa) (?:esto|eso)$/.test(text) && memory.lastFamily) return { clarificationQuestion: 'Estos datos muestran hechos y asociaciones observadas; no permiten demostrar su causa. Puedo comparar periodos o ampliar un dominio.' };
  // Only the three approved compound forms; no unbounded general planner.
  if (/ y /.test(text)) {
    if (/inventario/.test(text) && /proveedor/.test(text) && /pedido|orden|pendient/.test(text))
      return { tasks: [task('get_inventory_intelligence', { mode: 'summary' }), task('get_supplier_intelligence', { mode: 'rank', metric: 'orders', limit: 5 })] };
    if (/salud|diagnostico/.test(text) && /negocio|general/.test(text) && /proveedor/.test(text) && /retras|demor|tarda/.test(text))
      return { tasks: [task('get_business_health', {}), task('get_supplier_intelligence', { mode: 'rank', metric: 'delays', sortDirection: 'desc' })] };
    if (/stock/.test(text) && /pronostic|prediccion|forecast|demanda|vendere/.test(text)) {
      const ref = productRef(message, memory) || memory.selectedProduct?.key;
      if (!ref) return { clarificationQuestion: '¿De qué producto deseas consultar el stock y el pronóstico?' };
      const forecastClause = message.split(/\s+y\s+/i).find(part => {
        const clause = clean(part);
        return /pronostic|prediccion|forecast|demanda|vendere/.test(clause) && !/stock/.test(clause);
      });
      const forecastInput = forecastClause && normalize(forecastClause).includes(normalize(ref))
        ? forecastClause : `${forecastClause || ''} de ${ref}`;
      const forecast = forecastClause ? routeV3(forecastInput, memory, binding) : null;
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
    if (/vend[ií]|ventas/.test(text) && (/stock\b/.test(text) || /proveedores?/.test(text) && /pedido|orden|pendient/.test(text))) {
      const parts = message.split(/\s+y\s+/i);
      const first = routeV3(parts[0], memory, binding), second = routeV3(parts.slice(1).join(' y '), memory, binding);
      const secondSkill = second?.tasks?.[0]?.skillId;
      if (first?.tasks?.[0]?.skillId === 'get_business_analytics'
        && second?.tasks?.length === 1 && ['get_inventory_intelligence', 'get_supplier_intelligence'].includes(secondSkill)) {
        return { tasks: [...first.tasks, ...second.tasks] };
      }
    }
    if (/proveedor/.test(text) && /tarda|demora/.test(text) && /critic/.test(text)) return { tasks: [task('get_supplier_intelligence', { mode: 'rank', metric: /tarda/.test(text) ? 'lead_time' : 'delays', sortDirection: 'desc', limit: 1 }),
      task('get_inventory_intelligence', { mode: 'rank', risk: 'CRITICAL' }, { fromPrevious: 'supplier' })] };
    if (/mejor cliente|cliente.*compra mas/.test(text) && /suele comprar|preferencia/.test(text)) return { tasks: [task('get_customer_intelligence', { mode: 'rank', metric: 'spend', limit: 1 }),
      task('get_customer_intelligence', { mode: 'preferences' }, { fromPrevious: 'customer' })] };
  }
  if (/como (?:esta|va) (?:mi|el) negocio|como va el negocio|resumen general|vista general.{0,20}negocio|estado del negocio|diagnostico general|que deberia revisar hoy|salud (?:de|del)|salud general del negocio|principales problemas/.test(text)) {
    const period = queryPeriod(message, binding, memory);
    return period.clarificationQuestion ? period : { tasks: [task('get_business_health', period)] };
  }
  if (/amplia (?:el )?inventario/.test(text)) return { tasks: [task('get_inventory_intelligence', { mode: 'rank', metric: 'stockout_risk' })] };
  if (/amplia (?:los )?clientes/.test(text)) return { tasks: [task('get_customer_intelligence', { mode: 'rank', metric: 'spend' })] };
  const contextualCustomerFollowup = memory.lastFamily === 'get_customer_intelligence'
    && /^(?:y )?(?:su riesgo|cual de esos compra mas|quien de esos compra mas|que compra|cuanto gasto|su detalle|cuando compro|cuando fue su ultima compra)/.test(text);
  const customerLanguage = /clientes?|gast[oó]|gasto|suele comprar|suelen comprar|preferencias|recencia|frecuencia|quien me compra|que compra /.test(text)
    || /\bCLI-\d+\b/i.test(message) || contextualCustomerFollowup;
  if (customerLanguage && !/negocio|categoria|producto.*vendido|proveedor|sup \d+/.test(text)) {
    const ref = message.match(/\bCLI-\d+\b/i)?.[0] || trimRef(message.match(/(?:busca a|cliente|gasto|gastó|comprar|compra)\s+([A-ZÁÉÍÓÚÑ][\p{L}\s]+?)(?:\s+(?:en|este|el mes|los últimos)|[?]|$)/u)?.[1]);
    const general = /clientes|quienes|quien.*compra mas|mejor cliente/.test(text);
    const selected = ref || (!general && memory.lastFamily === 'get_customer_intelligence' && /\bsu\b|que suele|cuanto gasto|que compra|que prefiere|cuando compro/.test(text) ? memory.selectedCustomer?.key : null);
    const mode = /prefer|suele comprar|suelen comprar|que compra/.test(text) ? 'preferences' : selected ? 'detail' : 'rank';
    const args = { mode, metric: /frecuencia|frecuente/.test(text) ? 'tickets' : /recencia/.test(text) ? 'recency' : 'spend', ...(selected ? { customerRef: selected } : {}) };
    if (/riesgo/.test(text)) args.segment = 'AT_RISK';
    if (/alto valor/.test(text)) args.segment = 'TOP_HIGH_VALUE';
    if (/inactiv|dejaron de comprar/.test(text)) args.segment = 'INACTIVE';
    if (/nuevos/.test(text)) args.segment = 'NEW';
    if (/consumidor final/.test(text)) return { clarificationQuestion: 'Consumidor Final es un agregado anónimo; no tiene un perfil RFM individual.' };
    if (mode === 'preferences' && !selected) return { clarificationQuestion: '¿De qué cliente deseas conocer las preferencias?' };
    if (/gasto|gastó|gastaron|gastado/.test(message) || /este mes|ultimos|ayer|hoy/.test(text)) {
      const period = queryPeriod(message, binding, memory); if (period.clarificationQuestion) return period; Object.assign(args, period);
    }
    return { tasks: [task('get_customer_intelligence', args)] };
  }
  if (/proveedor|abastece|lead time|puntualidad|retrasos|dependencia|llego tarde|llegaron tarde|se atraso|\bsup \d+\b/.test(text)
    || /que productos me vende/.test(text) && memory.selectedSupplier) {
    if (/precio|barato|cuesta|cost[oó]/.test(text)) return null; // existing configured-offer skills
    if (/mejor|peor/.test(text) && !/tarda|demora|gasto|compras|lead time|puntual|depend/.test(text)) return { clarificationQuestion: '¿Qué métrica deseas comparar: gasto, órdenes, lead time, puntualidad o dependencia? No hay un score de mejor proveedor.' };
    const ref = message.match(/\bSUP-\d+\b/i)?.[0] || trimRef(message.match(/(?:lead time|puntualidad|retrasos|gasto)\s+(?:de|del)\s+(?:proveedor\s+)?(.+)$/i)?.[1]);
    if (/critic|alto riesgo/.test(text)) return { tasks: [task('get_inventory_intelligence', { mode: 'rank', risk: /critic/.test(text) ? 'CRITICAL' : 'HIGH',
      ...(ref || memory.selectedSupplier ? { supplierRef: ref || memory.selectedSupplier.key } : {}) })] };
    const general = /que proveedor|proveedores|quien.*abastece|de que proveedor/.test(text);
    const selected = ref || (!general && /\bsu\b|ese proveedor|el anterior|me vende|productos|lead time|puntual|llego tarde|se atraso/.test(text) ? memory.selectedSupplier?.key : null);
    if (!selected && /\b(?:ese|este|su) proveedor\b/.test(text))
      return { clarificationQuestion: '¿A qué proveedor te refieres? Indica su nombre o código; un producto no identifica por sí solo un proveedor.' };
    const pendingOnly = /(?:pedido|orden|compra).{0,20}pendient|pendient.{0,20}(?:pedido|orden|compra)/.test(text) && !selected;
    const args = { mode: selected ? 'detail' : 'rank', metric: /tarda|demora|retras|llego tarde|se atraso/.test(text) ? 'delays' : /lead time|tiempo de entrega|plazo de entrega/.test(text) ? 'lead_time' : /puntual/.test(text) ? 'punctuality' : /depend/.test(text) ? 'dependency' : /orden|pedido/.test(text) ? 'orders' : 'spend', ...(selected ? { supplierRef: selected } : {}), ...(pendingOnly ? { limit: 20 } : {}) };
    if (/tarda/.test(text)) args.metric = 'lead_time';
    if (/tarda mas|demora mas|mas retras/.test(text)) args.sortDirection = 'desc';
    if (/menor|menos|rapido/.test(text)) args.sortDirection = 'asc';
    if (/que productos/.test(text) && !selected) return null; // ordinary supplier product resolution
    const parsed = resolveOperationalPeriod(message, operationalDateOf(binding));
    if (parsed.clarificationQuestion) return parsed;
    if (parsed.explicit) Object.assign(args, parsed.period);
    return { tasks: [task('get_supplier_intelligence', args, pendingOnly ? { pendingOnly: true } : {})] };
  }
  if (/junt[oa]s|junto con|junto a|cross sell|canasta|acompan|asociacion|combinacion/.test(text)) {
    const ref = /\bcombinacion\b/.test(text) ? null : productRef(message, memory) || (/\bel\b|\beso\b|\bsu\b/.test(text) ? memory.selectedProduct?.key : null);
    return { tasks: [task('get_cross_sell_recommendations', { mode: ref ? 'recommend' : 'rules', ...(ref ? { productRef: ref } : {}) })] };
  }
  if (horizonFollowup || /pronostic|prediccion|forecast|demanda|cuanto vendere|se vendera|manana|proxima semana/.test(text)) {
    const ref = productRef(message.replace(/\s+(?:(?:para|en|a)\s+)?(?:los\s+)?(?:pr[oó]ximos?\s+)?\d+\s+d[ií]as?[.!?]*$/i, ''), memory) || (horizonFollowup || /\bsu\b|^y |manana/.test(text)
      || memory.selectedProduct?.key && /^(?:pronostico|prediccion|forecast)(?: a | para )/.test(text) ? memory.selectedProduct?.key : null);
    const horizon = Number(text.match(/\b(\d+) dias?\b/)?.[1] || (/manana/.test(text) ? 1 : /14|dos semanas/.test(text) ? 14 : 7));
    if (/como calcul|metodo|metodologia/.test(text)) return { tasks: [task('get_product_forecast', { mode: 'method' })] };
    if (![7, 14].includes(horizon) || /proximo mes|28 dias/.test(text)) return { clarificationQuestion: 'Ridge LIVE tiene modelos aprobados únicamente para 7 y 14 días. El horizonte de 1 día no está aprobado; no se usa un sustituto.',
      suggestions: [7, 14].map(days => ({ label: `Consultar ${days} días`, message: ref ? `pronóstico de ${ref} próximos ${days} días` : `pronóstico próximos ${days} días` })) };
    if (/esta semana/.test(text) && !ref) return { clarificationQuestion: 'Ridge LIVE admite 7 o 14 días. ¿De qué producto deseas consultar el pronóstico?' };
    if (!ref && /ayer/.test(text)) return { clarificationQuestion: '¿De qué producto deseas consultar la predicción de ayer?' };
    const args = { mode: ref ? 'detail' : /mayor|mas|top/.test(text) ? 'rank' : 'summary', horizonDays: horizon, ...(ref ? { productRef: ref } : {}) };
    const compare = /compar/.test(text) && message.match(/(?:demanda|forecast|predicci[oó]n|pron[oó]stico)\s+(?:de\s+)?(.+)\s+y\s+(.+)$/i);
    if (compare) { delete args.productRef; args.mode = 'compare'; args.productRefs = [trimRef(compare[1]), trimRef(compare[2])].join('|'); }
    if (/ayer/.test(text)) args.asOfDate = addCalendarDays(operationalDateOf(binding), -1);
    return { tasks: [task('get_product_forecast', args)] };
  }
  if (!/margen bruto|margen/.test(text) && /stock|inventario|disponible/.test(text)
    && /cuant|cual|queda|qued|tiene|hay|disponible|inventario de|stock de|stock del|\bsu\b|minimo/.test(text)) {
    const canReuseProduct = !memory.lastFamily || ['get_inventory_intelligence', 'get_product_forecast', 'get_business_analytics'].includes(memory.lastFamily);
    const explicitProductFollowup = /ese (?:producto|item|articulo)/.test(text);
    const ref = productRef(message, memory) || ((canReuseProduct || explicitProductFollowup) && memory.selectedProduct?.key && /^(?:[¿¡ ]*y |[¿¡ ]*cuanto|[¿¡ ]*que|[¿¡ ]*cual|[¿¡ ]*esta|[¿¡ ]*hay|[¿¡ ]*queda)/.test(text)
      ? memory.selectedProduct.key : null);
    if (!ref && !/bajo|critico|agot|riesgo|sobre/.test(text)) return { clarificationQuestion: '¿De qué producto deseas consultar el stock disponible?' };
    if (ref) return { tasks: [task('get_inventory_intelligence', { mode: 'detail', productRef: ref })] };
  }
  if (/reponer|reposicion|deberia pedir|debo pedir|cuanto pedir|agot|acabando|critic|alto riesgo|riesgo|sobrestock|sobrad|lento|sin movimiento|\babc\b|\bxyz\b|\baz\b/.test(text)
    || /stock bajo|poco stock|bajos.*stock/.test(text)) {
    const candidateRef = productRef(message, memory);
    const ref = candidateRef && !/^(?:stock bajo|poco stock|bajo stock)$/.test(normalize(candidateRef)) ? candidateRef
      : /cuanto|\bsu\b|\breponerlo\b|\bpedirlo\b/.test(text) ? memory.selectedProduct?.key : null;
    const args = { mode: ref ? 'detail' : 'rank', metric: 'reorder', ...(ref ? { productRef: ref } : {}) };
    if (/critic/.test(text)) args.risk = 'CRITICAL';
    if (/alto riesgo/.test(text)) args.risk = 'HIGH';
    if (/stock bajo|poco stock|bajos.*stock/.test(text)) args.flag = 'low_stock';
    if (/deberia reponer|deberian reponer|debo reponer|deberia pedir|deberian pedir/.test(text)) args.flag = 'should_reorder';
    if (/sobrestock|sobrad/.test(text)) { args.flag = 'overstock'; args.metric = 'overstock'; }
    if (/lento/.test(text)) args.flag = 'slow_moving';
    if (/sin movimiento/.test(text)) args.flag = 'dead_stock';
    if (/\baz\b/.test(text)) { args.abc = 'A'; args.xyz = 'Z'; }
    if (/\babc\b/.test(text) && !args.abc) args.mode = 'summary';
    if (/\bxyz\b/.test(text) && !args.xyz) args.mode = 'summary';
    if (/alguno|sus productos/.test(text) && memory.selectedSupplier) args.supplierRef = memory.selectedSupplier.key;
    if (!ref && /cuanto.*pedir/.test(text)) return { clarificationQuestion: '¿De qué producto deseas consultar la cantidad sugerida?' };
    return { tasks: [task('get_inventory_intelligence', args)] };
  }
  if (memory.selectedProduct?.key && /^(?:y )?(?:cuanto vende|cuanto vendio|que ventas tuvo)/.test(text)) {
    const period = queryPeriod(message, binding, memory, true);
    if (period.clarificationQuestion) return period;
    return { tasks: [task('get_business_analytics', { mode: 'summary', metric: 'revenue', productRef: memory.selectedProduct.key, ...period })] };
  }
  if (/ventas|vendi|vendimos|vendio|mas vendido|venta|margen|ticket|ingreso|por categoria|categoria.{0,20}(?:vende|venta).{0,12}mas/.test(text)) {
    const followup = /^y |por categoria/.test(text);
    const period = queryPeriod(/mas que.*semana pasada/.test(text) ? message.replace(/semana pasada/i, 'esta semana') : message, binding, memory, followup); if (period.clarificationQuestion) return period;
    const args = { mode: /mas vendido|categoria.*(?:margen|vende|venta)|por categoria|ranking|top/.test(text) ? 'rank' : /mas que|compar|semana pasada/.test(text) ? 'compare' : 'summary',
      metric: /margen/.test(text) ? 'gross_margin' : /tickets/.test(text) ? 'tickets' : /unidades|mas vendido/.test(text) ? 'units' : 'revenue', ...period };
    if (args.mode === 'rank') args.entityType = /categoria/.test(text) ? 'category' : 'product';
    const category = trimRef(message.match(/\b(?:de|en)\s+(?:la\s+)?categor[ií]a\s+(.+)$/i)?.[1]), subcategory = trimRef(message.match(/\b(?:de|en)\s+(?:la\s+)?subcategor[ií]a\s+(.+)$/i)?.[1]);
    if (category) args.categoryRef = category;
    if (subcategory) args.subcategoryRef = subcategory;
    let ref = !category && !subcategory && /vendi de|ventas de|ventas tuvo/.test(text) ? productRef(message, memory) : null;
    if (ref && /^(?:los?\s+)?(?:ultimos?\s+\d+\s+dias?|hoy|ayer|anteayer|esta semana|este mes|mes pasado)$/i
      .test(normalize(ref))) ref = null;
    if (ref) args.productRef = ref;
    return { tasks: [task('get_business_analytics', args)] };
  }
  if (/^busca (?:a )?/.test(text) || /^[\p{L}\d .-]{3,100}$/u.test(message.trim())
    && !/^(?:y|si|ok|vale|dale|correcto|de acuerdo|no|precio|stock|minimo|que|cuanto|esta|el|la)\b/.test(text)
    && !/\b(?:ventas?|vendid[oa]s?|tickets?|ingresos?|resumen|negocio|riesgo|clientes?)\b/.test(text)) {
    const sku = message.match(/\b(?:[A-Z]{2,}(?:-[A-Z0-9]+){1,5}|M5-[A-Z]+_\d+_\d+)\b/)?.[0];
    return { lookup: sku || trimRef(message.replace(/^busca(?: a)?\s+/i, '')) };
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
    try { return { skillId: item.skillId, agent: agentForTask(item.skillId, item.args), args: validateSkillArgs(require('./skills').getSkillDefinition(item.skillId).inputSchema, item.args),
      requestedIntent: requestedIntent(item.requestedIntent) || (item.args.flag === 'should_reorder' ? 'replenishment' : item.skillId === 'get_product_forecast' ? 'forecast' : null),
      ...(['customer', 'supplier'].includes(item.fromPrevious) ? { fromPrevious: item.fromPrevious } : {}) }; } catch { return null; }
  }).filter(Boolean);
  let lastProductTask = null;
  if (V3_SKILLS[value.lastProductTask?.skillId] && value.lastProductTask?.args?.productRef) {
    try { lastProductTask = { skillId: value.lastProductTask.skillId, requestedIntent: requestedIntent(value.lastProductTask.requestedIntent),
      args: validateSkillArgs(require('./skills').getSkillDefinition(value.lastProductTask.skillId).inputSchema, value.lastProductTask.args) }; } catch { /* Discard invalid restored references. */ }
  }
  return { binding: value.binding, expiresAt: value.expiresAt,
    selectedProduct: entity(value.selectedProduct), selectedCustomer: entity(value.selectedCustomer), selectedSupplier: entity(value.selectedSupplier),
    readRecommendation: value.readRecommendation && typeof value.readRecommendation.sku === 'string' && value.readRecommendation.sku.length <= 100
      && Number.isSafeInteger(value.readRecommendation.quantity) && value.readRecommendation.quantity > 0 && value.readRecommendation.quantity <= 1000000
      ? { sku: value.readRecommendation.sku, quantity: value.readRecommendation.quantity,
        supplierCode: /^SUP-\d{2}$/.test(value.readRecommendation.supplierCode || '') ? value.readRecommendation.supplierCode : null } : null,
    selectedPeriod: value.selectedPeriod && isDate(value.selectedPeriod.startDate) && isDate(value.selectedPeriod.endDate) ? { startDate: value.selectedPeriod.startDate, endDate: value.selectedPeriod.endDate } : null,
    lastFamily: Object.keys(V3_SKILLS).includes(value.lastFamily) ? value.lastFamily : null,
    lastProductTask,
    ranking: value.ranking && ['product', 'customer', 'supplier', 'category', 'subcategory'].includes(value.ranking.type) ? { type: value.ranking.type,
      items: (value.ranking.items || []).slice(0, 5).map(entity).filter(Boolean) } : null,
    pending: tasks.length && ['productRef', 'productRefs', 'customerRef', 'supplierRef', 'categoryRef', 'subcategoryRef'].includes(value.pending?.field) ? {
      tasks, field: value.pending.field, query: String(value.pending.query || '').slice(0, 100), type: value.pending.type,
      responseMode: value.pending.responseMode === 'minimal' ? 'minimal' : null,
      taskIndex: Number.isInteger(value.pending.taskIndex) && value.pending.taskIndex >= 0 && value.pending.taskIndex < tasks.length ? value.pending.taskIndex : 0,
      selectionIndex: Number.isSafeInteger(value.pending.selectionIndex) && value.pending.selectionIndex >= 0 && value.pending.selectionIndex < 5 ? value.pending.selectionIndex : 0,
      offset: Number.isSafeInteger(value.pending.offset) ? Math.max(0, value.pending.offset) : 0 } : null };
};

const money = cents => Number.isFinite(cents) ? `S/ ${(cents / 100).toFixed(2)}` : 'no disponible';
const num = value => Number.isFinite(value) ? Number(value.toFixed(2)).toString() : 'no disponible';
const units = value => Number.isFinite(value) ? require('../utils/assistantFormatting').units(Number(value.toFixed(2))) : 'unidades no disponibles';
const label = row => row.productName || row.displayName || row.name || row.sku || row.customerCode || row.supplierCode || row.categoryName || row.categoryCode;
const segmentLabel = code => ({ AT_RISK: 'en riesgo según actividad observada', INACTIVE: 'sin compras completadas en los últimos 90 días', NEW: 'nuevo', LOYAL: 'frecuente', TOP_HIGH_VALUE: 'alto valor observado', POTENTIAL: 'potencial' })[code] || 'no disponible';
const reasonLabel = code => ({ LOW_DEMAND: 'ventas observadas bajas', PERISHABLE_CAP: 'cantidad limitada por vida útil', BELOW_REORDER_POINT: 'posición por debajo del punto de reposición', NO_INBOUND: 'sin entradas pendientes', INBOUND_INSUFFICIENT: 'entradas pendientes insuficientes', COVER_BELOW_LEAD_TIME: 'cobertura inferior al plazo observado', LEAD_TIME_EXCEEDS_FORECAST_HORIZON: 'plazo superior al horizonte aprobado', INSUFFICIENT_DEMAND_VARIABILITY_HISTORY: 'historia insuficiente de variabilidad', LOW_STOCK: 'stock bajo', SINGLE_SOURCE: 'un solo proveedor', SLOW_MOVING: 'rotación lenta', DEAD_STOCK: 'sin movimiento observado', OVERSTOCK: 'exceso de stock', STOCKOUT_RISK: 'riesgo de agotamiento' })[code] || 'indicador observado al corte';
const healthInsightLabel = insight => ({
  SALES_DOWN_VS_PREVIOUS_PERIOD: 'Las ventas observadas disminuyeron frente al periodo comparable.',
  MARGIN_DOWN: 'El margen bruto observado disminuyó frente al periodo comparable; no es utilidad neta.',
  CUSTOMER_AT_RISK_COUNT: 'Hay clientes registrados en riesgo según las reglas documentadas; no implica probabilidad de abandono.',
  CRITICAL_STOCK_COUNT: 'El inventario presenta productos con riesgo crítico.',
  OVERSTOCK_VALUE: 'Hay valor estimado en exceso de stock según las reglas de inventario; no es un deterioro contable.',
  HIGH_SUPPLIER_DEPENDENCY: 'Una parte concentrada del gasto de compras recibido corresponde a un proveedor.',
  SINGLE_SOURCE_INVENTORY_EXPOSURE: 'Hay productos de riesgo alto o crítico con una sola oferta de proveedor configurada.',
  CROSS_SELL_OPPORTUNITIES: 'Hay asociaciones estables de productos en el histórico; no implican causalidad.'
})[insight?.code] || 'Hay un indicador que requiere revisión en el panel de salud.';
const displayMoney = cents => Number.isFinite(cents) ? `S/ ${(cents / 100).toFixed(2)}` : 'no disponible';
const displayNumber = value => Number.isFinite(value) ? Number(value.toFixed(2)) : 'no disponible';
const percent = value => Number.isFinite(value) ? `${displayNumber(value * 100)}%` : 'no disponible';
const crossSellCutoff = result => result.metadata.frozenCutoff || result.metadata.asOf || '2026-10-12';
const crossSellExplanation = result => `FP-Growth resume asociaciones observadas; no demuestra causalidad ni garantiza ventas futuras. El artefacto Market Basket es histórico y está congelado al ${crossSellCutoff(result)}.`;
const crossSellBaseLabel = (result, args) => {
  const product = result.metadata.selected?.product || result.data.sourceProduct;
  if (product?.label) return product.key ? `${product.label} (${product.key})` : product.label;
  if (product?.name || product?.productName) return `${product.name || product.productName}${product.sku ? ` (${product.sku})` : ''}`;
  return product?.sku || args.productRef || null;
};
const crossSellMetrics = row => [
  ...(Number.isFinite(row.ticketCount) ? [`${row.ticketCount} tickets observados`] : []),
  ...(Number.isFinite(row.support) ? [`support ${percent(row.support)}`] : []),
  ...(Number.isFinite(row.confidence) ? [`confidence ${percent(row.confidence)}`] : []),
  ...(Number.isFinite(row.lift) ? [`lift ${displayNumber(row.lift)}`] : []),
  ...(typeof row.stability?.status === 'string' ? [`estabilidad ${row.stability.status}`]
    : typeof row.stability === 'string' ? [`estabilidad ${row.stability}`] : [])
].join(' · ');
const mlExplanation = concept => ({
  supervised: 'Ridge Regression es aprendizaje supervisado: usa las 27 variables del contrato CAUSAL27 para estimar demanda acumulada. Ridge LIVE sirve únicamente modelos ACTIVE aprobados para 7 y 14 días.',
  features: 'Las features son variables de entrada que el modelo usa para estimar su objetivo. La lista siguiente procede del contrato de evaluación; no se recalculan ni se interpretan como causas.',
  wape: 'WAPE es el error absoluto total dividido entre la demanda real total. Es una métrica agregada de error; no es una probabilidad de acierto por producto.',
  baseline: 'Un baseline es una referencia simple para comprobar si un modelo aporta mejora. Se compara con el mismo corte de evaluación; un valor menor de WAPE indica menor error agregado.',
  why_method: 'El forecast operativo usa Ridge Regression ACTIVE con CAUSAL27 en 7 y 14 días. La evaluación histórica HGB/MA28 es evidencia separada; no sustituye Ridge LIVE ni aprueba el horizonte de 1 día.',
  kmeans: 'K-Means es aprendizaje no supervisado: agrupa clientes por similitud de Recency, Frequency y Monetary. Es exploratorio y se entrenó con 38 clientes; no asigna probabilidades.',
  silhouette: 'Silhouette resume qué tan cohesionados y separados quedan los grupos: valores mayores suelen indicar mejor separación. Aquí se interpreta junto con estabilidad y utilidad, no como criterio único.',
  ari: 'ARI mide cuánto coinciden agrupaciones entre ejecuciones; 1 representa coincidencia completa. El ARI reportado es estabilidad del clustering, no exactitud contra etiquetas reales.',
  rfm: 'RFM resume recencia, frecuencia y gasto mediante reglas/criterios. K-Means agrupa de forma no supervisada según similitud en esas variables. Ninguno es universalmente mejor.',
  unsupervised: 'El aprendizaje no supervisado busca estructura sin etiquetas objetivo. En este sistema, K-Means agrupa clientes e Isolation Forest señala días de ventas atípicos.',
  isolation_forest: 'Isolation Forest es un modelo no supervisado que identifica observaciones aislables respecto al patrón aprendido. Sus señales requieren revisión contextual.',
  anomaly: 'Una anomalía es una observación estadísticamente alejada del patrón aprendido; no identifica por sí sola la causa ni confirma un incidente.',
  fraud: 'No. Isolation Forest solo señala comportamientos estadísticamente atípicos que requieren revisión contextual. No existen etiquetas de fraude ni incidentes confirmados.',
  score: 'El anomaly score ordena observaciones por atipicidad según el artifact. No es una probabilidad de fraude ni de error.',
  accuracy: 'Accuracy requiere etiquetas reales para comparar predicciones correctas e incorrectas. Este Isolation Forest es no supervisado y el escenario no tiene etiquetas de anomalías verificadas; por eso no se reporta accuracy.',
  contamination: 'Contamination es un parámetro de Isolation Forest relacionado con la proporción esperada de observaciones atípicas; no es una probabilidad individual.',
  fp_growth: 'FP-Growth extrae patrones frecuentes de compras y genera reglas de asociación. El artifact de Market Basket está congelado al 2026-10-12; asociación no implica causalidad.',
  support: 'Support es la proporción de tickets que contienen conjuntamente los productos de una regla; ticketCount muestra evidencia observada en cantidad de tickets.',
  confidence: 'Confidence estima qué proporción de tickets con el antecedente también contiene el consecuente. Es frecuencia condicional observada, no causalidad.',
  lift: 'Lift compara la frecuencia conjunta observada con la esperada si antecedente y consecuente fueran independientes. Mayor que 1 indica asociación positiva, no efecto causal.',
  causality: 'No puede concluirse causalidad: FP-Growth describe compras que aparecen juntas en el histórico congelado al 2026-10-12.',
  inventory_not_ml: 'El inventario combina stock y entradas operacionales con P7/P14 de Ridge ACTIVE cuando están disponibles. Cobertura, safety stock y reposición son reglas existentes; ABC/XYZ es clasificación descriptiva. Una cantidad sugerida no confirma una compra y los datos desconocidos siguen no disponibles.',
  supplier_not_ml: 'Actualmente no se usa Machine Learning para proveedores. Se resumen órdenes, gasto, lead time, puntualidad y dependencia de abastecimiento; no se produce un score o calificación global de proveedor.',
  coverage: 'La cobertura estima cuántos días puede sostenerse el stock disponible según la demanda estimada; es una métrica operativa, no una probabilidad ni un modelo ML.',
  reorder_point: 'El punto de reposición es un umbral operativo para indicar cuándo conviene reponer, considerando demanda y plazo de abastecimiento; alcanzarlo no crea ni confirma una compra.',
  safety_stock: 'El safety stock es una reserva operativa para amortiguar variaciones de demanda y abastecimiento. No es ML por sí mismo ni activa una compra automáticamente.',
  lead_time: 'Lead time es el tiempo observado entre la orden al proveedor y la recepción. Se resume desde compras registradas; no equivale a una predicción de retraso.',
  punctuality: 'La puntualidad resume qué proporción de órdenes recibidas llegó dentro del plazo observado. Es una métrica descriptiva, no una probabilidad futura ni un score global.',
  dependency: 'La dependencia describe concentración de abastecimiento y productos con fuente única; no califica por sí sola la calidad del proveedor.',
  supplier_score: 'No existe un score ML de proveedor. Se usan métricas descriptivas de gasto, órdenes, plazo y puntualidad; no se produce una calificación global.'
})[concept];
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
  if (skillId === 'get_product_forecast' && args.mode === 'evaluation') {
    kind = 'forecast'; title = 'Evaluación de modelos de demanda'; subtitle = `Evidencia histórica al ${d.analysisCutoff || result.metadata.frozenCutoff || result.metadata.asOf}`;
    const selectedMethod = d.selectedOperationalMethod || {};
    metrics.push({ label: 'Método del benchmark histórico', value: selectedMethod.algorithm || selectedMethod.label || 'no disponible' },
      { label: 'Horizontes del benchmark histórico', value: (selectedMethod.horizons || []).map(day => `${day}d`).join(' · ') });
    for (const row of d.modelEvaluation || []) items.push({ type: 'category', key: row.algorithm, label: row.algorithm,
      secondaryLabel: row.dataset?.name || row.modelId,
      metrics: [{ label: 'Estado', value: row.modelStatus === 'REJECTED_FOR_OPERATIONAL_USE' ? 'Evaluado; no aprobado para operación' : row.modelStatus },
        { label: 'TEST WAPE', value: percent(row.metrics?.test?.wape) },
        ...(Number.isFinite(row.baseline?.testMetrics?.wape) ? [{ label: 'Baseline WAPE', value: percent(row.baseline.testMetrics.wape) }] : [])] });
    if (args.concept === 'features') {
      for (const row of d.modelEvaluation || []) items.push({ type: 'category', key: `${row.modelId}-features`, label: `${row.dataset?.name || row.modelId} · features`,
        metrics: (row.features || []).slice(0, 5).map((feature, index) => ({ label: `Variable ${index + 1}`, value: feature })) });
    }
    note = 'Evaluación histórica HGB/MA28; no representa el modelo LIVE. Ridge LIVE usa ACTIVE CAUSAL27 en 7 y 14 días; 1 día no está aprobado.';
  } else if (skillId === 'get_customer_intelligence' && args.mode === 'clustering') {
    kind = 'customer'; title = 'Segmentación exploratoria K-Means'; subtitle = `Corte de entrenamiento ${d.trainingCutoff || result.metadata.asOf}`;
    metrics.push({ label: 'Clientes entrenables', value: d.sampleCount ?? 'no disponible' }, { label: 'Clusters (k)', value: d.k ?? 'no disponible' },
      { label: 'Silhouette', value: displayNumber(d.metrics?.silhouetteMean) }, { label: 'Estabilidad ARI', value: displayNumber(d.metrics?.subsampleAriMean) });
    for (const cluster of d.clusters || []) items.push({ type: 'category', key: `cluster-${cluster.cluster}`, label: cluster.name,
      metrics: [{ label: 'Cluster', value: cluster.cluster }, { label: 'Clientes', value: cluster.size }] });
    for (const row of d.assignments || []) items.push({ type: 'customer', key: row.customerRef, label: row.customerName || row.customerRef,
      secondaryLabel: row.customerRef, metrics: [{ label: 'Asignación', value: row.status === 'INSUFFICIENT_HISTORY' ? 'historia insuficiente' : `Cluster ${row.cluster}: ${row.clusterName || ''}` }] });
    if (d.requestedClusterFound === false) note = 'No existe un cluster con ese nombre o número en el artifact aprobado; no se infirió una asignación.';
    else note = `K-Means no supervisado sobre Recency, Frequency y Monetary; muestra pequeña (n=${d.sampleCount ?? '—'}), exploratoria y entrenada al ${d.trainingCutoff || result.metadata.asOf}.${d.assignmentAsOfDate ? ` La asignación individual usa RFM disponible al ${d.assignmentAsOfDate}.` : ''} No se incluyen probabilidades.`;
  } else if (skillId === 'get_business_analytics' && args.mode === 'anomalies') {
    kind = 'business'; title = 'Días de ventas atípicos'; subtitle = `Isolation Forest · histórico congelado al ${d.analysisCutoff || result.metadata.asOf}`;
    metrics.push({ label: 'Días analizados', value: d.analysisDays ?? 'no disponible' }, { label: 'Señales atípicas en el histórico', value: d.anomalyCount ?? 'no disponible' },
      { label: 'Tasa observada', value: percent(d.anomalyRate) }, { label: 'Estabilidad Jaccard', value: displayNumber(d.stability?.jaccardMean) });
    for (const row of d.topAnomalies || []) items.push({ type: 'category', key: row.date, label: row.date,
      metrics: [{ label: 'Score de atipicidad (no probabilidad)', value: displayNumber(row.anomalyScore) }] });
    note = 'Comportamientos estadísticamente atípicos para revisión contextual; no son fraude, error ni incidentes confirmados.';
  } else if (skillId === 'get_business_analytics') {
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
        { label: 'Stock', value: displayNumber(row.stock?.onHand) },
        ...(Number.isFinite(row.inventoryPolicy?.configuredMinimumStock) ? [{ label: 'Stock mínimo', value: displayNumber(row.inventoryPolicy.configuredMinimumStock) }] : []),
        { label: 'Entradas', value: displayNumber(row.stock?.incoming) },
        { label: 'Posición de inventario', value: displayNumber(row.stock?.inventoryPosition) },
        { label: 'Cobertura', value: Number.isFinite(row.coverage?.daysCover) ? `${displayNumber(row.coverage.daysCover)} días` : 'no disponible' },
        { label: 'Riesgo', value: row.risk?.level || 'no disponible' },
        { label: 'Reponer', value: row.recommendation?.shouldReorder === true ? 'Sí'
          : row.recommendation?.shouldReorder === false ? 'No' : 'no disponible' },
        { label: 'Stock de seguridad', value: displayNumber(row.inventoryPolicy?.safetyStock) },
        { label: 'Punto de reorden', value: displayNumber(row.inventoryPolicy?.reorderPoint) },
        { label: 'Cantidad sugerida', value: displayNumber(row.recommendation?.recommendedQty) },
        { label: 'Motivo', value: (row.risk?.reasonCodes || []).slice(0, 3).map(reasonLabel).join(', ') || 'sin indicador adicional' }
      ]); if (item) items.push(item);
    }
  } else if (skillId === 'get_product_forecast') {
    kind = 'forecast'; title = selected?.label ? `Pronóstico · ${selected.label}` : 'Pronóstico de demanda';
    const horizon = args.horizonDays || d.horizonDays || 7;
    const ridge = d.method === 'RIDGE_REGRESSION';
    subtitle = ridge ? 'Ridge LIVE · autoridad ACTIVE · CAUSAL27 · 7 y 14 días aprobados'
      : `${horizon} ${horizon === 1 ? 'día' : 'días'} desde el corte operativo del escenario.`;
    if (d.totalExpectedUnits !== undefined) metrics.push({ label: `Unidades esperadas · ${horizon} ${horizon === 1 ? 'día' : 'días'}`, value: displayNumber(d.totalExpectedUnits) });
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], item = itemFor(row, i, [
        { label: `Unidades esperadas · ${horizon} días`, value: displayNumber(ridge ? row.predictionUnits : row[`expectedUnitsNext${horizon}d`]) },
        ...(ridge ? [{ label: 'Estado', value: row.status },
          { label: 'Estado del modelo', value: row.activeModelStatus || 'No disponible' },
          { label: 'Motivo', value: row.reasonCode || 'Sin limitación reportada' },
          { label: 'Modelo ACTIVE', value: Number.isSafeInteger(row.modelVersion) ? `v${row.modelVersion}` : 'No disponible' },
          { label: 'Feature version', value: row.featureVersion || 'No disponible' },
          { label: 'Revisión', value: row.dataVersion || result.metadata.dataVersion || 'No disponible' },
          { label: 'Observaciones cerradas hasta', value: row.observationsThrough || result.metadata.observationsClosedThrough || 'No disponible' }] : [])]);
      if (item) items.push(item);
    }
    note = ridge ? '1 día no aprobado. Un dato no disponible no equivale a cero; el pronóstico no garantiza ventas ni implica un entrenamiento nuevo.'
      : 'Evidencia histórica de media móvil de 28 días; no representa Ridge LIVE.';
  } else if (skillId === 'get_cross_sell_recommendations') {
    kind = 'cross_sell'; title = selected?.label ? `Compras observadas junto con ${selected.label}` : 'Productos que suelen aparecer juntos';
    const sourceRows = rows.slice(0, 5);
    for (let i = 0; i < sourceRows.length; i++) {
      const row = sourceRows[i], names = row.consequentProducts || [row.recommendedProduct], keys = row.consequentSkus || [row.recommendedSku || row.sku];
      const detail = [
        ...(Number.isFinite(row.support) ? [{ label: 'Support', value: percent(row.support) }] : []),
        ...(Number.isFinite(row.confidence) ? [{ label: 'Confidence observada', value: percent(row.confidence) }] : []),
        ...(Number.isFinite(row.lift) ? [{ label: 'Lift', value: displayNumber(row.lift) }] : []),
        ...(typeof row.stability?.status === 'string' || typeof row.stability === 'string'
          ? [{ label: 'Estabilidad', value: row.stability?.status || row.stability }] : [])
      ];
      for (let j = 0; j < Math.min((keys || []).length, 5 - items.length); j++) {
        const key = keys[j], name = names?.[j]; if (!key || !name) continue;
        items.push({ type: 'product', key, label: name, secondaryLabel: key,
          metrics: [...(Number.isFinite(row.ticketCount) ? [{ label: 'Tickets observados', value: row.ticketCount }] : []), ...detail], selectMessage: key });
      }
    }
    const baseLabel = crossSellBaseLabel(result, args);
    note = d.available === false
      ? `No se pudieron consultar asociaciones validadas en el artefacto actual de Market Basket.${baseLabel ? ` Producto base: ${baseLabel}.` : ''} ${crossSellExplanation(result)}`
      : !items.length
        ? `No se encontraron asociaciones frecuentes disponibles${baseLabel ? ` para ${baseLabel}` : ''} en el artefacto actual. Esto no significa que el producto nunca se compre junto con otros. ${crossSellExplanation(result)}`
        : crossSellExplanation(result);
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
    if (args.segment === 'TOP_HIGH_VALUE') note = 'Alto valor observado según gasto del RFM de 90 días y actividad reciente. El riesgo de inactividad es una categoría distinta; este ranking no lo usa como criterio.';
    if (d.periodMetrics) metrics.push({ label: 'Gasto del periodo solicitado', value: Object.values(d.periodMetrics).map(row => displayMoney(row.revenueCents)).join(' · ') });
  } else if (skillId === 'get_supplier_intelligence') {
    kind = 'supplier'; title = args.pendingOnly ? 'Proveedores con pedidos pendientes'
      : selected?.label ? `Proveedor · ${selected.label}` : 'Inteligencia de proveedores';
    if (args.pendingOnly) metrics.push({ label: 'Proveedores con pedidos pendientes', value: d.total ?? rows.length });
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], item = itemFor(row, i, [
        { label: 'Compras', value: row.purchaseOrderCount ?? 'no disponible' }, { label: 'Gasto recibido', value: displayMoney(row.receivedSpendCents) },
        { label: 'Pedidos pendientes', value: row.pendingOrderCount ?? 'no disponible' },
        { label: 'Lead time observado', value: Number.isFinite(row.leadTime?.averageDays) ? `${displayNumber(row.leadTime.averageDays)} días` : 'no disponible' },
        { label: 'Puntualidad', value: Number.isFinite(row.punctuality?.onTimeRatePct) ? `${displayNumber(row.punctuality.onTimeRatePct)}%` : 'no disponible' },
        { label: 'Productos', value: (row.productsSupplied || []).slice(0, 3).map(p => p.name || p.productName || p.sku).join(', ') || `${row.exclusiveOfferedSkuCount ?? 0} exclusivos` }
      ]); if (item) items.push(item);
    }
    if (d.singleSourceCriticalOrHigh) metrics.push({ label: 'Productos de alto riesgo con una sola fuente', value: d.singleSourceCriticalOrHigh.singleSourceCriticalOrHighSkuCount });
    note = ['supplier_not_ml', 'supplier_score', 'lead_time', 'punctuality', 'dependency'].includes(args.concept) ? mlExplanation(args.concept) : 'Métricas descriptivas observadas; no constituyen una calificación de proveedor.';
  } else if (skillId === 'get_business_health') {
    kind = 'health'; title = 'Resumen de salud del negocio';
    const h = d.businessHealth || {};
    metrics.push({ label: 'Ventas', value: displayMoney(h.sales?.kpis?.revenueCents) },
      { label: 'Margen bruto', value: Number.isFinite(h.sales?.kpis?.grossMarginPct) ? `${displayNumber(h.sales.kpis.grossMarginPct)}%` : 'no disponible' },
      { label: 'Clientes en riesgo observado', value: h.customers?.atRiskCount ?? 'no disponible' },
      { label: 'Inventario crítico', value: h.inventory?.critical ?? 'no disponible' },
      { label: 'Proveedores', value: h.suppliers?.summary?.suppliers ?? 'no disponible' },
      { label: 'Asociaciones estables', value: h.marketBasket?.stableCrossSellRuleCount ?? 'no disponible' });
    for (const insight of (d.alerts || []).slice(0, 1)) items.push({ type: 'category', key: String(insight.code || items.length),
      label: healthInsightLabel(insight), metrics: [], secondaryLabel: undefined });
    note = `Indicadores descriptivos del corte V3; el resumen no asigna un puntaje global. Market Basket permanece histórico al ${h.marketBasket?.freshness?.analysisCutoff || '2026-10-12'}.`;
  }
  if (args.concept && mlExplanation(args.concept)
    && !(skillId === 'get_cross_sell_recommendations' && ['fp_growth', 'causality'].includes(args.concept))) {
    note = [note, mlExplanation(args.concept)].filter(Boolean).join(' ');
  }
  return { kind, title, ...(subtitle ? { subtitle } : {}), metrics: metrics.slice(0, 8), items: items.slice(0, skillId === 'get_business_health' ? 5 : 5),
    ...(note ? { note } : {}) };
};
const renderV3 = (skillId, result, args, responseMode = null) => {
  const d = result.data, date = result.metadata.asOf;
  const items = d.items || [];
  if (responseMode === 'inventory-condition-list' && skillId === 'get_inventory_intelligence') {
    if (!items.length) return args.flag === 'should_reorder'
      ? 'No encontré productos con recomendación de reposición disponible.'
      : 'No encontré productos con stock en el mínimo configurado o por debajo.';
    const visible = items.slice(0, 5);
    return visible.map(item => `${label(item)}\nStock actual: ${units(item.stock?.onHand)} · Stock mínimo: ${units(item.inventoryPolicy?.configuredMinimumStock)}`
      + (item.sku ? `\nSKU: ${item.sku}` : '')).join('\n\n')
      + (items.length > visible.length ? `\n\nMostrando ${visible.length} de ${d.total || items.length} opciones.` : '');
  }
  if (responseMode === 'inventory-filter' && skillId === 'get_inventory_intelligence') {
    if (result.status === 'PARTIAL' || d.reasonCode === 'LIVE_FORECAST_REQUIRED') return 'No pude verificar qué productos reponer porque falta evidencia de pronóstico para esa recomendación. No inferí una cantidad.';
    if (!items.length) return `No encontré productos que coincidan con esa marca o categoría ${args.flag === 'should_reorder' ? 'recomendados para reposición' : 'bajo la condición de bajo stock'}.`;
    const visible = items.slice(0, 5);
    return visible.map(item => `${label(item)}: ${units(item.stock?.onHand)} disponibles; ${args.flag === 'should_reorder' ? 'reposición recomendada' : 'bajo stock'}.`).join('\n')
      + (items.length > visible.length ? `\nMostrando ${visible.length} de ${d.total || items.length} opciones.` : '');
  }
  if (responseMode === 'minimal' && skillId === 'get_inventory_intelligence' && items.length === 1) {
    return `${label(items[0])}: ${units(items[0].stock?.onHand)} disponibles.`;
  }
  const period = result.metadata.period;
  const heading = skillId === 'get_cross_sell_recommendations'
    ? 'Escenario V3 · Market Basket FROZEN.'
    : `Escenario V3 · ${result.metadata.dataMode === 'LIVE' ? 'datos operativos' : 'histórico'} al ${date}${period ? ` · ${period.startDate === period.endDate ? `el ${period.startDate}` : `${period.startDate} → ${period.endDate}`}` : ''}.`;
  if (skillId === 'get_cross_sell_recommendations') {
    const baseLabel = crossSellBaseLabel(result, args);
    const metricExplanation = ['support', 'confidence', 'lift'].includes(args.concept) ? mlExplanation(args.concept) : null;
    const methodology = [crossSellExplanation(result), metricExplanation].filter(Boolean).join(' ');
    if (d.available === false) {
      return `${heading}\n${baseLabel ? `Producto base: ${baseLabel}.\n` : ''}No se pudieron consultar asociaciones validadas en el artefacto actual de Market Basket.\n${methodology}`;
    }
    if (!items.length) {
      const absence = baseLabel
        ? `No se encontraron asociaciones frecuentes disponibles para ${baseLabel} en el artefacto actual de Market Basket.`
        : 'No se encontraron asociaciones frecuentes disponibles en el artefacto actual de Market Basket.';
      return `${heading}\n${absence} Esto solo indica que no hay una regla disponible bajo los criterios actuales; no significa que el producto nunca se compre junto con otros.\n${methodology}`;
    }
    const visible = items.slice(0, 5);
    const lines = visible.map((row, index) => {
      const names = row.consequentProducts || [row.recommendedProduct], keys = row.consequentSkus || [row.recommendedSku || row.sku];
      const associated = (names || []).slice(0, 5).map((name, i) => {
        const key = keys?.[i]; return name && key ? `${name} (${key})` : name || key;
      }).filter(Boolean).join(', ');
      const metrics = crossSellMetrics(row);
      return `${index + 1}. ${associated}${metrics ? ` · ${metrics}` : ''}.`;
    });
    return `${heading}\n${baseLabel ? `Producto base: ${baseLabel}.\n` : ''}${lines.join('\n')}\n${methodology}`;
  }
  if (skillId === 'get_product_forecast' && args.mode === 'evaluation') {
    const selected = d.selectedOperationalMethod || {}, evaluationRows = d.modelEvaluation || [];
    const lines = [`Método del benchmark histórico: ${selected.algorithm || selected.label || 'no disponible'} (${(selected.horizons || []).join('/')} días).`];
    for (const row of evaluationRows) {
      const baseline = row.baseline?.testMetrics?.wape;
      lines.push(`${row.dataset?.name || row.modelId}: ${row.algorithm} · ${row.modelStatus === 'REJECTED_FOR_OPERATIONAL_USE' ? 'evaluado; no aprobado para operación' : 'evaluado'} · TEST WAPE ${percent(row.metrics?.test?.wape)}${Number.isFinite(baseline) ? ` · baseline ${percent(baseline)}` : ''}.`);
      if (args.concept === 'features') lines.push(`Features ${row.dataset?.name || row.modelId}: ${(row.features || []).join(', ') || 'no disponibles en el contrato'}.`);
    }
    lines.push('HGB/MA28 se conservan como evidencia histórica. Ridge LIVE usa modelos ACTIVE CAUSAL27 en 7 y 14 días; 1 día no está aprobado.');
    const explanation = mlExplanation(args.concept); if (explanation && args.concept !== 'algorithm') lines.push(explanation);
    return `${heading}\n${lines.join('\n')}`;
  }
  if (skillId === 'get_customer_intelligence' && args.mode === 'clustering') {
    const lines = [`K-Means no supervisado · k=${d.k ?? '—'} · n=${d.sampleCount ?? '—'} clientes entrenables · silhouette ${num(d.metrics?.silhouetteMean)} · ARI de estabilidad ${num(d.metrics?.subsampleAriMean)}.`];
    for (const cluster of d.clusters || []) lines.push(`Cluster ${cluster.cluster}: ${cluster.name} · ${cluster.size} clientes.`);
    if (d.requestedClusterFound === false) lines.push('No encontré un cluster con ese nombre o número en el artifact aprobado; no inferí miembros.');
    else if (Array.isArray(d.assignments) && d.assignments.length) {
      lines.push(...d.assignments.map(row => row.status === 'INSUFFICIENT_HISTORY'
        ? `${row.customerName || row.customerRef}: historial insuficiente; no se asignó cluster.`
        : `${row.customerName || row.customerRef} (${row.customerRef}): cluster ${row.cluster} · ${row.clusterName || 'asignación exploratoria'}.`));
      if (d.assignmentAsOfDate) lines.push(`Asignación individual basada en RFM disponible al ${d.assignmentAsOfDate}; el entrenamiento del modelo permanece en ${d.trainingCutoff || date}.`);
    } else if (args.clusterFilter || args.clusterId !== undefined) lines.push('No hay asignaciones disponibles para ese filtro.');
    lines.push(`Modelo exploratorio entrenado al ${d.trainingCutoff || date}; variables RFM: Recency, Frequency, Monetary. No se generan probabilidades.`);
    const explanation = mlExplanation(args.concept); if (explanation && args.concept !== 'kmeans') lines.push(explanation);
    return `${heading}\n${lines.join('\n')}`;
  }
  if (skillId === 'get_business_analytics' && args.mode === 'anomalies') {
    const lines = [`Isolation Forest no supervisado · ${d.analysisDays ?? '—'} días evaluados · ${d.anomalyCount ?? '—'} señales atípicas (${percent(d.anomalyRate)}) · estabilidad Jaccard ${num(d.stability?.jaccardMean)}.`];
    const top = d.topAnomalies || [];
    if (top.length) lines.push(`Días más atípicos del periodo: ${top.map(row => `${row.date} (score ${num(row.anomalyScore)})`).join('; ')}. El score ordena atipicidad, no es probabilidad.`);
    else lines.push('No hay días atípicos en el periodo consultado.');
    lines.push('Son comportamientos estadísticamente atípicos para revisión contextual; no confirman fraude, error ni incidentes. El modelo y su evidencia están congelados al 2026-10-12.');
    const explanation = mlExplanation(args.concept); if (explanation && !['anomaly', 'isolation_forest'].includes(args.concept)) lines.push(explanation);
    return `${heading}\n${lines.join('\n')}`;
  }
  const lines = items.slice(0, 5).map((r, i) => {
    if (skillId === 'get_inventory_intelligence') return `${i + 1}. ${label(r)} (${r.sku}) · stock ${num(r.stock?.onHand)} · entradas pendientes ${num(r.stock?.incoming)} · cobertura ${num(r.coverage?.daysCover)} días · riesgo ${r.risk?.level || 'no disponible'} · cantidad sugerida ${num(r.recommendation?.recommendedQty)} · motivos: ${(r.risk?.reasonCodes || []).map(reasonLabel).join(', ') || 'sin indicador adicional'}.`;
    if (skillId === 'get_product_forecast') return d.method === 'RIDGE_REGRESSION'
      ? `${i + 1}. ${result.metadata.selected?.product?.label || label(r)} (${r.sku}) · Ridge LIVE · autoridad ACTIVE · ${units(r.predictionUnits)} en ${args.horizonDays || 7} días · estado ${r.status} · modelo ${r.modelVersion == null ? 'no disponible' : `v${r.modelVersion}`} (${r.activeModelStatus || 'no disponible'}) · CAUSAL27 ${r.featureVersion || ''} · revisión ${r.dataVersion || result.metadata.dataVersion || 'no disponible'} · observaciones cerradas hasta ${r.observationsThrough || 'no disponible'}${r.reasonCode ? ` · motivo ${r.reasonCode}` : ''}.`
      : `${i + 1}. ${result.metadata.selected?.product?.label || label(r)} (${r.sku}) · evidencia histórica MA28: ${units(r[`expectedUnitsNext${args.horizonDays || 7}d`])} en ${args.horizonDays || 7} días; no es Ridge LIVE.`;
    if (skillId === 'get_customer_intelligence') return `${i + 1}. ${label(r)} · ${segmentLabel(r.segment)} · última compra ${r.lastPurchaseDate || 'sin compras'} · ${num(r.ticketCount)} tickets históricos · gasto histórico ${money(r.totalSpentCents)} · ticket promedio ${money(r.averageTicketCents)}${args.mode === 'preferences' ? ` · categoría preferida: ${r.preferences?.favoriteCategoryName || 'no disponible'} · productos habituales: ${(r.preferences?.topProducts || []).slice(0, 5).map(p => p.name || p.sku).join(', ') || 'sin datos'}` : ''}.`;
    if (skillId === 'get_supplier_intelligence' && args.mode === 'alternatives') return `${i + 1}. ${r.sku} · ${(r.alternatives || []).slice(0, 5).map(offer => `${offer.supplierName || offer.supplierCode}: ${money(offer.unitCostCents)}`).join('; ') || 'sin alternativas configuradas'}.`;
    if (skillId === 'get_supplier_intelligence') return `${i + 1}. ${label(r)} (${r.supplierCode}) · ${num(r.purchaseOrderCount)} compras históricas · ${num(r.pendingOrderCount)} pedidos pendientes · gasto histórico recibido ${money(r.receivedSpendCents)} · lead time observado ${num(r.leadTime?.averageDays)} días con ${num(r.leadTime?.sampleSize)} observaciones · puntualidad ${num(r.punctuality?.onTimeRatePct)}% · catálogo exclusivo: ${num(r.exclusiveOfferedSkuCount)} productos · ${(r.productsSupplied || []).slice(0, 5).map(p => p.name || p.productName || p.sku).join(', ')}.`;
    if (skillId === 'get_cross_sell_recommendations') return `${i + 1}. ${(r.consequentProducts || [r.recommendedProduct]).filter(Boolean).join(', ')} (${(r.consequentSkus || [r.recommendedSku || r.sku]).filter(Boolean).join(', ')})${crossSellMetrics(r) ? ` · ${crossSellMetrics(r)}` : ''}.`;
    return `${i + 1}. ${label(r)} · ${args.metric === 'units' ? units(r.metric ?? r.units ?? r.unitsSold) : args.metric === 'tickets' ? `${num(r.metric ?? r.ticketCount)} tickets` : money(r.metric ?? r[args.metric === 'gross_margin' ? 'grossMarginCents' : 'revenueCents'])}.`;
  });
  if (skillId === 'get_business_analytics' && d.kpis) {
    const k = d.kpis, margin = Number.isFinite(k.grossMarginPct) ? `${num(k.grossMarginPct)}%` : 'no disponible';
    lines.push(`Ventas ${money(k.revenueCents)} · ${units(k.unitsSold)} · ${num(k.ticketCount)} tickets · ticket promedio ${money(k.averageTicket * 100)} · margen bruto ${margin}.`);
    if (args.mode === 'compare') lines.push(Number.isFinite(d.trends?.revenue?.percentChange)
      ? `Variación de ventas: ${num(d.trends.revenue.percentChange)}% frente al periodo comparable anterior; no demuestra causalidad.`
      : 'La variación frente al periodo comparable no está disponible.');
  }
  if (skillId === 'get_inventory_intelligence' && d.summary) lines.push(`${num(d.summary.products)} productos · ${num(d.summary.critical)} críticos · ${num(d.summary.lowStock)} con stock bajo · ${num(d.summary.shouldReorder)} requieren reposición. ABC: ${Object.entries(d.abcCounts || {}).map(([key, count]) => `${key}: ${count}`).join(', ')}. XYZ: ${Object.entries(d.xyzCounts || {}).map(([key, count]) => `${key}: ${count}`).join(', ')}.`);
  if (skillId === 'get_product_forecast' && d.method === 'RIDGE_REGRESSION') lines.push('Ridge Regression ACTIVE · CAUSAL27 · horizontes aprobados 7 y 14 días. 1 día no aprobado. No se usa MA28 como sustituto ni se calcula un forecast diario.');
  if (skillId === 'get_product_forecast' && d.totalExpectedUnits !== undefined) lines.push(`Estimación agregada: ${units(d.totalExpectedUnits)} en ${d.horizonDays} ${d.horizonDays === 1 ? 'día' : 'días'} desde el corte del escenario.`);
  if (skillId === 'get_customer_intelligence' && d.periodMetrics) lines.push(`Gasto del periodo solicitado: ${Object.entries(d.periodMetrics).map(([code, row]) => `${code}: ${money(row.revenueCents)}`).join('; ')}. El segmento RFM corresponde a su ventana de 90 días.`);
  if (skillId === 'get_customer_intelligence' && args.segment === 'TOP_HIGH_VALUE') lines.push('El segmento de alto valor se basa en gasto del RFM de 90 días y actividad reciente; el riesgo de inactividad es una categoría distinta y no es el criterio de este ranking.');
  if (skillId === 'get_supplier_intelligence' && d.singleSourceCriticalOrHigh) lines.push(`Dependencia: ${num(d.singleSourceCriticalOrHigh.singleSourceCriticalOrHighSkuCount)} productos críticos o de alto riesgo con un solo proveedor observado/configurado; no es un score de calidad.`);
  if (skillId === 'get_supplier_intelligence' && args.pendingOnly) lines.unshift(`${d.total ?? items.length} proveedores con pedidos pendientes; se muestran hasta 5. La cifra procede de órdenes pendientes registradas.`);
  if (skillId !== 'get_cross_sell_recommendations' && args.concept && mlExplanation(args.concept)) lines.push(mlExplanation(args.concept));
  if (skillId === 'get_business_health') {
    const h = d.businessHealth;
    if (h) lines.push(`Ventas: ${money(h.sales?.kpis?.revenueCents)}.`, `Margen bruto: ${num(h.sales?.kpis?.grossMarginPct)}%.`,
      `Clientes en riesgo observado: ${num(h.customers?.atRiskCount)}.`, `Inventario: ${num(h.inventory?.critical)} críticos.`,
      `Proveedores: ${num(h.suppliers?.summary?.suppliers)}.`, `Cross-sell: ${num(h.marketBasket?.stableCrossSellRuleCount)} reglas estables.`);
    if (h.marketBasket?.freshness?.analysisCutoff) lines.push(`Market Basket permanece histórico al ${h.marketBasket.freshness.analysisCutoff}.`);
    for (const insight of (d.alerts || []).slice(0, Math.max(0, 7 - lines.length))) lines.push(healthInsightLabel(insight));
  }
  if (!lines.length) lines.push('No hay registros que cumplan los filtros solicitados.');
  const horizon = args.horizonDays || 7;
  const forecastDates = skillId === 'get_product_forecast' && !d.method
    ? ` Horizonte del escenario: ${new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10)} → ${new Date(Date.parse(date) + horizon * 86400000).toISOString().slice(0, 10)}.` : '';
  return `${heading}${forecastDates}\n${lines.join('\n')}`;
};

const handleV3 = async ({ message, state, context, service, run, commit, execution, deterministicProbe, onPublicResult }) => {
  let binding;
  try { binding = await service.resolveContext(context); } catch { return { answer: 'El módulo analítico no está disponible en este momento.', intent: 'v3_unavailable', agent: 'coordinator' }; }
  if (!binding) return null;
  const now = Date.now(), saved = compactV3State(state.v3Context, now);
  const memory = saved?.binding === contextBinding(context) ? saved : {};
  const existingProduct = state.selectedProductReference;
  if ((!state.v3Context || state.v3Context.binding === contextBinding(context)) && existingProduct?.sku
    && Number.isSafeInteger(existingProduct.createdAt) && existingProduct.createdAt > now - TTL_MS
    && existingProduct.sku !== memory.selectedProduct?.key) {
    const resolution = await service.resolveEntity('product', existingProduct.sku, context);
    if (resolution.entity) memory.selectedProduct = resolution.entity;
  }
  if (memory.pending && /^(?:si(?: ese)?|ok|vale|dale|correcto)$/.test(clean(message))) return { answer: 'Elige una entidad por nombre, código o número. Esta selección no confirma una operación.', clarification: true, intent: 'v3_selection', agent: 'coordinator' };
  let plan = require('./compositeRouting').compositePlan(message, memory, binding, routeV3) || routeV3(message, memory, binding);
  if (plan?.outOfDomain) return { answer: require('./domainGate').OUT_OF_DOMAIN_ANSWER, intent: 'out_of_domain', agent: 'coordinator' };
  const language = require('./languageNlu');
  if (/^(?:pan|primor)[?!.]*$/i.test(message.trim()) && !memory.pending && !memory.selectedProduct)
    plan = { clarificationQuestion: '¿Quieres consultar stock, pronóstico, productos relacionados o preparar una venta de ese producto?' };
  if (execution?.hasSemanticProvider() && language.fallbackDecision(message, plan, memory)) {
    const legacy = deterministicProbe?.();
    if (legacy && !['search_product', 'ambiguous_query', 'unsupported'].includes(legacy.intent)) return null;
    plan = await language.semanticPlan({ message, memory, binding, execution });
    memory.pending = null; memory.ranking = null;
    if (saved) commit({ v3Context: { ...memory } });
    if (plan.semanticAction) return { answer: 'La venta necesita selección y preview antes de confirmar.',
      intent: 'semantic_sale_proposal', agent: 'coordinator', clarification: true, semanticAction: plan.semanticAction };
    if (plan.outOfDomain) return { answer: require('./domainGate').OUT_OF_DOMAIN_ANSWER, intent: 'out_of_domain', agent: 'coordinator' };
    if (plan.groundedQuestion) return require('./grounded').handleGrounded({ message: plan.groundedQuestion, context, service, run, execution });
  }
  const publicNote = plan?.publicNote;
  let responseMode = plan?.responseMode || null;
  let productResolution;
  const rawChoice = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const ordinal = ordinalSelection(message), numeric = /^(?:(?:opcion|numero)\s+)?([+\-−]?\d+(?:[.,]\d+)?)[.!?]?$/.exec(rawChoice);
  const choiceLike = ordinal.matched || Boolean(numeric);
  const candidates = memory.ranking?.items || [];
  const match = candidates.find(row => normalize(row.key) === normalize(message) || normalize(row.label) === normalize(message));
  const index = numeric ? /^\d+$/.test(numeric[1]) && Number.isSafeInteger(Number(numeric[1])) ? Number(numeric[1]) - 1 : null
    : ordinal.index === -1 ? candidates.length - 1 : ordinal.index;
  if (choiceLike && index !== null && index >= candidates.length && memory.ranking?.type === 'product')
    return { answer:`La lista tiene ${candidates.length} opciones; esa opción no está en la lista vigente.`,
      clarification:true, intent:'v3_selection', agent:'coordinator' };
  const chooseOther = /^(?:esa no,? la otra|no,? esa,? la otra|no es esa,? la otra)$/.test(clean(message).replace(/[?.!]/g, '').trim());
  let selected = match || (choiceLike && index !== null ? candidates[index] : null);
  if (!selected && chooseOther && memory.ranking?.type === 'product' && memory.selectedProduct) {
    const selectedIndex = candidates.findIndex(row => row.id === memory.selectedProduct.id);
    const alternatives = selectedIndex >= 0 ? candidates.filter((_, candidateIndex) => candidateIndex !== selectedIndex) : [];
    if (alternatives.length === 1) selected = alternatives[0];
  }
  if (!selected && memory.pending && plan?.lookup) {
    const ranked = require('../automations/entityResolution').rankEntities(candidates.map(row => ({ _id: row.id, name: row.label, sku: row.type === 'product' ? row.key : undefined })), message);
    const value = ranked.value || (ranked.confidence === 'HIGH_CONFIDENCE' && ranked.candidates.length === 1 ? ranked.candidates[0] : null);
    if (value) selected = candidates.find(row => row.id === String(value._id) && row.label === value.name);
  }
  const scope = { ...memory, binding: contextBinding(context), expiresAt: now + TTL_MS };
  const resolvedProductRefs = new Set(memory.ranking?.type === 'product' ? memory.ranking.items.map(row => row.key) : []);
  const save = () => commit({ v3Context: scope,
    ...(scope.selectedSupplier ? { lastSupplier: { id: scope.selectedSupplier.id, name: scope.selectedSupplier.label } } : {}),
    ...(scope.selectedProduct ? { lastEntity: { id: scope.selectedProduct.id, sku: scope.selectedProduct.key, name: scope.selectedProduct.label },
      selectedProductReference: { id: scope.selectedProduct.id, sku: scope.selectedProduct.key, name: scope.selectedProduct.label } }
      : Object.hasOwn(scope, 'selectedProduct') ? { lastEntity: null, recentEntities: [], selectedProductReference: null } : {}) });
  if (memory.pending && /^(?:ver mas|siguiente|anterior)$/.test(clean(message))) {
    const offset = Math.max(0, memory.pending.offset + (clean(message) === 'anterior' ? -5 : 5));
    const resolution = await service.resolveEntity(memory.pending.type, memory.pending.query, context, offset);
    resolution.selectionIndex = memory.pending.selectionIndex;
    resolution.taskIndex = memory.pending.taskIndex;
    return candidateView(resolution, memory.pending.tasks, memory.pending.field);
  }
  if (selected && (!plan || plan.lookup || choiceLike || chooseOther || memory.pending && match)) {
    scope[`selected${selected.type[0].toUpperCase()}${selected.type.slice(1)}`] = selected;
    if (memory.pending) plan = { responseMode: memory.pending.responseMode, tasks: memory.pending.tasks.map((item, i) => {
      const target = memory.pending.taskIndex || 0;
      if (i !== target && item.args[memory.pending.field] !== memory.pending.tasks[target].args[memory.pending.field]) return item;
      let reference = selected.key;
      if (memory.pending.field === 'productRefs') { const refs = item.args.productRefs.split('|'); refs[memory.pending.selectionIndex] = selected.key; reference = refs.join('|'); }
      return { ...item, args: { ...item.args, [memory.pending.field]: reference } };
    }) };
    else plan = selected.type === 'category'
      ? { tasks: [task('get_business_analytics', { mode: 'rank', entityType: 'category', categoryRef: selected.key })] }
      : { tasks: [task(selected.type === 'product' ? 'get_inventory_intelligence' : selected.type === 'customer' ? 'get_customer_intelligence' : 'get_supplier_intelligence', { mode: 'detail', [`${selected.type}Ref`]: selected.key })] };
    scope.pending = null; save();
    responseMode = plan.responseMode || responseMode;
    if (selected.type === 'product') productResolution = { status: 'CONTEXT_MATCH', sku: selected.key,
      candidateCount: candidates.length, resumedSkillId: plan.tasks[memory.pending?.taskIndex || 0].skillId };
  } else if (choiceLike && !plan?.clarificationQuestion) return { answer: 'Elige una entidad de la lista vigente o indica su nombre/código.', clarification: true, intent: 'v3_selection', agent: 'coordinator' };
  if (!plan) return null;
  // A new explicit request replaces the visible selection list, while the active
  // product remains available for an unambiguous cross-domain pronoun within TTL.
  if (!choiceLike && !selected && plan.tasks?.length) {
    scope.pending = null; scope.ranking = null; save();
  }
  if (plan.responseMode === 'inventory-filter') {
    const all = [], pageSize = 5, maximumCandidates = 20;
    let totalMatches = 0;
    for (let offset = 0; offset < maximumCandidates; offset += pageSize) {
      const resolution = await service.resolveEntity('product', plan.lookup, context, offset);
      const page = resolution.candidates?.length ? resolution.candidates : resolution.entity ? [resolution.entity] : [];
      totalMatches = resolution.pagination?.totalMatches || page.length;
      all.push(...page);
      if (!page.length || all.length >= totalMatches || all.length >= maximumCandidates) break;
    }
    if (totalMatches > all.length && all.length >= maximumCandidates) return {
      answer: 'Hay demasiadas coincidencias para revisar con seguridad en una sola consulta. Indica una categoría o marca más específica.',
      clarification: true, intent: 'v3_inventory_filter', agent: 'coordinator'
    };
    const normalizedBrand = plan.brandFilter ? normalize(plan.brandFilter) : null;
    const matching = all.filter(row => !normalizedBrand || normalize(row.label || row.name || '').includes(normalizedBrand));
    const skus = [];
    for (const sku of new Set(matching.map(row => row.key || row.sku).filter(Boolean))) {
      if (skus.length >= maximumCandidates || [...skus, sku].join('|').length > 490) break;
      skus.push(sku);
      resolvedProductRefs.add(sku);
    }
    if (!skus.length) return { answer: 'No encontré productos que coincidan con esa marca o categoría.', clarification: false, intent: 'v3_inventory_filter', agent: 'coordinator' };
    plan = { responseMode: 'inventory-filter', tasks: [task('get_inventory_intelligence', {
      mode: 'summary', flag: plan.condition, productRefs: skus.join('|'), limit: maximumCandidates
    })] };
  }
  if (plan.lookup) {
    if (isContextualProductReference(plan.lookup)) {
      if (!scope.selectedProduct) return { answer: '¿A qué producto te refieres? Indica su nombre o código.', clarification: true, intent: 'v3_selection', agent: 'coordinator' };
      plan = { tasks: [task('get_inventory_intelligence', { mode: 'detail', productRef: scope.selectedProduct.key })] };
      productResolution = { status: 'CONTEXT_MATCH', sku: scope.selectedProduct.key };
    }
  }
  if (plan.lookup) {
    const types = ['minimal', 'list'].includes(responseMode) ? ['product'] : ['product', 'customer', 'supplier'];
    for (const type of types) {
      const resolution = await service.resolveEntity(type, plan.lookup, context);
      if (resolution.entity) {
        if (type === 'product') { scope.selectedProduct = resolution.entity; scope.pending = null; scope.ranking = null;
          productResolution = { status: resolution.resolutionStatus || 'SINGLE_MATCH', sku: resolution.entity.key }; }
        plan = { tasks: [task(type === 'product' ? 'get_inventory_intelligence' : type === 'customer' ? 'get_customer_intelligence' : 'get_supplier_intelligence', { mode: 'detail', [`${type}Ref`]: resolution.entity.key })] }; break;
      }
      if (resolution.candidates?.length) return candidateView(resolution, [task(type === 'product' ? 'get_inventory_intelligence' : type === 'customer' ? 'get_customer_intelligence' : 'get_supplier_intelligence', { mode: 'detail', [`${type}Ref`]: plan.lookup })], `${type}Ref`);
    }
    if (plan.lookup) return candidateView({ type: 'product', query: plan.lookup, candidates: [] }, [], 'productRef');
  }
  if (plan.clarificationQuestion) {
    if (plan.specialist) { scope.pending = null; scope.ranking = null; save(); }
    const response = () => ({ answer: plan.clarificationQuestion, clarification: true, intent: 'v3_clarification', agent: plan.specialist || 'coordinator',
      ...(plan.suggestions ? { suggestions: plan.suggestions } : {}) });
    return plan.specialist && execution ? execution.runAgent(plan.specialist, response) : response();
  }
  if (plan.tasks.length > 4) return { answer: 'Indica qué dominio deseas priorizar.', clarification: true, intent: 'v3_clarification', agent: 'coordinator' };
  // Resolve every new product reference before dispatch. Already displayed or
  // resolved identities reuse compact context and are revalidated by the service.
  plan = { ...plan, tasks: plan.tasks.map(row => {
    const intent = requestedIntent(row.requestedIntent) || (row.args.flag === 'should_reorder' ? 'replenishment' : null);
    const args = { ...row.args };
    // A yes/no question about one SKU must retrieve it even when the answer is
    // false or unknown; should_reorder is a list filter, not the user's intent.
    if (row.skillId === 'get_inventory_intelligence' && args.mode === 'detail' && intent === 'replenishment') delete args.flag;
    return { ...row, requestedIntent: intent, agent: agentForTask(row.skillId, args), args };
  }) };
  for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex++) {
    const current = plan.tasks[taskIndex], refs = current.args.productRefs?.split('|')
      || (current.args.productRef ? [current.args.productRef] : []);
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index];
      if (isContextualProductReference(ref)) {
        if (!scope.selectedProduct) return { answer: '¿A qué producto te refieres? Indica su nombre o código.', clarification: true, intent: 'v3_selection', agent: 'coordinator' };
        refs[index] = scope.selectedProduct.key;
        productResolution = { status: 'CONTEXT_MATCH', sku: refs[index] };
      } else if (scope.selectedProduct?.key !== ref && !resolvedProductRefs.has(ref)) {
        const resolution = await service.resolveEntity('product', ref, context);
        if (!resolution.entity) return candidateView({ ...resolution, type: 'product', query: ref, selectionIndex: index, taskIndex },
          plan.tasks, current.args.productRefs ? 'productRefs' : 'productRef');
        refs[index] = resolution.entity.key; scope.selectedProduct = resolution.entity; scope.pending = null;
        resolvedProductRefs.add(refs[index]);
        productResolution = { status: resolution.resolutionStatus || 'SINGLE_MATCH', sku: refs[index] };
      } else if (!productResolution) {
        productResolution = { status: 'CONTEXT_MATCH', sku: ref };
      }
    }
    if (refs.length) current.args[current.args.productRefs ? 'productRefs' : 'productRef'] = current.args.productRefs ? refs.join('|') : refs[0];
  }
  const visibleProductList = ['inventory-condition-list', 'inventory-filter'].includes(responseMode);
  if (visibleProductList) { scope.ranking = null; scope.selectedProduct = null; }
  const answers = publicNote ? [publicNote] : [], v3Views = [], nearestMinimumRows = []; let previous, rankedForResponse = null;
  for (let i = 0; i < plan.tasks.length; i++) {
    const current = plan.tasks[i];
    if (current.fromPrevious) {
      const row = previous?.data?.items?.[0], key = current.fromPrevious === 'supplier' ? row?.supplierCode : row?.customerCode;
      if (!key) { answers.push('No hay una entidad inequívoca para continuar el segundo análisis.'); break; }
      current.args = { ...current.args, [`${current.fromPrevious}Ref`]: key };
    }
    try {
      const resolvedProduct = current.args.productRef;
      execution?.recordLanguageDecision?.({ detectedIntent: current.skillId,
        entitySource: resolvedProduct ? message.includes(resolvedProduct) ? 'explicit'
          : productResolution?.status === 'CONTEXT_MATCH' && !selected ? 'active_context' : 'resolver' : 'none',
        ...(resolvedProduct ? { contextEntityType: 'product', contextEntityId: resolvedProduct } : {}) });
      let result = await run(current.agent, current.skillId, current.args);
      if (result.metadata.resolution) {
        const resolution = result.metadata.resolution;
        return candidateView(resolution, plan.tasks.slice(i), resolution.referenceField || `${resolution.type}Ref`);
      }
      if (current.pendingOnly) {
        const items = (result.data.items || []).filter(row => Number(row.pendingOrderCount) > 0);
        result = { ...result, data: { ...result.data, items, total: items.length } };
      }
      const displayArgs = current.pendingOnly ? { ...current.args, pendingOnly: true } : current.args;
      onPublicResult?.(current.skillId, result, displayArgs, responseMode);
      const conclusion = current.agent === 'inventory'
        ? require('./inventorySpecialist').renderInventoryConclusion(result, current.requestedIntent)
        : current.agent === 'forecast' ? require('./forecastSpecialist').renderForecastConclusion(result, current.requestedIntent, displayArgs) : null;
      previous = result; answers.push([conclusion, renderV3(current.skillId, result, displayArgs, responseMode)].filter(Boolean).join('\n\n'));
      if (responseMode === 'inventory-nearest-minimum' && current.skillId === 'get_inventory_intelligence') {
        nearestMinimumRows.push(...(result.data.items || []));
      }
      let rankedEntities = [];
      scope.lastFamily = current.skillId;
      if (current.args.productRef) scope.lastProductTask = { skillId: current.skillId, args: current.args, requestedIntent: current.requestedIntent };
      if (current.skillId === 'get_supplier_intelligence' && !current.args.productRef && current.args.mode !== 'alternatives') {
        // An explicit supplier comparison supersedes a product from an older domain.
        scope.selectedProduct = null;
        scope.readRecommendation = null;
      }
      for (const [type, entity] of Object.entries(result.metadata.selected || {})) scope[`selected${type[0].toUpperCase()}${type.slice(1)}`] = entity;
      if (current.args.productRef && result.metadata.selected?.product && !productResolution)
        productResolution = { status: 'EXACT', sku: result.metadata.selected.product.key };
      if (scope.readRecommendation && scope.readRecommendation.sku !== scope.selectedProduct?.key) scope.readRecommendation = null;
      if (current.skillId === 'get_inventory_intelligence' && result.metadata.selected?.product && result.data.items?.length === 1) {
        const row = result.data.items[0], quantity = row.recommendation?.recommendedQty;
        scope.readRecommendation = Number.isSafeInteger(quantity) && quantity > 0 ? { sku: row.sku, quantity, supplierCode: row.supplier?.preferredSupplierCode || null } : null;
      }
      if (current.skillId === 'get_business_analytics' && current.args.startDate) scope.selectedPeriod = { startDate: current.args.startDate, endDate: current.args.endDate };
      const type = displayEntityType(current.skillId, current.args);
      const ranked = result.data.items || [];
      if (type && ranked.length && !['inventory-condition-list', 'inventory-nearest-minimum'].includes(responseMode)
        && (!result.metadata.selected?.[type] || current.skillId === 'get_cross_sell_recommendations')
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
      const view = await createV3View(current.skillId, result, displayArgs, service, context, rankedEntities);
      if (responseMode === 'minimal' && current.skillId === 'get_inventory_intelligence' && view.items?.length === 1) {
        view.metrics = view.items[0].metrics.filter(metric => metric.label === 'Stock');
        view.items[0].metrics = view.items[0].metrics.filter(metric => metric.label === 'Stock');
        view.note = undefined;
      }
      if (responseMode === 'inventory-filter' && current.skillId === 'get_inventory_intelligence') {
        view.metrics = [];
        view.items = view.items.map(item => ({ ...item, metrics: item.metrics.filter(metric => ['Stock', 'Riesgo'].includes(metric.label)) }));
        view.note = undefined;
      }
      if (['inventory-condition-list', 'inventory-nearest-minimum'].includes(responseMode)
        && current.skillId === 'get_inventory_intelligence') {
        view.metrics = [];
        view.items = view.items.map(item => ({ ...item, metrics: [
          { label: 'Stock actual', value: displayNumber(result.data.items?.find(row => row.sku === item.key)?.stock?.onHand) },
          { label: 'Stock mínimo', value: displayNumber(result.data.items?.find(row => row.sku === item.key)?.inventoryPolicy?.configuredMinimumStock) }
        ] }));
        view.note = undefined;
      }
      if (visibleProductList && current.skillId === 'get_inventory_intelligence') {
        const visibleRows = (result.data.items || []).slice(0, 5);
        if (visibleRows.length && visibleRows.every(row => typeof row.sku === 'string' && row.sku)) {
          const resolved = await Promise.all(visibleRows.map(row => service.resolveEntity('product', row.sku, context)));
          const entities = resolved.map(row => row.entity);
          scope.ranking = entities.length === visibleRows.length && entities.every(row => row?.type === 'product'
            && isObjectId(row.id) && typeof row.key === 'string' && typeof row.label === 'string')
            ? { type:'product', items:entities } : null;
        }
      }
      v3Views.push(view);
      scope.pending = null; save();
    } catch (error) {
      const functional = error.functionalCode;
      const message = ({ UNSUPPORTED_HORIZON: 'Ridge LIVE solo tiene horizontes aprobados de 7 y 14 días; 1 día no está aprobado.',
        FORECAST_PRODUCT_REQUIRED: 'Selecciona un producto para consultar su Ridge LIVE a 7 o 14 días. No se sustituirá por un ranking MA28.',
        INVALID_PERIOD: 'Indica un periodo dentro del histórico disponible y no posterior a la fecha operativa actual.',
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
          note: 'Ridge LIVE está aprobado únicamente para 7 y 14 días.' });
        return { answer: answers.join('\n\n'), intent: 'v3_intelligence', agent: 'analyst', v3Views,
          suggestions: [7, 14].map(days => ({ label: `Consultar ${days} días`, message: product ? `pronóstico de ${product} próximos ${days} días` : `pronóstico próximos ${days} días` })) };
      }
    }
  }
  if (responseMode === 'inventory-context-stock-extreme') {
    const rows = (previous?.data?.items || []).filter(row => Number.isFinite(row.stock?.onHand));
    const direction = plan.sortDirection === 'desc' ? -1 : 1;
    rows.sort((left, right) => direction * (left.stock.onHand - right.stock.onHand)
      || String(left.sku).localeCompare(String(right.sku)));
    const selected = rows[0];
    answers.splice(0, answers.length, selected
      ? `${plan.sortDirection === 'desc' ? 'El producto con más' : 'El producto con menos'} stock de la lista es ${selected.productName || selected.name}: ${units(selected.stock.onHand)} unidades.`
      : 'No hay datos de stock suficientes en la lista anterior para compararlos.');
    v3Views.splice(0, v3Views.length, selected ? { kind: 'inventory', title: 'Comparación de stock', metrics: [], items: [{
      type: 'product', key: selected.sku, secondaryLabel: selected.sku, label: selected.productName || selected.name,
      metrics: [{ label: 'Stock actual', value: displayNumber(selected.stock.onHand) }]
    }] } : { kind: 'inventory', title: 'Comparación de stock', metrics: [], items: [] });
  }
  if (responseMode === 'inventory-nearest-minimum') {
    const eligible = nearestMinimumRows.filter(row => Number.isFinite(row.stock?.onHand)
      && Number.isFinite(row.inventoryPolicy?.configuredMinimumStock)
      && row.stock.onHand > row.inventoryPolicy.configuredMinimumStock)
      .sort((left, right) => (left.stock.onHand - left.inventoryPolicy.configuredMinimumStock)
        - (right.stock.onHand - right.inventoryPolicy.configuredMinimumStock) || String(left.sku).localeCompare(String(right.sku)));
    const nearest = eligible[0];
    answers.splice(0, answers.length, nearest
      ? `${nearest.productName || nearest.name}: stock actual ${units(nearest.stock.onHand)}; stock mínimo ${units(nearest.inventoryPolicy.configuredMinimumStock)}.`
      : 'No encontré un producto por encima de su mínimo de stock en los datos consultados.');
    v3Views.splice(0, v3Views.length, nearest ? { kind: 'inventory', title: 'Producto más cercano al mínimo', metrics: [], items: [{
      type: 'product', key: nearest.sku, secondaryLabel: nearest.sku, label: nearest.productName || nearest.name,
      metrics: [{ label: 'Stock actual', value: displayNumber(nearest.stock.onHand) },
        { label: 'Stock mínimo', value: displayNumber(nearest.inventoryPolicy.configuredMinimumStock) }]
    }] } : { kind: 'inventory', title: 'Producto más cercano al mínimo', metrics: [], items: [] });
  }
  const suggestions = rankedForResponse?.length ? rankedForResponse.slice(0, 5).map(row => ({ label: row.label, message: row.key,
    ...(row.type === 'product' || row.type === 'customer' || row.type === 'supplier' ? { detail: row.key } : {}) })) : undefined;
  return { answer: answers.join('\n\n'), intent: 'v3_intelligence', agent: plan.tasks.length > 1 ? 'coordinator' : plan.tasks[0].agent,
    ...(productResolution ? { productResolution } : {}),
    ...(v3Views.length ? { v3Views } : {}), ...(suggestions ? { suggestions, suggestionsEntityType: rankedForResponse[0].type } : {}) };

  function candidateView(resolution, tasks, field) {
    const items = resolution.candidates || [], pagination = resolution.pagination;
    if (resolution.type === 'product') { scope.selectedProduct = null; scope.readRecommendation = null; }
    if (!items.length) {
      scope.pending = null; scope.ranking = null; save();
      return { answer: resolution.type === 'product'
        ? `No encontré productos similares a «${String(resolution.query || '').slice(0, 100)}». Prueba con parte del nombre o el código.`
        : 'No encontré esa referencia en tu negocio. Indica su nombre o código completo.',
        clarification: true, intent: 'v3_selection', agent: 'coordinator',
        ...(resolution.type === 'product' ? { productResolution: { status: 'NO_MATCH', candidateCount: 0 } } : {}) };
    }
    scope.pending = { tasks, field, type: resolution.type, query: resolution.query, responseMode, taskIndex: resolution.taskIndex || 0,
      selectionIndex: resolution.selectionIndex || 0, offset: pagination?.offset || 0 };
    if (resolution.type === 'supplier') scope.expiresAt = now + require('./memory').SUPPLIER_SELECTION_TTL_MS;
    scope.ranking = { type: resolution.type, items }; save();
    return { answer: `${publicNote ? `${publicNote}\n` : ''}Encontré ${pagination?.totalMatches || items.length} coincidencias. Elige una opción por número, nombre o código:\n${items.map((row, i) => `${i + 1}. ${row.label} (${row.key})`).join('\n')}`,
      intent: 'v3_selection', agent: 'coordinator', clarification: true,
      ...(resolution.type === 'product' ? { productResolution: { status: items.length > 1 ? 'MULTIPLE_MATCHES' : 'SINGLE_MATCH', candidateCount: pagination?.totalMatches || items.length } } : {}),
      contextProvenance: { sourceType: 'candidate_snapshot', entityType: resolution.type, query: resolution.query,
        page: Math.floor((pagination?.offset || 0) / 5) + 1, pageSize: 5, totalMatches: pagination?.totalMatches || items.length },
      suggestions: items.map(row => ({ label: row.label, detail: row.key, message: row.key })),
      suggestionsEntityType: resolution.type, suggestionsExpiresAt: scope.expiresAt,
      ...(pagination ? { suggestionsPagination: pagination } : {}) };
  }
};
module.exports = { routeV3, handleV3, compactV3State, renderV3 };
