'use strict';
require('dotenv').config({ quiet: true });
const { randomUUID } = require('node:crypto');
if (!process.env.MONGODB_TEST_URI || !process.env.FORECAST_TRAINING_PYTHON) throw new Error('Local test Mongo and Python are required.');
const target = new URL(process.env.MONGODB_TEST_URI);
if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || !target.pathname.slice(1).endsWith('_test')) throw new Error('Refusing non-local/non-test Mongo.');
target.searchParams.delete('replicaSet');
target.searchParams.set('directConnection', 'true');
target.pathname = `/forecast_lifecycle_${randomUUID().replaceAll('-', '')}_test`;
process.env.MONGODB_TEST_URI = target.href;
require('./forecastRidgeLifecycle.test');
