const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');
const { createInventoryAlertDispatcher, receiveAlertEvent } = require('../services/inventoryAlertOutbox');
const { createInventoryAlertChannels } = require('../services/inventoryAlertChannels');
const sameSecret = (value, expected) => typeof value === 'string' && typeof expected === 'string' && expected.length >= 32
  && timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(expected).digest());
const createInventoryAlertDispatchRoutes = ({ dispatcher = createInventoryAlertDispatcher(), receive = receiveAlertEvent,
  channels = createInventoryAlertChannels(),
  config = () => process.env } = {}) => {
  const router = express.Router();
  router.use((req, res, next) => {
    const settings = config();
    const nodeRedRequest = ['/receipt', '/channels/process'].includes(req.path);
    const expected = nodeRedRequest ? settings.NODE_RED_WEBHOOK_SECRET : settings.INVENTORY_ALERT_DISPATCH_SECRET;
    if (!nodeRedRequest && expected === settings.NODE_RED_WEBHOOK_SECRET) {
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
  router.post('/channels/process', async (req, res) => {
    if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.eventId !== 'string') {
      return res.status(400).json({ success: false, code: 'INVALID_CHANNEL_REQUEST' });
    }
    try {
      const result = await channels.process(req.body.eventId);
      if (!result) return res.status(400).json({ success: false, code: 'INVALID_ALERT_EVENT' });
      res.json({ success: true, ...result });
    } catch { res.status(503).json({ success: false, code: 'CHANNEL_UNAVAILABLE' }); }
  });
  router.post('/channels/run', async (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length) return res.status(400).json({ success: false, code: 'INVALID_CHANNEL_REQUEST' });
    try { res.json({ success: true, ...await channels.run() }); }
    catch { res.status(503).json({ success: false, code: 'CHANNEL_UNAVAILABLE' }); }
  });
  return router;
};
module.exports = { createInventoryAlertDispatchRoutes, sameSecret };
