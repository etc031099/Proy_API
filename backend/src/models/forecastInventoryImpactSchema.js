'use strict';
const mongoose = require('mongoose');
const P = require('../services/forecastPredictionImpactDomain');
const D = require('../services/forecastMlUpdateExecutionDomain');
const options = { _id: false, strict: 'throw' };
const number = { type: Number, default: null, validate: v => v === null || Number.isFinite(v) };
const bool = { type: Boolean, default: null };
const risk = { type: String, default: null, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', null] };
const pair = new mongoose.Schema({ before: number, after: number, delta: number }, options);
const detail = new mongoose.Schema({ sku: { type: String, required: true, maxlength: 160 },
  productName: { type: String, default: null, maxlength: 200 },
  risk: new mongoose.Schema({ before: risk, after: risk, changed: bool }, options),
  shouldReorder: new mongoose.Schema({ before: bool, after: bool, changed: bool }, options),
  recommendedQty: pair, reorderPoint: pair,
  coverage: new mongoose.Schema({ daysCoverBefore: number, daysCoverAfter: number, delta: number }, options),
  ranking: new mongoose.Schema({ positionBefore: number, positionAfter: number, delta: number,
    status: { type: String, enum: ['COMPARABLE', 'NOT_COMPARABLE'] } }, options),
  availability: new mongoose.Schema({ before: { type: String, enum: ['AVAILABLE', 'PARTIAL'] },
    after: { type: String, enum: ['AVAILABLE', 'PARTIAL'] },
    reasonCodesBefore: { type: [String], validate: r => r.length <= 32 },
    reasonCodesAfter: { type: [String], validate: r => r.length <= 32 } }, options),
}, options);
const summary = new mongoose.Schema(Object.fromEntries(['totalProductsEvaluated', 'comparableProductsCount',
  'riskChangedCount', 'reorderDecisionChangedCount', 'recommendedQtyChangedCount', 'reorderPointChangedCount',
  'coverageChangedCount', 'rankingChangedCount', 'unavailableCount', 'notComparableCount'].map(key => [key,
  { type: Number, min: 0, validate: Number.isSafeInteger }])), options);
module.exports = new mongoose.Schema({ kind: { type: String, required: true, enum: ['MODEL_ATTRIBUTED_INVENTORY_IMPACT'] },
  status: { type: String, required: true, enum: ['PENDING', 'COMPLETE', 'PARTIAL', 'NOT_CAPTURED'] },
  reasonCode: { type: String, default: null, enum: [...Object.keys(D.REASONS), null] },
  idempotencyKey: { type: String, match: /^[a-f0-9]{64}$/ }, predictionIdentity: { type: String, match: /^[a-f0-9]{64}$/ },
  rankingMetric: { type: String, enum: ['stockout_risk'] },
  summary: { type: summary, default: undefined },
  details: { type: [detail], default: undefined, validate: rows => rows == null || rows.length <= P.MAX_PRODUCTS },
  completedAt: { type: Date, default: undefined },
}, options);
