const mongoose = require('mongoose');
const { Product, Transaction, Contact } = require('../models');
const { asyncHandler } = require('../middleware/validation');
const { getExchangeRate } = require('../services/externalApiService');
const { toFiniteNumber } = require('../utils/numbers');

const REPORTING_CURRENCY = 'PEN';
const RECENT_REPORT_TRANSACTION_LIMIT = 10;
const REPORT_GROUP_FORMATS = {
  hour: '%Y-%m-%d %H:00',
  day: '%Y-%m-%d',
  week: '%G-W%V',
  month: '%Y-%m',
  year: '%Y'
};

const getBaseAmount = (transaction) => {
  const originalAmount = Number(transaction.originalAmount);
  if (Number.isFinite(originalAmount) && originalAmount > 0) return originalAmount;
  const totalAmount = Number(transaction.totalAmount) || 0;
  const exchangeRate = Number(transaction.exchangeRate);
  return transaction.currency !== 'USD' && exchangeRate > 0
    ? totalAmount / exchangeRate
    : totalAmount;
};

const getReportingAmount = (transaction, usdToReportingRate) =>
  getBaseAmount(transaction) * usdToReportingRate;

const reportingAmountExpression = (usdToReportingRate) => ({
  $multiply: [
    {
      $cond: [
        { $gt: ['$originalAmount', 0] },
        '$originalAmount',
        {
          $cond: [
            {
              $and: [
                { $ne: ['$currency', 'USD'] },
                { $gt: ['$exchangeRate', 0] }
              ]
            },
            { $divide: ['$totalAmount', '$exchangeRate'] },
            '$totalAmount'
          ]
        }
      ]
    },
    usdToReportingRate
  ]
});

const invalidRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

const parseOptionalDate = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalidRequest(`${label} must be a valid date`);
  return date;
};

const applyDateRange = (filter, query) => {
  const start = parseOptionalDate(query.startDate ?? query.from, 'startDate/from');
  const end = parseOptionalDate(query.endDate ?? query.to, 'endDate/to');
  if (start && end && start > end) {
    throw invalidRequest('The report start date cannot be after the end date');
  }
  if (start || end) {
    filter.date = {};
    if (start) filter.date.$gte = start;
    if (end) filter.date.$lte = end;
  }
  return { start, end };
};

const emptyFinancialStats = () => ({ sales: 0, purchases: 0, transactionCount: 0 });

const financialStatsFromAggregation = (rows = []) => {
  const result = emptyFinancialStats();
  rows.forEach((row) => {
    if (row._id === 'sale') result.sales = row.amount;
    if (row._id === 'purchase') result.purchases = row.amount;
    result.transactionCount += row.count;
  });
  return { ...result, profit: result.sales - result.purchases };
};

/**
 * @desc    Get inventory report
 * @route   GET /api/reports/inventory
 * @access  Private
 */
const getInventoryReport = asyncHandler(async (req, res) => {
  const { category, lowStock, sortBy = 'name', sortOrder = 'asc' } = req.query;
  const businessId = req.businessId;

  // Build filter
  const filter = { businessId, isActive: true };
  if (category) {
    filter.category = { $regex: category, $options: 'i' };
  }

  // Build sort object
  const sort = {};
  sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

  let products = await Product.find(filter).sort(sort);

  // Filter for low stock if requested
  if (lowStock === 'true') {
    products = products.filter(product => product.stock <= product.minStockLevel);
  }

  // Calculate inventory statistics
  const totalProducts = products.length;
  const productRates = {};
  for (const product of products) {
    const currency = ['PEN', 'USD', 'EUR'].includes(product.currency) ? product.currency : 'USD';
    if (!productRates[currency]) {
      const response = await getExchangeRate({ base: currency, target: REPORTING_CURRENCY });
      productRates[currency] = toFiniteNumber(response?.rate, {
        field: 'Inventory exchange rate',
        min: Number.EPSILON
      });
    }
  }
  const totalValue = products.reduce((sum, product) => {
    const currency = ['PEN', 'USD', 'EUR'].includes(product.currency) ? product.currency : 'USD';
    return sum + (product.stock * product.price * productRates[currency]);
  }, 0);
  const lowStockProducts = products.filter(product => product.stock <= product.minStockLevel);
  const outOfStockProducts = products.filter(product => product.stock === 0);

  // Category breakdown
  const categoryBreakdown = products.reduce((acc, product) => {
    if (!acc[product.category]) {
      acc[product.category] = {
        count: 0,
        totalStock: 0,
        totalValue: 0
      };
    }
    acc[product.category].count++;
    acc[product.category].totalStock += product.stock;
    const currency = ['PEN', 'USD', 'EUR'].includes(product.currency) ? product.currency : 'USD';
    acc[product.category].totalValue += (product.stock * product.price * productRates[currency]);
    return acc;
  }, {});

  res.json({
    success: true,
    data: {
      products,
      statistics: {
        totalProducts,
        totalValue,
        currency: REPORTING_CURRENCY,
        lowStockCount: lowStockProducts.length,
        outOfStockCount: outOfStockProducts.length,
        categories: Object.keys(categoryBreakdown).length
      },
      lowStockProducts,
      outOfStockProducts,
      categoryBreakdown
    }
  });
});

/**
 * @desc    Get transaction report
 * @route   GET /api/reports/transactions
 * @access  Private
 */
const getTransactionReport = asyncHandler(async (req, res) => {
  const { type, groupBy = 'day', contactId } = req.query;
  const businessId = req.businessId;

  if (!Object.prototype.hasOwnProperty.call(REPORT_GROUP_FORMATS, groupBy)) {
    throw invalidRequest('groupBy must be one of: hour, day, week, month, year');
  }

  // Build filter
  const filter = { businessId, status: 'completed' };
  const range = applyDateRange(filter, req.query);

  if (type && ['sale', 'purchase'].includes(type)) {
    filter.type = type;
  } else if (type) {
    throw invalidRequest('type must be sale or purchase');
  }

  if (contactId) {
    if (!mongoose.isObjectIdOrHexString(contactId)) {
      throw invalidRequest('contactId must be a valid ObjectId');
    }
    const contactObjectId = new mongoose.Types.ObjectId(contactId);
    filter.$or = [
      { customerId: contactObjectId },
      { vendorId: contactObjectId }
    ];
  }

  const rateResponse = await getExchangeRate({ base: 'USD', target: REPORTING_CURRENCY });
  const usdToReportingRate = toFiniteNumber(rateResponse?.rate, {
    field: 'Reporting exchange rate',
    min: Number.EPSILON
  });

  const [aggregationRows, recentTransactions] = await Promise.all([
    Transaction.aggregate([
      { $match: filter },
      { $set: { reportingAmount: reportingAmountExpression(usdToReportingRate) } },
      {
        $facet: {
          summary: [{
            $group: {
              _id: '$type',
              amount: { $sum: '$reportingAmount' },
              count: { $sum: 1 },
              average: { $avg: '$reportingAmount' }
            }
          }],
          groupedData: [
            {
              $group: {
                _id: {
                  period: {
                    $dateToString: {
                      format: REPORT_GROUP_FORMATS[groupBy],
                      date: '$date',
                      timezone: 'UTC'
                    }
                  },
                  type: '$type'
                },
                amount: { $sum: '$reportingAmount' },
                count: { $sum: 1 }
              }
            },
            { $sort: { '_id.period': 1 } }
          ]
        }
      }
    ]),
    Transaction.find(filter)
      .select('type customerId customerName vendorId vendorName totalAmount currency date paymentMethod status')
      .populate('customerId', 'name')
      .populate('vendorId', 'name')
      .sort({ date: -1 })
      .limit(RECENT_REPORT_TRANSACTION_LIMIT)
      .lean()
  ]);
  const aggregation = aggregationRows[0] || { summary: [], groupedData: [] };

  const byType = Object.fromEntries(aggregation.summary.map(row => [row._id, row]));
  const groupedByPeriod = {};
  aggregation.groupedData.forEach((row) => {
    const period = row._id.period;
    groupedByPeriod[period] ||= {
      period,
      sales: { count: 0, amount: 0 },
      purchases: { count: 0, amount: 0 }
    };
    groupedByPeriod[period][row._id.type === 'sale' ? 'sales' : 'purchases'] = {
      count: row.count,
      amount: row.amount
    };
  });

  const sales = byType.sale || { amount: 0, count: 0, average: 0 };
  const purchases = byType.purchase || { amount: 0, count: 0, average: 0 };

  res.json({
    success: true,
    data: {
      recentTransactions,
      groupedData: Object.values(groupedByPeriod),
      range: {
        from: range.start?.toISOString() || null,
        to: range.end?.toISOString() || null,
        groupBy
      },
      summary: {
        totalSales: sales.amount,
        totalPurchases: purchases.amount,
        profit: sales.amount - purchases.amount,
        salesCount: sales.count,
        purchasesCount: purchases.count,
        totalTransactions: sales.count + purchases.count,
        averageSaleAmount: sales.average,
        averagePurchaseAmount: purchases.average,
        currency: REPORTING_CURRENCY
      }
    }
  });
});

/**
 * @desc    Get customer report
 * @route   GET /api/reports/customer/:id
 * @access  Private
 */
const getCustomerReport = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { startDate, endDate } = req.query;
  const businessId = req.businessId;

  // Get customer
  const customer = await Contact.findOne({
    _id: id,
    businessId,
    type: 'customer',
    isActive: true
  });

  if (!customer) {
    return res.status(404).json({
      success: false,
      message: 'Customer not found'
    });
  }

  // Build transaction filter
  const filter = {
    businessId,
    status: 'completed',
    customerId: id,
    type: 'sale'
  };

  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) filter.date.$lte = new Date(endDate);
  }

  // Get customer transactions
  const transactions = await Transaction.find(filter)
    .populate('products.productId', 'name category')
    .sort({ date: -1 });

  // Calculate statistics
  const totalPurchases = transactions.reduce((sum, t) => sum + getBaseAmount(t), 0);
  const totalTransactions = transactions.length;
  const averagePurchaseAmount = totalTransactions > 0 ? totalPurchases / totalTransactions : 0;

  // Product preferences (most purchased products)
  const productStats = {};
  transactions.forEach(transaction => {
    transaction.products.forEach(item => {
      const productId = item.productId._id.toString();
      if (!productStats[productId]) {
        productStats[productId] = {
          product: item.productId,
          totalQuantity: 0,
          totalAmount: 0,
          transactionCount: 0
        };
      }
      productStats[productId].totalQuantity += item.quantity;
      productStats[productId].totalAmount += item.total;
      productStats[productId].transactionCount++;
    });
  });

  const topProducts = Object.values(productStats)
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, 10);

  // Monthly breakdown
  const monthlyData = transactions.reduce((acc, transaction) => {
    const month = transaction.date.toISOString().substring(0, 7); // YYYY-MM
    if (!acc[month]) {
      acc[month] = { month, count: 0, amount: 0 };
    }
    acc[month].count++;
    acc[month].amount += getBaseAmount(transaction);
    return acc;
  }, {});

  res.json({
    success: true,
    data: {
      customer,
      transactions,
      statistics: {
        totalPurchases,
        totalTransactions,
        averagePurchaseAmount,
        currentBalance: customer.currentBalance,
        creditLimit: customer.creditLimit
      },
      topProducts,
      monthlyBreakdown: Object.values(monthlyData).sort((a, b) => a.month.localeCompare(b.month))
    }
  });
});

/**
 * @desc    Get vendor report
 * @route   GET /api/reports/vendor/:id
 * @access  Private
 */
const getVendorReport = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { startDate, endDate } = req.query;
  const businessId = req.businessId;

  // Get vendor
  const vendor = await Contact.findOne({
    _id: id,
    businessId,
    type: 'vendor',
    isActive: true
  });

  if (!vendor) {
    return res.status(404).json({
      success: false,
      message: 'Vendor not found'
    });
  }

  // Build transaction filter
  const filter = {
    businessId,
    status: 'completed',
    vendorId: id,
    type: 'purchase'
  };

  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) filter.date.$lte = new Date(endDate);
  }

  // Get vendor transactions
  const transactions = await Transaction.find(filter)
    .populate('products.productId', 'name category')
    .sort({ date: -1 });

  // Calculate statistics
  const totalPurchases = transactions.reduce((sum, t) => sum + getBaseAmount(t), 0);
  const totalTransactions = transactions.length;
  const averagePurchaseAmount = totalTransactions > 0 ? totalPurchases / totalTransactions : 0;

  // Product analysis
  const productStats = {};
  transactions.forEach(transaction => {
    transaction.products.forEach(item => {
      const productId = item.productId._id.toString();
      if (!productStats[productId]) {
        productStats[productId] = {
          product: item.productId,
          totalQuantity: 0,
          totalAmount: 0,
          transactionCount: 0
        };
      }
      productStats[productId].totalQuantity += item.quantity;
      productStats[productId].totalAmount += item.total;
      productStats[productId].transactionCount++;
    });
  });

  const topProducts = Object.values(productStats)
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, 10);

  res.json({
    success: true,
    data: {
      vendor,
      transactions,
      statistics: {
        totalPurchases,
        totalTransactions,
        averagePurchaseAmount,
        currentBalance: vendor.currentBalance
      },
      topProducts
    }
  });
});

/**
 * @desc    Get business dashboard summary
 * @route   GET /api/reports/dashboard
 * @access  Private
 */
const getDashboardSummary = asyncHandler(async (req, res) => {
  const businessId = req.businessId;
  const today = new Date();
  const periodMode = req.query.period || 'current';
  if (!['current', 'latest'].includes(periodMode)) {
    throw invalidRequest('period must be current or latest');
  }

  const latestTransaction = periodMode === 'latest'
    ? await Transaction.findOne({ businessId, status: 'completed' })
      .select('date')
      .sort({ date: -1 })
      .lean()
    : null;
  const anchor = latestTransaction?.date || today;
  const startOfMonth = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const endOfMonth = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  const startOfYear = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
  const endOfYear = new Date(Date.UTC(anchor.getUTCFullYear() + 1, 0, 1));

  // Get counts
  const [
    totalProducts,
    totalCustomers,
    totalVendors,
    lowStockProducts
  ] = await Promise.all([
    Product.countDocuments({ businessId, isActive: true }),
    Contact.countDocuments({ businessId, type: 'customer', isActive: true }),
    Contact.countDocuments({ businessId, type: 'vendor', isActive: true }),
    Product.findLowStock(businessId)
  ]);

  const rateResponse = await getExchangeRate({ base: 'USD', target: REPORTING_CURRENCY });
  const usdToReportingRate = toFiniteNumber(rateResponse?.rate, {
    field: 'Reporting exchange rate',
    min: Number.EPSILON
  });

  const [aggregated = { monthly: [], yearly: [] }] = await Transaction.aggregate([
    {
      $match: {
        businessId,
        status: 'completed',
        date: { $gte: startOfYear, $lt: endOfYear }
      }
    },
    { $set: { reportingAmount: reportingAmountExpression(usdToReportingRate) } },
    {
      $facet: {
        monthly: [
          { $match: { date: { $gte: startOfMonth, $lt: endOfMonth } } },
          { $group: { _id: '$type', amount: { $sum: '$reportingAmount' }, count: { $sum: 1 } } }
        ],
        yearly: [
          { $group: { _id: '$type', amount: { $sum: '$reportingAmount' }, count: { $sum: 1 } } }
        ]
      }
    }
  ]);
  const monthly = financialStatsFromAggregation(aggregated.monthly);
  const yearly = financialStatsFromAggregation(aggregated.yearly);

  // Recent transactions
  const recentTransactions = await Transaction.find({ businessId, status: 'completed' })
    .populate('customerId', 'name')
    .populate('vendorId', 'name')
    .sort({ date: -1 })
    .limit(5);

  res.json({
    success: true,
    data: {
      baseCurrency: REPORTING_CURRENCY,
      period: {
        mode: periodMode,
        hasData: monthly.transactionCount > 0 || yearly.transactionCount > 0,
        monthFrom: startOfMonth.toISOString(),
        monthTo: endOfMonth.toISOString(),
        yearFrom: startOfYear.toISOString(),
        yearTo: endOfYear.toISOString()
      },
      overview: {
        totalProducts,
        totalCustomers,
        totalVendors,
        lowStockProductsCount: lowStockProducts.length
      },
      monthly,
      yearly,
      lowStockProducts: lowStockProducts.slice(0, 10),
      recentTransactions
    }
  });
});

module.exports = {
  getInventoryReport,
  getTransactionReport,
  getCustomerReport,
  getVendorReport,
  getDashboardSummary
};
