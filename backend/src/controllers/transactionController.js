const mongoose = require('mongoose');
const { Transaction, Product, Contact, CreditPayment } = require('../models');
const { asyncHandler } = require('../middleware/validation');
const { validatePaymentMethod, getExchangeRate } = require('../services/externalApiService');
const { notifyLowStock } = require('../services/telegramService');
const { emitEvent } = require('../services/webhookService');
const { toFiniteNumber } = require('../utils/numbers');
const { applyStockChange, normalizeDate } = require('../services/inventoryService');

const TRANSACTION_CURRENCIES = ['PEN', 'USD', 'EUR'];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const baseAmountExpression = {
  $cond: [
    { $gt: [{ $ifNull: ['$originalAmount', 0] }, 0] },
    '$originalAmount',
    {
      $cond: [
        { $and: [
          { $ne: ['$currency', 'USD'] },
          { $gt: [{ $ifNull: ['$exchangeRate', 0] }, 0] }
        ] },
        { $divide: ['$totalAmount', '$exchangeRate'] },
        '$totalAmount'
      ]
    }
  ]
};

/**
 * @desc    Get all transactions with filters
 * @route   GET /api/transactions
 * @access  Private
 */
const getTransactions = asyncHandler(async (req, res) => {
  const { 
    type, 
    startDate, 
    endDate, 
    contactId, 
    status, 
    search,
    page = 1, 
    limit = 10 
  } = req.query;
  const businessId = req.businessId;

  // Build filter object
  const filter = { businessId };

  if (type && ['sale', 'purchase'].includes(type.toLowerCase())) {
    filter.type = type.toLowerCase();
  }

  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) filter.date.$lte = new Date(endDate);
  }

  if (contactId) {
    filter.$and = [{ $or: [
      { customerId: contactId },
      { vendorId: contactId }
    ] }];
  }

  if (typeof search === 'string' && search.trim()) {
    const searchPattern = new RegExp(escapeRegex(search.trim()), 'i');
    const searchConditions = [
      { customerName: searchPattern },
      { vendorName: searchPattern },
      { 'products.productName': searchPattern }
    ];
    if (/^[0-9a-f]{1,24}$/i.test(search.trim())) {
      searchConditions.push({
        $expr: {
          $regexMatch: {
            input: { $toString: '$_id' },
            regex: escapeRegex(search.trim()),
            options: 'i'
          }
        }
      });
    }
    filter.$and = [...(filter.$and || []), { $or: searchConditions }];
  }

  if (status && ['pending', 'completed', 'cancelled'].includes(status)) {
    filter.status = status;
  }

  // Calculate pagination
  const requestedPage = Number(page);
  const limitNum = Number(limit);
  const total = await Transaction.countDocuments(filter);
  const pages = Math.ceil(total / limitNum);
  const pageNum = pages === 0 ? 1 : Math.min(requestedPage, pages);
  const skip = (pageNum - 1) * limitNum;

  // Get transactions with pagination and populate references
  const transactions = await Transaction.find(filter)
    .populate('customerId', 'name phone email')
    .populate('vendorId', 'name phone email')
    .populate('supplierId', 'name phone email')
    .populate('products.productId', 'name category sku')
    .sort({ date: -1 })
    .limit(limitNum)
    .skip(skip);

  res.json({
    success: true,
    data: {
      transactions,
      pagination: {
        current: pageNum,
        pages,
        total,
        limit: limitNum
      }
    }
  });
});

/**
 * @desc    Get single transaction
 * @route   GET /api/transactions/:id
 * @access  Private
 */
const getTransaction = asyncHandler(async (req, res) => {
  const transaction = await Transaction.findOne({
    _id: req.params.id,
    businessId: req.businessId
  })
    .populate('customerId', 'name phone email address')
    .populate('vendorId', 'name phone email address')
    .populate('supplierId', 'name phone email address')
    .populate('products.productId', 'name description category sku');

  if (!transaction) {
    return res.status(404).json({
      success: false,
      message: 'Transaction not found'
    });
  }

  res.json({
    success: true,
    data: { transaction }
  });
});

/**
 * @desc    Create new transaction (sale or purchase)
 * @route   POST /api/transactions
 * @access  Private
 */
const createTransaction = asyncHandler(async (req, res) => {
  const historical = req.historicalContext || null;
  let result;
  try { result = await require('../services/transactionWriteService')
    .writeTransaction({ input: req.body, businessId: req.businessId, historical }); }
  catch (error) {
    if (error.directResponse) return res.status(error.statusCode).json({ success: false, message: error.message });
    throw error;
  }
  const { transaction, transactionData, lowStockNotifications } = result;
  if (!historical) {
    for (const notification of lowStockNotifications) {
      Promise.resolve().then(() => notifyLowStock(req.businessId, notification.product, notification.previousStock))
        .catch(error => console.error('[Telegram] low-stock notification failed:', error.message));
    }
    emitEvent('transaction.created', {
      transactionId: transaction._id, businessId: req.businessId, type: transactionData.type,
      totalAmount: transactionData.totalAmount, currency: transactionData.currency,
      paymentMethod: transactionData.paymentMethod, customerName: transactionData.customerName || null,
      vendorName: transactionData.vendorName || null, itemCount: transactionData.products.length,
      items: transactionData.products.map(item => ({ name: item.productName, quantity: item.quantity, total: item.total }))
    });
  }
  const populatedTransaction = historical ? transaction : await Transaction.findById(transaction._id)
    .populate('customerId', 'name phone email').populate('vendorId', 'name phone email')
    .populate('supplierId', 'name phone email').populate('products.productId', 'name category');
  res.status(201).json({ success: true,
    message: `${transactionData.type === 'sale' ? 'Sale' : 'Purchase'} recorded successfully`,
    data: { transaction: populatedTransaction } });
});
/**
 * @desc    Get sales transactions
 * @route   GET /api/transactions/sales
 * @access  Private
 */
const getSales = asyncHandler(async (req, res) => {
  const { startDate, endDate, customerId, page = 1, limit = 10 } = req.query;
  const businessId = req.businessId;

  const filter = { businessId, type: 'sale' };

  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) filter.date.$lte = new Date(endDate);
  }

  if (customerId) {
    filter.customerId = customerId;
  }

  const pageNum = page;
  const limitNum = limit;
  const skip = (pageNum - 1) * limitNum;

  const sales = await Transaction.find(filter)
    .populate('customerId', 'name phone email')
    .sort({ date: -1 })
    .limit(limitNum)
    .skip(skip);

  const total = await Transaction.countDocuments(filter);

  res.json({
    success: true,
    data: {
      sales,
      pagination: {
        current: pageNum,
        pages: Math.ceil(total / limitNum),
        total,
        limit: limitNum
      }
    }
  });
});

/**
 * @desc    Get purchase transactions
 * @route   GET /api/transactions/purchases
 * @access  Private
 */
const getPurchases = asyncHandler(async (req, res) => {
  const { startDate, endDate, vendorId, page = 1, limit = 10 } = req.query;
  const businessId = req.businessId;

  const filter = { businessId, type: 'purchase' };

  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) filter.date.$lte = new Date(endDate);
  }

  if (vendorId) {
    filter.vendorId = vendorId;
  }

  const pageNum = page;
  const limitNum = limit;
  const skip = (pageNum - 1) * limitNum;

  const purchases = await Transaction.find(filter)
    .populate('vendorId', 'name phone email')
    .sort({ date: -1 })
    .limit(limitNum)
    .skip(skip);

  const total = await Transaction.countDocuments(filter);

  res.json({
    success: true,
    data: {
      purchases,
      pagination: {
        current: pageNum,
        pages: Math.ceil(total / limitNum),
        total,
        limit: limitNum
      }
    }
  });
});

/**
 * @desc    Update transaction status
 * @route   PATCH /api/transactions/:id/status
 * @access  Private
 */
const updateTransactionStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();
  let transaction;
  try {
    transaction = await Transaction.findOne({
      _id: id,
      businessId: req.businessId
    }).session(session);

    if (!transaction) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (transaction.status === status) {
      await session.abortTransaction();
      return res.status(200).json({
        success: true,
        message: `Transaction is already ${status}; no changes were applied`,
        data: { transaction }
      });
    }

    if (transaction.status !== 'completed' || status !== 'cancelled') {
      throw Object.assign(
        new Error(`Transaction cannot transition from ${transaction.status} to ${status}`),
        { statusCode: 409 }
      );
    }

    let creditCustomer = null;
    let creditBalance = null;
    let creditAmount = null;
    const isCreditSale = transaction.type === 'sale'
      && transaction.paymentMethod === 'credit'
      && transaction.customerId;

    if (isCreditSale) {
      creditCustomer = await Contact.findOne({
        _id: transaction.customerId,
        businessId: req.businessId
      }).session(session);

      if (!creditCustomer) {
        throw Object.assign(
          new Error('Cannot cancel credit sale because the customer no longer exists'),
          { statusCode: 409 }
        );
      }

      const currency = transaction.currency || 'PEN';
      const ambiguousPayment = await CreditPayment.exists({
        customerId: transaction.customerId,
        businessId: req.businessId,
        currency,
        date: { $gte: transaction.date }
      }).session(session);

      if (ambiguousPayment) {
        throw Object.assign(
          new Error('Cannot cancel credit sale with subsequent payments until a refund policy is defined'),
          { statusCode: 409 }
        );
      }

      creditBalance = toFiniteNumber(
        creditCustomer.balancesByCurrency?.[currency]
          ?? (currency === 'PEN' ? creditCustomer.currentBalance : 0),
        { field: 'Current balance' }
      );
      creditAmount = toFiniteNumber(transaction.totalAmount, {
        field: 'Transaction amount',
        min: 0
      });
      if (creditBalance < creditAmount) {
        throw Object.assign(
          new Error('Cannot cancel credit sale because its balance can no longer be reversed exactly'),
          { statusCode: 409 }
        );
      }
    }

    const historical = req.historicalContext || null;
    const cancellationTime = historical
      ? normalizeDate(historical.cancelledAt, 'cancelledAt')
      : new Date(Math.max(Date.now(), transaction.createdAt.getTime() + 1));
    if (cancellationTime <= transaction.createdAt || cancellationTime < transaction.date) {
      throw Object.assign(
        new Error('cancelledAt must be after createdAt and not before the transaction date'),
        { statusCode: 400 }
      );
    }

    for (const [itemIndex, item] of transaction.products.entries()) {
      const product = await Product.findOne({
        _id: item.productId,
        businessId: req.businessId
      }).session(session);

      if (!product) {
        throw Object.assign(new Error(`Product ${item.productName} is no longer available`), { statusCode: 409 });
      }

      const reversal = transaction.type === 'purchase' ? -item.quantity : item.quantity;
      if (transaction.type === 'purchase' && product.stock < item.quantity) {
        throw Object.assign(
          new Error(`Cannot cancel this purchase because ${product.name} no longer has enough stock to remove it`),
          { statusCode: 409 },
        );
      }
      await applyStockChange({
        product,
        quantityDelta: reversal,
        type: 'cancellation',
        transactionId: transaction._id,
        occurredAt: cancellationTime,
        source: historical ? 'historical_import' : 'api',
        scenarioId: historical?.scenarioId || transaction.scenarioId || null,
        sourceEventId: historical
          ? `${historical.sourceEventId}:inventory:${itemIndex}`
          : null,
        session
      });
    }

    if (creditCustomer) {
      const currency = transaction.currency || 'PEN';
      creditCustomer.balancesByCurrency[currency] = toFiniteNumber(
        creditBalance - creditAmount,
        { field: 'Resulting balance', min: 0 }
      );
      if (currency === 'PEN') creditCustomer.currentBalance = creditCustomer.balancesByCurrency.PEN;
      await creditCustomer.save({ session });
    }

    transaction.status = status;
    transaction.cancelledAt = cancellationTime;
    await transaction.save({ session });
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }

  res.json({
    success: true,
    message: status === 'cancelled'
      ? 'Transaction cancelled and inventory reversed successfully'
      : 'Transaction status updated successfully',
    data: { transaction }
  });
});

/**
 * @desc    Get transaction summary/statistics
 * @route   GET /api/transactions/summary
 * @access  Private
 */
const getTransactionSummary = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  const businessId = req.businessId;
  const reportingCurrency = 'PEN';

  const matchStage = { businessId, status: 'completed' };
  
  if (startDate || endDate) {
    matchStage.date = {};
    if (startDate) matchStage.date.$gte = new Date(startDate);
    if (endDate) matchStage.date.$lte = new Date(endDate);
  }

  const rateResponse = await getExchangeRate({ base: 'USD', target: reportingCurrency });
  const usdToReportingRate = toFiniteNumber(rateResponse?.rate, {
    field: 'Reporting exchange rate',
    min: Number.EPSILON
  });
  const summary = await Transaction.aggregate([
    { $match: matchStage },
    { $addFields: { baseAmount: baseAmountExpression } },
    { $addFields: { baseAmount: { $multiply: ['$baseAmount', usdToReportingRate] } } },
    {
      $group: {
        _id: '$type',
        totalAmount: { $sum: '$baseAmount' },
        transactionCount: { $sum: 1 },
        averageAmount: { $avg: '$baseAmount' }
      }
    }
  ]);

  // Format the summary
  const result = {
    sales: {
      totalAmount: 0,
      transactionCount: 0,
      averageAmount: 0
    },
    purchases: {
      totalAmount: 0,
      transactionCount: 0,
      averageAmount: 0
    }
  };

  summary.forEach(item => {
    if (item._id === 'sale') {
      result.sales = {
        totalAmount: item.totalAmount,
        transactionCount: item.transactionCount,
        averageAmount: item.averageAmount
      };
    } else if (item._id === 'purchase') {
      result.purchases = {
        totalAmount: item.totalAmount,
        transactionCount: item.transactionCount,
        averageAmount: item.averageAmount
      };
    }
  });

  // Calculate profit/loss
  result.profitLoss = result.sales.totalAmount - result.purchases.totalAmount;

  res.json({
    success: true,
    data: { summary: { ...result, currency: reportingCurrency } }
  });
});

module.exports = {
  getTransactions,
  getTransaction,
  createTransaction,
  getSales,
  getPurchases,
  updateTransactionStatus,
  getTransactionSummary
};
