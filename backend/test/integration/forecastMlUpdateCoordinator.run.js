'use strict';

require('dotenv').config({ quiet: true });
const { randomUUID } = require('node:crypto');
if (!process.env.MONGODB_TEST_URI) throw new Error('A local dedicated Mongo test URI is required.');
const target = new URL(process.env.MONGODB_TEST_URI);
if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || !target.pathname.slice(1).endsWith('_test')) {
  throw new Error('Refusing non-local or non-test MongoDB for forecast coordinator integration tests.');
}
target.searchParams.delete('replicaSet');
target.searchParams.set('directConnection', 'true');
target.pathname = `/forecast_ml_update_${randomUUID().replaceAll('-', '')}_test`;
process.env.MONGODB_TEST_URI = target.href;
require('./forecastMlUpdateCoordinator.test');
