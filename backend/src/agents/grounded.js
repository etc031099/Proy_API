'use strict';
const { classifyGrounded, buildGroundedPlan } = require('./groundedRouting');
const { buildGroundedContext, contextMetrics, validateGroundedOutput } = require('./groundedContext');
const { renderV3 } = require('./v3Routing');

const handleGrounded = async ({ message, context, service, run, execution }) => {
  if (classifyGrounded(message).route !== 'GROUNDED_LLM') return null;
  let binding;
  try { binding = await service.resolveContext(context); }
  catch { return { intent: 'grounded_unavailable', agent: 'coordinator', answer: 'No pude verificar el contexto del negocio para este análisis.' }; }
  if (!binding) return null;
  const plan = buildGroundedPlan(message, binding);
  if (plan.clarificationQuestion) return { answer: plan.clarificationQuestion, clarification: true, intent: 'grounded_clarification', agent: 'coordinator' };
  const results = [], facts = [];
  let incomplete = false;
  for (const task of plan.tasks) {
    const args = { ...task.args };
    const previousItems = results.find(row => row.skillId === 'get_inventory_intelligence')?.result.data?.items
      || results.find(row => row.skillId === 'get_business_analytics')?.result.data?.items;
    const skus = previousItems?.map(row => row.sku).filter(Boolean).slice(0, 3);
    if (skus?.length && !args.productRef && ['get_inventory_intelligence', 'get_product_forecast'].includes(task.skillId))
      args.productRefs = skus.join('|');
    try {
      const result = await run(task.agent, task.skillId, args);
      results.push({ skillId: task.skillId, result });
      if (!['READY', 'NO_DATA', 'PARTIAL'].includes(result.status)) { incomplete = true; break; }
      facts.push(renderV3(task.skillId, result, args));
      if (result.status === 'PARTIAL') incomplete = true;
    } catch { incomplete = true; break; }
  }
  const compact = buildGroundedContext({ question: message, plan, results, binding });
  const grounded = { route: plan.route, responseIntent: plan.responseIntent, domains: plan.domains,
    skills: plan.skills, contextMetrics: contextMetrics(compact), noHistoricalSkuData: compact.noHistoricalSkuData };
  let answer = facts.filter(Boolean).join('\n\n');
  const notes = [];
  if (plan.responseIntent === 'customer_retention') notes.push('El valor del cliente y su inactividad son señales distintas; no hay una probabilidad de abandono calculada. K-Means es exploratorio.');
  if (plan.noHistoricalSkuData) notes.push('No hay historial directo de SKU nuevos: cualquier propuesta sería exploratoria, no un pronóstico validado.');
  if (incomplete) notes.push('No hay datos suficientes para una interpretación completa; se conservan los hechos obtenidos.');
  else if (!execution.hasGroundedProvider()) notes.push('La interpretación adicional aún no está habilitada; estos son los datos verificados.');
  else if (!compact.evidence.some(row => row.facts && row.status === 'READY')) notes.push('No hay datos suficientes para generar una interpretación.');
  else {
    try {
      const generated = await execution.generateGrounded({ maxTokens: 300, temperature: 0,
        messages: [{ role: 'system', content: 'Devuelve JSON con observations (1 a 3: evidenceRefs, interpretation, advisoryRecommendation) y limitations (array vacío o reglas aplicables copiadas de constraints). Sigue constraints; sin herramientas.' },
          { role: 'user', content: JSON.stringify(compact) }] });
      const interpreted = validateGroundedOutput(generated.text, compact);
      answer += '\n\nInterpretación y recomendaciones:\n' + interpreted.observations.map(row => `${row.interpretation} ${row.advisoryRecommendation}`).join('\n');
      notes.push(...interpreted.limitations);
    } catch { notes.push('No pude generar una interpretación validada; se conservan los hechos obtenidos.'); }
  }
  return { intent: plan.responseIntent, agent: 'analyst', grounded,
    answer: [answer || 'No hay datos suficientes.', ...notes].join('\n\n') };
};
module.exports = { handleGrounded };
