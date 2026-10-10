require('dotenv').config({ quiet: true });
const { randomUUID } = require('node:crypto');
if (!process.env.MONGODB_TEST_URI) throw Error('Local dedicated test Mongo required');
const target = new URL(process.env.MONGODB_TEST_URI);
if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  || !target.pathname.endsWith('_test')) throw Error('Refusing non-local/non-test Mongo');
target.pathname = `/telegram_recovery_${randomUUID().replaceAll('-', '')}_test`;
target.searchParams.set('directConnection', 'true');
process.env.MONGODB_TEST_URI = target.href;
require('./telegramRecovery.test');
