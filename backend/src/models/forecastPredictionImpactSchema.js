'use strict';
const mongoose = require('mongoose');
const P = require('../services/forecastPredictionImpactDomain');
const options = { _id: false, strict: 'throw' };
const number = { type: Number, default: null, validate: value => value === null || Number.isFinite(value) };
const product = new mongoose.Schema({ sku: { type: String, required: true, maxlength: 160 },
  productName: { type: String, default: null, maxlength: 200 } }, options);
const snapshot = new mongoose.Schema({ businessId: String, scenarioId: String, dataVersion: String,
  asOf: String, capturedAtUtc: String, observationsClosedThrough: String, snapshotHash: String,
  universeHash: String, historicalDatasetSha256: String,
  products: { type: [product], validate: rows => rows.length <= P.MAX_PRODUCTS } }, options);
const difference = new mongoose.Schema({ old: number, new: number, delta: number, deltaPct: number,
  direction: { type: String, required: true, enum: ['UNCHANGED', 'INCREASED', 'DECREASED', 'NOT_COMPARABLE'] } }, options);
const counts = new mongoose.Schema({ increasedCount: Number, decreasedCount: Number,
  unchangedCount: Number, notComparableCount: Number }, options);
const summary = new mongoose.Schema({ totalProductsEvaluated: Number, comparableProductsCount: Number,
  predictionChangedCount: Number, predictionUnchangedCount: Number, notComparableCount: Number,
  p7: counts, p14: counts }, options);
const detail = new mongoose.Schema({ sku: { type: String, required: true, maxlength: 160 },
  productName: { type: String, default: null, maxlength: 200 }, p7: difference, p14: difference }, options);
module.exports = new mongoose.Schema({ kind: { type: String, enum: ['MODEL_ATTRIBUTED_IMPACT'], required: true },
  captureReason: { type: String, default: null, enum: [...Object.keys(require('../services/forecastMlUpdateExecutionDomain').REASONS), null] },
  snapshot: { type: snapshot, default: null }, idempotencyKey: { type: String, match: /^[a-f0-9]{64}$/ },
  versions: { type: [new mongoose.Schema({ horizonDays: { type: Number, enum: [7, 14] },
    beforeVersion: number, afterVersion: number }, options)], default: undefined },
  summary: { type: summary, default: undefined },
  detail: { type: [detail], default: undefined, validate: rows => rows == null || rows.length <= P.MAX_PRODUCTS },
  finalizedAt: { type: Date, default: undefined } }, options);
