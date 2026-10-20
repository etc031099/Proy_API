'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getCertifiedStable2020Replay } = require('./forecastReplayCertificateService');

const DETAIL_SHA256 = '5f8fa93cdf2ce067dafa4c4dd648e4a9400d598b22e17e68e259fb8c38b62a9a';
const POLICY_SHA256 = '522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3';
const DETAIL_PATH = path.join(__dirname, '../evidence/forecast-replay/cert-stable-2020-detail.json');
const PAGE_SIZE = 10;
let certificate;

function invalidSelection() {
  return Object.assign(new Error('Invalid certified evidence selection'), { code: 'FORECAST_REPLAY_SELECTION_INVALID', httpStatus: 400 });
}

function validateDetailCertificate(raw) {
  if (createHash('sha256').update(raw).digest('hex') !== DETAIL_SHA256) throw new Error('FORECAST_REPLAY_INTEGRITY_FAILED');
  const value = JSON.parse(raw.toString('utf8'));
  const summary = getCertifiedStable2020Replay();
  if (value.demoRunId !== summary.demoRunId || value.seed !== 2020 || value.profile !== 'STABLE'
    || value.requiredOrigins !== 107 || value.purpose !== 'REPLAY_ONLY'
    || value.policy.numericPolicySha256 !== POLICY_SHA256 || value.reference !== 'MA28'
    || Object.keys(summary.liveImpact).some(key => value.liveImpact[key] !== false)) {
    throw new Error('FORECAST_REPLAY_INTEGRITY_FAILED');
  }
  return value;
}

function readCertificate() {
  // Fixed file only; never reads a client-supplied path, invokes ML or accesses DB.
  if (!certificate) certificate = validateDetailCertificate(fs.readFileSync(DETAIL_PATH));
  return certificate;
}

function selection(query, allowed) {
  if (Object.keys(query).some(key => !allowed.includes(key))) throw invalidSelection();
  const horizon = query.horizonDays ?? '7';
  if (horizon !== '7' && horizon !== '14') throw invalidSelection();
  return readCertificate().horizons.find(row => row.horizonDays === Number(horizon));
}

function metadata(data, horizon) {
  return { demoRunId: data.demoRunId, purpose: data.purpose, requiredOrigins: data.requiredOrigins,
    reference: data.reference, policy: data.policy, certificateSha256: DETAIL_SHA256,
    horizonDays: horizon.horizonDays, status: horizon.status };
}

function getCertifiedReplayOrigins(query = {}) {
  const horizon = selection(query, ['horizonDays', 'fold', 'page']);
  if (query.fold !== undefined && !horizon.folds.some(fold => fold.key === query.fold)) throw invalidSelection();
  if (query.page !== undefined && (typeof query.page !== 'string' || !/^[1-9]\d{0,2}$/.test(query.page))) throw invalidSelection();
  const filtered = horizon.origins.filter(row => query.fold === undefined || row.fold === query.fold);
  const page = Number(query.page ?? 1);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  if (page > totalPages) throw invalidSelection();
  return JSON.parse(JSON.stringify({ ...metadata(readCertificate(), horizon), folds: horizon.folds,
    totalOrigins: horizon.origins.length, total: filtered.length, page, pageSize: PAGE_SIZE, totalPages,
    items: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(row => ({ origin: row.origin,
      fold: row.fold, sampleCount: row.sampleCount, candidateMae: row.candidate.mae, baselineMae: row.baseline.mae })),
    focalEvidence: horizon.focalEvidence, allCheckCount: horizon.allCheckCount,
    passedCheckCount: horizon.passedCheckCount, globalChecks: horizon.globalChecks, reasons: horizon.reasons }));
}

function getCertifiedReplayOrigin(origin, query = {}) {
  const horizon = selection(query, ['horizonDays']);
  if (typeof origin !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(origin)) throw invalidSelection();
  const row = horizon.origins.find(item => item.origin === origin);
  if (!row) throw invalidSelection();
  return JSON.parse(JSON.stringify({ ...metadata(readCertificate(), horizon), ...row }));
}

module.exports = { getCertifiedReplayOrigins, getCertifiedReplayOrigin, validateDetailCertificate, DETAIL_SHA256 };
