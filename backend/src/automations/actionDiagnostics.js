'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const attempts = new AsyncLocalStorage();
const PHASES = new Set(['EXECUTION_PREFLIGHT', 'SESSION_START', 'ACTION_LOAD', 'PRECONDITION_REVALIDATION', 'STOCK_UPDATE',
  'EXCHANGE_RATE', 'TRANSACTION_PERSIST', 'JOURNAL', 'DOMAIN_EVENTS', 'EXECUTOR',
  'EXECUTION_BUDGET_CHECK', 'ACTION_PERSIST', 'AUDIT', 'COMMIT', 'ROLLBACK']);
const DEPENDENCIES = new Set(['NONE', 'MONGO', 'EXCHANGE_RATE']);
const MONGO_CODES = new Set([50, 64, 89, 91, 112, 189, 251, 262, 8000, 11000, 11600, 11602, 13435, 13436]);
const elapsed = start => Math.max(0, Math.round(performance.now() - start));
function phase(value, dependency = 'NONE') {
  const state = attempts.getStore();
  if (state && PHASES.has(value) && DEPENDENCIES.has(dependency)) {
    state.phase = value; state.dependency = dependency;
  }
}
function failure(error) {
  const state = attempts.getStore();
  if (!state || state.failure) return;
  const mongoCode = MONGO_CODES.has(error?.code) ? error.code : null;
  const mongo = mongoCode !== null || /^(?:Mongo\w*Error|MongooseServerSelectionError)$/.test(error?.name || '');
  const category = state.deadline ? 'EXECUTION_DEADLINE'
    : ['ValidationError', 'CastError', 'StrictModeError'].includes(error?.name) ? 'MODEL_VALIDATION'
      : mongo ? ([50, 64, 89, 262].includes(mongoCode) || /Timeout|ServerSelection/.test(error.name || '') ? 'MONGO_TIMEOUT' : 'MONGO_ERROR')
        : state.dependency === 'EXCHANGE_RATE' ? 'EXTERNAL_DEPENDENCY' : 'INTERNAL_ERROR';
  // Never retain the exception, message, stack, payload or arbitrary error fields.
  state.failure = { failureCategory: category, executionPhase: state.phase,
    dependency: mongo ? 'MONGO' : state.dependency, mongoCode };
}
async function observe(value, dependency, work) {
  const state = attempts.getStore();
  if (!state) return work();
  const previous = [state.phase, state.dependency], start = performance.now();
  phase(value, dependency);
  try { return await work(); }
  catch (error) { failure(error); throw error; }
  finally {
    if (PHASES.has(value)) state.phaseDurationsMs[value] = (state.phaseDurationsMs[value] || 0) + elapsed(start);
    [state.phase, state.dependency] = previous;
  }
}
async function exchangeRate(called, work) {
  const state = attempts.getStore(), start = performance.now();
  if (state && called) state.exchangeRate.called = true;
  try {
    const result = await observe('EXCHANGE_RATE', called ? 'EXCHANGE_RATE' : 'NONE', work);
    if (state && called) {
      state.exchangeRate.fallbackUsed ||= result?.source === 'fallback';
      state.exchangeRate.respondedSuccessfully &&= result?.source !== 'fallback';
    }
    return result;
  } catch (error) {
    if (state && called) state.exchangeRate.respondedSuccessfully = false;
    throw error;
  } finally { if (state && called) state.exchangeRate.durationMs += elapsed(start); }
}
function budget(durationMs, timeoutMs) {
  const state = attempts.getStore();
  if (!state) return;
  phase('EXECUTION_BUDGET_CHECK');
  state.budgetElapsedMs = Math.max(0, Math.round(durationMs)); state.timeoutMs = timeoutMs;
  state.deadline = durationMs > timeoutMs;
}
function rollback(status) {
  const state = attempts.getStore();
  if (state && ['CONFIRMED', 'FAILED', 'UNCERTAIN'].includes(status)) state.rollbackStatus = status;
}
async function run(actionId, work) {
  const state = { phase: 'ACTION_LOAD', dependency: 'MONGO', started: performance.now(),
    rollbackStatus: 'NOT_ATTEMPTED', timeoutMs: null, budgetElapsedMs: null, phaseDurationsMs: {},
    exchangeRate: { called: false, durationMs: 0, fallbackUsed: false, respondedSuccessfully: true } };
  return attempts.run(state, async () => {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof require('./contracts').ActionError) || error.code === 'ACTION_EXECUTION_FAILED') {
        failure(error);
        const event = { event: 'agent_action_execution_failed',
          actionId: typeof actionId === 'string' && /^[a-f\d-]{36}$/i.test(actionId) ? actionId : null,
          attemptId: randomUUID(), ...state.failure, durationMs: elapsed(state.started), timeoutMs: state.timeoutMs,
          budgetElapsedMs: state.budgetElapsedMs, executorDurationMs: state.phaseDurationsMs.EXECUTOR ?? null,
          phaseDurationsMs: state.phaseDurationsMs, exchangeRate: { ...state.exchangeRate,
            respondedSuccessfully: state.exchangeRate.called ? state.exchangeRate.respondedSuccessfully : null },
          rollbackStatus: state.rollbackStatus };
        try { console.error(JSON.stringify(event)); } catch { /* Observability cannot change the outcome. */ }
      }
      throw error;
    }
  });
}
module.exports = { run, phase, observe, exchangeRate, budget, rollback, failure,
  limit: timeoutMs => { const state = attempts.getStore(); if (state) state.timeoutMs = timeoutMs; },
  withoutTracking: work => attempts.run(undefined, work) };
