'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const { createV3BusinessIntelligenceDashboard } = require('../services/v3BusinessIntelligenceDashboard');
const { getCertifiedStable2020Replay } = require('../services/forecastReplayCertificateService');

const createBusinessIntelligenceDashboardRoutes = ({ service, authenticateMiddleware = authenticate,
  businessAccessMiddleware = checkBusinessAccess } = {}) => {
  const router = express.Router();
  const dashboard = service || createV3BusinessIntelligenceDashboard();
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => `${req.user.businessId}:${req.user._id}`,
    message: { success: false, code: 'ANALYTICS_RATE_LIMITED', message: 'Demasiadas consultas de analítica. Inténtalo más tarde.' } });
  const endpoint = method => async (req, res) => {
    if (['revision', 'forecast', 'activeForecastModels', 'healthDiagnostic'].includes(method)) res.set('Cache-Control', 'no-store');
    const result = await dashboard[method](req);
    if (result.error) return res.status(result.error.httpStatus).json({ success: false,
      code: result.error.code, message: result.error.message,
      ...(Array.isArray(result.error.candidates) ? { candidates: result.error.candidates } : {}) });
    return res.json({ success: true, data: result.data });
  };
  router.use(authenticateMiddleware, businessAccessMiddleware, limiter);
  router.get('/test-control/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json({ success: true, data: await require('../services/mlTestAccess').readStatus(req.user) }); }
    catch { return res.status(503).json({ success: false, code: 'ML_TEST_STATUS_UNAVAILABLE' }); }
  });
  router.get('/revision', endpoint('revision'));
  router.get('/summary', endpoint('summary'));
  router.get('/sales', endpoint('sales'));
  router.get('/sales/anomalies', endpoint('salesAnomalies'));
  router.get('/customers', endpoint('customers'));
  router.get('/customers/clustering', endpoint('customerClustering'));
  router.get('/customers/:customerRef', endpoint('customer'));
  router.get('/suppliers', endpoint('suppliers'));
  router.get('/suppliers/:supplierRef', endpoint('supplier'));
  router.get('/associations', endpoint('associations'));
  router.get('/products/:sku/related', endpoint('productRelated'));
  router.get('/health', endpoint('health'));
  router.get('/health/diagnostics', endpoint('healthDiagnostic'));
  router.get('/inventory', endpoint('inventory'));
  router.get('/forecast/evaluation', endpoint('forecastEvaluation'));
  router.get('/forecast/replay/certified-stable-2020', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query || {}).length > 0) {
      return res.status(400).json({ success: false, code: 'FORECAST_REPLAY_SELECTION_NOT_ALLOWED' });
    }
    return res.json({ success: true, data: getCertifiedStable2020Replay() });
  });
  router.get('/forecast/models/active', endpoint('activeForecastModels'));
  router.get('/products/:sku/forecast', endpoint('forecast'));
  router.get('/products/:sku/inventory', endpoint('productInventory'));
  return router;
};

module.exports = { createBusinessIntelligenceDashboardRoutes };
