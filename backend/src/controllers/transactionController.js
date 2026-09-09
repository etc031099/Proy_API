const mongoose = require('mongoose');
const { Transaction, Product, Contact } = require('../models');
const { asyncHandler } = require('../middleware/validation');
const { validatePaymentMethod, getExchangeRate } = require('../services/externalApiService');
const { notifyLowStock } = require('../services/telegramService');

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
    filter.$or = [
      { customerId: contactId },
      { vendorId: contactId }
    ];
  }

  if (status && ['pending', 'completed', 'cancelled'].includes(status)) {
    filter.status = status;
  }

  // Calculate pagination
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
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

  // Get total count for pagination
  const total = await Transaction.countDocuments(filter);

  res.json({
    success: true,
    data: {
      transactions,
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
  const { type, customerId, customerName, vendorId, products = [], paymentMethod, notes, currency = 'PEN' } = req.body;
  const businessId = req.businessId;
  const normalizedCurrency = String(currency || 'PEN').toUpperCase();
  const targetCurrency = ['PEN', 'USD', 'EUR'].includes(normalizedCurrency) ? normalizedCurrency : 'PEN';

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'At least one product is required.'
    });
  }

  // Start a session for transaction
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // Validate contact based on transaction type
    let contact;
    if (type === 'sale') {
      if (customerId) {
        contact = await Contact.findOne({
          _id: customerId,
          businessId,
          type: 'customer',
          isActive: true
        }).session(session);

        if (!contact) {
          return res.status(404).json({
            success: false,
            message: 'Customer not found'
          });
        }
      } else if ((paymentMethod || 'cash') === 'credit') {
        throw Object.assign(
          new Error('A registered customer is required for credit sales'),
          { statusCode: 400 },
        );
      }
    } else if (type === 'purchase') {
      if (!vendorId) {
        return res.status(400).json({
          success: false,
          message: 'Vendor ID is required for purchases'
        });
      }
      contact = await Contact.findOne({
        _id: vendorId,
        businessId,
        type: 'vendor',
        isActive: true
      }).session(session);

      if (!contact) {
        return res.status(404).json({
          success: false,
          message: 'Vendor not found'
        });
      }
    }

    // Validate and process products
    const processedProducts = [];
    const lowStockNotifications = [];
    let subtotal = 0;

    for (const item of products) {
      const product = await Product.findOne({
        _id: item.productId,
        businessId,
        isActive: true
      }).session(session);

      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product with ID ${item.productId} not found`
        });
      }

      if (type === 'sale' && product.stock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for product ${product.name}. Available: ${product.stock}, Requested: ${item.quantity}`
        });
      }

      const previousStock = product.stock;
      if (type === 'sale') {
        product.stock -= item.quantity;
      } else {
        product.stock += item.quantity;
      }

      await product.save({ session });
      if (type === 'sale') lowStockNotifications.push({ product, previousStock });

      const matchingSupplierPrice = type === 'purchase'
        ? product.supplierPrices.find(entry => String(entry.supplierId) === String(vendorId))
        : null;
      if (type === 'purchase' && !matchingSupplierPrice) {
        return res.status(400).json({
          success: false,
          message: `Product ${product.name} is not configured for the selected vendor`
        });
      }
      const preferredSupplierPrice = type === 'purchase' && product.preferredSupplierId
        ? product.supplierPrices.find(entry => String(entry.supplierId) === String(product.preferredSupplierId))
        : null;
      const itemCost = type === 'purchase'
        ? Number(item.costPrice ?? matchingSupplierPrice?.purchasePrice ?? preferredSupplierPrice?.purchasePrice ?? item.price ?? product.costPrice ?? product.price ?? 0)
        : undefined;
      const sourcePrice = type === 'sale'
        ? Number(item.price ?? product.price ?? 0)
        : itemCost;
      const productCurrency = ['PEN', 'USD', 'EUR'].includes(product.currency) ? product.currency : 'USD';
      const itemRateResponse = await getExchangeRate({ base: productCurrency, target: targetCurrency });
      const itemRate = Number(itemRateResponse?.rate) || 1;
      const itemPrice = Number((sourcePrice * itemRate).toFixed(2));
      const itemTotal = Number((Number(item.quantity || 0) * itemPrice).toFixed(2));
      subtotal += itemTotal;

      processedProducts.push({
        productId: product._id,
        productName: product.name,
        quantity: Number(item.quantity || 0),
        price: itemPrice,
        ...(type === 'purchase' ? { costPrice: itemPrice } : {}),
        total: itemTotal
      });
    }

    const baseCurrency = 'USD';
    const exchangeRateResponse = await getExchangeRate({ base: baseCurrency, target: targetCurrency });
    const resolvedRate = Number(exchangeRateResponse?.rate) || 1;
    // Item prices and subtotal are already expressed in the selected transaction currency.
    // Only store the USD equivalent separately for reports; do not convert the subtotal again.
    const totalAmount = Number(subtotal.toFixed(2));
    const paymentValidation = await validatePaymentMethod({
      method: paymentMethod || 'cash',
      amount: totalAmount
    });

    if (!paymentValidation.valid || !paymentValidation.supported) {
      return res.status(400).json({
        success: false,
        message: paymentValidation.message || 'Payment method is not supported.'
      });
    }

    // Create transaction data
    const transactionData = {
      type,
      products: processedProducts,
      totalAmount,
      originalAmount: Number((subtotal / resolvedRate).toFixed(2)),
      businessId,
      currency: targetCurrency,
      exchangeRate: resolvedRate,
      paymentMethod: paymentMethod || 'cash',
      notes
    };

    if (type === 'sale') {
      transactionData.customerId = customerId;
      transactionData.customerName = contact?.name || String(customerName || 'Consumidor final').trim();
    } else {
      transactionData.vendorId = vendorId;
      transactionData.supplierId = vendorId;
      transactionData.vendorName = contact.name;
    }

    const transaction = await Transaction.create([transactionData], { session });

    if (type === 'sale' && (paymentMethod || 'cash') === 'credit') {
      const currencyBalance = Number(
        contact.balancesByCurrency?.[targetCurrency]
        || (targetCurrency === 'PEN' ? contact.currentBalance : 0)
      );
      const newBalance = currencyBalance + totalAmount;
      if (targetCurrency === 'PEN' && Number(contact.creditLimit || 0) > 0 && newBalance > Number(contact.creditLimit)) {
        throw Object.assign(
          new Error(`Credit limit exceeded. Available credit: ${Math.max(0, Number(contact.creditLimit) - currencyBalance).toFixed(2)} PEN`),
          { statusCode: 400 },
        );
      }
      contact.balancesByCurrency[targetCurrency] = newBalance;
      if (targetCurrency === 'PEN') contact.currentBalance = newBalance;
      await contact.save({ session });
    }

    await session.commitTransaction();

    for (const notification of lowStockNotifications) {
      Promise.resolve()
        .then(() => notifyLowStock(businessId, notification.product, notification.previousStock))
        .catch((error) => console.error('[Telegram] low-stock notification failed:', error.message));
    }

    const populatedTransaction = await Transaction.findById(transaction[0]._id)
      .populate('customerId', 'name phone email')
      .populate('vendorId', 'name phone email')
      .populate('supplierId', 'name phone email')
      .populate('products.productId', 'name category');

    res.status(201).json({
      success: true,
      message: `${type === 'sale' ? 'Sale' : 'Purchase'} recorded successfully`,
      data: { transaction: populatedTransaction }
    });

  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
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

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
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

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
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
      return res.status(400).json({
        success: false,
        message: `Transaction is already ${status}`
      });
    }

    if (status === 'cancelled') {
      if (transaction.status === 'cancelled') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'Transaction is already cancelled' });
      }

      for (const item of transaction.products) {
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
        product.stock += reversal;
        await product.save({ session });
      }

      if (transaction.type === 'sale' && transaction.paymentMethod === 'credit' && transaction.customerId) {
        const customer = await Contact.findOne({
          _id: transaction.customerId,
          businessId: req.businessId
        }).session(session);
        if (customer) {
          const currency = transaction.currency || 'PEN';
          const balance = Number(
            customer.balancesByCurrency?.[currency]
            || (currency === 'PEN' ? customer.currentBalance : 0)
          );
          customer.balancesByCurrency[currency] = Math.max(0, balance - transaction.totalAmount);
          if (currency === 'PEN') customer.currentBalance = customer.balancesByCurrency.PEN;
          await customer.save({ session });
        }
      }
    }

    transaction.status = status;
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

  const matchStage = { businessId };
  
  if (startDate || endDate) {
    matchStage.date = {};
    if (startDate) matchStage.date.$gte = new Date(startDate);
    if (endDate) matchStage.date.$lte = new Date(endDate);
  }

  const rateResponse = await getExchangeRate({ base: 'USD', target: reportingCurrency });
  const usdToReportingRate = Number(rateResponse?.rate) || 1;
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