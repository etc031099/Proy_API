'use strict';

const { randomUUID } = require('node:crypto');
const config = require('../config/v3Operational');
const mlTestFence = require('./mlTestFence');
const updateCoordinator = require('./forecastMlUpdateCoordinator');
const { describePending } = require('./forecastCloudWorker');

const MANUAL_TERMINAL_DECISIONS = new Set(['NO_PENDING_WORK', 'DEBOUNCE_NOT_ELAPSED', 'NOT_MATURE',
  'COOLDOWN_ACTIVE', 'PREVIOUS_FAILURE_NOT_RETRYABLE']);

function assertActiveTestEpoch(token) {
  if (token?.state !== 'TEST_ACTIVE' || !/^[a-f0-9-]{36}$/.test(token.testCycleId || '')
      || !/^[1-9]\d*$/.test(String(token.resetEpoch || ''))) {
    throw Object.assign(new Error('TEST_EPOCH_REQUIRED'), { code: 'TEST_EPOCH_REQUIRED', httpStatus: 409 });
  }
  return token;
}

async function drainInCapturedEpoch({ db, worker, horizonDays, leaseOwner = `local-${randomUUID()}`, token,
  fence = mlTestFence, readState, update = updateCoordinator,
  completeManualEvaluation = updateCoordinator.completeManualEvaluation,
  describe = describePending, now = () => new Date(), precondition }) {
  const expected = assertActiveTestEpoch(token);
  return fence.withEpoch(db, async () => {
    if (precondition) await precondition(expected);
    const result = await worker.runEligible({ horizonDays, leaseOwner });
    if (result !== null) return { result };
    if (typeof readState !== 'function') throw new Error('Local drain state reader is required.');
    const state = await readState(horizonDays);
    const details = describe(state, horizonDays, update, now());
    const evaluation = details.eligibility === 'ELIGIBLE' ? 'CLAIM_NOT_ACQUIRED' : details.eligibility;
    let manualRequestClosed = false;
    if (state?.manualPending === true && typeof state.manualRequestKey === 'string'
        && state.manualRequestKey && MANUAL_TERMINAL_DECISIONS.has(details.eligibility)) {
      manualRequestClosed = await completeManualEvaluation({ businessId: config.businessId,
        scenarioId: config.scenarioId, horizonDays, manualRequestKey: state.manualRequestKey,
        result: details.eligibility, now: now() });
    }
    return { result: null, evaluation, ...(state?.manualPending === true ? { manualRequestClosed } : {}) };
  }, expected);
}

module.exports = { assertActiveTestEpoch, drainInCapturedEpoch };
