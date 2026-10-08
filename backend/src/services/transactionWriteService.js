const mongoose = require('mongoose');
const { Transaction, Product, Contact } = require('../models');
const { validatePaymentMethod, getExchangeRate } = require('./externalApiService');
const { toFiniteNumber } = require('../utils/numbers');
const { applyStockChange, normalizeDate } = require('./inventoryService');
const TRANSACTION_CURRENCIES = ['PEN', 'USD', 'EUR'];
// One business implementation for CRUD and actions. Caller-owned sessions never commit here.
// Preview runs the same pricing/contact/credit validation without business writes.
const writeTransaction = async ({ input, businessId, historical = null, session: suppliedSession, preview = false, expectedSnapshot }) => {
  const { type, customerId, customerName, vendorId, products = [], paymentMethod, notes, currency = 'PEN' } = input;
  const normalizedCurrency = String(currency || 'PEN').toUpperCase();
  const targetCurrency = TRANSACTION_CURRENCIES.includes(normalizedCurrency) ? normalizedCurrency : 'PEN';
  const transactionId = historical?.transactionId || new mongoose.Types.ObjectId();
  const transactionDate = historical
    ? normalizeDate(historical.date, 'transaction date')
    : new Date();
  const resolveExchangeRate = async (base, target) => {
    if (!historical) return getExchangeRate({ base, target });
    if (base === target) return { rate: 1 };
    const rate = toFiniteNumber(historical.exchangeRates?.[`${base}/${target}`], {
      field: `Historical exchange rate ${base}/${target}`,
      min: Number.EPSILON
    });
    return { rate };
  };

  if (!Array.isArray(products) || products.length === 0) {
    throw Object.assign(new Error('At least one product is required.'), { statusCode: 400, directResponse: true });
  }

  // Start a session for transaction
  const session = suppliedSession || await mongoose.startSession();
  const ownsSession = !suppliedSession;

  try {
    if (ownsSession) session.startTransaction();

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
          throw Object.assign(new Error('Customer not found'), { statusCode: 404, directResponse: true });
        }
      } else if ((paymentMethod || 'cash') === 'credit') {
        throw Object.assign(
          new Error('A registered customer is required for credit sales'),
          { statusCode: 400 },
        );
      }
    } else if (type === 'purchase') {
      if (!vendorId) {
        throw Object.assign(new Error('Vendor ID is required for purchases'), { statusCode: 400, directResponse: true });
      }
      contact = await Contact.findOne({
        _id: vendorId,
        businessId,
        type: 'vendor',
        isActive: true
      }).session(session);

      if (!contact) {
        throw Object.assign(new Error('Vendor not found'), { statusCode: 404, directResponse: true });
      }
    }

    // Validate and process products
    const processedProducts = [];
    const lowStockNotifications = [];
    const snapshotItems = [];
    const previewProducts = new Map();
    let subtotal = 0;

    for (const [itemIndex, item] of products.entries()) {
      const itemQuantity = toFiniteNumber(item.quantity, {
        field: 'Product quantity',
        min: 1,
        integer: true
      });
      const product = (preview && previewProducts.get(String(item.productId))) || await Product.findOne({
        _id: item.productId,
        businessId,
        isActive: true
      }).session(session);

      if (!product) {
        throw Object.assign(new Error(`Product with ID ${item.productId} not found`), { statusCode: 404, directResponse: true });
      }

      let canonicalSalePrice;
      let canonicalSaleCurrency;
      let canonicalPurchaseCost;
      let canonicalPurchaseCurrency;
      if (type === 'sale') {
        canonicalSalePrice = toFiniteNumber(product.price, {
          field: 'Product price',
          min: 0
        });
        canonicalSaleCurrency = String(product.currency || '').trim().toUpperCase();
        if (!TRANSACTION_CURRENCIES.includes(canonicalSaleCurrency)) {
          throw Object.assign(
            new Error(`Product currency must be one of: ${TRANSACTION_CURRENCIES.join(', ')}`),
            { statusCode: 400, code: 'INVALID_CURRENCY' }
          );
        }
      } else if (type === 'purchase') {
        const matchingSupplierPrice = (product.supplierPrices || []).find(
          entry => String(entry.supplierId) === String(vendorId)
        );
        if (!matchingSupplierPrice) {
          throw Object.assign(
            new Error(`Product ${product.name} is not configured for the selected vendor`),
            { statusCode: 400 }
          );
        }
        canonicalPurchaseCost = toFiniteNumber(matchingSupplierPrice.purchasePrice, {
          field: 'Supplier purchase price',
          min: 0
        });
        canonicalPurchaseCurrency = String(product.currency || '').trim().toUpperCase();
        if (!TRANSACTION_CURRENCIES.includes(canonicalPurchaseCurrency)) {
          throw Object.assign(
            new Error(`Product currency must be one of: ${TRANSACTION_CURRENCIES.join(', ')}`),
            { statusCode: 400, code: 'INVALID_CURRENCY' }
          );
        }
      }

      if (type === 'sale' && product.stock < itemQuantity) {
        throw Object.assign(new Error(`Insufficient stock for product ${product.name}. Available: ${product.stock}, Requested: ${itemQuantity}`), { statusCode: 400, directResponse: true });
      }

      const previousStock = product.stock;
      snapshotItems.push({ productId: String(product._id), sku: product.sku, name: product.name,
        stock: previousStock, quantity: itemQuantity, currency: product.currency,
        price: type === 'sale' ? canonicalSalePrice : canonicalPurchaseCost });
      if (preview) {
        product.stock = toFiniteNumber(toFiniteNumber(product.stock, { field: 'Current stock', min: 0, integer: true })
          + (type === 'sale' ? -itemQuantity : itemQuantity), { field: 'Resulting stock', min: 0, integer: true });
        previewProducts.set(String(product._id), product);
      } else await applyStockChange({
        product,
        quantityDelta: type === 'sale' ? -itemQuantity : itemQuantity,
        type,
        transactionId,
        occurredAt: transactionDate,
        source: historical ? 'historical_import' : 'api',
        scenarioId: historical?.scenarioId || null,
        sourceEventId: historical
          ? `${historical.sourceEventId}:inventory:${itemIndex}`
          : null,
        session
      });
      if (type === 'sale') lowStockNotifications.push({ product, previousStock });

      const sourcePrice = type === 'sale' ? canonicalSalePrice : canonicalPurchaseCost;
      const productCurrency = type === 'sale'
        ? canonicalSaleCurrency
        : canonicalPurchaseCurrency;
      const itemRateResponse = await resolveExchangeRate(productCurrency, targetCurrency);
      const itemRate = toFiniteNumber(itemRateResponse?.rate, {
        field: 'Exchange rate',
        min: Number.EPSILON
      });
      const itemPrice = toFiniteNumber(Number((sourcePrice * itemRate).toFixed(2)), {
        field: 'Converted product price',
        min: 0
      });
      const itemTotal = toFiniteNumber(Number((itemQuantity * itemPrice).toFixed(2)), {
        field: 'Product total',
        min: 0
      });
      subtotal = toFiniteNumber(subtotal + itemTotal, {
        field: 'Transaction subtotal',
        min: 0
      });

      snapshotItems[snapshotItems.length - 1].convertedPrice = itemPrice;
      snapshotItems[snapshotItems.length - 1].resultingStock = product.stock;
      processedProducts.push({
        productId: product._id,
        productName: product.name,
        quantity: itemQuantity,
        price: itemPrice,
        ...(type === 'purchase' ? { costPrice: itemPrice } : {}),
        total: itemTotal
      });
    }

    const baseCurrency = 'USD';
    const exchangeRateResponse = await resolveExchangeRate(baseCurrency, targetCurrency);
    const resolvedRate = toFiniteNumber(exchangeRateResponse?.rate, {
      field: 'Exchange rate',
      min: Number.EPSILON
    });
    // Item prices and subtotal are already expressed in the selected transaction currency.
    // Only store the USD equivalent separately for reports; do not convert the subtotal again.
    const totalAmount = Number(subtotal.toFixed(2));
    const paymentValidation = await validatePaymentMethod({
      method: paymentMethod || 'cash',
      amount: totalAmount
    });

    if (!paymentValidation.valid || !paymentValidation.supported) {
      throw Object.assign(new Error(paymentValidation.message || 'Payment method is not supported.'), { statusCode: 400, directResponse: true });
    }

    // Create transaction data
    const transactionData = {
      _id: transactionId,
      type,
      products: processedProducts,
      totalAmount,
      originalAmount: Number((subtotal / resolvedRate).toFixed(2)),
      businessId,
      currency: targetCurrency,
      exchangeRate: resolvedRate,
      paymentMethod: paymentMethod || 'cash',
      notes,
      date: transactionDate,
      cancelledAt: null,
      scenarioId: historical?.scenarioId || null,
      sourceEventId: historical?.sourceEventId || null,
      ...(historical?.createdAt ? {
        createdAt: normalizeDate(historical.createdAt, 'transaction createdAt'),
        updatedAt: normalizeDate(historical.createdAt, 'transaction createdAt')
      } : {})
    };

    if (type === 'sale') {
      transactionData.customerId = customerId;
      transactionData.customerName = contact?.name || String(customerName || 'Consumidor final').trim();
    } else {
      transactionData.vendorId = vendorId;
      transactionData.supplierId = vendorId;
      transactionData.vendorName = contact.name;
    }

    const snapshot = { items: snapshotItems, currency: targetCurrency, totalAmount,
      exchangeRate: resolvedRate, paymentMethod: paymentMethod || 'cash',
      contactId: contact ? String(contact._id) : null, contactName: contact?.name || transactionData.customerName,
      creditLimit: contact?.creditLimit ?? null, currentBalance: contact?.currentBalance ?? null,
      balancesByCurrency: contact?.balancesByCurrency ? Object.fromEntries(TRANSACTION_CURRENCIES.map(currency =>
        [currency, contact.balancesByCurrency[currency] ?? 0])) : null };
    if (expectedSnapshot && JSON.stringify(snapshot) !== JSON.stringify(expectedSnapshot)) {
      throw Object.assign(new Error('Transaction state changed; prepare a new preview.'), { code: 'ACTION_CONFLICT', statusCode: 409 });
    }
    if (type === 'sale' && (paymentMethod || 'cash') === 'credit') {
      const currencyBalance = toFiniteNumber(
        contact.balancesByCurrency?.[targetCurrency]
        || (targetCurrency === 'PEN' ? contact.currentBalance : 0),
        { field: 'Current balance' }
      );
      const newBalance = toFiniteNumber(currencyBalance + totalAmount, {
        field: 'Resulting balance'
      });
      if (targetCurrency === 'PEN' && Number(contact.creditLimit || 0) > 0 && newBalance > Number(contact.creditLimit)) {
        throw Object.assign(
          new Error(`Credit limit exceeded. Available credit: ${Math.max(0, Number(contact.creditLimit) - currencyBalance).toFixed(2)} PEN`),
          { statusCode: 400 },
        );
      }
      contact.balancesByCurrency[targetCurrency] = newBalance;
      if (targetCurrency === 'PEN') contact.currentBalance = newBalance;
      if (!preview) await contact.save({ session });
    }


    if (preview) {
      if (ownsSession) await session.abortTransaction();
      return { snapshot, transactionData };
    }
    const [transaction] = await Transaction.create([transactionData], { session });
    if (ownsSession) await session.commitTransaction();
    return { transaction, snapshot, lowStockNotifications, transactionData };
  } catch (error) {
    if (ownsSession && session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    if (ownsSession) await session.endSession();
  }
};

module.exports = { writeTransaction };
