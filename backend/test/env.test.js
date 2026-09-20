const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const { validateEnvironment } = require('../src/config/env');

const strongSecret = () => randomBytes(32).toString('hex');

const validEnvironment = (overrides = {}) => ({
  NODE_ENV: 'test',
  PORT: '5000',
  MONGODB_URI: 'mongodb://localhost:27017/inventory_billing_test',
  JWT_SECRET: strongSecret(),
  ...overrides
});

const assertConfigurationError = (environment, expectedIssue) => {
  assert.throws(
    () => validateEnvironment(environment, { warn: () => {} }),
    (error) => error.code === 'INVALID_ENVIRONMENT'
      && error.issues.some((issue) => issue.includes(expectedIssue))
  );
};

test('environment validation rejects a missing JWT_SECRET', () => {
  const environment = validEnvironment();
  delete environment.JWT_SECRET;

  assertConfigurationError(environment, 'JWT_SECRET is required');
});

test('environment validation rejects an empty or whitespace-only JWT_SECRET', () => {
  for (const value of ['', '   ']) {
    assertConfigurationError(validEnvironment({ JWT_SECRET: value }), 'JWT_SECRET is required');
  }
});

test('environment validation rejects a JWT_SECRET shorter than 32 characters', () => {
  assertConfigurationError(
    validEnvironment({ JWT_SECRET: 'short-but-not-a-placeholder' }),
    'at least 32 characters'
  );
});

test('environment validation rejects known JWT_SECRET placeholders', () => {
  const placeholders = [
    'your_super_secure_jwt_secret_key_for_docker_deployment_at_least_32_chars',
    'your_super_secret_jwt_key_here_replace_with_secure_random_string',
    'change-me-change-me-change-me-change-me',
    'password-password-password-password'
  ];

  for (const value of placeholders) {
    assertConfigurationError(validEnvironment({ JWT_SECRET: value }), 'placeholder');
  }
});

test('environment validation accepts a strong JWT_SECRET', () => {
  const result = validateEnvironment(validEnvironment(), { warn: () => {} });

  assert.equal(result.nodeEnvironment, 'test');
  assert.equal(result.port, 5000);
  assert.equal(result.webhookEnabled, false);
});

test('environment validation rejects NODE_RED_WEBHOOK_URL without a secret', () => {
  assertConfigurationError(
    validEnvironment({ NODE_RED_WEBHOOK_URL: 'https://automation.example.test/webhook' }),
    'NODE_RED_WEBHOOK_SECRET is required'
  );
});

test('environment validation accepts a Node-RED URL with its secret', () => {
  const environment = validEnvironment({
    NODE_RED_WEBHOOK_URL: 'https://automation.example.test/webhook',
    NODE_RED_WEBHOOK_SECRET: 'configured-outside-the-repository'
  });

  const result = validateEnvironment(environment, { warn: () => {} });

  assert.equal(result.webhookEnabled, true);
});

test('environment validation warns when a webhook secret has no URL', () => {
  const warnings = [];

  const result = validateEnvironment(
    validEnvironment({ NODE_RED_WEBHOOK_SECRET: 'unused-secret' }),
    { warn: (warning) => warnings.push(warning) }
  );

  assert.equal(result.webhookEnabled, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /integration remains disabled/);
});

test('environment validation rejects invalid NODE_ENV, PORT and MONGODB_URI values', () => {
  assertConfigurationError(validEnvironment({ NODE_ENV: 'staging' }), 'NODE_ENV');
  assertConfigurationError(validEnvironment({ PORT: '5000abc' }), 'PORT');
  assertConfigurationError(validEnvironment({ PORT: '70000' }), 'PORT');
  assertConfigurationError(validEnvironment({ MONGODB_URI: '' }), 'MONGODB_URI is required');
  assertConfigurationError(validEnvironment({ MONGODB_URI: 'https://example.test' }), 'mongodb');
});
