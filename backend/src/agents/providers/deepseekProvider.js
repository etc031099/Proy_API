'use strict';
const { createNeutralProvider } = require('./neutralProvider');
const { isPlainObject } = require('../contracts');
const { DEEPSEEK_PRICES } = require('../../config/deepseekPricing');
const failure = code => Object.assign(new Error('DeepSeek response unavailable'), { code });
const count = value => Number.isSafeInteger(value) && value >= 0;
const DEFAULT_MAX_OUTPUT_TOKENS = 500;
const MAX_OUTPUT_TOKENS = 600;

const readDeepSeekConfig = (env = process.env) => {
  const model = env.DEEPSEEK_MODEL || 'deepseek-flash';
  let base;
  try { base = new URL(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'); }
  catch { throw failure('DEEPSEEK_CONFIGURATION_INVALID'); }
  const maxOutputTokens = Number(env.DEEPSEEK_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS);
  const timeoutMs = Number(env.DEEPSEEK_TIMEOUT_MS || 15000);
  if (base.origin !== 'https://api.deepseek.com' || !['/', '/v1', '/v1/'].includes(base.pathname)
    || base.username || base.password || base.search || base.hash
    || !['deepseek-flash', 'deepseek-v4-pro'].includes(model)
    || (env.DEEPSEEK_REASONING_EFFORT || 'none') !== 'none'
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000)
    throw failure('DEEPSEEK_CONFIGURATION_INVALID');
  return Object.freeze({ model, endpoint: `${base.href.replace(/\/$/, '')}/chat/completions`, maxOutputTokens, timeoutMs });
};

const normalizeDeepSeekUsage = source => {
  if (source !== undefined && source !== null && !isPlainObject(source)) throw failure('DEEPSEEK_INVALID_RESPONSE');
  const usage = isPlainObject(source) ? source : {};
  for (const value of [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, usage.prompt_cache_hit_tokens,
    usage.prompt_cache_miss_tokens, usage.prompt_tokens_details?.cached_tokens, usage.completion_tokens_details?.reasoning_tokens]) {
    if (value !== undefined && value !== null && !count(value)) throw failure('DEEPSEEK_INVALID_RESPONSE');
  }
  const parsed = { inputTokens: count(usage.prompt_tokens) ? usage.prompt_tokens : null,
    outputTokens: count(usage.completion_tokens) ? usage.completion_tokens : null,
    totalTokens: count(usage.total_tokens) ? usage.total_tokens : null,
    cachedInputTokens: count(usage.prompt_cache_hit_tokens) ? usage.prompt_cache_hit_tokens
      : count(usage.prompt_tokens_details?.cached_tokens) ? usage.prompt_tokens_details.cached_tokens : null,
    cacheMissInputTokens: count(usage.prompt_cache_miss_tokens) ? usage.prompt_cache_miss_tokens : null,
    reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens) ? usage.completion_tokens_details.reasoning_tokens : null };
  // Do not replace missing usage with an estimate or zero.
  if (parsed.inputTokens !== null && parsed.outputTokens !== null && parsed.totalTokens !== null
    && parsed.inputTokens + parsed.outputTokens !== parsed.totalTokens
    || parsed.inputTokens !== null && [parsed.cachedInputTokens, parsed.cacheMissInputTokens].some(n => n !== null && n > parsed.inputTokens)
    || parsed.cachedInputTokens !== null && parsed.cacheMissInputTokens !== null && parsed.inputTokens !== null
      && parsed.cachedInputTokens + parsed.cacheMissInputTokens !== parsed.inputTokens
    || count(usage.prompt_cache_hit_tokens) && count(usage.prompt_tokens_details?.cached_tokens)
      && usage.prompt_cache_hit_tokens !== usage.prompt_tokens_details.cached_tokens
    || parsed.reasoningTokens !== null && parsed.outputTokens !== null && parsed.reasoningTokens > parsed.outputTokens)
    throw failure('DEEPSEEK_INVALID_RESPONSE');
  return parsed;
};

const createDeepSeekProvider = ({ env = process.env, fetchImpl = globalThis.fetch, clock } = {}) => {
  const config = readDeepSeekConfig(env), apiKey = env.DEEPSEEK_API_KEY;
  // Key is held only by this closure; it is never part of config, errors or telemetry.
  return createNeutralProvider({ provider: 'deepseek', model: config.model, prices: DEEPSEEK_PRICES,
    timeoutMs: config.timeoutMs, ...(clock ? { clock } : {}), generate: async request => {
      if (request.route !== 'GROUNDED_LLM' || typeof apiKey !== 'string' || !apiKey.trim()
        || /[\r\n]/.test(apiKey) || typeof fetchImpl !== 'function') throw failure('DEEPSEEK_CONFIGURATION_INVALID');
      const body = { model: config.model, messages: request.messages, stream: false,
        max_tokens: Math.min(request.maxTokens, config.maxOutputTokens), reasoning_effort: 'none',
        response_format: { type: 'json_object' }, temperature: request.temperature };
      let response;
      try {
        response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error', signal: request.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim()}` }, body: JSON.stringify(body) });
      } catch { throw failure(request.signal.aborted ? 'DEEPSEEK_TIMEOUT' : 'DEEPSEEK_NETWORK_ERROR'); }
      const diagnostic = { providerResponseReceived: true, httpStatus: response.status,
        contentPresent: false, contentLength: 0, finishReason: null, usagePresent: false,
        usageParseResult: 'ABSENT', validationResult: 'REJECTED', validationReason: 'HTTP_ERROR' };
      const reject = reason => { throw Object.assign(failure('DEEPSEEK_INVALID_RESPONSE'),
        { responseDiagnostic: { ...diagnostic, validationReason: reason }, usage: parsedUsage }); };
      let parsedUsage = normalizeDeepSeekUsage();
      if (!response.ok) throw Object.assign(failure(response.status === 401 || response.status === 403 ? 'DEEPSEEK_AUTH_FAILED'
        : response.status === 429 ? 'DEEPSEEK_RATE_LIMITED' : 'DEEPSEEK_UNAVAILABLE'), { responseDiagnostic: diagnostic });
      let result;
      try { result = await response.json(); } catch { reject('ENVELOPE_JSON_INVALID'); }
      const choice = result?.choices?.[0], message = choice?.message;
      diagnostic.contentPresent = typeof message?.content === 'string' && Boolean(message.content.trim());
      diagnostic.contentLength = typeof message?.content === 'string' ? message.content.length : 0;
      diagnostic.finishReason = ['stop', 'length', 'tool_calls', 'content_filter', 'insufficient_system_resource'].includes(choice?.finish_reason) ? choice.finish_reason : null;
      diagnostic.usagePresent = result?.usage !== undefined && result?.usage !== null;
      try {
        parsedUsage = normalizeDeepSeekUsage(result?.usage);
        diagnostic.usageParseResult = !diagnostic.usagePresent ? 'ABSENT'
          : ['inputTokens', 'outputTokens', 'totalTokens'].every(key => parsedUsage[key] !== null) ? 'COMPLETE' : 'INCOMPLETE';
      } catch { diagnostic.usageParseResult = 'INVALID'; reject('USAGE_INVALID'); }
      if (choice?.finish_reason === 'length') reject('OUTPUT_TRUNCATED');
      if (!isPlainObject(result) || result.model !== config.model || result.choices?.length !== 1
        || choice?.finish_reason !== 'stop' || message?.role !== 'assistant' || message.tool_calls?.length || message.function_call
        || typeof message?.content !== 'string' || !message.content.trim() || message.content.length > 6000)
        reject(!diagnostic.contentPresent ? 'CONTENT_EMPTY' : result.model !== config.model ? 'MODEL_MISMATCH'
          : choice?.finish_reason !== 'stop' ? 'FINISH_REASON_UNSUPPORTED' : 'ENVELOPE_SCHEMA_INVALID');
      // Drop reasoning_content and all provider envelope data before crossing the boundary.
      return { text: message.content, usage: parsedUsage,
        responseDiagnostic: { ...diagnostic, validationResult: 'ACCEPTED', validationReason: 'NONE' } };
    } });
};
module.exports = { createDeepSeekProvider, readDeepSeekConfig, normalizeDeepSeekUsage,
  DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS };
