"""One-shot, leakage-guarded local M6.5B benchmark for Pasco V3."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
import threading
import copy
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import psutil
from threadpoolctl import threadpool_limits

from ml.src.v3_forecast import (
    DATASET_SHA256, DATASET_VERSION, FEATURE_SETS, FEATURE_VERSION, FOLDS,
    HISTORY_END, HORIZONS, MODEL_VERSION, PRIMARY_HORIZONS, SCENARIO_ID,
    SPLITS, apply_nonnegative, baseline_prediction, build_examples,
    coherent_predictions, feature_contract, load_validated_dataset, make_estimator, read_ndjson,
    metric_bundle, predict_cold_start, predict_forecast_batch, segment_membership, sha256_file,
)


class PeakRssSampler:
    def __init__(self) -> None:
        self.process = psutil.Process()
        self.peak = self.process.memory_info().rss
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._sample, daemon=True)

    def _sample(self) -> None:
        while not self.stop.is_set():
            self.peak = max(self.peak, self.process.memory_info().rss)
            self.stop.wait(0.1)

    def __enter__(self) -> "PeakRssSampler":
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop.set()
        self.thread.join(timeout=1)


ROOT = Path(__file__).resolve().parents[2]
RUN_DIR = ROOT / "ml/.test-tmp/m6_5b_v3"
FREEZE_PATH = RUN_DIR / "test-freeze.json"
REPORT_PATH = RUN_DIR / "benchmark-results.json"
ARTIFACT_DIR = ROOT / "ml/models/minimarket-pasco-v3"
BASELINES = ("B0_LAST", "B1_SEASONAL_7", "B2_MEAN_7", "B3_MEAN_28")
CANDIDATES = ("HGB-S-E0", "HGB-S-E1", "HGB-S-E2", "HGB-P-E2", "ET-E2")
SEED = 2026
MAX_FITS = 76
MAX_CPU_SECONDS = 30 * 60
MAX_RSS_BYTES = 2 * 1024**3
ACTIVE_RSS_SAMPLER: PeakRssSampler | None = None


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temp, path)


def git_value(*args: str) -> str:
    try:
        return subprocess.check_output(["git", *args], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return "unavailable"


def fit_origins(cutoff: date, horizon: int) -> list[date]:
    start = date.fromisoformat("2025-11-10")
    end = cutoff - timedelta(days=horizon)
    return [start + timedelta(days=i) for i in range(max(0, (end - start).days + 1))]


def example_frame(dataset: Any, origins: list[date], horizon: int, segments: dict[str, str]) -> tuple[Any, np.ndarray, Any]:
    x, y, meta = build_examples(dataset, origins, horizon)
    meta["segment"] = meta["sku"].map(segments)
    return x, y, meta


def actual_baseline(dataset: Any, meta: Any, horizon: int, name: str) -> np.ndarray:
    predictions = []
    for row in meta.itertuples(index=False):
        origin = date.fromisoformat(row.origin)
        history = [int(dataset.inventory[row.sku][(origin - timedelta(days=offset)).isoformat()]["unitsSold"]) for offset in range(27, -1, -1)]
        predictions.append(baseline_prediction(history, horizon, name))
    return apply_nonnegative(predictions)


def joined_metrics(y: np.ndarray, p: np.ndarray, meta: Any) -> dict[str, Any]:
    overall = metric_bundle(y, p)
    category: dict[str, Any] = {}
    for key in sorted(meta["category"].unique()):
        mask = meta["category"].to_numpy() == key
        category[str(key)] = metric_bundle(y[mask], p[mask])
    subcategory: dict[str, Any] = {}
    for key in sorted(meta["subcategory"].unique()):
        mask = meta["subcategory"].to_numpy() == key
        subcategory[str(key)] = metric_bundle(y[mask], p[mask])
    segment: dict[str, Any] = {}
    for key in sorted(meta["segment"].dropna().unique()):
        mask = meta["segment"].to_numpy() == key
        segment[str(key)] = metric_bundle(y[mask], p[mask])
    sku_metrics: list[dict[str, Any]] = []
    for sku in sorted(meta["sku"].unique()):
        mask = meta["sku"].to_numpy() == sku
        metrics = metric_bundle(y[mask], p[mask])
        sku_metrics.append({"sku": sku, **metrics})
    valid_wape = [item for item in sku_metrics if item["wape"] is not None]
    macro_mae = float(np.mean([item["mae"] for item in sku_metrics]))
    return {
        "overall": overall,
        "category": category,
        "subcategory": subcategory,
        "segment": segment,
        "sku": sku_metrics,
        "macroMaeBySku": macro_mae,
        "medianSkuWape": float(np.median([item["wape"] for item in valid_wape])) if valid_wape else None,
        "skuWithZeroActual": int(sum(item["actual_units"] == 0 for item in sku_metrics)),
    }


def relative_improvement(baseline: float | None, model: float | None) -> float | None:
    if baseline is None or model is None or baseline <= 0:
        return None
    return float((baseline - model) / baseline)


def revenues_by_sku(dataset: Any, cutoff: date) -> dict[str, int]:
    generated = ROOT / "data/minimarket-pasco-v3/generated"
    sales: dict[str, tuple[str, str]] = {}
    with (generated / "sales.ndjson").open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            sales[row["saleCode"]] = (row["localDate"], row["status"])
    totals: dict[str, int] = defaultdict(int)
    with (generated / "sale-items.ndjson").open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            sale = sales.get(row["saleCode"])
            if sale and sale[1] == "completed" and sale[0] <= cutoff.isoformat():
                totals[row["sku"]] += int(row["lineTotalCents"])
    return dict(totals)


def top_revenue_skus(dataset: Any, cutoff: date) -> list[str]:
    revenue = revenues_by_sku(dataset, cutoff)
    return [sku for sku, _ in sorted(revenue.items(), key=lambda item: (-item[1], item[0]))[:10]]


def attach_top10_gate(metrics: dict[str, Any], top10: list[str], baseline_metrics: dict[str, Any]) -> dict[str, Any]:
    model = {row["sku"]: row for row in metrics["sku"]}
    baseline = {row["sku"]: row for row in baseline_metrics["sku"]}
    results = []
    passed = True
    for sku in top10:
        current, prior = model[sku], baseline[sku]
        mae_degradation = (current["mae"] - prior["mae"]) / prior["mae"] if prior["mae"] > 0 else None
        norm_bias = current["normalized_bias"]
        sku_ok = ((mae_degradation is not None and mae_degradation <= 0.20) or (mae_degradation is None and current["mae"] <= prior["mae"])) and (norm_bias is None or abs(norm_bias) <= 0.20)
        results.append({"sku": sku, "model": current, "baseline": prior, "relativeMaeDegradation": mae_degradation, "passed": sku_ok})
        passed = passed and sku_ok
    return {"items": results, "passed": passed}


def segment_strategy(candidate_prediction: np.ndarray, baseline_prediction_: np.ndarray, meta: Any, fallback_segments: set[str]) -> np.ndarray:
    result = np.asarray(candidate_prediction, dtype=np.float64).copy()
    mask = meta["segment"].isin(fallback_segments).to_numpy()
    result[mask] = baseline_prediction_[mask]
    return apply_nonnegative(result)


def validation_fallbacks(model_metrics: dict[str, Any], base_metrics: dict[str, Any]) -> set[str]:
    fallback: set[str] = set()
    for segment, model in model_metrics["segment"].items():
        base = base_metrics["segment"][segment]
        improvement = relative_improvement(base["wape"], model["wape"])
        if improvement is None:
            # Zero-denominator/error-zero groups are compared without division.
            if (base["wape"] is None and model["mae"] > base["mae"] + 0.1) or (base["wape"] == 0 and model["mae"] >= base["mae"]):
                fallback.add(segment)
        elif improvement <= 0:
            fallback.add(segment)
    return fallback


def check_acceptance(model: dict[str, Any], baseline: dict[str, Any], horizon: int, top10: list[str]) -> dict[str, Any]:
    overall = model["overall"]
    base = baseline["overall"]
    improvement = relative_improvement(base["wape"], overall["wape"])
    checks = {
        "relativeWapeAtLeast5Pct": improvement is not None and improvement >= 0.05,
        "absoluteNormalizedBiasAtMost10Pct": overall["normalized_bias"] is not None and abs(overall["normalized_bias"]) <= 0.10,
        "macroMaeNoMoreThan10PctWorse": model["macroMaeBySku"] <= baseline["macroMaeBySku"] * 1.10 if baseline["macroMaeBySku"] > 0 else model["macroMaeBySku"] <= 0.1 * horizon,
    }
    group_failures = []
    for group_type in ("category", "segment"):
        for name, item in model[group_type].items():
            prior = baseline[group_type][name]
            if item["actual_units"] > 0 and prior["wape"] is not None and item["wape"] is not None and prior["wape"] > 0:
                if relative_improvement(prior["wape"], item["wape"]) < -0.10:
                    group_failures.append(f"{group_type}:{name}:WAPE")
            elif item["mae"] > prior["mae"] + 0.1 * horizon:
                group_failures.append(f"{group_type}:{name}:MAE-zero-denominator")
    checks["categoryAndSegmentProtection"] = not group_failures
    top_gate = attach_top10_gate(model, top10, baseline)
    checks["top10BusinessSkuGate"] = top_gate["passed"]
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "relativeWapeImprovement": improvement,
        "groupFailures": group_failures,
        "top10": top_gate,
    }


def fit_and_predict(candidate: str, feature_set: str, horizon: int, train: tuple[Any, np.ndarray], evaluate: tuple[Any, np.ndarray], fit_counter: list[int], started: float) -> tuple[np.ndarray, Any, dict[str, Any]]:
    if fit_counter[0] >= MAX_FITS:
        raise RuntimeError("M6.5A maximum 76 fits would be exceeded")
    if time.process_time() - started > MAX_CPU_SECONDS:
        raise RuntimeError("M6.5A 30-minute CPU budget reached; stopping further fits")
    process = psutil.Process()
    if process.memory_info().rss > MAX_RSS_BYTES or (ACTIVE_RSS_SAMPLER and ACTIVE_RSS_SAMPLER.peak > MAX_RSS_BYTES):
        raise RuntimeError("M6.5A 2 GiB RSS budget reached; stopping further fits")
    candidate_features = FEATURE_SETS[feature_set]
    model = make_estimator(candidate, candidate_features, seed=SEED)
    fit_counter[0] += 1
    t0 = time.perf_counter()
    with threadpool_limits(limits=2):
        model.fit(train[0].loc[:, candidate_features], train[1])
        prediction = apply_nonnegative(model.predict(evaluate[0].loc[:, candidate_features]))
    elapsed = time.perf_counter() - t0
    rss = process.memory_info().rss
    if rss > MAX_RSS_BYTES or (ACTIVE_RSS_SAMPLER and ACTIVE_RSS_SAMPLER.peak > MAX_RSS_BYTES):
        raise RuntimeError("M6.5A 2 GiB RSS budget exceeded during fit")
    if time.process_time() - started > MAX_CPU_SECONDS:
        raise RuntimeError("M6.5A 30-minute CPU budget exceeded during fit")
    return prediction, model, {"fitNumber": fit_counter[0], "seconds": round(elapsed, 3), "rssBytesAfterFit": rss}


def collect_window_data(dataset: Any, horizon: int, origins: list[date], segments: dict[str, str]) -> tuple[Any, np.ndarray, Any]:
    return example_frame(dataset, origins, horizon, segments)


def candidate_from_parts(candidate: str) -> tuple[str, str]:
    if candidate.startswith("HGB-S"):
        return "HGB-S", candidate[-2:]
    if candidate.startswith("HGB-P"):
        return "HGB-P", "E2"
    return "ET-E2", "E2"


def candidate_parameters(candidate: str) -> dict[str, Any]:
    if candidate.startswith("HGB"):
        return {
            "estimator": "HistGradientBoostingRegressor",
            "loss": "poisson" if candidate == "HGB-P-E2" else "squared_error",
            "learning_rate": 0.05, "max_iter": 150, "max_leaf_nodes": 15,
            "min_samples_leaf": 30, "l2_regularization": 1.0,
            "early_stopping": False, "random_state": SEED,
            "categoricalEncoding": "fit-only OrdinalEncoder, unknown=-1 treated as missing",
        }
    return {
        "estimator": "ExtraTreesRegressor", "n_estimators": 100,
        "max_depth": 12, "min_samples_leaf": 5, "max_features": 1.0,
        "bootstrap": False, "n_jobs": 2, "criterion": "squared_error",
        "random_state": SEED, "categoricalEncoding": "fit-only OneHotEncoder, unknown ignored",
    }


def _origins(split: str, horizon: int) -> list[date]:
    start, end = SPLITS[split]
    # A prediction origin precedes the first target day by one day.
    first = date(2025, 11, 10) if split == "train" else start - timedelta(days=1)
    last = end - timedelta(days=horizon)
    if first > last:
        return []
    return [first + timedelta(days=i) for i in range((last - first).days + 1)]


def non_overlapping_rows(meta: Any, horizon: int) -> np.ndarray:
    origins = sorted(meta["origin"].unique())
    selected = set(origins[::horizon])
    return meta["origin"].isin(selected).to_numpy()


def with_non_overlapping_summary(metrics: dict[str, Any], y: np.ndarray, p: np.ndarray, meta: Any, horizon: int) -> dict[str, Any]:
    mask = non_overlapping_rows(meta, horizon)
    return {**metrics, "nonOverlappingOrigins": sorted(meta.loc[mask, "origin"].unique().tolist()), "nonOverlapping": metric_bundle(y[mask], p[mask])}


def align_common_horizon_rows(payload_by_horizon: dict[int, tuple[np.ndarray, np.ndarray, Any]]) -> tuple[dict[int, np.ndarray], dict[int, np.ndarray], dict[int, Any], list[tuple[str, str]]]:
    common_origins = set.intersection(*(set(payload_by_horizon[h][2]["origin"]) for h in PRIMARY_HORIZONS))
    indexes = {
        h: {(row.sku, row.origin): i for i, row in enumerate(payload_by_horizon[h][2].itertuples(index=False)) if row.origin in common_origins}
        for h in PRIMARY_HORIZONS
    }
    keys = sorted(set.intersection(*(set(indexes[h]) for h in PRIMARY_HORIZONS)))
    y_by_horizon: dict[int, np.ndarray] = {}
    p_by_horizon: dict[int, np.ndarray] = {}
    meta_by_horizon: dict[int, Any] = {}
    for h in PRIMARY_HORIZONS:
        y, prediction, metadata = payload_by_horizon[h]
        order = [indexes[h][key] for key in keys]
        y_by_horizon[h] = np.asarray(y)[order]
        p_by_horizon[h] = np.asarray(prediction)[order]
        meta_by_horizon[h] = metadata.iloc[order].reset_index(drop=True)
    return y_by_horizon, p_by_horizon, meta_by_horizon, keys


def test_rows_after_lock(dataset: Any, horizon: int, segments: dict[str, str]) -> tuple[Any, np.ndarray, Any]:
    return collect_window_data(dataset, horizon, _origins("test", horizon), segments)


def run_benchmark() -> None:
    global ACTIVE_RSS_SAMPLER
    if FREEZE_PATH.exists() or REPORT_PATH.exists():
        raise RuntimeError("A previous M6.5B freeze/result exists; TEST cannot be repeated")
    if ARTIFACT_DIR.exists():
        raise RuntimeError("V3 artifact directory already exists; refusing to overwrite it")
    np.random.seed(SEED)
    started_wall, started_cpu = time.perf_counter(), time.process_time()
    process = psutil.Process()
    peak_rss = process.memory_info().rss
    rss_sampler = PeakRssSampler()
    ACTIVE_RSS_SAMPLER = rss_sampler
    rss_sampler.__enter__()
    dataset = load_validated_dataset(ROOT)
    feature_spec = feature_contract()
    full_day_rows = sum(map(len, dataset.daily_by_sku.values()))
    if full_day_rows != 29_200 or len(dataset.products) != 80:
        raise ValueError("V3 canonical dataset must be exactly 80 SKUs ×365 days")
    initial_segments = segment_membership(dataset, SPLITS["train"][1])
    expected_segment_counts = {"very_low": 12, "intermittent": 17, "high_stable": 9, "medium": 42}
    actual_segment_counts = {name: list(initial_segments.values()).count(name) for name in expected_segment_counts}
    if actual_segment_counts != expected_segment_counts:
        raise ValueError(f"V3 training-only segments changed: {actual_segment_counts}")
    initial_top10 = top_revenue_skus(dataset, SPLITS["train"][1])
    fits: list[int] = [0]
    fit_log: list[dict[str, Any]] = []
    validation_results: dict[int, dict[str, Any]] = {}
    fold_results: dict[int, dict[str, Any]] = {}
    model_predictions: dict[int, dict[str, Any]] = {}
    baseline_predictions: dict[int, dict[str, Any]] = {}
    model_choices: dict[int, dict[str, Any]] = {}

    for horizon in PRIMARY_HORIZONS:
        full_train = collect_window_data(dataset, horizon, _origins("train", horizon), initial_segments)
        validation = collect_window_data(dataset, horizon, _origins("validation", horizon), initial_segments)
        base_val: dict[str, np.ndarray] = {}
        baseline_metric: dict[str, Any] = {}
        for baseline in BASELINES:
            pred = actual_baseline(dataset, validation[2], horizon, baseline)
            base_val[baseline] = pred
            baseline_metric[baseline] = with_non_overlapping_summary(
                joined_metrics(validation[1], pred, validation[2]), validation[1], pred, validation[2], horizon,
            )
        selected_baseline = min(BASELINES, key=lambda name: (baseline_metric[name]["overall"]["wape"] if baseline_metric[name]["overall"]["wape"] is not None else float("inf"), BASELINES.index(name)))
        baseline_predictions[horizon] = {"validation": (validation[1], base_val[selected_baseline], validation[2]), "allValidation": base_val, "test": {}}

        candidates_data: dict[str, Any] = {}
        for candidate_name in CANDIDATES:
            estimator_name, feature_set = candidate_from_parts(candidate_name)
            fold_metrics: list[dict[str, Any]] = []
            fold_payload: list[tuple[np.ndarray, np.ndarray, Any]] = []
            for fold_name, fit_end, eval_start, eval_end in FOLDS:
                train_set = collect_window_data(dataset, horizon, fit_origins(fit_end, horizon), segment_membership(dataset, fit_end))
                fold_segments = segment_membership(dataset, fit_end)
                eval_origins = [date.fromisoformat(value) for value in _date_range_origins(eval_start - timedelta(days=1), eval_end - timedelta(days=horizon))]
                evaluation = collect_window_data(dataset, horizon, eval_origins, fold_segments)
                prediction, _, timing = fit_and_predict(estimator_name, feature_set, horizon, train_set[:2], evaluation[:2], fits, started_cpu)
                baseline = actual_baseline(dataset, evaluation[2], horizon, selected_baseline)
                mmodel, mbase = joined_metrics(evaluation[1], prediction, evaluation[2]), joined_metrics(evaluation[1], baseline, evaluation[2])
                fit_log.append({"horizon": horizon, "candidate": candidate_name, "fold": fold_name, **timing})
                fold_metrics.append({"fold": fold_name, "model": mmodel, "baseline": mbase, "relativeWapeImprovement": relative_improvement(mbase["overall"]["wape"], mmodel["overall"]["wape"])})
                fold_payload.append((evaluation[1], prediction, evaluation[2]))
            validation_prediction, _, timing = fit_and_predict(estimator_name, feature_set, horizon, full_train[:2], validation[:2], fits, started_cpu)
            val_raw = joined_metrics(validation[1], validation_prediction, validation[2])
            fallback = validation_fallbacks(val_raw, baseline_metric[selected_baseline])
            val_final_prediction = segment_strategy(validation_prediction, base_val[selected_baseline], validation[2], fallback)
            val_final = joined_metrics(validation[1], val_final_prediction, validation[2])
            val_non_overlapping = metric_bundle(
                validation[1][non_overlapping_rows(validation[2], horizon)],
                val_final_prediction[non_overlapping_rows(validation[2], horizon)],
            )
            acceptance = check_acceptance(val_final, baseline_metric[selected_baseline], horizon, initial_top10)
            fold_strategy_results = []
            for (payload, fold) in zip(fold_payload, fold_metrics):
                yfold, raw_pred, fold_meta = payload
                baseline_fold = actual_baseline(dataset, fold_meta, horizon, selected_baseline)
                final_pred = segment_strategy(raw_pred, baseline_fold, fold_meta, fallback)
                final_m = joined_metrics(yfold, final_pred, fold_meta)
                fold_strategy_results.append({"fold": fold["fold"], "metrics": final_m, "relativeWapeImprovement": relative_improvement(fold["baseline"]["overall"]["wape"], final_m["overall"]["wape"])})
            gains = [entry["relativeWapeImprovement"] for entry in fold_strategy_results]
            stability_pass = sum(value is not None and value > 0 for value in gains) >= 2 and np.mean([value for value in gains if value is not None]) >= 0 and not any(value is not None and value < -0.10 for value in gains)
            acceptance["checks"]["walkForwardStability"] = bool(stability_pass)
            acceptance["passed"] = all(acceptance["checks"].values())
            candidates_data[candidate_name] = {
                "featureSet": feature_set,
                "featureCount": len(FEATURE_SETS[feature_set]),
                "folds": fold_metrics,
                "foldsAfterFallback": fold_strategy_results,
                "validationRaw": val_raw,
                "validationFinal": val_final,
                "validationNonOverlapping": val_non_overlapping,
                "fallbackSegments": sorted(fallback),
                "acceptance": acceptance,
                "validationPrediction": validation_prediction,
                "timing": timing,
            }
        eligible = [name for name, result in candidates_data.items() if result["acceptance"]["passed"]]
        candidate_selected = min(eligible, key=lambda name: (candidates_data[name]["validationFinal"]["overall"]["wape"], CANDIDATES.index(name))) if eligible else None
        if candidate_selected:
            selected = candidates_data[candidate_selected]
            model_choices[horizon] = {
                "method": "HYBRID_ML_BASELINE" if selected["fallbackSegments"] else "ML",
                "baseline": selected_baseline,
                "candidate": candidate_selected,
                "featureSet": selected["featureSet"],
                "fallbackSegments": selected["fallbackSegments"],
                "validationMetrics": selected["validationFinal"],
                "validationAcceptance": selected["acceptance"],
                "rawValidationMetrics": selected["validationRaw"],
            }
            model_predictions[horizon] = {"validation": selected["validationPrediction"], "validationFinal": segment_strategy(selected["validationPrediction"], base_val[selected_baseline], validation[2], set(selected["fallbackSegments"])), "candidates": candidates_data}
        else:
            baseline_selected = baseline_metric[selected_baseline]
            model_choices[horizon] = {
                "method": "BASELINE_FALLBACK", "baseline": selected_baseline,
                "candidate": None, "featureSet": None, "fallbackSegments": list(expected_segment_counts),
                "validationMetrics": baseline_selected, "validationAcceptance": {"passed": True, "checks": {"declaredValidationSelectedBaseline": True}},
            }
            model_predictions[horizon] = {"validation": None, "validationFinal": base_val[selected_baseline], "candidates": candidates_data}
        validation_results[horizon] = {
            "baselineCandidates": baseline_metric,
            "selectedBaseline": selected_baseline,
            "candidateResults": {name: {key: value for key, value in result.items() if key not in {"validationPrediction", "timing"}} for name, result in candidates_data.items()},
        }
        fold_results[horizon] = {name: result["foldsAfterFallback"] for name, result in candidates_data.items()}

    # A single frozen configuration for the experimental 28-day sensitivity, derived from 7d development only.
    h28_baseline_data = collect_window_data(dataset, 28, _origins("validation", 28), initial_segments)
    h28_baseline_candidates: dict[str, Any] = {}
    for baseline in BASELINES:
        pred = actual_baseline(dataset, h28_baseline_data[2], 28, baseline)
        h28_baseline_candidates[baseline] = {"prediction": pred, "metrics": joined_metrics(h28_baseline_data[1], pred, h28_baseline_data[2])}
    h28_baseline = min(BASELINES, key=lambda name: (h28_baseline_candidates[name]["metrics"]["overall"]["wape"] if h28_baseline_candidates[name]["metrics"]["overall"]["wape"] is not None else float("inf"), BASELINES.index(name)))
    hgb_options_for_h28 = [name for name in CANDIDATES if name.startswith("HGB")]
    h28_model_name = min(
        hgb_options_for_h28,
        key=lambda name: validation_results[7]["candidateResults"][name]["validationFinal"]["overall"]["wape"],
    )
    h28_estimator, h28_features = candidate_from_parts(h28_model_name)
    h28_folds: list[dict[str, Any]] = []
    for fold_name, fit_end, eval_start, eval_end in FOLDS:
        fold_segments = segment_membership(dataset, fit_end)
        train_set = collect_window_data(dataset, 28, fit_origins(fit_end, 28), fold_segments)
        eval_origins = [date.fromisoformat(value) for value in _date_range_origins(eval_start - timedelta(days=1), eval_end - timedelta(days=28))]
        evaluation = collect_window_data(dataset, 28, eval_origins, fold_segments)
        pred, _, timing = fit_and_predict(h28_estimator, h28_features, 28, train_set[:2], evaluation[:2], fits, started_cpu)
        base = actual_baseline(dataset, evaluation[2], 28, h28_baseline)
        h28_folds.append({"fold": fold_name, "model": joined_metrics(evaluation[1], pred, evaluation[2]), "baseline": joined_metrics(evaluation[1], base, evaluation[2]), "relativeWapeImprovement": relative_improvement(metric_bundle(evaluation[1], base)["wape"], metric_bundle(evaluation[1], pred)["wape"]), "timing": timing})
    h28_train = collect_window_data(dataset, 28, _origins("train", 28), initial_segments)
    h28_val_pred, _, h28_val_timing = fit_and_predict(h28_estimator, h28_features, 28, h28_train[:2], h28_baseline_data[:2], fits, started_cpu)
    h28_val_metrics = joined_metrics(h28_baseline_data[1], h28_val_pred, h28_baseline_data[2])

    # Limited, pre-registered censoring ablation on h7 only: selected HGB family, filtered TRAIN labels only.
    h7_candidate_results = validation_results[7]["candidateResults"]
    hgb_candidates = [name for name in CANDIDATES if name.startswith("HGB")]
    hgb_choice = min(hgb_candidates, key=lambda name: h7_candidate_results[name]["validationFinal"]["overall"]["wape"] if "validationFinal" in h7_candidate_results[name] else float("inf"))
    ablation_estimator, ablation_features = candidate_from_parts(hgb_choice)
    ablation: dict[str, Any] = {"candidate": hgb_choice, "horizon": 7, "fits": []}
    val7 = collect_window_data(dataset, 7, _origins("validation", 7), initial_segments)
    train7 = collect_window_data(dataset, 7, _origins("train", 7), initial_segments)
    ablation_fit_x = train7[0].loc[~train7[2]["censoredLabel"].to_numpy()].reset_index(drop=True)
    ablation_fit_y = train7[1][~train7[2]["censoredLabel"].to_numpy()]
    ablation_prediction, _, timing = fit_and_predict(ablation_estimator, ablation_features, 7, (ablation_fit_x, ablation_fit_y), val7[:2], fits, started_cpu)
    ablation["fits"].append({"split": "validation", "fitRowsBefore": len(train7[1]), "fitRowsAfter": len(ablation_fit_y), "evaluationRows": len(val7[1]), "metricsAllValidation": joined_metrics(val7[1], ablation_prediction, val7[2]), "timing": timing})
    # The three fold ablations deliberately filter only each fold's own TRAIN labels.
    for fold_name, fit_end, eval_start, eval_end in FOLDS:
        fold_segments = segment_membership(dataset, fit_end)
        fit_data = collect_window_data(dataset, 7, fit_origins(fit_end, 7), fold_segments)
        eval_origins = [date.fromisoformat(value) for value in _date_range_origins(eval_start - timedelta(days=1), eval_end - timedelta(days=7))]
        eval_data = collect_window_data(dataset, 7, eval_origins, fold_segments)
        keep = ~fit_data[2]["censoredLabel"].to_numpy()
        pred, _, timing = fit_and_predict(ablation_estimator, ablation_features, 7, (fit_data[0].loc[keep].reset_index(drop=True), fit_data[1][keep]), eval_data[:2], fits, started_cpu)
        ablation["fits"].append({"split": fold_name, "fitRowsBefore": len(fit_data[1]), "fitRowsAfter": int(keep.sum()), "evaluationRows": len(eval_data[1]), "metricsAllEvaluation": joined_metrics(eval_data[1], pred, eval_data[2]), "timing": timing})

    # Freeze/test gates apply to the exact cumulative output that will be served.
    val_data_by_h: dict[int, tuple[Any, np.ndarray, Any]] = {}
    base_val_selected: dict[int, np.ndarray] = {}
    for horizon in PRIMARY_HORIZONS:
        val_data_by_h[horizon] = collect_window_data(dataset, horizon, _origins("validation", horizon), initial_segments)
        baseline_name = model_choices[horizon]["baseline"]
        base_val_selected[horizon] = baseline_predictions[horizon]["allValidation"][baseline_name]

    def validation_coherent_payload() -> tuple[dict[int, Any], dict[int, Any], dict[int, Any]]:
        model_payload = {h: (val_data_by_h[h][1], np.asarray(model_predictions[h]["validationFinal"]), val_data_by_h[h][2]) for h in PRIMARY_HORIZONS}
        base_payload = {h: (val_data_by_h[h][1], base_val_selected[h], val_data_by_h[h][2]) for h in PRIMARY_HORIZONS}
        model_y, model_p, model_meta, _ = align_common_horizon_rows(model_payload)
        base_y, base_p, base_meta, _ = align_common_horizon_rows(base_payload)
        coherent_model, _, _ = coherent_predictions(model_p)
        coherent_base, _, _ = coherent_predictions(base_p)
        model_metrics = {h: joined_metrics(model_y[h], coherent_model[h], model_meta[h]) for h in PRIMARY_HORIZONS}
        baseline_metrics = {h: joined_metrics(base_y[h], coherent_base[h], base_meta[h]) for h in PRIMARY_HORIZONS}
        return model_metrics, baseline_metrics, {h: coherent_model[h] for h in PRIMARY_HORIZONS}

    coherent_validation_gates: dict[int, Any] = {}
    coherent_validation_metrics, coherent_validation_baselines, coherent_validation_predictions = validation_coherent_payload()
    for horizon in PRIMARY_HORIZONS:
        if model_choices[horizon]["candidate"]:
            coherent_validation_gates[horizon] = check_acceptance(
                coherent_validation_metrics[horizon], coherent_validation_baselines[horizon], horizon, initial_top10,
            )
        else:
            coherent_validation_gates[horizon] = {"passed": True, "checks": {"preselectedBaselineFallback": True}}
    failed_ml_horizons = [h for h in PRIMARY_HORIZONS if model_choices[h]["candidate"] and not coherent_validation_gates[h]["passed"]]
    if failed_ml_horizons:
        for horizon in failed_ml_horizons:
            model_choices[horizon]["preTestCoherenceFallbackReason"] = "selected ML/hybrid failed frozen common-origin coherent validation gates"
            model_choices[horizon]["method"] = "BASELINE_FALLBACK"
            model_choices[horizon]["candidate"] = None
            model_choices[horizon]["featureSet"] = None
            model_choices[horizon]["fallbackSegments"] = list(expected_segment_counts)
            model_predictions[horizon]["validationFinal"] = base_val_selected[horizon]
        coherent_validation_metrics, coherent_validation_baselines, coherent_validation_predictions = validation_coherent_payload()
        remaining_failures = []
        for horizon in PRIMARY_HORIZONS:
            if model_choices[horizon]["candidate"]:
                coherent_validation_gates[horizon] = check_acceptance(coherent_validation_metrics[horizon], coherent_validation_baselines[horizon], horizon, initial_top10)
                if not coherent_validation_gates[horizon]["passed"]:
                    remaining_failures.append(horizon)
        if remaining_failures:
            for horizon in PRIMARY_HORIZONS:
                if model_choices[horizon]["candidate"]:
                    model_choices[horizon]["preTestCoherenceFallbackReason"] = "combined cumulative strategy failed validation gates; retain selected baselines for all horizons"
                    model_choices[horizon]["method"] = "BASELINE_FALLBACK"
                    model_choices[horizon]["candidate"] = None
                    model_choices[horizon]["featureSet"] = None
                    model_choices[horizon]["fallbackSegments"] = list(expected_segment_counts)
                    model_predictions[horizon]["validationFinal"] = base_val_selected[horizon]
            coherent_validation_metrics, coherent_validation_baselines, coherent_validation_predictions = validation_coherent_payload()
    for horizon in PRIMARY_HORIZONS:
        model_choices[horizon]["coherentValidationMetrics"] = coherent_validation_metrics[horizon]
        model_choices[horizon]["coherentValidationBaselineMetrics"] = coherent_validation_baselines[horizon]
        model_choices[horizon]["coherentValidationGate"] = coherent_validation_gates[horizon]
        validation_results[horizon]["selectedStrategyCoherentMetrics"] = coherent_validation_metrics[horizon]
        validation_results[horizon]["selectedBaselineCoherentMetrics"] = coherent_validation_baselines[horizon]
        validation_results[horizon]["selectedStrategyCoherentGate"] = coherent_validation_gates[horizon]
        choice = model_choices[horizon]
        if choice["candidate"]:
            choice["hyperparameters"] = candidate_parameters(choice["candidate"])
            choice["selectedFeatures"] = list(FEATURE_SETS[choice["featureSet"]])
        else:
            choice["hyperparameters"] = None
            choice["selectedFeatures"] = []

    # Freeze all development choices before obtaining any TEST target/prediction frame.
    freeze = {
        "state": "FROZEN_TEST_NOT_STARTED",
        "createdAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "baseCommit": git_value("rev-parse", "HEAD"),
        "designCommit": "3d2763722a0977667a8df5c106aa2d5050c14404",
        "codeSha256": {"module": sha256_file(ROOT / "ml/src/v3_forecast.py"), "runner": sha256_file(Path(__file__))},
        "scenarioId": SCENARIO_ID,
        "datasetVersion": DATASET_VERSION,
        "datasetSha256": DATASET_SHA256,
        "featureVersion": FEATURE_VERSION,
        "featureOrder": feature_spec["featureOrder"],
        "featureSetSha256": feature_spec["sha256"],
        "horizons": copy.deepcopy(model_choices),
        "h28": {"model": h28_model_name, "hyperparameters": candidate_parameters(h28_model_name), "features": list(FEATURE_SETS[h28_features]), "baseline": h28_baseline},
        "numpySeed": SEED,
        "estimatorSeed": SEED,
        "trainingCutoffs": {str(h): "2026-06-30" for h in PRIMARY_HORIZONS},
        "preTestRefitCutoff": "2026-08-15",
        "selectedBaselines": {str(h): model_choices[h]["baseline"] for h in PRIMARY_HORIZONS},
        "selectedModelConfigurations": {str(h): {key: model_choices[h].get(key) for key in ("method", "candidate", "featureSet", "selectedFeatures", "hyperparameters", "fallbackSegments")} for h in PRIMARY_HORIZONS},
        "split": {key: [value.isoformat() for value in vals] for key, vals in SPLITS.items()},
        "testProtocol": "test rows/materialization begins only after this freeze; one-shot marker is persisted before fit/prediction",
        "fitCountBeforeTest": fits[0],
    }
    atomic_json(FREEZE_PATH, freeze)
    # Persist the consumed-test marker before materializing any TEST labels or predictions.
    freeze["state"] = "TEST_EXECUTION_STARTED_DO_NOT_RERUN"
    freeze["testStartedAtUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    atomic_json(FREEZE_PATH, freeze)

    test_results: dict[int, Any] = {}
    test_cache: dict[int, tuple[Any, np.ndarray, Any]] = {}
    test_selected_baselines: dict[int, np.ndarray] = {}
    pretest_models: dict[int, Any] = {}
    for horizon in PRIMARY_HORIZONS:
        choice = model_choices[horizon]
        segments_test = segment_membership(dataset, SPLITS["validation"][1])
        test_data = test_rows_after_lock(dataset, horizon, segments_test)
        test_cache[horizon] = test_data
        base_test: dict[str, np.ndarray] = {}
        for baseline in BASELINES:
            base_test[baseline] = actual_baseline(dataset, test_data[2], horizon, baseline)
        baseline_choice = choice["baseline"]
        test_selected_baselines[horizon] = base_test[baseline_choice]
        baseline_metrics_all = {name: joined_metrics(test_data[1], pred, test_data[2]) for name, pred in base_test.items()}
        test_nonoverlap_mask = non_overlapping_rows(test_data[2], horizon)
        for name, pred in base_test.items():
            baseline_metrics_all[name]["nonOverlappingOrigins"] = sorted(test_data[2].loc[test_nonoverlap_mask, "origin"].unique().tolist())
            baseline_metrics_all[name]["nonOverlapping"] = metric_bundle(test_data[1][test_nonoverlap_mask], pred[test_nonoverlap_mask])
        if choice["candidate"]:
            candidate_name = choice["candidate"]
            estimator_name, feature_set = candidate_from_parts(candidate_name)
            train_val_origins = fit_origins(SPLITS["validation"][1], horizon)
            train_val = collect_window_data(dataset, horizon, train_val_origins, initial_segments)
            _, model, timing = fit_and_predict(estimator_name, feature_set, horizon, train_val[:2], test_data[:2], fits, started_cpu)
            pretest_models[horizon] = model
            candidate_raw = apply_nonnegative(model.predict(test_data[0].loc[:, FEATURE_SETS[feature_set]]))
            final = segment_strategy(candidate_raw, base_test[baseline_choice], test_data[2], set(choice["fallbackSegments"]))
            candidate_raw_metrics = joined_metrics(test_data[1], candidate_raw, test_data[2])
            final_metrics = joined_metrics(test_data[1], final, test_data[2])
            final_status = "ML" if not choice["fallbackSegments"] else "HYBRID_ML_BASELINE"
        else:
            candidate_raw, final = None, base_test[baseline_choice]
            candidate_raw_metrics = None
            final_metrics = joined_metrics(test_data[1], final, test_data[2])
            timing = None
            final_status = "BASELINE_FALLBACK"
        selected_base_metrics = baseline_metrics_all[baseline_choice]
        gate = check_acceptance(final_metrics, selected_base_metrics, horizon, initial_top10)
        # Keep TEST outcomes descriptive; do not change the frozen selection based on them.
        test_results[horizon] = {
            "baselineAll": baseline_metrics_all,
            "selectedBaseline": baseline_choice,
            "candidateRaw": candidate_raw_metrics,
            "selectedStrategy": final_status,
            "finalMetrics": final_metrics,
            "relativeWapeImprovement": relative_improvement(selected_base_metrics["overall"]["wape"], final_metrics["overall"]["wape"]),
            "gateResult": gate,
            "timing": timing,
            "nonOverlapping": metric_bundle(test_data[1][non_overlapping_rows(test_data[2], horizon)], final[non_overlapping_rows(test_data[2], horizon)]),
            "nonOverlappingOrigins": sorted(test_data[2].loc[non_overlapping_rows(test_data[2], horizon), "origin"].unique().tolist()),
        }

    # Experimental h28 test: fixed h7-selected configuration; it can never become operational in this phase.
    test28 = test_rows_after_lock(dataset, 28, segment_membership(dataset, SPLITS["validation"][1]))
    base28_test = {name: actual_baseline(dataset, test28[2], 28, name) for name in BASELINES}
    h28_base_metrics = {name: joined_metrics(test28[1], pred, test28[2]) for name, pred in base28_test.items()}
    h28_train_val = collect_window_data(dataset, 28, fit_origins(SPLITS["validation"][1], 28), initial_segments)
    _, h28_pretest_model, h28_pretest_timing = fit_and_predict(h28_estimator, h28_features, 28, h28_train_val[:2], test28[:2], fits, started_cpu)
    h28_pred = apply_nonnegative(h28_pretest_model.predict(test28[0].loc[:, FEATURE_SETS[h28_features]]))
    h28_metrics = joined_metrics(test28[1], h28_pred, test28[2])
    h28_val_baseline_metrics = h28_baseline_candidates[h28_baseline]["metrics"]
    h28_val_gate = check_acceptance(h28_val_metrics, h28_val_baseline_metrics, 28, initial_top10)
    h28_test_gate = check_acceptance(h28_metrics, h28_base_metrics[h28_baseline], 28, initial_top10)
    h28_fold_gains = [item["relativeWapeImprovement"] for item in h28_folds]
    h28_fold_stability = sum(value is not None and value > 0 for value in h28_fold_gains) >= 2 and np.mean([value for value in h28_fold_gains if value is not None]) >= 0 and not any(value is not None and value < -0.10 for value in h28_fold_gains)
    h28_candidate_gates_pass = h28_val_gate["passed"] and h28_test_gate["passed"] and h28_fold_stability
    h28_test = {
        "selectedBaseline": h28_baseline,
        "validationBaselineMetrics": h28_val_baseline_metrics,
        "validationCandidateMetrics": h28_val_metrics,
        "validationGate": h28_val_gate,
        "baselineAll": h28_base_metrics,
        "candidate": h28_model_name,
        "hyperparameters": candidate_parameters(h28_model_name),
        "walkForward": h28_folds,
        "walkForwardStabilityPassed": bool(h28_fold_stability),
        "candidateMetrics": h28_metrics,
        "testGate": h28_test_gate,
        "relativeWapeImprovement": relative_improvement(h28_base_metrics[h28_baseline]["overall"]["wape"], h28_metrics["overall"]["wape"]),
        "independentOriginCount": len(sorted(test28[2]["origin"].unique())[::28]),
        "classification": "EXPERIMENTAL_APPROVED_NOT_OPERATIONAL_INSUFFICIENT_INDEPENDENT_WINDOWS" if h28_candidate_gates_pass else "EXPERIMENTAL_NOT_APPROVED_GATES_FAILED",
        "timing": h28_pretest_timing,
    }

    # Apply the pre-registered cumulative postprocessing to the exact selected strategy.
    # A test-failing horizon may only be rejected in favor of its already frozen
    # validation baseline. Recompute coherence from the same cached test arrays
    # until no further candidate needs rejection; no target/test rows are reloaded.
    for horizon in PRIMARY_HORIZONS:
        choice = model_choices[horizon]
        test_results[horizon]["horizonSpecificRawGateDiagnostic"] = test_results[horizon]["gateResult"]
        test_results[horizon]["selectionAtTest"] = {
            "method": choice["method"], "candidate": choice["candidate"],
            "featureSet": choice["featureSet"], "baseline": choice["baseline"],
            "fallbackSegments": list(choice["fallbackSegments"]),
        }
    final_selected_test: dict[int, np.ndarray] = {}
    final_coherent: dict[int, np.ndarray] = {}
    final_coherent_metrics: dict[int, Any] = {}
    final_coherent_baseline_metrics: dict[int, Any] = {}
    final_coherent_gates: dict[int, Any] = {}
    final_adjustment_count = 0
    final_adjustment_magnitude = 0.0
    rejection_gates: dict[int, Any] = {}
    for _ in range(len(PRIMARY_HORIZONS) + 1):
        test_model_payload: dict[int, tuple[np.ndarray, np.ndarray, Any]] = {}
        test_base_payload: dict[int, tuple[np.ndarray, np.ndarray, Any]] = {}
        for horizon in PRIMARY_HORIZONS:
            test_data = test_cache[horizon]
            choice = model_choices[horizon]
            if choice["candidate"]:
                _, feature_set = candidate_from_parts(choice["candidate"])
                raw = apply_nonnegative(pretest_models[horizon].predict(test_data[0].loc[:, FEATURE_SETS[feature_set]]))
                selected = segment_strategy(raw, test_selected_baselines[horizon], test_data[2], set(choice["fallbackSegments"]))
            else:
                selected = test_selected_baselines[horizon]
            test_model_payload[horizon] = (test_data[1], selected, test_data[2])
            test_base_payload[horizon] = (test_data[1], test_selected_baselines[horizon], test_data[2])
        model_y, model_raw, model_meta, common_keys = align_common_horizon_rows(test_model_payload)
        base_y, base_raw, base_meta, base_keys = align_common_horizon_rows(test_base_payload)
        if common_keys != base_keys:
            raise AssertionError("Selected model/baseline common-origin alignment differs")
        coherent, adjustment_count, adjustment_magnitude = coherent_predictions(model_raw)
        coherent_base, _, _ = coherent_predictions(base_raw)
        rejected_this_round = False
        for horizon in PRIMARY_HORIZONS:
            coherent_metrics = joined_metrics(model_y[horizon], coherent[horizon], model_meta[horizon])
            coherent_baseline_metrics = joined_metrics(base_y[horizon], coherent_base[horizon], base_meta[horizon])
            raw_gate = test_results[horizon]["horizonSpecificRawGateDiagnostic"]
            coherent_gate = check_acceptance(coherent_metrics, coherent_baseline_metrics, horizon, initial_top10) if model_choices[horizon]["candidate"] else {"passed": True, "checks": {"preselectedBaselineFallback": True}}
            final_gate = {
                "passed": bool(raw_gate["passed"] and coherent_gate["passed"]),
                "checks": {"horizonSpecificAllOrigins": raw_gate["passed"], "commonOriginCoherent": coherent_gate["passed"]},
                "horizonSpecificGate": raw_gate, "coherentCommonOriginGate": coherent_gate,
            }
            final_coherent_metrics[horizon] = coherent_metrics
            final_coherent_baseline_metrics[horizon] = coherent_baseline_metrics
            final_coherent_gates[horizon] = final_gate
            if model_choices[horizon]["candidate"] and not final_gate["passed"]:
                rejection_gates[horizon] = final_gate
                model_choices[horizon]["testAcceptanceFailure"] = "sealed test rejected the frozen candidate; retain the validation-selected baseline without tuning"
                model_choices[horizon]["method"] = "BASELINE_FALLBACK"
                model_choices[horizon]["candidate"] = None
                model_choices[horizon]["featureSet"] = None
                model_choices[horizon]["fallbackSegments"] = list(expected_segment_counts)
                model_choices[horizon]["hyperparameters"] = None
                model_choices[horizon]["selectedFeatures"] = []
                rejected_this_round = True
        final_selected_test = {h: payload[1] for h, payload in test_model_payload.items()}
        final_coherent = coherent
        final_adjustment_count = adjustment_count
        final_adjustment_magnitude = adjustment_magnitude
        if not rejected_this_round:
            break
    else:
        raise AssertionError("Candidate rejection did not converge to frozen baselines")

    for horizon in PRIMARY_HORIZONS:
        test_data = test_cache[horizon]
        selected = final_selected_test[horizon]
        mask = non_overlapping_rows(test_data[2], horizon)
        test_results[horizon]["selectedStrategy"] = model_choices[horizon]["method"]
        test_results[horizon]["finalMetrics"] = joined_metrics(test_data[1], selected, test_data[2])
        test_results[horizon]["relativeWapeImprovement"] = relative_improvement(
            test_results[horizon]["baselineAll"][model_choices[horizon]["baseline"]]["overall"]["wape"],
            test_results[horizon]["finalMetrics"]["overall"]["wape"],
        )
        test_results[horizon]["nonOverlapping"] = metric_bundle(test_data[1][mask], selected[mask])
        test_results[horizon]["nonOverlappingOrigins"] = sorted(test_data[2].loc[mask, "origin"].unique().tolist())
        test_results[horizon]["commonOriginCoherentMetrics"] = final_coherent_metrics[horizon]
        test_results[horizon]["commonOriginCoherentBaselineMetrics"] = final_coherent_baseline_metrics[horizon]
        test_results[horizon]["commonOriginCoherentGate"] = final_coherent_gates[horizon]["coherentCommonOriginGate"]
        test_results[horizon]["gateResult"] = final_coherent_gates[horizon] if model_choices[horizon]["candidate"] else {
            "passed": True, "checks": {"frozenBaselineFallback": True},
            "rejectedCandidateGate": rejection_gates.get(horizon),
        }
    n_predictions = sum(len(cache[1]) for cache in test_cache.values())
    for horizon in PRIMARY_HORIZONS:
        val_data = collect_window_data(dataset, horizon, _origins("validation", horizon), initial_segments)
        selected_pred = model_predictions[horizon]["validationFinal"]
        validation_results[horizon]["selectedStrategyMetrics"] = joined_metrics(val_data[1], selected_pred, val_data[2])
        validation_results[horizon]["relativeWapeImprovement"] = relative_improvement(
            validation_results[horizon]["baselineCandidates"][model_choices[horizon]["baseline"]]["overall"]["wape"],
            validation_results[horizon]["selectedStrategyMetrics"]["overall"]["wape"],
        )

    # Build compact diagnostics and holdout summaries after the single sealed pass.
    data_quality = {
        "targetZeroRatio": sum(row["unitsSold"] == 0 for series in dataset.daily_by_sku.values() for row in series) / full_day_rows,
        "observableCensorProxyRatio": sum(row["availableHours"] <= 7.5 for series in dataset.daily_by_sku.values() for row in series) / full_day_rows,
        "latentStockoutRatioDiagnosticOnly": sum(bool(row.get("stockoutFlag")) for series in dataset.daily_by_sku.values() for row in series) / full_day_rows,
        "promotionDayRatioFromCalendarRows": sum(bool(row.get("promotionOccurred")) for series in dataset.daily_by_sku.values() for row in series) / full_day_rows,
        "segmentsTrainOnly": actual_segment_counts,
        "categorySkuCount": {category: sum(product["categoryCode"] == category for product in dataset.products) for category in sorted({product["categoryCode"] for product in dataset.products})},
    }
    sku_audit: dict[str, Any] = {}
    error_examples: dict[str, Any] = {}
    for horizon in PRIMARY_HORIZONS:
        choice = model_choices[horizon]
        test_data = test_cache[horizon]
        if choice["candidate"]:
            _, set_name = candidate_from_parts(choice["candidate"])
            raw = apply_nonnegative(pretest_models[horizon].predict(test_data[0].loc[:, FEATURE_SETS[set_name]]))
            pred = segment_strategy(raw, actual_baseline(dataset, test_data[2], horizon, choice["baseline"]), test_data[2], set(choice["fallbackSegments"]))
        else:
            pred = actual_baseline(dataset, test_data[2], horizon, choice["baseline"])
        metrics = joined_metrics(test_data[1], pred, test_data[2])
        sku_rows = metrics["sku"]
        sku_audit[horizon] = {"bestByMae": sorted(sku_rows, key=lambda item: (item["mae"], item["sku"]))[:10], "worstByMae": sorted(sku_rows, key=lambda item: (-item["mae"], item["sku"]))[:10], "bestByWape": sorted([row for row in sku_rows if row["wape"] is not None], key=lambda item: (item["wape"], item["sku"]))[:10], "worstByWape": sorted([row for row in sku_rows if row["wape"] is not None], key=lambda item: (-item["wape"], item["sku"]))[:10]}
        residual = pred - test_data[1]
        sorted_indices = np.argsort(np.abs(residual))
        intermittent = np.flatnonzero(test_data[2]["segment"].to_numpy() == "intermittent")
        difficult_intermittent = int(intermittent[np.argmax(np.abs(residual[intermittent]))]) if len(intermittent) else int(sorted_indices[-1])
        interesting = [int(sorted_indices[0]), int(sorted_indices[-1]), int(np.argmin(residual)), int(np.argmax(residual)), difficult_intermittent]
        error_examples[horizon] = [{"sku": test_data[2].iloc[i]["sku"], "origin": test_data[2].iloc[i]["origin"], "actualUnits": float(test_data[1][i]), "predictedUnits": float(pred[i]), "errorPredictedMinusActual": float(residual[i]), "segment": test_data[2].iloc[i]["segment"]} for i in dict.fromkeys(interesting)]

    artifact_fit_log: list[dict[str, Any]] = []
    final_models: dict[int, Any] = {}
    for horizon in PRIMARY_HORIZONS:
        choice = model_choices[horizon]
        if choice["candidate"]:
            est_name, set_name = candidate_from_parts(choice["candidate"])
            train_full = collect_window_data(dataset, horizon, fit_origins(HISTORY_END, horizon), segment_membership(dataset, HISTORY_END))
            _, final_model, timing = fit_and_predict(
                est_name, set_name, horizon, train_full[:2],
                (train_full[0].iloc[:80], train_full[1][:80]), fits, started_cpu,
            )
            ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
            model_path = ARTIFACT_DIR / f"h{horizon}.joblib"
            joblib.dump(final_model, model_path, compress=3)
            final_models[horizon] = final_model
            choice["trainedThrough"] = HISTORY_END.isoformat()
            artifact_fit_log.append({"horizon": horizon, **timing, "trainingExamples": len(train_full[1]), "trainedThrough": HISTORY_END.isoformat()})
        else:
            model_path = None
        choice["artifactModelFile"] = model_path.name if model_path else None

    reproducibility: dict[str, Any] = {"status": "NOT_APPLICABLE_NO_ACCEPTED_ML_MODEL"}
    if final_models:
        reproducibility_horizon = 7 if 7 in final_models else min(final_models)
        choice = model_choices[reproducibility_horizon]
        estimator_name, feature_set = candidate_from_parts(choice["candidate"])
        reproducibility_train = collect_window_data(dataset, reproducibility_horizon, fit_origins(HISTORY_END, reproducibility_horizon), segment_membership(dataset, HISTORY_END))
        probe_x = reproducibility_train[0].iloc[:160]
        probe_y = reproducibility_train[1][:160]
        baseline_probe = apply_nonnegative(final_models[reproducibility_horizon].predict(probe_x.loc[:, FEATURE_SETS[feature_set]]))
        _, repeated_model, repeat_timing = fit_and_predict(
            estimator_name, feature_set, reproducibility_horizon,
            reproducibility_train[:2], (probe_x, probe_y), fits, started_cpu,
        )
        repeated_probe = apply_nonnegative(repeated_model.predict(probe_x.loc[:, FEATURE_SETS[feature_set]]))
        max_abs_delta = float(np.max(np.abs(baseline_probe - repeated_probe)))
        max_rel_delta = float(np.max(np.abs(baseline_probe - repeated_probe) / np.maximum(np.abs(baseline_probe), 1.0)))
        if not np.allclose(baseline_probe, repeated_probe, rtol=1e-8, atol=1e-10):
            raise RuntimeError("Deterministic refit exceeded the approved reproducibility tolerance")
        reproducibility = {
            "status": "PASS", "horizon": reproducibility_horizon,
            "probeRows": len(probe_y), "sameSeedAndConfig": True,
            "maxAbsolutePredictionDelta": max_abs_delta,
            "maxRelativePredictionDelta": max_rel_delta,
            "repeatFit": repeat_timing,
        }

    inference_started = time.perf_counter()
    batch_preview = predict_forecast_batch(
        dataset, prediction_origin=HISTORY_END,
        skus=sorted(dataset.product_by_sku), strategy_by_horizon=model_choices,
        models=final_models, model_version=MODEL_VERSION,
    )
    batch_inference_ms = round((time.perf_counter() - inference_started) * 1000, 3)
    if len(batch_preview) != 80 or any(item.get("status") != "READY" for item in batch_preview):
        raise RuntimeError("Local 80-SKU batch contract smoke failed")
    prediction_smoke = {
        "skuCount": len(batch_preview), "statusCounts": {"READY": sum(item["status"] == "READY" for item in batch_preview)},
        "latencyMs": batch_inference_ms, "target": "<1000ms engineering target; no cloud/network",
        "horizonsMonotonic": all(item["forecast"]["expectedUnitsNext1d"] <= item["forecast"]["expectedUnitsNext7d"] <= item["forecast"]["expectedUnitsNext14d"] for item in batch_preview),
    }
    test_results["28"] = h28_test
    test_results["coherence"] = {
        "sameOriginSkuCount": len(common_keys), "adjustedValuesCount": final_adjustment_count,
        "adjustedMagnitudeRelativeToRawPredictionSum": final_adjustment_magnitude,
        "rule": "p7=max(p1,p7); p14=max(p7,p14)", "metrics": final_coherent_metrics,
    }
    rss_sampler.__exit__()
    report = {
        "phase": "M6.5B", "scenarioId": SCENARIO_ID, "datasetVersion": DATASET_VERSION,
        "datasetSha256": DATASET_SHA256, "dailyFileSha256": sha256_file(ROOT / "data/minimarket-pasco-v3/generated/product-daily.ndjson"),
        "featureVersion": FEATURE_VERSION, "featureContract": feature_spec,
        "datasetIntegrity": {"products": len(dataset.products), "productDays": full_day_rows, "daysPerSku": 365, "target": "unitsSold", "targetRange": [0, max(row["unitsSold"] for series in dataset.daily_by_sku.values() for row in series)]},
        "dataQuality": data_quality,
        "splitOrigins": {str(h): {split: {"origins": len(_origins(split, h)), "examples": len(_origins(split, h)) * len(dataset.products), "firstOrigin": _origins(split, h)[0].isoformat(), "lastOrigin": _origins(split, h)[-1].isoformat()} for split in ("train", "validation", "test")} for h in HORIZONS},
        "folds": [{"fold": name, "fitLabelsEnd": fit.isoformat(), "evaluationLabels": [start.isoformat(), end.isoformat()]} for name, fit, start, end in FOLDS],
        "initialSegments": actual_segment_counts,
        "initialTop10TrainRevenueSkus": initial_top10,
        "categoryNames": {row["code"]: row["name"] for row in read_ndjson(ROOT / "data/minimarket-pasco-v3/generated/categories.ndjson")},
        "baselinesAndCandidates": validation_results,
        "foldStrategyResults": fold_results,
        "selectedStrategyByHorizon": model_choices,
        "censoringAblationH7": ablation,
        "test": test_results,
        "skuAudit": sku_audit,
        "errorExamples": error_examples,
        "preTestFreeze": freeze,
        "fitCount": fits[0],
        "fitLog": fit_log,
        "finalArtifactFitLog": artifact_fit_log,
        "reproducibility": reproducibility,
        "predictionContractSmoke": prediction_smoke,
        "runtime": {"wallSeconds": round(time.perf_counter() - started_wall, 3), "cpuSeconds": round(time.process_time() - started_cpu, 3), "peakRssBytes": max(peak_rss, rss_sampler.peak, process.memory_info().rss), "peakRssMb": round(max(peak_rss, rss_sampler.peak, process.memory_info().rss) / (1024**2), 2), "maxFits": MAX_FITS, "maxCpuSeconds": MAX_CPU_SECONDS, "maxRssBytes": MAX_RSS_BYTES, "threads": 2},
        "artifact": None,
    }
    fitted_files = sorted(ARTIFACT_DIR.glob("*.joblib")) if ARTIFACT_DIR.exists() else []
    if fitted_files:
        artifact_manifest = {
            "scenarioId": SCENARIO_ID, "datasetVersion": DATASET_VERSION, "datasetSha256": DATASET_SHA256,
            "configSha256": dataset.manifest.get("configSha256"),
            "generatorVersion": dataset.manifest.get("generatorVersion"),
            "featureVersion": FEATURE_VERSION, "featureContractSha256": feature_spec["sha256"], "modelVersion": MODEL_VERSION,
            "cutoffDate": HISTORY_END.isoformat(), "timezone": "America/Lima", "targetDefinition": "effective_units_sold_cumulative_t_plus_1_through_t_plus_h",
            "horizonStrategy": model_choices, "seed": SEED, "python": sys.version, "numpy": np.__version__,
            "sklearn": __import__("sklearn").__version__, "codeCommitBase": git_value("rev-parse", "HEAD"),
            "designCommit": freeze["designCommit"], "codeSha256": freeze["codeSha256"], "predictionInterval": None, "confidence": None,
            "files": {path.name: {"bytes": path.stat().st_size, "sha256": sha256_file(path)} for path in fitted_files},
            "trainingCutoff": "2026-10-12", "qualityScope": "local synthetic operational scenario; not actual market validation",
            "timezonePolicy": "America/Lima local closed-day origin; cutoff is exclusive next-day 00:00 local",
            "segmentDefinition": {
                "very_low": "train mean < 0.5 units/day",
                "intermittent": "mean >= 0.5 and zero-sales ratio >= 0.5",
                "high_stable": "mean >= 3, zero-sales ratio < 0.5, population CV <= 1",
                "medium": "remaining SKUs",
                "statisticsFitThrough": "2026-06-30 for frozen audit segments; serving re-evaluates from history through cutoff",
            },
            "featureContract": feature_spec,
            "inputHashes": dataset.manifest.get("hashes", {}).get("files", {}),
            "modelScope": "one global model per accepted direct horizon; no per-SKU models",
            "reportReference": "ml/.test-tmp/m6_5b_v3/benchmark-results.json",
            "testProtocol": "single sealed test pass; no tuning or retraining from test outcomes",
            "modelCard": {
                "scope": "forecast evaluated on the synthetic operational Minimarket Pasco V3 scenario",
                "notValidatedFor": ["real Cerro de Pasco sales", "causal effects", "probabilistic confidence", "inventory/order recommendations"],
                "predictionInterval": None, "confidence": None,
            },
        }
        atomic_json(ARTIFACT_DIR / "manifest.json", artifact_manifest)
        verified_models = load_verified_v3_models(ARTIFACT_DIR, artifact_manifest)
        roundtrip = predict_forecast_batch(
            dataset, prediction_origin=HISTORY_END,
            skus=sorted(dataset.product_by_sku), strategy_by_horizon=model_choices,
            models=verified_models, model_version=MODEL_VERSION,
        )
        roundtrip_deltas = []
        for expected, actual in zip(batch_preview, roundtrip):
            for horizon in PRIMARY_HORIZONS:
                key = f"expectedUnitsNext{horizon}d"
                roundtrip_deltas.append(abs(expected["forecast"][key] - actual["forecast"][key]))
        max_roundtrip_delta = max(roundtrip_deltas, default=0.0)
        if max_roundtrip_delta > 1e-10:
            raise RuntimeError("Verified V3 artifact round-trip differs from in-memory batch predictions")
        report["predictionContractSmoke"]["artifactRoundTrip"] = {
            "status": "PASS", "skuCount": len(roundtrip), "maxAbsolutePredictionDelta": max_roundtrip_delta,
        }
        report["artifact"] = {
            "directory": str(ARTIFACT_DIR.relative_to(ROOT)), "manifest": artifact_manifest,
            "manifestSha256": sha256_file(ARTIFACT_DIR / "manifest.json"),
            "totalBytes": sum(path.stat().st_size for path in fitted_files),
            "artifactFiles": {path.name: {"bytes": path.stat().st_size, "sha256": sha256_file(path)} for path in fitted_files},
        }
    freeze["state"] = "TEST_EXECUTION_COMPLETE_NO_RETUNING"
    freeze["testCompletedAtUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    freeze["totalFitCount"] = fits[0]
    atomic_json(FREEZE_PATH, freeze)
    atomic_json(REPORT_PATH, report)
    print(json.dumps({"state": freeze["state"], "freeze": str(FREEZE_PATH.relative_to(ROOT)), "report": str(REPORT_PATH.relative_to(ROOT)), "fitCount": fits[0], "runtime": report["runtime"], "artifact": report["artifact"]}, indent=2))


def _date_range_origins(first: date, last: date) -> list[str]:
    if first > last:
        return []
    return [(first + timedelta(days=i)).isoformat() for i in range((last - first).days + 1)]


if __name__ == "__main__":
    if Path(__file__).resolve().parents[2] != ROOT:
        raise RuntimeError("Unexpected repository root")
    run_benchmark()
