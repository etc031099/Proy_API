'use strict';
require('dotenv').config({ quiet: true });
const { randomUUID } = require('node:crypto');
let target;
try { target = new URL(process.env.MONGODB_TEST_URI); } catch { throw new Error('CHECKPOINT_LOCAL_TEST_URI_REQUIRED'); }
if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || !target.pathname.endsWith('_test')) throw new Error('CHECKPOINT_LOCAL_TEST_DATABASE_REQUIRED');
target.searchParams.delete('replicaSet'); target.searchParams.set('directConnection', 'true');
target.pathname = `/ml_checkpoint_${randomUUID().replaceAll('-', '')}_test`;
process.env.MONGODB_TEST_URI = target.href;
require('./mlTestRestore.test');
