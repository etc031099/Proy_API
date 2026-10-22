require('dotenv').config();
const connectDB = require('../src/config/database');

(async () => {
  await connectDB();
  try {
    const indexes = require('../src/services/telegramTransportIndexes');
    await indexes.provisionTelegramTransportIndexes();
    await indexes.verifyTelegramTransportIndexes();
    console.log('Telegram transport indexes verified.');
  } finally {
    await require('mongoose').connection.close();
  }
})().catch(error => {
  console.error('Telegram transport index provisioning failed:', error.code || 'INDEX_PROVISION_FAILED');
  process.exitCode = 1;
});
