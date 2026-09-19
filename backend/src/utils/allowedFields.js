const createFieldError = (field) => {
  const error = new Error(`Field "${field}" is not allowed`);
  error.statusCode = 400;
  error.code = 'FIELD_NOT_ALLOWED';
  error.field = field;
  return error;
};

const assertNoMongoOperators = (value, path = '') => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoMongoOperators(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, nestedValue] of Object.entries(value)) {
    const field = path ? `${path}.${key}` : key;
    if (key.startsWith('$')) throw createFieldError(field);
    assertNoMongoOperators(nestedValue, field);
  }
};

const assertAllowedFields = (source, allowedFields, path = '') => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    const error = new Error(`${path || 'Request body'} must be an object`);
    error.statusCode = 400;
    error.code = 'INVALID_BODY';
    throw error;
  }

  assertNoMongoOperators(source, path);
  const allowed = new Set(allowedFields);
  const rejected = Object.keys(source).find(field => !allowed.has(field));
  if (rejected) throw createFieldError(path ? `${path}.${rejected}` : rejected);
};

const pickAllowedFields = (source, allowedFields) => {
  assertAllowedFields(source, allowedFields);
  return Object.fromEntries(
    allowedFields
      .filter(field => Object.prototype.hasOwnProperty.call(source, field))
      .map(field => [field, source[field]])
  );
};

module.exports = {
  assertAllowedFields,
  pickAllowedFields
};
