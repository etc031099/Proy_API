'use strict';
const { normalize, isOutOfDomain } = require('./domainGate');
// Split only independent request starts. Product conjunctions (pan y leche),
// comparisons, and "y por qué" remain owned by their existing domain router.
const splitRequests = message => String(message).split(/(?:\s+y\s+|[?.!]\s+adem[aá]s,?\s*)(?=[¿]?(?:(?:luego|despues|después|ademas|además)\s+)?(?:en\s+(?:q|qu[eé])\s+cantidad\b|q\b|qu[eé](?=\s|$)|cual(?:es)?\b|quien(?:es)?\b|cu[aá]nt[oa]s?\b|stock\b|inventario\b|ventas\b|clientes\b|proveedores\b|productos\b|salud\b|margen\b|pron[oó]stico\b|forecast\b|dime\b|dame\b|cu[eé]ntame\b|recomi[eé]ndame\b|explicame\b|precio\b|capital\b|de esos\b|predice\b))/i)
  .map(part => part.trim().replace(/^(?:primero|luego|despu[eé]s|adem[aá]s)\s+(?=dime|dame|stock|ventas)/i, ''));
const writeClause = message => {
  const source = normalize(message);
  const forecast = /^pronostico\b/.test(require('./languageNlu').highPrecisionMessage(message, { allowImplicitReference: true }));
  // The infinitive in a parsed forecast ("se espera vender") is not a sale
  // command. Every other mutation/confirmation signal still blocks composition.
  return /\b(?:vende|vender|venta de|compra \d|comprar \d|confirma\w*|hazlo|borra|elimina|ajusta|crea|crear)\b/.test(
    forecast ? source.replace(/\bvender\b/g, '') : source);
};
const clarify = () => ({ clarificationQuestion: 'La consulta compuesta contiene partes que no puedo relacionar con seguridad. Indícalas por separado; no asumiré relaciones entre entidades o resultados.' });
function groundedCoversComposite(message) {
  const parts = splitRequests(message);
  if (parts.some(part => writeClause(part) || isOutOfDomain(part))) return false;
  const plan = require('./groundedRouting').classifyGrounded(message);
  if (plan.route !== 'GROUNDED_LLM') return false;
  const signals = { business: /ventas?|vend[ií]|tickets?|margen/, inventory: /stock|inventario|repon/, forecast: /forecast|pronostic|prediccion|demanda/,
    customers: /clientes?|compradores/, suppliers: /proveedor(?:es)?/, health: /negocio|salud/, 'cross-sell': /juntos|cross.sell|cesta|asociacion/ };
  return parts.every(part => {
    const requested = Object.entries(signals).filter(([, pattern]) => pattern.test(normalize(part))).map(([domain]) => domain);
    if (!requested.length) return /^(?:dime|explica|que|como)\b.*\b(?:prioriz\w*|vigilar|interpret\w*|conclusion\w*)\b/.test(normalize(part));
    return requested.every(domain => plan.domains.includes(domain));
  });
}
function compositePlan(message, memory, binding, route) {
  const shared = require('./specialistRouting').sharedProductPlan(message, memory);
  if (shared) return shared;
  const parts = splitRequests(message);
  if (parts.length < 2) return null;
  if (parts.length > 4 || parts.some(writeClause)) return clarify();
  if (parts.slice(1).some(part => /\b(?:de esos|cada uno|con el|de cada|los dos primeros)\b/.test(normalize(part)))) return clarify();
  const external = parts.filter(isOutOfDomain), business = parts.filter(part => !isOutOfDomain(part));
  if (!business.length) return { outOfDomain: true };
  const plans = business.map(part => route(part, memory, binding));
  if (plans.some(plan => !plan?.tasks?.length || plan.route || plan.tasks.some(task => task.fromPrevious))) return {
    ...clarify(), semanticFallback: parts.length === 2 && business.length === 2
      && business.every(require('./languageNlu').likelySpecialistQuery)
      && plans.every(plan => !plan?.clarificationQuestion || plan.semanticFallback === true)
  };
  const tasks = plans.flatMap(plan => plan.tasks);
  if (new Set(tasks.map(row => row.agent)).size > 2) return clarify();
  const specialistPair = tasks.length === 2 && tasks.some(task => task.agent === 'inventory') && tasks.some(task => task.agent === 'forecast');
  if (specialistPair && (!tasks[0].args.productRef || !tasks[1].args.productRef
    || normalize(tasks[0].args.productRef) !== normalize(tasks[1].args.productRef))) return clarify();
  if (tasks.length > 4) return clarify();
  // Do not execute a context-dependent clause against a previous turn's entity
  // when the current composite could establish a different one.
  if (business.slice(1).some(part => /\b(?:ese|esa|este|su|lo provee)\b/.test(normalize(part)))) return clarify();
  return { tasks, ...(external.length ? { publicNote: 'La parte externa está fuera del ámbito del sistema. Respondo la parte del negocio.' } : {}) };
}
module.exports = { splitRequests, writeClause, compositePlan, groundedCoversComposite };
