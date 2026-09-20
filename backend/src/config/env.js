const ALLOWED_NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);
const MIN_JWT_SECRET_LENGTH = 32;

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

  if (!webhookUrlConfigured && webhookSecretConfigured) {
    warnings.push(
      'NODE_RED_WEBHOOK_SECRET is configured without NODE_RED_WEBHOOK_URL; the integration remains disabled'
    );
  }

  if (issues.length > 0) {
    throw new EnvironmentConfigurationError(issues);
  }

  warnings.forEach((warning) => warn(`[config] ${warning}`));

  return Object.freeze({
    nodeEnvironment: nodeEnvironment.trim(),
    port: environment.PORT === undefined ? 5000 : Number(environment.PORT.trim()),
    webhookEnabled: webhookUrlConfigured
  });
};

module.exports = {
  ALLOWED_NODE_ENVIRONMENTS,
  MIN_JWT_SECRET_LENGTH,
  EnvironmentConfigurationError,
  isKnownSecretPlaceholder,
  validateEnvironment
};
