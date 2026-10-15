'use strict';
const { createDeepSeekProvider } = require('./deepseekProvider');
const selectedProvider = (env = process.env) => String(env.LLM_PROVIDER || 'gemini').trim().toLowerCase();

// Lazy and server-side: deterministic/OOD requests do not construct a client.
const configuredGroundedProvider = (env = process.env) => {
  if (String(env.AGENT_ENABLED).toLowerCase() !== 'true' || selectedProvider(env) !== 'deepseek') return null;
  const model = ['deepseek-flash', 'deepseek-v4-pro'].includes(env.DEEPSEEK_MODEL) ? env.DEEPSEEK_MODEL : 'deepseek-flash';
  let client;
  return Object.freeze({ provider: 'deepseek', model,
    generate: async request => (client ||= createDeepSeekProvider({ env })).generate(request) });
};
module.exports = { selectedProvider, configuredGroundedProvider };
