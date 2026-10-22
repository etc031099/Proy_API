import { readForecastImpactSnapshot, registerSaleWithImpact, uniqueForecastImpactProducts, type ForecastImpactProduct } from './forecastImpactSnapshot';
import { recordInventoryOperation, readInventoryImpactSnapshot, type InventoryImpactSnapshot } from './inventoryImpactSnapshot';
import { captureCustomerImpactSnapshot, type CustomerImpactContext, type CustomerImpactSnapshot } from './customerImpactSnapshot';
import { registerCustomerSaleImpact } from './customerImpactChannel';
import { captureSalesImpactSnapshot, waitForSalesImpactBefore, type SalesImpactSnapshot } from './salesImpactSnapshot';
import { publishCompletedSaleImpact } from './salesImpactChannel';
import { publishForecastImpactSale, readLatestForecastImpactSale } from './forecastImpactChannel';
import { readLatestCustomerImpact } from './customerImpactChannel';
import { readLatestInventoryImpact } from './inventoryImpactChannel';
import { readLatestSalesImpact } from './salesImpactChannel';

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
  let inventory: InventoryImpactSnapshot;
  try { inventory = await readInventoryImpactSnapshot(products); }
  catch { inventory = { context: { businessId: null, scenarioId: null, datasetVersion: null }, complete: false,
    capturedAt: new Date().toISOString(), products: {} }; }

  let customer: CustomerImpactSnapshot | null = null;
  if (customerId) customer = await captureCustomerImpactSnapshot(customerId);

  const salesBefore = waitForSalesImpactBefore(captureSalesImpactSnapshot());
  let forecast: SaleImpactBaseline['forecast'];
  try { forecast = await readForecastImpactSnapshot(products); }
  catch { forecast = { context: inventory.context, complete: false, revision: null, capturedAt: new Date().toISOString(),
    horizons: { 7: emptyHorizon(), 14: emptyHorizon() }, forecasts: {} }; }
  return { inventory, customer, forecast, sales: await salesBefore };
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
  let customerContext: CustomerImpactContext = baseline.forecast.context;
  let skipPublishing = false;
  const shouldPublish = (response: T) => options.isSuccessful(response) && !skipPublishing;

  const response = await recordInventoryOperation({
    type: 'SALE', products,
    // All pre-write snapshots were captured above, before the existing write call.
    beforeSnapshot: baseline.inventory,
    submit: () => registerCustomerSaleImpact({
      customerMongoId: options.customerId,
      displayName: options.displayName,
      beforeSnapshot: baseline.customer,
      getContext: () => customerContext,
      submit: () => registerSaleWithImpact({
        products,
        captureBefore: async () => baseline.forecast,
        submit: options.submit,
        isSuccessful: shouldPublish,
        onSuccess: ({ response: result, products: affectedProducts }) => {
          const metadata = options.getMetadata(result);
          if (alreadyPublished(metadata.transactionId)) { skipPublishing = true; return; }
          if (actionKey) completedActionImpacts.add(actionKey);
          const occurredAt = metadata.occurredAt || new Date().toISOString();
          const context = baseline.forecast.context;
          customerContext = context;
          publishForecastImpactSale({ version: 2, type: 'SALE_COMPLETED', transactionId: metadata.transactionId,
            occurredAt, hasCustomer: Boolean(options.customerId), customerRef: options.customerId,
            products: affectedProducts, baseline: baseline.forecast,
            baselineUnavailable: !baseline.forecast.complete, context });
          publishCompletedSaleImpact({ businessContext: context, transactionId: metadata.transactionId, occurredAt,
            saleTotal: metadata.total === null ? null : { value: metadata.total, currency: metadata.currency || 'PEN' },
            before: baseline.sales });
        },
      }),
      isSuccessful: shouldPublish,
      getMetadata: result => {
        const metadata = options.getMetadata(result);
        return { transactionId: metadata.transactionId, occurredAt: metadata.occurredAt };
      },
    }),
    isSuccessful: shouldPublish,
    getMetadata: result => {
      const metadata = options.getMetadata(result);
      return { operationId: metadata.transactionId, occurredAt: metadata.occurredAt };
    },
  });

  if (options.isSuccessful(response) && actionKey) {
    completedActionImpacts.add(actionKey);
    actionBaselines.delete(actionKey);
  }
  return response;
}

