const mongoose = require('mongoose');
const { Product, Contact } = require('../models');
const { asyncHandler } = require('../middleware/validation');
const { notifyLowStock } = require('../services/telegramService');
const { emitEvent } = require('../services/webhookService');
const { toFiniteNumber } = require('../utils/numbers');
const { assertAllowedFields, pickAllowedFields } = require('../utils/allowedFields');
const { SKU_INDEX_NAME, normalizeSku } = require('../utils/sku');
const { applyStockChange } = require('../services/inventoryService');

const PRODUCT_CREATE_FIELDS = [
  'name', 'description', 'price', 'currency', 'costPrice', 'stock', 'category',
  'sku', 'minStockLevel', 'supplierPrices', 'preferredSupplierId'
];
const PRODUCT_UPDATE_FIELDS = PRODUCT_CREATE_FIELDS.filter(field => field !== 'stock');
const SUPPLIER_PRICE_FIELDS = ['supplierId', 'purchasePrice'];

const normalizeSkuField = (data) => {
  if (Object.prototype.hasOwnProperty.call(data, 'sku')) {
    data.sku = normalizeSku(data.sku);
  }
};

const isSkuDuplicateKey = (error) => error?.code === 11000 && (
  error?.index === SKU_INDEX_NAME
  || error?.keyPattern?.sku === 1
);

const sendSkuConflict = (res) => res.status(409).json({
  success: false,
  code: 'SKU_ALREADY_EXISTS',
  message: 'Product with this SKU already exists in this business'
});

const validateSupplierPrices = async (supplierPrices, businessId) => {
  if (supplierPrices === undefined) return undefined;
  if (!Array.isArray(supplierPrices)) {
    const error = new Error('Supplier prices must be an array');
    error.statusCode = 400;
    throw error;
  }

  supplierPrices.forEach((entry, index) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      assertAllowedFields(entry, SUPPLIER_PRICE_FIELDS, `supplierPrices[${index}]`);
    }
  });

  const entries = supplierPrices.filter(entry => entry && entry.supplierId);
  const supplierIds = [...new Set(entries.map(entry => String(entry.supplierId)))];
  const validSuppliers = await Contact.find({
    _id: { $in: supplierIds },
    businessId,
    type: 'vendor',
    isActive: true
  }).select('_id');
  if (validSuppliers.length !== supplierIds.length) {
    const error = new Error('Supplier prices must reference active vendors in this business');
    error.statusCode = 400;
    throw error;
  }

  return entries.map(entry => ({
    supplierId: entry.supplierId,
    purchasePrice: toFiniteNumber(entry.purchasePrice, {
      field: 'Supplier purchase price',
      min: 0
    })
  }));
};

const validatePreferredSupplier = async (preferredSupplierId, supplierPrices, businessId) => {
  if (!preferredSupplierId) return null;
  const isConfigured = (supplierPrices || []).some(
    entry => String(entry.supplierId) === String(preferredSupplierId),
  );
  if (!isConfigured) {
    const error = new Error('Preferred supplier must have a configured purchase price');
    error.statusCode = 400;
    throw error;
  }
  const supplier = await Contact.findOne({
    _id: preferredSupplierId,
    businessId,
    type: 'vendor',
    isActive: true,
  }).select('_id');
  if (!supplier) {
    const error = new Error('Preferred supplier must be an active vendor in this business');
    error.statusCode = 400;
    throw error;
  }
  return preferredSupplierId;
};

/**
 * @desc    Get all products with search and filter
 * @route   GET /api/products
 * @access  Private
 */
const getProducts = asyncHandler(async (req, res) => {
  const { search, category, minStock, maxStock, page = 1, limit = 10 } = req.query;
  const businessId = req.businessId;

  // Build filter object
  const filter = { businessId, isActive: true };

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
      { sku: { $regex: search, $options: 'i' } }
    ];
  }

  if (category) {
    filter.category = { $regex: category, $options: 'i' };
  }

  if (minStock !== undefined || maxStock !== undefined) {
    filter.stock = {};
    if (minStock !== undefined) filter.stock.$gte = minStock;
    if (maxStock !== undefined) filter.stock.$lte = maxStock;
  }

  // Calculate pagination
  const pageNum = page;
  const limitNum = limit;
  const skip = (pageNum - 1) * limitNum;

  // Get products with pagination
  const products = await Product.find(filter)
    .sort({ createdAt: -1 })
    .limit(limitNum)
    .skip(skip);

  // Get total count for pagination
  const total = await Product.countDocuments(filter);

  res.json({
    success: true,
    data: {
      products,
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
 * @desc    Get single product
 * @route   GET /api/products/:id
 * @access  Private
 */
const getProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOne({
    _id: req.params.id,
    businessId: req.businessId,
    isActive: true
  });

  if (!product) {
    return res.status(404).json({
      success: false,
      message: 'Product not found'
    });
  }

  res.json({
    success: true,
    data: { product }
  });
});

/**
 * @desc    Create new product
 * @route   POST /api/products
 * @access  Private
 */
const createProduct = asyncHandler(async (req, res) => {
  const productData = pickAllowedFields(req.body, PRODUCT_CREATE_FIELDS);
  const historical = req.historicalContext || null;
  normalizeSkuField(productData);
  const supplierPrices = await validateSupplierPrices(productData.supplierPrices, req.businessId);
  const preferredSupplierId = await validatePreferredSupplier(
    productData.preferredSupplierId,
    supplierPrices || [],
    req.businessId,
  );
  productData.businessId = req.businessId;
  if (historical) {
    productData._id = historical.productId;
    productData.scenarioId = historical.scenarioId;
    productData.sourceEventId = historical.sourceEventId;
    productData.createdAt = historical.createdAt;
    productData.updatedAt = historical.createdAt;
  }
  if (supplierPrices) productData.supplierPrices = supplierPrices;
  productData.preferredSupplierId = preferredSupplierId;

  // Check if SKU already exists (if provided)
  if (productData.sku) {
    const existingProduct = await Product.findOne({
      sku: productData.sku,
      businessId: req.businessId
    });

    if (existingProduct) {
      return sendSkuConflict(res);
    }
  }

  const initialStock = toFiniteNumber(productData.stock ?? 0, {
    field: 'Stock', min: 0, integer: true
  });
  productData.stock = 0;
  const session = await mongoose.startSession();
  let product;
  try {
    session.startTransaction();
    [product] = await Product.create([productData], { session });
    if (initialStock > 0) {
      await applyStockChange({
        product,
        quantityDelta: initialStock,
        type: 'opening',
        occurredAt: historical?.createdAt,
        source: historical ? 'historical_import' : 'api',
        scenarioId: historical?.scenarioId || null,
        sourceEventId: historical ? `${historical.sourceEventId}:inventory` : null,
        session
      });
    }
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    if (isSkuDuplicateKey(error) || (error?.code === 112 && productData.sku)) {
      return sendSkuConflict(res);
    }
    throw error;
  } finally {
    await session.endSession();
  }

  res.status(201).json({
    success: true,
    message: 'Product created successfully',
    data: { product }
  });
});

/**
 * @desc    Update product
 * @route   PUT /api/products/:id
 * @access  Private
 */
const updateProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updateData = pickAllowedFields(req.body, PRODUCT_UPDATE_FIELDS);
  normalizeSkuField(updateData);
  const existingProduct = await Product.findOne({ _id: id, businessId: req.businessId, isActive: true })
    .select('supplierPrices');
  if (!existingProduct) {
    return res.status(404).json({
      success: false,
      message: 'Product not found'
    });
  }
  const supplierPrices = await validateSupplierPrices(updateData.supplierPrices, req.businessId);
  if (supplierPrices) updateData.supplierPrices = supplierPrices;
  if (updateData.preferredSupplierId !== undefined) {
    updateData.preferredSupplierId = await validatePreferredSupplier(
      updateData.preferredSupplierId,
      supplierPrices || existingProduct.supplierPrices,
      req.businessId,
    );
  }

  // Check if SKU already exists (if being updated)
  if (updateData.sku) {
    const existingProduct = await Product.findOne({
      sku: updateData.sku,
      businessId: req.businessId,
      _id: { $ne: id }
    });

    if (existingProduct) {
      return sendSkuConflict(res);
    }
  }

  let product;
  try {
    product = await Product.findOneAndUpdate(
      { _id: id, businessId: req.businessId },
      updateData,
      { new: true, runValidators: true }
    );
  } catch (error) {
    if (isSkuDuplicateKey(error)) return sendSkuConflict(res);
    throw error;
  }

  if (!product) {
    return res.status(404).json({
      success: false,
      message: 'Product not found'
    });
  }

  res.json({
    success: true,
    message: 'Product updated successfully',
    data: { product }
  });
});

/**
 * @desc    Delete product (soft delete)
 * @route   DELETE /api/products/:id
 * @access  Private
 */
const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, businessId: req.businessId },
    { isActive: false },
    { new: true }
  );

  if (!product) {
    return res.status(404).json({
      success: false,
      message: 'Product not found'
    });
  }

  res.json({
    success: true,
    message: 'Product deleted successfully'
  });
});

/**
 * @desc    Get products by category
 * @route   GET /api/products/category/:category
 * @access  Private
 */
const getProductsByCategory = asyncHandler(async (req, res) => {
  const { category } = req.params;
  const { page = 1, limit = 10 } = req.query;

  const pageNum = page;
  const limitNum = limit;
  const skip = (pageNum - 1) * limitNum;

  const filter = {
    businessId: req.businessId,
    category: { $regex: category, $options: 'i' },
    isActive: true
  };

  const products = await Product.find(filter)
    .sort({ name: 1 })
    .limit(limitNum)
    .skip(skip);

  const total = await Product.countDocuments(filter);

  res.json({
    success: true,
    data: {
      category,
      products,
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
 * @desc    Get low stock products
 * @route   GET /api/products/low-stock
 * @access  Private
 */
const getLowStockProducts = asyncHandler(async (req, res) => {
  const products = await Product.findLowStock(req.businessId);

  res.json({
    success: true,
    data: {
      products,
      count: products.length
    }
  });
});

/**
 * @desc    Update product stock
 * @route   PATCH /api/products/:id/stock
 * @access  Private
 */
const updateProductStock = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { operation = 'set' } = req.body; // set, add, subtract
  const quantity = toFiniteNumber(req.body.quantity, {
    field: 'Quantity',
    min: 0,
    integer: true
  });

  const session = await mongoose.startSession();
  let product;
  let previousStock;
  let newStock;
  try {
    session.startTransaction();
    product = await Product.findOne({
      _id: id,
      businessId: req.businessId,
      isActive: true
    }).session(session);

    if (!product) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    previousStock = product.stock;
    switch (operation) {
      case 'add':
        newStock = toFiniteNumber(product.stock + quantity, {
          field: 'Resulting stock', min: 0, integer: true
        });
        break;
      case 'subtract':
        newStock = Math.max(0, product.stock - quantity);
        break;
      case 'set':
      default:
        newStock = quantity;
        break;
    }

    await applyStockChange({
      product,
      quantityDelta: newStock - previousStock,
      type: 'manual_adjustment',
      source: 'api',
      session
    });
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
  Promise.resolve()
    .then(() => notifyLowStock(req.businessId, product, previousStock))
    .catch((error) => console.error('[Telegram] low-stock notification failed:', error.message));

  // Optional real-time event to Node-RED (no-op unless NODE_RED_WEBHOOK_URL is set)
  if (product.stock <= product.minStockLevel) {
    emitEvent('product.low_stock', {
      businessId: req.businessId,
      productId: product._id,
      name: product.name,
      stock: product.stock,
      minStockLevel: product.minStockLevel,
      previousStock
    });
  }

  res.json({
    success: true,
    message: 'Product stock updated successfully',
    data: {
      product,
      previousStock,
      newStock,
      operation
    }
  });
});

/**
 * @desc    Get product categories
 * @route   GET /api/products/categories
 * @access  Private
 */
const getCategories = asyncHandler(async (req, res) => {
  const categories = await Product.aggregate([
    { $match: { businessId: req.businessId, isActive: true } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);

  res.json({
    success: true,
    data: {
      categories: categories.map(cat => ({
        name: cat._id,
        productCount: cat.count
      }))
    }
  });
});

module.exports = {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductsByCategory,
  getLowStockProducts,
  updateProductStock,
  getCategories
};
