const Binding = require('../models/TelegramAssistantBinding');
const Receipt = require('../models/TelegramUpdateReceipt');
const Callback = require('../models/TelegramCallbackToken');
const Conversation = require('../models/AgentConversation');
const Message = require('../models/AgentConversationMessage');
const fail = () => { throw Object.assign(new Error('Telegram index conflict'), { code: 'TELEGRAM_INDEX_CONFLICT' }); };
// Administrative provisioning only: never invoked automatically by startup or webhook.
const provisionTelegramTransportIndexes = async (models = [Binding, Receipt, Callback, Conversation, Message]) => {
  for (const Model of models) {
    let actual;
    try { actual = await Model.collection.listIndexes().toArray(); }
    catch (error) { if (error.code !== 26) throw error; actual = []; }
    for (const [key, options] of Model.schema.indexes()) {
      const equivalent = actual.find(index => JSON.stringify(index.key) === JSON.stringify(key));
      if (equivalent) {
        if (Boolean(equivalent.unique) !== Boolean(options.unique) || equivalent.sparse || equivalent.partialFilterExpression
          || equivalent.expireAfterSeconds !== options.expireAfterSeconds) fail();
        continue;
      }
      if (actual.some(index => index.name === options.name)) fail();
      await Model.collection.createIndex(key, { name: options.name, ...(options.unique ? { unique: true } : {}),
        ...(options.expireAfterSeconds !== undefined ? { expireAfterSeconds: options.expireAfterSeconds } : {}) });
    }
  }
};
const verifyTelegramTransportIndexes = async (models = [Binding, Receipt, Callback, Conversation, Message]) => {
  for (const Model of models) {
    const actual = await Model.collection.listIndexes().toArray();
    for (const [key, options] of Model.schema.indexes()) {
      if (!actual.some(index => JSON.stringify(index.key) === JSON.stringify(key)
        && Boolean(index.unique) === Boolean(options.unique) && !index.partialFilterExpression && !index.sparse
        && index.expireAfterSeconds === options.expireAfterSeconds)) fail();
    }
  }
  return true;
};
module.exports = { provisionTelegramTransportIndexes, verifyTelegramTransportIndexes };
