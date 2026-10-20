import type { ForecastImpactSnapshot } from './forecastImpactSnapshot';

export const FORECAST_IMPACT_CHANNEL = 'business-intelligence-sale-completed-v2';
export const FORECAST_IMPACT_SESSION_KEY = 'business-intelligence.latest-sale-impact.v2';

export interface ForecastImpactSaleMessage {
  version: 2;
  type: 'SALE_COMPLETED';
  transactionId: string | null;
  occurredAt: string;
  hasCustomer: boolean;
  customerRef: string | null;
  products: Array<{ sku: string; name: string; quantity: number }>;
  baseline: ForecastImpactSnapshot | null;
  baselineUnavailable: boolean;
  context: ForecastImpactSnapshot['context'];
}

export function publishForecastImpactSale(message: ForecastImpactSaleMessage): void {
  try { if (typeof window !== 'undefined') window.sessionStorage.setItem(FORECAST_IMPACT_SESSION_KEY, JSON.stringify(message)); } catch { /* Session storage is an optional recovery channel. */ }
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(FORECAST_IMPACT_CHANNEL);
  channel.postMessage(message);
  channel.close();
}

export function isForecastImpactSaleMessage(value: unknown): value is ForecastImpactSaleMessage {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ForecastImpactSaleMessage>;
  const baselineValid = row.baseline === null || isSnapshot(row.baseline);
  if (!baselineValid) return false;
  return row.version === 2 && row.type === 'SALE_COMPLETED'
    && (row.transactionId === null || typeof row.transactionId === 'string')
    && typeof row.occurredAt === 'string'
    && typeof row.hasCustomer === 'boolean'
    && (row.customerRef === null || typeof row.customerRef === 'string')
    && typeof row.baselineUnavailable === 'boolean'
    && row.baselineUnavailable === (row.baseline === null || row.baseline?.complete === false)
    && isContext(row.context)
    && Array.isArray(row.products)
    && row.products.every(item => item && typeof item.sku === 'string'
      && typeof item.name === 'string' && Number.isSafeInteger(item.quantity) && item.quantity > 0)
    && baselineValid;
}

export function readLatestForecastImpactSale(): ForecastImpactSaleMessage | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(FORECAST_IMPACT_SESSION_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (isForecastImpactSaleMessage(value)) return value;
    window.sessionStorage.removeItem(FORECAST_IMPACT_SESSION_KEY);
    return null;
  } catch {
    try { window.sessionStorage.removeItem(FORECAST_IMPACT_SESSION_KEY); } catch { /* Ignore unavailable storage. */ }
    return null;
  }
}

export function clearLatestForecastImpactSale(): void {
  try { window.sessionStorage.removeItem(FORECAST_IMPACT_SESSION_KEY); } catch { /* Ignore unavailable storage. */ }
}

function isContext(value: unknown): value is ForecastImpactSnapshot['context'] {
  if (!value || typeof value !== 'object') return false;
  const context = value as ForecastImpactSnapshot['context'];
  return (context.businessId === null || typeof context.businessId === 'string')
    && (context.scenarioId === null || typeof context.scenarioId === 'string')
    && (context.datasetVersion === null || typeof context.datasetVersion === 'string');
}

function isSnapshot(value: unknown): value is import('./forecastImpactSnapshot').ForecastImpactSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<import('./forecastImpactSnapshot').ForecastImpactSnapshot>;
  return isContext(snapshot.context)
    && typeof snapshot.complete === 'boolean'
    && (snapshot.revision === null || typeof snapshot.revision === 'string')
    && typeof snapshot.capturedAt === 'string'
    && Boolean(snapshot.horizons && snapshot.horizons[7] && snapshot.horizons[14] && snapshot.forecasts)
    && Object.values(snapshot.forecasts || {}).every(item => item && typeof item.sku === 'string'
      && typeof item.name === 'string' && (item.seven === null || typeof item.seven === 'number')
      && (item.fourteen === null || typeof item.fourteen === 'number'));
}
