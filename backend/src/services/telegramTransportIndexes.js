const Binding = require('../models/TelegramAssistantBinding');
const Receipt = require('../models/TelegramUpdateReceipt');
const Callback = require('../models/TelegramCallbackToken');
const Conversation = require('../models/AgentConversation');
const Message = require('../models/AgentConversationMessage');
const DEFAULT_MODELS = [Binding, Receipt, Callback, Conversation, Message];
const fail = (code, details) => { throw Object.assign(new Error(code), { code, details }); };
const INDEX_OPTIONS = ['unique', 'sparse', 'expireAfterSeconds', 'partialFilterExpression', 'collation', 'hidden',
  'wildcardProjection', 'weights', 'default_language', 'language_override', 'textIndexVersion', '2dsphereIndexVersion',
  'bits', 'min', 'max', 'bucketSize', 'sphereIndexVersion', 'storageEngine', 'prepareUnique'];
const INDEX_METADATA = new Set(['v', 'ns', 'buildUUID', 'background']);

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
};
const sameKey = (left, right) => JSON.stringify(Object.entries(left || {})) === JSON.stringify(Object.entries(right || {}));
const normalizedOptions = options => Object.fromEntries(INDEX_OPTIONS.map(key => [key,
  key === 'unique' || key === 'sparse' || key === 'hidden' ? options[key] === true
    : Object.hasOwn(options, key) ? stable(options[key]) : null]));
const defaultIndexName = key => Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join('_');
const expectedIndexes = Model => Model.schema.indexes().map(([key, options]) => ({
  name: options.name || defaultIndexName(key),
  key,
  options: normalizedOptions(options)
}));

const listActualIndexes = async Model => {
  try { return { collectionExists: true, indexes: await Model.collection.listIndexes().toArray() }; }
  catch (error) {
    if (error.code === 26 || error.codeName === 'NamespaceNotFound') return { collectionExists: false, indexes: [] };
    throw error;
  }
};

const inspectTelegramTransportIndexes = async (models = DEFAULT_MODELS) => {
  const collections = [];
  for (const Model of models) {
    if (Model.schema.options.autoCreate !== false || Model.schema.options.autoIndex !== false)
      fail('TELEGRAM_INDEX_AUTOCREATE_NOT_DISABLED', { collection: Model.collection.collectionName });
    const { collectionExists, indexes: actual } = await listActualIndexes(Model);
    const required = expectedIndexes(Model);
    const indexes = required.map(expected => {
      const byName = actual.find(index => index.name === expected.name);
      const byKey = actual.filter(index => sameKey(index.key, expected.key));
      const candidates = [...new Set([...(byName ? [byName] : []), ...byKey])];
      const exact = candidates.find(index => index.name === expected.name && sameKey(index.key, expected.key)
        && JSON.stringify(normalizedOptions(index)) === JSON.stringify(expected.options)
        && Object.keys(index).every(key => INDEX_METADATA.has(key) || ['name', 'key', ...INDEX_OPTIONS].includes(key)));
      if (exact) return { name: expected.name, key: expected.key, status: 'EXISTS' };
      if (candidates.length) {
        const reasons = [];
        if (byName && !sameKey(byName.key, expected.key)) reasons.push('NAME_HAS_DIFFERENT_KEYS');
        if (byKey.some(index => index.name !== expected.name)) reasons.push('KEY_HAS_DIFFERENT_NAME');
        if (byName && sameKey(byName.key, expected.key)
          && JSON.stringify(normalizedOptions(byName)) !== JSON.stringify(expected.options)) reasons.push('OPTIONS_MISMATCH');
        if (candidates.some(index => Object.keys(index).some(key => !INDEX_METADATA.has(key)
          && !['name', 'key', ...INDEX_OPTIONS].includes(key)))) reasons.push('UNSUPPORTED_EXISTING_OPTION');
        return { name: expected.name, key: expected.key, status: 'CONFLICT', reasons: [...new Set(reasons)] };
      }
      return { name: expected.name, key: expected.key, status: 'MISSING' };
    });
    collections.push({ collection: Model.collection.collectionName, exists: collectionExists, indexes });
  }
  const summary = collections.flatMap(row => row.indexes).reduce((result, index) => {
    result[index.status.toLowerCase()]++;
    return result;
  }, { exists: 0, missing: 0, conflict: 0 });
  return { collections, summary };
};

const verifyTelegramTransportIndexes = async (models = DEFAULT_MODELS) => {
  const report = await inspectTelegramTransportIndexes(models);
  if (report.summary.missing || report.summary.conflict) fail('TELEGRAM_INDEXES_NOT_READY', report);
  return report;
};

// Administrative provisioning only: never invoked automatically by startup or webhook.
// MongoDB does not make a multi-index creation sequence globally atomic.
const provisionTelegramTransportIndexes = async (models = DEFAULT_MODELS, {
  expectedDatabaseName, actualDatabaseName, authorized = false
} = {}) => {
  if (authorized !== true) fail('TELEGRAM_PROVISION_NOT_AUTHORIZED');
  if (typeof expectedDatabaseName !== 'string' || !expectedDatabaseName
    || actualDatabaseName !== expectedDatabaseName) fail('TELEGRAM_DATABASE_MISMATCH');

  const plan = await inspectTelegramTransportIndexes(models);
  if (plan.summary.conflict) fail('TELEGRAM_INDEX_CONFLICT', plan);
  if (plan.collections.some(row => !row.exists)) fail('TELEGRAM_COLLECTIONS_MISSING', plan);
  for (const row of plan.collections) {
    const Model = models.find(model => model.collection.collectionName === row.collection);
    for (const index of row.indexes) {
      if (index.status !== 'MISSING') continue;
      const expected = expectedIndexes(Model).find(item => item.name === index.name);
      const booleanOptions = new Set(['unique', 'sparse', 'hidden']);
      const options = Object.fromEntries(INDEX_OPTIONS.filter(key => booleanOptions.has(key)
        ? expected.options[key] === true : expected.options[key] !== null)
        .map(key => [key, expected.options[key]]));
      await Model.collection.createIndex(expected.key, { ...options, name: expected.name });
    }
  }
  return verifyTelegramTransportIndexes(models);
};

module.exports = { inspectTelegramTransportIndexes, provisionTelegramTransportIndexes, verifyTelegramTransportIndexes };
