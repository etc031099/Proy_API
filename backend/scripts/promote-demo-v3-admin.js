'use strict';

const DEMO_BUSINESS_ID = 'MINIMARKET-PASCO-V3';
const REQUIRED_ENV = Object.freeze({
  uri: 'DEMO_V3_ADMIN_MONGO_URI',
  database: 'DEMO_V3_ADMIN_EXPECTED_DATABASE',
  email: 'DEMO_V3_ADMIN_EMAIL'
});

function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readConfig(env) {
  const uri = typeof env[REQUIRED_ENV.uri] === 'string' ? env[REQUIRED_ENV.uri].trim() : '';
  const expectedDatabase = typeof env[REQUIRED_ENV.database] === 'string' ? env[REQUIRED_ENV.database].trim() : '';
  const expectedEmail = typeof env[REQUIRED_ENV.email] === 'string' ? env[REQUIRED_ENV.email].trim().toLowerCase() : '';
  if (!uri || !expectedDatabase || !expectedEmail) throw safeError('ADMIN_PROMOTION_CONFIG_MISSING');
  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri)) throw safeError('ADMIN_PROMOTION_URI_INVALID');

  let uriDatabase;
  try { uriDatabase = decodeURIComponent(new URL(uri).pathname.replace(/^\//, '').split('/')[0] || ''); }
  catch { throw safeError('ADMIN_PROMOTION_URI_INVALID'); }
  if (!uriDatabase || uriDatabase !== expectedDatabase) throw safeError('ADMIN_PROMOTION_DATABASE_MISMATCH');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedEmail)) throw safeError('ADMIN_PROMOTION_EMAIL_INVALID');
  return { uri, expectedDatabase, expectedEmail, businessId: DEMO_BUSINESS_ID };
}

function partialId(id) {
  const value = String(id ?? '');
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function publicResult(status, user) {
  return {
    status,
    userId: partialId(user._id),
    businessId: user.businessId,
    currentRole: user.role,
    targetRole: 'admin',
    writes: status === 'PROMOTED' ? 1 : 0
  };
}

async function promoteDemoV3Admin({ db, expectedEmail, expectedDatabase, businessId = DEMO_BUSINESS_ID, apply = false }) {
  if (!db || typeof db.collection !== 'function') throw safeError('ADMIN_PROMOTION_DATABASE_UNAVAILABLE');
  if (businessId !== DEMO_BUSINESS_ID || !expectedDatabase) throw safeError('ADMIN_PROMOTION_SCOPE_INVALID');
  const users = db.collection('users');
  const matches = await users.find({ email: expectedEmail }).project({ _id: 1, businessId: 1, role: 1, isActive: 1 }).limit(2).toArray();
  if (matches.length === 0) throw safeError('ADMIN_PROMOTION_USER_NOT_FOUND');
  if (matches.length !== 1) throw safeError('ADMIN_PROMOTION_MULTIPLE_USERS');

  const user = matches[0];
  if (user.businessId !== businessId || user.businessId !== DEMO_BUSINESS_ID) throw safeError('ADMIN_PROMOTION_TENANT_MISMATCH');
  if (user.isActive !== true) throw safeError('ADMIN_PROMOTION_USER_INACTIVE');
  if (!['user', 'admin'].includes(user.role)) throw safeError('ADMIN_PROMOTION_ROLE_INVALID');
  if (user.role === 'admin') return publicResult('ALREADY_ADMIN', user);
  if (!apply) return publicResult('DRY_RUN', user);

  const result = await users.updateOne(
    { _id: user._id, businessId: DEMO_BUSINESS_ID, role: 'user', isActive: true },
    { $set: { role: 'admin' } },
    { writeConcern: { w: 'majority' } }
  );
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) throw safeError('ADMIN_PROMOTION_CONDITIONAL_UPDATE_FAILED');

  const verified = await users.findOne(
    { _id: user._id, businessId: DEMO_BUSINESS_ID },
    { projection: { _id: 1, businessId: 1, role: 1, isActive: 1 } }
  );
  if (!verified || verified.role !== 'admin' || verified.isActive !== true) throw safeError('ADMIN_PROMOTION_VERIFY_FAILED');
  return publicResult('PROMOTED', verified);
}

async function runCli({ env = process.env, args = process.argv.slice(2), stdout = console.log, clientFactory } = {}) {
  const unknownArgs = args.filter(arg => arg !== '--apply');
  if (unknownArgs.length || args.filter(arg => arg === '--apply').length > 1) throw safeError('ADMIN_PROMOTION_ARGUMENTS_INVALID');
  const apply = args.includes('--apply');
  const config = readConfig(env);
  let client;
  try {
    const MongoClient = clientFactory || require('mongodb').MongoClient;
    client = new MongoClient(config.uri, { writeConcern: { w: 'majority' } });
    await client.connect();
    const result = await promoteDemoV3Admin({
      db: client.db(config.expectedDatabase), expectedEmail: config.expectedEmail,
      expectedDatabase: config.expectedDatabase, businessId: config.businessId, apply
    });
    stdout(JSON.stringify(result));
    return result;
  } catch (error) {
    const allowedCodes = new Set([
      'ADMIN_PROMOTION_USER_NOT_FOUND', 'ADMIN_PROMOTION_MULTIPLE_USERS', 'ADMIN_PROMOTION_TENANT_MISMATCH',
      'ADMIN_PROMOTION_USER_INACTIVE', 'ADMIN_PROMOTION_ROLE_INVALID', 'ADMIN_PROMOTION_CONDITIONAL_UPDATE_FAILED',
      'ADMIN_PROMOTION_VERIFY_FAILED', 'ADMIN_PROMOTION_DATABASE_UNAVAILABLE'
    ]);
    const code = allowedCodes.has(error?.code) ? error.code : 'ADMIN_PROMOTION_OPERATION_FAILED';
    stdout(JSON.stringify({ status: 'FAILED', code, writes: 0 }));
    process.exitCode = 1;
    return { status: 'FAILED', code, writes: 0 };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

if (require.main === module) {
  runCli().catch(error => {
    const code = typeof error?.code === 'string' && error.code.startsWith('ADMIN_PROMOTION_')
      ? error.code : 'ADMIN_PROMOTION_OPERATION_FAILED';
    console.log(JSON.stringify({ status: 'FAILED', code, writes: 0 }));
    process.exitCode = 1;
  });
}

module.exports = { DEMO_BUSINESS_ID, REQUIRED_ENV, readConfig, promoteDemoV3Admin, runCli };
