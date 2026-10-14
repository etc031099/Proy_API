require('dotenv').config({ quiet: true });
const { randomUUID } = require('node:crypto');
if (!process.env.MONGODB_TEST_URI) throw new Error('A local dedicated replica-set test Mongo URI is required.');
const target = new URL(process.env.MONGODB_TEST_URI);
if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || !target.pathname.endsWith('_test')) {
  throw new Error('Refusing to run F.4B integration against a non-local or non-test Mongo database.');
}
target.pathname = `/inventory_v3_f4b_${randomUUID().replaceAll('-', '')}_test`;
target.searchParams.set('directConnection', 'true');
process.env.MONGODB_TEST_URI = target.href;
require('./v3LiveBackendContracts.test');
