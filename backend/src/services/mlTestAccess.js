'use strict';
const config = require('../config/v3Operational');
const mongoose = require('mongoose');
const F = require('./mlTestFence');
const fail = (code, httpStatus = 403) => { throw Object.assign(new Error(code), { code, httpStatus }); };
// Trusted session user only; never accept tenant/scenario/epoch from a body.
function authorizeAdminAction(user, body = {}, query = {}) {
  if (!user?._id) fail('ML_TEST_AUTH_REQUIRED', 401);
  if (!user?._id || user.isActive !== true || user.role !== 'admin') fail('ML_TEST_ADMIN_REQUIRED');
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('ML_TEST_SCOPE_FORBIDDEN');
  if (!query || typeof query !== 'object' || Array.isArray(query)) fail('ML_TEST_SCOPE_FORBIDDEN');
  if (user.businessId !== config.businessId || ['businessId', 'scenarioId', 'resetEpoch', 'testCycleId'].some(key => key in body || key in query)) {
    fail('ML_TEST_SCOPE_FORBIDDEN');
  }
  return { businessId: config.businessId, scenarioId: config.scenarioId };
}
async function readStatus(user, db = mongoose.connection.db) {
  if (user?.businessId !== config.businessId) return { state: 'NO_TEST', resetEpoch: '0', testCycleId: null, maintenance: false, cloudRestoreEnabled: false };
  if (!db) throw Object.assign(new Error('ML_TEST_STATUS_UNAVAILABLE'), { code: 'ML_TEST_STATUS_UNAVAILABLE' });
  const token = await F.capture(db);
  return { state: token.state, resetEpoch: token.resetEpoch, testCycleId: token.testCycleId,
    maintenance: !['NO_TEST', 'TEST_ACTIVE'].includes(token.state), cloudRestoreEnabled: false };
}
// This guard runs after authentication, before critical reads AND writes.
async function maintenanceGuard(req, res, next, db = mongoose.connection.db) {
  if (req.user?.businessId !== config.businessId || /^\/api\/intelligence\/test-control\/status(?:\?|$)/.test(req.originalUrl || '')) return next();
  try {
    const status = await readStatus(req.user, db);
    if (!status.maintenance) return next();
    return res.status(503).set('Cache-Control', 'no-store').json({ success: false, code: 'ML_TEST_MAINTENANCE',
      message: status.state === 'RESTORING' ? 'Restableciendo prueba…' : 'Prueba bloqueada hasta recuperación administrativa.' });
  } catch {
    return res.status(503).set('Cache-Control', 'no-store').json({ success: false, code: 'ML_TEST_STATUS_UNAVAILABLE', message: 'Estado de prueba temporalmente no disponible.' });
  }
}
module.exports = { authorizeAdminAction, readStatus, maintenanceGuard };
