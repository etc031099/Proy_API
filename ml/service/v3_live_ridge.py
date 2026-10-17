"""Fail-closed LIVE CAUSAL27 feature construction and safe Ridge scoring.

The module deliberately accepts an exact ACTIVE registry envelope from its
caller. It never reads Mongo, loads executable model formats, trains a model,
or falls back to the separate MA28 serving adapter.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timedelta
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

from ml.service.v3_live_context import LiveV3Context
from ml.src import v3_forecast

SCENARIO_ID = v3_forecast.SCENARIO_ID
TIMEZONE = "America/Lima"
LIMA = ZoneInfo(TIMEZONE)
FEATURE_VERSION = "RIDGE_CAUSAL27_V1"
ARTIFACT_SCHEMA_VERSION = "ridge-causal27-json-v1"
MODEL_FAMILY = "RIDGE_REGRESSION"
RECIPE_ID = "RIDGE-CAUSAL27"
TARGET_DEFINITION = "effective_units_sold_cumulative_t_plus_1_through_t_plus_h"
PROMOTION_POLICY_VERSION = "M6.10A22-PROMOTION-v1"
PROMOTION_POLICY_HASH = "522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3"
HISTORICAL_CUTOFF = v3_forecast.HISTORY_END
MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

CATEGORICAL_FEATURES = (
    "sku", "categoryCode", "subcategoryCode", "brand", "presentation", "unit",
)
NUMERIC_FEATURES = (
    "sizeValue", "containedUnits", "weekdayNext", "weekendNextDays", "monthNext",
    "dayOfMonthNext", "paydayDays", "monthEndDays", "currentUnits", "lag_1",
    "lag_7", "lag_14", "lag_28", "rollingMean_7", "rollingMean_14",
    "rollingMean_28", "rollingStd_7", "rollingStd_28", "zeroSalesStreak",
    "daysSinceLastSale", "neverSoldInObservedWindow",
)
FEATURE_ORDER = CATEGORICAL_FEATURES + NUMERIC_FEATURES
_NUMERIC_RULES = {
    "sizeValue": "as-of product descriptor; no post-T catalog values",
    "containedUnits": "as-of product descriptor; strict integer",
    "weekdayNext": "ISO weekday of T+1 in America/Lima",
    "weekendNextDays": "count of ISO weekdays >= 6 over T+1..T+h",
    "monthNext": "calendar month of T+1 in America/Lima",
    "dayOfMonthNext": "calendar day of T+1 in America/Lima",
    "paydayDays": "count of local dates with day 14..16 over T+1..T+h",
    "monthEndDays": "count of actual local month-end dates over T+1..T+h",
    "currentUnits": "certified unitsSold[T]",
    "lag_1": "certified unitsSold[T-1]",
    "lag_7": "certified unitsSold[T-7]",
    "lag_14": "certified unitsSold[T-14]",
    "lag_28": "certified unitsSold[T-28]",
    "rollingMean_7": "arithmetic mean unitsSold[T-6..T]",
    "rollingMean_14": "arithmetic mean unitsSold[T-13..T]",
    "rollingMean_28": "arithmetic mean unitsSold[T-27..T]",
    "rollingStd_7": "population std ddof=0 unitsSold[T-6..T]",
    "rollingStd_28": "population std ddof=0 unitsSold[T-27..T]",
    "zeroSalesStreak": "consecutive certified zero days ending at T, within 29 days",
    "daysSinceLastSale": "days from last positive sale through T; 29 if none in 29 days",
    "neverSoldInObservedWindow": "integer flag: no positive sale in 29 certified days",
}
_CATEGORICAL_RULES = {
    name: "exact product descriptor effective at T; historical canonical catalog plus catalogChanges effective in America/Lima through T"
    for name in CATEGORICAL_FEATURES
}


class LiveRidgeError(Exception):
    """Safe, machine-readable feature/artifact/scoring failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _feature_spec() -> dict[str, Any]:
    return {
        "featureVersion": FEATURE_VERSION,
        "timezone": TIMEZONE,
        "historicalCutoff": HISTORICAL_CUTOFF.isoformat(),
        "targetDefinition": TARGET_DEFINITION,
        "categoricalFeatures": list(CATEGORICAL_FEATURES),
        "numericFeatures": list(NUMERIC_FEATURES),
        "categoricalRules": _CATEGORICAL_RULES,
        "numericRules": _NUMERIC_RULES,
        "historyDays": 29,
        "missingDayPolicy": "reject; never impute zero",
        "excludedFeatures": [
            "holidayDaysKnown", "holidayCoverageDays", "priceAtOriginCents",
            "meanKnownPriceHorizonCents", "priceChangeKnownHorizonCents",
            "knownPromoDays", "meanKnownDiscountPct", "currentStockAtCutoff",
            "availableAtCutoff", "limitedAvailabilityDays_7", "limitedAvailabilityDays_28",
        ],
    }


def feature_contract_hash() -> str:
    canonical = json.dumps(_feature_spec(), ensure_ascii=False, sort_keys=True,
                           separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


FEATURE_HASH = feature_contract_hash()


def _get(item: Any, name: str, default: Any = None) -> Any:
    if isinstance(item, Mapping):
        return item.get(name, default)
    return getattr(item, name, default)


def _day_value(value: Any) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise LiveRidgeError("FEATURE_UNAVAILABLE", "A certified local-date value is invalid.")


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise LiveRidgeError("FEATURE_UNAVAILABLE", f"A required feature is unavailable: {field}.")
    return float(value)


def _strict_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise LiveRidgeError("FEATURE_UNAVAILABLE", f"A required categorical feature is unavailable: {field}.")
    return value


def _sku(product: Any) -> str | None:
    value = _get(product, "sku")
    return str(value) if isinstance(value, str) and value else None


def _product_as_of(dataset: Any, live: LiveV3Context, requested_sku: str, through: date) -> dict[str, Any]:
    # Start with the canonical historical catalog, keyed by immutable productKey.
    canonical = {str(row.get("productKey") or row.get("sku")): dict(row)
                 for row in dataset.products if isinstance(row, Mapping)}
    by_sku = {_sku(row): key for key, row in canonical.items() if _sku(row)}

    changes = sorted(live.snapshot.catalogChanges,
                     key=lambda row: (_get(row, "effectiveAtUtc"), int(_get(row, "revision", 0)),
                                      str(_get(row, "eventKey", ""))))
    for change in changes:
        if _get(change, "entityType") != "product":
            continue
        effective = _get(change, "effectiveAtUtc")
        if not isinstance(effective, datetime) or effective.tzinfo is None or effective.utcoffset() is None:
            raise LiveRidgeError("FEATURE_UNAVAILABLE", "Catalog change has no valid timezone-aware effective time.")
        if effective.astimezone(LIMA).date() > through:
            continue
        projection = _get(change, "projection")
        before = _get(projection, "before")
        after = _get(projection, "after")
        product_key = str(_get(after, "productKey") or _get(change, "entityKey") or "")
        if not product_key:
            raise LiveRidgeError("FEATURE_UNAVAILABLE", "As-of catalog identity is unavailable.")
        if before is not None and _sku(before):
            by_sku.pop(_sku(before), None)
        prior = canonical.get(product_key, {})
        # Project only model descriptors. Do not let prices, stock, suppliers or
        # other current operational fields leak into this feature contract.
        merged = dict(prior)
        for field in ("productKey", "sku", "categoryCode", "subcategoryCode", "brand",
                      "presentation", "unit", "sizeValue", "containedUnits", "active"):
            value = _get(after, field)
            if value is not None:
                merged[field] = value
        canonical[product_key] = merged
        if _sku(merged):
            by_sku[_sku(merged)] = product_key

    product_key = by_sku.get(requested_sku)
    if product_key is None:
        raise LiveRidgeError("PRODUCT_NOT_FOUND", "The requested SKU is not present in the catalog effective at T.")
    product = canonical[product_key]
    if product.get("active") is False:
        raise LiveRidgeError("FEATURE_UNAVAILABLE", "The requested product is inactive at T.")
    missing = [name for name in FEATURE_ORDER[:len(CATEGORICAL_FEATURES)] if not product.get(name)]
    missing += [name for name in ("sizeValue", "containedUnits") if product.get(name) is None]
    if missing:
        raise LiveRidgeError("FEATURE_UNAVAILABLE", "Required as-of product descriptors are unavailable.")
    return product


def _closed_units(dataset: Any, live: LiveV3Context, product_key: str, sku: str, day: date,
                  through: date) -> int:
    if day <= HISTORICAL_CUTOFF:
        row = dataset.inventory.get(sku, {}).get(day.isoformat())
        if row is None:
            raise LiveRidgeError("INSUFFICIENT_HISTORY", "A required historical product-day is missing.")
        completeness = row.get("completeness", "COMPLETE")
        units = row.get("unitsSold")
    else:
        if day > through:
            raise LiveRidgeError("FEATURE_UNAVAILABLE", "A requested feature day is later than the certified close boundary.")
        row = live.closed_sales_by_product_day.get((product_key, day))
        if row is None:
            raise LiveRidgeError("FEATURE_UNAVAILABLE", "A post-cutoff product-day is not certified in the operational snapshot.")
        completeness = _get(row, "completeness")
        units = _get(row, "unitsSold")
        if completeness != "COMPLETE":
            raise LiveRidgeError("FEATURE_UNAVAILABLE", "A post-cutoff product-day is not completely closed.")
    if completeness == "PARTIAL":
        raise LiveRidgeError("FEATURE_UNAVAILABLE", "A historical product-day is partial.")
    if isinstance(units, bool) or not isinstance(units, int) or units < 0:
        raise LiveRidgeError("FEATURE_UNAVAILABLE", "A certified product-day has invalid unitsSold.")
    return units


def build_live_features(dataset: Any, live: LiveV3Context, *, business_id: str,
                        scenario_id: str, sku: str, horizon_days: int) -> dict[str, Any]:
    """Build the exact ordered CAUSAL27 row at the snapshot's closed boundary T."""
    if scenario_id != SCENARIO_ID or live.snapshot.metadata.scenarioId != scenario_id:
        raise LiveRidgeError("INVALID_SCOPE", "The requested scenario does not match the approved V3 snapshot.")
    if business_id != live.snapshot.metadata.businessId:
        raise LiveRidgeError("INVALID_SCOPE", "The tenant does not match the authenticated snapshot.")
    if horizon_days not in (7, 14):
        raise LiveRidgeError("MODEL_NOT_APPROVED", "Only promoted 7- and 14-day Ridge horizons can be scored.")
    metadata = live.snapshot.metadata
    if not live.context_hash or live.context_hash != metadata.snapshotHash:
        raise LiveRidgeError("FEATURE_UNAVAILABLE", "Snapshot hash does not match the validated live context.")
    if str(live.data_version) != str(metadata.dataVersion):
        raise LiveRidgeError("FEATURE_UNAVAILABLE", "Snapshot revision does not match the live context.")
    through = _day_value(metadata.observationsClosedThrough)
    if through > _day_value(metadata.asOfDate) - timedelta(days=1):
        raise LiveRidgeError("FEATURE_UNAVAILABLE", "The snapshot close boundary exceeds the allowed operational date.")
    if through < HISTORICAL_CUTOFF:
        raise LiveRidgeError("INSUFFICIENT_HISTORY", "The certified live close boundary predates the historical cutoff.")
    product = _product_as_of(dataset, live, sku, through)
    product_key = str(product.get("productKey") or "")
    if not product_key:
        raise LiveRidgeError("FEATURE_UNAVAILABLE", "As-of product key is unavailable.")

    dates = [through - timedelta(days=offset) for offset in range(28, -1, -1)]
    sales = [_closed_units(dataset, live, product_key, sku, day, through) for day in dates]
    horizon_dates = [through + timedelta(days=step) for step in range(1, horizon_days + 1)]
    month_ends = []
    for day in horizon_dates:
        first_next_month = date(day.year + (day.month == 12), day.month % 12 + 1, 1)
        month_ends.append(day.day == (first_next_month - timedelta(days=1)).day)

    values: dict[str, Any] = {
        "sku": sku,
        "categoryCode": _strict_string(product["categoryCode"], "categoryCode"),
        "subcategoryCode": _strict_string(product["subcategoryCode"], "subcategoryCode"),
        "brand": _strict_string(product["brand"], "brand"),
        "presentation": _strict_string(product["presentation"], "presentation"),
        "unit": _strict_string(product["unit"], "unit"),
        "sizeValue": _finite_number(product["sizeValue"], "sizeValue"),
        "containedUnits": _strict_integer(product["containedUnits"], "containedUnits"),
        "weekdayNext": horizon_dates[0].isoweekday(),
        "weekendNextDays": sum(day.isoweekday() >= 6 for day in horizon_dates),
        "monthNext": horizon_dates[0].month,
        "dayOfMonthNext": horizon_dates[0].day,
        "paydayDays": sum(14 <= day.day <= 16 for day in horizon_dates),
        "monthEndDays": sum(month_ends),
        "currentUnits": sales[-1],
        "lag_1": sales[-2],
        "lag_7": sales[-8],
        "lag_14": sales[-15],
        "lag_28": sales[0],
        "rollingMean_7": sum(sales[-7:]) / 7.0,
        "rollingMean_14": sum(sales[-14:]) / 14.0,
        "rollingMean_28": sum(sales[-28:]) / 28.0,
        "rollingStd_7": _population_std(sales[-7:]),
        "rollingStd_28": _population_std(sales[-28:]),
    }
    zero_streak = 0
    for units in reversed(sales):
        if units != 0:
            break
        zero_streak += 1
    positive_positions = [index for index, units in enumerate(sales) if units > 0]
    values["zeroSalesStreak"] = zero_streak
    values["daysSinceLastSale"] = len(sales) - 1 - positive_positions[-1] if positive_positions else 29
    values["neverSoldInObservedWindow"] = int(not positive_positions)
    if tuple(values.keys()) != FEATURE_ORDER:
        raise LiveRidgeError("FEATURE_UNAVAILABLE", "The LIVE feature row does not match the ordered CAUSAL27 contract.")
    for name in NUMERIC_FEATURES:
        number = _finite_number(values[name], name)
        values[name] = number
    return values


def _population_std(values: list[int]) -> float:
    mean = sum(values) / len(values)
    return math.sqrt(sum((value - mean) ** 2 for value in values) / len(values))


def _strict_integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise LiveRidgeError("FEATURE_UNAVAILABLE", f"A required integer feature is unavailable: {field}.")
    return value


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _json_finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_verified_ridge_artifact(envelope: Mapping[str, Any], *, business_id: str,
                                 scenario_id: str, horizon_days: int) -> dict[str, Any]:
    """Verify exact registry metadata, bytes, schema, dimensions and finite parameters."""
    return _load_verified_ridge_artifact(envelope, business_id=business_id,
        scenario_id=scenario_id, horizon_days=horizon_days, allowed_statuses=("ACTIVE",))


def _load_verified_ridge_artifact(envelope: Mapping[str, Any], *, business_id: str,
                                  scenario_id: str, horizon_days: int,
                                  allowed_statuses: tuple[str, ...]) -> dict[str, Any]:
    """Common validation; public serving always supplies ACTIVE only."""
    if not isinstance(envelope, Mapping):
        raise LiveRidgeError("ARTIFACT_INVALID", "The registry response is not a valid artifact envelope.")
    metadata = envelope.get("metadata")
    raw = envelope.get("artifactData")
    if not isinstance(metadata, Mapping) or not isinstance(raw, (bytes, bytearray, memoryview)):
        raise LiveRidgeError("ARTIFACT_INVALID", "The registry artifact envelope is incomplete.")
    raw = bytes(raw)
    if not raw or len(raw) > MAX_ARTIFACT_BYTES:
        raise LiveRidgeError("ARTIFACT_INVALID", "The artifact size is outside the supported bound.")
    expected_metadata = {
        "businessId": business_id, "scenarioId": scenario_id, "horizonDays": horizon_days,
        "modelFamily": MODEL_FAMILY, "recipeId": RECIPE_ID,
        "featureVersion": FEATURE_VERSION, "featureHash": FEATURE_HASH,
        "promotionPolicyVersion": PROMOTION_POLICY_VERSION,
        "promotionPolicyHash": PROMOTION_POLICY_HASH,
    }
    if (horizon_days not in (7, 14) or isinstance(horizon_days, bool)
            or metadata.get("status") not in allowed_statuses
            or any(metadata.get(key) != value for key, value in expected_metadata.items())):
        raise LiveRidgeError("ARTIFACT_INVALID", "The ACTIVE registry metadata does not match tenant, scenario, horizon, or feature contract.")
    if metadata.get("artifactBytes") != len(raw) or metadata.get("artifactHash") != _sha256(raw):
        raise LiveRidgeError("ARTIFACT_INVALID", "The artifact bytes do not match their recorded size and SHA256.")
    try:
        artifact = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_json_keys,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON number")))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise LiveRidgeError("ARTIFACT_INVALID", "The model artifact is not strict UTF-8 JSON.") from error
    expected = {
        "schemaVersion", "businessId", "scenarioId", "horizonDays", "modelFamily", "recipeId",
        "featureVersion", "featureHash", "modelVersion", "categoricalFeatures", "numericFeatures",
        "categories", "scalerMean", "scalerScale", "coefficients", "intercept", "alpha", "solver", "tol",
    }
    if not isinstance(artifact, dict) or set(artifact) != expected:
        raise LiveRidgeError("ARTIFACT_INVALID", "The model artifact fields do not match the safe Ridge schema.")
    artifact_scope = {key: value for key, value in expected_metadata.items()
                      if key not in {"status", "promotionPolicyVersion", "promotionPolicyHash"}}
    for key, value in artifact_scope.items():
        if artifact.get(key) != value:
            raise LiveRidgeError("ARTIFACT_INVALID", "The serialized artifact scope or feature contract is inconsistent.")
    if (artifact.get("schemaVersion") != ARTIFACT_SCHEMA_VERSION
            or artifact.get("modelVersion") != metadata.get("modelVersion")
            or isinstance(metadata.get("modelVersion"), bool)
            or not isinstance(metadata.get("modelVersion"), int) or metadata.get("modelVersion") < 1):
        raise LiveRidgeError("ARTIFACT_INVALID", "The serialized artifact version does not match its registry metadata.")
    if (artifact.get("categoricalFeatures") != list(CATEGORICAL_FEATURES)
            or artifact.get("numericFeatures") != list(NUMERIC_FEATURES)
            or artifact.get("solver") != "lsqr" or artifact.get("alpha") != 10.0
            or artifact.get("tol") != 0.0001):
        raise LiveRidgeError("ARTIFACT_INVALID", "The serialized artifact recipe differs from Ridge CAUSAL27.")
    categories = artifact.get("categories")
    if not isinstance(categories, dict) or set(categories) != set(CATEGORICAL_FEATURES):
        raise LiveRidgeError("ARTIFACT_INVALID", "One-hot category dimensions are invalid.")
    category_count = 0
    for name in CATEGORICAL_FEATURES:
        values = categories[name]
        if (not isinstance(values, list) or not values
                or any(not isinstance(value, str) or not value for value in values)
                or values != sorted(set(values))):
            raise LiveRidgeError("ARTIFACT_INVALID", "One-hot categories must be nonempty, unique, ordered strings.")
        category_count += len(values)
    for field in ("scalerMean", "scalerScale"):
        values = artifact.get(field)
        if not isinstance(values, list) or len(values) != len(NUMERIC_FEATURES) or not all(_json_finite(x) for x in values):
            raise LiveRidgeError("ARTIFACT_INVALID", "Scaler dimensions or numeric values are invalid.")
    if any(float(value) <= 0 for value in artifact["scalerScale"]):
        raise LiveRidgeError("ARTIFACT_INVALID", "Scaler scales must be positive and finite.")
    coefficients = artifact.get("coefficients")
    if (not isinstance(coefficients, list) or len(coefficients) != category_count + len(NUMERIC_FEATURES)
            or not all(_json_finite(value) for value in coefficients)
            or not _json_finite(artifact.get("intercept"))):
        raise LiveRidgeError("ARTIFACT_INVALID", "Ridge coefficient dimensions or values are invalid.")
    return artifact


def score_ridge(features: Mapping[str, Any], artifact: Mapping[str, Any]) -> float:
    """Score one validated CAUSAL27 row with sklearn-compatible OHE/Scaler/Ridge math."""
    if tuple(features.keys()) != FEATURE_ORDER:
        raise LiveRidgeError("FEATURE_UNAVAILABLE", "Feature order does not match the Ridge artifact contract.")
    categories = artifact.get("categories")
    if not isinstance(categories, Mapping) or set(categories) != set(CATEGORICAL_FEATURES):
        raise LiveRidgeError("ARTIFACT_INVALID", "One-hot category dimensions are invalid.")
    category_count = 0
    for name in CATEGORICAL_FEATURES:
        levels = categories.get(name)
        if (not isinstance(levels, list) or not levels
                or any(not isinstance(level, str) or not level for level in levels)
                or levels != sorted(set(levels))):
            raise LiveRidgeError("ARTIFACT_INVALID", "One-hot categories are not valid ordered lists.")
        category_count += len(levels)
    means, scales, coefficients = (artifact.get("scalerMean"), artifact.get("scalerScale"),
                                   artifact.get("coefficients"))
    if (not isinstance(means, list) or len(means) != len(NUMERIC_FEATURES)
            or not isinstance(scales, list) or len(scales) != len(NUMERIC_FEATURES)
            or not isinstance(coefficients, list)
            or len(coefficients) != category_count + len(NUMERIC_FEATURES)
            or not all(_json_finite(value) for value in means + scales + coefficients)
            or any(float(scale) <= 0 for scale in scales)
            or not _json_finite(artifact.get("intercept"))):
        raise LiveRidgeError("ARTIFACT_INVALID", "Ridge parameter dimensions or finite values are invalid.")
    vector: list[float] = []
    for name in CATEGORICAL_FEATURES:
        value = features[name]
        if not isinstance(value, str):
            raise LiveRidgeError("FEATURE_UNAVAILABLE", "A categorical Ridge feature is not a string.")
        levels = categories[name]
        # sklearn OneHotEncoder(handle_unknown='ignore') emits all zeros for unknowns.
        vector.extend(1.0 if value == level else 0.0 for level in levels)
    for index, name in enumerate(NUMERIC_FEATURES):
        value = _finite_number(features[name], name)
        vector.append((value - float(means[index])) / float(scales[index]))
    prediction = float(artifact["intercept"]) + sum(a * b for a, b in zip(vector, coefficients))
    if not math.isfinite(prediction):
        raise LiveRidgeError("ARTIFACT_INVALID", "Ridge scoring produced a nonfinite result.")
    return max(prediction, 0.0)


def _iso_datetime(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return value if isinstance(value, str) else None


def ridge_live_forecast(*, dataset: Any, live: LiveV3Context, business_id: str,
                        scenario_id: str, sku: str, horizon_days: int,
                        registry_loader: Callable[..., Mapping[str, Any] | None]) -> dict[str, Any]:
    """Resolve exact ACTIVE artifact and score; deliberately no fallback path."""
    metadata = live.snapshot.metadata
    through = _day_value(metadata.observationsClosedThrough)
    common = {
        "sku": sku, "scenarioId": scenario_id, "horizonDays": horizon_days,
        "targetDefinition": TARGET_DEFINITION, "forecastStartDate": (through + timedelta(days=1)).isoformat(),
        "forecastEndDate": (through + timedelta(days=max(1, horizon_days))).isoformat(),
        "observationsThrough": through.isoformat(), "featureVersion": FEATURE_VERSION,
        "promotionPolicyVersion": PROMOTION_POLICY_VERSION, "dataVersion": str(live.data_version),
        "snapshotHash": live.context_hash,
    }
    if scenario_id != SCENARIO_ID or business_id != metadata.businessId or scenario_id != metadata.scenarioId:
        return {**common, "status": "MODEL_UNAVAILABLE", "reasonCode": "INVALID_SCOPE",
                "predictionUnits": None, "modelVersion": None, "trainedAt": None,
                "trainedDataVersion": None, "dataCutoff": None, "activeModelStatus": "NONE"}
    # 1d is vetoed before the registry loader can be called.
    if horizon_days == 1:
        return {**common, "status": "MODEL_NOT_APPROVED", "reasonCode": "PROMOTION_POLICY_FAILED",
                "predictionUnits": None, "modelFamily": MODEL_FAMILY, "recipeId": RECIPE_ID,
                "modelVersion": None, "trainedAt": None, "trainedDataVersion": None,
                "dataCutoff": None, "activeModelStatus": "NOT_APPROVED"}
    if horizon_days not in (7, 14):
        return {**common, "status": "MODEL_NOT_APPROVED", "reasonCode": "UNSUPPORTED_HORIZON",
                "predictionUnits": None, "modelVersion": None, "trainedAt": None,
                "trainedDataVersion": None, "dataCutoff": None, "activeModelStatus": "NOT_APPROVED"}
    try:
        envelope = registry_loader(businessId=business_id, scenarioId=scenario_id, horizonDays=horizon_days)
    except Exception:
        return {**common, "status": "MODEL_UNAVAILABLE", "reasonCode": "REGISTRY_UNAVAILABLE",
                "predictionUnits": None, "modelVersion": None, "trainedAt": None,
                "trainedDataVersion": None, "dataCutoff": None, "activeModelStatus": "UNKNOWN"}
    if envelope is None:
        return {**common, "status": "MODEL_UNAVAILABLE", "reasonCode": "ACTIVE_MODEL_NOT_FOUND",
                "predictionUnits": None, "modelVersion": None, "trainedAt": None,
                "trainedDataVersion": None, "dataCutoff": None, "activeModelStatus": "NONE"}
    try:
        artifact = load_verified_ridge_artifact(envelope, business_id=business_id,
                                                scenario_id=scenario_id, horizon_days=horizon_days)
        features = build_live_features(dataset, live, business_id=business_id,
                                       scenario_id=scenario_id, sku=sku, horizon_days=horizon_days)
        prediction = score_ridge(features, artifact)
    except LiveRidgeError as error:
        status = {"INSUFFICIENT_HISTORY": "INSUFFICIENT_HISTORY", "FEATURE_UNAVAILABLE": "FEATURE_UNAVAILABLE",
                  "PRODUCT_NOT_FOUND": "FEATURE_UNAVAILABLE"}.get(error.code, "MODEL_UNAVAILABLE")
        return {**common, "status": status, "reasonCode": error.code,
                "predictionUnits": None, "modelFamily": MODEL_FAMILY, "recipeId": RECIPE_ID,
                "modelVersion": envelope.get("metadata", {}).get("modelVersion"),
                "trainedAt": _iso_datetime(envelope.get("metadata", {}).get("trainedAt")),
                "trainedDataVersion": envelope.get("metadata", {}).get("trainedDataVersion"),
                "dataCutoff": envelope.get("metadata", {}).get("dataCutoff"),
                "activeModelStatus": envelope.get("metadata", {}).get("status", "UNKNOWN")}
    registered = envelope["metadata"]
    return {**common, "status": "READY", "reasonCode": None, "predictionUnits": prediction,
            "modelFamily": MODEL_FAMILY, "recipeId": RECIPE_ID,
            "modelVersion": registered.get("modelVersion"),
            "trainedAt": _iso_datetime(registered.get("trainedAt")),
            "trainedDataVersion": registered.get("trainedDataVersion"),
            "dataCutoff": registered.get("dataCutoff"), "activeModelStatus": "ACTIVE"}


def ridge_cache_key(*, business_id: str, scenario_id: str, sku: str, horizon_days: int,
                    observations_through: date, data_version: str, snapshot_hash: str,
                    active_model_version: int) -> tuple[str, ...]:
    """Document the future-safe cache identity without introducing a cache here."""
    if (not all(isinstance(value, str) and value for value in
                (business_id, scenario_id, sku, data_version, snapshot_hash))
            or horizon_days not in (7, 14) or not isinstance(observations_through, date)
            or not isinstance(active_model_version, int) or isinstance(active_model_version, bool)
            or active_model_version < 1):
        raise LiveRidgeError("INVALID_CACHE_SCOPE", "Cache identity is incomplete or invalid.")
    return (business_id, scenario_id, sku, str(horizon_days), observations_through.isoformat(),
            data_version, snapshot_hash, str(active_model_version))


__all__ = ["LiveRidgeError", "FEATURE_VERSION", "FEATURE_HASH", "FEATURE_ORDER",
           "CATEGORICAL_FEATURES", "NUMERIC_FEATURES", "build_live_features",
           "load_verified_ridge_artifact", "score_ridge", "ridge_live_forecast", "ridge_cache_key"]
