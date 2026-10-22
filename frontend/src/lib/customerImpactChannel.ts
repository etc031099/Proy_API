import { captureCustomerImpactSnapshot, isCustomerImpactEvent, makeCustomerImpactEvent, sameCustomerImpactContext, type CustomerImpactContext, type CustomerImpactEvent, type CustomerImpactSnapshot } from './customerImpactSnapshot';
import { mayReplaceImpact } from './operationImpactIdentity';

export const CUSTOMER_IMPACT_CHANNEL = 'business-intelligence-customer-sale-impact-v1';
export const CUSTOMER_IMPACT_SESSION_KEY = 'business-intelligence.latest-customer-impact.v1';
export const CUSTOMER_IMPACT_LOCAL_EVENT = 'business-intelligence:customer-sale-impact';
let activeCustomerCapture = 0;

export function publishCustomerImpact(event: CustomerImpactEvent): void {
  const previous = readLatestCustomerImpact();
  if (!mayReplaceImpact({ ...event, operationType: 'SALE' }, previous ? { ...previous, operationType: 'SALE' } : null)) return;
  if (event.transactionId === previous?.transactionId && event.captureStatus !== 'COMPLETE' && previous?.captureStatus === 'COMPLETE'
    && sameCustomerImpactContext(previous.businessContext, event.businessContext)) {
    return;
  }
  saveLatestCustomerImpact(event);
  try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CUSTOMER_IMPACT_LOCAL_EVENT, { detail: event })); } catch { /* Same-tab delivery is optional. */ }
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(CUSTOMER_IMPACT_CHANNEL);
    channel.postMessage(event);
    channel.close();
  } catch { /* Optional cross-tab delivery; session storage remains authoritative. */ }
}

export function saveLatestCustomerImpact(event: CustomerImpactEvent): void {
  const previous = readLatestCustomerImpact();
  if (!mayReplaceImpact({ ...event, operationType: 'SALE' }, previous ? { ...previous, operationType: 'SALE' } : null)) return;
  try { if (typeof window !== 'undefined') window.sessionStorage.setItem(CUSTOMER_IMPACT_SESSION_KEY, JSON.stringify(event)); }
  catch { /* The sale remains successful when temporary storage is unavailable. */ }
}

export function readLatestCustomerImpact(): CustomerImpactEvent | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(CUSTOMER_IMPACT_SESSION_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (isCustomerImpactEvent(value)) return value;
    window.sessionStorage.removeItem(CUSTOMER_IMPACT_SESSION_KEY);
  } catch {
    try { window.sessionStorage.removeItem(CUSTOMER_IMPACT_SESSION_KEY); } catch { /* Optional storage. */ }
  }
  return null;
}

export function clearLatestCustomerImpact(): void {
  try { window.sessionStorage.removeItem(CUSTOMER_IMPACT_SESSION_KEY); } catch { /* Optional storage. */ }
}

export async function registerCustomerSaleImpact<T>(options: {
  customerMongoId: string | null;
  displayName: string;
  beforeSnapshot?: CustomerImpactSnapshot | null;
  getContext: () => CustomerImpactContext;
  submit: () => Promise<T>;
  isSuccessful: (response: T) => boolean;
  getMetadata: (response: T) => { transactionId: string | null; occurredAt?: string | null };
}): Promise<T> {
  const individualCustomerId = options.customerMongoId !== 'CONSUMER_FINAL' ? options.customerMongoId : null;
  const before = options.beforeSnapshot !== undefined ? options.beforeSnapshot
    : individualCustomerId ? await captureCustomerImpactSnapshot(individualCustomerId) : null;
  const response = await options.submit();
  if (options.isSuccessful(response)) {
    const metadata = options.getMetadata(response);
    const capture = ++activeCustomerCapture;
    const context = options.getContext();
    if (!individualCustomerId || !context.businessId || !context.scenarioId || !context.datasetVersion) {
      clearLatestCustomerImpact();
      return response;
    }
    const after = await captureCustomerImpactSnapshot(individualCustomerId);
    if (capture !== activeCustomerCapture) return response;
    publishCustomerImpact(makeCustomerImpactEvent({ businessContext: context, transactionId: metadata.transactionId,
      displayName: options.displayName || 'Cliente', occurredAt: metadata.occurredAt || new Date().toISOString(), before, after }));
  }
  return response;
}
