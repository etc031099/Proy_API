const SKU_INDEX_NAME = 'businessId_1_sku_1';
const SKU_INDEX_KEY = { businessId: 1, sku: 1 };
const SKU_PARTIAL_FILTER = { sku: { $type: 'string', $gt: '' } };

const normalizeSku = (value) => {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return value;

  const normalized = value.trim();
  return normalized === '' ? null : normalized;
};

module.exports = {
  SKU_INDEX_NAME,
  SKU_INDEX_KEY,
  SKU_PARTIAL_FILTER,
  normalizeSku
};
