from __future__ import annotations

from typing import Any

import numpy as np


RMSSE_SCALE_DEFINITION = (
    "mean squared first difference of the 7-day target per item on "
    "consecutive TRAIN anchors"
)


def clip_predictions(prediction: Any) -> tuple[np.ndarray, int]:
    values = np.asarray(prediction, dtype=np.float64)
    negatives = int(np.count_nonzero(values < 0))
    return np.maximum(values, 0.0), negatives


def wape(actual: Any, prediction: Any) -> float:
    actual_values = np.asarray(actual, dtype=np.float64)
    predicted_values = np.asarray(prediction, dtype=np.float64)
    denominator = float(np.abs(actual_values).sum())
    if denominator == 0:
        return float("nan")
    return float(np.abs(actual_values - predicted_values).sum() / denominator)


def mae(actual: Any, prediction: Any) -> float:
    actual_values = np.asarray(actual, dtype=np.float64)
    predicted_values = np.asarray(prediction, dtype=np.float64)
    return float(np.abs(actual_values - predicted_values).mean())


def rmsse(actual: Any, prediction: Any, scales: Any) -> float:
    actual_values = np.asarray(actual, dtype=np.float64)
    predicted_values = np.asarray(prediction, dtype=np.float64)
    scale_values = np.asarray(scales, dtype=np.float64)
    valid = np.isfinite(scale_values) & (scale_values > 0)
    if not np.any(valid):
        return float("nan")
    return float(np.sqrt(np.mean(np.square(actual_values[valid] - predicted_values[valid]) / scale_values[valid])))


def rotation_thresholds(item_means: Any) -> tuple[float, float]:
    values = np.asarray(item_means, dtype=np.float64)
    return tuple(float(value) for value in np.quantile(values, [0.33, 0.67]))


def rotation_class(value: float, low_threshold: float, high_threshold: float) -> str:
    if value <= low_threshold:
        return "low"
    if value <= high_threshold:
        return "medium"
    return "high"


def metric_bundle(actual: Any, prediction: Any, scales: Any) -> dict[str, float]:
    return {
        "wape": wape(actual, prediction),
        "mae": mae(actual, prediction),
        "rmsse": rmsse(actual, prediction, scales),
    }


def zero_target_metrics(actual: Any, prediction: Any) -> dict[str, float | int | None]:
    actual_values = np.asarray(actual, dtype=np.float64)
    predicted_values = np.asarray(prediction, dtype=np.float64)
    mask = actual_values == 0
    if not np.any(mask):
        return {"rows": 0, "wape": None, "mae": None, "mean_bias": None, "positive_prediction_pct": None, "total_overprediction": None}
    selected = predicted_values[mask]
    return {
        "rows": int(mask.sum()),
        "wape": None,
        "mae": float(np.abs(selected).mean()),
        "mean_bias": float(selected.mean()),
        "positive_prediction_pct": float(100.0 * np.mean(selected > 0)),
        "total_overprediction": float(np.maximum(selected, 0).sum()),
    }
