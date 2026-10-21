'use strict';

const { V3_SKILLS } = require('./v3Skills');
const { extractProductReference, isContextualProductReference } = require('../utils/productReference');
const REQUESTED_INTENTS = Object.freeze(['replenishment', 'stock', 'coverage', 'risk', 'forecast', 'model_status', 'method']);
const requestedIntent = value => REQUESTED_INTENTS.includes(value) ? value : null;
const agentForTask = (skillId, args = {}) => skillId === 'get_inventory_intelligence' ? 'inventory'
  : skillId === 'get_product_forecast' && args.mode !== 'evaluation' && !args.asOfDate ? 'forecast'
    : V3_SKILLS[skillId]?.agents[0];

// Only this grammar shares one explicit product across replenishment and forecast.
const sharedProductPlan = message => {
  const shared = message.match(/^\s*[¿]?para\s+([^,\n]+),\s*expl[ií]came\s+si\s+debo\s+reponer(?:la|lo)?[\s,]+(?:y(?:\s+tambi[eé]n)?|adem[aá]s|junto con|a la vez|por otro lado)\s+cu[aá]nto\s+se\s+espera\s+vender\s+en\s+(7|14)\s+d[ií]as[?.!]*\s*$/i);
  if (!shared || /\s+(?:y|junto con|adem[aá]s)\s+|[;?]/i.test(shared[1])) return null;
  return { tasks: [
    { skillId: 'get_inventory_intelligence', agent: 'inventory', requestedIntent: 'replenishment',
      args: { limit: 5, mode: 'detail', productRef: shared[1].trim(), metric: 'reorder' } },
    { skillId: 'get_product_forecast', agent: 'forecast', requestedIntent: 'forecast',
      args: { limit: 5, mode: 'detail', productRef: shared[1].trim(), horizonDays: Number(shared[2]) } }
  ] };
};

// A bounded deterministic route. Historical and broader composite analyses retain
// their existing path. No raw user question is persisted for continuation.
const specialistPlan = (message, memory = {}) => {
  const text = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[¿?¡!]/g, '').trim();
  // A shared, explicit product anchors both clauses; never borrow another turn's SKU.
  // Keep this bounded to read-only replenishment + an approved LIVE horizon.
  const shared = sharedProductPlan(message);
  if (shared) return shared;
  // A conjunction between model attributes is not a second business request.
  const intentText = text.replace(/\bmodelo\s+y\s+version\b/g, 'modelo version');
  if (/histor|evaluacion|wape|baseline|ma28|hgb|ayer|fp.?growth|k.?means|isolation|features?\b|variables|supervisad|algoritmo|machine learning|compar|\d{4}-\d{2}-\d{2}|\s+y\s+/.test(intentText)) return null;
  if (/^(?:crea|crear|compra|comprar|vende|vender|ajusta|ajustar|actualiza|prepara)\b/.test(text)) return null;
  const forecast = /pronostic|prediccion|forecast|cuanto venderemos|cuanto vendere|se vendera/.test(text);
  const forecastContext = memory.lastFamily === 'get_product_forecast';
  const model = /\b(?:modelo|version|feature.?version|revision)\b|observaciones.*cerrad|cerrad.*observaciones/.test(text)
    && (forecast || forecastContext || /feature.?version|observaciones.*cerrad|cerrad.*observaciones/.test(text)
      || /(?:que|cual).*modelo.*\b(?:usa|utiliza|activo)\b|(?:estado|version).*modelo/.test(text));
  const method = /como calcul|metodo|metodologia/.test(text);
  const replenishment = /(?:debo|deberia|por que|cuanto).*reponer|(?:debo|deberia).*pedir/.test(text);
  const coverage = /cobertura/.test(text);
  const stock = /stock|existencias|entradas pendientes|posicion de inventario/.test(text);
  const risk = /riesgo (?:alto|critico)|(?:alto|critico) riesgo/.test(text);
  if (!forecast && !model && !replenishment && !coverage && !stock && !risk) return null;
  let ref = extractProductReference(message);
  // In model questions the first "del" can refer to the forecast, not the product.
  const forecastRef = message.match(/\b(?:pron[oó]stico|forecast|predicci[oó]n)\s+(?:del?|para)\s+(.+)/i)?.[1];
  if (model && forecastRef) ref = extractProductReference(`pronóstico de ${forecastRef}`);
  if (coverage && /^(?:cobertura|coverage)(?: tiene)?$/i.test(ref || '')) ref = null;
  if (model && !ref) ref = message.match(/\bpara\s+(.+?)[?.!]*$/i)?.[1];
  if (model && !ref) ref = memory.selectedProduct?.key;
  if (isContextualProductReference(ref) || !ref && /\bsu\b|ese producto|este producto|^y |cuantos? dias de cobertura/.test(text)) ref = memory.selectedProduct?.key;
  const make = (skillId, args, intent) => ({ tasks: [{ skillId, agent: agentForTask(skillId, args),
    args: { limit: 5, ...args }, requestedIntent: intent }] });
  if (forecast || model) {
    const horizonDays = Number(text.match(/\b(\d+) dias?\b/)?.[1] || (/manana/.test(text) ? 1 : /dos semanas/.test(text) ? 14
      : model && memory.lastProductTask?.skillId === 'get_product_forecast' ? memory.lastProductTask.args.horizonDays || 7 : 7));
    if (![7, 14].includes(horizonDays)) return { specialist: 'forecast', clarificationQuestion:
      'Ridge LIVE tiene modelos aprobados únicamente para 7 y 14 días. El horizonte de 1 día no está aprobado; no se usa un sustituto.',
      suggestions: [7, 14].map(days => ({ label: `Consultar ${days} días`, message: ref ? `pronóstico de ${ref} próximos ${days} días` : `pronóstico próximos ${days} días` })) };
    if (method) return make('get_product_forecast', { mode: 'method' }, 'method');
    if (model && !ref) return make('get_product_forecast', { mode: 'method' }, 'method');
    if (!ref) return null;
    return make('get_product_forecast', { mode: 'detail', productRef: ref, horizonDays }, model ? 'model_status' : 'forecast');
  }
  if (risk && !ref) return make('get_inventory_intelligence', { mode: 'rank', risk: /critico/.test(text) ? 'CRITICAL' : 'HIGH' }, 'risk');
  if (!ref) return null;
  return make('get_inventory_intelligence', { mode: 'detail', productRef: ref,
    ...(replenishment ? { metric: 'reorder' } : {}) }, replenishment ? 'replenishment' : coverage ? 'coverage' : 'stock');
};

module.exports = { specialistPlan, sharedProductPlan, agentForTask, requestedIntent };
