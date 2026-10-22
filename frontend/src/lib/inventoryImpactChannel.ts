import type { InventoryImpactEvent, InventoryImpactSnapshot } from './inventoryImpactSnapshot';
import { mayReplaceImpact } from './operationImpactIdentity';

export const INVENTORY_IMPACT_CHANNEL = 'business-intelligence-inventory-operation-v1';
export const INVENTORY_IMPACT_SESSION_KEY = 'business-intelligence.latest-inventory-impact.v1';

export function publishInventoryImpact(event: InventoryImpactEvent): void {
  if (!mayReplaceImpact({ ...event, transactionId: event.transactionId || event.operationId },
    latestInventoryIdentity())) return;
  saveLatestInventoryImpact(event);
  dispatchLocalInventoryImpact(event);
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(INVENTORY_IMPACT_CHANNEL);
    channel.postMessage(event);
    channel.close();
  } catch { /* Broadcasting is optional; the completed operation must remain successful. */ }
}

export const INVENTORY_IMPACT_LOCAL_EVENT = 'business-intelligence:inventory-operation-impact';
export function dispatchLocalInventoryImpact(event: InventoryImpactEvent): void {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(INVENTORY_IMPACT_LOCAL_EVENT, { detail: event }));
  } catch { /* Same-tab delivery is optional; session storage remains the recovery channel. */ }
}

export function publishInventoryImpactIfCurrent(event: InventoryImpactEvent, expected: InventoryImpactEvent): void {
  const current = readLatestInventoryImpact();
  if (!expected.operationId || current?.operationId !== expected.operationId
    || current.transactionId !== expected.transactionId || current.type !== expected.type
    || current.occurredAt !== expected.occurredAt) return;
  publishInventoryImpact(event);
}

export function saveLatestInventoryImpact(event: InventoryImpactEvent): void {
  if (!mayReplaceImpact({ ...event, transactionId: event.transactionId || event.operationId },
    latestInventoryIdentity())) return;
  try { if (typeof window !== 'undefined') window.sessionStorage.setItem(INVENTORY_IMPACT_SESSION_KEY, JSON.stringify(event)); }
  catch { /* Session storage is an optional recovery channel. */ }
}

function latestInventoryIdentity(): (InventoryImpactEvent & { transactionId: string | null }) | null {
  const event = readLatestInventoryImpact();
  return event ? { ...event, transactionId: event.transactionId || event.operationId } : null;
}

export function isInventoryImpactEvent(value: unknown): value is InventoryImpactEvent {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<InventoryImpactEvent>;
  return row.version === 1 && ['SALE', 'SALE_CANCELLED', 'PURCHASE_CREATED', 'INVENTORY_ADJUSTMENT'].includes(row.type || '')
    && (row.operationId === null || typeof row.operationId === 'string')
    && (row.transactionId === undefined || row.transactionId === null || typeof row.transactionId === 'string')
    && typeof row.occurredAt === 'string' && Number.isFinite(Date.parse(row.occurredAt))
    && (row.reference === null || typeof row.reference === 'string') && row.operationSucceeded === true
    && (row.counterparty === undefined || row.counterparty === null || (typeof row.counterparty === 'object'
      && ['CUSTOMER', 'SUPPLIER'].includes(row.counterparty.role) && (row.counterparty.id === null || typeof row.counterparty.id === 'string')
      && (row.counterparty.name === null || typeof row.counterparty.name === 'string')))
    && Array.isArray(row.products) && row.products.every(item => item && typeof item.sku === 'string'
      && typeof item.name === 'string' && Number.isSafeInteger(item.quantity) && item.quantity > 0)
    && isSnapshot(row.baseline) && ['AVAILABLE', 'PARTIAL', 'BASELINE_UNAVAILABLE'].includes(row.baselineStatus || '')
    && (row.after === null || isSnapshot(row.after)) && (row.afterPending === undefined || typeof row.afterPending === 'boolean') && isContext(row.context)
    && contextEqual(row.context, row.baseline.context)
    && (row.after === null || contextEqual(row.context, row.after.context)) && typeof row.afterUnavailable === 'boolean';
}

export function readLatestInventoryImpact(): InventoryImpactEvent | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(INVENTORY_IMPACT_SESSION_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (isInventoryImpactEvent(value)) return value;
    window.sessionStorage.removeItem(INVENTORY_IMPACT_SESSION_KEY);
  } catch {
    try { window.sessionStorage.removeItem(INVENTORY_IMPACT_SESSION_KEY); } catch { /* Ignore unavailable storage. */ }
  }
  return null;
}

export function clearLatestInventoryImpact(): void {
  try { window.sessionStorage.removeItem(INVENTORY_IMPACT_SESSION_KEY); } catch { /* Optional storage. */ }
}

export function sameContext(a: InventoryImpactSnapshot['context'], b: InventoryImpactSnapshot['context']): boolean {
  return Boolean(a.businessId && a.scenarioId && a.datasetVersion && b.businessId && b.scenarioId && b.datasetVersion)
    && a.businessId === b.businessId && a.scenarioId === b.scenarioId && a.datasetVersion === b.datasetVersion;
}

function contextEqual(a: InventoryImpactSnapshot['context'], b: InventoryImpactSnapshot['context']): boolean {
  return a.businessId === b.businessId && a.scenarioId === b.scenarioId && a.datasetVersion === b.datasetVersion;
}

function isContext(value: unknown): value is InventoryImpactSnapshot['context'] {
  if (!value || typeof value !== 'object') return false;
  const context = value as InventoryImpactSnapshot['context'];
  return [context.businessId, context.scenarioId, context.datasetVersion].every(item => item === null || typeof item === 'string');
}

function isSnapshot(value: unknown): value is InventoryImpactSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<InventoryImpactSnapshot>;
  return isContext(snapshot.context) && typeof snapshot.complete === 'boolean'
    && typeof snapshot.capturedAt === 'string' && Number.isFinite(Date.parse(snapshot.capturedAt))
    && Boolean(snapshot.products && typeof snapshot.products === 'object')
    && Object.values(snapshot.products || {}).every(item => item && typeof item.sku === 'string'
      && typeof item.name === 'string' && ['AVAILABLE', 'UNAVAILABLE'].includes(item.captureStatus));
}
