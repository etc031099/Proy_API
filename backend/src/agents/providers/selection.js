'use strict';
const { createDeepSeekProvider, readDeepSeekConfig } = require('./deepseekProvider');
const selectedProvider = (env = process.env) => String(env.LLM_PROVIDER || 'gemini').trim().toLowerCase();

// Lazy and server-side: deterministic/OOD requests do not construct a client.
const configuredGroundedProvider = (env = process.env) => {
  if (String(env.AGENT_ENABLED).toLowerCase() !== 'true' || selectedProvider(env) !== 'deepseek') return null;
  const model = readDeepSeekConfig(env).model;
  let client;
  return Object.freeze({ provider: 'deepseek', model,
    generate: request => (client ||= createDeepSeekProvider({ env })).generate(request) });
};
module.exports = { selectedProvider, configuredGroundedProvider };
