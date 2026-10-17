from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StrictBool, StrictFloat, StrictInt, model_validator


BUSINESS_ID = "MINIMARKET-PASCO-V3"
SCENARIO_ID = "minimarket-pasco-v3"
DATASET_SHA256 = "a90b913b6ee83174165b39eaab1526525b3aacc53cae1abe6c3f5a54a469cac8"
DATASET_VERSION = "minimarket-pasco-v3-seed2026-v1"
REFERENCE_DATE = date(2026, 10, 12)
TIMEZONE = "America/Lima"
MAX_PAGE_SIZE = 20
MAX_OFFSET = 10_000
MAX_ENTITY_BATCH = 80


class StrictSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class FrozenSnapshotSchema(StrictSchema):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, frozen=True)


class V3Context(StrictSchema):
    businessId: str = Field(min_length=1, max_length=100)
    scenarioId: str = Field(min_length=1, max_length=100)
    datasetVersion: str | None = Field(default=None, min_length=1, max_length=100)
    datasetSha256: str | None = Field(default=None, min_length=64, max_length=64)
    timezone: str = Field(default=TIMEZONE, min_length=1, max_length=64)
    asOfDate: date | None = None


class V3Request(StrictSchema):
    requestId: str = Field(min_length=1, max_length=128)
    context: V3Context
    # `mode` is already the operation selector (summary/detail/rank) on every
    # domain request. Keep that public contract intact and add a source selector.
    dataMode: Literal["HISTORICAL", "LIVE"] = "HISTORICAL"
    operationalSnapshot: "V3OperationalSnapshot | None" = None


class SnapshotCounts(FrozenSnapshotSchema):
    catalogChanges: StrictInt = Field(ge=0, le=30_000)
    sales: StrictInt = Field(ge=0, le=4_096)
    purchases: StrictInt = Field(ge=0, le=2_048)
    transactionChanges: StrictInt = Field(ge=0, le=30_000)
    stockStates: StrictInt = Field(ge=0, le=5_000)
    closedSalesDays: StrictInt = Field(ge=0, le=30_000)


class CostCoverage(FrozenSnapshotSchema):
    knownSaleLines: StrictInt = Field(ge=0, le=65_536)
    unknownSaleLines: StrictInt = Field(ge=0, le=65_536)


class SnapshotMetadata(FrozenSnapshotSchema):
    snapshotVersion: Literal["v3-operational-snapshot-v1", "v3-operational-snapshot-v2"]
    contractVersion: Literal["1", "2"]
    businessId: str = Field(min_length=1, max_length=100)
    scenarioId: str = Field(min_length=1, max_length=100)
    historicalDatasetVersion: str = Field(min_length=1, max_length=100)
    historicalDatasetSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    historicalCutoff: date
    deltaStart: date
    timezone: str = Field(min_length=1, max_length=64)
    operationalDate: date
    asOfDate: date
    capturedAtUtc: datetime
    dataThroughUtc: datetime | None
    observationsClosedThrough: date
    dataVersion: str = Field(pattern=r"^(0|[1-9][0-9]*)$", max_length=19)
    completeness: Literal["COMPLETE"]
    counts: SnapshotCounts
    costCoverage: CostCoverage
    availabilityCoverage: Literal["UNKNOWN", "OBSERVED"]
    snapshotHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    payloadBytes: StrictInt = Field(ge=1, le=1_572_864)


class SupplierOfferProjection(FrozenSnapshotSchema):
    supplierKey: str = Field(min_length=1, max_length=160)
    costCents: StrictInt | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    preferred: bool
    active: bool


class ProductProjection(FrozenSnapshotSchema):
    productKey: str = Field(min_length=1, max_length=160)
    sku: str | None = Field(default=None, max_length=100)
    name: str = Field(min_length=1, max_length=240)
    active: bool
    priceCents: StrictInt | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    costPriceCents: StrictInt | None = Field(default=None, ge=0)
    category: str | None = Field(default=None, max_length=120)
    categoryCode: str | None = Field(default=None, max_length=64)
    subcategoryCode: str | None = Field(default=None, max_length=64)
    brand: str | None = Field(default=None, max_length=120)
    presentation: str | None = Field(default=None, max_length=120)
    sizeValue: StrictInt | StrictFloat | None = Field(default=None, ge=0)
    sizeUnit: str | None = Field(default=None, max_length=32)
    containedUnits: StrictInt | None = Field(default=None, ge=1)
    unit: str | None = Field(default=None, max_length=32)
    perishable: bool
    shelfLifeDays: StrictInt | None = Field(default=None, ge=1)
    minStock: StrictInt = Field(ge=0)
    safetyStock: StrictInt | None = Field(default=None, ge=0)
    reorderPoint: StrictInt | None = Field(default=None, ge=0)
    demandProfileKey: str | None = Field(default=None, max_length=80)
    supplierOffers: tuple[SupplierOfferProjection, ...] = Field(max_length=100)


class ContactProjection(FrozenSnapshotSchema):
    entityKey: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=240)
    type: Literal["customer", "vendor"]
    active: bool
    createdAtUtc: datetime | None = None


class CatalogProjection(FrozenSnapshotSchema):
    entityType: Literal["product", "contact"]
    before: ProductProjection | ContactProjection | None
    after: ProductProjection | ContactProjection

    @model_validator(mode="after")
    def projection_types_match(self):
        expected = ProductProjection if self.entityType == "product" else ContactProjection
        if not isinstance(self.after, expected) or (self.before is not None and not isinstance(self.before, expected)):
            raise ValueError("catalog projection shape does not match entityType")
        return self


class CatalogChange(FrozenSnapshotSchema):
    eventKey: str = Field(min_length=1, max_length=240)
    effectiveAtUtc: datetime
    revision: str = Field(pattern=r"^[1-9][0-9]*$", max_length=19)
    entityType: Literal["product", "customer", "supplier"]
    entityKey: str = Field(min_length=1, max_length=160)
    operation: Literal["CREATE", "UPDATE", "DEACTIVATE"]
    projection: CatalogProjection


class SaleLine(FrozenSnapshotSchema):
    lineKey: str = Field(min_length=1, max_length=200)
    productKey: str = Field(min_length=1, max_length=160)
    sku: str | None = Field(default=None, max_length=100)
    quantity: StrictInt = Field(gt=0, le=1_000_000)
    unitPriceCents: StrictInt = Field(ge=0, le=1_000_000_000)
    lineTotalCents: StrictInt = Field(ge=0, le=1_000_000_000)
    unitCostAtSaleCents: StrictInt | None = Field(default=None, ge=0, le=1_000_000_000)
    costBasis: Literal["CAPTURED", "UNKNOWN"]
    costKnown: bool
    promo: bool = False


class LiveSale(FrozenSnapshotSchema):
    saleKey: str = Field(min_length=1, max_length=160)
    occurredAtUtc: datetime
    localDate: date
    customerKey: str | None = Field(default=None, max_length=160)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    totalCents: StrictInt = Field(ge=0, le=1_000_000_000)
    initialStatus: Literal["completed", "pending", "cancelled"]
    lines: tuple[SaleLine, ...] = Field(min_length=1, max_length=128)


class PurchaseLine(FrozenSnapshotSchema):
    lineKey: str = Field(min_length=1, max_length=200)
    productKey: str = Field(min_length=1, max_length=160)
    sku: str | None = Field(default=None, max_length=100)
    quantityOrdered: StrictInt = Field(gt=0, le=1_000_000)
    purchaseUnitCostCents: StrictInt = Field(ge=0, le=1_000_000_000)
    lineTotalCents: StrictInt = Field(ge=0, le=1_000_000_000)


class LivePurchase(FrozenSnapshotSchema):
    purchaseKey: str = Field(min_length=1, max_length=160)
    supplierKey: str = Field(min_length=1, max_length=160)
    orderedAtUtc: datetime
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    status: Literal["pending", "completed", "cancelled"]
    receiptEvidence: Literal["IMMEDIATE_PURCHASE", "DATED_RECEIPT", "NONE"]
    promisedAtUtc: datetime | None
    lines: tuple[PurchaseLine, ...] = Field(min_length=1, max_length=128)
    contractVersion: Literal[2] | None = None
    fulfillmentMode: Literal["DEFERRED"] | None = None
    initialStatus: Literal["pending", "completed", "cancelled"] | None = None


class TransactionLineChange(FrozenSnapshotSchema):
    lineKey: str = Field(min_length=1, max_length=200)
    receivedQty: StrictInt | None = Field(default=None, ge=0, le=1_000_000)
    productKey: str | None = Field(default=None, max_length=160)
    sku: str | None = Field(default=None, max_length=100)
    orderedQty: StrictInt | None = Field(default=None, ge=0, le=1_000_000)
    purchaseUnitCostCents: StrictInt | None = Field(default=None, ge=0, le=1_000_000_000)
    costBasis: Literal["OBSERVED_RECEIPT_COST", "ORDER_COST", "HISTORICAL_COST", "UNAVAILABLE"] | None = None
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")


class TransactionChange(FrozenSnapshotSchema):
    eventKey: str = Field(min_length=1, max_length=240)
    effectiveAtUtc: datetime
    revision: str = Field(pattern=r"^[1-9][0-9]*$", max_length=19)
    entityType: Literal["transaction"]
    entityKey: str = Field(min_length=1, max_length=160)
    transactionKey: str = Field(min_length=1, max_length=160)
    transactionOrigin: Literal["HISTORICAL", "LIVE"]
    kind: Literal["CANCEL", "RECEIVE"]
    lineChanges: tuple[TransactionLineChange, ...] = Field(max_length=128)
    receiptKey: str | None = Field(default=None, max_length=200)
    supplierKey: str | None = Field(default=None, max_length=160)


class StockState(FrozenSnapshotSchema):
    productKey: str = Field(min_length=1, max_length=160)
    sku: str | None = Field(default=None, max_length=100)
    onHand: StrictInt = Field(ge=0, le=1_000_000_000)
    stockBasis: Literal["MONGO_LEDGER"]


class ClosedSalesDay(FrozenSnapshotSchema):
    productKey: str = Field(min_length=1, max_length=160)
    localDate: date
    unitsSold: StrictInt = Field(ge=0, le=1_000_000)
    completeness: Literal["COMPLETE"]
    availability: Literal["UNKNOWN", "OBSERVED"]
    availableHours: float | None = Field(default=None, ge=0, le=24)
    onHandUsableAtOrigin: StrictInt | None = Field(default=None, ge=0)


class V3OperationalSnapshot(FrozenSnapshotSchema):
    metadata: SnapshotMetadata
    catalogChanges: tuple[CatalogChange, ...] = Field(max_length=30_000)
    sales: tuple[LiveSale, ...] = Field(max_length=4_096)
    purchases: tuple[LivePurchase, ...] = Field(max_length=2_048)
    transactionChanges: tuple[TransactionChange, ...] = Field(max_length=30_000)
    stockStates: tuple[StockState, ...] = Field(max_length=5_000)
    closedSalesDays: tuple[ClosedSalesDay, ...] = Field(max_length=30_000)


V3Request.model_rebuild()


class PeriodRange(StrictSchema):
    startDate: date
    endDate: date


class PageRequest(StrictSchema):
    limit: StrictInt = Field(default=5, ge=1, le=MAX_PAGE_SIZE)
    offset: StrictInt = Field(default=0, ge=0, le=MAX_OFFSET)


class BusinessRequest(V3Request, PageRequest):
    mode: Literal["summary", "compare", "rank", "anomalies"] = "summary"
    period: PeriodRange | None = None
    entityType: Literal["product", "category"] | None = None
    metric: Literal["units", "revenue", "gross_margin", "tickets"] | None = None
    categoryCode: str | None = Field(default=None, min_length=1, max_length=64)
    subcategoryCode: str | None = Field(default=None, min_length=1, max_length=64)
    productSku: str | None = Field(default=None, min_length=1, max_length=100)

    @model_validator(mode="after")
    def anomaly_scope(self):
        if self.mode == "anomalies" and any((self.entityType, self.metric, self.categoryCode, self.subcategoryCode, self.productSku, self.offset)):
            raise ValueError("Frozen business anomalies do not accept entity filters or offset")
        return self


class InventoryRequest(V3Request, PageRequest):
    mode: Literal["summary", "detail", "rank", "recommendations"] = "summary"
    includeSummary: StrictBool = False
    skus: list[str] = Field(default_factory=list, max_length=MAX_ENTITY_BATCH)
    risk: Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"] | None = None
    abc: Literal["A", "B", "C"] | None = None
    xyz: Literal["X", "Y", "Z"] | None = None
    flag: Literal["low_stock", "overstock", "slow_moving", "dead_stock", "single_source", "should_reorder"] | None = None
    metric: Literal["stockout_risk", "low_stock", "overstock", "slow_moving", "abc_a", "az", "single_source_critical", "reorder"] = "reorder"
    activeRidgeModels: list[RidgeActiveArtifact] = Field(default_factory=list, max_length=2)

    @model_validator(mode="after")
    def live_inventory_ridge_scope(self):
        if self.activeRidgeModels:
            horizons = [item.metadata.horizonDays for item in self.activeRidgeModels]
            if (self.dataMode != "LIVE" or sorted(horizons) != sorted(set(horizons))
                    or any(horizon not in (7, 14) for horizon in horizons)
                    or any(item.metadata.businessId != self.context.businessId
                           or item.metadata.scenarioId != self.context.scenarioId for item in self.activeRidgeModels)):
                raise ValueError("LIVE inventory Ridge artifacts must be unique and tenant/scenario scoped to horizons 7/14")
        return self


class RidgeActiveArtifactMetadata(StrictSchema):
    businessId: str = Field(min_length=1, max_length=160)
    scenarioId: str = Field(min_length=1, max_length=160)
    horizonDays: StrictInt = Field(ge=7, le=14)
    modelFamily: str = Field(min_length=1, max_length=80)
    recipeId: str = Field(min_length=1, max_length=100)
    modelVersion: StrictInt = Field(ge=1)
    status: Literal["ACTIVE"]
    trainedAt: datetime
    trainedDataVersion: str = Field(pattern=r"^(0|[1-9][0-9]*)$", max_length=19)
    dataCutoff: date
    featureVersion: str = Field(min_length=1, max_length=100)
    featureHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    promotionPolicyVersion: str = Field(min_length=1, max_length=100)
    promotionPolicyHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    artifactHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    artifactBytes: StrictInt = Field(ge=1, le=262_144)


class RidgeActiveArtifact(StrictSchema):
    metadata: RidgeActiveArtifactMetadata
    artifactDataBase64: str = Field(min_length=1, max_length=349_528)


class ForecastRequest(V3Request, PageRequest):
    mode: Literal["detail", "compare", "rank", "summary", "evaluation"] = "detail"
    skus: list[str] = Field(default_factory=list, max_length=MAX_ENTITY_BATCH)
    horizonDays: StrictInt = Field(default=7, ge=1, le=365)
    includeObservedSeries: StrictBool = False
    useLiveRidge: StrictBool = False
    activeRidgeModel: RidgeActiveArtifact | None = None

    @model_validator(mode="after")
    def live_ridge_scope(self):
        if self.useLiveRidge:
            if self.dataMode != "LIVE" or self.mode != "detail" or len(self.skus) != 1 or self.horizonDays not in (1, 7, 14):
                raise ValueError("LIVE Ridge requires one SKU and an approved operational detail horizon")
            if self.horizonDays == 1 and self.activeRidgeModel is not None:
                raise ValueError("One-day Ridge is not approved and cannot carry an artifact")
        elif self.activeRidgeModel is not None:
            raise ValueError("A Ridge artifact is only accepted for LIVE Ridge scoring")
        return self


class CrossSellRequest(V3Request, PageRequest):
    mode: Literal["recommend", "rules", "summary"] = "recommend"
    sku: str | None = Field(default=None, min_length=1, max_length=100)
    categoryCode: str | None = Field(default=None, min_length=1, max_length=64)


class ClusteringRfm(StrictSchema):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    recency: float | None = Field(default=None, ge=0)
    frequency: float = Field(ge=0)
    monetary: float = Field(ge=0)


class CustomerRequest(V3Request, PageRequest):
    mode: Literal["detail", "rank", "preferences", "activity", "summary", "clustering"] = "summary"
    customerCode: str | None = Field(default=None, min_length=1, max_length=64)
    segment: Literal["AT_RISK", "INACTIVE", "NEW", "LOYAL", "TOP_HIGH_VALUE", "POTENTIAL",
                     "INSUFFICIENT_HISTORY"] | None = None
    metric: Literal["spend", "tickets", "recency", "gross_margin"] = "spend"
    period: PeriodRange | None = None
    assignmentRfm: ClusteringRfm | None = None
    assignmentAsOfDate: date | None = None

    @model_validator(mode="after")
    def clustering_assignment_scope(self):
        if self.assignmentRfm is not None or self.assignmentAsOfDate is not None:
            if (self.mode != "clustering" or not self.customerCode or self.assignmentRfm is None
                    or self.assignmentAsOfDate is None or self.assignmentAsOfDate < REFERENCE_DATE):
                raise ValueError("Clustering assignment requires resolved customer and dated RFM")
        if self.mode == "clustering" and self.period is not None:
            raise ValueError("Frozen clustering does not accept a sales period")
        return self


class SupplierRequest(V3Request, PageRequest):
    mode: Literal["detail", "rank", "summary", "alternatives", "dependency"] = "summary"
    supplierCode: str | None = Field(default=None, min_length=1, max_length=64)
    productSkus: list[str] = Field(default_factory=list, max_length=5)
    metric: Literal["spend", "orders", "lead_time", "late_share", "dependency", "fastestLeadTime", "punctuality", "delays", "productCoverage", "exclusiveProducts"] = "spend"
    period: PeriodRange | None = None


class HealthRequest(V3Request):
    period: PeriodRange | None = None
    limit: StrictInt = Field(default=5, ge=1, le=5)
    activeRidgeModels: list[RidgeActiveArtifact] = Field(default_factory=list, max_length=2)

    @model_validator(mode="after")
    def live_health_ridge_scope(self):
        if self.activeRidgeModels:
            horizons = [item.metadata.horizonDays for item in self.activeRidgeModels]
            if (self.dataMode != "LIVE" or sorted(horizons) != sorted(set(horizons))
                    or any(horizon not in (7, 14) for horizon in horizons)
                    or any(item.metadata.businessId != self.context.businessId
                           or item.metadata.scenarioId != self.context.scenarioId for item in self.activeRidgeModels)):
                raise ValueError("LIVE Health Ridge artifacts must be unique and tenant/scenario scoped to horizons 7/14")
        return self


InventoryRequest.model_rebuild()
HealthRequest.model_rebuild()


class V3Metadata(StrictSchema):
    scenarioId: str
    asOfDate: date
    timezone: str
    datasetVersion: str
    datasetSha256: str
    contractVersion: str
    source: Literal["CANONICAL_V3_BUNDLE"]
    engineVersion: str | None = None
    versions: dict[str, str | None]
    durationMs: float = Field(ge=0)
    latencyP50Ms: float | None = Field(default=None, ge=0)


class V3LiveMetadata(V3Metadata):
    source: Literal["HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT"]
    dataVersion: str = Field(pattern=r"^(0|[1-9][0-9]*)$", max_length=19)
    snapshotHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    freshness: dict[str, JsonValue]


class V3Response(StrictSchema):
    requestId: str
    status: Literal["OK", "PARTIAL"]
    data: dict[str, JsonValue]
    metadata: V3Metadata | V3LiveMetadata


class V3HealthResponse(StrictSchema):
    serviceAlive: Literal[True]
    v1Ready: bool
    v3IntelligenceReady: bool
    domains: dict[str, bool]
    liveDomains: dict[str, bool]
    domainErrors: dict[str, str]
    loadingMetrics: dict[str, float | int | None]


__all__ = [
    "BUSINESS_ID", "SCENARIO_ID", "DATASET_SHA256", "REFERENCE_DATE", "TIMEZONE",
    "MAX_PAGE_SIZE", "MAX_OFFSET", "MAX_ENTITY_BATCH", "BusinessRequest", "InventoryRequest",
    "ForecastRequest", "CrossSellRequest", "CustomerRequest", "SupplierRequest", "HealthRequest",
    "V3Response", "V3Metadata", "V3LiveMetadata", "V3HealthResponse", "V3OperationalSnapshot",
]
