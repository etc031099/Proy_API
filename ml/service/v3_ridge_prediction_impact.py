"""Bounded internal prediction audit CLI; no Mongo, training, or public endpoint."""
from __future__ import annotations
import json
import sys
from pathlib import Path

from ml.service.v3_live_context import LiveV3ContextStore
from ml.service.v3_schemas import V3OperationalSnapshot, DATASET_VERSION, DATASET_SHA256, TIMEZONE
from ml.service.v3_ridge_audit import score_audit_horizon
from ml.service.v3_live_ridge import LiveRidgeError
from ml.src.v3_forecast import load_validated_dataset
from ml.src.business_customer_supplier_v3 import load_local_sources


def evaluate(payload):
    snapshot = V3OperationalSnapshot.model_validate(payload["snapshot"])
    identity = payload["audit"]
    meta = snapshot.metadata
    root = Path(__file__).resolve().parents[2]
    dataset = load_validated_dataset(root)
    records = load_local_sources(root, dataset=dataset)
    live = LiveV3ContextStore(max_entries=1).build(snapshot, base_records=records,
        request_business_id=identity["businessId"], request_scenario_id=identity["scenarioId"],
        request_dataset_version=DATASET_VERSION, request_dataset_sha256=DATASET_SHA256,
        request_timezone=TIMEZONE, request_as_of_date=meta.asOfDate,
        request_body_bytes=len(json.dumps(payload).encode()))
    skus = [p["sku"] for p in payload["products"]]
    horizons = []
    errors = []
    for item in identity["horizons"]:
        if not item["comparable"]:
            continue
        try:
            horizons.append(score_audit_horizon(dataset=dataset, live=live,
                business_id=identity["businessId"], scenario_id=identity["scenarioId"],
                horizon_days=item["horizonDays"], before_version=item["beforeVersion"],
                after_version=item["afterVersion"], before=item["before"], after=item["after"], skus=skus))
        except LiveRidgeError as error:
            errors.append({"horizonDays": item["horizonDays"], "reasonCode":
                "ARTIFACT_INTEGRITY_FAILED" if error.code in ("ARTIFACT_INVALID", "AUDIT_VERSION_MISMATCH")
                else "IMPACT_SCORING_INVALID"})
        except Exception:
            errors.append({"horizonDays": item["horizonDays"], "reasonCode": "IMPACT_SCORING_FAILED"})
    return {"horizons": horizons, "errors": errors}


if __name__ == "__main__":
    try:
        # Never stream arbitrary input or exception messages back to the caller.
        raw = sys.stdin.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError()
        print(json.dumps({"ok": True, "result": evaluate(json.loads(raw))}, allow_nan=False))
    except Exception:
        print(json.dumps({"ok": False, "code": "IMPACT_SCORING_FAILED"}))
