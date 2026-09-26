const mongoose = require('mongoose');
const { createDemandForecastService, DemandForecastError } = require('../services/demandForecastService');

const forecastService = createDemandForecastService();

const getDemandForecast = async (req, res, next) => {
  try {
    const productId = req.query.productId || null;
    if (productId && !mongoose.isObjectIdOrHexString(productId)) {
      return res.status(400).json({ success: false, code: 'INVALID_PRODUCT_ID', message: 'productId is invalid' });
    }
    const result = await forecastService.getDemandForecast({
      businessId: req.businessId,
      productId
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof DemandForecastError) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message
      });
    }
    return next(error);
  }
};

module.exports = { getDemandForecast };
