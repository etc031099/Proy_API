require('dotenv').config({ quiet: true });
const { randomUUID } = require('node:crypto');
// Preserve local test authentication, isolate dispatcher collection from every other suite.
const target = new URL(process.env.MONGODB_TEST_URI);
if (target.protocol !== 'mongodb:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  || !target.pathname.endsWith('_test')) throw Error('Local dedicated test Mongo required');
target.pathname = `/inventory_outbox_${randomUUID().replaceAll('-', '')}_test`;
process.env.MONGODB_TEST_URI = target.href;
require('./inventoryAlertOutbox.test');
