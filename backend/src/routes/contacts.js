const express = require('express');
const {
  getContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  getCustomers,
  getVendors,
  updateContactBalance,
  searchContacts
} = require('../controllers/contactController');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const { validateRequest } = require('../middleware/validation');
const {
  createContactValidation,
  updateContactValidation,
  updateBalanceValidation,
  paginationValidation,
  limitValidation
} = require('../utils/validations');

const router = express.Router();
const searchValidation = require('express-validator').query('search').optional().isString().trim().isLength({ max: 100 });

// Apply authentication and business access middleware to all routes
router.use(authenticate);
router.use(checkBusinessAccess);

// Contact CRUD routes
router.get('/', paginationValidation, searchValidation, require('express-validator').query('type').optional().isIn(['customer', 'vendor']), validateRequest, getContacts);
router.post('/', createContactValidation, validateRequest, createContact);

// Special routes (must come before :id routes)
router.get('/customers', paginationValidation, searchValidation, validateRequest, getCustomers);
router.get('/vendors', paginationValidation, searchValidation, validateRequest, getVendors);
router.get('/search/:term', limitValidation, validateRequest, searchContacts);

// Individual contact routes
router.get('/:id', getContact);
router.put('/:id', updateContactValidation, validateRequest, updateContact);
router.delete('/:id', deleteContact);
router.patch('/:id/balance', updateBalanceValidation, validateRequest, updateContactBalance);

module.exports = router;
