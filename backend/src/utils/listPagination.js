const escapeSearch = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const listPagination = async (model, filter, query, defaultLimit = 20) => {
  const requested = Number(query.page ?? 1), limit = Number(query.limit ?? defaultLimit);
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 10000
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    const error = new Error('Invalid pagination'); error.statusCode = 400; throw error;
  }
  const total = await model.countDocuments(filter), pages = Math.ceil(total / limit);
  const current = pages ? Math.min(requested, pages) : 1;
  return { current, limit, total, pages, skip: (current - 1) * limit };
};
module.exports = { escapeSearch, listPagination };
