'use strict';

require('dotenv').config({ quiet: true });
const { randomUUID } = require('node:crypto');

if (!process.env.MONGODB_TEST_URI) throw new Error('A dedicated local MONGODB_TEST_URI is required.');
if (!process.env.FORECAST_TRAINING_PYTHON) throw new Error('FORECAST_TRAINING_PYTHON is required.');
const target = new URL(process.env.MONGODB_TEST_URI);
if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || !target.pathname.slice(1).endsWith('_test')) {
  throw new Error('Refusing non-local or non-test MongoDB.');
}
target.searchParams.delete('replicaSet');
target.searchParams.set('directConnection', 'true');
target.pathname = `/forecast_ridge_${randomUUID().replaceAll('-', '')}_test`;
process.env.MONGODB_TEST_URI = target.href;
require('./forecastRidgeTraining.test');
