'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { canonicalJson } = require('../../../scripts/lib/minimarket-v3-generator');
const { HistoricalScenario } = require('../../src/models');
const { BUSINESS_ID, SCENARIO_ID, RESET_MODELS, scenarioFilter } = require('./minimarketV3Mongo');

const PROTECTED_TENANTS = ['ML-CLOUD-DEMO', 'ML-CLOUD-DEMO-V2'];

function validateAtlasScenario(existing, counts, hash) {
  if (existing && (existing.sourceSha256 !== hash || existing.metadata?.importTarget !== 'atlas'
      || !['importing', 'failed', 'completed'].includes(existing.status))) throw new Error('V3 existente inesperado; detener sin sobrescribir.');
  if (!existing && Object.values(counts).some((count) => count !== 0)) throw new Error('Documentos V3 sin marcador aprobado; detener sin sobrescribir.');
}

async function preflightAtlas(pkg) {
  const counts = {};
  for (const model of [...RESET_MODELS, HistoricalScenario]) {
    const c = model.collection;
    const unexpected = await c.countDocuments({ $or: [
      { businessId: BUSINESS_ID, scenarioId: { $ne: SCENARIO_ID } },
      { scenarioId: SCENARIO_ID, businessId: { $ne: BUSINESS_ID } },
    ] });
    if (unexpected) throw new Error('Ownership V3 inesperado; detener sin escrituras.');
    counts[c.collectionName] = await c.countDocuments(scenarioFilter());
  }
  const existing = await HistoricalScenario.collection.findOne(scenarioFilter());
  validateAtlasScenario(existing, counts, pkg.manifest.hashes.logicalDatasetSha256);
  return { counts, existingApprovedRun: Boolean(existing), collisions: existing ? 'managed_existing_run' : 0 };
}

async function captureAtlasSnapshot() {
  const db = mongoose.connection.db;
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name).sort();
  const collections = {};
  const protectedTenants = {};
  for (const tenant of PROTECTED_TENANTS) protectedTenants[tenant] = {};
  for (const name of names) {
    const c = db.collection(name);
    const stats = await db.command({ collStats: name });
    collections[name] = { count: await c.countDocuments({}), dataSize: stats.size, storageSize: stats.storageSize, indexSize: stats.totalIndexSize };
    for (const tenant of PROTECTED_TENANTS) {
      const hash = crypto.createHash('sha256'); let count = 0;
      for await (const doc of c.find({ businessId: tenant }).sort({ _id: 1 }).batchSize(500)) {
        hash.update(canonicalJson(JSON.parse(JSON.stringify(doc))) + '\n'); count += 1;
      }
      protectedTenants[tenant][name] = { count, sha256: hash.digest('hex') };
    }
  }
  const stats = await db.stats();
  return { at: new Date().toISOString(), collections, protectedTenants,
    database: { collections: stats.collections, documents: stats.objects, dataSize: stats.dataSize, storageSize: stats.storageSize, indexSize: stats.indexSize } };
}

function compareProtectedSnapshots(before, after) {
  for (const tenant of PROTECTED_TENANTS) {
    const names = new Set([...Object.keys(before.protectedTenants[tenant]), ...Object.keys(after.protectedTenants[tenant])]);
    const emptyHash = crypto.createHash('sha256').digest('hex');
    for (const name of names) {
      const left = before.protectedTenants[tenant][name] || { count: 0, sha256: emptyHash };
      const right = after.protectedTenants[tenant][name] || { count: 0, sha256: emptyHash };
      if (left.count !== right.count || left.sha256 !== right.sha256) throw new Error(`Snapshot protegido cambió: ${tenant}/${name}. Detener y auditar; no borrar.`);
    }
  }
  return { countsUnchanged: true, documentHashesUnchanged: true };
}

module.exports = { PROTECTED_TENANTS, validateAtlasScenario, preflightAtlas, captureAtlasSnapshot, compareProtectedSnapshots };
