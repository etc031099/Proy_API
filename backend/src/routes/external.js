const express = require('express');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/validation');
const {
  getExchangeRate,
  validateDocument,
  validatePaymentMethod
} = require('../services/externalApiService');

const router = express.Router();

router.use(authenticate);
router.use(checkBusinessAccess);

router.get('/exchange-rate', asyncHandler(async (req, res) => {
  const { base, target } = req.query;
  const result = await getExchangeRate({ base, target });

  res.json({
    success: true,
    data: result
  });
}));

router.get('/document/validate', asyncHandler(async (req, res) => {
  const { type, number } = req.query;
  const result = await validateDocument({ type, number });

  res.json({
    success: true,
    data: result
  });
}));

router.get('/payment-method/validate', asyncHandler(async (req, res) => {
  const { method, amount } = req.query;
  const result = await validatePaymentMethod({
    method,
    amount: amount === undefined ? 0 : Number(amount)
  });

  res.json({
    success: true,
    data: result
  });
}));

module.exports = router;
