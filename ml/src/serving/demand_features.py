from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

from ml.src.common import repository_path, sha256_file
from ml.src.inference.demand_v1 import validate_and_order_features
from ml.src.m5 import connect_duckdb


READY = "READY"
INSUFFICIENT_HISTORY = "INSUFFICIENT_HISTORY"
MISSING_LINEAGE = "MISSING_LINEAGE"
MISSING_PRICE_HISTORY = "MISSING_PRICE_HISTORY"
MISSING_CALENDAR = "MISSING_CALENDAR"
INVALID_HISTORY = "INVALID_HISTORY"
INVALID_FEATURES = "INVALID_FEATURES"

EXPECTED_BUSINESS_ID = "ML-CLOUD-DEMO"
EXPECTED_SCENARIO_ID = "m5-ca3-cloud-demo-v1"
EXPECTED_ANCHOR_STRATEGY = "latest_eligible_historical_anchor"
SKU_PREFIX = "M5-"
MINIMUM_HISTORY_ROWS = 57
MAX_UNITS_SOLD = 2_147_483_647

DEFAULT_LINEAGE_MANIFEST = "ml/data/serving/cloud_demo_lineage_manifest.json"
DEFAULT_FEATURE_CONTRACT = "ml/models/demand_forecast_v1_contract.json"


class FeatureBuildError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class FeatureBuildResult:
    status: str
    sku: str
    item_id: str
    anchor_operational_date: date
    anchor_source_date: date
    features: pd.DataFrame


def _parse_date(
    value: Any, field: str, error_code: str, *, allow_datetime: bool = False
) -> date:
    if isinstance(value, datetime):
        if allow_datetime and value.time() == datetime.min.time():
            return value.date()
        raise FeatureBuildError(error_code, f"{field} must be a date without time")
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        raise FeatureBuildError(error_code, f"{field} must be an ISO date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise FeatureBuildError(error_code, f"{field} must be an ISO date") from error
    if value != parsed.isoformat():
        raise FeatureBuildError(error_code, f"{field} must use YYYY-MM-DD")
    return parsed


def _validate_units(value: Any, index: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise FeatureBuildError(
            INVALID_HISTORY, f"dailySales[{index}].unitsSold must be numeric"
        )
    numeric = float(value)
    if not math.isfinite(numeric) or not numeric.is_integer():
        raise FeatureBuildError(
            INVALID_HISTORY, f"dailySales[{index}].unitsSold must be a finite integer"
        )
    integer = int(numeric)
    if integer < 0 or integer > MAX_UNITS_SOLD:
        raise FeatureBuildError(
            INVALID_HISTORY,
            f"dailySales[{index}].unitsSold must be between 0 and {MAX_UNITS_SOLD}",
        )
    return integer


def _read_parquet(path: Path) -> pd.DataFrame:
    connection = connect_duckdb()
    try:
        return connection.execute(
            "SELECT * FROM read_parquet(?)", [str(path)]
        ).fetch_df()
    finally:
        connection.close()


class DemandFeatureBuilder:
    def __init__(
        self,
        lineage_manifest_path: str | Path = DEFAULT_LINEAGE_MANIFEST,
        feature_contract_path: str | Path = DEFAULT_FEATURE_CONTRACT,
    ) -> None:
        self.manifest_path = repository_path(lineage_manifest_path).resolve()
        self.contract_path = repository_path(feature_contract_path).resolve()
        self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self.contract = json.loads(self.contract_path.read_text(encoding="utf-8"))
        self._validate_manifest()

        frames: dict[str, pd.DataFrame] = {}
        for name, record in self.manifest["artifacts"].items():
            path = repository_path(record["path"]).resolve()
            if not path.is_file() or sha256_file(path) != record["sha256"]:
                raise FeatureBuildError(
                    MISSING_LINEAGE, f"Lineage artifact {name} is missing or corrupted"
                )
            frames[name] = _read_parquet(path)

        if len(frames["products"]) != self.manifest["products_count"]:
            raise FeatureBuildError(MISSING_LINEAGE, "Product lineage count is invalid")
        if len(frames["calendar"]) != self.manifest["calendar_rows"]:
            raise FeatureBuildError(MISSING_CALENDAR, "Calendar lineage count is invalid")
        if len(frames["prices"]) != self.manifest["price_rows"]:
            raise FeatureBuildError(MISSING_PRICE_HISTORY, "Price lineage count is invalid")

        self.products = {
            row.item_id: row for row in frames["products"].itertuples(index=False)
        }
        self.calendar = {
            _parse_date(
                row.source_date, "source_date", MISSING_CALENDAR, allow_datetime=True
            ): row
            for row in frames["calendar"].itertuples(index=False)
        }
        self.prices = {
            (
                row.item_id,
                _parse_date(
                    row.source_date,
                    "source_date",
                    MISSING_PRICE_HISTORY,
                    allow_datetime=True,
                ),
            ): row
            for row in frames["prices"].itertuples(index=False)
        }

    def _validate_manifest(self) -> None:
        if self.manifest.get("business_id") != EXPECTED_BUSINESS_ID:
            raise FeatureBuildError(MISSING_LINEAGE, "Unexpected lineage businessId")
        if self.manifest.get("scenario_id") != EXPECTED_SCENARIO_ID:
            raise FeatureBuildError(MISSING_LINEAGE, "Unexpected lineage scenarioId")
        if self.manifest.get("date_offset_days") != 3654:
            raise FeatureBuildError(MISSING_LINEAGE, "Unexpected lineage date offset")
        if self.contract.get("feature_set_version") != "demand-v1":
            raise FeatureBuildError(INVALID_FEATURES, "Unexpected feature contract version")
        if len(self.contract.get("feature_order", [])) != 31:
            raise FeatureBuildError(INVALID_FEATURES, "Feature contract must contain 31 features")

    def _validate_context(
        self,
        anchor_operational_date: Any,
        *,
        business_id: str | None,
        scenario_id: str,
        anchor_strategy: str,
    ) -> tuple[date, date]:
        if business_id is not None and business_id != EXPECTED_BUSINESS_ID:
            raise FeatureBuildError(MISSING_LINEAGE, "businessId is not supported by this lineage")
        if scenario_id != EXPECTED_SCENARIO_ID:
            raise FeatureBuildError(MISSING_LINEAGE, "scenarioId is not supported by this lineage")
        if anchor_strategy != EXPECTED_ANCHOR_STRATEGY:
            raise FeatureBuildError(INVALID_HISTORY, "Unsupported anchor strategy")
        operational = _parse_date(
            anchor_operational_date, "anchorOperationalDate", INVALID_HISTORY
        )
        expected_operational = date.fromisoformat(self.manifest["operational_anchor"])
        if operational != expected_operational:
            raise FeatureBuildError(
                INVALID_HISTORY,
                f"CLOUD-DEMO anchor must be {expected_operational.isoformat()}",
            )
        source = operational - timedelta(days=self.manifest["date_offset_days"])
        if source.isoformat() != self.manifest["source_anchor"]:
            raise FeatureBuildError(MISSING_LINEAGE, "Anchor date mapping is inconsistent")
        return operational, source

    def _validate_history(
        self, daily_sales: Iterable[dict[str, Any]], anchor: date
    ) -> tuple[list[date], np.ndarray]:
        if isinstance(daily_sales, (str, bytes, dict)):
            raise FeatureBuildError(INVALID_HISTORY, "dailySales must be a list of records")
        records = list(daily_sales)
        if len(records) < MINIMUM_HISTORY_ROWS:
            raise FeatureBuildError(
                INSUFFICIENT_HISTORY,
                f"At least {MINIMUM_HISTORY_ROWS} inclusive daily rows are required",
            )
        dates: list[date] = []
        units: list[int] = []
        for index, record in enumerate(records):
            if not isinstance(record, dict) or set(record) != {"date", "unitsSold"}:
                raise FeatureBuildError(
                    INVALID_HISTORY,
                    f"dailySales[{index}] must contain exactly date and unitsSold",
                )
            dates.append(
                _parse_date(record["date"], f"dailySales[{index}].date", INVALID_HISTORY)
            )
            units.append(_validate_units(record["unitsSold"], index))
        if len(set(dates)) != len(dates):
            raise FeatureBuildError(INVALID_HISTORY, "dailySales contains duplicate dates")
        if dates != sorted(dates):
            raise FeatureBuildError(INVALID_HISTORY, "dailySales must be chronologically ordered")
        if dates[-1] != anchor:
            raise FeatureBuildError(INVALID_HISTORY, "dailySales must end exactly at the anchor")
        for previous, current in zip(dates, dates[1:]):
            if current - previous != timedelta(days=1):
                raise FeatureBuildError(INVALID_HISTORY, "dailySales contains a date gap")
        return dates, np.asarray(units, dtype=np.float64)

    def _price_features(self, item_id: str, source_anchor: date) -> dict[str, Any]:
        required_dates = [source_anchor - timedelta(days=offset) for offset in range(28)]
        try:
            rows = [self.prices[(item_id, value)] for value in required_dates]
        except KeyError as error:
            raise FeatureBuildError(
                MISSING_PRICE_HISTORY, "Price lineage does not cover the required 28 days"
            ) from error
        current = float(rows[0].filled_sell_price)
        lag_7 = float(rows[7].filled_sell_price)
        recent = np.asarray(
            [float(row.filled_sell_price) for row in rows], dtype=np.float64
        )
        if (
            not np.isfinite(recent).all()
            or np.any(recent <= 0)
            or not math.isfinite(current)
            or not math.isfinite(lag_7)
            or lag_7 <= 0
        ):
            raise FeatureBuildError(MISSING_PRICE_HISTORY, "Price lineage is invalid")
        change = current / lag_7 - 1.0
        relative = current / float(recent.mean())
        if not math.isfinite(change) or not math.isfinite(relative):
            raise FeatureBuildError(MISSING_PRICE_HISTORY, "Price ratios are not finite")
        return {
            "sell_price": current,
            "price_change_pct_7": change,
            "price_relative_to_recent_mean_28": relative,
            "price_missing_active": int(bool(rows[0].price_missing_active)),
        }

    def build(
        self,
        sku: str,
        anchor_operational_date: str | date,
        daily_sales: Iterable[dict[str, Any]],
        *,
        business_id: str | None = None,
        scenario_id: str = EXPECTED_SCENARIO_ID,
        anchor_strategy: str = EXPECTED_ANCHOR_STRATEGY,
    ) -> FeatureBuildResult:
        operational_anchor, source_anchor = self._validate_context(
            anchor_operational_date,
            business_id=business_id,
            scenario_id=scenario_id,
            anchor_strategy=anchor_strategy,
        )
        if not isinstance(sku, str) or not sku.startswith(SKU_PREFIX) or len(sku) <= len(SKU_PREFIX):
            raise FeatureBuildError(MISSING_LINEAGE, "SKU must use the controlled M5- prefix")
        item_id = sku[len(SKU_PREFIX) :]
        product = self.products.get(item_id)
        if product is None:
            raise FeatureBuildError(MISSING_LINEAGE, "SKU is not present in product lineage")

        _, units = self._validate_history(daily_sales, operational_anchor)
        active_start = _parse_date(
            product.active_start, "active_start", MISSING_LINEAGE, allow_datetime=True
        )
        active_age = (source_anchor - active_start).days
        if active_age < 56:
            raise FeatureBuildError(
                INSUFFICIENT_HISTORY, "Product has less than 56 active-age days"
            )
        calendar = self.calendar.get(source_anchor)
        if calendar is None:
            raise FeatureBuildError(MISSING_CALENDAR, "Anchor is absent from calendar lineage")

        last_positive = np.flatnonzero(units > 0)
        days_since_last_sale = (
            int(len(units) - 1 - last_positive[-1])
            if len(last_positive)
            else active_age + 1
        )
        recent_28 = units[-28:]
        recent_56 = units[-56:]
        features: dict[str, Any] = {
            "cat_id": product.cat_id,
            "dept_id": product.dept_id,
            "active_age_days": active_age,
            "current_units": int(units[-1]),
            "lag_1": int(units[-2]),
            "lag_7": int(units[-8]),
            "lag_14": int(units[-15]),
            "lag_28": int(units[-29]),
            "lag_56": int(units[-57]),
            "rolling_sum_7": int(units[-7:].sum()),
            "rolling_mean_28": float(recent_28.mean()),
            "rolling_std_28": float(recent_28.std(ddof=1)),
            "rolling_mean_56": float(recent_56.mean()),
            "days_since_last_sale": days_since_last_sale,
            "has_prior_sale": int(bool(len(last_positive))),
            "sale_days_last_28": int(np.count_nonzero(recent_28 > 0)),
            "nonzero_rate_56": float(np.count_nonzero(recent_56 > 0) / 56.0),
            "day_of_week": int(calendar.day_of_week),
            "week_of_year": int(calendar.week_of_year),
            "month": int(calendar.month),
            "quarter": int(calendar.quarter),
            "is_weekend": int(bool(calendar.is_weekend)),
            "event_name_1": calendar.event_name_1,
            "event_type_1": calendar.event_type_1,
            "event_name_2": calendar.event_name_2,
            "event_type_2": calendar.event_type_2,
            "snap_CA": int(calendar.snap_CA),
            **self._price_features(item_id, source_anchor),
        }
        try:
            validated = validate_and_order_features(pd.DataFrame([features]), self.contract)
        except (TypeError, ValueError) as error:
            raise FeatureBuildError(INVALID_FEATURES, str(error)) from error
        if list(validated.columns) != self.contract["feature_order"] or validated.shape != (1, 31):
            raise FeatureBuildError(INVALID_FEATURES, "Feature row violates demand-v1 order")
        return FeatureBuildResult(
            status=READY,
            sku=sku,
            item_id=item_id,
            anchor_operational_date=operational_anchor,
            anchor_source_date=source_anchor,
            features=validated,
        )


def build_demand_v1_features(
    sku: str,
    anchor_operational_date: str | date,
    daily_sales: Iterable[dict[str, Any]],
    **context: Any,
) -> FeatureBuildResult:
    return DemandFeatureBuilder().build(
        sku, anchor_operational_date, daily_sales, **context
    )
