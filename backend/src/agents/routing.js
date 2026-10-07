const { AgentError, isPlainObject, validateAgentMessage } = require('./contracts');

const ROUTING_SCHEMA = Object.freeze({
  type: 'OBJECT', additionalProperties: false,
  properties: {
    intent: { type: 'STRING', enum: ['business_query', 'clarification', 'out_of_scope'] },
    targetAgent: { type: 'STRING', enum: ['coordinator', 'operations', 'analyst'] },
    requiresClarification: { type: 'BOOLEAN' }
  },
  required: ['intent', 'targetAgent', 'requiresClarification']
});
const validateRoutingOutput = output => {
  if (!isPlainObject(output) || Reflect.ownKeys(output).some(key => !['intent', 'targetAgent', 'requiresClarification'].includes(key))
    || !['business_query', 'clarification', 'out_of_scope'].includes(output.intent)
    || !['coordinator', 'operations', 'analyst'].includes(output.targetAgent)
    || typeof output.requiresClarification !== 'boolean') throw new AgentError('GEMINI_INVALID_RESPONSE');
  if ((output.intent === 'clarification') !== output.requiresClarification
    || (output.intent !== 'business_query' && output.targetAgent !== 'coordinator')
    || (output.intent === 'business_query' && !['operations', 'analyst'].includes(output.targetAgent))) {
    throw new AgentError('GEMINI_INVALID_RESPONSE');
  }
  return Object.freeze({ ...output });
};
const classifyAgentIntent = async (execution, query) => {
  if (!execution || typeof execution.generateStructured !== 'function') throw new AgentError('AGENT_INVALID_REQUEST');
  const text = validateAgentMessage(query);
  const result = await execution.generateStructured({ agentId: 'coordinator',
    systemInstruction: 'Clasifica la consulta en español. Devuelve solo el esquema indicado. No inventes datos ni ejecutes herramientas.',
    messages: [{ role: 'user', text }], schema: ROUTING_SCHEMA });
  return validateRoutingOutput(result.output);
};

module.exports = { ROUTING_SCHEMA, validateRoutingOutput, classifyAgentIntent };
