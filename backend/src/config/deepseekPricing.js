'use strict';
const { deepFreeze } = require('../agents/contracts');

// USD per 1M tokens. Source: https://api-docs.deepseek.com/quick_start/pricing/
// Verified 2026-10-15. Calendar classification is deliberately not inferred.
const DEEPSEEK_PRICES = deepFreeze([{
  provider: 'deepseek', model: 'deepseek-flash', currency: 'USD', unit: 1000000,
  version: 'deepseek-flash-2026-10-15', effectiveFrom: '2026-08-16', verifiedAt: '2026-10-15',
  offPeak: { cacheHitInput: 0.003, cacheMissInput: 0.15, output: 0.60 },
  peak: { cacheHitInput: 0.006, cacheMissInput: 0.30, output: 1.20 }
}]);
module.exports = { DEEPSEEK_PRICES };
