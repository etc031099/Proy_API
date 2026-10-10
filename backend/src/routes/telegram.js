const express = require('express');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');
const {
  getStatus,
  generateConnectionCode,
  disconnectTelegram,
  updatePreferences
} = require('../controllers/telegramController');

const router = express.Router();
router.use(authenticate);
router.use(checkBusinessAccess);
router.get('/status', getStatus);
router.patch('/preferences', updatePreferences);
router.post('/connect/code', generateConnectionCode);
router.delete('/connection', disconnectTelegram);

module.exports = router;
