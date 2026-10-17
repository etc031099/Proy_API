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
  availabilityStatus?: string | null; coverageStatus?: string | null; coverageReasonCode?: string | null;
  riskStatus?: string | null; riskReasonCode?: string | null;
  recommendationStatus?: string | null; recommendationReasonCode?: string | null;
}
export interface InventorySummary extends IntelligenceFreshness {
  availabilityStatus?: Availability | string;
  reasonCode?: string | null;
  fieldAvailability?: Record<string, string> | null;
  unavailableCount?: number | null;
  summary: {
    totalProducts: number | null;
    riskCounts: { critical: number | null; high: number | null; medium: number | null; low: number | null };
    reorderCount: number | null; lowStockCount: number | null; overstockCount: number | null; incomingUnits: number | null;
    slowMovingCount?: number | null; deadStockCount?: number | null;
    abcCounts?: Record<string, number> | null; xyzCounts?: Record<string, number> | null;
    abcXyzCounts?: Record<string, number> | null;
    riskCountsStatus?: string | null; riskUnavailableCount?: number | null;
    recommendationUnavailableCount?: number | null; forecastAvailability?: string | null;
    modelVersion7?: number | null; modelVersion14?: number | null;
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
  registryFound?: boolean;
  activePointerFound?: boolean;
  artifactFound?: boolean;
  artifactStatus?: string | null;
  horizonMatches?: boolean | null;
  recipeMatches?: boolean | null;
  featureHashMatches?: boolean | null;
  artifactHashValid?: boolean | null;
  mlLoadStatus?: 'READY' | 'FAILED' | 'NOT_CHECKED';
  mlLoadReasonCode?: string | null;
  metrics?: { wape: number | null; mae: number | null; bias: number | null };
}
export interface ForecastActiveModels {
  models: ForecastActiveModel[];
  forecastServing?: { businessId: string; scenarioId: string; asOf: string; dataVersion: string | null; observationsClosedThrough: string | null;
    snapshotStatus: 'AVAILABLE' | 'UNAVAILABLE'; snapshotReasonCode: string | null;
    horizons: Record<string, { status: string; reasonCode: string | null; mlLoadStatus?: string; mlLoadReasonCode?: string | null }> };
}
export interface HealthDiagnostic {
  httpStatus: number;
  dependencyStatus: { inventory: string; forecast: string; supplier: string; healthAssembly: string };
  reasonCode: string | null;
  elapsedMs: number;
}
export interface AuthenticatedDiagnosticResult<T> {
  httpStatus: number;
  data?: T;
  code?: string;
}
export type ForecastMlUpdateRequestStatus = 'REQUEST_ACCEPTED' | 'ALREADY_PENDING' | 'RUNNING';
export interface ForecastMlUpdateRequestResult {
  requestStatus: ForecastMlUpdateRequestStatus;
  trigger: 'MANUAL';
  pending: boolean;
  horizons: Array<7 | 14>;
  dispatchStatus: 'DISPATCHED' | 'DEFERRED' | 'RESERVED' | 'NOT_REQUESTED';
  messageCode: string;
}
export type ForecastMlUpdateResult = 'LAST_RESULT_NO_PENDING' | 'LAST_RESULT_INSUFFICIENT_HISTORY'
  | 'LAST_RESULT_REJECTED' | 'LAST_RESULT_PROMOTED' | 'LAST_RESULT_FAILED' | 'NOT_ELIGIBLE_YET' | null;
export type ForecastMlUpdateReason = 'NO_PENDING_WORK' | 'DEBOUNCE_NOT_ELAPSED' | 'NOT_MATURE'
  | 'COOLDOWN_ACTIVE' | 'PREVIOUS_FAILURE_NOT_RETRYABLE' | 'NO_PROMOTION_INSUFFICIENT_HISTORY'
  | 'REJECTED' | 'PROMOTED' | 'FAILED' | null;
export interface ForecastMlUpdateHorizonStatus {
  horizonDays: 7 | 14;
  activeModelVersion: number | null;
  trainedDataVersion: string | number | null;
  pending: boolean;
  currentlyRunning: boolean;
  trigger: 'AUTO' | 'MANUAL';
  lastRequestAt: string | null;
  lastAttemptAt: string | null;
  lastEvaluatedAt: string | null;
  lastResult: ForecastMlUpdateResult;
  lastEvaluationReason: ForecastMlUpdateReason;
  eligibility: string;
  nextEligibleAt: string | null;
  requestStatus: string;
  dispatchStatus: 'RESERVED' | 'DISPATCHED' | 'DEFERRED' | null;
  availableOrigins: number | null;
  requiredOrigins: 107;
}
export interface ForecastMlUpdateStatus {
  dataVersion: string | number;
  closedThrough: string;
  horizons: [ForecastMlUpdateHorizonStatus, ForecastMlUpdateHorizonStatus];
}
export type ForecastMlExecutionStatus = 'REQUESTED' | 'PENDING' | 'RUNNING' | 'DEFERRED' | 'NOT_ELIGIBLE'
  | 'EVALUATED_NO_PROMOTION' | 'PROMOTED' | 'PARTIAL' | 'FAILED' | 'INTERRUPTED' | 'NO_PENDING_WORK' | 'UNKNOWN';
export interface ForecastMlImpactSummary {
  status: 'NOT_APPLICABLE' | 'PENDING' | 'COMPLETE' | 'PARTIAL' | 'NOT_CAPTURED';
  reasonCode: string | null;
  summary: Record<string, number | Record<string, number> | null> | null;
}
export interface ForecastMlExecutionHorizon {
  horizonDays: 7 | 14;
  activeVersionBefore: number | null;
  activeVersionAfter: number | null;
  candidateVersion: number | null;
  resultStatus: ForecastMlExecutionStatus;
  promotionDecision: 'PROMOTED' | 'NOT_PROMOTED' | 'NOT_EVALUATED' | null;
  promotionReason: string | null;
  availableOrigins: number | null;
  requiredOrigins: number | null;
  trainingJobReference: string | null;
}
export interface ForecastMlUpdateExecution {
  executionId: string;
  triggerSource: 'MANUAL' | 'SCHEDULED' | 'CLI' | 'UNKNOWN';
  requestSource: 'MANUAL' | 'SCHEDULED' | 'CLI' | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  status: ForecastMlExecutionStatus;
  reasonCode: string | null;
  dataVersionEvaluated: string | null;
  observationsClosedThrough: string | null;
  availableOrigins: number | null;
  requiredOrigins: number | null;
  pendingBefore: boolean | null;
  pendingAfter: boolean | null;
  horizons: ForecastMlExecutionHorizon[];
  impact: {
    status: ForecastMlImpactSummary['status'];
    reasonCode: string | null;
    prediction: ForecastMlImpactSummary;
    inventory: ForecastMlImpactSummary;
  };
}
export interface ForecastMlUpdateHistoryPage {
  items: ForecastMlUpdateExecution[];
  page: { limit: number; nextCursor: string | null };
}
export interface ForecastMlUpdateExecutionDetail extends ForecastMlUpdateExecution {
  stage: string;
  eligibility: string | null;
  signalTypes: string[];
  attempts: Array<{ runAttempt: number | null; status: ForecastMlExecutionStatus; reasonCode: string | null;
    startedAt: string | null; finishedAt: string | null; horizons: ForecastMlExecutionHorizon[] }>;
  dataVersionBefore: string | null;
  message: string | null;
  impact: ForecastMlUpdateExecution['impact'] & { prediction: ForecastMlImpactSummary & {
    versions: Array<{ horizonDays: 7 | 14; beforeVersion: number | null; afterVersion: number | null }>;
  } };
}
export interface ForecastMlProductImpact {
  sku: string;
  productName: string | null;
  prediction: { p7: { old: number | null; new: number | null; delta: number | null; deltaPct: number | null; direction: string } | null;
    p14: { old: number | null; new: number | null; delta: number | null; deltaPct: number | null; direction: string } | null };
  inventory: { risk?: { before: string | null; after: string | null; changed: boolean | null };
    shouldReorder?: { before: boolean | null; after: boolean | null; changed: boolean | null };
    recommendedQty?: { before: number | null; after: number | null; delta: number | null };
    reorderPoint?: { before: number | null; after: number | null; delta: number | null };
    coverage?: { daysCoverBefore: number | null; daysCoverAfter: number | null; delta: number | null };
    ranking?: { positionBefore: number | null; positionAfter: number | null; delta: number | null; status: string };
    availability?: { before: string; after: string; reasonCodesBefore: string[]; reasonCodesAfter: string[] };
    status?: 'NOT_CAPTURED' };
}
export interface ForecastMlUpdateProductsPage {
  executionId: string;
  items: ForecastMlProductImpact[];
  page: { limit: number; nextCursor: string | null };
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
  fieldAvailability?: Record<string, string> | null;
  coverage: { daysCover: number | null; status: string | null; availabilityStatus?: string | null; reasonCode?: string | null };
  inventoryPolicy: { safetyStock: number | null; reorderPoint: number | null; status?: string | null; reasonCode?: string | null; safetyStockStatus?: string | null; reorderStatus?: string | null };
  recommendation: { reorderNow: boolean | null; preventiveRecommendation: boolean | null; recommendedQty: number | null; status?: string | null; availabilityStatus?: string | null; reasonCode?: string | null };
  risk: { level: RiskLevel | null; reasonCodes: string[]; status?: string | null; availabilityStatus?: string | null; reasonCode?: string | null };
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
