const {
  createDashboardIoMiddleware,
  createHttpNodeMiddleware,
  createWebhookSecurity
} = require('./webhook-security');

const MIN_SECRET_LENGTH = 32;
const ALLOWED_NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);

class NodeRedConfigurationError extends Error {
  constructor(issues) {
    super(`Invalid Node-RED configuration: ${issues.join('; ')}`);
    this.name = 'NodeRedConfigurationError';
    this.code = 'INVALID_NODE_RED_ENVIRONMENT';
    this.issues = issues;
  }
}

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

const readBoolean = (value, defaultValue, name) => {
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new NodeRedConfigurationError([`${name} must be true or false`]);
};

const addCredentialPairIssues = (issues, environment, usernameKey, passwordKey, required) => {
  const hasUsername = hasText(environment[usernameKey]);
  const hasPassword = hasText(environment[passwordKey]);

  if (required && !hasUsername) issues.push(`${usernameKey} is required`);
  if (required && !hasPassword) issues.push(`${passwordKey} is required`);
  if (hasUsername !== hasPassword) {
    issues.push(`${usernameKey} and ${passwordKey} must be configured together`);
  }
};

const validateSecret = (issues, value, name, required) => {
  if (!hasText(value)) {
    if (required) issues.push(`${name} is required`);
    return;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (value.trim().length < MIN_SECRET_LENGTH) {
    issues.push(`${name} must contain at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (
    normalized.includes('billingdemosecret')
    || normalized.includes('changeme')
    || normalized.includes('replacewith')
    || normalized.includes('placeholder')
  ) {
    issues.push(`${name} must not use a documented placeholder or default value`);
  }
};

const createSettings = (environment = process.env, dependencies = {}) => {
  const issues = [];
  if (!hasText(environment.NODE_ENV)) {
    issues.push('NODE_ENV is required');
  } else if (!ALLOWED_NODE_ENVIRONMENTS.has(environment.NODE_ENV.trim())) {
    issues.push('NODE_ENV must be development, test, or production');
  }

  const isProduction = environment.NODE_ENV === 'production';
  const editorEnabled = readBoolean(
    environment.NODE_RED_ENABLE_EDITOR,
    !isProduction,
    'NODE_RED_ENABLE_EDITOR'
  );

  validateSecret(
    issues,
    environment.NODE_RED_CREDENTIAL_SECRET,
    'NODE_RED_CREDENTIAL_SECRET',
    isProduction
  );
  validateSecret(
    issues,
    environment.NODE_RED_WEBHOOK_SECRET,
    'NODE_RED_WEBHOOK_SECRET',
    true
  );

  addCredentialPairIssues(
    issues,
    environment,
    'NODE_RED_USERNAME',
    'NODE_RED_PASSWORD',
    isProduction && editorEnabled
  );
  addCredentialPairIssues(
    issues,
    environment,
    'NODE_RED_HTTP_USERNAME',
    'NODE_RED_HTTP_PASSWORD',
    isProduction
  );

  if (hasText(environment.NODE_RED_PASSWORD) && environment.NODE_RED_PASSWORD.trim().length < 12) {
    issues.push('NODE_RED_PASSWORD must contain at least 12 characters');
  }
  if (hasText(environment.NODE_RED_HTTP_PASSWORD)
    && environment.NODE_RED_HTTP_PASSWORD.trim().length < 12) {
    issues.push('NODE_RED_HTTP_PASSWORD must contain at least 12 characters');
  }

  if (issues.length > 0) throw new NodeRedConfigurationError(issues);

  const webhookSecurity = createWebhookSecurity(environment.NODE_RED_WEBHOOK_SECRET.trim());
  const protectPrivateEndpoints = isProduction || hasText(environment.NODE_RED_HTTP_USERNAME);
  const privateHttpOptions = {
    username: environment.NODE_RED_HTTP_USERNAME?.trim(),
    password: environment.NODE_RED_HTTP_PASSWORD?.trim(),
    protectPrivateEndpoints
  };
  const privateHttpMiddleware = createHttpNodeMiddleware(privateHttpOptions);
  const settings = {
    uiPort: environment.PORT || 1880,
    uiHost: '0.0.0.0',
    flowFile: 'flows.json',
    functionExternalModules: false,
    externalModules: {
      autoInstall: false,
      // Runtime nodes baked into the image must remain loadable; only runtime installation is disabled.
      palette: { allowInstall: false, allowUpload: false },
      modules: { allowInstall: false, allowList: [], denyList: ['*'] }
    },
    functionGlobalContext: { webhookSecurity },
    httpAdminRoot: editorEnabled ? '/' : false,
    disableEditor: !editorEnabled,
    httpNodeMiddleware: privateHttpMiddleware,
    ui: {
      middleware: privateHttpMiddleware,
      ioMiddleware: createDashboardIoMiddleware(privateHttpOptions)
    },
    editorTheme: {
      projects: { enabled: false },
      tours: false
    },
    logging: {
      console: { level: 'info', metrics: false, audit: isProduction }
    }
  };

  if (hasText(environment.NODE_RED_CREDENTIAL_SECRET)) {
    settings.credentialSecret = environment.NODE_RED_CREDENTIAL_SECRET.trim();
  }

  const editorCredentialsConfigured = hasText(environment.NODE_RED_USERNAME);
  if (editorEnabled && editorCredentialsConfigured) {
    const loadBcrypt = dependencies.loadBcrypt || (() => require('bcryptjs'));
    let bcrypt;
    try {
      bcrypt = loadBcrypt();
    } catch {
      throw new NodeRedConfigurationError([
        'bcryptjs is required when editor authentication is enabled'
      ]);
    }

    settings.adminAuth = {
      type: 'credentials',
      users: [{
        username: environment.NODE_RED_USERNAME.trim(),
        password: bcrypt.hashSync(environment.NODE_RED_PASSWORD, 10),
        permissions: '*'
      }]
    };
  }

  return settings;
};

module.exports = {
  MIN_SECRET_LENGTH,
  NodeRedConfigurationError,
  createSettings
};
