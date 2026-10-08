const ALLOWED_NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);
const MIN_JWT_SECRET_LENGTH = 32;
const MIN_WEBHOOK_SECRET_LENGTH = 32;
const MIN_ML_SECRET_LENGTH = 32;
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_GEMINI_TIMEOUT_MS = 15000;
const { parseCorsAllowedOrigins } = require('./cors');

const EXACT_SECRET_PLACEHOLDERS = new Set([
  'secret',
  'password',
  'example',
  'default',
  'changeme'
]);

const SECRET_PLACEHOLDER_FRAGMENTS = [
  'yoursupersecure',
  'yoursupersecret',
  'replacewith',
  'changeme',
  'placeholder'
];
const REPEATED_GENERIC_SECRET = /^(?:secret|password|example|default|changeme)+$/;

class EnvironmentConfigurationError extends Error {
  constructor(issues) {
    super(`Invalid environment configuration: ${issues.join('; ')}`);
    this.name = 'EnvironmentConfigurationError';
    this.code = 'INVALID_ENVIRONMENT';
    this.issues = issues;
  }
}

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

const normalizePlaceholder = (value) => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');

const isKnownSecretPlaceholder = (value) => {
  const normalized = normalizePlaceholder(value);
  return EXACT_SECRET_PLACEHOLDERS.has(normalized)
    || REPEATED_GENERIC_SECRET.test(normalized)
    || SECRET_PLACEHOLDER_FRAGMENTS.some((fragment) => normalized.includes(fragment));
};

const validateEnvironment = (environment = process.env, options = {}) => {
  const issues = [];
  const warnings = [];
  const warn = options.warn || console.warn;

  const nodeEnvironment = environment.NODE_ENV;
  if (!hasText(nodeEnvironment)) {
    issues.push('NODE_ENV is required');
  } else if (!ALLOWED_NODE_ENVIRONMENTS.has(nodeEnvironment.trim())) {
    issues.push('NODE_ENV must be development, test, or production');
  }

  const corsConfiguration = parseCorsAllowedOrigins(environment.CORS_ALLOWED_ORIGINS, {
    required: typeof nodeEnvironment === 'string' && nodeEnvironment.trim() === 'production'
  });
  issues.push(...corsConfiguration.issues);

  if (environment.PORT !== undefined) {
    const portText = typeof environment.PORT === 'string' ? environment.PORT.trim() : '';
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
      issues.push('PORT must be an integer between 1 and 65535');
    }
  }

  if (!hasText(environment.MONGODB_URI)) {
    issues.push('MONGODB_URI is required');
  } else if (!/^mongodb(?:\+srv)?:\/\//i.test(environment.MONGODB_URI.trim())) {
    issues.push('MONGODB_URI must use the mongodb or mongodb+srv scheme');
  }

  if (!hasText(environment.JWT_SECRET)) {
    issues.push('JWT_SECRET is required');
  } else {
    const jwtSecret = environment.JWT_SECRET.trim();
    if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
      issues.push(`JWT_SECRET must contain at least ${MIN_JWT_SECRET_LENGTH} characters`);
    }
    if (isKnownSecretPlaceholder(jwtSecret)) {
      issues.push('JWT_SECRET must not use a documented placeholder or default value');
    }
  }

  const webhookUrlConfigured = hasText(environment.NODE_RED_WEBHOOK_URL);
  const webhookSecretConfigured = hasText(environment.NODE_RED_WEBHOOK_SECRET);

  if (webhookUrlConfigured && !webhookSecretConfigured) {
    issues.push('NODE_RED_WEBHOOK_SECRET is required when NODE_RED_WEBHOOK_URL is configured');
  }

  if (webhookUrlConfigured && webhookSecretConfigured) {
    const webhookSecret = environment.NODE_RED_WEBHOOK_SECRET.trim();
    if (webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
      issues.push(`NODE_RED_WEBHOOK_SECRET must contain at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`);
    }
    if (isKnownSecretPlaceholder(webhookSecret)) {
      issues.push('NODE_RED_WEBHOOK_SECRET must not use a documented placeholder or default value');
    }
  }

  if (!webhookUrlConfigured && webhookSecretConfigured) {
    warnings.push(
      'NODE_RED_WEBHOOK_SECRET is configured without NODE_RED_WEBHOOK_URL; the integration remains disabled'
    );
  }

  const mlEnabledText = environment.ML_ENABLED === undefined
    ? 'false'
    : String(environment.ML_ENABLED).trim().toLowerCase();
  if (!['true', 'false'].includes(mlEnabledText)) {
    issues.push('ML_ENABLED must be true or false');
  }
  const mlEnabled = mlEnabledText === 'true';
  if (mlEnabled) {
    if (!hasText(environment.ML_SERVICE_URL)) {
      issues.push('ML_SERVICE_URL is required when ML_ENABLED is true');
    } else {
      try {
        const url = new URL(environment.ML_SERVICE_URL.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          issues.push('ML_SERVICE_URL must be an HTTP(S) URL without credentials, query, or fragment');
        }
      } catch {
        issues.push('ML_SERVICE_URL must be a valid HTTP(S) URL');
      }
    }
    if (!hasText(environment.ML_SERVICE_SECRET)) {
      issues.push('ML_SERVICE_SECRET is required when ML_ENABLED is true');
    } else {
      const mlSecret = environment.ML_SERVICE_SECRET.trim();
      if (mlSecret !== environment.ML_SERVICE_SECRET) {
        issues.push('ML_SERVICE_SECRET must not contain surrounding whitespace');
      }
      if (mlSecret.length < MIN_ML_SECRET_LENGTH) {
        issues.push(`ML_SERVICE_SECRET must contain at least ${MIN_ML_SECRET_LENGTH} characters`);
      }
      if (isKnownSecretPlaceholder(mlSecret)) {
        issues.push('ML_SERVICE_SECRET must not use a documented placeholder or default value');
      }
      if (hasText(environment.JWT_SECRET) && mlSecret === environment.JWT_SECRET.trim()) {
        issues.push('ML_SERVICE_SECRET must differ from JWT_SECRET');
      }
      if (hasText(environment.NODE_RED_WEBHOOK_SECRET)
        && mlSecret === environment.NODE_RED_WEBHOOK_SECRET.trim()) {
        issues.push('ML_SERVICE_SECRET must differ from NODE_RED_WEBHOOK_SECRET');
      }
    }
  }

  const agentEnabledText = environment.AGENT_ENABLED === undefined
    ? 'false' : String(environment.AGENT_ENABLED).trim().toLowerCase();
  if (!['true', 'false'].includes(agentEnabledText)) issues.push('AGENT_ENABLED must be true or false');
  const agentEnabled = agentEnabledText === 'true';
  const geminiModel = environment.GEMINI_MODEL === undefined || !hasText(environment.GEMINI_MODEL)
    ? DEFAULT_GEMINI_MODEL : environment.GEMINI_MODEL.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(geminiModel)) issues.push('GEMINI_MODEL must be a valid model identifier');
  try { require('../agents/providers/failover').parseFallbackModels(environment.GEMINI_FALLBACK_MODELS, geminiModel); }
  catch { issues.push('GEMINI_FALLBACK_MODELS must contain at most two valid model identifiers'); }
  const geminiTimeoutText = environment.GEMINI_TIMEOUT_MS === undefined
    ? String(DEFAULT_GEMINI_TIMEOUT_MS) : String(environment.GEMINI_TIMEOUT_MS).trim();
  const geminiTimeoutMs = Number(geminiTimeoutText);
  if (!/^\d+$/.test(geminiTimeoutText) || !Number.isSafeInteger(geminiTimeoutMs)
    || geminiTimeoutMs < 1000 || geminiTimeoutMs > 20000) {
    issues.push('GEMINI_TIMEOUT_MS must be an integer between 1000 and 20000');
  }
  if (agentEnabled && !hasText(environment.GEMINI_API_KEY)) {
    issues.push('GEMINI_API_KEY is required when AGENT_ENABLED is true');
  }

  if (issues.length > 0) {
    throw new EnvironmentConfigurationError(issues);
  }

  warnings.forEach((warning) => warn(`[config] ${warning}`));

  return Object.freeze({
    nodeEnvironment: nodeEnvironment.trim(),
    port: environment.PORT === undefined ? 5000 : Number(environment.PORT.trim()),
    webhookEnabled: webhookUrlConfigured,
    mlEnabled,
    agentEnabled,
    geminiModel,
    geminiTimeoutMs,
    corsAllowedOrigins: Object.freeze([...corsConfiguration.origins])
  });
};

module.exports = {
  ALLOWED_NODE_ENVIRONMENTS,
  MIN_JWT_SECRET_LENGTH,
  MIN_WEBHOOK_SECRET_LENGTH,
  MIN_ML_SECRET_LENGTH,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  EnvironmentConfigurationError,
  isKnownSecretPlaceholder,
  validateEnvironment
};
