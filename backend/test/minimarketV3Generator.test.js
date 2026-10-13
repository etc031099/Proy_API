'use strict';

const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateDataset } = require('../../scripts/lib/minimarket-v3-generator');
const { validateDataset } = require('../../scripts/validate-minimarket-v3-dataset');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-3-generator-tests-'));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

describe('M6.3 operational Minimarket V3 generator', () => {
  it('generates a deterministic, linked, ledger-valid 365-day business package', async () => {
    const runA = generateDataset({ outputDir: path.join(tempRoot, 'run-a') });
    const runB = generateDataset({ outputDir: path.join(tempRoot, 'run-b') });
    assert.equal(runA.manifest.hashes.logicalDatasetSha256, runB.manifest.hashes.logicalDatasetSha256);

    const auditA = await validateDataset(path.join(tempRoot, 'run-a'));
    const auditB = await validateDataset(path.join(tempRoot, 'run-b'));
    assert.equal(auditA.valid, true, auditA.errors.join('\n'));
    assert.equal(auditB.valid, true, auditB.errors.join('\n'));
    assert.equal(auditA.logicalDatasetSha256, auditB.logicalDatasetSha256);
    assert.equal(runA.manifest.seed, 2026);
    assert.equal(runA.manifest.counts.products, 80);
    assert.ok(runA.manifest.counts.completedSales >= 10000 && runA.manifest.counts.completedSales <= 15000);
    assert.ok(runA.manifest.counts.saleItems >= 30000 && runA.manifest.counts.saleItems <= 50000);
    assert.equal(runA.manifest.counts.productDailyRows, 29200);
    assert.equal(runA.manifest.counts.inventorySnapshotRows, 80);
    assert.ok(runA.manifest.aggregates.stockoutProductDayPct > 0 && runA.manifest.aggregates.stockoutProductDayPct <= 5);
    assert.ok(runA.report.analytics.topCooccurrencePairs.length > 0);
    assert.equal(Object.keys(runA.report.analytics.customerProfileEvidence).length, 6);
    assert.ok(runA.report.analytics.topSuppliers.filter((supplier) => supplier.receivedOrders > 0).length >= 8);
    assert.equal(auditA.measured.finalSnapshotCount, 80);
  });

  it('refuses to overwrite an existing destination', () => {
    const existing = path.join(tempRoot, 'already-there');
    fs.mkdirSync(existing);
    assert.throws(() => generateDataset({ outputDir: existing }), /no lo sobrescribe/);
  });
});
