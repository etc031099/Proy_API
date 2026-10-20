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
export interface CertifiedForecastReplayEvidence {
  demoRunId: 'cert-stable-2020';
  purpose: 'REPLAY_ONLY';
  profile: 'STABLE';
  seed: 2020;
  requiredOrigins: 107;
  policy: { numericPolicy: 'M6.10A22-PROMOTION-v1'; replayPolicy: 'REPLAY-CAUSAL27-107-v1' };
  level: 'LEVEL_7_FULL_EVALUATION';
  liveImpact: { modifiesLive: false; modifiesRegistry: false; modifiesActive: false; promotesActive: false };
  horizons: Array<{
    horizonDays: 7 | 14;
    status: 'PASS' | 'REJECTED';
    metrics: { wape: number; mae: number; normalizedBias: number; relativeWapeImprovement: number };
    globalChecks: { G1_POOLED_WAPE_5PCT: boolean; G2_POOLED_BIAS_10PCT: boolean; G3_POOLED_MACRO_MAE_110PCT: boolean };
    reasons: string[];
    selectedIdentity?: string;
    selectedState?: 'REPLAY_SELECTED';
    candidateState?: 'REPLAY_REJECTED';
  }>;
  interpretation: { execution: 'HISTORICAL_OFFLINE_REPLAY'; isLiveState: false; requiredOriginsWasWeakened: false; explanations: string[] };
}
export type ReplayFoldKey = 'F2' | 'F3' | 'VALIDATION';
export interface ReplayMetrics {
  rows: number; actual_units: number; mae: number; wape: number | null;
  bias_units: number; normalized_bias: number | null;
}
export interface ReplayOriginMetadata {
  demoRunId: 'cert-stable-2020'; purpose: 'REPLAY_ONLY'; requiredOrigins: 107;
  reference: 'MA28'; horizonDays: 7 | 14; status: 'PASS' | 'REJECTED';
  certificateSha256: string;
  policy: { numericPolicy: string; replayPolicy: string; numericPolicySha256: string };
}
export interface ReplayOriginsPage extends ReplayOriginMetadata {
  totalOrigins: number; total: number; page: number; pageSize: number; totalPages: number;
  folds: Array<{ order: number; key: ReplayFoldKey; startOrigin: string; endOrigin: string; origins: number }>;
  items: Array<{ origin: string; fold: ReplayFoldKey; sampleCount: number; candidateMae: number; baselineMae: number }>;
  globalChecks: Record<string, boolean>; reasons: string[]; allCheckCount: number; passedCheckCount: number;
  focalEvidence: null | { horizonDays: 14; fold: 'F3'; sku: string; ruleKey: string;
    support: { origins: number; uniqueDayUnits: number; sufficient: boolean };
    candidateMae: number; baselineMae: number; ratio: number; threshold: number; operator: '<='; passed: boolean };
}
export interface ReplayOriginDetail extends ReplayOriginMetadata {
  origin: string; fold: ReplayFoldKey; sampleCount: number;
  actualUnits: number; candidateUnits: number; baselineUnits: number;
  candidate: ReplayMetrics; baseline: ReplayMetrics;
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
export interface MlTestCapability {
  allowed: boolean;
  target: 'LOCAL' | null;
  reasonCode: string | null;
}
export interface MlTestControlStatus {
  state: string;
  resetEpoch: string;
  testCycleId: string | null;
  maintenance: boolean;
  cloudRestoreEnabled: boolean;
  capabilities?: { destructiveMlTestControls?: MlTestCapability };
}
export interface MlTestLifecycleStatus extends Omit<MlTestControlStatus, 'capabilities'> {
  checkpointId?: string | null;
  activeCheckpointId?: string | null;
  lastCheckpointId?: string | null;
  checkpoint?: { checkpointId?: string; status?: string; dataVersion?: string | null; createdAt?: string | null; failureCode?: string | null } | null;
  failureCode?: string | null;
}
export interface MlTestLifecycleResult extends MlTestLifecycleStatus {
  status?: string;
  restoreId?: string | null;
  totalDocuments?: number;
  totalBytes?: number;
  totalChunks?: number;
  idempotent?: boolean;
  activityAfterRestore?: MlTestActivityVerification;
}
export interface MlTestActivityOperation {
  transactionId: string;
  revision: string;
  quantity: number;
  occurredAt: string | null;
  kind: 'SALE_COMPLETED' | 'SALE_CANCELLED';
  status: 'completed' | 'cancelled';
}
export interface MlTestProductBaselineForecast {
  status: string; reasonCode: string | null; modelFamily: string | null; activeModelStatus: string | null;
  modelVersion: number | null; trainedDataVersion: string | null; units: number | null;
  horizonDays: 7 | 14; dataVersion: string;
}
export type MlTestProductBaseline = { available: false } | {
  available: true;
  baselineRevision: string;
  capturedRevision: string;
  capturedAt: string | null;
  stock: { onHand: number | null; incoming?: number | null; inventoryPosition?: number | null };
  forecast7: MlTestProductBaselineForecast;
  forecast14: MlTestProductBaselineForecast;
  coverage: { daysCover: number | null; status: string | null; availabilityStatus: string | null; reasonCode: string | null };
  risk: { level: string | null; status: string | null; reasonCodes: string[] };
  recommendation: { reorderNow: boolean | null; recommendedQty: number | null; status: string | null;
    availabilityStatus: string | null; reasonCode: string | null };
};
export interface MlTestActivityProduct {
  sku: string; name: string; saleCount: number; totalQuantity: number;
  cancellationCount: number; cancelledQuantity: number;
  latestActivityAt: string | null; latestActivityRevision: string;
  operationCount: number; operations: MlTestActivityOperation[];
  baseline: MlTestProductBaseline;
}
export interface MlTestActivity {
  checkpointId: string; testCycleId: string | null; resetEpoch: string;
  summary: { baselineRevision: string; currentRevision: string; totalSales: number;
    grossUnits: number; affectedProducts: number; cancellationCount: number };
  products: MlTestActivityProduct[];
  page: { limit: number; nextCursor: string | null; operationsPerProduct: number };
}
export interface MlTestActivityVerification {
  status: 'EMPTY' | 'NOT_EMPTY' | 'UNAVAILABLE';
  checkpointId?: string; resetEpoch?: string; baselineRevision?: string; currentRevision?: string;
  totalSales?: number; grossUnits?: number; affectedProducts?: number; cancellationCount?: number;
}
export interface MlTestScenarioAnalysisResult {
  horizonDays: 7 | 14;
  testCycleId: string;
  resetEpoch: string;
  outcome: string;
  trained: boolean;
  candidateCreated: boolean;
  promoted: boolean;
  reasonCode: string | null;
  requiredOrigins: number;
  availableOrigins: number | null;
  activeModelBefore: { modelVersion: number | null; trainedDataVersion: string | null; dataCutoff: string | null } | null;
  activeModelAfter: { modelVersion: number | null; trainedDataVersion: string | null; dataCutoff: string | null } | null;
  message: string;
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
export type ForecastMlReadinessStatus = 'NO_CHANGES' | 'SIGNALS_PENDING' | 'WAITING_DEBOUNCE'
  | 'WAITING_MATURITY' | 'WAITING_COOLDOWN' | 'READY_FOR_WORKER_REVIEW' | 'WORKER_ACTIVE' | 'UNKNOWN';
export interface ForecastMlReadiness {
  status: ForecastMlReadinessStatus;
  reasonCode: string | null;
  hasPendingSignals: boolean;
  pendingSignalCount: number;
  pendingSignalTypes: Array<'SALE_COMPLETED' | 'SALE_CANCELLED' | 'PRODUCT_UPDATED'>;
  firstPendingSignalAt: string | null;
  lastPendingSignalAt: string | null;
  pendingSince: string | null;
  lastDirtyAt: string | null;
  nextEligibleAt: string | null;
  eligibility: string;
  latestMatureOrigin: string | null;
  lastTrainedMatureOrigin: string | null;
  processedRevision: string | null;
  latestPendingRevision: string | null;
  requiredOrigins: 107;
  availableOriginsActual: number | null;
}
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
  readiness?: ForecastMlReadiness;
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

export type ProductOperationType = 'SALE' | 'SALE_CANCELLED' | 'PURCHASE_CREATED' | 'PURCHASE_RECEIVED' | 'INVENTORY_ADJUSTMENT';
export type ProductOperationFilter = 'ALL' | ProductOperationType;
export interface ProductOperationHistoryItem {
  operationId: string; sourceId: string; type: ProductOperationType; occurredAt: string; quantity: number | null;
  reference: string | null; customer: string | null; supplier: string | null;
  relationQuality: 'DIRECT_ID' | 'DIRECT_REVISION' | 'LIMITED_LEGACY';
  ridgeImpact: { status: 'persisted' | 'not_found' | 'not_applicable'; horizons: Array<{
    horizonDays: 7 | 14; eventType: 'SALE_COMPLETED' | 'SALE_CANCELLED'; dataVersion: string;
    occurredAt: string | null; historicalCorrection: boolean;
  }> };
  inventoryImpact: { status: 'persisted' | 'not_found'; movementType: string | null;
    quantityDelta: number | null; stockBefore: number | null; stockAfter: number | null };
}
export interface ProductOperationHistoryPage {
  product: { sku: string; name: string }; items: ProductOperationHistoryItem[]; limit: number;
  hasMore: boolean; nextCursor: string | null; filters: { type: ProductOperationFilter; from: string | null; to: string | null };
}
export interface ProductOperationDetail {
  operation: ProductOperationHistoryItem;
  facts: { product: { sku: string; name: string }; quantity: number | null; reference: string | null;
    customer: string | null; supplier: string | null; status: string | null; receiptKey: string | null };
  inventoryMovements: Array<{ movementType: string; quantityDelta: number; stockBefore: number; stockAfter: number; occurredAt: string }>;
  ridgeEvidence: ProductOperationHistoryItem['ridgeImpact'];
  traceability: { revision: string | null; eventOrdinal: number | null; eventKey: string | null; effectiveAtUtc: string | null;
    entityType: string | null; entityKey: string | null; operation: string | null; relationQuality: ProductOperationHistoryItem['relationQuality'] };
}

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
