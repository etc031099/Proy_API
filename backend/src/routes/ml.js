const express = require('express');
const { getDemandForecast } = require('../controllers/mlController');
const { authenticate, checkBusinessAccess } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate, checkBusinessAccess);
router.get('/demand-forecast', getDemandForecast);

module.exports = router;
