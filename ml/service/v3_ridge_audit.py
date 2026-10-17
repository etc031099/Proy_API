"""Internal exact-version audit scoring. No registry mutation or LIVE endpoint."""
from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping

from .v3_live_ridge import (LiveRidgeError, MAX_ARTIFACT_BYTES,
    _load_verified_ridge_artifact, build_live_features, score_ridge)

MAX_AUDIT_PRODUCTS = 200


def load_audit_ridge_artifact(envelope, *, expected_version, business_id,
                              scenario_id, horizon_days):
    if (isinstance(expected_version, bool) or not isinstance(expected_version, int)
            or expected_version < 1 or not isinstance(envelope, Mapping)
            or not isinstance(envelope.get("metadata"), Mapping)
            or envelope["metadata"].get("modelVersion") != expected_version):
        raise LiveRidgeError("AUDIT_VERSION_MISMATCH", "Exact execution version is required.")
    encoded = envelope.get("artifactBase64")
    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_ARTIFACT_BYTES + 2) // 3):
        raise LiveRidgeError("ARTIFACT_INVALID", "Audit artifact encoding is invalid.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise LiveRidgeError("ARTIFACT_INVALID", "Audit artifact encoding is invalid.") from error
    return _load_verified_ridge_artifact({"metadata": envelope["metadata"], "artifactData": raw},
        business_id=business_id, scenario_id=scenario_id, horizon_days=horizon_days,
        allowed_statuses=("ACTIVE", "SUPERSEDED"))


def score_audit_horizon(*, dataset, live, business_id, scenario_id, horizon_days,
                        before_version, after_version, before, after, skus):
    """Build features once per SKU on one supplied snapshot; only artifacts differ."""
    if (not isinstance(skus, list) or not skus or len(skus) > MAX_AUDIT_PRODUCTS
            or any(not isinstance(sku, str) or not sku or len(sku) > 160 for sku in skus)
            or len(set(skus)) != len(skus)):
        raise LiveRidgeError("AUDIT_PRODUCT_UNIVERSE_INVALID", "Audit SKU universe is invalid or exceeds its bound.")
    old = load_audit_ridge_artifact(before, expected_version=before_version,
        business_id=business_id, scenario_id=scenario_id, horizon_days=horizon_days)
    new = load_audit_ridge_artifact(after, expected_version=after_version,
        business_id=business_id, scenario_id=scenario_id, horizon_days=horizon_days)
    rows = []
    for sku in skus:
        try:
            features = build_live_features(dataset, live, business_id=business_id,
                scenario_id=scenario_id, sku=sku, horizon_days=horizon_days)
            rows.append({"sku": sku, "oldPrediction": score_ridge(features, old),
                         "newPrediction": score_ridge(features, new), "reasonCode": None})
        except LiveRidgeError as error:
            rows.append({"sku": sku, "oldPrediction": None, "newPrediction": None,
                         "reasonCode": error.code})
    return {"horizonDays": horizon_days, "beforeVersion": before_version,
            "afterVersion": after_version, "dataVersion": str(live.data_version),
            "snapshotHash": live.context_hash, "rows": rows}
