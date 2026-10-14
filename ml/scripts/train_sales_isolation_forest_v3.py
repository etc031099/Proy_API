"""Explicit local training with validated canonical daily data. No database access."""
from pathlib import Path
import json
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service.v3_schemas import DATASET_SHA256
from ml.src.sales_isolation_forest_v3 import ARTIFACT_DIR, build_daily, train


def main():
    root = Path(__file__).resolve().parents[2]
    runtime = V3IntelligenceRuntime(root)
    runtime.load()
    if not runtime.ready:
        raise RuntimeError("Approved canonical source unavailable")
    meta = train(build_daily(runtime), DATASET_SHA256, root / ARTIFACT_DIR)
    print(json.dumps({"selected": "auto", "anomalyCount": meta["anomalyCount"], "anomalyRate": meta["anomalyRate"],
                      "stability": meta["stability"], "candidates": [{k: c[k] for k in ("contamination", "anomalyCount", "countsBySplit", "jaccardMean", "jaccardMin")} for c in meta["candidates"]],
                      "artifactHash": meta["artifactHash"]}))


if __name__ == "__main__":
    main()
