from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

from ml.src.common import atomic_write_json, repository_path, utc_now
from ml.src.training.metrics import RMSSE_SCALE_DEFINITION
from ml.src.training.train_ridge import DEFAULT_CONFIG, load_configuration, load_contract


DEFAULT_LOCK = "ml/reports/ml_r4_selection_lock.json"
SELECTED_EXPERIMENT_ID = "r4b2b_hgb_b_full"


def selection_is_eligible(selected_wape: float, baseline_wape: float, ridge_wape: float, peak_rss: int, maximum_rss: int) -> bool:
    return (
        selected_wape < baseline_wape
        and selected_wape < ridge_wape * 0.99
        and selected_wape < baseline_wape * 0.99
        and peak_rss < maximum_rss
    )


def freeze_selection(
    config_path: str | Path = DEFAULT_CONFIG,
    lock_path: str | Path = DEFAULT_LOCK,
) -> dict[str, Any]:
    config = load_configuration(config_path)
    manifest, features = load_contract(config)
    report_path = repository_path(config["paths"]["experiments"])
    destination = repository_path(lock_path)
    if destination.exists():
        existing = json.loads(destination.read_text(encoding="utf-8"))
        if existing.get("selected_experiment_id") != SELECTED_EXPERIMENT_ID:
            raise RuntimeError("A different ML-R4 selection is already locked")
        return existing
    with report_path.open("r", encoding="utf-8", newline="") as stream:
        rows = {row["experiment_id"]: row for row in csv.DictReader(stream)}
    required = {
        SELECTED_EXPERIMENT_ID,
        "r4b1_baseline_four_week_average",
        "r4b1_ridge_alpha_100_0_direct",
    }
    if missing := required - set(rows):
        raise RuntimeError(f"Cannot freeze selection; missing experiments: {sorted(missing)}")
    selected = rows[SELECTED_EXPERIMENT_ID]
    baseline = rows["r4b1_baseline_four_week_average"]
    ridge = rows["r4b1_ridge_alpha_100_0_direct"]
    selected_wape = float(selected["wape"])
    baseline_wape = float(baseline["wape"])
    ridge_wape = float(ridge["wape"])
    peak_rss = int(selected["peak_rss_bytes"])
    maximum_rss = int(config["memory"]["maximum_rss_bytes"])
    if not selection_is_eligible(
        selected_wape, baseline_wape, ridge_wape, peak_rss, maximum_rss
    ):
        raise RuntimeError("HGB-B FULL does not satisfy the predeclared selection rule")
    lock = {
        "status": "locked_before_test",
        "selection_timestamp": utc_now(),
        "selected_experiment_id": SELECTED_EXPERIMENT_ID,
        "selected_model": "HGB-B",
        "target_transform": "direct",
        "feature_set_version": manifest["feature_set_version"],
        "gold_logical_hash": manifest["logical_hash"],
        "features": features,
        "parameters": json.loads(selected["parameters_json"]),
        "preprocessing": {
            "numeric": "float32 passthrough",
            "categorical": "OrdinalEncoder(handle_unknown=use_encoded_value, unknown_value=-1, encoded_missing_value=-1, dtype=float32)",
            "categorical_features": [
                "cat_id", "dept_id", "event_name_1", "event_type_1",
                "event_name_2", "event_type_2",
            ],
        },
        "clipping_policy": "prediction = max(prediction, 0); no rounding",
        "metric_definitions": {
            "primary": "global WAPE",
            "secondary": ["MAE", "RMSSE"],
            "rmsse_scale_definition": RMSSE_SCALE_DEFINITION,
        },
        "selection_basis": {
            "hgb_b_full_validation": {
                key: float(selected[key]) for key in ["wape", "mae", "rmsse"]
            },
            "four_week_validation_wape": baseline_wape,
            "ridge_validation_wape": ridge_wape,
            "relative_wape_improvement_vs_four_week_pct": 100.0
            * (baseline_wape - selected_wape) / baseline_wape,
            "relative_wape_improvement_vs_ridge_pct": 100.0
            * (ridge_wape - selected_wape) / ridge_wape,
            "peak_rss_bytes": peak_rss,
            "fit_seconds": float(selected["fit_seconds"]),
        },
        "known_segment_observations": [
            "low and low-demand segments are weaker than high-demand segments",
            "target-zero predictions show positive bias",
            "cold-start RMSSE is unavailable without a TRAIN scale",
        ],
        "limitations": [
            "n_iter_ reached 250/250; max_iter remains frozen",
            "single-store M5 demand-v1 dataset",
        ],
        "test_access_policy": "single_final_evaluation",
    }
    atomic_write_json(destination, lock)
    return lock


def main() -> int:
    parser = argparse.ArgumentParser(description="Freeze ML-R4 model selection before TEST")
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--lock", default=DEFAULT_LOCK)
    arguments = parser.parse_args()
    try:
        print(json.dumps(freeze_selection(arguments.config, arguments.lock), indent=2))
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"ML-R4 selection freeze failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
