'use strict';

const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { estimateExpectedDailyDemand, generateDataset, perishableOrderCap } = require('../../scripts/lib/minimarket-v3-generator');
const { validateDataset } = require('../../scripts/validate-minimarket-v3-dataset');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-3-generator-tests-'));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

describe('M6.3 operational Minimarket V3 generator', () => {
  it('does not interpret stockout-censored days as zero demand', () => {
    const history = [
      ...Array.from({ length: 24 }, () => ({ unitsSold: 0, stockout: true })),
      ...Array.from({ length: 4 }, () => ({ unitsSold: 6, stockout: false })),
    ];
    const estimate = estimateExpectedDailyDemand(history, 6.6);
    assert.ok(estimate > 5.5, `estimate should stay near in-stock demand, got ${estimate}`);
    assert.ok(estimate < 6.6, `profile prior should keep estimate conservative, got ${estimate}`);
  });

  it('uses only the rolling calendar window and falls back to the profile prior when all days are censored', () => {
    const history = [
      { unitsSold: 30, stockout: false },
      ...Array.from({ length: 28 }, () => ({ unitsSold: 0, stockout: true })),
    ];
    assert.equal(estimateExpectedDailyDemand(history, 2), 2);
    assert.equal(estimateExpectedDailyDemand([], 2), 2);
  });

  it('caps short-life replenishment at shelf demand rounded to feasible supplier packs', () => {
    assert.equal(perishableOrderCap(6.6, 1, 4), 8);
    assert.equal(perishableOrderCap(0.2, 1, 4), 4);
    assert.equal(perishableOrderCap(3.2, 2, 4), 8);
    assert.equal(perishableOrderCap(80, 1, 4), 80, 'one-day shelf cap should prevent extreme perishable overstock');
  });

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
    const dailyRows = fs.readFileSync(path.join(tempRoot, 'run-a', 'product-daily.ndjson'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.sku === 'PAN-FRE-001');
    const stockoutDays = dailyRows.filter((row) => row.stockoutFlag).length;
    const episodes = dailyRows.reduce((state, row) => {
      if (row.stockoutFlag && !state.inEpisode) { state.count += 1; state.current = 1; state.inEpisode = true; }
      else if (row.stockoutFlag) state.current += 1;
      else { state.max = Math.max(state.max, state.current); state.current = 0; state.inEpisode = false; }
      return state;
    }, { count: 0, current: 0, max: 0, inEpisode: false });
    episodes.max = Math.max(episodes.max, episodes.current);
    const panLostDemand = dailyRows.reduce((sum, row) => sum + row.lostDemandSynthetic, 0);
    assert.ok(stockoutDays < 271, `PAN-FRE stockout days did not improve: ${stockoutDays}`);
    assert.ok(episodes.max < 35, `PAN-FRE longest stockout episode did not improve: ${episodes.max}`);
    assert.ok(panLostDemand < 1300, `PAN-FRE lost demand did not improve: ${panLostDemand}`);
    const panProduct = fs.readFileSync(path.join(tempRoot, 'run-a', 'products.ndjson'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line)).find((row) => row.sku === 'PAN-FRE-001');
    const panCap = perishableOrderCap(panProduct.baseUnitsPerDay, panProduct.shelfLifeDays, 4);
    assert.ok(Math.max(...dailyRows.map((row) => row.endingStock)) <= panProduct.initialStock + panCap * 2,
      'PAN-FRE ending stock should remain within opening stock plus two feasible short-life deliveries');
    assert.ok(panProduct.totalExpiredUnits < panProduct.recent28SoldUnits * 0.1,
      'PAN-FRE expiry should not indicate excessive perishable waste');
    const panPurchases = fs.readFileSync(path.join(tempRoot, 'run-a', 'purchase-items.ndjson'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.sku === 'PAN-FRE-001');
    assert.ok(panPurchases.length > 0, 'PAN-FRE should have replenishment orders');
    const pendingOrders = fs.readFileSync(path.join(tempRoot, 'run-a', 'purchases.ndjson'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.status === 'pending');
    assert.equal(pendingOrders.length, runA.manifest.counts.pendingPurchases);
    assert.ok(pendingOrders.every((row) => row.orderedLocalDate <= runA.manifest.dateRange.historyEnd && row.receivedAt === null));
  });

  it('refuses to overwrite an existing destination', () => {
    const existing = path.join(tempRoot, 'already-there');
    fs.mkdirSync(existing);
    assert.throws(() => generateDataset({ outputDir: existing }), /no lo sobrescribe/);
  });
});
