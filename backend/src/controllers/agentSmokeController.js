const { AgentError } = require('../agents/contracts');
const { GeminiProviderError, getGeminiProvider } = require('../agents/providers/geminiProvider');

const TOKEN_FIELDS = Object.freeze([
  'inputTokens', 'outputTokens', 'thoughtTokens', 'cachedInputTokens', 'toolUseTokens', 'totalTokens'
]);
const SAFE_ERROR_CODES = new Set([
  'GEMINI_AUTHENTICATION_FAILED', 'GEMINI_PERMISSION_DENIED', 'GEMINI_MODEL_NOT_FOUND',
  'GEMINI_RATE_LIMITED', 'GEMINI_TIMEOUT', 'GEMINI_NETWORK_ERROR', 'GEMINI_UNAVAILABLE', 'GEMINI_INVALID_RESPONSE'
]);
const statusFor = code => ({
  GEMINI_AUTHENTICATION_FAILED: 502,
  GEMINI_PERMISSION_DENIED: 502,
  GEMINI_MODEL_NOT_FOUND: 502,
  GEMINI_RATE_LIMITED: 503,
  GEMINI_TIMEOUT: 504,
  GEMINI_NETWORK_ERROR: 503,
  GEMINI_UNAVAILABLE: 503,
  GEMINI_INVALID_RESPONSE: 502
}[code] || 503);

const createGeminiSmokeHandler = ({ enabled, providerFactory = getGeminiProvider } = {}) => async (req, res) => {
  if (enabled !== true) return res.status(404).json({ success: false, code: 'AGENT_DISABLED' });
  const body = req.body;
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)) {
    return res.status(400).json({ success: false, code: 'AGENT_INVALID_REQUEST', message: 'Request body must be empty' });
  }

  try {
    const result = await providerFactory().generate({
      agentId: 'coordinator',
      systemInstruction: 'Responde exactamente con la palabra OK. No uses herramientas ni solicites datos.',
      messages: [{ role: 'user', text: 'Responde únicamente: OK' }]
    });
    const usage = result?.usage;
    if (typeof result?.model !== 'string' || !/^[\w.:/-]{1,100}$/.test(result.model)
      || result.text?.trim() !== 'OK' || typeof result.latencyMs !== 'number' || !Number.isFinite(result.latencyMs)
      || !usage || typeof usage.usageAvailable !== 'boolean'
      || !TOKEN_FIELDS.every(field => usage[field] === null || Number.isSafeInteger(usage[field]) && usage[field] >= 0)) {
      throw new AgentError('GEMINI_INVALID_RESPONSE');
    }
    const metricsComplete = usage.usageAvailable && TOKEN_FIELDS.every(field => usage[field] !== null);
    return res.status(200).json({
      success: true,
      model: result.model,
      output: 'OK',
      usage: { ...Object.fromEntries(TOKEN_FIELDS.map(field => [field, usage[field]])),
        usageAvailable: usage.usageAvailable, metricsComplete },
      latencyMs: result.latencyMs
    });
  } catch (error) {
    const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : 'GEMINI_UNAVAILABLE';
    return res.status(statusFor(code)).json({
      success: false,
      code,
      message: new GeminiProviderError(code).message
    });
  }
};

module.exports = { createGeminiSmokeHandler, statusFor };
