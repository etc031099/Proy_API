'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const { createForecastManualUpdateService } = require('../services/forecastManualUpdateService');

function createForecastMlUpdateRoutes({ service, historyService, authenticateMiddleware = authenticate,
  businessAccessMiddleware = checkBusinessAccess } = {}) {
  const router = express.Router();
  const api = service || createForecastManualUpdateService();
  const history = historyService || require('../services/forecastMlUpdateHistoryService').createForecastMlUpdateHistoryService();
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
  const historyHandle = method => async (req, res) => {
    try { return res.json({ success: true, data: await history[method](req) }); }
    catch (error) {
      const code = ['ML_HISTORY_CURSOR_INVALID', 'ML_HISTORY_FILTER_INVALID', 'ML_HISTORY_LIMIT_INVALID'].includes(error.code)
        ? error.code : error.code === 'AUTH_REQUIRED' ? error.code
          : error.code === 'ML_SCOPE_UNAVAILABLE' ? error.code
            : error.code === 'ML_HISTORY_EXECUTION_NOT_FOUND' ? error.code : 'ML_HISTORY_UNAVAILABLE';
      const status = ['ML_HISTORY_CURSOR_INVALID', 'ML_HISTORY_FILTER_INVALID', 'ML_HISTORY_LIMIT_INVALID'].includes(code)
        ? 400 : code === 'AUTH_REQUIRED' ? 401 : code === 'ML_SCOPE_UNAVAILABLE' ? 403
          : code === 'ML_HISTORY_EXECUTION_NOT_FOUND' ? 404 : 503;
      return res.status(status).json({ success: false, code });
    }
  };
  router.get('/history', limiter(60), historyHandle('list'));
  router.get('/history/:executionId/products', limiter(60), historyHandle('products'));
  router.get('/history/:executionId', limiter(60), historyHandle('get'));
  return router;
}

module.exports = { createForecastMlUpdateRoutes };
