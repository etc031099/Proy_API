'use strict';

// Deliberately project only fixed enums, numeric versions and ISO dates.
// Never echo arbitrary fields, exception messages, identifiers or report contents.
const fs = require('node:fs');
const path = require('node:path');
const decisions = new Set(['PREFLIGHT_PASS', 'NO_PENDING_WORK', 'DEBOUNCE_NOT_ELAPSED',
  'NOT_MATURE', 'COOLDOWN_ACTIVE', 'NO_PROMOTION_INSUFFICIENT_HISTORY',
  'CANDIDATE_REJECTED', 'CANDIDATE_PROMOTED', 'FAILED', 'LEASE_ACTIVE',
  'PREVIOUS_FAILURE_NOT_RETRYABLE', 'ELIGIBLE', 'CLAIM_NOT_ACQUIRED']);
const number = value => /^(0|[1-9]\d{0,18})$/.test(String(value)) ? String(value) : '—';
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : '—';
const decision = value => decisions.has(value) ? value : 'NOT_REPORTED';

function formatReport(report) {
  if (!report || !['OK', 'FAILED'].includes(report.status)) return 'Reporte ausente o inválido. Revisar el estado de los pasos.\n';
  const rows = [
    `Estado: ${report.status}; modo: ${['CHECK', 'STATUS', 'RUN'].includes(report.mode) ? report.mode : 'UNKNOWN'}.`,
    `dataVersion: ${number(report.dataVersion)}; closedThrough: ${day(report.closedThrough)}.`,
    '', '| Horizonte | Pending | Decisión | ACTIVE | trainedDataVersion | Origins disponibles/requeridos |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const horizon of [7, 14]) {
    const item = Array.isArray(report.horizons) ? report.horizons.find(row => row?.horizonDays === horizon) : null;
    const pending = typeof item?.pending === 'boolean' ? String(item.pending) : 'no evaluado';
    rows.push(`| ${horizon}d | ${pending} | ${decision(item?.result)} | ${number(item?.activeModelVersionAtPreflight)} | ${number(item?.activeTrainedDataVersionAtPreflight)} | ${number(item?.promotionReadiness?.availableOrigins)}/${number(item?.promotionReadiness?.requiredOrigins)} |`);
  }
  rows.push('', 'CHECK es solo lectura. RUN usa el pipeline existente y puede persistir trabajo/candidatos elegibles; este resumen no estima writes.');
  return rows.join('\n') + '\n';
}

function main(env = process.env) {
  const sections = [`# Forecast Ridge\n\nEjecución UTC: ${new Date().toISOString()}\n`];
  for (const mode of ['check', 'run']) {
    let report;
    try { report = JSON.parse(fs.readFileSync(path.join(env.RUNNER_TEMP, `forecast-ridge-${mode}.json`), 'utf8')); }
    catch { /* Missing/invalid output must not disclose raw text. */ }
    sections.push(`## ${mode.toUpperCase()}\n\n${formatReport(report)}`);
  }
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, sections.join('\n'), 'utf8');
}

if (require.main === module) main();
module.exports = { formatReport };
