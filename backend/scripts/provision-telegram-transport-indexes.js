const mongoose = require('mongoose');
const { connectionOptions } = require('../src/config/database');
const indexService = require('../src/services/telegramTransportIndexes');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const usage = 'Usage: node scripts/provision-telegram-transport-indexes.js --expected-db <name> [--authorize-provision]';
const parseArgs = argv => {
  let expectedDatabaseName;
  let authorized = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--expected-db' && argv[index + 1]) expectedDatabaseName = argv[++index];
    else if (argv[index] === '--authorize-provision') authorized = true;
    else if (argv[index] === '--help') return { help: true };
    else fail('TELEGRAM_INDEX_INVALID_ARGUMENTS');
  }
  if (!expectedDatabaseName || !/^[A-Za-z0-9_-]{1,63}$/.test(expectedDatabaseName)) fail('TELEGRAM_EXPECTED_DATABASE_REQUIRED');
  return { expectedDatabaseName, authorized };
};

const run = async argv => {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage);
    return;
  }
  if (!process.env.MONGODB_URI) fail('MONGODB_URI_REQUIRED');

  await mongoose.connect(process.env.MONGODB_URI, connectionOptions());
  try {
    const connection = mongoose.connection;
    const actualDatabaseName = connection.db.databaseName;
    if (actualDatabaseName !== args.expectedDatabaseName) {
      console.log(JSON.stringify({ mode: args.authorized ? 'PROVISION' : 'PREFLIGHT',
        expectedDatabaseName: args.expectedDatabaseName, actualDatabaseName, databaseMatch: false }));
      fail('TELEGRAM_DATABASE_MISMATCH');
    }

    const hello = await connection.db.admin().command({ hello: 1 });
    if (!hello.setName || hello.isWritablePrimary !== true) fail('MONGODB_PRIMARY_REQUIRED');
    if (process.env.MONGODB_REPLICA_SET && hello.setName !== process.env.MONGODB_REPLICA_SET) fail('MONGODB_REPLICA_SET_MISMATCH');

    const metadata = { expectedDatabaseName: args.expectedDatabaseName, actualDatabaseName,
      databaseMatch: true, replicaSet: hello.setName, writablePrimary: true };
    const report = args.authorized
      ? await indexService.provisionTelegramTransportIndexes(undefined, { ...metadata, authorized: true })
      : await indexService.inspectTelegramTransportIndexes();
    const mode = args.authorized ? 'PROVISION' : 'PREFLIGHT';
    console.log(JSON.stringify({ mode, ...metadata, ...report }, null, 2));
    if (report.summary.conflict) process.exitCode = 2;
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  run(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ success: false, code: error.code || 'TELEGRAM_INDEX_OPERATION_FAILED',
      ...(error.details ? { details: error.details } : {}) }));
    process.exitCode = error.code === 'TELEGRAM_INDEX_CONFLICT' ? 2 : 1;
    void mongoose.disconnect();
  });
}

module.exports = { parseArgs, run };
