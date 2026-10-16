"""Read-only local smoke of persisted ACTIVE 7/14 Ridge artifacts."""
from __future__ import annotations

import base64
import json
import sys
from datetime import date

from ml.service import v3_live_ridge as live
from ml.service import v3_ridge_training as train
from ml.src import v3_forecast


def check(request: dict) -> dict:
    if request.get("businessId") != train.BUSINESS_ID or request.get("scenarioId") != v3_forecast.SCENARIO_ID:
        raise train.TrainingError("INVALID_SCOPE")
    closed = date.fromisoformat(request["observationsClosedThrough"])
    envelopes = {}
    for horizon in (7, 14):
        item = request["models"][str(horizon)]
        raw = base64.b64decode(item["artifactBase64"], validate=True)
        envelopes[horizon] = live.load_verified_ridge_artifact(
            {"metadata": item["metadata"], "artifactData": raw},
            business_id=train.BUSINESS_ID, scenario_id=v3_forecast.SCENARIO_ID,
            horizon_days=horizon)
    dataset = v3_forecast.load_validated_dataset(train.ROOT)
    catalog, closed_rows, _ = train._journal_overlay(dataset, request["journal"], closed)
    cases = [("historical", min(v3_forecast.HISTORY_END, closed))]
    if closed > v3_forecast.HISTORY_END:
        cases.append(("live", closed))
    summary = []
    for mode, origin in cases:
        violations = []
        checked = 0
        for sku in sorted(dataset.product_by_sku):
            predictions = {}
            for horizon in (7, 14):
                if mode == "historical":
                    source = dataset.feature_row(sku, origin, horizon)
                    row = {name: source[name] for name in live.FEATURE_ORDER}
                else:
                    row = train._live_row(dataset, catalog, closed_rows, business_id=train.BUSINESS_ID,
                                          horizon=horizon, sku=sku, origin=origin,
                                          data_version=request["inputDataVersion"])
                predictions[horizon] = live.score_ridge(row, envelopes[horizon])
            checked += 1
            if predictions[7] > predictions[14] + 1e-10:
                violations.append({"sku": sku, "forecast7": predictions[7],
                                   "forecast14": predictions[14]})
        summary.append({"mode": mode, "origin": origin.isoformat(), "checkedSku": checked,
                        "violationCount": len(violations), "violations": violations[:10]})
    return {"modelVersions": {str(h): request["models"][str(h)]["metadata"]["modelVersion"]
                              for h in (7, 14)}, "summary": summary}


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "result": check(json.load(sys.stdin))}, allow_nan=False))
    except (train.TrainingError, live.LiveRidgeError) as error:
        print(json.dumps({"ok": False, "code": error.code}))
    except Exception:
        print(json.dumps({"ok": False, "code": "BUNDLE_CHECK_FAILED"}))
