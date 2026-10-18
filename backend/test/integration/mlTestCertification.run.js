'use strict';
require('dotenv').config({ quiet: true });
// Each case allocates and removes its own strictly validated disposable DB.
const target = new URL(process.env.MONGODB_TEST_URI);
if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || !target.pathname.endsWith('_test')) throw new Error('CHECKPOINT_LOCAL_TEST_DATABASE_REQUIRED');
target.searchParams.delete('replicaSet'); target.searchParams.set('directConnection', 'true');
process.env.MONGODB_TEST_URI = target.href;
require('./mlTestCertification.test');
