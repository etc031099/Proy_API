from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import pickle
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import psutil

from ml.src.common import PeakMemoryMonitor, atomic_write_json, repository_path, sha256_file, utc_now
from ml.src.m5 import connect_duckdb
from ml.src.training.freeze_r4_selection import DEFAULT_LOCK, SELECTED_EXPERIMENT_ID
from ml.src.training.metrics import RMSSE_SCALE_DEFINITION, clip_predictions, metric_bundle
from ml.src.training.train_hgb_sample import (
    build_hgb,
    build_hgb_preprocessor,
    pipeline_size_estimate,
)
from ml.src.training.train_ridge import (
    CATEGORICAL_FEATURES,
    DEFAULT_CONFIG,
    EXPECTED_TRAIN_ROWS,
    TARGET,
    _clean_json,
    _quoted,
    attach_segments,
    direct_baselines,
    load_configuration,
    load_contract,
    load_split,
    segment_report,
    train_item_statistics,
    write_experiment_log,
)


EXPECTED_TEST_ROWS = 255_989
EXPECTED_TEST_START = "2016-02-22"
EXPECTED_TEST_END = "2016-05-15"
DEFAULT_REPORT = "ml/reports/ml_r4_final_evaluation.json"
DEFAULT_ACCESS_MARKER = "ml/reports/ml_r4_test_access.json"


def ensure_test_unopened(marker: Path, report: Path) -> None:
    if marker.exists() or report.exists():
        raise RuntimeError(
            "TEST final evaluation has already been started or completed; refusing a second access"
        )


def load_final_test(gold: Path, features: list[str]) -> tuple[pd.DataFrame, np.ndarray, pd.DataFrame]:
    selected = features + [TARGET, "item_id", "source_date"]
    connection = connect_duckdb()
    try:
        frame = connection.execute(
            f"SELECT {_quoted(selected)} FROM read_parquet(?) "
            "WHERE split = 'test' ORDER BY item_id, source_date",
            [str(gold)],
        ).fetch_df()
    finally:
        connection.close()
    target = frame.pop(TARGET).to_numpy(dtype=np.float32, copy=False)
    metadata = frame[["item_id", "source_date"]].copy()
    frame.drop(columns=["item_id", "source_date"], inplace=True)
    numeric = [name for name in features if name not in CATEGORICAL_FEATURES]
    for name in numeric:
        frame[name] = frame[name].astype(np.float32, copy=False)
    for name in CATEGORICAL_FEATURES:
        frame[name] = frame[name].astype("category")
    return frame, target, metadata


def previous_week_test_baseline(gold: Path, bronze: Path) -> np.ndarray:
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
            ), test_keys AS (
              SELECT item_id, source_date FROM read_parquet(?)
              WHERE split = 'test'
            )
            SELECT h.previous_week FROM test_keys t
            JOIN history h USING (item_id, source_date)
            ORDER BY t.item_id, t.source_date
            """,
            [str(bronze), str(gold)],
        ).fetchnumpy()["previous_week"].astype(np.float32, copy=False)
    finally:
        connection.close()
    if len(values) != EXPECTED_TEST_ROWS or not np.isfinite(values).all():
        raise RuntimeError("Could not derive complete previous-week TEST baseline")
    return values


def _validation_records(report_path: Path) -> dict[str, dict[str, str]]:
    with report_path.open("r", encoding="utf-8", newline="") as stream:
        return {row["experiment_id"]: row for row in csv.DictReader(stream)}


def evaluate_test_once(
    config_path: str | Path = DEFAULT_CONFIG,
    lock_path: str | Path = DEFAULT_LOCK,
    report_path: str | Path = DEFAULT_REPORT,
    marker_path: str | Path = DEFAULT_ACCESS_MARKER,
) -> dict[str, Any]:
    config = load_configuration(config_path)
    manifest, features = load_contract(config)
    gold = repository_path(config["paths"]["gold"])
    bronze = repository_path(config["paths"]["bronze"])
    experiments_path = repository_path(config["paths"]["experiments"])
    segments_directory = repository_path(config["paths"]["segments_directory"])
    lock_file = repository_path(lock_path)
    final_report = repository_path(report_path)
    access_marker = repository_path(marker_path)
    ensure_test_unopened(access_marker, final_report)
    if not lock_file.is_file():
        raise RuntimeError("Pre-TEST selection lock does not exist")
    lock = json.loads(lock_file.read_text(encoding="utf-8"))
    if lock.get("status") != "locked_before_test" or lock.get("selected_experiment_id") != SELECTED_EXPERIMENT_ID:
        raise RuntimeError("Invalid pre-TEST selection lock")
    if lock.get("gold_logical_hash") != manifest["logical_hash"]:
        raise RuntimeError("Selection lock and Gold manifest differ")

    hgb_config = config["hgb"]
    parameters = dict(hgb_config["config_b"])
    common = {
        "loss": hgb_config["loss"],
        "early_stopping": hgb_config["early_stopping"],
        "validation_fraction": hgb_config["validation_fraction"],
        "n_iter_no_change": hgb_config["n_iter_no_change"],
    }
    seed = int(config["experiment"]["random_state"])
    maximum_rss = int(config["memory"]["maximum_rss_bytes"])
    monitor = PeakMemoryMonitor()
    monitor.__enter__()
    try:
        train, y_train, _ = load_split(gold, "train", features, metadata=False)
        if len(train) != EXPECTED_TRAIN_ROWS:
            raise RuntimeError("Unexpected TRAIN row count before final TEST")
        item_statistics = train_item_statistics(gold)
        preprocessor, categorical_indices = build_hgb_preprocessor(features)
        preprocessing_started = time.perf_counter()
        x_train = preprocessor.fit_transform(train).astype(np.float32, copy=False)
        preprocessing_seconds = time.perf_counter() - preprocessing_started
        del train
        if psutil.Process().memory_info().rss >= maximum_rss:
            raise MemoryError("RSS reached the configured limit before TEST access")
        estimator = build_hgb(parameters, categorical_indices, seed, common)
        fit_started = time.perf_counter()
        estimator.fit(x_train, y_train)
        fit_seconds = time.perf_counter() - fit_started
        if int(estimator.n_iter_) != int(lock["parameters"]["actual_iterations"]):
            raise RuntimeError("Deterministic retraining differs from the selected model")
        model_content_hash = hashlib.sha256(
            pickle.dumps(
                {"preprocessing": preprocessor, "estimator": estimator},
                protocol=pickle.HIGHEST_PROTOCOL,
            )
        ).hexdigest()

        marker = {
            "status": "started",
            "opened_at_utc": utc_now(),
            "test_access_policy": "single_final_evaluation",
            "selection_timestamp": lock["selection_timestamp"],
            "selected_experiment_id": SELECTED_EXPERIMENT_ID,
            "model_content_hash": model_content_hash,
        }
        atomic_write_json(access_marker, marker)

        test, y_test, test_metadata = load_final_test(gold, features)
        test_start = str(test_metadata["source_date"].min().date())
        test_end = str(test_metadata["source_date"].max().date())
        if len(test) != EXPECTED_TEST_ROWS:
            raise RuntimeError(f"Unexpected TEST row count: {len(test)}")
        if (test_start, test_end) != (EXPECTED_TEST_START, EXPECTED_TEST_END):
            raise RuntimeError(f"Unexpected TEST date range: {test_start} to {test_end}")
        test_metadata, thresholds = attach_segments(test_metadata, item_statistics)
        scales = test_metadata["rmsse_scale"].to_numpy(dtype=np.float64)
        transform_started = time.perf_counter()
        x_test = preprocessor.transform(test).astype(np.float32, copy=False)
        test_transform_seconds = time.perf_counter() - transform_started
        predict_started = time.perf_counter()
        raw_prediction = estimator.predict(x_test)
        predict_seconds = time.perf_counter() - predict_started
        prediction, negatives = clip_predictions(raw_prediction)
        test_metrics = metric_bundle(y_test, prediction, scales)
        segmented = segment_report(y_test, prediction, test_metadata, test)

        baseline_predictions = direct_baselines(test)
        baseline_predictions["previous_week"] = previous_week_test_baseline(gold, bronze)
        baseline_metrics = {
            name: metric_bundle(y_test, clip_predictions(values)[0], scales)
            for name, values in baseline_predictions.items()
        }
        validation_rows = _validation_records(experiments_path)
        selected_validation = validation_rows[SELECTED_EXPERIMENT_ID]
        validation_metrics = {
            key: float(selected_validation[key]) for key in ["wape", "mae", "rmsse"]
        }
        baseline_validation_metrics = {
            name: {
                key: float(validation_rows[experiment_id][key])
                for key in ["wape", "mae", "rmsse"]
            }
            for name, experiment_id in {
                "zero": "r4b1_baseline_zero",
                "last7": "r4b1_baseline_last7",
                "four_week_average": "r4b1_baseline_four_week_average",
                "previous_week": "r4b1_baseline_previous_week",
            }.items()
        }
        relative = {
            "test_vs_validation": {
                key: 100.0 * (test_metrics[key] - validation_metrics[key]) / validation_metrics[key]
                for key in ["wape", "mae", "rmsse"]
            },
            "test_wape_improvement_vs_four_week_pct": 100.0
            * (baseline_metrics["four_week_average"]["wape"] - test_metrics["wape"])
            / baseline_metrics["four_week_average"]["wape"],
        }
        model_size = pipeline_size_estimate(preprocessor, estimator)
        test_experiment = {
            "experiment_id": "r4c_hgb_b_final_test",
            "executed_at_utc": utc_now(),
            "model": "hist_gradient_boosting_B_FINAL_TEST",
            "target_transform": "none",
            "parameters_json": json.dumps(lock["parameters"], sort_keys=True),
            "sample_policy": "full_train_frozen_before_test",
            "random_state": seed,
            "evaluation_split": "test",
            "evaluation_rows": len(y_test),
            "train_rows": len(y_train),
            "validation_rows": int(manifest["rows"]["validation"]),
            "feature_set_version": manifest["feature_set_version"],
            "gold_logical_hash": manifest["logical_hash"],
            "fit_seconds": round(fit_seconds, 3),
            "predict_seconds": round(predict_seconds, 3),
            "peak_rss_bytes": monitor.peak_rss_bytes,
            "model_size_estimate_bytes": model_size,
            **test_metrics,
            "negative_predictions_before_clip": negatives,
            "status": "final_test_completed",
            "notes": f"single final TEST evaluation; {RMSSE_SCALE_DEFINITION}",
        }
        segment_path = segments_directory / "r4c_hgb_b_final_test.json"
        atomic_write_json(segment_path, segmented)
        report = {
            "selected_model": lock["selected_model"],
            "selection_timestamp": lock["selection_timestamp"],
            "selection_basis": lock["selection_basis"],
            "feature_set_version": manifest["feature_set_version"],
            "gold_logical_hash": manifest["logical_hash"],
            "training_rows": len(y_train),
            "validation_rows": int(manifest["rows"]["validation"]),
            "test_rows": len(y_test),
            "test_date_range": {"start": test_start, "end": test_end, "target_through": "2016-05-22"},
            "parameters": lock["parameters"],
            "preprocessing": lock["preprocessing"],
            "validation_metrics": validation_metrics,
            "test_metrics": test_metrics,
            "baseline_validation_metrics": baseline_validation_metrics,
            "baseline_test_metrics": baseline_metrics,
            "relative_improvements": relative,
            "segment_metrics": segmented,
            "cold_start_metrics": segmented["cold_start"]["True"],
            "target_zero_metrics": segmented["target_zero"],
            "negative_predictions_before_clip": negatives,
            "fit_seconds": round(fit_seconds, 3),
            "preprocessing_seconds": round(preprocessing_seconds, 3),
            "test_transform_seconds": round(test_transform_seconds, 3),
            "predict_seconds": round(predict_seconds, 3),
            "peak_rss_bytes": monitor.peak_rss_bytes,
            "model_size_estimate_bytes": model_size,
            "model_content_hash": model_content_hash,
            "rmsse_scale_definition": RMSSE_SCALE_DEFINITION,
            "limitations": lock["limitations"] + [
                "TEST is a single final evaluation and cannot be used for retuning",
                "cold-start products have no TRAIN-derived RMSSE scale",
                "target-zero predictions retain positive bias",
            ],
            "test_access_policy": "single_final_evaluation",
            "test_accessed_at_utc": marker["opened_at_utc"],
            "test_experiment_id": test_experiment["experiment_id"],
        }
        atomic_write_json(final_report, _clean_json(report))
        write_experiment_log(experiments_path, [test_experiment])
        marker["status"] = "completed"
        marker["completed_at_utc"] = utc_now()
        marker["report_sha256"] = sha256_file(final_report)
        atomic_write_json(access_marker, marker)
    finally:
        monitor.__exit__(None, None, None)
    return _clean_json(report)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the single final ML-R4 TEST evaluation")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--lock", default=DEFAULT_LOCK)
    parser.add_argument("--report", default=DEFAULT_REPORT)
    parser.add_argument("--marker", default=DEFAULT_ACCESS_MARKER)
    arguments = parser.parse_args()
    try:
        print(json.dumps(evaluate_test_once(arguments.config, arguments.lock, arguments.report, arguments.marker), indent=2))
    except (FileNotFoundError, MemoryError, RuntimeError, ValueError) as error:
        print(f"ML-R4C final TEST evaluation failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
