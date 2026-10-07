const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const { createGeminiSmokeHandler } = require('../controllers/agentSmokeController');

const createAgentRoutes = ({ enabled, providerFactory, authenticateMiddleware = authenticate,
  businessAccessMiddleware = checkBusinessAccess } = {}) => {
  const router = express.Router();
  const smokeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 3,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: req => req.user._id.toString(),
    message: { success: false, code: 'AGENT_SMOKE_RATE_LIMITED', message: 'Too many smoke requests. Try again later.' }
  });
  router.post('/smoke', authenticateMiddleware, businessAccessMiddleware, smokeLimiter,
    createGeminiSmokeHandler({ enabled, providerFactory }));
  return router;
};

module.exports = createAgentRoutes;
