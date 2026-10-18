'use strict';
require('dotenv').config({ quiet: true });
const { randomUUID } = require('node:crypto');
const uri = new URL(process.env.MONGODB_TEST_URI);
if (uri.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname)
    || !uri.pathname.endsWith('_test')) throw new Error('CHECKPOINT_LOCAL_TEST_DATABASE_REQUIRED');
uri.searchParams.delete('replicaSet'); uri.searchParams.set('directConnection', 'true');
uri.pathname = `/ml_checkpoint_${randomUUID().replaceAll('-', '')}_test`;
process.env.MONGODB_TEST_URI = uri.href;
require('./mlTestAdmin.test');
