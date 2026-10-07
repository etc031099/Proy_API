const { randomUUID } = require('node:crypto');
const {
  AgentError, ERROR_MESSAGES, EXECUTION_LIMITS, deepFreeze, isPlainObject,
  isTraceId, isDate, isTimestamp, validateSkillArgs
} = require('./contracts');
const { getAgentDefinition } = require('./definitions');
const { getSkillDefinition } = require('./skills');

const EVENT_TYPES = Object.freeze([
  'request_started', 'agent_started', 'llm_started', 'llm_finished',
  'skill_called', 'skill_finished', 'agent_finished', 'request_finished', 'error'
]);
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'thoughtTokens', 'cachedInputTokens', 'toolUseTokens', 'totalTokens'];
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const safeDuration = value => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const invalid = () => { throw new AgentError('AGENT_INVALID_REQUEST'); };

// Only these fields can reach a trace sink. No raw args, prompts, identities or secrets.
const createTraceEvent = (type, metadata) => {
  if (!EVENT_TYPES.includes(type) || !isPlainObject(metadata) || !isTraceId(metadata.requestId)) invalid();
  const event = { type, timestamp: new Date().toISOString(), requestId: metadata.requestId };
  for (const key of ['conversationId', 'agentRunId', 'skillCallId']) {
    if (metadata[key] !== undefined) {
      if (!isTraceId(metadata[key])) invalid();
      event[key] = metadata[key];
    }
  }
  if (metadata.agentId !== undefined) { getAgentDefinition(metadata.agentId); event.agentId = metadata.agentId; }
  if (metadata.skillId !== undefined) { getSkillDefinition(metadata.skillId); event.skillId = metadata.skillId; }
  if (metadata.durationMs !== undefined) {
    if (!safeDuration(metadata.durationMs)) invalid();
    event.durationMs = metadata.durationMs;
  }
  if (metadata.returnedCount !== undefined) {
    if (!safeCount(metadata.returnedCount)) invalid();
    event.returnedCount = metadata.returnedCount;
  }
  if (metadata.model !== undefined) {
    if (typeof metadata.model !== 'string' || !/^[\w.:/-]{1,100}$/.test(metadata.model)) invalid();
    event.model = metadata.model;
  }
  for (const field of TOKEN_FIELDS) {
    if (metadata[field] !== undefined && metadata[field] !== null && !safeCount(metadata[field])) invalid();
    if (Object.hasOwn(metadata, field)) event[field] = metadata[field];
  }
  if (metadata.usageAvailable !== undefined) {
    if (typeof metadata.usageAvailable !== 'boolean') invalid();
    event.usageAvailable = metadata.usageAvailable;
  }
  if (metadata.status !== undefined) {
    if (!['STARTED', 'SUCCEEDED', 'FAILED'].includes(metadata.status)) invalid();
    event.status = metadata.status;
  }
  if (metadata.code !== undefined) {
    if (!Object.hasOwn(ERROR_MESSAGES, metadata.code)) invalid();
    event.code = metadata.code;
  }
  if (/^(agent_|llm_|skill_)/.test(type) && (!event.agentId || !event.agentRunId)) invalid();
  if (type.startsWith('skill_') && (!event.skillId || !event.skillCallId)) invalid();
  return Object.freeze(event);
};

/** Each record represents one completed/failed generation, not a token budget. */
const createRequestUsage = (options = {}) => {
  if (!isPlainObject(options) || Reflect.ownKeys(options).some(key => !['llmRecords', 'totalSkillCalls', 'agentIds'].includes(key))) invalid();
  const { llmRecords = [], totalSkillCalls = 0, agentIds = [] } = options;
  if (!Array.isArray(llmRecords) || llmRecords.length > EXECUTION_LIMITS.maxLlmCalls
    || !Array.isArray(agentIds) || !safeCount(totalSkillCalls)
    || totalSkillCalls > EXECUTION_LIMITS.maxSkillCalls) invalid();
  const ids = new Set(agentIds);
  ids.forEach(getAgentDefinition);
  const records = llmRecords.map(record => {
    if (!isPlainObject(record)) invalid();
    getAgentDefinition(record.agentId);
    ids.add(record.agentId);
    if (typeof record.model !== 'string' || !/^[\w.:/-]{1,100}$/.test(record.model)
      || typeof record.usageAvailable !== 'boolean' || !safeDuration(record.latencyMs)) invalid();
    const copy = { agentId: record.agentId, model: record.model,
      usageAvailable: record.usageAvailable, latencyMs: record.latencyMs };
    for (const field of TOKEN_FIELDS) {
      if (record.usageAvailable) {
        if (record[field] !== null && !safeCount(record[field])) invalid();
        copy[field] = record[field];
      } else {
        if (record[field] !== undefined && record[field] !== null) invalid();
        copy[field] = null;
      }
    }
    if (copy.usageAvailable && copy.cachedInputTokens > copy.inputTokens) invalid();
    return copy;
  });
  const sum = (items, field) => {
    if (items.some(record => !record.usageAvailable || record[field] === null)) return null;
    const value = items.reduce((total, record) => total + record[field], 0);
    if (!safeCount(value)) invalid();
    return value;
  };
  const agents = [...ids].map(agentId => {
    const runs = records.filter(record => record.agentId === agentId);
    const models = [...new Set(runs.map(record => record.model))];
    const latencyMs = runs.reduce((total, record) => total + record.latencyMs, 0);
    if (!safeDuration(latencyMs)) invalid();
    return {
      agentId, model: models.length === 1 ? models[0] : null, llmCalls: runs.length,
      ...Object.fromEntries(TOKEN_FIELDS.map(field => [field, sum(runs, field)])),
      latencyMs, usageAvailable: runs.every(record => record.usageAvailable)
    };
  });
  return deepFreeze({
    totalLlmCalls: records.length, totalSkillCalls,
    totalInputTokens: sum(records, 'inputTokens'), totalOutputTokens: sum(records, 'outputTokens'),
    totalTokens: sum(records, 'totalTokens'),
    totalToolUseTokens: sum(records, 'toolUseTokens'),
    metricsComplete: records.every(record => record.usageAvailable && TOKEN_FIELDS.every(field => record[field] !== null)), agents
  });
};

const createEvidence = options => {
  if (!isPlainObject(options) || Reflect.ownKeys(options).some(key => !['skillId', 'label', 'asOf', 'period'].includes(key))) invalid();
  getSkillDefinition(options.skillId);
  if (typeof options.label !== 'string' || !options.label.trim() || options.label.length > 160
    || (options.asOf !== undefined && !isDate(options.asOf) && !isTimestamp(options.asOf))) invalid();
  let period;
  if (options.period !== undefined) {
    try {
      period = validateSkillArgs({ properties: {
        startDate: { type: 'string', maxLength: 10, format: 'date' },
        endDate: { type: 'string', maxLength: 10, format: 'date' }
      }, required: ['startDate', 'endDate'] }, options.period);
    } catch { invalid(); }
  }
  return deepFreeze({
    evidenceId: randomUUID(), sourceType: 'skill', skillId: options.skillId, label: options.label,
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }), ...(period ? { period } : {})
  });
};

module.exports = { EVENT_TYPES, createTraceEvent, createRequestUsage, createEvidence };
