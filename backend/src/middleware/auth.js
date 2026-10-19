const { verifyToken } = require('../utils/jwt');
const { User } = require('../models');
const ADMIN_ML_LIFECYCLE_PATH = /^\/api\/ml-test\/(?:checkpoint|restore|recover-failed-checkpoint|recover-stale-checkpoint|purge-failed-checkpoint-payloads)(?:\?|$)/;

function shouldApplyBusinessWriterFence(method, businessId, originalUrl) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method)
    && businessId === require('../config/v3Operational').businessId
    && !ADMIN_ML_LIFECYCLE_PATH.test(originalUrl || '');
}

/**
 * Authentication middleware
 * Verifies JWT token and attaches user to request
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    // Extract token from Bearer token
    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : authHeader;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Invalid token format.'
      });
    }

    // Verify token
    const decoded = verifyToken(token);
    
    if (!decoded || !decoded.id) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Invalid token payload.'
      });
    }
    
    // Get user from database
    const user = await User.findById(decoded.id).select('-password');
    
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. User not found or inactive.'
      });
    }

    // Validate user has required fields
    if (!user.businessId) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user data. Business ID not found.'
      });
    }

    // Attach user to request
    req.user = user;
    let continueRequest = false;
    await require('../services/mlTestAccess').maintenanceGuard(req, res, () => { continueRequest = true; });
    if (!continueRequest) return;
    // Administrative lifecycle owns its maintenance/CAS fencing. The allowlist
    // is limited to these routes; each still applies route-level admin, target,
    // feature-flag and operation-specific validation.
    if (shouldApplyBusinessWriterFence(req.method, user.businessId, req.originalUrl)) {
      const fence = require('../services/mlTestFence');
      return await fence.runCycle(() => fence.untilResponseFinished(res, next));
    }
    next();

  } catch (error) {
    if (/^(?:TEST|STALE_TEST)_/.test(error.code || '')) {
      if (res.headersSent) return;
      return res.status(503).json({ success: false, code: 'ML_TEST_MAINTENANCE',
        message: 'Operación temporalmente bloqueada por el control de prueba.' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Invalid token.'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Token expired.'
      });
    }

    console.error('Authentication error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during authentication.'
    });
  }
};

/**
 * Authorization middleware
 * Checks if user has required role
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. User not authenticated.'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.'
      });
    }

    next();
  };
};

/**
 * Business access middleware - Updated
 * Ensures user can only access data from their business
 */
const checkBusinessAccess = (req, res, next) => {
  try {
    // Validate request object
    if (!req) {
      return res.status(500).json({ success: false, message: 'Invalid request object' });
    }

    // Check if user is authenticated
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. User not authenticated.'
      });
    }

    // Check if user has businessId
    if (!req.user.businessId) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user data. Business ID not found.'
      });
    }

    // Set businessId for the request
    req.businessId = req.user.businessId;
    
    // Continue to next middleware
    next();
  } catch (error) {
    console.error('checkBusinessAccess error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error in business access check.'
    });
  }
};

module.exports = {
  authenticate,
  authorize,
  checkBusinessAccess,
  shouldApplyBusinessWriterFence
};
