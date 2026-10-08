const { fail } = require('./contracts');
const evaluateCondition = (condition, result) => {
  if (condition !== 'has_low_stock') fail('ACTION_NOT_ALLOWED');
  return Array.isArray(result?.data) && result.data.length > 0;
};
module.exports = { evaluateCondition };
