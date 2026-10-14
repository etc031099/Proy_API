export type IntelligenceMode = 'LIVE' | 'HISTORICAL';
export type Availability = 'READY' | 'PARTIAL' | 'UNAVAILABLE' | 'COLD_START' | 'INSUFFICIENT_HISTORY' | 'NOT_AVAILABLE';
export type MarginAvailability = 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE';
export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type SeriesStatus = 'CLOSED' | 'ZERO' | 'MISSING' | 'PARTIAL';

export interface IntelligenceFreshness {
  asOf: string;
  timezone: string;
  mode: IntelligenceMode;
  updatedAt: string | null;
  dataThrough: string | null;
  availability?: Record<string, string>;
}
export interface MoneyValue { value: number | null; currency: string | null; }
export interface BusinessSummary extends IntelligenceFreshness {
  salesToday: MoneyValue | null;
  unitsToday: number | null;
  ticketsToday: number | null;
  averageTicket: MoneyValue | null;
  grossMargin: { value: number | null; currency: string | null; percent: number | null; availability: MarginAvailability };
  inventory: {
    totalProducts: number | null;
    riskCounts: { critical: number | null; high: number | null; medium: number | null; low: number | null };
    reorderCount: number | null;
    lowStockCount: number | null;
    overstockCount: number | null;
    pendingPurchasesCount: number | null;
  };
}
export interface InventoryRankingItem {
  sku: string; productName: string; presentation: string | null; stock: number | null;
  coverageDays: number | null; risk: RiskLevel | null; riskReasonCodes: string[];
  recommendedQty: number | null; reorderNow: boolean | null;
}
export interface InventorySummary extends IntelligenceFreshness {
  summary: {
    totalProducts: number | null;
    riskCounts: { critical: number | null; high: number | null; medium: number | null; low: number | null };
    reorderCount: number | null; lowStockCount: number | null; overstockCount: number | null; incomingUnits: number | null;
  };
  items: InventoryRankingItem[]; total: number;
}
export interface ProductOption { id: string; sku: string; name: string; presentation: string | null; }
export interface ForecastResponse extends IntelligenceFreshness {
  status: Availability | 'READY' | 'INSUFFICIENT_HISTORY';
  product: { sku: string; name?: string; presentation?: string | null; brand?: string | null; size?: { value: number; unit: string | null } | null };
  method: 'MOVING_AVERAGE_28' | string;
  observationCutoff: string | null;
  horizons: { '1d': number | null; '7d': number | null; '14d': number | null };
  observedSeries: Array<{ date: string; units: number | null; status: SeriesStatus }>;
  forecastPeriod: { startDate: string | null; selectedHorizonDays: number; units: number | null } | null;
}
export interface ProductInventory {
  asOf: string;
  timezone: string;
  mode: IntelligenceMode;
  updatedAt: string | null;
  dataThrough: string | null;
  status: Availability | string;
  availability: Availability | string;
  freshness: { mode: IntelligenceMode; updatedAt: string | null; dataThrough: string | null };
  product: ForecastResponse['product'];
  stock: { onHand: number | null; incoming: number | null; inventoryPosition: number | null };
  demand: { expectedDaily: number | null; expectedUnitsNext1d: number | null; expectedUnitsNext7d: number | null; expectedUnitsNext14d: number | null };
  coverage: { daysCover: number | null; status: string | null };
  inventoryPolicy: { safetyStock: number | null; reorderPoint: number | null };
  recommendation: { reorderNow: boolean | null; preventiveRecommendation: boolean | null; recommendedQty: number | null };
  risk: { level: RiskLevel | null; reasonCodes: string[] };
  classification: { abc: string | null; xyz: string | null };
}
export interface IntelligenceApiError { code: string; message: string; }
