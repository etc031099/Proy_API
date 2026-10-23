const { randomBytes } = require('node:crypto');
const testUri = process.env.MONGODB_TEST_URI
  || `mongodb://127.0.0.1:27018/telegram_indexes_${randomBytes(8).toString('hex')}_test?replicaSet=rs0&directConnection=true`;
const uri = new URL(testUri);
if (uri.protocol !== 'mongodb:' || uri.hostname !== '127.0.0.1' || uri.port !== '27018'
  || uri.username || uri.password || !/^\/telegram_indexes_[a-f0-9]{16}_test$/.test(uri.pathname)
  || uri.searchParams.get('replicaSet') !== 'rs0' || uri.searchParams.get('directConnection') !== 'true') {
  throw Error('Refusing MongoDB test URI: require unauthenticated 127.0.0.1:27018, isolated random database, rs0 and directConnection=true');
}
process.env.MONGODB_TEST_URI = uri.href;
require('./telegramIndexProvisioning.test');
