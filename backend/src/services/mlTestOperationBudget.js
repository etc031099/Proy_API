'use strict';
const LIMITS = Object.freeze({ captureMs: 120000, cloudCaptureMs: 240000, maxCloudCaptureMs: 300000,
  restoreMs: 300000, verificationMs: 120000, maxBytes: 128 * 1024 * 1024,
  maxDocuments: 200000, maxChunks: 128, maxRssBytes: 512 * 1024 * 1024 });
const CLOUD_CAPTURE_TIMEOUT_ENV = 'ML_TEST_CHECKPOINT_CLOUD_TIMEOUT_MS';
const PHASES = new Set(['QUIESCENCE', 'DRAIN', 'SNAPSHOT_READ', 'CHUNK_WRITE', 'VERIFY', 'FINALIZE']);
function captureBudgetMs({ operational = false, env = process.env } = {}) {
  const fallback = operational ? LIMITS.cloudCaptureMs : LIMITS.captureMs;
  const raw = operational ? env[CLOUD_CAPTURE_TIMEOUT_ENV] : undefined;
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(String(raw))) throw Object.assign(new Error('Invalid checkpoint timeout configuration'), { code: 'CHECKPOINT_OPERATION_TIMEOUT_CONFIG_INVALID' });
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < LIMITS.captureMs || value > LIMITS.maxCloudCaptureMs) {
    throw Object.assign(new Error('Invalid checkpoint timeout configuration'), { code: 'CHECKPOINT_OPERATION_TIMEOUT_CONFIG_INVALID' });
  }
  return value;
}
function budget(milliseconds, { now = Date.now, memory = process.memoryUsage } = {}) {
  const started = now();
  return () => {
    const code = now() - started > milliseconds ? 'CHECKPOINT_OPERATION_TIMEOUT'
      : memory().rss > LIMITS.maxRssBytes ? 'CHECKPOINT_MEMORY_LIMIT_EXCEEDED' : null;
    if (code) throw Object.assign(new Error(code), { code });
  };
}
function checkpointBudget(milliseconds, { now = Date.now, memory = process.memoryUsage,
  checkpointId = null, onPhase = () => {} } = {}) {
  const started = now();
  let phase = 'QUIESCENCE', phaseStarted = started;
  const phaseElapsedMs = {};
  const reportedPhases = new Set();
  function check(nextPhase = phase, collection = null) {
    const timestamp = now();
    if (nextPhase !== phase) {
      phaseElapsedMs[phase] = (phaseElapsedMs[phase] || 0) + Math.max(0, timestamp - phaseStarted);
      phase = PHASES.has(nextPhase) ? nextPhase : 'SNAPSHOT_READ';
      phaseStarted = timestamp;
    }
    if (!reportedPhases.has(phase)) {
      reportedPhases.add(phase);
      try { onPhase({ checkpointId, phase, budgetMs: milliseconds, elapsedMs: Math.max(0, timestamp - started),
        remainingBudgetMs: Math.max(0, milliseconds - (timestamp - started)), collection }); } catch { /* diagnostics are best-effort */ }
    }
    const elapsedMs = Math.max(0, timestamp - started);
    const remainingBudgetMs = Math.max(0, milliseconds - elapsedMs);
    const phaseElapsed = Math.max(0, timestamp - phaseStarted);
    const code = elapsedMs >= milliseconds ? 'CHECKPOINT_OPERATION_TIMEOUT'
      : memory().rss > LIMITS.maxRssBytes ? 'CHECKPOINT_MEMORY_LIMIT_EXCEEDED' : null;
    if (code) throw Object.assign(new Error(code), { code, phase, checkpointId, budgetMs: milliseconds, elapsedMs,
      phaseElapsedMs: phaseElapsed, remainingBudgetMs: 0 });
    return remainingBudgetMs;
  }
  check.remaining = () => Math.max(0, milliseconds - Math.max(0, now() - started));
  check.elapsed = () => Math.max(0, now() - started);
  check.phaseElapsed = () => Math.max(0, now() - phaseStarted);
  check.phaseName = () => phase;
  check.phaseMetrics = () => ({ ...phaseElapsedMs,
    [phase]: (phaseElapsedMs[phase] || 0) + Math.max(0, now() - phaseStarted) });
  return check;
}
module.exports = { LIMITS, CLOUD_CAPTURE_TIMEOUT_ENV, PHASES, captureBudgetMs, budget, checkpointBudget };
