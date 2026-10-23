// Explicit disposable local runner. Never loads .env or accepts a cloud target.
const { randomBytes } = require('node:crypto');
const testUri = process.env.MONGODB_TEST_URI ||
  `mongodb://127.0.0.1:27018/telegram_operations_${randomBytes(8).toString('hex')}_test?replicaSet=rs0&directConnection=true`;
const url = new URL(testUri);
if (url.protocol !== 'mongodb:' || url.hostname !== '127.0.0.1' || url.port !== '27018'
  || url.username || url.password || !/^\/telegram_operations_[a-f0-9]{16}_test$/.test(url.pathname)
  || url.searchParams.get('replicaSet') !== 'rs0' || url.searchParams.get('directConnection') !== 'true') {
  throw Error('Refusing MongoDB test URI: require unauthenticated 127.0.0.1:27018, isolated random database, rs0 and directConnection=true');
}
process.env.MONGODB_TEST_URI = url.href;
require('./telegramOperations.test');
