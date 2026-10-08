const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const { createGeminiSmokeHandler } = require('../controllers/agentSmokeController');
const { createAgentMessagesHandler } = require('../controllers/agentMessagesController');
const { logAgentEvent } = require('../controllers/agentMessagesController');
const { createAgentOrchestrator } = require('../agents/orchestrator');
const { createAgentConversationService } = require('../services/agentConversationService');
const { createAgentHistoryHandler } = require('../controllers/agentHistoryController');
const { createActionService } = require('../automations/execution');
const { withActionAssistant } = require('../automations/assistant');
const { createAgentActionHandler } = require('../controllers/agentActionsController');

const createAgentRoutes = ({ enabled, providerFactory, orchestrator, historyService, actionService = createActionService(), authenticateMiddleware = authenticate,
  businessAccessMiddleware = checkBusinessAccess } = {}) => {
  const router = express.Router();
  const runtime = withActionAssistant(orchestrator || createAgentOrchestrator({ onEvent: logAgentEvent }), actionService, { onEvent: logAgentEvent });
  const history = historyService || createAgentConversationService({ runtime, actionService });
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
  const messagesLimiter = rateLimit({
    windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => req.user._id.toString(),
    message: { success: false, code: 'AGENT_RATE_LIMITED', message: 'Demasiadas consultas. Inténtalo más tarde.' }
  });
  router.post('/messages', authenticateMiddleware, businessAccessMiddleware, messagesLimiter,
    createAgentMessagesHandler({ enabled, orchestrator: runtime, history }));
  for (const decision of ['confirm', 'cancel']) router.post(`/actions/:id/${decision}`,
    authenticateMiddleware, businessAccessMiddleware, messagesLimiter, createAgentActionHandler({ enabled, service: actionService, decision }));
  const historyLimiter = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => req.user._id.toString(), message: { success: false, code: 'AGENT_RATE_LIMITED', message: 'Demasiadas solicitudes de historial.' } });
  router.get('/conversations', authenticateMiddleware, businessAccessMiddleware, historyLimiter,
    createAgentHistoryHandler({ enabled, history, operation: 'list' }));
  router.get('/conversations/:conversationId', authenticateMiddleware, businessAccessMiddleware, historyLimiter,
    createAgentHistoryHandler({ enabled, history, operation: 'get' }));
  router.delete('/conversations/:conversationId', authenticateMiddleware, businessAccessMiddleware, historyLimiter,
    createAgentHistoryHandler({ enabled, history, operation: 'remove' }));
  return router;
};

module.exports = createAgentRoutes;
