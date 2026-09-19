const { body, query } = require('express-validator');
const { MAX_SAFE_NUMERIC_VALUE, toFiniteNumber } = require('./numbers');

const MAX_PAGE = 10000;
const MAX_PAGE_SIZE = 100;

const validateNumericInput = (options) => (value) => {
  toFiniteNumber(value, options);
  return true;
};

const limitValidation = [
  query('limit')
    .optional()
    .custom(validateNumericInput({ field: 'Limit', min: 1, max: MAX_PAGE_SIZE, integer: true }))
    .withMessage(`Limit must be an integer between 1 and ${MAX_PAGE_SIZE}`)
    .bail()
    .toInt()
];

const paginationValidation = [
  query('page')
    .optional()
    .custom(validateNumericInput({ field: 'Page', min: 1, max: MAX_PAGE, integer: true }))
    .withMessage(`Page must be an integer between 1 and ${MAX_PAGE}`)
    .bail()
    .toInt(),
  ...limitValidation
];

// Auth validations
const registerValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters'),
    
  body('email')
    .trim()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please enter a valid email address'),
    
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one lowercase letter, one uppercase letter, and one number'),
    
  body('businessId')
    .trim()
    .notEmpty()
    .withMessage('Business ID is required')
    .isLength({ min: 3, max: 50 })
    .withMessage('Business ID must be between 3 and 50 characters')
];

const loginValidation = [
  body('email')
    .trim()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please enter a valid email address'),
    
  body('password')
    .notEmpty()
    .withMessage('Password is required')
];

const updateProfileValidation = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters')
];

const changePasswordValidation = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
    
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('New password must contain at least one lowercase letter, one uppercase letter, and one number')
];

// Product validations
const createProductValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Product name is required')
    .isLength({ min: 1, max: 100 })
    .withMessage('Product name must be between 1 and 100 characters'),
    
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),
    
  body('price')
    .custom(validateNumericInput({ field: 'Price', min: 0, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Price must be a non-negative finite number')
    .bail()
    .toFloat(),

  body('costPrice')
    .optional()
    .custom(validateNumericInput({ field: 'Cost price', min: 0, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Cost price must be a non-negative finite number')
    .bail()
    .toFloat(),
    
  body('stock')
    .custom(validateNumericInput({ field: 'Stock', min: 0, max: MAX_SAFE_NUMERIC_VALUE, integer: true }))
    .bail()
    .isInt({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Stock must be a non-negative safe integer')
    .bail()
    .toInt(),
    
  body('category')
    .trim()
    .notEmpty()
    .withMessage('Category is required')
    .isLength({ min: 1, max: 50 })
    .withMessage('Category must be between 1 and 50 characters'),
    
  body('sku')
    .optional()
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('SKU must be between 1 and 50 characters'),
    
  body('minStockLevel')
    .optional()
    .custom(validateNumericInput({ field: 'Minimum stock level', min: 0, max: MAX_SAFE_NUMERIC_VALUE, integer: true }))
    .bail()
    .isInt({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Minimum stock level must be a non-negative safe integer')
    .bail()
    .toInt(),

  body('currency')
    .optional()
    .trim()
    .toUpperCase()
    .isIn(['PEN', 'USD', 'EUR'])
    .withMessage('Currency must be one of: PEN, USD, EUR'),

  body('supplierPrices')
    .optional()
    .isArray()
    .withMessage('Supplier prices must be an array'),

  body('supplierPrices.*.supplierId')
    .isMongoId()
    .withMessage('Supplier price must reference a valid supplier ID'),

  body('supplierPrices.*.purchasePrice')
    .custom(validateNumericInput({ field: 'Supplier purchase price', min: 0, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Supplier purchase price must be a non-negative finite number')
    .bail()
    .toFloat()
];

const updateProductValidation = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Product name must be between 1 and 100 characters'),
    
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),
    
  body('price')
    .optional()
    .custom(validateNumericInput({ field: 'Price', min: 0, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Price must be a non-negative finite number')
    .bail()
    .toFloat(),

  body('costPrice')
    .optional()
    .custom(validateNumericInput({ field: 'Cost price', min: 0, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Cost price must be a non-negative finite number')
    .bail()
    .toFloat(),
    
  body('stock')
    .optional()
    .custom(validateNumericInput({ field: 'Stock', min: 0, max: MAX_SAFE_NUMERIC_VALUE, integer: true }))
    .bail()
    .isInt({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Stock must be a non-negative safe integer')
    .bail()
    .toInt(),
    
  body('category')
    .optional()
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('Category must be between 1 and 50 characters'),
    
  body('sku')
    .optional()
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('SKU must be between 1 and 50 characters'),
    
  body('minStockLevel')
    .optional()
    .custom(validateNumericInput({ field: 'Minimum stock level', min: 0, max: MAX_SAFE_NUMERIC_VALUE, integer: true }))
    .bail()
    .isInt({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Minimum stock level must be a non-negative safe integer')
    .bail()
    .toInt(),

  body('currency')
    .optional()
    .trim()
    .toUpperCase()
    .isIn(['PEN', 'USD', 'EUR'])
    .withMessage('Currency must be one of: PEN, USD, EUR'),

  body('supplierPrices')
    .optional()
    .isArray()
    .withMessage('Supplier prices must be an array'),

  body('supplierPrices.*.supplierId')
    .isMongoId()
    .withMessage('Supplier price must reference a valid supplier ID'),

  body('supplierPrices.*.purchasePrice')
    .custom(validateNumericInput({ field: 'Supplier purchase price', min: 0, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Supplier purchase price must be a non-negative finite number')
    .bail()
    .toFloat()
];

const updateStockValidation = [
  body('quantity')
    .custom(validateNumericInput({ field: 'Quantity', min: 0, max: MAX_SAFE_NUMERIC_VALUE, integer: true }))
    .bail()
    .isInt({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Quantity must be a non-negative safe integer')
    .bail()
    .toInt(),
    
  body('operation')
    .optional()
    .isIn(['set', 'add', 'subtract'])
    .withMessage('Operation must be one of: set, add, subtract')
];

// Contact validations
const createContactValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Contact name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),
    
  body('phone')
    .trim()
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^\+?[\d\s\-\(\)]{7,20}$/)
    .withMessage('Please enter a valid phone number'),
    
  body('documentType')
    .optional({ checkFalsy: true })
    .trim()
    .isIn(['dni', 'ruc'])
    .withMessage('Document type must be dni or ruc'),

  body('documentNumber')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 8, max: 20 })
    .withMessage('Document number must be between 8 and 20 characters'),

  body('email')
    .optional({ checkFalsy: true })
    .trim()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please enter a valid email address'),
    
  body('type')
    .notEmpty()
    .withMessage('Contact type is required')
    .isIn(['customer', 'vendor'])
    .withMessage('Type must be either customer or vendor'),
    
  body('address.street')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 })
    .withMessage('Street address cannot exceed 200 characters'),
    
  body('address.city')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 50 })
    .withMessage('City cannot exceed 50 characters'),
    
  body('address.state')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 50 })
    .withMessage('State cannot exceed 50 characters'),
    
  body('address.zipCode')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 20 })
    .withMessage('Zip code cannot exceed 20 characters'),
    
  body('address.country')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 50 })
    .withMessage('Country cannot exceed 50 characters'),

  body('latitude')
    .optional()
    .custom(validateNumericInput({ field: 'Latitude', min: -90, max: 90, nullable: true }))
    .withMessage('Latitude must be a number between -90 and 90')
    .bail()
    .customSanitizer(value => toFiniteNumber(value, {
      field: 'Latitude', min: -90, max: 90, nullable: true
    })),

  body('longitude')
    .optional()
    .custom(validateNumericInput({ field: 'Longitude', min: -180, max: 180, nullable: true }))
    .withMessage('Longitude must be a number between -180 and 180')
    .bail()
    .customSanitizer(value => toFiniteNumber(value, {
      field: 'Longitude', min: -180, max: 180, nullable: true
    })),
    
  body('notes')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Notes cannot exceed 500 characters'),
    
  body('creditLimit')
    .optional()
    // null preserves the previous API contract and represents no configured credit limit.
    .custom(validateNumericInput({
      field: 'Credit limit', min: 0, max: MAX_SAFE_NUMERIC_VALUE, nullable: true
    }))
    .withMessage('Credit limit must be a non-negative finite number')
    .bail()
    .customSanitizer(value => toFiniteNumber(value, {
      field: 'Credit limit', min: 0, max: MAX_SAFE_NUMERIC_VALUE, nullable: true
    }))
];

const updateContactValidation = [
  body('name')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),
    
  body('phone')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^\+?[\d\s\-\(\)]{7,20}$/)
    .withMessage('Please enter a valid phone number'),
    
  body('documentType')
    .optional({ checkFalsy: true })
    .trim()
    .isIn(['dni', 'ruc'])
    .withMessage('Document type must be dni or ruc'),

  body('documentNumber')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 8, max: 20 })
    .withMessage('Document number must be between 8 and 20 characters'),

  body('email')
    .optional({ checkFalsy: true })
    .trim()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please enter a valid email address'),
    
  body('type')
    .optional({ checkFalsy: true })
    .isIn(['customer', 'vendor'])
    .withMessage('Type must be either customer or vendor'),
    
  body('address.street')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 200 })
    .withMessage('Street address cannot exceed 200 characters'),
    
  body('address.city')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 50 })
    .withMessage('City cannot exceed 50 characters'),
    
  body('address.state')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 50 })
    .withMessage('State cannot exceed 50 characters'),
    
  body('address.zipCode')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 20 })
    .withMessage('Zip code cannot exceed 20 characters'),
    
  body('address.country')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 50 })
    .withMessage('Country cannot exceed 50 characters'),

  body('latitude')
    .optional()
    .custom(validateNumericInput({ field: 'Latitude', min: -90, max: 90, nullable: true }))
    .withMessage('Latitude must be a number between -90 and 90')
    .bail()
    .customSanitizer(value => toFiniteNumber(value, {
      field: 'Latitude', min: -90, max: 90, nullable: true
    })),

  body('longitude')
    .optional()
    .custom(validateNumericInput({ field: 'Longitude', min: -180, max: 180, nullable: true }))
    .withMessage('Longitude must be a number between -180 and 180')
    .bail()
    .customSanitizer(value => toFiniteNumber(value, {
      field: 'Longitude', min: -180, max: 180, nullable: true
    })),
    
  body('notes')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Notes cannot exceed 500 characters'),
    
  body('creditLimit')
    .optional()
    // null clears the configured limit without being coerced to zero.
    .custom(validateNumericInput({
      field: 'Credit limit', min: 0, max: MAX_SAFE_NUMERIC_VALUE, nullable: true
    }))
    .withMessage('Credit limit must be a non-negative finite number')
    .bail()
    .customSanitizer(value => toFiniteNumber(value, {
      field: 'Credit limit', min: 0, max: MAX_SAFE_NUMERIC_VALUE, nullable: true
    }))
];

const updateBalanceValidation = [
  body('amount')
    .custom(validateNumericInput({ field: 'Amount', min: 0, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Amount must be a non-negative finite number')
    .bail()
    .toFloat(),
    
  body('operation')
    .optional()
    .isIn(['set', 'add', 'subtract'])
    .withMessage('Operation must be one of: set, add, subtract')
];

// Transaction validations
const createTransactionValidation = [
  body('type')
    .notEmpty()
    .withMessage('Transaction type is required')
    .isIn(['sale', 'purchase'])
    .withMessage('Type must be either sale or purchase'),
    
  body('customerId')
    .optional({ checkFalsy: true })
    .isMongoId()
    .withMessage('Invalid customer ID'),

  body('customerId')
    .custom((value, { req }) => {
      if (req.body.type === 'sale' && req.body.paymentMethod === 'credit' && !value) {
        throw new Error('A registered customer is required for credit sales');
      }
      return true;
    }),
    
  body('vendorId')
    .if(body('type').equals('purchase'))
    .notEmpty()
    .withMessage('Vendor ID is required for purchases')
    .isMongoId()
    .withMessage('Invalid vendor ID'),
    
  body('products')
    .isArray({ min: 1 })
    .withMessage('At least one product is required'),
    
  body('products.*.productId')
    .notEmpty()
    .withMessage('Product ID is required')
    .isMongoId()
    .withMessage('Invalid product ID'),
    
  body('products.*.quantity')
    .custom(validateNumericInput({
      field: 'Product quantity', min: 1, max: MAX_SAFE_NUMERIC_VALUE, integer: true
    }))
    .bail()
    .isInt({ min: 1, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Quantity must be a positive safe integer')
    .bail()
    .toInt(),
    
  body('products.*.price')
    .optional()
    .custom(validateNumericInput({ field: 'Product price', min: 0, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Price must be a non-negative finite number')
    .bail()
    .toFloat(),

  body('products.*.costPrice')
    .optional()
    .custom(validateNumericInput({ field: 'Product cost price', min: 0, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Cost price must be a non-negative finite number')
    .bail()
    .toFloat(),
    
  body('paymentMethod')
    .optional()
    .isIn(['cash', 'card', 'bank_transfer', 'credit', 'wallet'])
    .withMessage('Invalid payment method'),

  body('currency')
    .optional()
    .trim()
    .toUpperCase()
    .isIn(['PEN', 'USD', 'EUR'])
    .withMessage('Currency must be one of: PEN, USD, EUR'),
    
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Notes cannot exceed 500 characters')
];

const updateTransactionStatusValidation = [
  body('status')
    .notEmpty()
    .withMessage('Status is required')
    .isIn(['pending', 'completed', 'cancelled'])
    .withMessage('Status must be one of: pending, completed, cancelled')
];

const productQueryValidation = [
  ...paginationValidation,
  query('minStock')
    .optional()
    .custom(validateNumericInput({
      field: 'Minimum stock filter', min: 0, max: MAX_SAFE_NUMERIC_VALUE, integer: true
    }))
    .bail()
    .isInt({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Minimum stock filter must be a non-negative safe integer')
    .bail()
    .toInt(),
  query('maxStock')
    .optional()
    .custom(validateNumericInput({
      field: 'Maximum stock filter', min: 0, max: MAX_SAFE_NUMERIC_VALUE, integer: true
    }))
    .bail()
    .isInt({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Maximum stock filter must be a non-negative safe integer')
    .bail()
    .toInt(),
  query('maxStock').custom((maxStock, { req }) => {
    if (maxStock !== undefined && req.query.minStock !== undefined && maxStock < req.query.minStock) {
      throw new Error('Maximum stock must be greater than or equal to minimum stock');
    }
    return true;
  })
];

const exchangeRateQueryValidation = [
  query('base')
    .optional()
    .trim()
    .toUpperCase()
    .isIn(['PEN', 'USD', 'EUR'])
    .withMessage('Base currency must be one of: PEN, USD, EUR'),
  query('target')
    .optional()
    .trim()
    .toUpperCase()
    .isIn(['PEN', 'USD', 'EUR'])
    .withMessage('Target currency must be one of: PEN, USD, EUR')
];

const paymentMethodQueryValidation = [
  query('amount')
    .optional()
    .custom(validateNumericInput({ field: 'Amount', min: 0, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Amount must be a non-negative finite number')
    .bail()
    .toFloat()
];

const createCreditPaymentValidation = [
  body('customerId')
    .isMongoId()
    .withMessage('Invalid customer ID'),
  body('amount')
    .custom(validateNumericInput({ field: 'Payment amount', min: 0.01, max: MAX_SAFE_NUMERIC_VALUE }))
    .bail()
    .isFloat({ min: 0.01, max: MAX_SAFE_NUMERIC_VALUE })
    .withMessage('Payment amount must be a finite number greater than zero')
    .bail()
    .toFloat(),
  body('currency')
    .optional()
    .trim()
    .toUpperCase()
    .isIn(['PEN', 'USD', 'EUR'])
    .withMessage('Currency must be one of: PEN, USD, EUR'),
  body('paymentMethod')
    .isIn(['cash', 'card', 'bank_transfer', 'wallet'])
    .withMessage('Invalid payment method'),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Notes cannot exceed 500 characters')
];

module.exports = {
  // Auth validations
  registerValidation,
  loginValidation,
  updateProfileValidation,
  changePasswordValidation,
  // Product validations
  createProductValidation,
  updateProductValidation,
  updateStockValidation,
  // Contact validations
  createContactValidation,
  updateContactValidation,
  updateBalanceValidation,
  // Transaction validations
  createTransactionValidation,
  updateTransactionStatusValidation,
  // Query and payment validations
  paginationValidation,
  limitValidation,
  productQueryValidation,
  exchangeRateQueryValidation,
  paymentMethodQueryValidation,
  createCreditPaymentValidation,
  MAX_PAGE,
  MAX_PAGE_SIZE
};
