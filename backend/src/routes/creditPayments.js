const express = require('express');
const { createCreditPayment, getCustomerCreditPayments } = require('../controllers/creditPaymentController');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, checkBusinessAccess);
router.post('/', createCreditPayment);
router.get('/customer/:customerId', getCustomerCreditPayments);

module.exports = router;
