"""Versioned moving-average contract; local only, independent of ML serving V1/V2."""
from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path

from ml.src import v3_forecast as v

STRATEGY_VERSION = "minimarket-pasco-v3-moving-average-28-v1"


def configuration() -> dict:
    return {"forecastStrategy": "MOVING_AVERAGE_28", "historyDays": 28,
            "horizons": [1, 7, 14], "formula": "h * mean(last 28 completed-day unitsSold)",
            "timezone": "America/Lima", "missingDays": "INSUFFICIENT_HISTORY",
            "target": "effective units sold, not unconstrained demand", "clipping": "max(0,p)",
            "coherence": "p7=max(p1,p7); p14=max(p7,p14)"}


def config_hash() -> str:
    return hashlib.sha256(json.dumps(configuration(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def predict(dataset: v.V3Dataset, *, sku: str, cutoff: date) -> dict:
    strategies = {h: {"method": "BASELINE_FALLBACK", "baseline": "B3_MEAN_28"} for h in v.PRIMARY_HORIZONS}
    item = v.predict_forecast_batch(dataset, prediction_origin=cutoff, skus=[sku], strategy_by_horizon=strategies)[0]
    result = {"sku": sku, "cutoffDate": cutoff.isoformat(), "strategyVersion": STRATEGY_VERSION,
              "forecastSource": "MOVING_AVERAGE_28", "status": item["status"],
              "confidence": None, "predictionInterval": None}
    result.update(item["forecast"] or {f"expectedUnitsNext{h}d": None for h in v.PRIMARY_HORIZONS})
    return result


def load_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("strategyVersion") != STRATEGY_VERSION or manifest.get("datasetSha256") != v.DATASET_SHA256:
        raise ValueError("Baseline bundle lineage/version mismatch")
    if manifest.get("config") != configuration() or manifest.get("configSha256") != config_hash():
        raise ValueError("Baseline bundle configuration mismatch")
    return manifest
