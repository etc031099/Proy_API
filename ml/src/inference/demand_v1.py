from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


CATEGORICAL_FEATURES = (
    "cat_id",
    "dept_id",
    "event_name_1",
    "event_type_1",
    "event_name_2",
    "event_type_2",
)


def build_feature_contract(
    feature_names: list[str], source_dtypes: dict[str, str]
) -> dict[str, Any]:
    categorical = set(CATEGORICAL_FEATURES)
    return {
        "contract_version": "1.0.0",
        "feature_set_version": "demand-v1",
        "strict": True,
        "safe_reorder_by_name": True,
        "feature_order": feature_names,
        "features": [
            {
                "name": name,
                "dtype": "string" if name in categorical else "float32",
                "source_dtype": source_dtypes[name],
                "type": "categorical" if name in categorical else "numeric",
                "required": True,
                "nullable": False,
            }
            for name in feature_names
        ],
        "output": {
            "name": "predictedDemand7d",
            "dtype": "float",
            "minimum_after_clipping": 0.0,
            "rounding": "none",
            "clipping": "max(0.0, raw_prediction)",
        },
        "artifact_security": (
            "Load joblib/pickle only from trusted, application-owned artifacts; "
            "never load a model uploaded by a user."
        ),
    }


def validate_and_order_features(
    frame: pd.DataFrame, contract: dict[str, Any]
) -> pd.DataFrame:
    if not isinstance(frame, pd.DataFrame):
        raise TypeError("Inference input must be a pandas DataFrame")
    expected = list(contract["feature_order"])
    missing = [name for name in expected if name not in frame.columns]
    unexpected = [name for name in frame.columns if name not in expected]
    if missing:
        raise ValueError(f"Missing required features: {', '.join(missing)}")
    if contract.get("strict", False) and unexpected:
        raise ValueError(f"Unexpected features: {', '.join(unexpected)}")

    ordered = frame.loc[:, expected].copy()
    specifications = {entry["name"]: entry for entry in contract["features"]}
    for name in expected:
        specification = specifications[name]
        values = ordered[name]
        if not specification["nullable"] and values.isna().any():
            raise ValueError(f"Feature {name} contains null values")
        if specification["type"] == "numeric":
            try:
                converted = pd.to_numeric(values, errors="raise").astype(
                    np.float32, copy=False
                )
            except (TypeError, ValueError) as error:
                raise ValueError(f"Feature {name} must be numeric") from error
            if not np.isfinite(converted.to_numpy(dtype=np.float32)).all():
                raise ValueError(f"Feature {name} contains NaN or infinity")
            ordered[name] = converted
        else:
            if not all(isinstance(value, str) for value in values):
                raise ValueError(f"Feature {name} must contain strings")
            ordered[name] = values.astype("category")
    return ordered


def predict_demand7d(
    pipeline: Any, frame: pd.DataFrame, contract: dict[str, Any]
) -> np.ndarray:
    ordered = validate_and_order_features(frame, contract)
    raw = np.asarray(pipeline.predict(ordered), dtype=np.float64)
    if raw.ndim != 1 or raw.shape[0] != len(ordered):
        raise RuntimeError("Model returned an unexpected prediction shape")
    if not np.isfinite(raw).all():
        raise RuntimeError("Model returned a non-finite prediction")
    return np.maximum(raw, 0.0)
