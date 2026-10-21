'use strict';

// Shared by BI and the assistant. Artifact selection remains owned by Registry.
function trustedForecastEnvelope(active, scope) {
  const metadata = active?.metadata, bytes = active?.artifactData;
  if (!metadata || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 262_144
      || metadata.status !== 'ACTIVE' || metadata.businessId !== scope.businessId
      || metadata.scenarioId !== scope.scenarioId || metadata.horizonDays !== scope.horizonDays) {
    const error = new Error('Active model artifact does not match the requested scope.');
    error.functionalCode = 'ARTIFACT_UNAVAILABLE'; throw error;
  }
  const fields = ['businessId', 'scenarioId', 'horizonDays', 'modelFamily', 'recipeId', 'modelVersion',
    'status', 'trainedAt', 'trainedDataVersion', 'dataCutoff', 'featureVersion', 'featureHash',
    'promotionPolicyVersion', 'promotionPolicyHash', 'artifactHash', 'artifactBytes'];
  return { metadata: Object.fromEntries(fields.map(key => [key,
    metadata[key] instanceof Date ? metadata[key].toISOString() : metadata[key]])),
    artifactDataBase64: bytes.toString('base64') };
}

function createV3RidgeServingAuthority({ registry } = {}) {
  let source = registry;
  const modelFor = async scope => {
    source ||= require('./forecastModelRegistryService').createForecastModelRegistryService();
    const active = await source.getActiveModelArtifact(scope);
    return active ? trustedForecastEnvelope(active, scope) : null;
  };
  const modelsFor = async scope => (await Promise.all([7, 14].map(async horizonDays => {
    try { return await modelFor({ ...scope, horizonDays }); }
    catch { return null; } // Preserve independent stock data when a model is unavailable.
  }))).filter(Boolean);
  return Object.freeze({ modelFor, modelsFor });
}

module.exports = { createV3RidgeServingAuthority, trustedForecastEnvelope };
