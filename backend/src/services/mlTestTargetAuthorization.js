'use strict';
// Unserializable, per-invocation capability. Never accepted from HTTP/JSON.
const grants = new WeakMap();
const config = require('../config/v3Operational');
const { authorizeAdminAction } = require('./mlTestAccess');
const CERTIFICATION = 'm6.10a3795b-admin-epoch-v1';
const LOCAL_REPLICA_SET = 'rs0';
const LOCAL_MONGO_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'mongodb', 'inventory_mongo']);
const fail = code => { throw Object.assign(new Error(code), { code, httpStatus: 503 }); };
const cloudFlagEnabled = env => env.ML_TEST_CLOUD_RESTORE_ENABLED === 'true';
const localFlagEnabled = env => env.ML_TEST_LOCAL_ENABLED === 'true' && env.NODE_ENV !== 'production';
function authorizeCloudTarget({ client, db, user, env, certificationId }) {
  authorizeAdminAction(user);
  if (!cloudFlagEnabled(env)) fail('ML_TEST_CLOUD_RESTORE_DISABLED');
  if (certificationId !== CERTIFICATION) fail('ML_TEST_CLOUD_CERTIFICATION_REQUIRED');
  assertCloudStatusTarget({ client, db, env });
  const capability = Object.freeze({});
  grants.set(capability, { kind: 'CLOUD', client, db, businessId: config.businessId, scenarioId: config.scenarioId });
  return capability;
}

function assertLocalConnectionTarget({ client, db, env }) {
  let uri;
  try { uri = new URL(env.MONGODB_URI); } catch { fail('ML_TEST_LOCAL_TARGET_INVALID'); }
  const database = env.ML_TEST_LOCAL_EXPECTED_DATABASE;
  const seedHosts = client?.options?.hosts;
  const localHost = hostname => LOCAL_MONGO_HOSTS.has(String(hostname || '').toLowerCase().replace(/^\[|\]$/g, ''));
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(database || '') || uri.protocol !== 'mongodb:'
      || !localHost(uri.hostname) || (uri.port && uri.port !== '27017') || uri.pathname !== `/${database}`
      || uri.hash || uri.searchParams.get('replicaSet') !== LOCAL_REPLICA_SET
      || env.MONGODB_REPLICA_SET !== LOCAL_REPLICA_SET || client?.options?.srvHost
      || client?.options?.replicaSet !== LOCAL_REPLICA_SET || !Array.isArray(seedHosts) || !seedHosts.length
      || seedHosts.some(host => !localHost(host.host) || (host.port && Number(host.port) !== 27017))
      || db?.databaseName !== database || db?.client !== client) fail('ML_TEST_LOCAL_TARGET_INVALID');
}

async function assertLocalStatusTarget({ client, db, env }) {
  if (!localFlagEnabled(env)) fail('ML_TEST_LOCAL_DISABLED');
  assertLocalConnectionTarget({ client, db, env });
  let hello;
  try { hello = await db.admin().command({ hello: 1 }); } catch { fail('ML_TEST_LOCAL_REPLICA_SET_REQUIRED'); }
  const localMember = value => {
    const match = String(value || '').match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!match) return false;
    const host = match[1].toLowerCase().replace(/^\[|\]$/g, '');
    return LOCAL_MONGO_HOSTS.has(host) && (!match[2] || Number(match[2]) === 27017);
  };
  if (hello?.setName !== LOCAL_REPLICA_SET || !hello.isWritablePrimary
      || !localMember(hello.me) || !Array.isArray(hello.hosts) || !hello.hosts.length
      || hello.hosts.some(host => !localMember(host))) fail('ML_TEST_LOCAL_REPLICA_SET_REQUIRED');
}

async function authorizeLocalTarget({ client, db, user, env }) {
  authorizeAdminAction(user);
  if (!localFlagEnabled(env)) fail('ML_TEST_LOCAL_DISABLED');
  await assertLocalStatusTarget({ client, db, env });
  const capability = Object.freeze({});
  grants.set(capability, { kind: 'LOCAL', client, db, businessId: config.businessId, scenarioId: config.scenarioId });
  return capability;
}
// Read-only status may be queried with the restore flag off. It is bound to
// the already configured application connection and fixed demo scope.
function assertCloudStatusTarget({ client, db, env }) {
  let uri;
  try { uri = new URL(env.FORECAST_CLOUD_MONGO_URI); } catch { fail('ML_TEST_CLOUD_TARGET_INVALID'); }
  const database = env.FORECAST_CLOUD_EXPECTED_DATABASE;
  if (env.FORECAST_CLOUD_EXPECTED_BUSINESS_ID !== config.businessId || env.FORECAST_CLOUD_EXPECTED_SCENARIO_ID !== config.scenarioId
      || !/^[A-Za-z0-9_-]{1,64}$/.test(database || '') || uri.protocol !== 'mongodb+srv:'
      || !uri.hostname.endsWith('.mongodb.net') || !uri.username || !uri.password || uri.port || uri.hash
      || uri.pathname !== `/${database}` || client?.options?.srvHost !== uri.hostname || db?.databaseName !== database || db?.client !== client
      || ['tls', 'ssl'].some(key => uri.searchParams.has(key) && uri.searchParams.get(key) !== 'true')
      || ['tlsInsecure', 'tlsAllowInvalidCertificates', 'tlsAllowInvalidHostnames', 'directConnection']
        .some(key => uri.searchParams.has(key) && uri.searchParams.get(key) !== 'false')) fail('ML_TEST_CLOUD_TARGET_INVALID');
}
function authorized(client, db, capability) {
  if (!capability || typeof capability !== 'object') return false;
  const grant = grants.get(capability);
  return Boolean(grant && grant.client === client && grant.db === db
    && grant.businessId === config.businessId && grant.scenarioId === config.scenarioId);
}
function cloudAuthorized(client, db, capability) {
  const grant = capability && typeof capability === 'object' ? grants.get(capability) : null;
  return grant?.kind === 'CLOUD' && authorized(client, db, capability);
}
module.exports = { authorizeCloudTarget, authorizeLocalTarget, assertCloudStatusTarget, assertLocalStatusTarget,
  assertLocalConnectionTarget, authorized, cloudAuthorized, cloudFlagEnabled, localFlagEnabled, CERTIFICATION,
  LOCAL_REPLICA_SET };
