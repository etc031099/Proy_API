const { MongoClient } = require('mongodb');

const BUSINESS_ID_INDEX_NAME = 'businessId_1';
const BUSINESS_ID_INDEX_KEY = { businessId: 1 };
const EMAIL_INDEX_NAME = 'email_1';

class BusinessIdMigrationBlockedError extends Error {
  constructor(message, audit) {
    super(message);
    this.name = 'BusinessIdMigrationBlockedError';
    this.audit = audit;
  }
}

const sameDocument = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const auditUsers = async (collection) => {
  const users = await collection.find({}, { projection: { businessId: 1 } }).toArray();
  const groups = new Map();
  const invalid = [];

  for (const user of users) {
    const hasBusinessId = Object.prototype.hasOwnProperty.call(user, 'businessId');
    const value = user.businessId;
    if (!hasBusinessId || value === undefined) {
      invalid.push({ id: String(user._id), reason: 'businessId is missing' });
      continue;
    }
    if (value === null) {
      invalid.push({ id: String(user._id), reason: 'businessId is null' });
      continue;
    }
    if (typeof value !== 'string') {
      invalid.push({ id: String(user._id), reason: 'businessId is not a string' });
      continue;
    }
    if (value === '' || value.trim() === '') {
      invalid.push({ id: String(user._id), reason: 'businessId is blank' });
      continue;
    }
    if (value !== value.trim()) {
      invalid.push({ id: String(user._id), reason: 'businessId has surrounding whitespace' });
      continue;
    }

    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(String(user._id));
  }

  return {
    totalUsers: users.length,
    invalid,
    duplicates: [...groups.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([businessId, ids]) => ({ businessId, ids }))
  };
};

const isUniqueIndex = (index, key) => Boolean(index)
  && sameDocument(index.key, key)
  && index.unique === true;

const migrateBusinessIdIndex = async ({ uri, expectedDb, collectionName = 'users' }) => {
  if (!uri) throw new Error('MongoDB URI is required');
  if (!expectedDb) throw new Error('Expected database name is required');

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });

  try {
    await client.connect();
    const db = client.db();
    if (db.databaseName !== expectedDb) {
      throw new Error(`Refusing migration: connected database is not ${expectedDb}`);
    }

    const collectionExists = await db.listCollections(
      { name: collectionName },
      { nameOnly: true }
    ).hasNext();
    if (!collectionExists) {
      throw new Error(`Refusing migration: collection ${collectionName} does not exist`);
    }

    const collection = db.collection(collectionName);
    const audit = await auditUsers(collection);
    const indexesBefore = await collection.indexes();
    const emailIndex = indexesBefore.find(index => index.name === EMAIL_INDEX_NAME);
    const businessIndex = indexesBefore.find(index => index.name === BUSINESS_ID_INDEX_NAME);

    if (!isUniqueIndex(emailIndex, { email: 1 })) {
      throw new BusinessIdMigrationBlockedError('email_1 must remain unique', audit);
    }
    if (businessIndex && !sameDocument(businessIndex.key, BUSINESS_ID_INDEX_KEY)) {
      throw new BusinessIdMigrationBlockedError('businessId_1 has an unexpected key definition', audit);
    }
    if (audit.invalid.length > 0 || audit.duplicates.length > 0) {
      throw new BusinessIdMigrationBlockedError(
        'Invalid or duplicate businessId values must be resolved manually',
        audit
      );
    }

    if (!businessIndex) {
      await collection.createIndex(BUSINESS_ID_INDEX_KEY, {
        name: BUSINESS_ID_INDEX_NAME,
        unique: true
      });
    } else if (businessIndex.unique !== true) {
      await db.command({
        collMod: collectionName,
        index: { keyPattern: BUSINESS_ID_INDEX_KEY, prepareUnique: true }
      });
      await db.command({
        collMod: collectionName,
        index: { keyPattern: BUSINESS_ID_INDEX_KEY, unique: true },
        dryRun: true
      });
      await db.command({
        collMod: collectionName,
        index: { keyPattern: BUSINESS_ID_INDEX_KEY, unique: true }
      });
    }

    const indexesAfter = await collection.indexes();
    if (!isUniqueIndex(
      indexesAfter.find(index => index.name === BUSINESS_ID_INDEX_NAME),
      BUSINESS_ID_INDEX_KEY
    )) {
      throw new Error(`Failed to verify ${BUSINESS_ID_INDEX_NAME}`);
    }
    if (!isUniqueIndex(
      indexesAfter.find(index => index.name === EMAIL_INDEX_NAME),
      { email: 1 }
    )) {
      throw new Error(`Failed to verify ${EMAIL_INDEX_NAME}`);
    }

    return {
      database: db.databaseName,
      collection: collectionName,
      index: BUSINESS_ID_INDEX_NAME,
      totalUsers: audit.totalUsers
    };
  } finally {
    await client.close();
  }
};

const parseArguments = (args) => {
  const read = flag => {
    const position = args.indexOf(flag);
    return position === -1 ? undefined : args[position + 1];
  };
  return { uriEnv: read('--uri-env'), expectedDb: read('--expected-db') };
};

if (require.main === module) {
  require('dotenv').config();
  const { uriEnv, expectedDb } = parseArguments(process.argv.slice(2));
  const uri = uriEnv && process.env[uriEnv];

  migrateBusinessIdIndex({ uri, expectedDb })
    .then(result => console.log(JSON.stringify({ success: true, ...result })))
    .catch(error => {
      console.error(JSON.stringify({
        success: false,
        name: error.name,
        message: error.message,
        audit: error.audit
      }));
      process.exitCode = 1;
    });
}

module.exports = {
  BUSINESS_ID_INDEX_NAME,
  BUSINESS_ID_INDEX_KEY,
  EMAIL_INDEX_NAME,
  BusinessIdMigrationBlockedError,
  auditUsers,
  migrateBusinessIdIndex
};
