"""Leakage-guarded local forecasting benchmark for the synthetic Pasco V3 scenario."""
from __future__ import annotations

import hashlib
import json
import math
import joblib
import subprocess
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder


SCENARIO_ID = "minimarket-pasco-v3"
DATASET_VERSION = "minimarket-pasco-v3-seed2026-v1"
DATASET_SHA256 = "a90b913b6ee83174165b39eaab1526525b3aacc53cae1abe6c3f5a54a469cac8"
DAILY_SHA256 = "72ff7ac7a7e3003223a86910714909e712b3239cd3bf27e4a7c2ea0a8e55eb01"
CONFIG_SHA256 = "13d956e997a1db267d2ed66f5d7624052a7458191b703af9f7f7b3a72eec38f6"
FEATURE_VERSION = "pasco-forecast-features-v1"
MODEL_VERSION = "MINIMARKET-PASCO-V3-FORECAST-v1"
HORIZONS = (1, 7, 14, 28)
PRIMARY_HORIZONS = (1, 7, 14)
HISTORY_START = date(2025, 10, 13)
HISTORY_END = date(2026, 10, 12)
FIRST_ORIGIN = date(2025, 11, 10)
SPLITS = {
    "train": (date(2025, 10, 13), date(2026, 6, 30)),
    "validation": (date(2026, 7, 1), date(2026, 8, 15)),
    "test": (date(2026, 8, 16), date(2026, 10, 12)),
}
FOLDS = (
    ("F1", date(2026, 3, 31), date(2026, 4, 1), date(2026, 4, 30)),
    ("F2", date(2026, 4, 30), date(2026, 5, 1), date(2026, 5, 31)),
    ("F3", date(2026, 5, 31), date(2026, 6, 1), date(2026, 6, 30)),
)
FORBIDDEN_FEATURES = frozenset({
    "unitsDemandedSynthetic", "lostDemandSynthetic", "stockoutFlag",
    "promotionOccurred", "realizedSalePrice", "endingStock_future",
    "receivedAt", "actualLeadDays", "late", "delayDays", "simulation-truth",
})


def read_ndjson(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_validated_dataset(repository_root: Path) -> "V3Dataset":
    generated = repository_root / "data/minimarket-pasco-v3/generated"
    definitions_path = repository_root / "data/minimarket-pasco-v3/products.json"
    manifest_path = generated / "manifest.json"
    daily_path = generated / "product-daily.ndjson"
    if not all(path.is_file() for path in (manifest_path, daily_path, definitions_path)):
        raise FileNotFoundError("Canonical local V3 product-day package is incomplete")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("scenarioId") != SCENARIO_ID or manifest.get("datasetVersion") != DATASET_VERSION:
        raise ValueError("V3 scenario/datasetVersion differs from the approved contract")
    if manifest.get("hashes", {}).get("logicalDatasetSha256") != DATASET_SHA256:
        raise ValueError("V3 logical dataset hash differs from the approved contract")
    manifest_files = manifest.get("hashes", {}).get("files", {})
    actual_files: dict[str, str] = {}
    for name, expected in manifest_files.items():
        path = generated / name
        if not path.is_file():
            raise FileNotFoundError(f"V3 canonical generated file is missing: {name}")
        actual_files[name] = sha256_file(path)
        if actual_files[name] != expected:
            raise ValueError(f"V3 canonical file hash differs for {name}")
    logical_hash = hashlib.sha256(json.dumps(actual_files, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
    if logical_hash != DATASET_SHA256 or manifest.get("configSha256") != CONFIG_SHA256:
        raise ValueError("V3 logical/configuration SHA does not match the approved dataset")
    config_probe = "const g=require('./scripts/lib/minimarket-v3-generator');const d=g.loadDefinitions();const c={scenario:d.scenario,categories:d.categories,products:d.products,suppliers:d.suppliers,offers:d.offers,customers:d.customers,profiles:d.profiles,simulation:d.simulation,promotions:d.promotions,dailyContract:d.dailyContract,stableKeys:d.stableKeys,canonicalization:d.canonicalization};process.stdout.write(g.sha256(Buffer.from(g.canonicalJson(c))))"
    try:
        actual_config = subprocess.check_output(["node", "-e", config_probe], cwd=repository_root, text=True, timeout=30).strip()
    except Exception as error:
        raise RuntimeError("Unable to verify V3 configuration SHA with the repository canonicalizer") from error
    if actual_config != CONFIG_SHA256:
        raise ValueError("V3 canonical source configuration changed from the approved hash")
    consumed_files = {
        "product-daily.ndjson": daily_path,
        "calendar.ndjson": generated / "calendar.ndjson",
        "price-history.ndjson": generated / "price-history.ndjson",
        "promotions.ndjson": generated / "promotions.ndjson",
    }
    for name, path in consumed_files.items():
        expected = manifest.get("hashes", {}).get("files", {}).get(name)
        if not path.is_file() or not expected or sha256_file(path) != expected:
            raise ValueError(f"V3 canonical input hash differs for {name}")
    if manifest.get("hashes", {}).get("files", {}).get("product-daily.ndjson") != DAILY_SHA256:
        raise ValueError("V3 product-day SHA-256 differs from the approved contract")
    rows = read_ndjson(daily_path)
    products_doc = json.loads(definitions_path.read_text(encoding="utf-8"))
    products = products_doc.get("catalog", [])
    if len(rows) != 29_200 or len(products) != 80:
        raise ValueError("V3 requires exactly 29,200 product-days and 80 canonical SKUs")
    grouped: dict[str, list[dict[str, Any]]] = {}
    keys: set[str] = set()
    required = {"dailyRowKey", "sku", "localDate", "unitsSold", "availableHours", "endingStock"}
    for row in rows:
        if not required.issubset(row) or row.get("scenarioId") != SCENARIO_ID:
            raise ValueError("V3 daily row is missing required fields or scenario identity")
        key = row["dailyRowKey"]
        if key in keys:
            raise ValueError("V3 product-day contains duplicate stable keys")
        keys.add(key)
        value = row["unitsSold"]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError("unitsSold must be a nonnegative integer")
        if not math.isfinite(float(row["availableHours"])) or not 0 <= row["availableHours"] <= 15:
            raise ValueError("availableHours must be finite and within the 0..15 scenario range")
        grouped.setdefault(row["sku"], []).append(row)
    sku_set = {product["sku"] for product in products}
    if set(grouped) != sku_set:
        raise ValueError("Product-day SKU set does not match the canonical catalog")
    for sku, series in grouped.items():
        series.sort(key=lambda item: item["localDate"])
        if len(series) != 365:
            raise ValueError(f"SKU {sku} does not have exactly 365 product-days")
        dates = [date.fromisoformat(row["localDate"]) for row in series]
        if dates[0] != HISTORY_START or dates[-1] != HISTORY_END:
            raise ValueError(f"SKU {sku} has unexpected history boundaries")
        if any((current - prior).days != 1 for prior, current in zip(dates, dates[1:])):
            raise ValueError(f"SKU {sku} has a gap in daily history")
    return V3Dataset(repository_root, manifest, products, grouped)


@dataclass
class V3Dataset:
    repository_root: Path
    manifest: dict[str, Any]
    products: list[dict[str, Any]]
    daily_by_sku: dict[str, list[dict[str, Any]]]

    def __post_init__(self) -> None:
        generated = self.repository_root / "data/minimarket-pasco-v3/generated"
        self.product_by_sku = {item["sku"]: item for item in self.products}
        calendar_rows = read_ndjson(generated / "calendar.ndjson")
        if len({item["localDate"] for item in calendar_rows}) != len(calendar_rows):
            raise ValueError("V3 calendar has duplicate local dates")
        if any(item.get("scenarioId") != SCENARIO_ID for item in calendar_rows):
            raise ValueError("V3 calendar contains a different scenario")
        self.calendar = {item["localDate"]: item for item in calendar_rows}
        self.prices: dict[str, list[dict[str, Any]]] = {}
        price_rows = read_ndjson(generated / "price-history.ndjson")
        if any(item.get("scenarioId") != SCENARIO_ID or item.get("sku") not in self.product_by_sku for item in price_rows):
            raise ValueError("V3 price history has invalid scenario/SKU identity")
        for item in price_rows:
            self.prices.setdefault(item["sku"], []).append(item)
        for history in self.prices.values():
            history.sort(key=lambda item: (item["effectiveFrom"], item["announcedAt"]))
        self.promotions = read_ndjson(generated / "promotions.ndjson")
        if any(item.get("scenarioId") != SCENARIO_ID or any(sku not in self.product_by_sku for sku in item.get("skus", [])) for item in self.promotions):
            raise ValueError("V3 promotion has invalid scenario/SKU identity")
        self.inventory: dict[str, dict[str, Any]] = {}
        for sku, series in self.daily_by_sku.items():
            self.inventory[sku] = {row["localDate"]: row for row in series}
        # The daily truth is retained for labels/diagnostics only. This allowlist
        # constructs feature columns and never copies arbitrary source fields.
        self.feature_cache: dict[tuple[str, date, int], dict[str, Any]] = {}

    def feature_row(self, sku: str, origin: date, horizon: int) -> dict[str, Any]:
        if horizon not in HORIZONS:
            raise ValueError("Unsupported horizon")
        if sku not in self.product_by_sku:
            raise KeyError("Unknown V3 SKU")
        if origin < FIRST_ORIGIN or origin > HISTORY_END:
            raise ValueError("Origin lacks a complete causal history")
        cache_key = (sku, origin, horizon)
        if cache_key in self.feature_cache:
            return dict(self.feature_cache[cache_key])
        origin_iso = origin.isoformat()
        history = self.inventory[sku]
        past_dates = [origin - timedelta(days=offset) for offset in range(28, -1, -1)]
        if any(day.isoformat() not in history for day in past_dates):
            raise ValueError("Feature history has a missing date; zero imputation is forbidden")
        sales = [int(history[day.isoformat()]["unitsSold"]) for day in past_dates]
        dates_by_offset = {offset: sales[-1 - offset] for offset in range(29)}
        product = self.product_by_sku[sku]
        future_dates = [origin + timedelta(days=step) for step in range(1, horizon + 1)]
        future_cal = [self.calendar.get(day.isoformat()) for day in future_dates]
        # Calendar fields used here are deterministic/published, not generated
        # arrivals or latent pulses. Dates beyond the frozen calendar carry no
        # claimed holiday knowledge.
        weekdays = [day.isoweekday() for day in future_dates]
        month_end = [day.day == (date(day.year + (day.month == 12), (day.month % 12) + 1, 1) - timedelta(days=1)).day for day in future_dates]
        known_holidays = [bool(record and record.get("holidayCode")) for record in future_cal]
        known_holiday_coverage = [record is not None for record in future_cal]
        holiday_days = sum(known_holidays)
        known_holiday_days = sum(known_holiday_coverage)

        base_price_cents = int(round(float(product["salePriceDemo"]) * 100))
        price_history = self.prices.get(sku, [])
        def known_price(day: date) -> int:
            result = base_price_cents
            for event in price_history:
                if event["announcedAt"] <= origin_iso and event["effectiveFrom"] <= day.isoformat():
                    result = int(event["priceCents"])
            return result

        current_price = known_price(origin)
        planned_prices = [known_price(day) for day in future_dates]
        known_promos: list[tuple[dict[str, Any], date, date]] = []
        for promo in self.promotions:
            if sku not in promo.get("skus", []) or promo["announcedAt"] > origin_iso:
                continue
            start, end = date.fromisoformat(promo["startDate"]), date.fromisoformat(promo["endDate"])
            known_promos.append((promo, start, end))
        promo_discounts = [max((int(p["discountPct"]) for p, start, end in known_promos if start <= day <= end), default=0) for day in future_dates]
        origin_record = history[origin_iso]
        prior_sales = [dates_by_offset[offset] for offset in range(28, -1, -1)]
        zero_streak = 0
        for value in reversed(prior_sales):
            if value != 0:
                break
            zero_streak += 1
        positives = [idx for idx, value in enumerate(prior_sales) if value > 0]
        days_since_sale = len(prior_sales) - 1 - positives[-1] if positives else 29
        sold_7 = [dates_by_offset[offset] for offset in range(6, -1, -1)]
        sold_14 = [dates_by_offset[offset] for offset in range(13, -1, -1)]
        sold_28 = [dates_by_offset[offset] for offset in range(27, -1, -1)]
        avail_7 = [float(history[(origin - timedelta(days=offset)).isoformat()]["availableHours"]) for offset in range(6, -1, -1)]
        avail_28 = [float(history[(origin - timedelta(days=offset)).isoformat()]["availableHours"]) for offset in range(27, -1, -1)]
        row = {
            # Static identity only from canonical definitions, never generated
            # end-of-period products metadata.
            "sku": sku,
            "categoryCode": str(product["categoryCode"]),
            "subcategoryCode": str(product["subcategoryCode"]),
            "brand": str(product["brand"]),
            "presentation": str(product["presentation"]),
            "unit": str(product["unit"]),
            "sizeValue": float(product["sizeValue"]),
            "containedUnits": int(product["containedUnits"]),
            "weekdayNext": weekdays[0],
            "weekendNextDays": sum(day >= 6 for day in weekdays),
            "monthNext": future_dates[0].month,
            "dayOfMonthNext": future_dates[0].day,
            "paydayDays": sum(14 <= day.day <= 16 for day in future_dates),
            "monthEndDays": sum(month_end),
            "holidayDaysKnown": holiday_days,
            "holidayCoverageDays": known_holiday_days,
            "priceAtOriginCents": current_price,
            "meanKnownPriceHorizonCents": float(np.mean(planned_prices)),
            "priceChangeKnownHorizonCents": planned_prices[-1] - current_price,
            "knownPromoDays": sum(value > 0 for value in promo_discounts),
            "meanKnownDiscountPct": float(np.mean(promo_discounts)),
            "currentUnits": dates_by_offset[0],
            "lag_1": dates_by_offset[1],
            "lag_7": dates_by_offset[7],
            "lag_14": dates_by_offset[14],
            "lag_28": dates_by_offset[28],
            "rollingMean_7": float(np.mean(sold_7)),
            "rollingMean_14": float(np.mean(sold_14)),
            "rollingMean_28": float(np.mean(sold_28)),
            "rollingStd_7": float(np.std(sold_7, ddof=0)),
            "rollingStd_28": float(np.std(sold_28, ddof=0)),
            "zeroSalesStreak": zero_streak,
            "daysSinceLastSale": days_since_sale,
            "neverSoldInObservedWindow": int(not positives),
            # Historical observable proxy only. Current state is from the
            # completed origin day's ending stock; no future receipt/status.
            "currentStockAtCutoff": int(origin_record["endingStock"]),
            "availableAtCutoff": int(float(origin_record["availableHours"]) > 0),
            "limitedAvailabilityDays_7": sum(hours < 15 for hours in avail_7),
            "limitedAvailabilityDays_28": sum(hours < 15 for hours in avail_28),
        }
        if FORBIDDEN_FEATURES.intersection(row):
            raise AssertionError("Forbidden post-period/latent field entered V3 feature row")
        self.feature_cache[cache_key] = row
        return dict(row)

    def target(self, sku: str, origin: date, horizon: int) -> int:
        if horizon not in HORIZONS or origin + timedelta(days=horizon) > HISTORY_END:
            raise ValueError("Target horizon is incomplete in the canonical history")
        if sku not in self.inventory:
            raise KeyError("Unknown V3 SKU")
        return sum(int(self.inventory[sku][(origin + timedelta(days=step)).isoformat()]["unitsSold"]) for step in range(1, horizon + 1))

    def censored_label(self, sku: str, origin: date, horizon: int) -> bool:
        # Offline observable severity for the train-only ablation. It never
        # reads stockoutFlag or latent demand.
        return any(float(self.inventory[sku][(origin + timedelta(days=step)).isoformat()]["availableHours"]) <= 7.5 for step in range(1, horizon + 1))


def eligible_origins(start: date, end: date, horizon: int, *, fit: bool = False) -> list[date]:
    if start > end:
        return []
    first = max(FIRST_ORIGIN, start - timedelta(days=1))
    last = end - timedelta(days=horizon)
    if fit and end == SPLITS["train"][1]:
        last = min(last, SPLITS["train"][1] - timedelta(days=horizon))
    if first > last:
        return []
    return [first + timedelta(days=offset) for offset in range((last - first).days + 1)]


def build_examples(dataset: V3Dataset, origins: Iterable[date], horizon: int, *, sku_order: list[str] | None = None) -> tuple[pd.DataFrame, np.ndarray, pd.DataFrame]:
    skus = sku_order or sorted(dataset.product_by_sku)
    features: list[dict[str, Any]] = []
    targets: list[int] = []
    metadata: list[dict[str, Any]] = []
    for origin in origins:
        for sku in skus:
            features.append(dataset.feature_row(sku, origin, horizon))
            targets.append(dataset.target(sku, origin, horizon))
            product = dataset.product_by_sku[sku]
            metadata.append({"sku": sku, "origin": origin.isoformat(), "category": product["categoryCode"], "subcategory": product["subcategoryCode"], "censoredLabel": dataset.censored_label(sku, origin, horizon)})
    return pd.DataFrame(features), np.asarray(targets, dtype=np.float64), pd.DataFrame(metadata)


CAT_FEATURES = ("sku", "categoryCode", "subcategoryCode", "brand", "presentation", "unit")
NUM_FEATURES = (
    "sizeValue", "containedUnits", "weekdayNext", "weekendNextDays", "monthNext", "dayOfMonthNext",
    "paydayDays", "monthEndDays", "holidayDaysKnown", "holidayCoverageDays", "priceAtOriginCents",
    "meanKnownPriceHorizonCents", "priceChangeKnownHorizonCents", "knownPromoDays", "meanKnownDiscountPct", "currentUnits",
    "lag_1", "lag_7", "lag_14", "lag_28", "rollingMean_7", "rollingMean_14", "rollingMean_28",
    "rollingStd_7", "rollingStd_28", "zeroSalesStreak", "daysSinceLastSale", "neverSoldInObservedWindow",
    "currentStockAtCutoff", "availableAtCutoff", "limitedAvailabilityDays_7", "limitedAvailabilityDays_28",
)
FEATURE_ORDER = CAT_FEATURES + NUM_FEATURES
FEATURE_SETS = {
    "E0": CAT_FEATURES + ("sizeValue", "containedUnits", "weekdayNext", "weekendNextDays", "monthNext", "dayOfMonthNext", "paydayDays", "monthEndDays", "holidayDaysKnown", "holidayCoverageDays", "currentUnits", "lag_1", "lag_7", "lag_14", "lag_28", "rollingMean_7", "rollingMean_14", "rollingMean_28", "rollingStd_7", "rollingStd_28", "zeroSalesStreak", "daysSinceLastSale", "neverSoldInObservedWindow"),
    "E1": FEATURE_ORDER[:-4],
    "E2": FEATURE_ORDER,
}


def make_estimator(candidate: str, feature_columns: tuple[str, ...], *, seed: int = 2026) -> Pipeline:
    categorical = [name for name in feature_columns if name in CAT_FEATURES]
    numeric = [name for name in feature_columns if name not in CAT_FEATURES]
    transformers: list[tuple[str, Any, list[str]]] = []
    if categorical:
        if candidate == "ET-E2":
            encoder = OneHotEncoder(handle_unknown="ignore", sparse_output=False, dtype=np.float32)
        else:
            encoder = OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1, encoded_missing_value=-1, dtype=np.float32)
        transformers.append(("categorical", encoder, categorical))
    if numeric:
        transformers.append(("numeric", "passthrough", numeric))
    preprocessor = ColumnTransformer(transformers, remainder="drop", verbose_feature_names_out=False)
    if candidate.startswith("HGB"):
        categorical_indices = list(range(len(categorical)))
        loss = "poisson" if candidate == "HGB-P-E2" else "squared_error"
        estimator = HistGradientBoostingRegressor(
            loss=loss, max_iter=150, learning_rate=0.05, max_leaf_nodes=15,
            min_samples_leaf=30, l2_regularization=1.0, early_stopping=False,
            categorical_features=categorical_indices or None, random_state=seed,
        )
    else:
        estimator = ExtraTreesRegressor(
            n_estimators=100, max_depth=12, min_samples_leaf=5, max_features=1.0,
            bootstrap=False, n_jobs=2, random_state=seed, criterion="squared_error",
        )
    return Pipeline([("preprocessing", preprocessor), ("estimator", estimator)])


def apply_nonnegative(prediction: Iterable[float]) -> np.ndarray:
    result = np.asarray(prediction, dtype=np.float64)
    if not np.isfinite(result).all():
        raise ValueError("Forecast contains nonfinite output")
    return np.maximum(result, 0.0)


def baseline_prediction(history: Iterable[int], horizon: int, method: str) -> float:
    values = list(history)
    if len(values) < 28:
        raise ValueError("Baseline requires 28 complete observed days")
    if method == "B0_LAST":
        return float(horizon * values[-1])
    if method == "B1_SEASONAL_7":
        recent_week = values[-7:]
        return float(sum(recent_week[index % 7] for index in range(horizon)))
    if method == "B2_MEAN_7":
        return float(horizon * np.mean(values[-7:]))
    if method == "B3_MEAN_28":
        return float(horizon * np.mean(values[-28:]))
    raise ValueError(f"Unknown baseline method: {method}")


def metric_bundle(actual: Iterable[float], prediction: Iterable[float]) -> dict[str, float | int | None]:
    y = np.asarray(actual, dtype=np.float64)
    p = np.asarray(prediction, dtype=np.float64)
    if y.shape != p.shape or y.size == 0:
        raise ValueError("Metric arrays must have the same nonempty shape")
    error = p - y
    denominator = float(np.abs(y).sum())
    return {
        "rows": int(y.size),
        "wape": float(np.abs(error).sum() / denominator) if denominator else None,
        "mae": float(np.abs(error).mean()),
        "rmse": float(np.sqrt(np.square(error).mean())),
        "bias_units": float(error.mean()),
        "normalized_bias": float(error.sum() / denominator) if denominator else None,
        "actual_units": float(y.sum()),
        "predicted_units": float(p.sum()),
    }


def segment_membership(dataset: V3Dataset, fit_end: date) -> dict[str, str]:
    result: dict[str, str] = {}
    for sku, series in dataset.daily_by_sku.items():
        values = [int(row["unitsSold"]) for row in series if row["localDate"] <= fit_end.isoformat()]
        mean = float(np.mean(values))
        zeros = float(np.mean(np.asarray(values) == 0))
        cv = float(np.std(values, ddof=0) / mean) if mean else None
        if mean < 0.5:
            segment = "very_low"
        elif zeros >= 0.5:
            segment = "intermittent"
        elif mean >= 3 and cv is not None and cv <= 1:
            segment = "high_stable"
        else:
            segment = "medium"
        result[sku] = segment
    return result


def predict_cold_start(*, sku_known: bool, daily_sales: Iterable[int], category_prior: float | None = None) -> dict[str, Any]:
    values = list(daily_sales)
    if not sku_known:
        if category_prior is not None and math.isfinite(category_prior) and category_prior >= 0:
            return {"status": "LIMITED_HISTORY", "forecastSource": "CATEGORY_PRIOR", "expectedDailyUnits": float(category_prior)}
        return {"status": "INSUFFICIENT_HISTORY", "forecastSource": None, "expectedDailyUnits": None}
    if len(values) >= 28:
        return {"status": "READY", "forecastSource": "MODEL_OR_BASELINE", "expectedDailyUnits": None}
    if len(values) >= 14:
        return {"status": "LIMITED_HISTORY", "forecastSource": "MOVING_AVERAGE_7", "expectedDailyUnits": float(np.mean(values[-7:]))}
    if len(values) >= 7:
        return {"status": "LIMITED_HISTORY", "forecastSource": "MOVING_AVERAGE_7", "expectedDailyUnits": float(np.mean(values[-7:]))}
    if category_prior is not None and math.isfinite(category_prior) and category_prior >= 0:
        return {"status": "LIMITED_HISTORY", "forecastSource": "CATEGORY_PRIOR", "expectedDailyUnits": float(category_prior)}
    return {"status": "INSUFFICIENT_HISTORY", "forecastSource": None, "expectedDailyUnits": None}


def feature_contract() -> dict[str, Any]:
    """Ordered, auditable feature allowlist for the V3 development bundle."""
    sources = {
        "sku": "canonical products.json; static identity",
        "categoryCode": "canonical products.json; static identity",
        "subcategoryCode": "canonical products.json; static identity",
        "brand": "canonical products.json; static descriptor",
        "presentation": "canonical products.json; static descriptor",
        "unit": "canonical products.json; static descriptor",
        "sizeValue": "canonical products.json; static descriptor",
        "containedUnits": "canonical products.json; static descriptor",
        "weekdayNext": "deterministic America/Lima calendar at t+1",
        "weekendNextDays": "deterministic America/Lima calendar t+1..t+h",
        "monthNext": "deterministic America/Lima calendar at t+1",
        "dayOfMonthNext": "deterministic America/Lima calendar at t+1",
        "paydayDays": "known day-of-month rule over t+1..t+h",
        "monthEndDays": "deterministic calendar over t+1..t+h",
        "holidayDaysKnown": "published frozen calendar only; unknown dates are not inferred",
        "holidayCoverageDays": "number of horizon dates present in the frozen calendar",
        "priceAtOriginCents": "canonical base price plus price events announced by t",
        "meanKnownPriceHorizonCents": "known prices announced by t and effective by each target date",
        "priceChangeKnownHorizonCents": "known horizon price minus price at t",
        "knownPromoDays": "promotions announced by t and effective in horizon",
        "meanKnownDiscountPct": "discount announced by t; no realized outcome fields",
        "currentUnits": "unitsSold[t], completed local day at origin",
        "lag_1": "unitsSold[t-1]",
        "lag_7": "unitsSold[t-7]",
        "lag_14": "unitsSold[t-14]",
        "lag_28": "unitsSold[t-28]",
        "rollingMean_7": "unitsSold[t-6..t], population mean",
        "rollingMean_14": "unitsSold[t-13..t], population mean",
        "rollingMean_28": "unitsSold[t-27..t], population mean",
        "rollingStd_7": "unitsSold[t-6..t], population std ddof=0",
        "rollingStd_28": "unitsSold[t-27..t], population std ddof=0",
        "zeroSalesStreak": "consecutive unitsSold==0 ending at t",
        "daysSinceLastSale": "calendar days since last positive unitsSold through t",
        "neverSoldInObservedWindow": "flag over 29 observed days through t",
        "currentStockAtCutoff": "endingStock[t], completed local day",
        "availableAtCutoff": "availableHours[t] > 0, completed local day",
        "limitedAvailabilityDays_7": "availableHours < 15 over t-6..t",
        "limitedAvailabilityDays_28": "availableHours < 15 over t-27..t",
    }
    units = {name: "units" for name in FEATURE_ORDER if name not in CAT_FEATURES}
    units.update({
        "sizeValue": "catalog sizeValue in sizeUnit", "containedUnits": "commercial items per package",
        "weekdayNext": "ISO weekday 1..7", "weekendNextDays": "days", "monthNext": "calendar month 1..12",
        "dayOfMonthNext": "calendar day 1..31", "paydayDays": "days", "monthEndDays": "days",
        "holidayDaysKnown": "days", "holidayCoverageDays": "days", "priceAtOriginCents": "PEN cents",
        "meanKnownPriceHorizonCents": "PEN cents", "priceChangeKnownHorizonCents": "PEN cents",
        "knownPromoDays": "days", "meanKnownDiscountPct": "percent", "currentUnits": "effective units", "rollingMean_7": "effective units/day",
        "rollingMean_14": "effective units/day", "rollingMean_28": "effective units/day",
        "rollingStd_7": "effective units/day", "rollingStd_28": "effective units/day",
        "zeroSalesStreak": "days", "daysSinceLastSale": "days", "neverSoldInObservedWindow": "boolean",
        "currentStockAtCutoff": "effective units", "availableAtCutoff": "boolean",
        "limitedAvailabilityDays_7": "days", "limitedAvailabilityDays_28": "days",
    })
    types = {name: "string" for name in CAT_FEATURES}
    types.update({name: "float" for name in NUM_FEATURES})
    for name in ("containedUnits", "weekdayNext", "weekendNextDays", "monthNext", "dayOfMonthNext", "paydayDays", "monthEndDays", "holidayDaysKnown", "holidayCoverageDays", "knownPromoDays", "zeroSalesStreak", "daysSinceLastSale", "neverSoldInObservedWindow", "currentStockAtCutoff", "availableAtCutoff", "limitedAvailabilityDays_7", "limitedAvailabilityDays_28"):
        types[name] = "integer"
    return {
        "featureVersion": FEATURE_VERSION,
        "featureOrder": list(FEATURE_ORDER),
        "featureSets": {key: list(value) for key, value in FEATURE_SETS.items()},
        "categorical": list(CAT_FEATURES),
        "numeric": list(NUM_FEATURES),
        "sourcesAndAsOfRules": sources,
        "units": units,
        "types": types,
        "forbidden": sorted(FORBIDDEN_FEATURES),
        "sha256": hashlib.sha256(json.dumps({"order": FEATURE_ORDER, "sets": FEATURE_SETS, "sources": sources}, sort_keys=True).encode()).hexdigest(),
    }


def coherent_predictions(predictions_by_horizon: dict[int, np.ndarray]) -> tuple[dict[int, np.ndarray], int, float]:
    """Apply the pre-registered cumulative monotonic constraint for same-origin forecasts."""
    if not {1, 7, 14}.issubset(predictions_by_horizon):
        raise ValueError("Coherence requires direct 1/7/14-day predictions")
    p1, p7, p14 = (apply_nonnegative(predictions_by_horizon[h]) for h in (1, 7, 14))
    if p1.shape != p7.shape or p1.shape != p14.shape:
        raise ValueError("Coherence inputs must align by SKU and prediction origin")
    raw = np.concatenate((p1, p7, p14))
    c7 = np.maximum(p7, p1)
    c14 = np.maximum(p14, c7)
    adjusted = np.concatenate((c7 - p7, c14 - p14))
    return {1: p1, 7: c7, 14: c14}, int(np.count_nonzero(adjusted)), float(np.abs(adjusted).sum() / max(float(raw.sum()), 1e-12))


def prediction_contract(
    *, sku: str, cutoff_date: date, forecast: dict[int, float], model_version: str,
    source_by_horizon: dict[int, str], approved_horizons: Iterable[int] = PRIMARY_HORIZONS,
) -> dict[str, Any]:
    approved = set(approved_horizons)
    if not sku or not {1, 7, 14}.issubset(forecast) or not {1, 7, 14}.issubset(source_by_horizon):
        raise ValueError("Prediction contract requires a known SKU and complete primary horizon set")
    if any(not math.isfinite(float(forecast[h])) or forecast[h] < 0 for h in PRIMARY_HORIZONS):
        raise ValueError("Forecast must be finite and nonnegative")
    values = [float(forecast[h]) for h in PRIMARY_HORIZONS]
    if not values[0] <= values[1] <= values[2]:
        raise ValueError("Cumulative forecast horizons must be monotonic")
    return {
        "scenarioId": SCENARIO_ID,
        "sku": sku,
        "cutoffDate": cutoff_date.isoformat(),
        "timezone": "America/Lima",
        "modelVersion": model_version,
        "targetDefinition": "effective_units_sold_cumulative_t_plus_1_through_t_plus_h",
        "status": "READY",
        "forecast": {
            f"expectedUnitsNext{h}d": float(forecast[h]) if h in approved else None
            for h in PRIMARY_HORIZONS
        },
        "horizonMetadata": [
            {
                "horizonDays": h,
                "forecastStart": (cutoff_date + timedelta(days=1)).isoformat(),
                "forecastEnd": (cutoff_date + timedelta(days=h)).isoformat(),
                "qualityStatus": "APPROVED" if h in approved else "NOT_APPROVED",
                "forecastSource": source_by_horizon[h],
                "modelVersion": model_version,
                "coherenceAdjustment": "applied across cumulative horizons",
            }
            for h in PRIMARY_HORIZONS
        ],
        "predictionInterval": None,
        "confidence": None,
    }


def predict_forecast_batch(
    dataset: V3Dataset,
    *,
    prediction_origin: date,
    skus: Iterable[str],
    strategy_by_horizon: dict[int | str, dict[str, Any]],
    models: dict[int | str, Any] | None = None,
    model_version: str = MODEL_VERSION,
) -> list[dict[str, Any]]:
    """Local V3 inference contract. This does not access inventory decisions or cloud services."""
    model_map = {int(key): value for key, value in (models or {}).items()}
    strategy_map = {int(key): value for key, value in strategy_by_horizon.items()}
    if not set(PRIMARY_HORIZONS).issubset(strategy_map):
        raise ValueError("V3 strategy must define the approved 1/7/14-day horizons")
    segments = segment_membership(dataset, prediction_origin)
    outputs: list[dict[str, Any]] = []
    for sku in skus:
        if sku not in dataset.product_by_sku:
            outputs.append({"scenarioId": SCENARIO_ID, "sku": sku, "cutoffDate": prediction_origin.isoformat(), "status": "UNKNOWN_SKU", "forecast": None, "confidence": None, "predictionInterval": None})
            continue
        history_map = dataset.inventory.get(sku, {})
        if any((prediction_origin - timedelta(days=offset)).isoformat() not in history_map for offset in range(27, -1, -1)):
            outputs.append({"scenarioId": SCENARIO_ID, "sku": sku, "cutoffDate": prediction_origin.isoformat(), "status": "INSUFFICIENT_HISTORY", "forecast": None, "confidence": None, "predictionInterval": None})
            continue
        features = {h: dataset.feature_row(sku, prediction_origin, h) for h in PRIMARY_HORIZONS}
        raw_prediction: dict[int, np.ndarray] = {}
        source: dict[int, str] = {}
        for horizon in PRIMARY_HORIZONS:
            strategy = strategy_map[horizon]
            fallback = strategy.get("method") == "BASELINE_FALLBACK" or segments[sku] in set(strategy.get("fallbackSegments", []))
            baseline_name = strategy["baseline"]
            observed = [int(history_map[(prediction_origin - timedelta(days=offset)).isoformat()]["unitsSold"]) for offset in range(27, -1, -1)]
            baseline_value = baseline_prediction(observed, horizon, baseline_name)
            if not fallback:
                if horizon not in model_map:
                    raise ValueError(f"Selected V3 ML horizon {horizon} is missing its trusted local model")
                columns = strategy.get("selectedFeatures") or FEATURE_SETS[strategy["featureSet"]]
                frame = pd.DataFrame([{name: features[horizon][name] for name in columns}])
                prediction = float(apply_nonnegative(model_map[horizon].predict(frame))[0])
                source[horizon] = "ML"
            else:
                prediction = baseline_value
                source[horizon] = "BASELINE_FALLBACK"
            raw_prediction[horizon] = np.asarray([prediction], dtype=np.float64)
        coherent, _, _ = coherent_predictions(raw_prediction)
        result = prediction_contract(
            sku=sku, cutoff_date=prediction_origin,
            forecast={h: float(coherent[h][0]) for h in PRIMARY_HORIZONS},
            model_version=model_version, source_by_horizon=source,
        )
        result["generatedAt"] = datetime.now(timezone.utc).isoformat()
        result["cutoffExclusiveUtc"] = f"{(prediction_origin + timedelta(days=1)).isoformat()}T05:00:00Z"
        result["trainedThrough"] = str(max(value.get("trainedThrough", HISTORY_END.isoformat()) for value in strategy_map.values()))
        outputs.append(result)
    return outputs


def load_verified_v3_models(bundle_dir: Path, manifest: dict[str, Any]) -> dict[int, Any]:
    """Load only bundle files whose internal hashes match the trusted manifest."""
    if manifest.get("scenarioId") != SCENARIO_ID or manifest.get("datasetVersion") != DATASET_VERSION or manifest.get("datasetSha256") != DATASET_SHA256:
        raise ValueError("V3 artifact lineage does not match the approved scenario")
    if manifest.get("featureVersion") != FEATURE_VERSION:
        raise ValueError("V3 artifact feature version mismatch")
    feature_spec = manifest.get("featureContract")
    if not isinstance(feature_spec, dict) or feature_spec.get("sha256") != feature_contract()["sha256"]:
        raise ValueError("V3 artifact feature contract mismatch")
    if manifest.get("featureContractSha256") != feature_spec.get("sha256"):
        raise ValueError("V3 artifact feature contract hash mismatch")
    if manifest.get("timezone") != "America/Lima" or manifest.get("modelVersion") != MODEL_VERSION:
        raise ValueError("V3 artifact timezone/model version mismatch")
    if manifest.get("targetDefinition") != "effective_units_sold_cumulative_t_plus_1_through_t_plus_h":
        raise ValueError("V3 artifact target contract mismatch")
    result: dict[int, Any] = {}
    for horizon_text, strategy in manifest.get("horizonStrategy", {}).items():
        horizon = int(horizon_text)
        filename = strategy.get("artifactModelFile")
        if not filename:
            continue
        record = manifest.get("files", {}).get(filename)
        path = (bundle_dir / filename).resolve()
        if bundle_dir.resolve() not in path.parents or not record or not path.is_file() or sha256_file(path) != record.get("sha256"):
            raise ValueError("V3 artifact file is missing, outside bundle, or hash-mismatched")
        result[horizon] = joblib.load(path)
    return result
