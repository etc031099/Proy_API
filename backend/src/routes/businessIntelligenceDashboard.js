'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const { createV3BusinessIntelligenceDashboard } = require('../services/v3BusinessIntelligenceDashboard');

const createBusinessIntelligenceDashboardRoutes = ({ service, authenticateMiddleware = authenticate,
  businessAccessMiddleware = checkBusinessAccess } = {}) => {
  const router = express.Router();
  const dashboard = service || createV3BusinessIntelligenceDashboard();
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => `${req.user.businessId}:${req.user._id}`,
    message: { success: false, code: 'ANALYTICS_RATE_LIMITED', message: 'Demasiadas consultas de analítica. Inténtalo más tarde.' } });
  const endpoint = method => async (req, res) => {
    const result = await dashboard[method](req);
    if (result.error) return res.status(result.error.httpStatus).json({ success: false,
      code: result.error.code, message: result.error.message });
    return res.json({ success: true, data: result.data });
  };
  router.use(authenticateMiddleware, businessAccessMiddleware, limiter);
  router.get('/summary', endpoint('summary'));
  router.get('/inventory', endpoint('inventory'));
  router.get('/products/:sku/forecast', endpoint('forecast'));
  router.get('/products/:sku/inventory', endpoint('productInventory'));
  return router;
};

module.exports = { createBusinessIntelligenceDashboardRoutes };
