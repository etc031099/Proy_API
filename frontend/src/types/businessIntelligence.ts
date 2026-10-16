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
    slowMovingCount?: number | null; deadStockCount?: number | null;
    abcCounts?: Record<string, number> | null; xyzCounts?: Record<string, number> | null;
    abcXyzCounts?: Record<string, number> | null;
  };
  items: InventoryRankingItem[]; total: number; flag?: string | null;
}
export interface ProductOption { id: string; sku: string; name: string; presentation: string | null; }
export interface ForecastResponse extends IntelligenceFreshness {
  status: Availability | 'READY' | 'INSUFFICIENT_HISTORY' | 'MODEL_NOT_APPROVED' | 'MODEL_UNAVAILABLE' | 'FEATURE_UNAVAILABLE';
  product: { sku: string; name?: string; presentation?: string | null; brand?: string | null; size?: { value: number; unit: string | null } | null };
  method: 'MOVING_AVERAGE_28' | string | null;
  reasonCode?: string | null;
  horizonDays?: 1 | 7 | 14;
  predictionUnits?: number | null;
  targetDefinition?: string | null;
  forecastStartDate?: string | null;
  forecastEndDate?: string | null;
  observationsThrough?: string | null;
  modelFamily?: string | null;
  recipeId?: string | null;
  modelVersion?: number | null;
  trainedAt?: string | null;
  trainedDataVersion?: string | null;
  dataCutoff?: string | null;
  featureVersion?: string | null;
  promotionPolicyVersion?: string | null;
  activeModelStatus?: string | null;
  dataVersion?: string | null;
  snapshotHash?: string | null;
  isTrainingPending?: boolean | null;
  baselineUnits?: number | null;
  baselineMethod?: string | null;
  observationCutoff: string | null;
  horizons: { '1d': number | null; '7d': number | null; '14d': number | null };
  observedSeries: Array<{ date: string; units: number | null; status: SeriesStatus }>;
  forecastPeriod: { startDate: string | null; selectedHorizonDays: number; units: number | null } | null;
}
export interface ForecastActiveModel {
  horizonDays: 1 | 7 | 14;
  status: 'ACTIVE' | 'MODEL_NOT_APPROVED' | 'MODEL_UNAVAILABLE';
  activeModelStatus: 'ACTIVE' | 'NOT_APPROVED' | 'NONE';
  reasonCode?: string | null;
  modelFamily: string | null;
  recipeId: string | null;
  modelVersion?: number | null;
  trainedAt?: string | null;
  trainedDataVersion?: string | null;
  dataCutoff?: string | null;
  featureVersion?: string | null;
  promotionPolicyVersion?: string | null;
  metrics?: { wape: number | null; mae: number | null; bias: number | null };
}
export interface ForecastActiveModels { models: ForecastActiveModel[]; }
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

export type SalesPeriod = 'TODAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS';
export interface AnalyticsMoney { value: number | null; currency: string | null; }
export interface AnalyticsMeta extends Omit<IntelligenceFreshness, 'mode'> {
  mode: IntelligenceMode | 'FROZEN' | null;
  freshness: { mode: IntelligenceMode | 'FROZEN' | null; updatedAt?: string | null; dataThrough?: string | null; cutoff?: string };
  dataVersion: number | null; snapshotHash: string | null; source: string | null; engineVersion: string | null;
}
export interface SalesAnalytics extends AnalyticsMeta {
  period: { startDate: string; endDate: string };
  comparisonPeriod: { startDate: string; endDate: string } | null;
  summary: { revenue: AnalyticsMoney | null; units: number | null; tickets: number | null; averageTicket: AnalyticsMoney | null;
    grossMargin: { value: number | null; currency: string | null; percent: number | null; availability: MarginAvailability } };
  grossMarginAvailability: MarginAvailability; variation: Record<string, unknown> | null; comparisonAvailability: string | null;
  series: Array<{ date: string; revenue: AnalyticsMoney | null; units: number | null; tickets: number | null; status: string }> | null;
  seriesStatus: string;
  rankings: { topProducts: Array<Record<string, unknown>>; topCategories: Array<Record<string, unknown>> };
}
export interface CustomerAnalyticsRow {
  customerId: string | null; displayName: string | null; segment: string | null; recency: number | null; frequency: number | null;
  monetary: AnalyticsMoney | null; spend: AnalyticsMoney | null; lifetimeTicketCount: number | null; rfm90d: Record<string, unknown> | null;
  averageTicket: AnalyticsMoney | null; lastPurchaseDate: string | null; firstPurchaseDate: string | null; reasonCodes: string[];
  preferences: Record<string, unknown> | null; trends: Record<string, unknown> | null; windows: Record<string, unknown> | null;
  freshness: Record<string, unknown> | null;
}
export interface CustomersAnalytics extends AnalyticsMeta {
  summary: { totalRegistered: number | null; active: number | null; new: number | null; inactive: number | null; atRisk: number | null;
    highValue: number | null; potential: number | null; segments: Record<string, number>; consumerFinalIncludedInIndividualRfm: false };
  items: CustomerAnalyticsRow[]; total: number; limit: number; offset: number;
}
export interface CustomerAnalyticsDetail extends AnalyticsMeta { status: string; item: CustomerAnalyticsRow; historyAvailability: string; }
export interface SupplierAnalyticsRow {
  supplierId: string | null; name: string | null; orders: number | null; spend: AnalyticsMoney | null; pending: number | null;
  received: number | null; leadTime: Record<string, unknown> | null; punctuality: Record<string, unknown> | null;
  leadTimeAvailability: string; dependency: Record<string, number | null>; products: Array<Record<string, unknown>>; status: string;
}
export interface SuppliersAnalytics extends AnalyticsMeta {
  period: { startDate: string; endDate: string };
  summary: { totalSuppliers: number | null; totalSpend: AnalyticsMoney | null; pendingOrders: number | null; receivedOrders: number | null;
    dependency: Record<string, unknown> | null; averageLeadTime: { days: number | null; sampleSize: number | null; status: string } };
  items: SupplierAnalyticsRow[]; total: number; limit: number; offset: number;
}
export interface SupplierAnalyticsDetail extends AnalyticsMeta {
  status: string; item: SupplierAnalyticsRow & { costTrends: Array<Record<string, unknown>> | null; historyAvailability: string };
  historyAvailability: string;
}
export interface AssociationRule {
  antecedent: string[]; antecedentProducts: Array<string | Record<string, unknown>>; consequent: string[]; consequentProducts: Array<string | Record<string, unknown>>;
  support: number | null; confidence: number | null; lift: number | null; ticketCount: number | null; stability: string | null; status: string | null;
}
export interface AssociationsAnalytics extends AnalyticsMeta {
  mode: 'FROZEN'; cutoff: string; summary: Record<string, unknown> | null; available: boolean; items: AssociationRule[]; total: number; limit: number; offset: number;
}
export interface RelatedProductAnalytics extends AnalyticsMeta {
  mode: 'FROZEN'; cutoff: string; sourceProduct: { sku: string; name: string; presentation: string | null }; available: boolean;
  items: Array<{ relatedProduct: { sku: string | null; name: string | null }; support: number | null; confidence: number | null;
    lift: number | null; ticketCount: number | null; stability: string | null; classification: string | null }>;
  total: number;
}
export interface BusinessHealthAnalytics extends AnalyticsMeta {
  status: string; period: { startDate: string; endDate: string };
  domains: Record<'sales' | 'margin' | 'customers' | 'inventory' | 'suppliers' | 'forecast' | 'marketBasket',
    { status: string; freshness: Record<string, unknown> | null; metrics: Record<string, unknown> | null; insights: Array<Record<string, unknown>> }>;
  insights: Array<Record<string, unknown>>;
}
export interface AnalyticsEnvelope<T> { success: boolean; data?: T; code?: string; message?: string; }
