const { MongoClient, ObjectId } = require('mongodb');
const {
  SKU_INDEX_NAME,
  SKU_INDEX_KEY,
  SKU_PARTIAL_FILTER
} = require('../src/utils/sku');

const GLOBAL_SKU_INDEX_NAME = 'sku_1';

class SkuMigrationBlockedError extends Error {
  constructor(message, audit) {
    super(message);
    this.name = 'SkuMigrationBlockedError';
    this.audit = audit;
  }
}

const sameDocument = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const auditProducts = async (collection) => {
  const products = await collection.find({}, {
    projection: { businessId: 1, sku: 1, isActive: 1 }
  }).toArray();
  const pairs = new Map();
  const emptySkuIds = [];
  const malformed = [];

  for (const product of products) {
    if (product.sku === undefined || product.sku === null) continue;
    if (typeof product.sku !== 'string') {
      malformed.push({ id: String(product._id), reason: 'SKU is not a string' });
      continue;
    }

    const normalizedSku = product.sku.trim();
    if (normalizedSku === '') {
      emptySkuIds.push(String(product._id));
      continue;
    }
    if (normalizedSku !== product.sku) {
      malformed.push({ id: String(product._id), reason: 'SKU has surrounding whitespace' });
      continue;
    }
    if (typeof product.businessId !== 'string' || product.businessId.trim() === '') {
      malformed.push({ id: String(product._id), reason: 'Real SKU has no valid businessId' });
      continue;
    }

    const key = JSON.stringify([product.businessId, normalizedSku]);
    if (!pairs.has(key)) {
      pairs.set(key, {
        businessId: product.businessId,
        sku: normalizedSku,
        ids: [],
        active: 0,
        inactive: 0
      });
    }
    const group = pairs.get(key);
    group.ids.push(String(product._id));
    product.isActive === false ? group.inactive++ : group.active++;
  }

  return {
    totalProducts: products.length,
    emptySkuIds,
    malformed,
    duplicates: [...pairs.values()].filter(group => group.ids.length > 1)
  };
};

const desiredIndexIsValid = (index) => Boolean(index)
  && sameDocument(index.key, SKU_INDEX_KEY)
  && index.unique === true
  && sameDocument(index.partialFilterExpression, SKU_PARTIAL_FILTER);

const migrateSkuIndex = async ({ uri, expectedDb, collectionName = 'products' }) => {
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
    const audit = await auditProducts(collection);
    const indexesBefore = await collection.indexes();
    const globalIndex = indexesBefore.find(index => index.name === GLOBAL_SKU_INDEX_NAME);
    const desiredIndex = indexesBefore.find(index => index.name === SKU_INDEX_NAME);

    if (globalIndex && !sameDocument(globalIndex.key, { sku: 1 })) {
      throw new SkuMigrationBlockedError('sku_1 has an unexpected key definition', audit);
    }
    if (desiredIndex && !desiredIndexIsValid(desiredIndex)) {
      throw new SkuMigrationBlockedError(`${SKU_INDEX_NAME} has unexpected options`, audit);
    }
    if (audit.duplicates.length > 0 || audit.malformed.length > 0) {
      throw new SkuMigrationBlockedError('SKU data conflicts must be resolved manually', audit);
    }

    if (audit.emptySkuIds.length > 0) {
      await collection.updateMany(
        { _id: { $in: audit.emptySkuIds.map(id => new ObjectId(id)) } },
        { $set: { sku: null } }
      );
    }

    if (!desiredIndex) {
      await collection.createIndex(SKU_INDEX_KEY, {
        name: SKU_INDEX_NAME,
        unique: true,
        partialFilterExpression: SKU_PARTIAL_FILTER
      });
    }

    // Create and verify the tenant-scoped guard before removing the old global index.
    const afterCreate = await collection.indexes();
    if (!desiredIndexIsValid(afterCreate.find(index => index.name === SKU_INDEX_NAME))) {
      throw new Error(`Failed to verify ${SKU_INDEX_NAME}`);
    }
    if (afterCreate.some(index => index.name === GLOBAL_SKU_INDEX_NAME)) {
      await collection.dropIndex(GLOBAL_SKU_INDEX_NAME);
    }

    const indexesAfter = await collection.indexes();
    if (!desiredIndexIsValid(indexesAfter.find(index => index.name === SKU_INDEX_NAME))) {
      throw new Error(`Final verification failed for ${SKU_INDEX_NAME}`);
    }
    if (indexesAfter.some(index => index.name === GLOBAL_SKU_INDEX_NAME)) {
      throw new Error(`${GLOBAL_SKU_INDEX_NAME} still exists after migration`);
    }

    return {
      database: db.databaseName,
      collection: collectionName,
      normalizedEmptySkus: audit.emptySkuIds.length,
      index: SKU_INDEX_NAME
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
  return {
    uriEnv: read('--uri-env'),
    expectedDb: read('--expected-db')
  };
};

if (require.main === module) {
  require('dotenv').config();
  const { uriEnv, expectedDb } = parseArguments(process.argv.slice(2));
  const uri = uriEnv && process.env[uriEnv];

  migrateSkuIndex({ uri, expectedDb })
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
  GLOBAL_SKU_INDEX_NAME,
  SkuMigrationBlockedError,
  auditProducts,
  desiredIndexIsValid,
  migrateSkuIndex
};
