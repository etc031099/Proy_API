const express = require('express');
const {
  getInventoryReport,
  getTransactionReport,
  getCustomerReport,
  getVendorReport,
  getDashboardSummary
} = require('../controllers/reportController');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');

const router = express.Router();

// Apply authentication and business access middleware to all routes
router.use(authenticate);
router.use(checkBusinessAccess);

// Report routes
router.get('/dashboard', getDashboardSummary);
router.get('/inventory', require('../utils/validations').paginationValidation,
  require('express-validator').query('search').optional().isString().trim().isLength({ max: 100 }),
  require('express-validator').query('category').optional().isString().trim().isLength({ max: 100 }),
  require('../middleware/validation').validateRequest, getInventoryReport);
router.get('/transactions', getTransactionReport);
router.get('/customer/:id', getCustomerReport);
router.get('/vendor/:id', getVendorReport);

module.exports = router;
