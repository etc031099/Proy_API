from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt


MAX_ITEMS = 60
MAX_DAILY_SALES_ROWS = 366


class StrictSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PredictionContext(StrictSchema):
    businessId: str = Field(min_length=1, max_length=100)
    scenarioId: str = Field(min_length=1, max_length=100)
    anchorStrategy: str = Field(min_length=1, max_length=100)
    anchorOperationalDate: date
    timezone: Literal["UTC"]


class HistoryCoverage(StrictSchema):
    start: date
    end: date
    complete: StrictBool


class DailySale(StrictSchema):
    date: date
    unitsSold: Annotated[StrictInt, Field(ge=0, le=2_147_483_647)]


class PredictionItem(StrictSchema):
    productId: str = Field(min_length=1, max_length=100)
    sku: str = Field(min_length=1, max_length=100)
    stockAtAnchor: Annotated[float | None, Field(default=None, ge=0, allow_inf_nan=False)]
    minStockLevel: Annotated[float | None, Field(default=None, ge=0, allow_inf_nan=False)]
    historyCoverage: HistoryCoverage
    dailySales: list[DailySale] = Field(
        min_length=1, max_length=MAX_DAILY_SALES_ROWS
    )


class PredictionRequest(StrictSchema):
    requestId: str = Field(min_length=1, max_length=128)
    context: PredictionContext
    items: list[PredictionItem] = Field(min_length=1, max_length=MAX_ITEMS)


class PredictionResult(StrictSchema):
    productId: str
    sku: str
    status: str
    predictedDemand7d: float | None = None
    message: str | None = None


class PredictionResponse(StrictSchema):
    requestId: str
    model: str
    modelVersion: str
    featureSetVersion: str
    anchorOperationalDate: date
    anchorSourceDate: date
    results: list[PredictionResult]
