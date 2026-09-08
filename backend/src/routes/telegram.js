const express = require('express');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const {
  getStatus,
  generateConnectionCode,
  disconnectTelegram
} = require('../controllers/telegramController');

const router = express.Router();
router.use(authenticate);
router.use(checkBusinessAccess);
router.get('/status', getStatus);
router.post('/connect/code', generateConnectionCode);
router.delete('/connection', disconnectTelegram);

module.exports = router;
