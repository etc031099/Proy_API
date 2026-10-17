'use strict';
const D = require('./forecastMlUpdateExecutionDomain');
const P = require('./forecastPredictionImpactDomain');
const safe = error => Object.hasOwn(D.REASONS, error?.code) ? error.code : 'INVENTORY_IMPACT_NOT_CAPTURED';

// Worker-side only. No model lookup, capture, serving endpoint, or training path.
function createForecastInventoryImpact({ service, scope, resolveSnapshot, score }) {
  const get = executionId => service.getExecution({ ...scope, executionId });
  async function calculate({ executionId }) {
    let row = await get(executionId);
    if (!row || !P.promoted(row) || !D.TERMINAL.includes(row.status) || !row.impact.prediction?.finalizedAt) {
      return { status: 'NOT_APPLICABLE', reasonCode: 'NO_MODEL_PROMOTION' };
    }
    if (row.impact.inventory?.completedAt) return { status: row.impact.status, reasonCode: 'IMPACT_ALREADY_FINALIZED' };
    let result = null, reasonCode = null;
    try {
      const snapshot = await resolveSnapshot(row);
      result = await score({ snapshot, prediction: row.impact.prediction });
      if (!result) throw Object.assign(new Error(), { code: 'INVENTORY_IMPACT_INVALID' });
    } catch (error) { reasonCode = safe(error); }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const final = await service.finalizeInventoryImpact({ ...scope, executionId,
          expectedVersion: row.writeVersion, result, reasonCode });
        return { status: final.impact.status, reasonCode: final.impact.reasonCode };
      } catch (error) {
        if (error.code === 'IMPACT_ALREADY_FINALIZED') return { status: (await get(executionId)).impact.status,
          reasonCode: 'IMPACT_ALREADY_FINALIZED' };
        if (error.code === 'EXECUTION_CONFLICT') { row = await get(executionId); continue; }
        // Invalid/oversized output becomes a bounded, immutable NOT_CAPTURED report.
        if (['INVENTORY_IMPACT_INVALID', 'SNAPSHOT_MISMATCH', 'IMPACT_SIZE_LIMIT'].includes(error.code)) {
          result = null; reasonCode = safe(error); row = await get(executionId); continue;
        }
        throw error; // Database failures leave PENDING for a later worker cycle.
      }
    }
    return { status: 'PENDING', reasonCode: null };
  }
  return { calculate };
}
module.exports = { createForecastInventoryImpact };
