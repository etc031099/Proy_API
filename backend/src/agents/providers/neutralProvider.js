'use strict';
const { performance } = require('node:perf_hooks');
const { isPlainObject, deepFreeze } = require('../contracts');
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const validId = value => typeof value === 'string' && /^[\w.-]{1,100}$/.test(value);
const unavailable = () => Object.assign(new Error('Provider response unavailable'), { code: 'AGENT_PROVIDER_FAILED' });

// Pricing is supplied by trusted server configuration, never by request arguments.
const estimateCostUsd = ({ provider, model, usage, prices = [], at = new Date().toISOString() }) => {
  const price = prices.filter(row => row.provider === provider && row.model === model && row.currency === 'USD'
    && typeof row.version === 'string' && Number.isFinite(Date.parse(row.effectiveFrom))
    && Date.parse(row.effectiveFrom) <= Date.parse(at)).sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0];
  const unknown = { estimatedCostUsd: null, pricingVersion: price?.version || null };
  if (price?.peak && price?.offPeak) {
    if (price.unit !== 1000000 || !validCount(usage?.inputTokens) || !validCount(usage?.outputTokens)
      || !validCount(usage.cachedInputTokens) || !validCount(usage.cacheMissInputTokens)
      || usage.cachedInputTokens + usage.cacheMissInputTokens !== usage.inputTokens) return unknown;
    const cost = rates => ['cacheHitInput', 'cacheMissInput', 'output'].every(key => Number.isFinite(rates[key]) && rates[key] >= 0)
      ? (usage.cachedInputTokens * rates.cacheHitInput + usage.cacheMissInputTokens * rates.cacheMissInput
        + usage.outputTokens * rates.output) / price.unit : NaN;
    const bounds = [cost(price.offPeak), cost(price.peak)];
    return bounds.every(Number.isFinite) ? { ...unknown, estimatedCostRangeUsd: { min: Math.min(...bounds), max: Math.max(...bounds) } } : unknown;
  }
  if (!price || ![price.inputPricePerToken, price.outputPricePerToken].every(n => Number.isFinite(n) && n >= 0)
    || !validCount(usage?.inputTokens) || !validCount(usage?.outputTokens)) return unknown;
  let cached = 0;
  if (price.cachedInputPricePerToken !== undefined) {
    if (!Number.isFinite(price.cachedInputPricePerToken) || price.cachedInputPricePerToken < 0
      || !validCount(usage.cachedInputTokens) || usage.cachedInputTokens > usage.inputTokens) return unknown;
    cached = usage.cachedInputTokens;
  }
  const amount = (usage.inputTokens - cached) * price.inputPricePerToken + usage.outputTokens * price.outputPricePerToken
    + cached * (price.cachedInputPricePerToken || 0);
  return { estimatedCostUsd: Number.isFinite(amount) ? amount : null, pricingVersion: price.version };
};

// Closed provider-neutral boundary: no tools or caller-supplied credentials.
const createNeutralProvider = ({ provider, model, generate, prices = [], timeoutMs = 15000, clock = () => new Date() }) => {
  if (!validId(provider) || provider === 'none' || !validId(model) || typeof generate !== 'function'
    || !Array.isArray(prices) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) throw unavailable();
  const priceConfig = structuredClone(prices);
  return Object.freeze({ provider, model, async generate(request) {
    if (!isPlainObject(request) || Object.keys(request).some(key => !['route', 'messages', 'maxTokens', 'temperature'].includes(key))
      || request.route !== undefined && request.route !== 'GROUNDED_LLM'
      || !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 8
      || ![300, 600].includes(request.maxTokens) || !Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 1
      || request.messages.some(message => !isPlainObject(message) || Object.keys(message).some(key => !['role', 'content'].includes(key))
        || !['system', 'user'].includes(message.role) || typeof message.content !== 'string')
      || Buffer.byteLength(JSON.stringify(request.messages), 'utf8') > 8000) throw unavailable();
    const start = performance.now(), controller = new AbortController();
    let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(() => generate({ ...request, signal: controller.signal })),
        new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMs); })]);
      if (!isPlainObject(result) || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 6000
        || result.provider !== undefined && result.provider !== provider || result.model !== undefined && result.model !== model) throw unavailable();
      const source = result.usage || {}, usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheMissInputTokens', 'reasoningTokens']
        .map(field => [field, validCount(source[field]) ? source[field] : null]));
      if (usage.cachedInputTokens !== null && usage.inputTokens !== null && usage.cachedInputTokens > usage.inputTokens) throw unavailable();
      return deepFreeze({ text: result.text, provider, model, usage,
        latencyMs: performance.now() - start, ...estimateCostUsd({ provider, model, usage, prices: priceConfig, at: clock().toISOString() }) });
    } catch (error) {
      const safe = unavailable();
      safe.failureKind = controller.signal.aborted ? 'TIMEOUT' : ({
        DEEPSEEK_AUTH_FAILED: 'AUTHENTICATION', DEEPSEEK_RATE_LIMITED: 'RATE_LIMIT', DEEPSEEK_UNAVAILABLE: 'UNAVAILABLE',
        DEEPSEEK_INVALID_RESPONSE: 'INVALID_RESPONSE', DEEPSEEK_NETWORK_ERROR: 'NETWORK',
        DEEPSEEK_CONFIGURATION_INVALID: 'CONFIGURATION'
      }[error?.code] || 'INVALID_RESPONSE');
      throw safe;
    } finally { clearTimeout(timer); }
  } });
};
module.exports = { createNeutralProvider, estimateCostUsd };
