const { performance } = require('node:perf_hooks');
const { AgentError, isPlainObject } = require('../contracts');
const { getAgentDefinition } = require('../definitions');
const { getToolDeclarations } = require('../toolCalls');
const { DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_TIMEOUT_MS } = require('../../config/env');

const GEMINI_ERROR_MESSAGES = Object.freeze({
  GEMINI_NOT_CONFIGURED: 'Gemini is not configured',
  GEMINI_AUTHENTICATION_FAILED: 'Gemini authentication failed',
  GEMINI_PERMISSION_DENIED: 'Gemini permission denied',
  GEMINI_MODEL_NOT_FOUND: 'Gemini model was not found',
  GEMINI_NETWORK_ERROR: 'Gemini network request failed',
  GEMINI_TIMEOUT: 'Gemini request timed out',
  GEMINI_RATE_LIMITED: 'Gemini rate limit reached',
  GEMINI_UNAVAILABLE: 'Gemini is temporarily unavailable',
  GEMINI_INVALID_RESPONSE: 'Gemini returned an invalid response',
  GEMINI_EMPTY_RESPONSE: 'Gemini returned no usable content',
  GEMINI_INVALID_JSON: 'Gemini returned invalid JSON',
  GEMINI_SCHEMA_VALIDATION_FAILED: 'Gemini response did not match the required schema',
  GEMINI_OUTPUT_TRUNCATED: 'Gemini output was truncated by its token limit',
  GEMINI_BUDGET_EXCEEDED: 'Gemini request budget exceeded'
});

class GeminiProviderError extends AgentError {
  constructor(code, { httpStatus = null, providerCode = null, retryable = false, diagnostics = null } = {}) {
    super(Object.hasOwn(GEMINI_ERROR_MESSAGES, code) ? code : 'GEMINI_UNAVAILABLE');
    this.name = 'GeminiProviderError';
    this.code = Object.hasOwn(GEMINI_ERROR_MESSAGES, code) ? code : 'GEMINI_UNAVAILABLE';
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
    this.category = this.code;
    this.providerCode = typeof providerCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(providerCode)
      ? providerCode : null;
    this.retryable = retryable === true;
    if (diagnostics) this.diagnostics = diagnostics;
  }
}

const inputError = () => { throw new AgentError('AGENT_INVALID_REQUEST'); };
const normalizeUsage = metadata => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { usageAvailable: false, inputTokens: null, outputTokens: null, thoughtTokens: null,
      cachedInputTokens: null, toolUseTokens: null, totalTokens: null };
  }
  const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    usageAvailable: true,
    inputTokens: token(metadata.promptTokenCount),
    outputTokens: token(metadata.candidatesTokenCount),
    thoughtTokens: token(metadata.thoughtsTokenCount),
    cachedInputTokens: token(metadata.cachedContentTokenCount),
    toolUseTokens: token(metadata.toolUsePromptTokenCount),
    // Keep Google's official total; do not recompute its accounting.
    totalTokens: token(metadata.totalTokenCount)
  };
};
const providerError = error => {
  if (error instanceof GeminiProviderError) return error;
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  const message = String(error?.message || '');
  const providerCodeValue = error?.error?.status ?? error?.statusText;
  const providerCode = typeof providerCodeValue === 'string'
    && ['UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(providerCodeValue)
    ? providerCodeValue : null;
  const metadata = { httpStatus: status, providerCode };
  if (status === 401 || providerCode === 'UNAUTHENTICATED' || /API key not valid|invalid api key|unauthenticated/i.test(message)) {
    return new GeminiProviderError('GEMINI_AUTHENTICATION_FAILED', metadata);
  }
  if (status === 403 || providerCode === 'PERMISSION_DENIED' || /permission denied|forbidden|not authorized/i.test(message)) {
    return new GeminiProviderError('GEMINI_PERMISSION_DENIED', metadata);
  }
  if (status === 404 || providerCode === 'NOT_FOUND' && /model|generatecontent|resource.*not found/i.test(message)) {
    return new GeminiProviderError('GEMINI_MODEL_NOT_FOUND', metadata);
  }
  if (status === 429 || providerCode === 'RESOURCE_EXHAUSTED' || /rate.?limit|resource exhausted|quota/i.test(message)) {
    return new GeminiProviderError('GEMINI_RATE_LIMITED', { ...metadata, retryable: true });
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /timed? ?out|deadline exceeded/i.test(`${error?.name || ''} ${message}`)
    || providerCode === 'DEADLINE_EXCEEDED') {
    return new GeminiProviderError('GEMINI_TIMEOUT', { ...metadata, retryable: true });
  }
  if (/fetch failed|network|socket|econn|enotfound|connection/i.test(message)
    || /^ERR_(?:NETWORK|INTERNET|CONNECTION)/.test(String(error?.code || ''))) {
    return new GeminiProviderError('GEMINI_NETWORK_ERROR', { ...metadata, retryable: true });
  }
  if ((Number.isInteger(status) && status >= 500 && status <= 599) || ['INTERNAL', 'UNAVAILABLE'].includes(providerCode)) {
    return new GeminiProviderError('GEMINI_UNAVAILABLE', { ...metadata, retryable: true });
  }
  return new GeminiProviderError('GEMINI_UNAVAILABLE', metadata);
};

const validatePrompt = ({ systemInstruction, messages }) => {
  if (typeof systemInstruction !== 'string' || systemInstruction.trim().length === 0 || systemInstruction.length > 2000
    || !Array.isArray(messages) || messages.length < 1 || messages.length > 8) inputError();
  let totalChars = systemInstruction.length;
  const sensitiveText = /@[a-z\d.-]+\.[a-z]{2,}|\b\d{9,15}\b|\b[a-f\d]{24}\b|\bBearer\s+\S+|AIza[\w-]{20,}|\b[a-f\d]{32,}\b/i;
  if (sensitiveText.test(systemInstruction)) inputError();
  for (const message of messages) {
    if (!isPlainObject(message) || Reflect.ownKeys(message).some(key => !['role', 'text'].includes(key))
      || !['user', 'model'].includes(message.role) || typeof message.text !== 'string'
      || !message.text.trim() || message.text.length > 2000) inputError();
    totalChars += message.text.length;
    // Requests contain no business records. Refuse obvious identifiers/secrets if accidentally added.
    if (sensitiveText.test(message.text)) inputError();
  }
  if (totalChars > 6000) throw new GeminiProviderError('GEMINI_BUDGET_EXCEEDED');
};

const responseParts = response => Array.isArray(response?.candidates)
  ? response.candidates[0]?.content?.parts || [] : [];
const readResponseText = response => {
  let sdkText;
  try { sdkText = response?.text; } catch { sdkText = undefined; }
  if (typeof sdkText === 'string' && sdkText.trim()) return sdkText;
  return responseParts(response).filter(part => part && typeof part.text === 'string' && part.thought !== true)
    .map(part => part.text).join('');
};
const readFunctionCalls = response => {
  let sdkCalls;
  try { sdkCalls = response?.functionCalls; } catch { sdkCalls = undefined; }
  if (sdkCalls !== undefined && !Array.isArray(sdkCalls)) return sdkCalls;
  if (Array.isArray(sdkCalls) && sdkCalls.length) return sdkCalls;
  const parts = responseParts(response);
  const callsFromParts = parts.filter(part => part?.functionCall).map(part => part.functionCall);
  return callsFromParts.length ? callsFromParts : Array.isArray(sdkCalls) ? sdkCalls : undefined;
};
const responseDiagnostics = (response, kind, text, calls) => {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const finishReason = candidates.map(candidate => candidate?.finishReason)
    .filter(value => typeof value === 'string' && /^[A-Z_]{2,40}$/.test(value)).slice(0, 4);
  const hasText = typeof text === 'string' && text.trim().length > 0;
  const hasFunctionCall = Array.isArray(calls) && calls.length > 0;
  const hasOtherParts = responseParts(response).some(part => part && typeof part === 'object'
    && typeof part.text !== 'string' && !part.functionCall);
  const responseKind = hasFunctionCall ? 'function_call'
    : hasText ? kind === 'structured' ? 'structured' : 'text'
      : hasOtherParts ? 'unknown' : 'empty';
  return Object.freeze({ responseKind, candidateCount: candidates.length, finishReason: Object.freeze(finishReason),
    hasText, hasFunctionCall, hasUsageMetadata: Boolean(response?.usageMetadata) });
};
const parseToolCalls = (response, diagnostics = null) => {
  const calls = readFunctionCalls(response);
  if (calls === undefined) return [];
  if (!Array.isArray(calls)) throw new GeminiProviderError('GEMINI_INVALID_RESPONSE', { diagnostics });
  if (calls.length > 4) throw new GeminiProviderError('GEMINI_BUDGET_EXCEEDED');
  return calls.map(call => {
    if (!isPlainObject(call) || typeof call.name !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(call.name)
      || call.args !== undefined && !isPlainObject(call.args)) throw new GeminiProviderError('GEMINI_INVALID_RESPONSE', { diagnostics });
    return Object.freeze({ name: call.name, args: Object.freeze({ ...(call.args || {}) }) });
  });
};

const schemaTypeMatches = (value, expected) => {
  const type = String(expected || '').toLowerCase();
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
};
const matchesSchema = (value, schema, depth = 0) => {
  if (!isPlainObject(schema) || depth > 20) return false;
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.some(candidate => Object.is(candidate, value)))) return false;
  if (schema.oneOf) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.filter(candidate => matchesSchema(value, candidate, depth + 1)).length !== 1) return false;
  }
  if (schema.type && ![].concat(schema.type).some(type => schemaTypeMatches(value, type))) return false;
  if (schemaTypeMatches(value, 'object')) {
    if (Array.isArray(schema.required) && schema.required.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties || {}, key))) return false;
    if (schema.properties && (!isPlainObject(schema.properties)
      || Object.entries(schema.properties).some(([key, propertySchema]) => Object.hasOwn(value, key)
        && !matchesSchema(value[key], propertySchema, depth + 1)))) return false;
  }
  if (Array.isArray(value) && schema.items && value.some(item => !matchesSchema(item, schema.items, depth + 1))) return false;
  return true;
};

const createGeminiProvider = ({ apiKey, model = DEFAULT_GEMINI_MODEL,
  timeoutMs = DEFAULT_GEMINI_TIMEOUT_MS, client, now = performance.now.bind(performance) } = {}) => {
  if (apiKey !== undefined && apiKey !== null && (typeof apiKey !== 'string' || !apiKey.trim())) {
    throw new GeminiProviderError('GEMINI_NOT_CONFIGURED');
  }
  if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(model)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 20000 || typeof now !== 'function') {
    throw new GeminiProviderError('GEMINI_NOT_CONFIGURED');
  }
  let sdkClient = client;
  const getClient = () => {
    if (!apiKey) throw new GeminiProviderError('GEMINI_NOT_CONFIGURED');
    if (!sdkClient) {
      const { GoogleGenAI } = require('@google/genai');
      sdkClient = new GoogleGenAI({ apiKey, httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } } });
    }
    return sdkClient;
  };
  const request = async (input, kind, schema) => {
    if (!isPlainObject(input)) inputError();
    const allowed = kind === 'structured'
      ? ['agentId', 'systemInstruction', 'messages', 'schema'] : ['agentId', 'systemInstruction', 'messages'];
    if (Reflect.ownKeys(input).some(key => !allowed.includes(key))) inputError();
    const { agentId, systemInstruction, messages } = input;
    let agent;
    try { agent = getAgentDefinition(agentId); } catch { inputError(); }
    validatePrompt({ systemInstruction, messages });
    if (kind === 'structured' && (!isPlainObject(schema) || Reflect.ownKeys(schema).length === 0)) inputError();

    const controller = new AbortController();
    const start = now();
    let timer;
    let response;
    try {
      const config = {
        systemInstruction,
        maxOutputTokens: agent.limits.providerMaxOutputTokens,
        thinkingConfig: { thinkingLevel: 'low' },
        automaticFunctionCalling: { disable: true },
        abortSignal: controller.signal,
        httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } }
      };
      if (kind === 'structured') {
        config.responseMimeType = 'application/json';
        config.responseSchema = schema;
      }
      if (kind === 'tools') {
        const tools = getToolDeclarations(agentId);
        if (tools.length) config.tools = [{ functionDeclarations: tools }];
      }
      const requestPromise = getClient().models.generateContent({
        model, contents: messages.map(message => ({ role: message.role === 'model' ? 'model' : 'user', parts: [{ text: message.text }] })), config
      });
      response = await Promise.race([requestPromise, new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new GeminiProviderError('GEMINI_TIMEOUT', { retryable: true }));
        }, timeoutMs);
      })]);
    } catch (error) {
      if (!apiKey && error instanceof GeminiProviderError) throw error;
      if (controller.signal.aborted) throw new GeminiProviderError('GEMINI_TIMEOUT', { retryable: true });
      throw providerError(error);
    } finally { clearTimeout(timer); }

    const latencyMs = now() - start;
    const usage = normalizeUsage(response?.usageMetadata);
    const text = readResponseText(response);
    const calls = readFunctionCalls(response);
    const diagnostics = responseDiagnostics(response, kind, text, calls);
    const toolCalls = parseToolCalls(response, diagnostics);
    const outputTruncated = diagnostics.finishReason.includes('MAX_TOKENS');
    if (kind === 'structured') {
      if (!text.trim()) throw new GeminiProviderError(outputTruncated ? 'GEMINI_OUTPUT_TRUNCATED' : 'GEMINI_EMPTY_RESPONSE', { diagnostics });
      let output;
      try { output = JSON.parse(text); } catch {
        throw new GeminiProviderError(outputTruncated ? 'GEMINI_OUTPUT_TRUNCATED' : 'GEMINI_INVALID_JSON', { diagnostics });
      }
      if (!matchesSchema(output, schema)) throw new GeminiProviderError('GEMINI_SCHEMA_VALIDATION_FAILED', { diagnostics });
      return Object.freeze({ output: isPlainObject(output) ? Object.freeze(output) : output, model, latencyMs, usage, diagnostics });
    }
    if (kind === 'tools' && toolCalls.length) return Object.freeze({ text: typeof text === 'string' ? text : '',
      toolCalls: Object.freeze(toolCalls), model, latencyMs, usage, diagnostics });
    if (!text.trim()) throw new GeminiProviderError(outputTruncated ? 'GEMINI_OUTPUT_TRUNCATED' : 'GEMINI_EMPTY_RESPONSE', { diagnostics });
    return Object.freeze({ text, ...(kind === 'tools' ? { toolCalls: Object.freeze([]) } : {}), model, latencyMs, usage, diagnostics });
  };

  return Object.freeze({
    generate: input => request(input, 'text'),
    generateStructured: input => request(input, 'structured', input?.schema),
    generateWithTools: input => request(input, 'tools')
  });
};

let processProvider;
const getGeminiProvider = () => processProvider ||= createGeminiProvider({
  apiKey: String(process.env.AGENT_ENABLED || '').trim().toLowerCase() === 'true'
    ? process.env.GEMINI_API_KEY : undefined,
  model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
  timeoutMs: process.env.GEMINI_TIMEOUT_MS === undefined ? DEFAULT_GEMINI_TIMEOUT_MS : Number(process.env.GEMINI_TIMEOUT_MS)
});

module.exports = { GeminiProviderError, createGeminiProvider, getGeminiProvider, normalizeUsage, providerError,
  responseDiagnostics, readResponseText, readFunctionCalls, matchesSchema, validatePrompt };
