'use strict';

const DATABASE_WRITE_BLOCKED_STORAGE = 'DATABASE_WRITE_BLOCKED_STORAGE';

function databaseStorageStatus(storageDegraded) {
  return {
    connected: true,
    readable: true,
    writesBlocked: Boolean(storageDegraded),
    storageDegraded: Boolean(storageDegraded),
    ...(storageDegraded ? { reasonCode: DATABASE_WRITE_BLOCKED_STORAGE } : {})
  };
}

function isAtlasStorageQuotaError(error) {
  const pending = [error];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || (typeof current !== 'object' && typeof current !== 'function') || seen.has(current)) continue;
    seen.add(current);
    if (Number(current.code) === 8000) return true;
    pending.push(current.cause, current.originalError);
    if (Array.isArray(current.writeErrors)) pending.push(...current.writeErrors);
  }
  return false;
}

async function initializeDatabaseBackedServices({ initializeCollections, provisionIndexes, refreshWatermarks,
  startPolling, onStorageDegraded = () => {}, onRefreshFailure = () => {} }) {
  const stages = [
    ['COLLECTION_INITIALIZATION', initializeCollections],
    ['INDEX_PROVISIONING', provisionIndexes]
  ];

  for (const [stage, initialize] of stages) {
    try {
      await initialize();
    } catch (error) {
      if (!isAtlasStorageQuotaError(error)) throw error;
      onStorageDegraded({ reasonCode: DATABASE_WRITE_BLOCKED_STORAGE, stage });
      return { mode: 'STORAGE_DEGRADED', reasonCode: DATABASE_WRITE_BLOCKED_STORAGE, stage };
    }
  }

  try {
    await refreshWatermarks();
  } catch (error) {
    if (isAtlasStorageQuotaError(error)) {
      onStorageDegraded({ reasonCode: DATABASE_WRITE_BLOCKED_STORAGE, stage: 'WATERMARK_REFRESH' });
      return { mode: 'STORAGE_DEGRADED', reasonCode: DATABASE_WRITE_BLOCKED_STORAGE, stage: 'WATERMARK_REFRESH' };
    }
    onRefreshFailure();
  }

  startPolling();
  return { mode: 'NORMAL', reasonCode: null, stage: null };
}

module.exports = { DATABASE_WRITE_BLOCKED_STORAGE, databaseStorageStatus, isAtlasStorageQuotaError,
  initializeDatabaseBackedServices };
