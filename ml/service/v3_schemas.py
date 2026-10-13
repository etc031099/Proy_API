from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StrictInt


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


class PeriodRange(StrictSchema):
    startDate: date
    endDate: date


class PageRequest(StrictSchema):
    limit: StrictInt = Field(default=5, ge=1, le=MAX_PAGE_SIZE)
    offset: StrictInt = Field(default=0, ge=0, le=MAX_OFFSET)


class BusinessRequest(V3Request, PageRequest):
    mode: Literal["summary", "compare", "rank"] = "summary"
    period: PeriodRange | None = None
    entityType: Literal["product", "category"] | None = None
    metric: Literal["units", "revenue", "gross_margin", "tickets"] | None = None
    categoryCode: str | None = Field(default=None, min_length=1, max_length=64)
    subcategoryCode: str | None = Field(default=None, min_length=1, max_length=64)
    productSku: str | None = Field(default=None, min_length=1, max_length=100)


class InventoryRequest(V3Request, PageRequest):
    mode: Literal["summary", "detail", "rank", "recommendations"] = "summary"
    skus: list[str] = Field(default_factory=list, max_length=MAX_ENTITY_BATCH)
    risk: Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"] | None = None
    abc: Literal["A", "B", "C"] | None = None
    xyz: Literal["X", "Y", "Z"] | None = None
    flag: Literal["low_stock", "overstock", "slow_moving", "dead_stock", "single_source", "should_reorder"] | None = None
    metric: Literal["stockout_risk", "low_stock", "overstock", "slow_moving", "abc_a", "az", "single_source_critical", "reorder"] = "reorder"


class ForecastRequest(V3Request, PageRequest):
    mode: Literal["detail", "compare", "rank", "summary"] = "detail"
    skus: list[str] = Field(default_factory=list, max_length=MAX_ENTITY_BATCH)
    horizonDays: StrictInt = Field(default=7, ge=1, le=365)


class CrossSellRequest(V3Request, PageRequest):
    mode: Literal["recommend", "rules", "summary"] = "recommend"
    sku: str | None = Field(default=None, min_length=1, max_length=100)
    categoryCode: str | None = Field(default=None, min_length=1, max_length=64)


class CustomerRequest(V3Request, PageRequest):
    mode: Literal["detail", "rank", "preferences", "activity", "summary"] = "summary"
    customerCode: str | None = Field(default=None, min_length=1, max_length=64)
    segment: Literal["AT_RISK", "INACTIVE", "NEW", "LOYAL", "TOP_HIGH_VALUE", "POTENTIAL"] | None = None
    metric: Literal["spend", "tickets", "recency", "gross_margin"] = "spend"
    period: PeriodRange | None = None


class SupplierRequest(V3Request, PageRequest):
    mode: Literal["detail", "rank", "summary", "alternatives", "dependency"] = "summary"
    supplierCode: str | None = Field(default=None, min_length=1, max_length=64)
    productSkus: list[str] = Field(default_factory=list, max_length=5)
    metric: Literal["spend", "orders", "lead_time", "late_share", "dependency", "fastestLeadTime", "punctuality", "delays", "productCoverage", "exclusiveProducts"] = "spend"
    period: PeriodRange | None = None


class HealthRequest(V3Request):
    period: PeriodRange | None = None
    limit: StrictInt = Field(default=5, ge=1, le=5)


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


class V3Response(StrictSchema):
    requestId: str
    status: Literal["OK", "PARTIAL"]
    data: dict[str, JsonValue]
    metadata: V3Metadata


class V3HealthResponse(StrictSchema):
    serviceAlive: Literal[True]
    v1Ready: bool
    v3IntelligenceReady: bool
    domains: dict[str, bool]
    domainErrors: dict[str, str]
    loadingMetrics: dict[str, float | int | None]


__all__ = [
    "BUSINESS_ID", "SCENARIO_ID", "DATASET_SHA256", "REFERENCE_DATE", "TIMEZONE",
    "MAX_PAGE_SIZE", "MAX_OFFSET", "MAX_ENTITY_BATCH", "BusinessRequest", "InventoryRequest",
    "ForecastRequest", "CrossSellRequest", "CustomerRequest", "SupplierRequest", "HealthRequest",
    "V3Response", "V3Metadata", "V3HealthResponse",
]
