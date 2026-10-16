'use strict';

require('dotenv').config({ quiet: true });
const { randomUUID } = require('node:crypto');

if (!process.env.MONGODB_TEST_URI) throw new Error('A local dedicated test Mongo URI is required.');
const target = new URL(process.env.MONGODB_TEST_URI);
if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || !target.pathname.slice(1).endsWith('_test')) {
  throw new Error('Refusing non-local or non-test MongoDB for forecast registry integration tests.');
}
// Use direct connection to the local rs0 node; the test verifies rs0 via hello.
target.searchParams.delete('replicaSet');
target.searchParams.set('directConnection', 'true');
target.pathname = `/forecast_registry_${randomUUID().replaceAll('-', '')}_test`;
process.env.MONGODB_TEST_URI = target.href;
require('./forecastModelRegistry.test');
