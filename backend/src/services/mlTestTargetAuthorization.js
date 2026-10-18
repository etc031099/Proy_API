'use strict';
// Unserializable, per-invocation capability. Never accepted from HTTP/JSON.
const grants = new WeakMap();
const config = require('../config/v3Operational');
const { authorizeAdminAction } = require('./mlTestAccess');
const CERTIFICATION = 'm6.10a3795b-admin-epoch-v1';
const fail = code => { throw Object.assign(new Error(code), { code, httpStatus: 503 }); };
const cloudFlagEnabled = env => env.ML_TEST_CLOUD_RESTORE_ENABLED === 'true';
function authorizeCloudTarget({ client, db, user, env, certificationId }) {
  const scope = authorizeAdminAction(user);
  if (!cloudFlagEnabled(env)) fail('ML_TEST_CLOUD_RESTORE_DISABLED');
  if (certificationId !== CERTIFICATION) fail('ML_TEST_CLOUD_CERTIFICATION_REQUIRED');
  let uri;
  try { uri = new URL(env.FORECAST_CLOUD_MONGO_URI); } catch { fail('ML_TEST_CLOUD_TARGET_INVALID'); }
  const database = env.FORECAST_CLOUD_EXPECTED_DATABASE;
  if (env.FORECAST_CLOUD_EXPECTED_BUSINESS_ID !== scope.businessId || env.FORECAST_CLOUD_EXPECTED_SCENARIO_ID !== scope.scenarioId
      || !/^[A-Za-z0-9_-]{1,64}$/.test(database || '') || uri.protocol !== 'mongodb+srv:'
      || !uri.hostname.endsWith('.mongodb.net') || !uri.username || !uri.password || uri.port || uri.hash
      || uri.pathname !== `/${database}` || client?.options?.srvHost !== uri.hostname || db?.databaseName !== database || db?.client !== client
      || ['tls', 'ssl'].some(key => uri.searchParams.has(key) && uri.searchParams.get(key) !== 'true')
      || ['tlsInsecure', 'tlsAllowInvalidCertificates', 'tlsAllowInvalidHostnames', 'directConnection']
        .some(key => uri.searchParams.has(key) && uri.searchParams.get(key) !== 'false')) fail('ML_TEST_CLOUD_TARGET_INVALID');
  const capability = Object.freeze({});
  grants.set(capability, { client, db, businessId: config.businessId, scenarioId: config.scenarioId });
  return capability;
}
function authorized(client, db, capability) {
  if (!capability || typeof capability !== 'object') return false;
  const grant = grants.get(capability);
  return Boolean(grant && grant.client === client && grant.db === db
    && grant.businessId === config.businessId && grant.scenarioId === config.scenarioId);
}
module.exports = { authorizeCloudTarget, authorized, cloudFlagEnabled, CERTIFICATION };
