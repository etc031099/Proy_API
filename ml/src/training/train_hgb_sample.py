from __future__ import annotations

import argparse
import gc
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
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.preprocessing import OrdinalEncoder

from ml.src.common import PeakMemoryMonitor, atomic_write_json, repository_path, utc_now
from ml.src.m5 import connect_duckdb
from ml.src.training.metrics import RMSSE_SCALE_DEFINITION, clip_predictions, metric_bundle
from ml.src.training.train_ridge import (
    CATEGORICAL_FEATURES,
    DEFAULT_CONFIG,
    EXPECTED_VALIDATION_ROWS,
    TARGET,
    _clean_json,
    _quoted,
    attach_segments,
    load_configuration,
    load_contract,
    load_split,
    segment_report,
    train_item_statistics,
    write_experiment_log,
)


REFERENCE_FOUR_WEEK_WAPE = 0.35799177837772045
REFERENCE_RIDGE_WAPE = 0.3609247803613216


def sampling_rule(seed: int, modulus: int, threshold: int) -> str:
    return (
        "TRAIN only; include first chronological row per item, otherwise "
        f"hash(item_id, source_date, seed={seed}) % {modulus} < {threshold}"
    )


def load_train_sample(
    gold: Path,
    features: list[str],
    *,
    seed: int,
    modulus: int,
    threshold: int,
) -> tuple[pd.DataFrame, np.ndarray, str, dict[str, Any]]:
    if not 0 <= threshold <= modulus:
        raise ValueError("Invalid deterministic sampling threshold")
    selected = features + [TARGET, "item_id", "source_date"]
    connection = connect_duckdb()
    try:
        frame = connection.execute(
            f"""
            SELECT {_quoted(selected)}
            FROM read_parquet(?)
            WHERE split = 'train'
            QUALIFY row_number() OVER (
                      PARTITION BY item_id ORDER BY source_date
                    ) = 1
                 OR hash(item_id, source_date, ?) % ? < ?
            ORDER BY item_id, source_date
            """,
            [str(gold), seed, modulus, threshold],
        ).fetch_df()
    finally:
        connection.close()
    digest = hashlib.sha256()
    for item_id, source_date in zip(frame["item_id"], frame["source_date"]):
        digest.update(f"{item_id}|{source_date.date().isoformat()}\n".encode())
    profile = {
        "rows": len(frame),
        "products": int(frame["item_id"].nunique()),
        "date_min": str(frame["source_date"].min().date()),
        "date_max": str(frame["source_date"].max().date()),
        "categories": int(frame["cat_id"].nunique()),
        "target_zero_pct": float(100.0 * (frame[TARGET] == 0).mean()),
        "target_mean": float(frame[TARGET].mean()),
    }
    frame.drop(columns=["item_id", "source_date"], inplace=True)
    target = frame.pop(TARGET).to_numpy(dtype=np.float32, copy=False)
    numeric = [name for name in features if name not in CATEGORICAL_FEATURES]
    for name in numeric:
        frame[name] = frame[name].astype(np.float32, copy=False)
    for name in CATEGORICAL_FEATURES:
        frame[name] = frame[name].astype("category")
    return frame, target, digest.hexdigest(), profile


def build_hgb_preprocessor(features: list[str]) -> tuple[ColumnTransformer, list[int]]:
    numeric = [name for name in features if name not in CATEGORICAL_FEATURES]
    preprocessor = ColumnTransformer(
        transformers=[
            ("numeric", "passthrough", numeric),
            (
                "categorical",
                OrdinalEncoder(
                    handle_unknown="use_encoded_value",
                    unknown_value=-1,
                    encoded_missing_value=-1,
                    dtype=np.float32,
                ),
                CATEGORICAL_FEATURES,
            ),
        ],
        sparse_threshold=0.0,
        verbose_feature_names_out=False,
    )
    categorical_indices = list(range(len(numeric), len(numeric) + len(CATEGORICAL_FEATURES)))
    return preprocessor, categorical_indices


def build_hgb(parameters: dict[str, Any], categorical_indices: list[int], seed: int, common: dict[str, Any]) -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        loss=common["loss"],
        max_iter=int(parameters["max_iter"]),
        learning_rate=float(parameters["learning_rate"]),
        max_leaf_nodes=int(parameters["max_leaf_nodes"]),
        min_samples_leaf=int(parameters["min_samples_leaf"]),
        l2_regularization=float(parameters["l2_regularization"]),
        early_stopping=bool(common["early_stopping"]),
        validation_fraction=float(common["validation_fraction"]),
        n_iter_no_change=int(common["n_iter_no_change"]),
        categorical_features=categorical_indices,
        random_state=seed,
    )


def pipeline_size_estimate(preprocessor: ColumnTransformer, estimator: Any) -> int:
    return len(
        pickle.dumps(
            {"preprocessing": preprocessor, "estimator": estimator},
            protocol=pickle.HIGHEST_PROTOCOL,
        )
    )


def run_hgb_sample(config_path: str | Path = DEFAULT_CONFIG) -> dict[str, Any]:
    config = load_configuration(config_path)
    manifest, features = load_contract(config)
    gold = repository_path(config["paths"]["gold"])
    report_path = repository_path(config["paths"]["experiments"])
    segments_directory = repository_path(config["paths"]["segments_directory"])
    seed = int(config["experiment"]["random_state"])
    maximum_rss = int(config["memory"]["maximum_rss_bytes"])
    hgb_config = config["hgb"]
    modulus = int(hgb_config["sample_modulus"])
    threshold = int(hgb_config["sample_threshold"])
    monitor = PeakMemoryMonitor()
    monitor.__enter__()
    experiments: list[dict[str, Any]] = []
    segment_files: dict[str, str] = {}
    try:
        train, y_train, sample_hash, sample_profile = load_train_sample(
            gold, features, seed=seed, modulus=modulus, threshold=threshold
        )
        if not 750_000 <= len(train) <= 1_000_000:
            raise RuntimeError(f"Deterministic TRAIN sample has unexpected size: {len(train)}")
        if sample_profile["products"] != 3_043:
            raise RuntimeError("Deterministic TRAIN sample does not contain every TRAIN product")
        validation, y_validation, validation_metadata = load_split(
            gold, "validation", features, metadata=True
        )
        if len(validation) != EXPECTED_VALIDATION_ROWS:
            raise RuntimeError("VALIDATION was not loaded completely")
        item_statistics = train_item_statistics(gold)
        validation_metadata, thresholds = attach_segments(validation_metadata, item_statistics)
        scales = validation_metadata["rmsse_scale"].to_numpy(dtype=np.float64)

        preprocessor, categorical_indices = build_hgb_preprocessor(features)
        transform_started = time.perf_counter()
        x_train = preprocessor.fit_transform(train).astype(np.float32, copy=False)
        x_validation = preprocessor.transform(validation).astype(np.float32, copy=False)
        transform_seconds = time.perf_counter() - transform_started
        if x_train.shape[1] != len(features) or x_validation.shape[0] != EXPECTED_VALIDATION_ROWS:
            raise RuntimeError("Unexpected HGB preprocessor output shape")
        del train
        gc.collect()
        if psutil.Process().memory_info().rss >= maximum_rss:
            raise MemoryError("RSS reached the configured 12 GiB safety limit")

        common = {
            "loss": hgb_config["loss"],
            "early_stopping": hgb_config["early_stopping"],
            "validation_fraction": hgb_config["validation_fraction"],
            "n_iter_no_change": hgb_config["n_iter_no_change"],
        }
        for label in ["a", "b", "c"]:
            parameters = dict(hgb_config[f"config_{label}"])
            estimator = build_hgb(parameters, categorical_indices, seed, common)
            fit_started = time.perf_counter()
            estimator.fit(x_train, y_train)
            fit_seconds = time.perf_counter() - fit_started
            predict_started = time.perf_counter()
            raw_prediction = estimator.predict(x_validation)
            predict_seconds = time.perf_counter() - predict_started
            prediction, negatives = clip_predictions(raw_prediction)
            metrics = metric_bundle(y_validation, prediction, scales)
            experiment_id = f"r4b2a_hgb_{label}"
            segment_path = segments_directory / f"{experiment_id}.json"
            atomic_write_json(
                segment_path,
                {
                    "experiment_id": experiment_id,
                    "sample_hash": sample_hash,
                    "sample_profile": sample_profile,
                    "rotation_thresholds": thresholds,
                    "metrics": segment_report(
                        y_validation, prediction, validation_metadata, validation
                    ),
                },
            )
            segment_files[experiment_id] = str(segment_path)
            logged_parameters = {
                **common, **parameters,
                "categorical_features": categorical_indices,
                "actual_iterations": int(estimator.n_iter_),
                "sample_hash": sample_hash,
            }
            experiments.append(
                {
                    "experiment_id": experiment_id,
                    "executed_at_utc": utc_now(),
                    "model": f"hist_gradient_boosting_{label.upper()}",
                    "target_transform": "none",
                    "parameters_json": json.dumps(logged_parameters, sort_keys=True),
                    "sample_policy": sampling_rule(seed, modulus, threshold),
                    "random_state": seed,
                    "train_rows": len(y_train),
                    "validation_rows": len(y_validation),
                    "feature_set_version": manifest["feature_set_version"],
                    "gold_logical_hash": manifest["logical_hash"],
                    "fit_seconds": round(fit_seconds, 3),
                    "predict_seconds": round(predict_seconds, 3),
                    "peak_rss_bytes": monitor.peak_rss_bytes,
                    "model_size_estimate_bytes": pipeline_size_estimate(preprocessor, estimator),
                    **metrics,
                    "negative_predictions_before_clip": negatives,
                    "status": "completed",
                    "notes": (
                        f"sample_hash={sample_hash}; actual_iterations={estimator.n_iter_}; "
                        f"preprocessing_seconds={transform_seconds:.3f}; {RMSSE_SCALE_DEFINITION}"
                    ),
                }
            )
            del estimator, raw_prediction, prediction
            gc.collect()
            if psutil.Process().memory_info().rss >= maximum_rss:
                raise MemoryError("RSS reached the configured 12 GiB safety limit")
    finally:
        monitor.__exit__(None, None, None)

    write_experiment_log(report_path, experiments)
    return _clean_json(
        {
            "status": "completed",
            "test_accessed": False,
            "sample_rule": sampling_rule(seed, modulus, threshold),
            "sample_hash": sample_hash,
            "sample_profile": sample_profile,
            "validation_rows": EXPECTED_VALIDATION_ROWS,
            "categorical_indices": categorical_indices,
            "reference_four_week_wape": REFERENCE_FOUR_WEEK_WAPE,
            "reference_ridge_wape": REFERENCE_RIDGE_WAPE,
            "experiments": experiments,
            "segments": segment_files,
            "peak_rss_bytes": monitor.peak_rss_bytes,
        }
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Train sampled demand-v1 HGB candidates")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    arguments = parser.parse_args()
    try:
        print(json.dumps(run_hgb_sample(arguments.config), indent=2))
    except (FileNotFoundError, MemoryError, RuntimeError, ValueError) as error:
        print(f"ML-R4B.2A failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
