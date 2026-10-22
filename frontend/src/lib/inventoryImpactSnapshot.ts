import { apiClient } from '@/lib/api';
import type { ProductInventory } from '@/types/businessIntelligence';
import { publishInventoryImpact, publishInventoryImpactIfCurrent } from '@/lib/inventoryImpactChannel';

export type InventoryImpactProduct = { sku: string; name: string; quantity: number };
export type InventoryImpactProductSnapshot = {
  sku: string;
  name: string;
  captureStatus: 'AVAILABLE' | 'UNAVAILABLE';
  stock: ProductInventory['stock'] | null;
  demand: Pick<ProductInventory['demand'], 'expectedDaily' | 'expectedUnitsNext7d' | 'expectedUnitsNext14d'> | null;
  coverage: ProductInventory['coverage'] | null;
  inventoryPolicy: Pick<ProductInventory['inventoryPolicy'], 'safetyStock' | 'reorderPoint'> | null;
  recommendation: Pick<ProductInventory['recommendation'], 'reorderNow' | 'recommendedQty'> | null;
  risk: Pick<ProductInventory['risk'], 'level' | 'lowStock'> | null;
  classification: ProductInventory['classification'] | null;
};
export type InventoryImpactSnapshot = {
  context: { businessId: string | null; scenarioId: string | null; datasetVersion: string | null };
  complete: boolean;
  capturedAt: string;
  products: Record<string, InventoryImpactProductSnapshot>;
};

export function uniqueInventoryImpactProducts(products: InventoryImpactProduct[]): InventoryImpactProduct[] {
  const bySku = new Map<string, InventoryImpactProduct>();
  for (const product of products) {
    if (!product.sku) continue;
    const current = bySku.get(product.sku);
    if (current) current.quantity += product.quantity;
    else bySku.set(product.sku, { ...product });
  }
  return [...bySku.values()];
}

export function confirmedPurchaseImpactProducts(
  resultItems: InventoryImpactProduct[] | undefined,
  actionItems: InventoryImpactProduct[] | undefined,
): InventoryImpactProduct[] {
  const source = resultItems?.length ? resultItems : actionItems || [];
  return uniqueInventoryImpactProducts(source.filter(item => typeof item.sku === 'string' && item.sku.trim().length > 0
    && typeof item.name === 'string' && item.name.trim().length > 0
    && Number.isSafeInteger(item.quantity) && item.quantity > 0));
}

export async function readInventoryImpactSnapshot(
  products: Array<Pick<InventoryImpactProduct, 'sku' | 'name'>>,
  options: { invalidateCache?: boolean } = {},
): Promise<InventoryImpactSnapshot> {
  const uniqueProducts = [...new Map(products.filter(product => product.sku).map(product => [product.sku, product])).values()];
  if (options.invalidateCache !== false) apiClient.invalidateIntelligenceReads();
  const [revisionResult, ...inventoryResults] = await Promise.all([
    apiClient.getIntelligenceRevision().catch(() => null),
    ...uniqueProducts.map(product => apiClient.getBusinessIntelligenceProductInventory(product.sku).catch(() => null)),
  ]);
  const revision = revisionResult?.success ? revisionResult.data : null;
  let complete = Boolean(revision);
  const snapshots: InventoryImpactSnapshot['products'] = {};
  uniqueProducts.forEach((product, index) => {
    const response = inventoryResults[index];
    const candidate = response?.success ? response.data : null;
    const row = candidate?.product.sku === product.sku ? candidate : null;
    if (!row) complete = false;
    snapshots[product.sku] = row ? {
      sku: row.product.sku,
      name: row.product.name || product.name || row.product.sku,
      captureStatus: 'AVAILABLE',
      stock: row.stock,
      demand: { expectedDaily: row.demand.expectedDaily, expectedUnitsNext7d: row.demand.expectedUnitsNext7d,
        expectedUnitsNext14d: row.demand.expectedUnitsNext14d },
      coverage: row.coverage,
      inventoryPolicy: { safetyStock: row.inventoryPolicy.safetyStock, reorderPoint: row.inventoryPolicy.reorderPoint },
      recommendation: { reorderNow: row.recommendation.reorderNow, recommendedQty: row.recommendation.recommendedQty },
      risk: { level: row.risk.level, lowStock: row.risk.lowStock ?? null },
      classification: row.classification,
    } : { sku: product.sku, name: product.name || product.sku, captureStatus: 'UNAVAILABLE', stock: null,
      demand: null, coverage: null, inventoryPolicy: null, recommendation: null, risk: null, classification: null };
  });
  return { context: { businessId: revision?.businessId || null, scenarioId: revision?.scenarioId || null,
      datasetVersion: revision?.datasetVersion || null }, complete: complete && Object.values(snapshots).every(row => row.captureStatus === 'AVAILABLE'),
    capturedAt: new Date().toISOString(), products: snapshots };
}

export async function readInventoryImpactContext(): Promise<InventoryImpactSnapshot['context'] | null> {
  try {
    const response = await apiClient.getIntelligenceRevision();
    if (!response.success || !response.data) return null;
    return { businessId: response.data.businessId || null, scenarioId: response.data.scenarioId || null,
      datasetVersion: response.data.datasetVersion || null };
  } catch { return null; }
}

export type InventoryImpactType = 'SALE' | 'SALE_CANCELLED' | 'PURCHASE_CREATED' | 'INVENTORY_ADJUSTMENT';
export type InventoryImpactEvent = {
  version: 1;
  type: InventoryImpactType;
  operationId: string | null;
  /** For transaction-backed operations this is the exact transaction id. */
  transactionId?: string | null;
  occurredAt: string;
  reference: string | null;
  counterparty?: { role: 'CUSTOMER' | 'SUPPLIER'; id: string | null; name: string | null } | null;
  operationSucceeded: true;
  products: InventoryImpactProduct[];
  baseline: InventoryImpactSnapshot;
  baselineStatus: 'AVAILABLE' | 'PARTIAL' | 'BASELINE_UNAVAILABLE';
  after: InventoryImpactSnapshot | null;
  afterPending?: boolean;
  afterUnavailable: boolean;
  context: InventoryImpactSnapshot['context'];
};

export async function recordInventoryOperation<T>(options: {
  type: InventoryImpactType;
  products: InventoryImpactProduct[];
  beforeSnapshot?: InventoryImpactSnapshot;
  submit: () => Promise<T>;
  isSuccessful: (response: T) => boolean;
  getMetadata: (response: T) => { operationId: string | null; occurredAt?: string | null; reference?: string | null;
    counterparty?: InventoryImpactEvent['counterparty'] };
  onSuccess?: (response: T, products: InventoryImpactProduct[]) => void;
}): Promise<T> {
  const products = uniqueInventoryImpactProducts(options.products);
  if (options.type !== 'PURCHASE_CREATED') return recordNonPurchaseInventoryOperation(options, products);
  const response = await options.submit();
  if (options.isSuccessful(response) && products.length > 0) {
    try {
      try { options.onSuccess?.(response, products); } catch { /* Optional impact hooks cannot change a successful write. */ }
      const metadata = options.getMetadata(response);
      publishConfirmedInventoryOperation({ type: options.type, operationId: metadata.operationId,
        occurredAt: metadata.occurredAt, reference: metadata.reference, counterparty: metadata.counterparty,
        products, beforeSnapshot: options.beforeSnapshot });
    } catch { /* Optional impact metadata must not change the result of a successful operation. */ }
  }
  return response;
}

async function recordNonPurchaseInventoryOperation<T>(options: {
  type: InventoryImpactType; products: InventoryImpactProduct[]; beforeSnapshot?: InventoryImpactSnapshot;
  submit: () => Promise<T>; isSuccessful: (response: T) => boolean;
  getMetadata: (response: T) => { operationId: string | null; occurredAt?: string | null; reference?: string | null;
    counterparty?: InventoryImpactEvent['counterparty'] };
  onSuccess?: (response: T, products: InventoryImpactProduct[]) => void;
}, products: InventoryImpactProduct[]): Promise<T> {
  let baseline: InventoryImpactSnapshot;
  try { baseline = options.beforeSnapshot || await readInventoryImpactSnapshot(products.map(({ sku, name }) => ({ sku, name }))); }
  catch { baseline = unavailableInventoryImpactSnapshot(products); }
  const response = await options.submit();
  if (!options.isSuccessful(response) || !products.length) return response;
  try {
    try { options.onSuccess?.(response, products); } catch { /* Optional impact hook. */ }
    const metadata = options.getMetadata(response);
    if (!metadata.operationId) return response;
    const after = await readInventoryImpactSnapshot(products.map(({ sku, name }) => ({ sku, name })));
    const baselineStatus = baseline.complete ? 'AVAILABLE' : Object.values(baseline.products).every(row => row.captureStatus === 'UNAVAILABLE')
      ? 'BASELINE_UNAVAILABLE' : 'PARTIAL';
    publishInventoryImpact({ version: 1, type: options.type, operationId: metadata.operationId,
      transactionId: metadata.operationId, occurredAt: metadata.occurredAt || new Date().toISOString(), reference: metadata.reference || null,
      counterparty: metadata.counterparty || null, operationSucceeded: true, products, baseline, baselineStatus,
      after, afterPending: false, afterUnavailable: !after.complete, context: baseline.context });
  } catch { /* Analytics cannot change the result of a successful operation. */ }
  return response;
}

const publishedInventoryOperationIds = new Set<string>();
export function publishConfirmedInventoryOperation(input: {
  type: InventoryImpactType;
  operationId: string | null;
  occurredAt?: string | null;
  reference?: string | null;
  counterparty?: InventoryImpactEvent['counterparty'];
  products: InventoryImpactProduct[];
  beforeSnapshot?: InventoryImpactSnapshot;
}, onAfterCaptured?: (after: InventoryImpactSnapshot) => void): boolean {
  const products = uniqueInventoryImpactProducts(input.products);
  const operationId = input.operationId;
  if (!operationId || publishedInventoryOperationIds.has(operationId)) return false;
  if (publishedInventoryOperationIds.size >= 200) publishedInventoryOperationIds.delete(publishedInventoryOperationIds.values().next().value!);
  publishedInventoryOperationIds.add(operationId);
  const baseline = input.beforeSnapshot || unavailableInventoryImpactSnapshot(products);
  const pending: InventoryImpactEvent = { version: 1, type: input.type, operationId, transactionId: operationId,
    occurredAt: input.occurredAt || new Date().toISOString(), reference: input.reference || null,
    counterparty: input.counterparty || null, operationSucceeded: true, products, baseline,
    baselineStatus: baseline.complete ? 'AVAILABLE' : Object.values(baseline.products).every(row => row.captureStatus === 'UNAVAILABLE')
      ? 'BASELINE_UNAVAILABLE' : 'PARTIAL', after: null, afterPending: true, afterUnavailable: false, context: baseline.context };
  if (!products.length) {
    publishInventoryImpact({ ...pending, baselineStatus: 'BASELINE_UNAVAILABLE', afterPending: false, afterUnavailable: true });
    return true;
  }
  publishInventoryOperationImpact(pending, onAfterCaptured);
  return true;
}

export function publishInventoryOperationImpact(event: InventoryImpactEvent,
  onAfterCaptured?: (after: InventoryImpactSnapshot) => void): void {
  publishInventoryImpact(event);
  void completeInventoryOperationImpact(event, onAfterCaptured);
}

async function completeInventoryOperationImpact(pending: InventoryImpactEvent,
  onAfterCaptured?: (after: InventoryImpactSnapshot) => void): Promise<void> {
  try {
    apiClient.invalidateIntelligenceReads();
    const [after, movementResults] = await Promise.all([
      readInventoryImpactSnapshot(pending.products.map(({ sku, name }) => ({ sku, name })), { invalidateCache: false }),
      Promise.all(pending.products.map(product => pending.transactionId && pending.type !== 'INVENTORY_ADJUSTMENT'
        ? apiClient.getProductOperationDetail(product.sku, `${pending.type}:${pending.transactionId}`).catch(() => null)
        : Promise.resolve(null))),
    ]);
    try { onAfterCaptured?.(after); } catch { /* Cross-impact updates are best-effort. */ }
    const baselineProducts = { ...pending.baseline.products };
    const afterProducts = { ...after.products };
    let movementCount = 0;
    pending.products.forEach((product, index) => {
      const response = movementResults[index];
      const movements = response?.data?.inventoryMovements;
      const matched = Array.isArray(movements) ? movements.filter(row => Number.isFinite(row.stockBefore)
        && Number.isFinite(row.stockAfter)) : [];
      if (!matched.length) return;
      const first = matched[0], last = matched[matched.length - 1];
      const afterRow = afterProducts[product.sku];
      if (!afterRow?.stock) return;
      const baselineRow = baselineProducts[product.sku];
      baselineProducts[product.sku] = { ...baselineRow, captureStatus: 'AVAILABLE', stock: {
        ...afterRow.stock, onHand: first.stockBefore, inventoryPosition: first.stockBefore,
      } };
      afterProducts[product.sku] = { ...afterRow, stock: { ...afterRow.stock, onHand: last.stockAfter,
        inventoryPosition: last.stockAfter } };
      movementCount += 1;
    });
    const baseline = { ...pending.baseline, context: after.context, products: baselineProducts };
    const completed: InventoryImpactEvent = { ...pending, baseline,
      baselineStatus: baseline.complete ? 'AVAILABLE' : movementCount ? 'PARTIAL' : 'BASELINE_UNAVAILABLE',
      after: { ...after, products: afterProducts }, afterPending: false, afterUnavailable: !after.complete, context: after.context };
    publishInventoryImpactIfCurrent(completed, pending);
  } catch {
    publishInventoryImpactIfCurrent({ ...pending, afterPending: false, afterUnavailable: true }, pending);
  }
}

function unavailableInventoryImpactSnapshot(products: InventoryImpactProduct[], context: InventoryImpactSnapshot['context'] = {
  businessId: null, scenarioId: null, datasetVersion: null,
}): InventoryImpactSnapshot {
  return { context, complete: false,
    capturedAt: new Date().toISOString(), products: Object.fromEntries(uniqueInventoryImpactProducts(products).map(product => [product.sku,
      { sku: product.sku, name: product.name, captureStatus: 'UNAVAILABLE' as const, stock: null, demand: null,
        coverage: null, inventoryPolicy: null, recommendation: null, risk: null, classification: null }])) };
}
