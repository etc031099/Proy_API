import { apiClient } from '@/lib/api';
import type { ProductInventory } from '@/types/businessIntelligence';
import { publishInventoryImpact } from '@/lib/inventoryImpactChannel';

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
  occurredAt: string;
  reference: string | null;
  operationSucceeded: true;
  products: InventoryImpactProduct[];
  baseline: InventoryImpactSnapshot;
  baselineStatus: 'AVAILABLE' | 'PARTIAL' | 'BASELINE_UNAVAILABLE';
  after: InventoryImpactSnapshot | null;
  afterUnavailable: boolean;
  context: InventoryImpactSnapshot['context'];
};

export async function recordInventoryOperation<T>(options: {
  type: InventoryImpactType;
  products: InventoryImpactProduct[];
  beforeSnapshot?: InventoryImpactSnapshot;
  submit: () => Promise<T>;
  isSuccessful: (response: T) => boolean;
  getMetadata: (response: T) => { operationId: string | null; occurredAt?: string | null; reference?: string | null };
  onSuccess?: (response: T, products: InventoryImpactProduct[]) => void;
}): Promise<T> {
  const products = uniqueInventoryImpactProducts(options.products);
  let baseline: InventoryImpactSnapshot;
  try { baseline = options.beforeSnapshot || await readInventoryImpactSnapshot(products.map(({ sku, name }) => ({ sku, name }))); }
  catch { baseline = unavailableInventoryImpactSnapshot(products); }
  const response = await options.submit();
  if (options.isSuccessful(response) && products.length > 0) {
    options.onSuccess?.(response, products);
    try {
      const metadata = options.getMetadata(response);
      const baselineStatus = baseline.complete ? 'AVAILABLE' : Object.values(baseline.products).every(row => row.captureStatus === 'UNAVAILABLE')
        ? 'BASELINE_UNAVAILABLE' : 'PARTIAL';
      const details: InventoryImpactEvent = { version: 1, type: options.type, operationId: metadata.operationId,
        occurredAt: metadata.occurredAt || new Date().toISOString(), reference: metadata.reference || null,
        operationSucceeded: true, products, baseline, baselineStatus, after: null, afterUnavailable: false, context: baseline.context };
      try {
        details.after = await readInventoryImpactSnapshot(products.map(({ sku, name }) => ({ sku, name })));
        details.afterUnavailable = !details.after.complete;
      } catch {
        details.after = unavailableInventoryImpactSnapshot(products, baseline.context);
        details.afterUnavailable = true;
      }
      publishInventoryImpact(details);
    } catch { /* Optional impact metadata must not change the result of a successful operation. */ }
  }
  return response;
}

function unavailableInventoryImpactSnapshot(products: InventoryImpactProduct[], context: InventoryImpactSnapshot['context'] = {
  businessId: null, scenarioId: null, datasetVersion: null,
}): InventoryImpactSnapshot {
  return { context, complete: false,
    capturedAt: new Date().toISOString(), products: Object.fromEntries(uniqueInventoryImpactProducts(products).map(product => [product.sku,
      { sku: product.sku, name: product.name, captureStatus: 'UNAVAILABLE' as const, stock: null, demand: null,
        coverage: null, inventoryPolicy: null, recommendation: null, risk: null, classification: null }])) };
}
