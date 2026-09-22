from __future__ import annotations

import argparse
import gc
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import psutil

from ml.src.common import PeakMemoryMonitor, atomic_write_json, repository_path, utc_now
from ml.src.training.metrics import RMSSE_SCALE_DEFINITION, clip_predictions, metric_bundle
from ml.src.training.train_hgb_sample import (
    REFERENCE_FOUR_WEEK_WAPE,
    REFERENCE_RIDGE_WAPE,
    build_hgb,
    build_hgb_preprocessor,
    pipeline_size_estimate,
)
from ml.src.training.train_ridge import (
    DEFAULT_CONFIG,
    EXPECTED_TRAIN_ROWS,
    EXPECTED_VALIDATION_ROWS,
    _clean_json,
    attach_segments,
    load_configuration,
    load_contract,
    load_split,
    segment_report,
    train_item_statistics,
    write_experiment_log,
)


SAMPLED_HGB_B_WAPE = 0.3346305692947286


def run_hgb_full(config_path: str | Path = DEFAULT_CONFIG) -> dict[str, Any]:
    config = load_configuration(config_path)
    manifest, features = load_contract(config)
    gold = repository_path(config["paths"]["gold"])
    report_path = repository_path(config["paths"]["experiments"])
    segments_directory = repository_path(config["paths"]["segments_directory"])
    seed = int(config["experiment"]["random_state"])
    maximum_rss = int(config["memory"]["maximum_rss_bytes"])
    hgb_config = config["hgb"]
    parameters = dict(hgb_config["config_b"])
    common = {
        "loss": hgb_config["loss"],
        "early_stopping": hgb_config["early_stopping"],
        "validation_fraction": hgb_config["validation_fraction"],
        "n_iter_no_change": hgb_config["n_iter_no_change"],
    }

    monitor = PeakMemoryMonitor()
    monitor.__enter__()
    try:
        train, y_train, _ = load_split(gold, "train", features, metadata=False)
        validation, y_validation, validation_metadata = load_split(
            gold, "validation", features, metadata=True
        )
        if len(train) != EXPECTED_TRAIN_ROWS:
            raise RuntimeError("FULL TRAIN row count differs from demand-v1 contract")
        if len(validation) != EXPECTED_VALIDATION_ROWS:
            raise RuntimeError("VALIDATION was not loaded completely")

        item_statistics = train_item_statistics(gold)
        validation_metadata, thresholds = attach_segments(
            validation_metadata, item_statistics
        )
        scales = validation_metadata["rmsse_scale"].to_numpy(dtype=np.float64)

        preprocessor, categorical_indices = build_hgb_preprocessor(features)
        preprocessing_started = time.perf_counter()
        x_train = preprocessor.fit_transform(train).astype(np.float32, copy=False)
        x_validation = preprocessor.transform(validation).astype(np.float32, copy=False)
        preprocessing_seconds = time.perf_counter() - preprocessing_started
        if x_train.shape != (EXPECTED_TRAIN_ROWS, len(features)):
            raise RuntimeError("Unexpected FULL TRAIN preprocessor output shape")
        if x_validation.shape != (EXPECTED_VALIDATION_ROWS, len(features)):
            raise RuntimeError("Unexpected VALIDATION preprocessor output shape")
        del train
        gc.collect()
        if psutil.Process().memory_info().rss >= maximum_rss:
            raise MemoryError("RSS reached the configured 12 GiB safety limit")

        estimator = build_hgb(parameters, categorical_indices, seed, common)
        fit_started = time.perf_counter()
        estimator.fit(x_train, y_train)
        fit_seconds = time.perf_counter() - fit_started
        predict_started = time.perf_counter()
        raw_prediction = estimator.predict(x_validation)
        predict_seconds = time.perf_counter() - predict_started
        prediction, negatives = clip_predictions(raw_prediction)
        metrics = metric_bundle(y_validation, prediction, scales)

        experiment_id = "r4b2b_hgb_b_full"
        segment_path = segments_directory / f"{experiment_id}.json"
        segmented = segment_report(
            y_validation, prediction, validation_metadata, validation
        )
        atomic_write_json(
            segment_path,
            {
                "experiment_id": experiment_id,
                "train_policy": "full_train",
                "train_rows": len(y_train),
                "rotation_thresholds": thresholds,
                "metrics": segmented,
            },
        )

        logged_parameters = {
            **common,
            **parameters,
            "categorical_features": categorical_indices,
            "actual_iterations": int(estimator.n_iter_),
        }
        experiment = {
            "experiment_id": experiment_id,
            "executed_at_utc": utc_now(),
            "model": "hist_gradient_boosting_B_FULL",
            "target_transform": "none",
            "parameters_json": json.dumps(logged_parameters, sort_keys=True),
            "sample_policy": "full_train",
            "random_state": seed,
            "train_rows": len(y_train),
            "validation_rows": len(y_validation),
            "feature_set_version": manifest["feature_set_version"],
            "gold_logical_hash": manifest["logical_hash"],
            "fit_seconds": round(fit_seconds, 3),
            "predict_seconds": round(predict_seconds, 3),
            "peak_rss_bytes": monitor.peak_rss_bytes,
            "model_size_estimate_bytes": pipeline_size_estimate(
                preprocessor, estimator
            ),
            **metrics,
            "negative_predictions_before_clip": negatives,
            "status": "completed",
            "notes": (
                f"actual_iterations={estimator.n_iter_}; "
                f"preprocessing_seconds={preprocessing_seconds:.3f}; "
                f"{RMSSE_SCALE_DEFINITION}"
            ),
        }
    finally:
        monitor.__exit__(None, None, None)

    write_experiment_log(report_path, [experiment])
    return _clean_json(
        {
            "status": "completed",
            "test_accessed": False,
            "train_rows": EXPECTED_TRAIN_ROWS,
            "validation_rows": EXPECTED_VALIDATION_ROWS,
            "preprocessing_seconds": round(preprocessing_seconds, 3),
            "experiment": experiment,
            "segment_report": str(segment_path),
            "comparison": {
                "sample_hgb_b_wape": SAMPLED_HGB_B_WAPE,
                "four_week_wape": REFERENCE_FOUR_WEEK_WAPE,
                "ridge_wape": REFERENCE_RIDGE_WAPE,
                "relative_improvement_vs_sample_pct": 100.0
                * (SAMPLED_HGB_B_WAPE - metrics["wape"])
                / SAMPLED_HGB_B_WAPE,
                "relative_improvement_vs_four_week_pct": 100.0
                * (REFERENCE_FOUR_WEEK_WAPE - metrics["wape"])
                / REFERENCE_FOUR_WEEK_WAPE,
                "relative_improvement_vs_ridge_pct": 100.0
                * (REFERENCE_RIDGE_WAPE - metrics["wape"])
                / REFERENCE_RIDGE_WAPE,
            },
            "peak_rss_bytes": monitor.peak_rss_bytes,
        }
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Train HGB-B on full demand-v1 TRAIN")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    arguments = parser.parse_args()
    try:
        print(json.dumps(run_hgb_full(arguments.config), indent=2))
    except (FileNotFoundError, MemoryError, RuntimeError, ValueError) as error:
        print(f"ML-R4B.2B failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
