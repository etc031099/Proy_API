const express = require('express');
const { createCreditPayment, getCustomerCreditPayments } = require('../controllers/creditPaymentController');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const { validateRequest } = require('../middleware/validation');
const { createCreditPaymentValidation } = require('../utils/validations');

const router = express.Router();
router.use(authenticate, checkBusinessAccess);
router.post('/', createCreditPaymentValidation, validateRequest, createCreditPayment);
router.get('/customer/:customerId', getCustomerCreditPayments);

module.exports = router;
