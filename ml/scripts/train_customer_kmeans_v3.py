"""Explicit local READ-only training against the approved V3 historical dataset."""
from pathlib import Path
import json
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service.v3_schemas import DATASET_SHA256
from ml.src.customer_kmeans_v3 import ARTIFACT_DIR, dataset_from_customers, train


def main():
    root = Path(__file__).resolve().parents[2]
    runtime = V3IntelligenceRuntime(root)
    runtime.load()
    if not runtime.ready:
        raise RuntimeError("Approved canonical V3 sources unavailable")
    rows = dataset_from_customers(runtime.customers.snapshot()["customers"])
    if len(rows) != 40 or sum(r["status"] == "ELIGIBLE" for r in rows) != 38:
        raise RuntimeError("Canonical customer eligibility changed")
    result = train(rows, DATASET_SHA256, root / ARTIFACT_DIR)
    print(json.dumps({k: result[k] for k in ("k", "metrics", "quality", "clusters", "scalerSensitivityAri", "artifactHash")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
