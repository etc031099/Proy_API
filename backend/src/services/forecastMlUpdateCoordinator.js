'use strict';

const mongoose = require('mongoose');
const config = require('../config/v3Operational');
const { ForecastMlUpdateEvent: Event, ForecastMlUpdateState: State,
  V3OperationalRevision: Revision, V3OperationalChange: Change } = require('../models');

const HORIZONS = [7, 14];
const DEBOUNCE_MS = 15 * 60 * 1000;
const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const MAX_INT64 = 9223372036854775807n;
const RIDGE_CATALOG_FIELDS = ['sku', 'categoryCode', 'subcategoryCode', 'brand',
  'presentation', 'unit', 'sizeValue', 'containedUnits'];

const isoDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const shiftDay = (day, offset) => {
  if (!isoDay(day)) throw new Error('Invalid closed-day watermark');
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
};
const limaDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone,
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const watermark = now => shiftDay(limaDay(now), -1);
const matureOrigin = (closedThrough, horizonDays) => shiftDay(closedThrough, -horizonDays);
const scope = ({ businessId, scenarioId, horizonDays }) => {
  if (!businessId || !scenarioId || !HORIZONS.includes(horizonDays)) throw new Error('Invalid forecast update scope');
  return { businessId, scenarioId, horizonDays };
};
const version = value => {
  const parsed = typeof value === 'bigint' ? value : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : null;
  if (parsed === null || parsed < 0n || parsed > MAX_INT64) throw new Error('Invalid V3 dataVersion');
  return parsed;
};
const relevantProductDiff = (before, after) => !before || !after || RIDGE_CATALOG_FIELDS.some(field =>
  (before[field] ?? null) !== (after[field] ?? null));

function classifyChange(change, { affectedLocalDate = null, closedThrough }) {
  if (change.entityType === 'sale' && change.operation === 'CREATE'
      && change.projection?.initialStatus === 'completed') {
    return { eventType: 'SALE_COMPLETED', affectedLocalDate: change.projection.localDate || null,
      historicalCorrection: false };
  }
  if (change.entityType === 'transaction' && change.operation === 'CANCEL'
      && change.projection?.type === 'sale') {
    const day = affectedLocalDate || null;
    return { eventType: 'SALE_CANCELLED', affectedLocalDate: day,
      historicalCorrection: Boolean(day && day <= closedThrough) };
  }
  if (change.entityType === 'product' && ['CREATE', 'UPDATE'].includes(change.operation)
      && relevantProductDiff(change.projection?.before, change.projection?.after)) {
    return { eventType: 'PRODUCT_UPDATED', affectedLocalDate: null, historicalCorrection: false };
  }
  return null;
}

const eligible = (row, now) => {
  const newMatureOrigin = row.latestMatureOrigin > (row.lastTrainedMatureOrigin || row.initialMatureOrigin);
  const correction = row.historicalCorrectionVersion != null;
  const debounceDone = row.nextEligibleAt <= now;
  const rateDone = correction || !row.lastAttemptAt || now.getTime() - row.lastAttemptAt.getTime() >= RATE_LIMIT_MS;
  return (newMatureOrigin || correction) && debounceDone && rateDone;
};
const log = (name, details) => console.info(JSON.stringify({ event: name, ...details }));

// Called by the V3 revision journal in the owning Mongo transaction. The unique
// event row prevents a repeated signal from incrementing the aggregate twice.
async function recordCommittedChange({ businessId, scenarioId, dataVersion, change, eventOrdinal,
  session, now = new Date(), affectedLocalDate = null }) {
  if (!session?.inTransaction()) throw new Error('Forecast update signal requires the owning transaction');
  const closedThrough = watermark(now);
  const event = classifyChange(change, { affectedLocalDate, closedThrough });
  if (!event) return false;
  const parsedVersion = version(dataVersion);
  for (const horizonDays of HORIZONS) {
    const key = scope({ businessId, scenarioId, horizonDays });
    const eventKey = `${parsedVersion}:${eventOrdinal}:${change.entityType}:${change.entityKey}:${change.operation}`;
    const inserted = await Event.updateOne({ ...key, eventKey }, { $setOnInsert: {
      ...key, eventKey, eventType: event.eventType, entityKey: change.entityKey,
      dataVersion: parsedVersion, affectedLocalDate: event.affectedLocalDate,
      historicalCorrection: event.historicalCorrection, occurredAt: now
    } }, { upsert: true, session, runValidators: true });
    if (!inserted.upsertedCount) continue;
    const old = await State.findOne(key).session(session).setOptions({ useBigInt64: true });
    const origin = matureOrigin(closedThrough, horizonDays);
    if (!old) {
      await State.create([{ ...key, status: 'PENDING', pendingSince: now,
        latestDataVersion: parsedVersion, eventCount: 1, lastDirtyAt: now,
        observationsClosedThrough: closedThrough, initialMatureOrigin: origin,
        latestMatureOrigin: origin, nextEligibleAt: new Date(now.getTime() + DEBOUNCE_MS),
        triggerReason: event.eventType,
        historicalCorrectionVersion: event.historicalCorrection ? parsedVersion : null,
        affectedLocalDate: event.historicalCorrection ? event.affectedLocalDate : null
      }], { session });
    } else {
      if (parsedVersion < version(old.latestDataVersion)) throw new Error('Forecast update dataVersion regressed');
      const wasSettled = old.lastProcessedDataVersion != null
        && version(old.lastProcessedDataVersion) === version(old.latestDataVersion)
        && old.historicalCorrectionVersion == null;
      if (wasSettled || old.status === 'CLAIMED') old.pendingSince = now;
      old.latestDataVersion = parsedVersion;
      old.eventCount += 1;
      old.lastDirtyAt = new Date(Math.max(old.lastDirtyAt.getTime(), now.getTime()));
      old.nextEligibleAt = new Date(old.lastDirtyAt.getTime() + DEBOUNCE_MS);
      old.triggerReason = event.eventType;
      if (closedThrough > old.observationsClosedThrough) {
        old.observationsClosedThrough = closedThrough;
        old.latestMatureOrigin = origin;
      }
      if (event.historicalCorrection) {
        old.historicalCorrectionVersion = parsedVersion;
        old.affectedLocalDate = !old.affectedLocalDate || event.affectedLocalDate < old.affectedLocalDate
          ? event.affectedLocalDate : old.affectedLocalDate;
      }
      if (old.status !== 'CLAIMED') old.status = 'PENDING';
      await old.save({ session });
    }
  }
  return true;
}

// A watermark advances from the Lima calendar, even on a day with zero sales.
// It certifies closed calendar dates; completeness of individual training rows
// remains a separate A.3.4 check.
async function refreshWatermarks({ businessId = config.businessId, scenarioId = config.scenarioId,
  now = new Date(), limit = 100 } = {}) {
  const closedThrough = watermark(now);
  const rows = await State.find({ businessId, scenarioId }).limit(limit)
    .setOptions({ useBigInt64: true }).lean();
  let ready = 0;
  for (const row of rows) {
    const origin = matureOrigin(closedThrough, row.horizonDays);
    const candidate = { ...row, observationsClosedThrough: closedThrough > row.observationsClosedThrough
      ? closedThrough : row.observationsClosedThrough,
    latestMatureOrigin: origin > row.latestMatureOrigin ? origin : row.latestMatureOrigin };
    const expiredClaim = row.status === 'CLAIMED' && row.leaseUntil <= now;
    // A crashed worker's lease is the same unfinished attempt, so recovery is
    // not held for another 24 hours by the attempt rate limit.
    if (expiredClaim) candidate.lastAttemptAt = null;
    const unsettled = candidate.lastProcessedDataVersion == null
      || version(candidate.latestDataVersion) > version(candidate.lastProcessedDataVersion)
      || candidate.historicalCorrectionVersion != null
      || candidate.latestMatureOrigin > (candidate.lastTrainedMatureOrigin || candidate.initialMatureOrigin);
    const status = eligible(candidate, now) ? 'READY' : unsettled ? 'PENDING' : 'IDLE';
    const filter = { _id: row._id, status: row.status, fencingToken: row.fencingToken,
      latestDataVersion: row.latestDataVersion, lastDirtyAt: row.lastDirtyAt };
    if (row.status === 'CLAIMED' && row.leaseUntil > now) {
      await State.updateOne(filter, { $set: { observationsClosedThrough: candidate.observationsClosedThrough,
        latestMatureOrigin: candidate.latestMatureOrigin } });
      continue;
    }
    const updated = await State.updateOne(filter, { $set: { status,
      observationsClosedThrough: candidate.observationsClosedThrough,
      latestMatureOrigin: candidate.latestMatureOrigin, leaseOwner: null, leaseUntil: null,
      ...(expiredClaim ? { lastAttemptAt: null } : {}) } });
    if (updated.modifiedCount && status === 'READY') {
      ready += 1;
      if (row.status !== 'READY') log('ML_RETRAIN_REQUESTED', { horizonDays: row.horizonDays,
        dataVersion: String(row.latestDataVersion) });
    }
  }
  return { inspected: rows.length, ready, observationsClosedThrough: closedThrough };
}

async function claimEligibleUpdate({ businessId = config.businessId, scenarioId = config.scenarioId,
  horizonDays, leaseOwner, now = new Date() }) {
  if (typeof leaseOwner !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(leaseOwner)) throw new Error('Invalid lease owner');
  if (horizonDays != null) scope({ businessId, scenarioId, horizonDays });
  await refreshWatermarks({ businessId, scenarioId, now });
  const rows = await State.find({ businessId, scenarioId, ...(horizonDays && { horizonDays }),
    status: 'READY', nextEligibleAt: { $lte: now } }).sort({ nextEligibleAt: 1 })
    .limit(10).setOptions({ useBigInt64: true }).lean();
  for (const row of rows) {
    if (!eligible(row, now)) continue;
    const claimed = await State.findOneAndUpdate({ _id: row._id, status: 'READY',
      latestDataVersion: row.latestDataVersion, fencingToken: row.fencingToken,
      nextEligibleAt: { $lte: now } }, { $set: { status: 'CLAIMED', leaseOwner,
      leaseUntil: new Date(now.getTime() + LEASE_MS), lastAttemptAt: now,
      claimedDataVersion: row.latestDataVersion, claimedMatureOrigin: row.latestMatureOrigin,
      claimedCorrectionVersion: row.historicalCorrectionVersion }, $inc: { fencingToken: 1 } },
    { new: true }).setOptions({ useBigInt64: true }).lean();
    if (claimed) {
      log('ML_UPDATE_CLAIMED', { horizonDays: claimed.horizonDays, dataVersion: String(claimed.claimedDataVersion) });
      return { businessId, scenarioId, horizonDays: claimed.horizonDays,
        inputDataVersion: String(claimed.claimedDataVersion),
        latestMatureOrigin: claimed.claimedMatureOrigin,
        historicalCorrection: claimed.claimedCorrectionVersion != null,
        affectedLocalDate: claimed.affectedLocalDate,
        leaseOwner, fencingToken: claimed.fencingToken, leaseUntil: claimed.leaseUntil };
    }
  }
  return null;
}

async function finishUpdate({ businessId, scenarioId, horizonDays, leaseOwner, fencingToken,
  success, failureCode, now = new Date() }) {
  const key = scope({ businessId, scenarioId, horizonDays });
  if (typeof leaseOwner !== 'string' || !Number.isSafeInteger(fencingToken) || fencingToken < 1) throw new Error('Invalid claim');
  if (!success && (typeof failureCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(failureCode))) {
    throw new Error('Invalid sanitized failure code');
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      const row = await State.findOne({ ...key, status: 'CLAIMED', leaseOwner, fencingToken,
        leaseUntil: { $gt: now } }).session(session).setOptions({ useBigInt64: true });
      if (!row) { await session.abortTransaction(); return false; }
      const claimedVersion = version(row.claimedDataVersion);
      const newerEvent = version(row.latestDataVersion) > claimedVersion;
      if (success) {
        row.lastProcessedDataVersion = claimedVersion;
        row.lastTrainedMatureOrigin = row.claimedMatureOrigin;
        row.lastSuccessAt = now;
        row.lastFailureCode = null;
        if (row.historicalCorrectionVersion != null
            && version(row.historicalCorrectionVersion) <= claimedVersion) {
          row.historicalCorrectionVersion = null;
          row.affectedLocalDate = null;
        }
      } else {
        row.lastFailureAt = now;
        row.lastFailureCode = failureCode;
        row.nextEligibleAt = new Date(Math.max(row.nextEligibleAt.getTime(), now.getTime() + DEBOUNCE_MS));
      }
      row.status = success && !newerEvent && row.historicalCorrectionVersion == null ? 'IDLE' : 'PENDING';
      if (row.status === 'IDLE') row.pendingSince = now;
      row.leaseOwner = null;
      row.leaseUntil = null;
      row.claimedDataVersion = null;
      row.claimedMatureOrigin = null;
      row.claimedCorrectionVersion = null;
      if (newerEvent && row.nextEligibleAt < new Date(row.lastDirtyAt.getTime() + DEBOUNCE_MS)) {
        row.nextEligibleAt = new Date(row.lastDirtyAt.getTime() + DEBOUNCE_MS);
      }
      await row.save({ session });
      let commitError;
      for (let commitAttempt = 0; commitAttempt < 2; commitAttempt += 1) {
        try { await session.commitTransaction(); commitError = null; break; }
        catch (error) {
          commitError = error;
          if (!error.hasErrorLabel?.('UnknownTransactionCommitResult') || commitAttempt === 1) break;
        }
      }
      if (commitError) {
        if (commitError.hasErrorLabel?.('UnknownTransactionCommitResult')) {
          throw Object.assign(new Error('Forecast update commit outcome is unknown'), { code: 'COMMIT_RESULT_UNKNOWN' });
        }
        throw commitError;
      }
      log(success ? 'ML_UPDATE_ACKED' : 'ML_UPDATE_FAILED', { horizonDays, dataVersion: String(claimedVersion),
        ...(success ? {} : { failureCode }) });
      return true;
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction();
      if (attempt === 0 && (error.hasErrorLabel?.('TransientTransactionError') || error.code === 112)) continue;
      throw error;
    } finally { await session.endSession(); }
  }
  return false;
}

const ackUpdate = input => finishUpdate({ ...input, success: true });
const failUpdate = input => finishUpdate({ ...input, success: false });

// Version-pinned, keyset-paginated journal export. The A.3.4 worker combines
// these pages with its immutable historical bundle; it must discard all pages
// if this method throws, including on a concurrent revision change.
async function exportOperationalChanges({ businessId = config.businessId, scenarioId = config.scenarioId,
  inputDataVersion, pageSize = 250, onPage }) {
  if (businessId !== config.businessId || scenarioId !== config.scenarioId) throw new Error('Invalid V3 export scope');
  const inputVersion = version(inputDataVersion);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500 || typeof onPage !== 'function') throw new Error('Invalid export contract');
  const session = await mongoose.startSession();
  let pages = 0, rows = 0, lastRevision = null, lastOrdinal = null;
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, readPreference: 'primary' });
    const revision = await Revision.findById(businessId).session(session).setOptions({ useBigInt64: true }).lean();
    if (!revision || version(revision.revision) !== inputVersion) throw new Error('TRAINING_EXPORT_VERSION_MISMATCH');
    while (true) {
      const cursor = lastRevision == null ? {} : { $or: [
        { revision: { $gt: lastRevision } },
        { revision: lastRevision, eventOrdinal: { $gt: lastOrdinal } }
      ] };
      const page = await Change.find({ businessId, scenarioId, revision: { $lte: inputVersion }, ...cursor })
        .sort({ revision: 1, eventOrdinal: 1 }).limit(pageSize + 1)
        .session(session).setOptions({ useBigInt64: true }).lean();
      const emitted = page.slice(0, pageSize);
      if (!emitted.length) break;
      await onPage(emitted.map(row => ({ ...row, revision: String(row.revision) })));
      pages += 1; rows += emitted.length;
      lastRevision = version(emitted.at(-1).revision); lastOrdinal = emitted.at(-1).eventOrdinal;
      if (page.length <= pageSize) break;
    }
    await session.commitTransaction();
    const current = await Revision.findById(businessId).setOptions({ useBigInt64: true }).lean();
    if (!current || version(current.revision) !== inputVersion) throw new Error('TRAINING_EXPORT_VERSION_MISMATCH');
    return { inputDataVersion: String(inputVersion), pages, rows, complete: true };
  } catch (error) { if (session.inTransaction()) await session.abortTransaction(); throw error; }
  finally { await session.endSession(); }
}

module.exports = { HORIZONS, DEBOUNCE_MS, RATE_LIMIT_MS, LEASE_MS, RIDGE_CATALOG_FIELDS,
  watermark, matureOrigin, relevantProductDiff, classifyChange, eligible,
  recordCommittedChange, refreshWatermarks, claimEligibleUpdate, ackUpdate, failUpdate,
  exportOperationalChanges };
