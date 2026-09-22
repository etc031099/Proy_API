from __future__ import annotations

import argparse
import csv
import gc
import json
import os
import pickle
import platform
import sys
import time
import tomllib
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import psutil
import sklearn
from sklearn.compose import ColumnTransformer, TransformedTargetRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from ml.src.common import PeakMemoryMonitor, atomic_write_json, repository_path, utc_now
from ml.src.m5 import connect_duckdb
from ml.src.training.metrics import (
    RMSSE_SCALE_DEFINITION,
    clip_predictions,
    metric_bundle,
    rotation_class,
    rotation_thresholds,
    zero_target_metrics,
)


DEFAULT_CONFIG = "ml/config/training_v1.toml"
TARGET = "target_units_next_7_days"
CATEGORICAL_FEATURES = [
    "cat_id", "dept_id", "event_name_1", "event_type_1",
    "event_name_2", "event_type_2",
]
EXPECTED_TRAIN_ROWS = 4_010_863
EXPECTED_VALIDATION_ROWS = 255_756
LOG_FIELDS = [
    "experiment_id", "executed_at_utc", "model", "target_transform",
    "parameters_json", "sample_policy", "random_state", "evaluation_split",
    "evaluation_rows", "train_rows", "validation_rows", "feature_set_version", "gold_logical_hash",
    "fit_seconds", "predict_seconds", "peak_rss_bytes",
    "model_size_estimate_bytes", "wape", "mae", "rmsse",
    "negative_predictions_before_clip", "status", "notes",
]


def load_configuration(path: str | Path = DEFAULT_CONFIG) -> dict[str, Any]:
    with repository_path(path).open("rb") as stream:
        return tomllib.load(stream)


def load_contract(config: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    manifest_path = repository_path(config["paths"]["manifest"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = config["experiment"]
    if manifest["feature_set_version"] != expected["feature_set_version"]:
        raise RuntimeError("Unexpected Gold feature_set_version")
    if manifest["logical_hash"] != expected["gold_logical_hash"]:
        raise RuntimeError("Unexpected Gold logical_hash")
    features = list(manifest["features"])
    if len(features) != 31 or set(CATEGORICAL_FEATURES) - set(features):
        raise RuntimeError("Unexpected demand-v1 feature contract")
    forbidden = set(manifest["identifier_columns"] + manifest["metadata_columns"] + [TARGET])
    if set(features) & forbidden:
        raise RuntimeError("Feature contract contains identifiers, metadata or target")
    return manifest, features


def _quoted(names: list[str]) -> str:
    return ", ".join('"' + name.replace('"', '""') + '"' for name in names)


def load_split(gold: Path, split: str, features: list[str], *, metadata: bool) -> tuple[pd.DataFrame, np.ndarray, pd.DataFrame | None]:
    if split not in {"train", "validation"}:
        raise ValueError("ML-R4B.1 permits only train and validation")
    extra = ["item_id", "source_date"] if metadata else []
    selected = features + [TARGET] + extra
    connection = connect_duckdb()
    try:
        frame = connection.execute(
            f"SELECT {_quoted(selected)} FROM read_parquet(?) WHERE split = ? ORDER BY item_id, source_date",
            [str(gold), split],
        ).fetch_df()
    finally:
        connection.close()
    target = frame.pop(TARGET).to_numpy(dtype=np.float32, copy=False)
    metadata_frame = None
    if metadata:
        metadata_frame = frame[["item_id", "source_date"]].copy()
        frame.drop(columns=["item_id", "source_date"], inplace=True)
    numeric = [name for name in features if name not in CATEGORICAL_FEATURES]
    for name in numeric:
        frame[name] = frame[name].astype(np.float32, copy=False)
    for name in CATEGORICAL_FEATURES:
        frame[name] = frame[name].astype("category")
    return frame, target, metadata_frame


def build_preprocessor(features: list[str]) -> ColumnTransformer:
    numeric = [name for name in features if name not in CATEGORICAL_FEATURES]
    return ColumnTransformer(
        transformers=[
            ("numeric", StandardScaler(with_mean=False), numeric),
            (
                "categorical",
                OneHotEncoder(
                    handle_unknown="ignore", sparse_output=True, dtype=np.float32
                ),
                CATEGORICAL_FEATURES,
            ),
        ],
        sparse_threshold=1.0,
        verbose_feature_names_out=False,
    )


def build_ridge(alpha: float) -> Ridge:
    return Ridge(alpha=alpha, solver="lsqr", fit_intercept=True, tol=1e-3, max_iter=500)


def build_ridge_pipeline(features: list[str], alpha: float) -> Pipeline:
    return Pipeline([("preprocessing", build_preprocessor(features)), ("estimator", build_ridge(alpha))])


def train_item_statistics(gold: Path) -> pd.DataFrame:
    connection = connect_duckdb()
    try:
        return connection.execute(
            """
            WITH ordered AS (
              SELECT item_id, source_date, current_units, target_units_next_7_days,
                     lag(source_date) OVER w AS prior_date,
                     lag(target_units_next_7_days) OVER w AS prior_target
              FROM read_parquet(?) WHERE split = 'train'
              WINDOW w AS (PARTITION BY item_id ORDER BY source_date)
            )
            SELECT item_id, avg(current_units) AS mean_daily_units,
                   avg(CASE WHEN date_diff('day', prior_date, source_date) = 1
                       THEN pow(target_units_next_7_days - prior_target, 2) END) AS rmsse_scale
            FROM ordered GROUP BY item_id ORDER BY item_id
            """,
            [str(gold)],
        ).fetch_df()
    finally:
        connection.close()


def previous_week_baseline(gold: Path, bronze: Path) -> np.ndarray:
    connection = connect_duckdb()
    try:
        values = connection.execute(
            """
            WITH history AS (
              SELECT item_id, source_date,
                     sum(units_sold) OVER (
                       PARTITION BY item_id ORDER BY source_date
                       ROWS BETWEEN 13 PRECEDING AND 7 PRECEDING
                     ) AS previous_week
              FROM read_parquet(?)
            ), validation_keys AS (
              SELECT item_id, source_date FROM read_parquet(?)
              WHERE split = 'validation'
            )
            SELECT h.previous_week FROM validation_keys v
            JOIN history h USING (item_id, source_date)
            ORDER BY v.item_id, v.source_date
            """,
            [str(bronze), str(gold)],
        ).fetchnumpy()["previous_week"].astype(np.float32, copy=False)
    finally:
        connection.close()
    if len(values) != EXPECTED_VALIDATION_ROWS or not np.isfinite(values).all():
        raise RuntimeError("Could not derive complete previous-week validation baseline")
    return values


def direct_baselines(validation: pd.DataFrame) -> dict[str, np.ndarray]:
    return {
        "zero": np.zeros(len(validation), dtype=np.float32),
        "last7": validation["rolling_sum_7"].to_numpy(dtype=np.float32, copy=False),
        "four_week_average": (
            7.0 * validation["rolling_mean_28"].to_numpy(dtype=np.float32, copy=False)
        ),
    }


def attach_segments(metadata: pd.DataFrame, item_statistics: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, float]]:
    stats = item_statistics.set_index("item_id")
    low, high = rotation_thresholds(stats["mean_daily_units"].to_numpy())
    metadata = metadata.copy()
    metadata["mean_daily_units"] = metadata["item_id"].map(stats["mean_daily_units"])
    metadata["rmsse_scale"] = metadata["item_id"].map(stats["rmsse_scale"])
    metadata["cold_start"] = metadata["mean_daily_units"].isna()
    metadata["rotation_class"] = metadata["mean_daily_units"].map(
        lambda value: "cold_start" if pd.isna(value) else rotation_class(value, low, high)
    )
    metadata["low_demand"] = metadata["mean_daily_units"].le(1.0).fillna(False)
    return metadata, {"q33": low, "q67": high, "low_demand_max_mean_daily_units": 1.0}


def _clean_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _clean_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean_json(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return None if not np.isfinite(value) else float(value)
    return value


def segment_report(actual: np.ndarray, prediction: np.ndarray, metadata: pd.DataFrame, categories: pd.DataFrame) -> dict[str, Any]:
    frame = metadata.copy()
    frame["cat_id"] = categories["cat_id"].astype(str).to_numpy()
    frame["dept_id"] = categories["dept_id"].astype(str).to_numpy()
    frame["actual"] = actual
    frame["prediction"] = prediction
    report: dict[str, Any] = {}
    for column in ["cat_id", "dept_id", "rotation_class", "low_demand", "cold_start"]:
        groups: dict[str, Any] = {}
        for value, group in frame.groupby(column, observed=True, dropna=False):
            indexes = group.index.to_numpy()
            groups[str(value)] = {
                "rows": len(indexes),
                "items": int(group["item_id"].nunique()),
                **metric_bundle(actual[indexes], prediction[indexes], group["rmsse_scale"].to_numpy()),
            }
        report[column] = groups
    report["target_zero"] = zero_target_metrics(actual, prediction)
    return _clean_json(report)


def model_size_estimate(estimator: Any, preprocessor: ColumnTransformer) -> int:
    return len(
        pickle.dumps(
            {"preprocessing": preprocessor, "estimator": estimator},
            protocol=pickle.HIGHEST_PROTOCOL,
        )
    )


def write_experiment_log(path: Path, new_rows: list[dict[str, Any]]) -> None:
    existing: list[dict[str, Any]] = []
    if path.exists():
        with path.open("r", encoding="utf-8", newline="") as stream:
            existing = list(csv.DictReader(stream))
    identifiers = {row["experiment_id"] for row in new_rows}
    rows = [row for row in existing if row.get("experiment_id") not in identifiers] + new_rows
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=LOG_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temporary, path)


def run_training(config_path: str | Path = DEFAULT_CONFIG) -> dict[str, Any]:
    config = load_configuration(config_path)
    manifest, features = load_contract(config)
    gold = repository_path(config["paths"]["gold"])
    bronze = repository_path(config["paths"]["bronze"])
    report_path = repository_path(config["paths"]["experiments"])
    segments_directory = repository_path(config["paths"]["segments_directory"])
    maximum_rss = int(config["memory"]["maximum_rss_bytes"])
    random_state = int(config["experiment"]["random_state"])
    monitor = PeakMemoryMonitor()
    monitor.__enter__()
    experiments: list[dict[str, Any]] = []
    segment_files: dict[str, str] = {}
    try:
        train, y_train, _ = load_split(gold, "train", features, metadata=False)
        validation, y_validation, validation_metadata = load_split(gold, "validation", features, metadata=True)
        if len(train) != EXPECTED_TRAIN_ROWS or len(validation) != EXPECTED_VALIDATION_ROWS:
            raise RuntimeError("Unexpected TRAIN or VALIDATION row count")
        item_statistics = train_item_statistics(gold)
        validation_metadata, thresholds = attach_segments(validation_metadata, item_statistics)
        scales = validation_metadata["rmsse_scale"].to_numpy(dtype=np.float64)

        baseline_values = direct_baselines(validation)
        baseline_values["previous_week"] = previous_week_baseline(gold, bronze)
        for name, raw_prediction in baseline_values.items():
            prediction, negatives = clip_predictions(raw_prediction)
            metrics = metric_bundle(y_validation, prediction, scales)
            experiment_id = f"r4b1_baseline_{name}"
            segment_path = segments_directory / f"{experiment_id}.json"
            atomic_write_json(segment_path, segment_report(y_validation, prediction, validation_metadata, validation))
            segment_files[experiment_id] = str(segment_path)
            experiments.append({
                "experiment_id": experiment_id, "executed_at_utc": utc_now(),
                "model": f"baseline_{name}", "target_transform": "none",
                "parameters_json": "{}", "sample_policy": "full_validation",
                "random_state": random_state, "train_rows": len(train),
                "validation_rows": len(validation), "feature_set_version": manifest["feature_set_version"],
                "gold_logical_hash": manifest["logical_hash"], "fit_seconds": 0.0,
                "predict_seconds": 0.0, "peak_rss_bytes": monitor.peak_rss_bytes,
                "model_size_estimate_bytes": 0, **metrics,
                "negative_predictions_before_clip": negatives, "status": "completed",
                "notes": RMSSE_SCALE_DEFINITION,
            })

        preprocessing = build_preprocessor(features)
        transform_started = time.perf_counter()
        x_train = preprocessing.fit_transform(train)
        x_validation = preprocessing.transform(validation)
        preprocessing_seconds = time.perf_counter() - transform_started
        if not hasattr(x_train, "tocsr") or not hasattr(x_validation, "tocsr"):
            raise RuntimeError("Preprocessing unexpectedly densified the feature matrix")
        x_train = x_train.tocsr().astype(np.float32, copy=False)
        x_validation = x_validation.tocsr().astype(np.float32, copy=False)
        del train
        gc.collect()
        if psutil.Process().memory_info().rss >= maximum_rss:
            raise MemoryError("RSS reached the configured 12 GiB safety limit")

        ridge_results: list[tuple[float, float]] = []
        best_alpha = None
        best_wape = float("inf")
        for alpha in config["ridge"]["alphas"]:
            estimator = build_ridge(float(alpha))
            fit_started = time.perf_counter()
            estimator.fit(x_train, y_train)
            fit_seconds = time.perf_counter() - fit_started
            predict_started = time.perf_counter()
            raw_prediction = estimator.predict(x_validation)
            predict_seconds = time.perf_counter() - predict_started
            prediction, negatives = clip_predictions(raw_prediction)
            metrics = metric_bundle(y_validation, prediction, scales)
            experiment_id = f"r4b1_ridge_alpha_{str(alpha).replace('.', '_')}_direct"
            segment_path = segments_directory / f"{experiment_id}.json"
            atomic_write_json(segment_path, segment_report(y_validation, prediction, validation_metadata, validation))
            segment_files[experiment_id] = str(segment_path)
            experiments.append({
                "experiment_id": experiment_id, "executed_at_utc": utc_now(), "model": "ridge",
                "target_transform": "none", "parameters_json": json.dumps({"alpha": alpha, "solver": "lsqr", "tol": 1e-3, "max_iter": 500}),
                "sample_policy": "full_train", "random_state": random_state,
                "train_rows": len(y_train), "validation_rows": len(y_validation),
                "feature_set_version": manifest["feature_set_version"], "gold_logical_hash": manifest["logical_hash"],
                "fit_seconds": round(fit_seconds, 3), "predict_seconds": round(predict_seconds, 3),
                "peak_rss_bytes": monitor.peak_rss_bytes,
                "model_size_estimate_bytes": model_size_estimate(estimator, preprocessing),
                **metrics, "negative_predictions_before_clip": negatives, "status": "completed",
                "notes": f"preprocessing_fit_transform_seconds={preprocessing_seconds:.3f}; {RMSSE_SCALE_DEFINITION}",
            })
            ridge_results.append((float(alpha), metrics["wape"]))
            if metrics["wape"] < best_wape:
                best_wape, best_alpha = metrics["wape"], float(alpha)
            del estimator, raw_prediction, prediction
            gc.collect()

        log_estimator = TransformedTargetRegressor(
            regressor=build_ridge(best_alpha), func=np.log1p, inverse_func=np.expm1,
            # Float32 round-off makes sklearn's exact inverse check noisy; the
            # round-trip behavior is covered explicitly by unit tests.
            check_inverse=False,
        )
        fit_started = time.perf_counter()
        log_estimator.fit(x_train, y_train)
        fit_seconds = time.perf_counter() - fit_started
        predict_started = time.perf_counter()
        raw_prediction = log_estimator.predict(x_validation)
        predict_seconds = time.perf_counter() - predict_started
        prediction, negatives = clip_predictions(raw_prediction)
        metrics = metric_bundle(y_validation, prediction, scales)
        experiment_id = f"r4b1_ridge_alpha_{str(best_alpha).replace('.', '_')}_log1p"
        segment_path = segments_directory / f"{experiment_id}.json"
        atomic_write_json(segment_path, segment_report(y_validation, prediction, validation_metadata, validation))
        segment_files[experiment_id] = str(segment_path)
        experiments.append({
            "experiment_id": experiment_id, "executed_at_utc": utc_now(), "model": "ridge",
            "target_transform": "log1p", "parameters_json": json.dumps({"alpha": best_alpha, "solver": "lsqr", "tol": 1e-3, "max_iter": 500}),
            "sample_policy": "full_train", "random_state": random_state,
            "train_rows": len(y_train), "validation_rows": len(y_validation),
            "feature_set_version": manifest["feature_set_version"], "gold_logical_hash": manifest["logical_hash"],
            "fit_seconds": round(fit_seconds, 3), "predict_seconds": round(predict_seconds, 3),
            "peak_rss_bytes": monitor.peak_rss_bytes,
            "model_size_estimate_bytes": model_size_estimate(log_estimator, preprocessing),
            **metrics, "negative_predictions_before_clip": negatives, "status": "completed",
            "notes": RMSSE_SCALE_DEFINITION,
        })
    finally:
        monitor.__exit__(None, None, None)

    write_experiment_log(report_path, experiments)
    summary = {
        "status": "completed", "test_accessed": False,
        "train_rows": EXPECTED_TRAIN_ROWS, "validation_rows": EXPECTED_VALIDATION_ROWS,
        "rmsse_scale_definition": RMSSE_SCALE_DEFINITION,
        "rotation_thresholds": thresholds,
        "best_direct_alpha": best_alpha,
        "experiments": experiments,
        "segments": segment_files,
        "peak_rss_bytes": monitor.peak_rss_bytes,
        "library_versions": {"python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__, "scikit_learn": sklearn.__version__},
    }
    return _clean_json(summary)


def main() -> int:
    parser = argparse.ArgumentParser(description="Train demand-v1 baselines and Ridge on TRAIN only")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    arguments = parser.parse_args()
    try:
        print(json.dumps(run_training(arguments.config), indent=2))
    except (FileNotFoundError, MemoryError, RuntimeError, ValueError) as error:
        print(f"ML-R4B.1 failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
