'use strict';

const { MongoClient } = require('mongodb');
const { checkProductOperationIndexes, provisionProductOperationIndexes } = require('../src/services/productOperationIndexes');

const URI_ENV = 'MONGODB_URI';
const DATABASE_ENV = 'PRODUCT_OP_INDEX_EXPECTED_DATABASE';
const REMOTE_APPLY_ENV = 'PRODUCT_OP_INDEX_ALLOW_REMOTE_APPLY';
const REMOTE_APPLY_CONFIRMATION = 'CREATE_PRODUCT_OPERATION_INDEXES';

function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseArgs(args) {
  if (args.length > 1 || args.some(arg => !['--check', '--apply'].includes(arg))
      || (args.includes('--check') && args.includes('--apply'))) throw safeError('PRODUCT_OP_INDEX_ARGUMENTS_INVALID');
  return args.includes('--apply') ? 'APPLY' : 'CHECK';
}

function readConfig(env = process.env) {
  const uri = typeof env[URI_ENV] === 'string' ? env[URI_ENV].trim() : '';
  const expectedDatabase = typeof env[DATABASE_ENV] === 'string' ? env[DATABASE_ENV].trim() : '';
  if (!uri || !expectedDatabase) throw safeError('PRODUCT_OP_INDEX_CONFIG_MISSING');
  let parsed;
  try { parsed = new URL(uri); } catch { throw safeError('PRODUCT_OP_INDEX_URI_INVALID'); }
  if (!/^mongodb(?:\+srv)?:$/.test(parsed.protocol)) throw safeError('PRODUCT_OP_INDEX_URI_INVALID');
  const uriDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  if (!uriDatabase || uriDatabase !== expectedDatabase) throw safeError('PRODUCT_OP_INDEX_DATABASE_MISMATCH');
  return { uri, expectedDatabase, isLocal: ['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']
    .includes(parsed.hostname.toLowerCase()) };
}

function publicFailure(error) {
  const allowed = new Set(['PRODUCT_OP_INDEX_ARGUMENTS_INVALID', 'PRODUCT_OP_INDEX_CONFIG_MISSING',
    'PRODUCT_OP_INDEX_URI_INVALID', 'PRODUCT_OP_INDEX_DATABASE_MISMATCH', 'PRODUCT_OP_INDEX_CONFLICT',
    'PRODUCT_OP_INDEX_COLLECTION_MISSING', 'PRODUCT_OP_INDEX_VERIFY_FAILED', 'PRODUCT_OP_INDEX_REMOTE_APPLY_BLOCKED']);
  return allowed.has(error?.code) ? error.code : 'PRODUCT_OP_INDEX_OPERATION_FAILED';
}

async function runCli({ env = process.env, args = process.argv.slice(2), stdout = console.log,
  clientFactory = options => new MongoClient(options.uri, options.clientOptions) } = {}) {
  let client;
  try {
    const mode = parseArgs(args);
    const config = readConfig(env);
    if (mode === 'APPLY' && !config.isLocal && env[REMOTE_APPLY_ENV] !== REMOTE_APPLY_CONFIRMATION) {
      throw safeError('PRODUCT_OP_INDEX_REMOTE_APPLY_BLOCKED');
    }
    client = clientFactory({ uri: config.uri, clientOptions: { serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000, maxPoolSize: 2,
      readPreference: 'primary', ...(mode === 'APPLY' ? { writeConcern: { w: 'majority' } } : {}) } });
    await client.connect();
    const db = client.db(config.expectedDatabase);
    const result = mode === 'APPLY' ? await provisionProductOperationIndexes(db) : await checkProductOperationIndexes(db);
    const output = { mode, database: config.expectedDatabase, ...result,
      writes: mode === 'APPLY' ? result.createdCount : 0 };
    stdout(JSON.stringify(output));
    return output;
  } catch (error) {
    const output = { mode: args.includes('--apply') ? 'APPLY' : 'CHECK', status: 'FAILED',
      code: publicFailure(error), indexes: error?.details?.indexes, writes: 0 };
    stdout(JSON.stringify(output));
    process.exitCode = 1;
    return output;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

if (require.main === module) runCli();

module.exports = { URI_ENV, DATABASE_ENV, parseArgs, readConfig, publicFailure, runCli };
