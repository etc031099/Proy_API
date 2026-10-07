const { AgentError, isPlainObject } = require('./contracts');
const { getAgentDefinition } = require('./definitions');
const { SKILLS } = require('./skills');

const toGeminiType = type => ({ object: 'OBJECT', string: 'STRING', integer: 'INTEGER', number: 'NUMBER', boolean: 'BOOLEAN', array: 'ARRAY' })[type];
const declarationSchema = (skill, properties) => {
  const result = { type: 'object', properties, additionalProperties: false };
  if (skill.inputSchema.required.length) result.required = [...skill.inputSchema.required];
  if (skill.inputSchema.oneOf) {
    result.oneOf = skill.inputSchema.oneOf.map(option => ({ required: [...option.required] }));
  }
  return result;
};

const getToolDeclarations = agentId => {
  const agent = getAgentDefinition(agentId);
  return Object.freeze(SKILLS.filter(skill => agent.allowedSkills.includes(skill.id)
    && skill.allowedAgents.includes(agentId) && skill.readOnly && skill.executorStatus === 'READY')
    .map(skill => Object.freeze({
      name: skill.id,
      description: skill.description,
      parametersJsonSchema: declarationSchema(skill, Object.fromEntries(Object.entries(skill.inputSchema.properties).map(([name, property]) => {
        const type = toGeminiType(property.type);
        if (!type) throw new AgentError('AGENT_INVALID_REQUEST');
        return [name, { type: type.toLowerCase(), ...(property.enum ? { enum: [...property.enum] } : {}),
          ...(property.format ? { format: property.format } : {}),
          ...(property.minimum !== undefined ? { minimum: property.minimum } : {}),
          ...(property.maximum !== undefined ? { maximum: property.maximum } : {}),
          ...(property.minLength !== undefined ? { minLength: property.minLength } : {}),
          ...(property.maxLength !== undefined ? { maxLength: property.maxLength } : {}) }];
      })))
    })));
};

/** Execute only a returned declaration name, through the normal server validator. */
const executeRequestedSkill = (execution, agentId, functionCall) => {
  if (!execution || typeof execution.executeSkill !== 'function' || !isPlainObject(functionCall)
    || Reflect.ownKeys(functionCall).some(key => !['name', 'args'].includes(key))
    || typeof functionCall.name !== 'string' || !isPlainObject(functionCall.args)) {
    throw new AgentError('AGENT_INVALID_REQUEST');
  }
  return execution.executeSkill({ agentId, skillId: functionCall.name, args: functionCall.args });
};

module.exports = { getToolDeclarations, executeRequestedSkill };
