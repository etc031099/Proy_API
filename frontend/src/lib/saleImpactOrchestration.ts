import { readForecastImpactSnapshot, uniqueForecastImpactProducts, type ForecastImpactProduct } from './forecastImpactSnapshot';
import { readInventoryImpactSnapshot, type InventoryImpactEvent, type InventoryImpactSnapshot } from './inventoryImpactSnapshot';
import { publishInventoryImpact } from './inventoryImpactChannel';
import { captureCustomerImpactSnapshot, makeCustomerImpactEvent, type CustomerImpactSnapshot } from './customerImpactSnapshot';
import { clearLatestCustomerImpact, publishCustomerImpact } from './customerImpactChannel';
import { captureSalesImpactSnapshot, waitForSalesImpactBefore, type SalesImpactSnapshot } from './salesImpactSnapshot';
import { publishCompletedSaleImpact } from './salesImpactChannel';
import { publishForecastImpactSale, readLatestForecastImpactSale } from './forecastImpactChannel';
import { readLatestCustomerImpact } from './customerImpactChannel';
import { readLatestInventoryImpact } from './inventoryImpactChannel';
import { readLatestSalesImpact } from './salesImpactChannel';
import { apiClient } from './api';

export type SaleImpactBaseline = {
  inventory: InventoryImpactSnapshot;
  customer: CustomerImpactSnapshot | null;
  forecast: Awaited<ReturnType<typeof readForecastImpactSnapshot>>;
  sales: SalesImpactSnapshot | null;
};

export type SaleImpactMetadata = {
  transactionId: string | null;
  occurredAt: string | null;
  customerId: string | null;
  total: number | null;
  currency: string | null;
};

const actionBaselines = new Map<string, Promise<SaleImpactBaseline>>();
const completedActionImpacts = new Set<string>();

async function captureBaseline(products: ForecastImpactProduct[], customerId: string | null): Promise<SaleImpactBaseline> {
  // Invalidate once, then start the independent HTTP/analytics snapshots together.
  // Inventory and forecast readers share the revision cache, so invalidating from
  // both readers concurrently would cancel one another's in-flight generation.
  try { apiClient.invalidateIntelligenceReads(); } catch { /* Baseline reads remain best-effort. */ }
  const individualCustomerId = customerId && customerId !== 'CONSUMER_FINAL' ? customerId : null;
  const [inventoryResult, customerResult, forecastResult, salesResult] = await Promise.allSettled([
    readInventoryImpactSnapshot(products, { invalidateCache: false }),
    individualCustomerId ? captureCustomerImpactSnapshot(individualCustomerId) : Promise.resolve(null),
    readForecastImpactSnapshot(products, { invalidateCache: false }),
    waitForSalesImpactBefore(captureSalesImpactSnapshot()),
  ]);
  const inventory: InventoryImpactSnapshot = inventoryResult.status === 'fulfilled' ? inventoryResult.value
    : { context: { businessId: null, scenarioId: null, datasetVersion: null }, complete: false,
      capturedAt: new Date().toISOString(), products: {} };
  const forecast: SaleImpactBaseline['forecast'] = forecastResult.status === 'fulfilled' ? forecastResult.value
    : { context: inventory.context, complete: false, revision: null, capturedAt: new Date().toISOString(),
      horizons: { 7: emptyHorizon(), 14: emptyHorizon() }, forecasts: {} };
  return { inventory,
    customer: customerResult.status === 'fulfilled' ? customerResult.value : null,
    forecast,
    sales: salesResult.status === 'fulfilled' ? salesResult.value : null };
}

function unavailableInventorySnapshot(products: ForecastImpactProduct[], context: InventoryImpactSnapshot['context']): InventoryImpactSnapshot {
  return { context, complete: false, capturedAt: new Date().toISOString(), products: Object.fromEntries(products.map(product => [product.sku, {
    sku: product.sku, name: product.name || product.sku, captureStatus: 'UNAVAILABLE' as const, stock: null,
    demand: null, coverage: null, inventoryPolicy: null, recommendation: null, risk: null, classification: null,
  }])) };
}

function emptyHorizon() {
  return { pending: null, signals: null, activeVersion: null, eligibility: null, reasonCode: null,
    currentlyRunning: null, lastEvaluatedAt: null, lastResult: null };
}

function alreadyPublished(transactionId: string | null): boolean {
  if (!transactionId) return false;
  return readLatestInventoryImpact()?.operationId === transactionId
    || readLatestCustomerImpact()?.transactionId === transactionId
    || readLatestSalesImpact()?.transactionId === transactionId
    || readLatestForecastImpactSale()?.transactionId === transactionId;
}

/** Shares the manual-sale capture and publication path with Assistant confirmations. */
export async function registerSaleWithImpacts<T>(options: {
  products: ForecastImpactProduct[];
  customerId: string | null;
  displayName: string;
  actionKey?: string;
  submit: () => Promise<T>;
  isSuccessful: (response: T) => boolean;
  getMetadata: (response: T) => SaleImpactMetadata;
}): Promise<T> {
  const products = uniqueForecastImpactProducts(options.products);
  const actionKey = options.actionKey;
  if (actionKey && completedActionImpacts.has(actionKey)) return options.submit();

  let baselinePromise: Promise<SaleImpactBaseline>;
  if (actionKey) {
    baselinePromise = actionBaselines.get(actionKey) || captureBaseline(products, options.customerId);
    actionBaselines.set(actionKey, baselinePromise);
  } else baselinePromise = captureBaseline(products, options.customerId);
  const baseline = await baselinePromise;
  // All BEFORE captures have resolved before this one commercial write.
  const response = await options.submit();
  if (!options.isSuccessful(response)) return response;
  if (products.length === 0) {
    if (actionKey) { completedActionImpacts.add(actionKey); actionBaselines.delete(actionKey); }
    return response;
  }

  const metadata = options.getMetadata(response);
  const occurredAt = metadata.occurredAt || new Date().toISOString();
  const context = baseline.forecast.context;
  const individualCustomerId = options.customerId && options.customerId !== 'CONSUMER_FINAL' ? options.customerId : null;
  const publishExistingImpacts = !alreadyPublished(metadata.transactionId);
  if (publishExistingImpacts) {
    publishForecastImpactSale({ version: 2, type: 'SALE_COMPLETED', transactionId: metadata.transactionId,
      occurredAt, hasCustomer: Boolean(individualCustomerId), customerRef: individualCustomerId,
      products, baseline: baseline.forecast, baselineUnavailable: !baseline.forecast.complete, context });
    publishCompletedSaleImpact({ businessContext: context, transactionId: metadata.transactionId, occurredAt,
      saleTotal: metadata.total === null ? null : { value: metadata.total, currency: metadata.currency || 'PEN' }, before: baseline.sales });
  }

  // Inventory and customer AFTER reads are independent. Start both together,
  // invalidate the shared revision cache only once, and publish each event only
  // after its own real BEFORE and AFTER snapshots are available (or explicitly unavailable).
  try { apiClient.invalidateIntelligenceReads(); } catch { /* The successful sale is unaffected. */ }
  const inventoryAfter = readInventoryImpactSnapshot(products, { invalidateCache: false });
  const customerAfter = individualCustomerId ? captureCustomerImpactSnapshot(individualCustomerId) : Promise.resolve(null);
  const inventoryCapture = inventoryAfter.then(after => {
    const baselineStatus: InventoryImpactEvent['baselineStatus'] = baseline.inventory.complete ? 'AVAILABLE'
      : Object.values(baseline.inventory.products).every(row => row.captureStatus === 'UNAVAILABLE') ? 'BASELINE_UNAVAILABLE' : 'PARTIAL';
    publishInventoryImpact({ version: 1, type: 'SALE', operationId: metadata.transactionId, occurredAt, reference: null,
      operationSucceeded: true, products, baseline: baseline.inventory, baselineStatus, after,
      afterUnavailable: !after.complete, context: baseline.inventory.context });
  }).catch(() => {
    const after = unavailableInventorySnapshot(products, baseline.inventory.context);
    const baselineStatus: InventoryImpactEvent['baselineStatus'] = baseline.inventory.complete ? 'AVAILABLE'
      : Object.values(baseline.inventory.products).every(row => row.captureStatus === 'UNAVAILABLE') ? 'BASELINE_UNAVAILABLE' : 'PARTIAL';
    publishInventoryImpact({ version: 1, type: 'SALE', operationId: metadata.transactionId, occurredAt, reference: null,
      operationSucceeded: true, products, baseline: baseline.inventory, baselineStatus, after, afterUnavailable: true,
      context: baseline.inventory.context });
  });
  const customerCapture = customerAfter.then(after => {
    if (!individualCustomerId || !context.businessId || !context.scenarioId || !context.datasetVersion) {
      clearLatestCustomerImpact();
      return;
    }
    publishCustomerImpact(makeCustomerImpactEvent({ businessContext: context, transactionId: metadata.transactionId,
      displayName: options.displayName || 'Cliente', occurredAt, before: baseline.customer, after }));
  }).catch(() => {
    if (!individualCustomerId || !context.businessId || !context.scenarioId || !context.datasetVersion) {
      clearLatestCustomerImpact();
      return;
    }
    publishCustomerImpact(makeCustomerImpactEvent({ businessContext: context, transactionId: metadata.transactionId,
      displayName: options.displayName || 'Cliente', occurredAt, before: baseline.customer, after: null }));
  });
  await Promise.allSettled([inventoryCapture, customerCapture]);

  if (actionKey) {
    completedActionImpacts.add(actionKey);
    actionBaselines.delete(actionKey);
  }
  return response;
}
