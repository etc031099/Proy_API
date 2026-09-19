const MAX_SAFE_NUMERIC_VALUE = Number.MAX_SAFE_INTEGER;

const createNumericError = (field, message) => {
  const error = new Error(`${field} ${message}`);
  error.statusCode = 400;
  error.code = 'INVALID_NUMBER';
  return error;
};

const toFiniteNumber = (value, {
  field = 'Value',
  min = -MAX_SAFE_NUMERIC_VALUE,
  max = MAX_SAFE_NUMERIC_VALUE,
  integer = false,
  nullable = false
} = {}) => {
  if (value === null && nullable) return null;

  if (typeof value !== 'string' && typeof value !== 'number') {
    throw createNumericError(field, 'must be a number');
  }

  if (typeof value === 'string' && value.trim() === '') {
    throw createNumericError(field, 'must be a number');
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    throw createNumericError(field, 'must be a finite number');
  }

  if (integer && !Number.isSafeInteger(numericValue)) {
    throw createNumericError(field, 'must be a safe integer');
  }

  if (numericValue < min || numericValue > max) {
    throw createNumericError(field, `must be between ${min} and ${max}`);
  }

  return numericValue;
};

module.exports = {
  MAX_SAFE_NUMERIC_VALUE,
  toFiniteNumber
};
