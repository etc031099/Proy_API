'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const { createForecastManualUpdateService } = require('../services/forecastManualUpdateService');

function createForecastMlUpdateRoutes({ service, authenticateMiddleware = authenticate,
  businessAccessMiddleware = checkBusinessAccess } = {}) {
  const router = express.Router();
  const api = service || createForecastManualUpdateService();
  router.use(authenticateMiddleware, businessAccessMiddleware);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const limiter = limit => rateLimit({ windowMs: 60_000, limit,
    standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => `${req.user.businessId}:${req.user._id}`,
    message: { success: false, code: 'ML_UPDATE_RATE_LIMITED' } });
  const handle = method => async (req, res) => {
    try {
      const data = await api[method](req);
      return res.status(method === 'request' && data.requestStatus === 'REQUEST_ACCEPTED' ? 202 : 200)
        .json({ success: true, data });
    } catch (error) {
      // Only locally defined API errors escape; never echo dependency messages.
      const safe = new Set(['AUTH_REQUIRED', 'ML_SCOPE_UNAVAILABLE', 'ML_REQUEST_FIELDS_NOT_ALLOWED',
        'ML_UPDATE_RATE_LIMITED', 'ML_REVISION_UNAVAILABLE', 'ACTIVE_MODEL_REQUIRED']);
      return res.status(safe.has(error.code) ? error.httpStatus : 503).json({ success: false,
        code: safe.has(error.code) ? error.code : 'ML_UPDATE_UNAVAILABLE' });
    }
  };
  router.post('/request', limiter(10), handle('request'));
  router.get('/status', limiter(60), handle('status'));
  return router;
}

module.exports = { createForecastMlUpdateRoutes };
