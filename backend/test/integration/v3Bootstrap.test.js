'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const mongoose = require('mongoose');
const { HistoricalScenario, Product, V3OperationalRevision, V3OperationalChange } = require('../../src/models');
const { config, bootstrapV3OperationalRevision, buildV3OperationalSnapshot } = require('../../src/services/v3OperationalSnapshotService');
const { assertLocalMongoUri, buildLocalDockerUri } = require('../../scripts/lib/minimarketV3Mongo');

test('F.5B bootstrap gates, rollback, idempotency and snapshot on local Mongo', async t => {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  const target = assertLocalMongoUri(buildLocalDockerUri(process.env.MONGODB_URI_DOCKER || ''));
  const database = `inventory_v3_f5b_${randomUUID().replaceAll('-', '')}_test`;
  target.pathname = `/${database}`;
  let connected = false;
  try {
    await mongoose.connect(target.toString(), { autoIndex: false, serverSelectionTimeoutMS: 7000 });
    connected = true;
    assert.equal(mongoose.connection.host, '127.0.0.1');
    assert.equal(mongoose.connection.name, database);
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.equal(hello.isWritablePrimary, true);
    assert.equal(hello.setName, 'rs0');
    for (const model of [HistoricalScenario, Product, V3OperationalRevision, V3OperationalChange]) await model.createCollection();
    await HistoricalScenario.create({ businessId: config.businessId, scenarioId: config.scenarioId,
      sourceSha256: config.sourceSha256, status: 'completed', metadata: {
        datasetVersion: config.datasetVersion, referenceDate: config.historicalCutoff, timezone: config.timezone
      } });

    await t.test('wrong tenant cannot initialize a revision', async () => {
      await assert.rejects(bootstrapV3OperationalRevision({ businessId: 'OTHER' }), error => error.code === 'V3_TENANT_REQUIRED');
      assert.equal(await V3OperationalRevision.countDocuments(), 0);
    });
    await t.test('base catalog requires the explicit attestation', async () => {
      // Minimal catalog sentinel in a disposable test database; no operational data.
      await Product.collection.insertOne({ businessId: config.businessId, scenarioId: config.scenarioId, sourceEventId: 'test-base' });
      await assert.rejects(bootstrapV3OperationalRevision({ businessId: config.businessId }),
        error => error.code === 'SNAPSHOT_BOOTSTRAP_ATTESTATION_REQUIRED');
      assert.equal(await V3OperationalRevision.countDocuments(), 0);
      await Product.collection.deleteMany({ businessId: config.businessId });
    });
    await t.test('uninitialized journal blocks the gate', async () => {
      await V3OperationalChange.collection.insertOne({ businessId: config.businessId });
      await assert.rejects(bootstrapV3OperationalRevision({ businessId: config.businessId }),
        error => error.code === 'SNAPSHOT_BOOTSTRAP_AMBIGUOUS');
      assert.equal(await V3OperationalRevision.countDocuments(), 0);
      await V3OperationalChange.collection.deleteMany({ businessId: config.businessId });
    });
    await t.test('failure before commit rolls back the initial revision', async () => {
      const original = mongoose.startSession;
      mongoose.startSession = async (...args) => {
        const session = await original.apply(mongoose, args);
        session.commitTransaction = async () => { throw new Error('F5B_FORCED_PRECOMMIT_FAILURE'); };
        return session;
      };
      try {
        await assert.rejects(bootstrapV3OperationalRevision({ businessId: config.businessId }), /F5B_FORCED_PRECOMMIT_FAILURE/);
      } finally { mongoose.startSession = original; }
      assert.equal(await V3OperationalRevision.countDocuments(), 0);
    });
    await t.test('second bootstrap preserves revision, timestamps and empty journal', async () => {
      const first = await bootstrapV3OperationalRevision({ businessId: config.businessId });
      const second = await bootstrapV3OperationalRevision({ businessId: config.businessId });
      assert.equal(first.bootstrapStatus, 'VERIFIED');
      assert.equal(String(first.revision), '0');
      assert.deepEqual(second, first);
      assert.equal(await V3OperationalRevision.countDocuments(), 1);
      assert.equal(await V3OperationalChange.countDocuments(), 0);
      const result = await buildV3OperationalSnapshot({ businessId: config.businessId,
        asOfDate: '2026-10-14', now: new Date('2026-10-14T18:00:00Z') });
      assert.equal(result.mode, 'LIVE');
      assert.equal(result.dataVersion, '0');
      assert.equal(result.snapshot.sales.length, 0);
      assert.equal(result.snapshot.purchases.length, 0);
      assert.match(result.snapshot.metadata.snapshotHash, /^[a-f0-9]{64}$/);
    });
  } finally {
    if (connected && mongoose.connection.host === '127.0.0.1' && mongoose.connection.name === database
        && /^inventory_v3_f5b_[a-f0-9]{32}_test$/.test(database)) await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
});
