'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { performance } = require('node:perf_hooks');
const { ForecastMlUpdateEvent: Event, ForecastMlUpdateState: State,
  V3OperationalRevision: Revision, V3OperationalChange: Change } = require('../../src/models');
const coordinator = require('../../src/services/forecastMlUpdateCoordinator');
const config = require('../../src/config/v3Operational');

const uri = process.env.MONGODB_TEST_URI;
const tenant = config.businessId;
const scenarioId = config.scenarioId;
const at = date => new Date(date);
const sale = n => ({ entityType: 'sale', entityKey: `sale-${n}`, operation: 'CREATE',
  projection: { initialStatus: 'completed', localDate: '2026-10-16' } });

async function signal({ businessId = tenant, revision, change = sale(revision), eventOrdinal = 0,
  now = at('2026-10-16T15:00:00Z'), commit = true } = {}) {
  const session = await mongoose.startSession();
  let signalMs = 0;
  try {
    session.startTransaction({ writeConcern: { w: 'majority' } });
    await Revision.updateOne({ _id: businessId }, { $set: { revision: BigInt(revision), bootstrapStatus: 'VERIFIED' } },
      { upsert: true, session });
    await Change.create([{ businessId, scenarioId, revision: BigInt(revision), eventOrdinal,
      eventKey: `${revision}:${eventOrdinal}`, effectiveAtUtc: now, ...change }], { session });
    const signalStart = performance.now();
    await coordinator.recordCommittedChange({ businessId, scenarioId, dataVersion: BigInt(revision),
      change, eventOrdinal, session, now, affectedLocalDate: '2026-10-10' });
    signalMs = performance.now() - signalStart;
    if (commit) await session.commitTransaction();
    else await session.abortTransaction();
  } finally { await session.endSession(); }
  return signalMs;
}

test('forecast coordinator transactional outbox, coalescing, claims, fencing, and version-pinned export',
  { timeout: 45000 }, async () => {
    assert.ok(uri);
    const target = new URL(uri);
    assert.equal(target.protocol, 'mongodb:');
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
    assert.match(target.pathname, /^\/forecast_ml_update_[a-f0-9]{32}_test$/);
    await mongoose.connect(uri, { directConnection: true, serverSelectionTimeoutMS: 8000 });
    const name = mongoose.connection.name;
    assert.match(name, /^forecast_ml_update_[a-f0-9]{32}_test$/);
    try {
      const hello = await mongoose.connection.db.admin().command({ hello: 1 });
      assert.equal(hello.setName, 'rs0');
      assert.equal(hello.isWritablePrimary, true);
      await Promise.all([Event.init(), State.init(), Revision.init(), Change.init()]);
      await signal({ revision: 1, commit: false });
      assert.equal(await Event.countDocuments(), 0);
      assert.equal(await State.countDocuments(), 0);
      assert.equal(await Change.countDocuments(), 0);
      await signal({ revision: 1 });
      assert.equal(await Event.countDocuments(), 2);
      assert.equal(await State.countDocuments(), 2);
      const repeatSession = await mongoose.startSession();
      try {
        repeatSession.startTransaction();
        await coordinator.recordCommittedChange({ businessId: tenant, scenarioId, dataVersion: 1n,
          change: sale(1), eventOrdinal: 0, session: repeatSession,
          now: at('2026-10-16T15:00:00Z') });
        await repeatSession.commitTransaction();
      } finally { await repeatSession.endSession(); }
      assert.equal((await State.findOne({ businessId: tenant, horizonDays: 7 })).eventCount, 1);
      const signalTimes = [];
      for (let revision = 2; revision <= 20; revision += 1) signalTimes.push(await signal({ revision }));
      console.info(JSON.stringify({ event: 'ML_COORD_LOCAL_SIGNAL_MEASUREMENT', samples: signalTimes.length,
        meanMs: Number((signalTimes.reduce((sum, ms) => sum + ms, 0) / signalTimes.length).toFixed(2)) }));
      const states = await State.find({ businessId: tenant }).setOptions({ useBigInt64: true }).lean();
      assert.equal(states.length, 2);
      assert(states.every(row => row.eventCount === 20 && row.latestDataVersion === 20n));
      assert.equal(await Event.countDocuments({ businessId: tenant }), 40);
      assert.equal(await coordinator.claimEligibleUpdate({ businessId: tenant, scenarioId,
        horizonDays: 7, leaseOwner: 'worker-a', now: at('2026-10-16T15:16:00Z') }), null,
      'today\'s sale alone does not mature a new label');
      const readyAt = at('2026-10-17T06:00:00Z');
      const claimStarted = performance.now();
      const [one, two] = await Promise.all(['worker-a', 'worker-b'].map(leaseOwner =>
        coordinator.claimEligibleUpdate({ businessId: tenant, scenarioId, horizonDays: 7, leaseOwner, now: readyAt })));
      console.info(JSON.stringify({ event: 'ML_COORD_LOCAL_CLAIM_MEASUREMENT',
        concurrentClaims: 2, elapsedMs: Number((performance.now() - claimStarted).toFixed(2)) }));
      assert.equal([one, two].filter(Boolean).length, 1);
      const claimed = one || two;
      assert.equal(claimed.inputDataVersion, '20');
      assert.equal(claimed.latestMatureOrigin, '2026-10-09');
      assert.equal((await State.findOne({ businessId: tenant, horizonDays: 14 })).status, 'READY',
        'the 14-day horizon is eligible independently and remains unclaimed');
      await signal({ revision: 21, now: at('2026-10-17T06:01:00Z') });
      const ackStarted = performance.now();
      assert.equal(await coordinator.ackUpdate({ businessId: tenant, scenarioId, horizonDays: 7,
        leaseOwner: claimed.leaseOwner, fencingToken: claimed.fencingToken, now: at('2026-10-17T06:02:00Z') }), true);
      console.info(JSON.stringify({ event: 'ML_COORD_LOCAL_ACK_MEASUREMENT',
        elapsedMs: Number((performance.now() - ackStarted).toFixed(2)) }));
      const afterAck = await State.findOne({ businessId: tenant, horizonDays: 7 }).setOptions({ useBigInt64: true }).lean();
      assert.equal(afterAck.status, 'PENDING');
      assert.equal(afterAck.lastProcessedDataVersion, 20n);
      assert.equal(afterAck.latestDataVersion, 21n);
      assert.equal(await coordinator.ackUpdate({ businessId: tenant, scenarioId, horizonDays: 7,
        leaseOwner: claimed.leaseOwner, fencingToken: claimed.fencingToken, now: at('2026-10-17T06:03:00Z') }), false);
      const claim14 = await coordinator.claimEligibleUpdate({ businessId: tenant, scenarioId,
        horizonDays: 14, leaseOwner: 'worker-14', now: at('2026-10-17T06:17:00Z') });
      assert.equal(claim14.inputDataVersion, '21');
      const recovered = await coordinator.claimEligibleUpdate({ businessId: tenant, scenarioId,
        horizonDays: 14, leaseOwner: 'worker-recovered', now: at('2026-10-17T06:23:00Z') });
      assert(recovered && recovered.fencingToken > claim14.fencingToken);
      assert.equal(await coordinator.failUpdate({ businessId: tenant, scenarioId, horizonDays: 14,
        leaseOwner: claim14.leaseOwner, fencingToken: claim14.fencingToken,
        failureCode: 'WORKER_FAILURE', now: at('2026-10-17T06:24:00Z') }), false);
      assert.equal(await coordinator.failUpdate({ businessId: tenant, scenarioId, horizonDays: 14,
        leaseOwner: recovered.leaseOwner, fencingToken: recovered.fencingToken,
        failureCode: 'WORKER_FAILURE', now: at('2026-10-17T06:24:00Z') }), true);
      const failedState = await State.findOne({ businessId: tenant, horizonDays: 14 }).lean();
      assert.equal(failedState.status, 'PENDING');
      assert.equal(failedState.lastFailureCode, 'WORKER_FAILURE');
      const ignored = { entityType: 'movement', entityKey: 'adjustment-22', operation: 'ADJUST', projection: {} };
      await signal({ revision: 22, change: ignored });
      assert.equal(await Event.countDocuments({ businessId: tenant }), 42);
      const correction = { entityType: 'transaction', entityKey: 'historical-sale', operation: 'CANCEL',
        projection: { type: 'sale' } };
      await signal({ revision: 23, change: correction, now: at('2026-10-17T06:25:00Z') });
      const corrected = await State.findOne({ businessId: tenant, horizonDays: 7 }).setOptions({ useBigInt64: true }).lean();
      assert.equal(corrected.historicalCorrectionVersion, 23n);
      assert.equal(corrected.affectedLocalDate, '2026-10-10');
      const priorityClaim = await coordinator.claimEligibleUpdate({ businessId: tenant, scenarioId,
        horizonDays: 7, leaseOwner: 'priority-worker', now: at('2026-10-17T06:41:00Z') });
      assert(priorityClaim && priorityClaim.historicalCorrection,
        'mature historical correction bypasses the 24-hour attempt rate limit after debounce');
      assert.equal(await coordinator.ackUpdate({ businessId: tenant, scenarioId, horizonDays: 7,
        leaseOwner: priorityClaim.leaseOwner, fencingToken: priorityClaim.fencingToken,
        now: at('2026-10-17T06:42:00Z') }), true);
      assert.equal((await State.findOne({ businessId: tenant, horizonDays: 7 })).status, 'IDLE');
      await signal({ businessId: 'other-tenant', revision: 1 });
      assert.equal(await State.countDocuments({ businessId: 'other-tenant' }), 2);
      const tenantScoped = await coordinator.claimEligibleUpdate({ businessId: tenant, scenarioId,
        horizonDays: 14, leaseOwner: 'tenant-check', now: at('2026-10-17T06:42:00Z') });
      assert.equal(tenantScoped?.businessId, tenant, 'claim remains scoped to the requested tenant');
      const pages = [];
      const exported = await coordinator.exportOperationalChanges({ businessId: tenant, scenarioId,
        inputDataVersion: '23', pageSize: 4, onPage: page => pages.push(page) });
      assert.equal(exported.complete, true);
      assert.equal(exported.rows, 23);
      assert.equal(pages.length, 6);
      await assert.rejects(coordinator.exportOperationalChanges({ businessId: tenant, scenarioId,
        inputDataVersion: '21', pageSize: 4, onPage: () => {} }), /TRAINING_EXPORT_VERSION_MISMATCH/);
      let raced = false;
      await assert.rejects(coordinator.exportOperationalChanges({ businessId: tenant, scenarioId,
        inputDataVersion: '23', pageSize: 4, onPage: async () => {
          if (!raced) { raced = true; await signal({ revision: 24 }); }
        } }), /TRAINING_EXPORT_VERSION_MISMATCH/);
    } finally {
      // The runner created this exact disposable database; never touch project data.
      if (mongoose.connection.name === name) await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });
