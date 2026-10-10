const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');
const { createInventoryAlertDispatcher, receiveAlertEvent } = require('../services/inventoryAlertOutbox');
const sameSecret = (value, expected) => typeof value === 'string' && typeof expected === 'string' && expected.length >= 32
  && timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(expected).digest());
const createInventoryAlertDispatchRoutes = ({ dispatcher = createInventoryAlertDispatcher(), receive = receiveAlertEvent,
  config = () => process.env } = {}) => {
  const router = express.Router();
  router.use((req, res, next) => {
    const settings = config();
    const expected = req.path === '/receipt' ? settings.NODE_RED_WEBHOOK_SECRET : settings.INVENTORY_ALERT_DISPATCH_SECRET;
    if (req.path !== '/receipt' && expected === settings.NODE_RED_WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, code: 'INTERNAL_UNAUTHORIZED' });
    }
    if (!sameSecret(req.get('X-Internal-Secret'), expected)) return res.status(401).json({ success: false, code: 'INTERNAL_UNAUTHORIZED' });
    next();
  });
  router.post('/run', async (req, res) => {
    if (!req.body || Object.keys(req.body).length) return res.status(400).json({ success: false, code: 'INVALID_DISPATCH_REQUEST' });
    try { res.json({ success: true, ...await dispatcher.run() }); }
    catch { res.status(503).json({ success: false, code: 'DISPATCH_UNAVAILABLE' }); }
  });
  router.post('/receipt', async (req, res) => {
    try {
      const result = await receive(req.body);
      if (!result) return res.status(400).json({ success: false, code: 'INVALID_ALERT_EVENT' });
      res.json(result);
    } catch { res.status(503).json({ success: false, code: 'RECEIPT_UNAVAILABLE' }); }
  });
  return router;
};
module.exports = { createInventoryAlertDispatchRoutes, sameSecret };
