const { Product } = require('../models');
const { escapeSearch, listPagination } = require('../utils/listPagination');
// Statistics cover the full filter; only the visible product rows are paged.
module.exports = async (req, getRate, reportingCurrency) => {
  const filter = { businessId: req.businessId, isActive: true };
  if (req.query.category) filter.category = { $regex: escapeSearch(req.query.category), $options: 'i' };
  if (req.query.search) filter.$or = ['name', 'sku', 'description'].map(field => ({ [field]: { $regex: escapeSearch(req.query.search), $options: 'i' } }));
  if (req.query.lowStock === 'true') filter.$expr = { $lte: ['$stock', '$minStockLevel'] };
  const { skip, ...pagination } = await listPagination(Product, filter, req.query);
  const sortBy = ['name', 'sku', 'category', 'stock', 'price'].includes(req.query.sortBy) ? req.query.sortBy : 'name';
  const direction = req.query.sortOrder === 'desc' ? -1 : 1;
  const [products, groups] = await Promise.all([
    Product.find(filter).sort({ [sortBy]: direction, _id: direction }).skip(skip).limit(pagination.limit),
    Product.aggregate([{ $match: filter }, { $group: {
      _id: { category: '$category', currency: { $cond: [{ $in: ['$currency', ['PEN', 'USD', 'EUR']] }, '$currency', 'USD'] } },
      count: { $sum: 1 }, totalStock: { $sum: '$stock' }, value: { $sum: { $multiply: ['$stock', '$price'] } },
      low: { $sum: { $cond: [{ $lte: ['$stock', '$minStockLevel'] }, 1, 0] } },
      out: { $sum: { $cond: [{ $eq: ['$stock', 0] }, 1, 0] } }
    } }])
  ]);
  const rates = {};
  for (const currency of new Set(groups.map(row => row._id.currency))) rates[currency] = await getRate(currency);
  const categoryBreakdown = {};
  let totalValue = 0, lowStockCount = 0, outOfStockCount = 0;
  for (const row of groups) {
    const value = row.value * rates[row._id.currency], key = row._id.category;
    const category = categoryBreakdown[key] || { count: 0, totalStock: 0, totalValue: 0 };
    category.count += row.count; category.totalStock += row.totalStock; category.totalValue += value;
    categoryBreakdown[key] = category; totalValue += value; lowStockCount += row.low; outOfStockCount += row.out;
  }
  return { products, pagination, statistics: { totalProducts: pagination.total, totalValue, lowStockCount,
    outOfStockCount, categories: Object.keys(categoryBreakdown).length, currency: reportingCurrency },
    lowStockProducts: [], outOfStockProducts: [], categoryBreakdown };
};
