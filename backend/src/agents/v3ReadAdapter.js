'use strict';

const { AgentError } = require('./contracts');
const { createV3RidgeServingAuthority } = require('../services/v3RidgeServingAuthority');

// Server-only adapter: identity and ACTIVE models never come from tool arguments.
const createV3AssistantRead = ({ execute, resolveContext, registry }) => {
  const authority = createV3RidgeServingAuthority({ registry });
  return async invocation => {
    const binding = await resolveContext(invocation.context);
    if (!binding) throw new AgentError('AGENT_SKILL_NOT_ALLOWED');
    const { args, skill } = invocation;
    const forecast = skill.id === 'get_product_forecast';
    const asOf = args.asOfDate || args.endDate || binding.operationalDate;
    const scope = { businessId: binding.businessId, scenarioId: binding.scenarioId };
    if (forecast && args.mode === 'method') return { status: 'READY',
      data: { method: 'RIDGE_REGRESSION', recipeId: 'RIDGE-CAUSAL27', featureVersion: 'RIDGE_CAUSAL27_V1',
        horizons: [7, 14], unavailableHorizons: [1], activeModelAuthority: 'ForecastModelRegistry' },
      metadata: { returnedCount: 1, totalMatches: 1, asOf: binding.operationalDate, domain: 'forecast' } };
    // Explicit historical evaluation retains its own frozen contract.
    if (asOf <= binding.historicalCutoff || forecast && args.mode === 'evaluation') return execute(invocation);
    if (['get_inventory_intelligence', 'get_business_health'].includes(skill.id)) {
      const trustedInventoryRidgeModels = await authority.modelsFor(scope);
      return execute({ ...invocation, trustedInventoryRidgeModels });
    }
    if (!forecast) return execute(invocation);
    const horizonDays = args.horizonDays ?? 7;
    if (![7, 14].includes(horizonDays)) {
      const error = new AgentError('AGENT_INVALID_SKILL_ARGS');
      error.functionalCode = 'UNSUPPORTED_HORIZON'; throw error;
    }
    // LIVE Ridge's certified contract scores a specific product, never a global
    // MA28 ranking. Ask for selection instead of manufacturing a replacement.
    const refs = args.productRef ? [args.productRef] : args.productRefs?.split('|');
    if (!refs?.length) {
      const error = new AgentError('AGENT_INVALID_SKILL_ARGS');
      error.functionalCode = 'FORECAST_PRODUCT_REQUIRED'; throw error;
    }
    if (refs.length > 5 || refs.length > skill.maxRecords) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
    const trustedForecastModelEnvelope = await authority.modelFor({ ...scope, horizonDays });
    const results = [];
    for (const productRef of [...new Set(refs)]) {
      invocation.signal.throwIfAborted();
      const { productRefs, ...rest } = args;
      const result = await execute({ ...invocation, args: { ...rest, productRef, mode: 'detail', horizonDays },
        useLiveRidge: true, trustedForecastModelEnvelope });
      if (result.status === 'CLARIFICATION') return result;
      results.push(result);
    }
    const first = results[0];
    if (results.some(result => result.metadata.dataVersion !== first.metadata.dataVersion
      || result.metadata.snapshotHash !== first.metadata.snapshotHash)) throw new AgentError('ML_SERVICE_UNAVAILABLE');
    const items = results.flatMap(result => result.data.items || []).map(row => {
      const { featureInputs, ...publicRow } = row;
      return publicRow;
    });
    return { ...first, status: !items.length ? 'NO_DATA' : items.every(row => row.status === 'READY') ? 'READY' : 'PARTIAL',
      data: { ...first.data, method: 'RIDGE_REGRESSION', horizonDays, items, total: items.length },
      metadata: { ...first.metadata, returnedCount: items.length, totalMatches: items.length,
        ...(results.length > 1 ? { selected: {} } : {}) } };
  };
};

module.exports = { createV3AssistantRead };
