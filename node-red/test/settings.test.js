const test = require('node:test');
const assert = require('node:assert/strict');

const { createSettings } = require('../lib/settings-factory');

const productionEnvironment = (overrides = {}) => ({
  NODE_ENV: 'production',
  NODE_RED_CREDENTIAL_SECRET: 'credential-secret-generated-outside-repository',
  NODE_RED_WEBHOOK_SECRET: 'webhook-secret-shared-outside-repository',
  NODE_RED_HTTP_USERNAME: 'dashboard-user',
  NODE_RED_HTTP_PASSWORD: 'dashboard-password-strong',
  ...overrides
});

const assertConfigurationError = (environment, issue, dependencies) => {
  assert.throws(
    () => createSettings(environment, dependencies),
    (error) => error.code === 'INVALID_NODE_RED_ENVIRONMENT'
      && error.issues.some((entry) => entry.includes(issue))
  );
};

test('production rejects a missing credentialSecret', () => {
  const environment = productionEnvironment();
  delete environment.NODE_RED_CREDENTIAL_SECRET;
  assertConfigurationError(environment, 'NODE_RED_CREDENTIAL_SECRET is required');
});

test('startup fails closed when NODE_ENV is missing or unknown', () => {
  const missingEnvironment = productionEnvironment();
  delete missingEnvironment.NODE_ENV;
  assertConfigurationError(missingEnvironment, 'NODE_ENV is required');

  assertConfigurationError(
    productionEnvironment({ NODE_ENV: 'prodution' }),
    'NODE_ENV must be development, test, or production'
  );
});

test('development remains usable with an explicit environment and webhook secret', () => {
  const settings = createSettings({
    NODE_ENV: 'development',
    NODE_RED_WEBHOOK_SECRET: 'development-webhook-secret-at-least-32-chars'
  });

  assert.equal(settings.disableEditor, false);
  assert.equal(settings.httpAdminRoot, '/');
  assert.equal(settings.credentialSecret, undefined);
});

test('production rejects a missing webhook secret', () => {
  const environment = productionEnvironment();
  delete environment.NODE_RED_WEBHOOK_SECRET;
  assertConfigurationError(environment, 'NODE_RED_WEBHOOK_SECRET is required');
});

test('production rejects the former credentialSecret fallback', () => {
  assertConfigurationError(
    productionEnvironment({
      NODE_RED_CREDENTIAL_SECRET: 'billing-demo-secret-change-me-billing-demo-secret'
    }),
    'placeholder'
  );
});

test('production disables editor and admin endpoints by default', () => {
  const settings = createSettings(productionEnvironment());

  assert.equal(settings.disableEditor, true);
  assert.equal(settings.httpAdminRoot, false);
  assert.equal(settings.adminAuth, undefined);
});

test('production editor opt-in requires complete admin credentials', () => {
  assertConfigurationError(
    productionEnvironment({ NODE_RED_ENABLE_EDITOR: 'true' }),
    'NODE_RED_USERNAME is required'
  );
});

test('missing bcrypt fails closed when authenticated editor is enabled', () => {
  const environment = productionEnvironment({
    NODE_RED_ENABLE_EDITOR: 'true',
    NODE_RED_USERNAME: 'editor-user',
    NODE_RED_PASSWORD: 'editor-password-strong'
  });

  assertConfigurationError(
    environment,
    'bcryptjs is required',
    { loadBcrypt: () => { throw new Error('module unavailable'); } }
  );
});

test('authenticated editor stores a bcrypt hash rather than plaintext', () => {
  const environment = productionEnvironment({
    NODE_RED_ENABLE_EDITOR: 'true',
    NODE_RED_USERNAME: 'editor-user',
    NODE_RED_PASSWORD: 'editor-password-strong'
  });
  const settings = createSettings(environment, {
    loadBcrypt: () => ({ hashSync: () => '$2b$10$test-hash' })
  });

  assert.equal(settings.disableEditor, false);
  assert.equal(settings.httpAdminRoot, '/');
  assert.equal(settings.adminAuth.users[0].password, '$2b$10$test-hash');
  assert.notEqual(settings.adminAuth.users[0].password, environment.NODE_RED_PASSWORD);
});

test('production requires dashboard HTTP credentials', () => {
  const environment = productionEnvironment();
  delete environment.NODE_RED_HTTP_PASSWORD;
  assertConfigurationError(environment, 'NODE_RED_HTTP_PASSWORD is required');
});

test('dashboard HTTP and websocket surfaces receive authentication middleware', () => {
  const settings = createSettings(productionEnvironment());

  assert.equal(settings.ui.middleware, settings.httpNodeMiddleware);
  assert.equal(typeof settings.ui.ioMiddleware, 'function');
});

test('external Function modules and runtime installs are disabled', () => {
  const settings = createSettings(productionEnvironment());

  assert.equal(settings.functionExternalModules, false);
  assert.equal(settings.externalModules.autoInstall, false);
  assert.equal(settings.externalModules.palette.allowInstall, false);
  assert.equal(settings.externalModules.palette.allowUpload, false);
  assert.equal(settings.externalModules.palette.denyList, undefined);
  assert.deepEqual(settings.externalModules.modules.denyList, ['*']);
});

test('configuration errors never include secret values', () => {
  const leakedValue = 'billing-demo-secret-change-me-billing-demo-secret';
  assert.throws(
    () => createSettings(productionEnvironment({ NODE_RED_CREDENTIAL_SECRET: leakedValue })),
    (error) => !error.message.includes(leakedValue)
  );
});
