const CORS_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const CORS_ALLOWED_HEADERS = Object.freeze(['Content-Type', 'Authorization']);

const validateCorsOrigin = (origin) => {
  if (origin.includes('*')) {
    return 'must not contain a wildcard';
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return 'must be an absolute URL origin';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'must use the http or https scheme';
  }
  if (parsed.username || parsed.password) {
    return 'must not contain embedded credentials';
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return 'must not contain a path, query, or fragment';
  }
  if (parsed.origin !== origin) {
    return 'must be written as an exact, canonical origin';
  }

  return null;
};

const parseCorsAllowedOrigins = (value, options = {}) => {
  const required = options.required === true;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      origins: [],
      issues: required ? ['CORS_ALLOWED_ORIGINS is required in production'] : []
    };
  }

  const entries = value.split(',').map((entry) => entry.trim());
  const issues = [];
  const origins = [];

  entries.forEach((entry, index) => {
    if (!entry) {
      issues.push(`CORS_ALLOWED_ORIGINS entry ${index + 1} must not be empty`);
      return;
    }

    const issue = validateCorsOrigin(entry);
    if (issue) {
      issues.push(`CORS_ALLOWED_ORIGINS entry ${index + 1} ${issue}`);
      return;
    }

    if (!origins.includes(entry)) origins.push(entry);
  });

  return { origins, issues };
};

const createCorsOptions = (allowedOrigins) => {
  const allowlist = new Set(allowedOrigins);

  return {
    origin(origin, callback) {
      if (origin === undefined || allowlist.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: false,
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    optionsSuccessStatus: 204
  };
};

module.exports = {
  CORS_ALLOWED_HEADERS,
  CORS_METHODS,
  createCorsOptions,
  parseCorsAllowedOrigins,
  validateCorsOrigin
};
