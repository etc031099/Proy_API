from __future__ import annotations

import argparse
import gc
import json
import os
import platform
import sys
import time
from pathlib import Path
from typing import Any

import duckdb
import joblib
import numpy as np
import pandas as pd
import psutil
import scipy
import sklearn
from sklearn.pipeline import Pipeline

from ml.src.common import (
    PeakMemoryMonitor,
    atomic_write_json,
    repository_path,
    sha256_file,
    utc_now,
)
from ml.src.inference.demand_v1 import (
    build_feature_contract,
    predict_demand7d,
    validate_and_order_features,
)
from ml.src.m5 import connect_duckdb
from ml.src.training.train_hgb_sample import build_hgb, build_hgb_preprocessor
from ml.src.training.train_ridge import (
    CATEGORICAL_FEATURES,
    DEFAULT_CONFIG,
    EXPECTED_TRAIN_ROWS,
    EXPECTED_VALIDATION_ROWS,
    TARGET,
    _quoted,
    load_configuration,
    load_contract,
)


REFIT_SPLITS = ("train", "validation")
EXPECTED_REFIT_ROWS = EXPECTED_TRAIN_ROWS + EXPECTED_VALIDATION_ROWS
EXPECTED_TEST_ROWS_METADATA_ONLY = 255_989
MODEL_PATH = "ml/models/demand_forecast_v1.joblib"
METADATA_PATH = "ml/models/model_metadata.json"
CONTRACT_PATH = "ml/models/demand_forecast_v1_contract.json"
FINAL_REPORT_PATH = "ml/reports/ml_r4_final_evaluation.json"
TEST_ACCESS_PATH = "ml/reports/ml_r4_test_access.json"


def load_refit_data(
    gold: Path, features: list[str]
) -> tuple[pd.DataFrame, np.ndarray, dict[str, int]]:
    selected = features + [TARGET]
    connection = connect_duckdb()
    try:
        frame = connection.execute(
            f"""
            SELECT {_quoted(selected)}
            FROM read_parquet(?)
            WHERE split IN (?, ?)
            ORDER BY item_id, source_date
            """,
            [str(gold), *REFIT_SPLITS],
        ).fetch_df()
        counts = dict(
            connection.execute(
                """
                SELECT split, count(*)::BIGINT
                FROM read_parquet(?)
                WHERE split IN (?, ?)
                GROUP BY split
                """,
                [str(gold), *REFIT_SPLITS],
            ).fetchall()
        )
    finally:
        connection.close()
    expected_counts = {
        "train": EXPECTED_TRAIN_ROWS,
        "validation": EXPECTED_VALIDATION_ROWS,
    }
    if counts != expected_counts or len(frame) != EXPECTED_REFIT_ROWS:
        raise RuntimeError(f"Unexpected refit split counts: {counts}")
    target = frame.pop(TARGET).to_numpy(dtype=np.float32, copy=False)
    numeric = [name for name in features if name not in CATEGORICAL_FEATURES]
    for name in numeric:
        frame[name] = frame[name].astype(np.float32, copy=False)
    for name in CATEGORICAL_FEATURES:
        frame[name] = frame[name].astype("category")
    return frame, target, counts


def load_historical_records() -> tuple[dict[str, Any], dict[str, Any]]:
    report = json.loads(repository_path(FINAL_REPORT_PATH).read_text(encoding="utf-8"))
    marker = json.loads(repository_path(TEST_ACCESS_PATH).read_text(encoding="utf-8"))
    if marker.get("status") != "completed":
        raise RuntimeError("The single final evaluation is not sealed")
    if report.get("test_access_policy") != "single_final_evaluation":
        raise RuntimeError("Unexpected final evaluation policy")
    return report, marker


def frozen_parameters(config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    hgb = config["hgb"]
    parameters = dict(hgb["config_b"])
    common = {
        "loss": hgb["loss"],
        "early_stopping": hgb["early_stopping"],
        "validation_fraction": hgb["validation_fraction"],
        "n_iter_no_change": hgb["n_iter_no_change"],
    }
    expected = {
        "max_iter": 250,
        "learning_rate": 0.05,
        "max_leaf_nodes": 63,
        "min_samples_leaf": 200,
        "l2_regularization": 1.0,
    }
    if parameters != expected or common != {
        "loss": "squared_error",
        "early_stopping": True,
        "validation_fraction": 0.05,
        "n_iter_no_change": 20,
    }:
        raise RuntimeError("HGB-B configuration no longer matches the selection lock")
    return parameters, common


def validate_metadata(metadata: dict[str, Any]) -> None:
    required = {
        "model_name",
        "model_version",
        "feature_set_version",
        "training_policy",
        "refit_rows",
        "test_rows",
        "joblib_sha256",
        "feature_names",
        "hyperparameters",
        "final_test_metrics",
    }
    missing = sorted(required - metadata.keys())
    if missing:
        raise ValueError(f"Model metadata is incomplete: {', '.join(missing)}")
    if metadata["training_policy"] != "train_plus_validation_after_single_final_test":
        raise ValueError("Unexpected final refit policy")
    if metadata["refit_rows"] != EXPECTED_REFIT_ROWS:
        raise ValueError("Unexpected final refit row count")
    if len(metadata["feature_names"]) != 31:
        raise ValueError("Unexpected final feature count")


def write_trusted_pipeline(pipeline: Pipeline, path: Path) -> tuple[str, int, float]:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    started = time.perf_counter()
    try:
        joblib.dump(pipeline, temporary, compress=3)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    elapsed = time.perf_counter() - started
    return sha256_file(path), path.stat().st_size, elapsed


def load_validation_smoke(gold: Path, features: list[str], rows: int = 32) -> pd.DataFrame:
    connection = connect_duckdb()
    try:
        frame = connection.execute(
            f"""
            SELECT {_quoted(features)} FROM read_parquet(?)
            WHERE split = ? ORDER BY item_id, source_date LIMIT ?
            """,
            [str(gold), "validation", rows],
        ).fetch_df()
    finally:
        connection.close()
    return frame


def run_refit(config_path: str | Path = DEFAULT_CONFIG) -> dict[str, Any]:
    config = load_configuration(config_path)
    manifest, features = load_contract(config)
    historical, marker = load_historical_records()
    gold = repository_path(config["paths"]["gold"])
    model_path = repository_path(MODEL_PATH)
    metadata_path = repository_path(METADATA_PATH)
    contract_path = repository_path(CONTRACT_PATH)
    maximum_rss = int(config["memory"]["maximum_rss_bytes"])
    seed = int(config["experiment"]["random_state"])
    parameters, common = frozen_parameters(config)
    contract = build_feature_contract(features, manifest["dtypes"])

    monitor = PeakMemoryMonitor()
    monitor.__enter__()
    try:
        refit, target, counts = load_refit_data(gold, features)
        refit = validate_and_order_features(refit, contract)
        preprocessor, categorical_indices = build_hgb_preprocessor(features)
        estimator = build_hgb(parameters, categorical_indices, seed, common)
        pipeline = Pipeline(
            [("preprocessing", preprocessor), ("estimator", estimator)]
        )
        fit_started = time.perf_counter()
        pipeline.fit(refit, target)
        refit_seconds = time.perf_counter() - fit_started
        actual_iterations = int(pipeline.named_steps["estimator"].n_iter_)
        del refit, target
        gc.collect()
        if psutil.Process().memory_info().rss >= maximum_rss:
            raise MemoryError("RSS reached the configured 12 GiB safety limit")

        joblib_sha256, joblib_size, serialization_seconds = write_trusted_pipeline(
            pipeline, model_path
        )
        reloaded = joblib.load(model_path)
        smoke_input = load_validation_smoke(gold, features)
        first = predict_demand7d(reloaded, smoke_input, contract)
        second = predict_demand7d(reloaded, smoke_input, contract)
        if first.shape != (len(smoke_input),) or not np.isfinite(first).all():
            raise RuntimeError("Final artifact smoke prediction failed")
        if not np.array_equal(first, second) or np.any(first < 0):
            raise RuntimeError("Final artifact smoke prediction is not deterministic/clipped")

        hyperparameters = {
            **common,
            **parameters,
            "random_state": seed,
            "categorical_features": categorical_indices,
            "actual_iterations": actual_iterations,
        }
        metadata = {
            "model_name": "demand_forecast_v1",
            "model_version": "1.0.0",
            "model_type": "HistGradientBoostingRegressor",
            "created_at_utc": utc_now(),
            "feature_set_version": manifest["feature_set_version"],
            "training_policy": "train_plus_validation_after_single_final_test",
            "train_rows": counts["train"],
            "validation_rows": counts["validation"],
            "refit_rows": EXPECTED_REFIT_ROWS,
            "test_rows": EXPECTED_TEST_ROWS_METADATA_ONLY,
            "test_usage": "historical metadata only; excluded from final fit and smoke",
            "gold_logical_hash": manifest["logical_hash"],
            "gold_file_sha256": manifest.get("file_sha256"),
            "joblib_sha256": joblib_sha256,
            "joblib_size_bytes": joblib_size,
            "target": TARGET,
            "prediction_time": manifest["prediction_time"],
            "prediction_horizon_days": manifest["target"]["horizon_days"],
            "feature_names": features,
            "categorical_features": list(CATEGORICAL_FEATURES),
            "numeric_features": [
                name for name in features if name not in CATEGORICAL_FEATURES
            ],
            "hyperparameters": hyperparameters,
            "preprocessing": {
                "numeric": "float32 passthrough",
                "categorical": (
                    "OrdinalEncoder(handle_unknown=use_encoded_value, "
                    "unknown_value=-1, encoded_missing_value=-1, dtype=float32)"
                ),
                "scaler": None,
                "imputation": None,
            },
            "random_state": seed,
            "validation_metrics": historical["validation_metrics"],
            "final_test_metrics": historical["test_metrics"],
            "baseline_test": {
                "name": "four_week_average",
                **historical["baseline_test_metrics"]["four_week_average"],
            },
            "relative_test_improvement_pct": historical["relative_improvements"][
                "test_wape_improvement_vs_four_week_pct"
            ],
            "clipping_policy": "predictedDemand7d = max(0.0, raw_prediction); no rounding",
            "limitations": [
                "Single-store M5 CA_3 dataset.",
                "RMSSE is unstable for some low-demand series.",
                "Positive bias exists when the target is zero.",
                "Six cold-start products were present in the historical final evaluation.",
                "The selected evaluation model reached max_iter=250.",
                "This model does not guarantee future sales.",
                "Predictions are consultative and not recommended quantities.",
            ],
            "artifact_security": contract["artifact_security"],
            "library_versions": {
                "python": platform.python_version(),
                "numpy": np.__version__,
                "scipy": scipy.__version__,
                "scikit_learn": sklearn.__version__,
                "joblib": joblib.__version__,
                "duckdb": duckdb.__version__,
                "pandas": pd.__version__,
            },
            "performance": {
                "refit_seconds": round(refit_seconds, 3),
                "serialization_seconds": round(serialization_seconds, 3),
                "peak_rss_bytes": monitor.peak_rss_bytes,
            },
            "smoke_test": {
                "split": "validation",
                "rows": len(first),
                "finite": True,
                "deterministic": True,
                "clipped_nonnegative": True,
                "prediction_min": float(first.min()),
                "prediction_max": float(first.max()),
            },
            "sealed_evaluation_marker_sha256": sha256_file(
                repository_path(TEST_ACCESS_PATH)
            ),
            "sealed_evaluation_completed_at_utc": marker["completed_at_utc"],
        }
        validate_metadata(metadata)
        atomic_write_json(contract_path, contract)
        atomic_write_json(metadata_path, metadata)
    finally:
        monitor.__exit__(None, None, None)

    return {
        "status": "completed",
        "refit_rows": EXPECTED_REFIT_ROWS,
        "actual_iterations": actual_iterations,
        "model_path": str(model_path),
        "metadata_path": str(metadata_path),
        "contract_path": str(contract_path),
        "joblib_sha256": joblib_sha256,
        "joblib_size_bytes": joblib_size,
        "refit_seconds": round(refit_seconds, 3),
        "serialization_seconds": round(serialization_seconds, 3),
        "peak_rss_bytes": monitor.peak_rss_bytes,
        "smoke_rows": len(first),
        "test_reopened": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Refit frozen demand-v1 HGB-B on TRAIN + VALIDATION"
    )
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    arguments = parser.parse_args()
    try:
        print(json.dumps(run_refit(arguments.config), indent=2))
    except (FileNotFoundError, MemoryError, RuntimeError, TypeError, ValueError) as error:
        print(f"ML-R4D.1 failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
