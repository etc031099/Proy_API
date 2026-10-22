import { readForecastImpactSnapshot, uniqueForecastImpactProducts, type ForecastImpactProduct } from './forecastImpactSnapshot';
import { publishConfirmedInventoryOperation, type InventoryImpactSnapshot, type InventoryImpactType } from './inventoryImpactSnapshot';
import { captureCustomerImpactSnapshot, makeCustomerImpactEvent, type CustomerImpactSnapshot } from './customerImpactSnapshot';
import { clearLatestCustomerImpact, publishCustomerImpact } from './customerImpactChannel';
import { type SalesImpactSnapshot } from './salesImpactSnapshot';
import { clearLatestForecastImpactSale, publishForecastImpactSale, readLatestForecastImpactSale } from './forecastImpactChannel';
import { readLatestCustomerImpact } from './customerImpactChannel';
import { clearLatestInventoryImpact, readLatestInventoryImpact } from './inventoryImpactChannel';
import { clearLatestSalesImpact, publishCompletedSaleImpact, readLatestSalesImpact } from './salesImpactChannel';

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

const ACTION_RESULT_TTL_MS = 60_000;
const MAX_ACTION_RESULTS = 100;
const completedActionImpacts = new Map<string, { expiresAt: number; response: unknown }>();
const inFlightActionImpacts = new Map<string, Promise<unknown>>();

type SaleImpactOptions<T> = {
  products: ForecastImpactProduct[];
  customerId: string | null;
  displayName: string;
  actionKey?: string;
  actionScope?: string;
  submit: () => Promise<T>;
  isSuccessful: (response: T) => boolean;
  getMetadata: (response: T) => SaleImpactMetadata;
};

function alreadyPublished(transactionId: string | null): boolean {
  if (!transactionId) return false;
  return readLatestInventoryImpact()?.operationId === transactionId
    || readLatestCustomerImpact()?.transactionId === transactionId
    || readLatestSalesImpact()?.transactionId === transactionId
    || readLatestForecastImpactSale()?.transactionId === transactionId;
}

/** Shares the manual-sale capture and publication path with Assistant confirmations. */
export async function registerSaleWithImpacts<T>(options: SaleImpactOptions<T>): Promise<T> {
  const scopedActionKey = options.actionKey && options.actionScope ? `${options.actionScope}:${options.actionKey}` : null;
  if (scopedActionKey) {
    const saved = completedActionImpacts.get(scopedActionKey);
    if (saved && saved.expiresAt > Date.now()) return saved.response as T;
    if (saved) completedActionImpacts.delete(scopedActionKey);
    const inFlight = inFlightActionImpacts.get(scopedActionKey);
    if (inFlight) return inFlight as Promise<T>;
    const operation = performSaleWithImpacts(options, scopedActionKey);
    inFlightActionImpacts.set(scopedActionKey, operation);
    try { return await operation; }
    finally { if (inFlightActionImpacts.get(scopedActionKey) === operation) inFlightActionImpacts.delete(scopedActionKey); }
  }
  return performSaleWithImpacts(options, null);
}

async function performSaleWithImpacts<T>(options: SaleImpactOptions<T>, scopedActionKey: string | null): Promise<T> {
  const products = uniqueForecastImpactProducts(options.products);
  const response = await options.submit();
  if (!options.isSuccessful(response)) return response;

  let metadata: SaleImpactMetadata;
  try { metadata = options.getMetadata(response); } catch {
    clearLatestInventoryImpact(); clearLatestCustomerImpact(); clearLatestSalesImpact(); clearLatestForecastImpactSale();
    return response;
  }
  if (!metadata.transactionId) {
    clearLatestInventoryImpact();
    clearLatestCustomerImpact();
    clearLatestSalesImpact();
    clearLatestForecastImpactSale();
    return response;
  }
  if (products.length === 0) {
    clearLatestInventoryImpact(); clearLatestCustomerImpact(); clearLatestSalesImpact(); clearLatestForecastImpactSale();
    if (scopedActionKey) rememberActionResult(scopedActionKey, response);
    return response;
  }
  const occurredAt = metadata.occurredAt || new Date().toISOString();
  const individualCustomerId = options.customerId && options.customerId !== 'CONSUMER_FINAL' ? options.customerId : null;
  if (alreadyPublished(metadata.transactionId)) {
    if (scopedActionKey) rememberActionResult(scopedActionKey, response);
    return response;
  }
  const context: InventoryImpactSnapshot['context'] = { businessId: null, scenarioId: null, datasetVersion: null };
  const pendingForecast = { version: 2 as const, type: 'SALE_COMPLETED' as const, transactionId: metadata.transactionId,
    occurredAt, hasCustomer: Boolean(individualCustomerId), customerRef: individualCustomerId, products,
    baseline: null, baselineUnavailable: true, context };
  try {
    publishForecastImpactSale(pendingForecast);
    publishCompletedSaleImpact({ businessContext: context, transactionId: metadata.transactionId, occurredAt,
      saleTotal: metadata.total === null ? null : { value: metadata.total, currency: metadata.currency || 'PEN' }, before: null });
  clearLatestCustomerImpact();
    publishConfirmedInventoryOperation({ type: 'SALE' as InventoryImpactType, operationId: metadata.transactionId,
      occurredAt, counterparty: individualCustomerId ? { role: 'CUSTOMER', id: individualCustomerId, name: options.displayName || null } : null,
      products }, after => {
      if (readLatestInventoryImpact()?.operationId !== metadata.transactionId) return;
      const verifiedContext = after.context;
      if (!verifiedContext.businessId || !verifiedContext.scenarioId || !verifiedContext.datasetVersion) return;
      publishForecastImpactSale({ ...pendingForecast, context: verifiedContext });
      if (individualCustomerId) void captureCustomerImpactSnapshot(individualCustomerId).then(customerAfter => {
        if (readLatestInventoryImpact()?.operationId !== metadata.transactionId) return;
        publishCustomerImpact(makeCustomerImpactEvent({ businessContext: verifiedContext, transactionId: metadata.transactionId,
          customerKind: 'IDENTIFIED', displayName: options.displayName || 'Cliente', occurredAt, before: null, after: customerAfter }));
      }).catch(() => {
        if (readLatestInventoryImpact()?.operationId !== metadata.transactionId) return;
        publishCustomerImpact(makeCustomerImpactEvent({ businessContext: verifiedContext,
          transactionId: metadata.transactionId, customerKind: 'IDENTIFIED', displayName: options.displayName || 'Cliente', occurredAt, before: null, after: null }));
      });
      else publishCustomerImpact(makeCustomerImpactEvent({ businessContext: verifiedContext, transactionId: metadata.transactionId,
        customerKind: 'CONSUMER_FINAL', displayName: options.displayName || 'Consumer Final', occurredAt, before: null, after: null }));
    });
  } catch { /* Analytics publication must never turn a confirmed sale into a failed UI result. */ }

  if (scopedActionKey) rememberActionResult(scopedActionKey, response);
  return response;
}

function rememberActionResult<T>(key: string, response: T): void {
  const now = Date.now();
  for (const [entryKey, entry] of completedActionImpacts) if (entry.expiresAt <= now) completedActionImpacts.delete(entryKey);
  while (completedActionImpacts.size >= MAX_ACTION_RESULTS) {
    const oldest = completedActionImpacts.keys().next().value;
    if (oldest === undefined) break;
    completedActionImpacts.delete(oldest);
  }
  completedActionImpacts.set(key, { expiresAt: now + ACTION_RESULT_TTL_MS, response });
}
