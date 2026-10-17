'use strict';

const config = require('../config/v3Operational');
const D = require('./forecastMlUpdateExecutionDomain');
const LIMIT_DEFAULT = 20, LIMIT_MAX = 50, PRODUCT_LIMIT_DEFAULT = 25, PRODUCT_LIMIT_MAX = 50;
const fail = (code, httpStatus = 400) => { throw Object.assign(new Error(code), { code, httpStatus }); };
const time = value => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
const enumValue = (value, allowed, fallback = null) => allowed.includes(value) ? value : fallback;
const reasonCode = value => value == null ? null : D.safeReason(value);
const finiteOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const reasonCodes = values => Array.isArray(values) ? values.slice(0, 32).map(reasonCode) : [];
const isoFilter = (value, isTo) => {
  if (typeof value !== 'string') fail('ML_HISTORY_FILTER_INVALID');
  if (D.validDay(value)) return new Date(`${value}T${isTo ? '23:59:59.999' : '00:00:00.000'}Z`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail('ML_HISTORY_FILTER_INVALID');
  return parsed;
};
const encodeCursor = payload => Buffer.from(JSON.stringify(payload)).toString('base64url');
function decodeCursor(raw, expected, extraKeys = []) {
  if (typeof raw !== 'string' || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) fail('ML_HISTORY_CURSOR_INVALID');
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const payload = JSON.parse(decoded);
    const expectedKeys = [...Object.keys(expected), ...extraKeys].sort();
    if (encodeCursor(payload) !== raw || !payload || Object.keys(payload).sort().join(',') !== expectedKeys.join(',')
        || Object.entries(expected).some(([key, value]) => payload[key] !== value)) fail('ML_HISTORY_CURSOR_INVALID');
    return payload;
  } catch (error) { if (error.code === 'ML_HISTORY_CURSOR_INVALID') throw error; fail('ML_HISTORY_CURSOR_INVALID'); }
}
function scoped(req) {
  const businessId = req.user?.businessId;
  if (!businessId) fail('AUTH_REQUIRED', 401);
  if (businessId !== config.businessId) fail('ML_SCOPE_UNAVAILABLE', 403);
  return { businessId, scenarioId: config.scenarioId };
}
function parseLimit(value, fallback, maximum, code) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})$/.test(value)) fail(code);
  const number = Number(value);
  if (number < 1 || number > maximum) fail(code);
  return number;
}
function parseListQuery(query, scope) {
  const allowed = ['limit', 'cursor', 'triggerSource', 'status', 'from', 'to', 'promotedOnly'];
  if (!query || Object.keys(query).some(key => !allowed.includes(key))) fail('ML_HISTORY_FILTER_INVALID');
  const parsed = { scope, limit: parseLimit(query.limit, LIMIT_DEFAULT, LIMIT_MAX, 'ML_HISTORY_LIMIT_INVALID') };
  if (query.triggerSource !== undefined) {
    if (!['MANUAL', 'SCHEDULED', 'CLI'].includes(query.triggerSource)) fail('ML_HISTORY_FILTER_INVALID');
    parsed.triggerSource = query.triggerSource;
  }
  if (query.status !== undefined) {
    if (!D.STATUSES.includes(query.status)) fail('ML_HISTORY_FILTER_INVALID');
    parsed.status = query.status;
  }
  if (query.promotedOnly !== undefined) {
    if (!['true', 'false'].includes(query.promotedOnly)) fail('ML_HISTORY_FILTER_INVALID');
    parsed.promotedOnly = query.promotedOnly === 'true';
  }
  if (query.from !== undefined) parsed.from = isoFilter(query.from, false);
  if (query.to !== undefined) parsed.to = isoFilter(query.to, true);
  if (parsed.from && parsed.to && parsed.from > parsed.to) fail('ML_HISTORY_FILTER_INVALID');
  if (query.cursor !== undefined) {
    parsed.cursorPayload = decodeCursor(query.cursor, { v: 1, k: 'list', ...scope,
      ...(parsed.triggerSource ? { triggerSource: parsed.triggerSource } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
      ...(parsed.from ? { from: parsed.from.toISOString() } : {}),
      ...(parsed.to ? { to: parsed.to.toISOString() } : {}),
      ...(parsed.promotedOnly !== undefined ? { promotedOnly: parsed.promotedOnly } : {}),
    }, ['requestedAt', 'executionId']);
    if (typeof parsed.cursorPayload.requestedAt !== 'string'
        || !D.validDay(parsed.cursorPayload.requestedAt.slice(0, 10))
        || !Number.isFinite(Date.parse(parsed.cursorPayload.requestedAt))
        || new Date(parsed.cursorPayload.requestedAt).toISOString() !== parsed.cursorPayload.requestedAt
        || typeof parsed.cursorPayload.executionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(parsed.cursorPayload.executionId)) {
      fail('ML_HISTORY_CURSOR_INVALID');
    }
  }
  return parsed;
}
function horizonSummary(rows) {
  const byHorizon = new Map((Array.isArray(rows) ? rows : []).map(row => [row.horizonDays, row]));
  return [7, 14].map(horizonDays => {
    const h = byHorizon.get(horizonDays);
    return { horizonDays, activeVersionBefore: h?.activeVersionBefore ?? null,
      activeVersionAfter: h?.activeVersionAfter ?? null, candidateVersion: h?.candidateVersion ?? null,
      resultStatus: enumValue(h?.resultStatus, D.STATUSES, 'UNKNOWN'),
      promotionDecision: enumValue(h?.promotionDecision, ['PROMOTED', 'NOT_PROMOTED', 'NOT_EVALUATED']),
      promotionReason: reasonCode(h?.promotionReason), availableOrigins: h?.availableOrigins ?? null,
      requiredOrigins: h?.requiredOrigins ?? null, trainingJobReference: h?.trainingJobReference ?? null };
  });
}
function summary(value, key) {
  if (!value || typeof value !== 'object') return { status: 'NOT_CAPTURED', summary: null };
  const allowed = key === 'prediction'
    ? ['totalProductsEvaluated', 'comparableProductsCount', 'predictionChangedCount', 'p7', 'p14']
    : ['totalProductsEvaluated', 'comparableProductsCount', 'riskChangedCount', 'reorderDecisionChangedCount',
      'recommendedQtyChangedCount', 'reorderPointChangedCount', 'coverageChangedCount', 'rankingChangedCount',
      'unavailableCount', 'notComparableCount'];
  return { status: enumValue(value.status, D.IMPACT_STATUSES, 'NOT_CAPTURED'), reasonCode: reasonCode(value.reasonCode),
    summary: value.summary ? Object.fromEntries(allowed.filter(field => value.summary[field] !== undefined)
      .map(field => [field, value.summary[field]])) : null };
}
function listItem(row) {
  const prediction = row.impact?.prediction, inventory = row.impact?.inventory;
  return { executionId: row.executionId, triggerSource: enumValue(row.triggerSource, ['MANUAL', 'SCHEDULED', 'CLI'], 'UNKNOWN'),
    requestSource: enumValue(row.requestSource, ['MANUAL', 'SCHEDULED', 'CLI']),
    requestedAt: time(row.requestedAt), startedAt: time(row.startedAt), finishedAt: time(row.finishedAt),
    status: enumValue(row.status, D.STATUSES, 'UNKNOWN'), reasonCode: reasonCode(row.reasonCode), dataVersionEvaluated: row.dataVersionEvaluated ?? null,
    observationsClosedThrough: row.observationsClosedThrough ?? null, availableOrigins: row.availableOrigins ?? null,
    requiredOrigins: row.requiredOrigins ?? null, pendingBefore: row.pendingBefore ?? null,
    pendingAfter: row.pendingAfter ?? null, horizons: horizonSummary(row.perHorizon),
    impact: { status: enumValue(row.impact?.status, D.IMPACT_STATUSES, 'NOT_CAPTURED'), reasonCode: reasonCode(row.impact?.reasonCode),
      prediction: summary({ status: row.impact?.predictionStatus ?? prediction?.status,
        reasonCode: prediction?.captureReason, summary: prediction?.summary }, 'prediction'),
      inventory: summary(inventory, 'inventory') } };
}
function executionDetail(row) {
  return { ...listItem(row), triggerSource: enumValue(row.triggerSource, ['MANUAL', 'SCHEDULED', 'CLI'], 'UNKNOWN'),
    stage: enumValue(row.stage, D.STAGES, 'UNKNOWN'), eligibility: reasonCode(row.eligibility),
    signalTypes: Array.isArray(row.signalTypes) ? row.signalTypes.filter(value => ['SALE_COMPLETED', 'SALE_CANCELLED', 'PRODUCT_UPDATED'].includes(value)) : [],
    attempts: (row.attempts || []).map(attempt => ({ runAttempt: Number.isSafeInteger(attempt.runAttempt) ? attempt.runAttempt : null,
      status: enumValue(attempt.status, D.STATUSES, 'UNKNOWN'), reasonCode: reasonCode(attempt.reasonCode),
      startedAt: time(attempt.startedAt), finishedAt: time(attempt.finishedAt),
      horizons: horizonSummary(attempt.perHorizon) })),
    impact: { status: enumValue(row.impact?.status, D.IMPACT_STATUSES, 'NOT_CAPTURED'), reasonCode: reasonCode(row.impact?.reasonCode),
    prediction: { ...summary({ status: row.impact?.predictionStatus ?? row.impact?.prediction?.status,
        reasonCode: row.impact?.prediction?.captureReason, summary: row.impact?.prediction?.summary }, 'prediction'),
        versions: (row.impact?.prediction?.versions || []).filter(v => [7, 14].includes(v.horizonDays)).map(v => ({
          horizonDays: v.horizonDays, beforeVersion: v.beforeVersion ?? null, afterVersion: v.afterVersion ?? null })) },
      inventory: summary(row.impact?.inventory, 'inventory') } };
}
function productItem(sku, prediction, inventory) {
  const p7 = prediction?.p7 || null, p14 = prediction?.p14 || null;
  const inv = inventory || null;
  const predictionHorizon = value => value ? { old: finiteOrNull(value.old), new: finiteOrNull(value.new),
    delta: finiteOrNull(value.delta), deltaPct: finiteOrNull(value.deltaPct),
    direction: enumValue(value.direction, ['UNCHANGED', 'INCREASED', 'DECREASED', 'NOT_COMPARABLE'], 'NOT_COMPARABLE') } : null;
  const risk = value => enumValue(value, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  return { sku, productName: prediction?.productName ?? inv?.productName ?? null,
    prediction: { p7: predictionHorizon(p7), p14: predictionHorizon(p14) },
    inventory: inv ? { risk: { before: risk(inv.risk?.before), after: risk(inv.risk?.after),
      changed: inv.risk?.changed ?? null }, shouldReorder: { before: inv.shouldReorder?.before ?? null,
      after: inv.shouldReorder?.after ?? null, changed: inv.shouldReorder?.changed ?? null },
      recommendedQty: { before: inv.recommendedQty?.before ?? null, after: inv.recommendedQty?.after ?? null,
        delta: inv.recommendedQty?.delta ?? null }, reorderPoint: { before: inv.reorderPoint?.before ?? null,
        after: inv.reorderPoint?.after ?? null, delta: inv.reorderPoint?.delta ?? null },
      coverage: { daysCoverBefore: inv.coverage?.daysCoverBefore ?? null,
        daysCoverAfter: inv.coverage?.daysCoverAfter ?? null, delta: inv.coverage?.delta ?? null },
      ranking: { positionBefore: inv.ranking?.positionBefore ?? null, positionAfter: inv.ranking?.positionAfter ?? null,
        delta: inv.ranking?.delta ?? null, status: enumValue(inv.ranking?.status, ['COMPARABLE', 'NOT_COMPARABLE'], 'NOT_COMPARABLE') },
      availability: { before: enumValue(inv.availability?.before, ['AVAILABLE', 'PARTIAL'], 'PARTIAL'),
        after: enumValue(inv.availability?.after, ['AVAILABLE', 'PARTIAL'], 'PARTIAL'),
        reasonCodesBefore: reasonCodes(inv.availability?.reasonCodesBefore),
        reasonCodesAfter: reasonCodes(inv.availability?.reasonCodesAfter) } }
      : { status: 'NOT_CAPTURED' } };
}
function createForecastMlUpdateHistoryService({ model = require('../models/ForecastMlUpdateExecution') } = {}) {
  async function list(req) {
    const scope = scoped(req), parsed = parseListQuery(req.query || {}, scope), filter = { ...scope };
    if (parsed.triggerSource) filter.triggerSource = parsed.triggerSource;
    if (parsed.status) filter.status = parsed.status;
    if (parsed.from || parsed.to) filter.requestedAt = { ...(parsed.from ? { $gte: parsed.from } : {}), ...(parsed.to ? { $lte: parsed.to } : {}) };
    if (parsed.promotedOnly) filter.perHorizon = { $elemMatch: { resultStatus: 'PROMOTED',
      promotionDecision: 'PROMOTED', activeChangeSource: 'EXECUTION' } };
    if (parsed.cursorPayload) filter.$or = [{ requestedAt: { $lt: new Date(parsed.cursorPayload.requestedAt) } },
      { requestedAt: new Date(parsed.cursorPayload.requestedAt), executionId: { $lt: parsed.cursorPayload.executionId } }];
    const projection = ['executionId', 'triggerSource', 'requestSource', 'requestedAt', 'startedAt', 'finishedAt',
      'status', 'reasonCode', 'dataVersionEvaluated', 'observationsClosedThrough', 'availableOrigins',
      'requiredOrigins', 'pendingBefore', 'pendingAfter', 'perHorizon', 'impact.status', 'impact.reasonCode',
      'impact.predictionStatus', 'impact.prediction.status', 'impact.prediction.captureReason', 'impact.prediction.summary',
      'impact.inventory.status', 'impact.inventory.reasonCode', 'impact.inventory.summary'].join(' ');
    try {
      const rows = await model.find(filter).select(projection).sort({ requestedAt: -1, executionId: -1 })
        .limit(parsed.limit + 1).lean().exec();
      const hasMore = rows.length > parsed.limit, page = rows.slice(0, parsed.limit), last = page.at(-1);
      const nextCursor = hasMore && last ? encodeCursor({ v: 1, k: 'list', ...scope,
        ...(parsed.triggerSource ? { triggerSource: parsed.triggerSource } : {}),
        ...(parsed.status ? { status: parsed.status } : {}), ...(parsed.from ? { from: parsed.from.toISOString() } : {}),
        ...(parsed.to ? { to: parsed.to.toISOString() } : {}),
        ...(parsed.promotedOnly !== undefined ? { promotedOnly: parsed.promotedOnly } : {}),
        requestedAt: time(last.requestedAt), executionId: last.executionId }) : null;
      return { items: page.map(listItem), page: { limit: parsed.limit, nextCursor } };
    } catch { fail('ML_HISTORY_UNAVAILABLE', 503); }
  }
  async function get(req) {
    const scope = scoped(req), executionId = req.params?.executionId;
    if (Object.keys(req.query || {}).length || typeof executionId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(executionId)) fail('ML_HISTORY_EXECUTION_NOT_FOUND', 404);
    try {
      const row = await model.findOne({ ...scope, executionId }).select([
        'executionId', 'triggerSource', 'requestSource', 'requestedAt', 'startedAt', 'finishedAt', 'status', 'stage',
        'reasonCode', 'message', 'eligibility', 'signalTypes', 'dataVersionBefore', 'dataVersionEvaluated',
        'observationsClosedThrough', 'availableOrigins', 'requiredOrigins', 'pendingBefore', 'pendingAfter',
        'perHorizon', 'attempts.runAttempt', 'attempts.status', 'attempts.reasonCode', 'attempts.startedAt',
        'attempts.finishedAt', 'attempts.perHorizon', 'impact.status', 'impact.reasonCode', 'impact.predictionStatus',
        'impact.prediction.status', 'impact.prediction.captureReason', 'impact.prediction.summary',
        'impact.prediction.versions', 'impact.inventory.status', 'impact.inventory.reasonCode',
        'impact.inventory.summary'].join(' ')).lean().exec();
      if (!row) fail('ML_HISTORY_EXECUTION_NOT_FOUND', 404);
      const data = executionDetail(row);
      data.dataVersionBefore = row.dataVersionBefore ?? null;
      data.message = Object.values(D.REASONS).includes(row.message) ? row.message : null;
    return data;
    } catch (error) {
      if (error.code === 'ML_HISTORY_EXECUTION_NOT_FOUND') throw error;
      fail('ML_HISTORY_UNAVAILABLE', 503);
    }
  }
  async function products(req) {
    const scope = scoped(req), executionId = req.params?.executionId;
    if (typeof executionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(executionId)) fail('ML_HISTORY_EXECUTION_NOT_FOUND', 404);
    const allowed = ['limit', 'cursor'];
    if (Object.keys(req.query || {}).some(key => !allowed.includes(key))) fail('ML_HISTORY_FILTER_INVALID');
    const limit = parseLimit(req.query?.limit, PRODUCT_LIMIT_DEFAULT, PRODUCT_LIMIT_MAX, 'ML_HISTORY_LIMIT_INVALID');
    let afterSku = null;
    if (req.query?.cursor) {
      afterSku = decodeCursor(req.query.cursor, { v: 1, k: 'products', ...scope, executionId }, ['afterSku']).afterSku;
      if (typeof afterSku !== 'string' || !afterSku || afterSku.length > 160) fail('ML_HISTORY_CURSOR_INVALID');
    }
    try {
      const row = await model.findOne({ ...scope, executionId }).select([
        'executionId', 'impact.prediction.detail', 'impact.prediction.snapshot.products', 'impact.inventory.details'].join(' ')).lean().exec();
      if (!row) fail('ML_HISTORY_EXECUTION_NOT_FOUND', 404);
      const predictionRows = row.impact?.prediction?.detail || [], inventoryRows = row.impact?.inventory?.details || [];
      const names = new Map((row.impact?.prediction?.snapshot?.products || []).map(p => [p.sku, p.productName ?? null]));
      const skus = [...new Set([...predictionRows, ...inventoryRows].map(value => value.sku))].sort();
      const eligible = afterSku === null ? skus : skus.filter(sku => sku > afterSku);
      const page = eligible.slice(0, limit + 1), hasMore = page.length > limit, chosen = page.slice(0, limit);
      const p = new Map(predictionRows.map(value => [value.sku, value])), i = new Map(inventoryRows.map(value => [value.sku, value]));
      const items = chosen.map(sku => ({ ...productItem(sku, p.get(sku), i.get(sku)),
        productName: p.get(sku)?.productName ?? i.get(sku)?.productName ?? names.get(sku) ?? null }));
      const nextCursor = hasMore && chosen.length ? encodeCursor({ v: 1, k: 'products', ...scope,
        executionId, afterSku: chosen.at(-1) }) : null;
      return { executionId, items, page: { limit, nextCursor } };
    } catch (error) {
      if (error.code === 'ML_HISTORY_EXECUTION_NOT_FOUND') throw error;
      fail('ML_HISTORY_UNAVAILABLE', 503);
    }
  }
  return Object.freeze({ list, get, products });
}
module.exports = { createForecastMlUpdateHistoryService, parseListQuery, listItem, executionDetail, productItem,
  LIMIT_DEFAULT, LIMIT_MAX, PRODUCT_LIMIT_DEFAULT, PRODUCT_LIMIT_MAX };
