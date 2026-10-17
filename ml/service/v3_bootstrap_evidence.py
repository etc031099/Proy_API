"""Pinned authorization evidence, never a fitted model or a runtime experiment."""
import hashlib
import json
from pathlib import Path

EVIDENCE_PATH = Path(__file__).with_name("forecast_bootstrap_evidence_v1.json")
EVIDENCE_HASH = "008927803998f5b628b300b71edc30147383c6bd3aa392daf63038b53d2873de"
POLICY_HASH = "522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3"
FEATURE_HASH = "84e928e62343eb9d9b7d9e0dc8843ea8e9395ae135997287f5b7ea3a02a860f5"


def load_evidence(horizon, expected_hash=EVIDENCE_HASH):
    if horizon not in (7, 14) or isinstance(horizon, bool):
        raise ValueError("MODEL_NOT_APPROVED")
    raw = EVIDENCE_PATH.read_bytes()
    if expected_hash != EVIDENCE_HASH or hashlib.sha256(raw).hexdigest() != EVIDENCE_HASH:
        raise ValueError("BOOTSTRAP_EVIDENCE_HASH_MISMATCH")
    data = json.loads(raw)
    if (data["promotionPolicyHash"] != POLICY_HASH or data["featureHash"] != FEATURE_HASH
            or data["recipeId"] != "RIDGE-CAUSAL27"
            or data["featureVersion"] != "RIDGE_CAUSAL27_V1"
            or data["promotionPolicyVersion"] != "M6.10A22-PROMOTION-v1"
            or set(data["horizons"]) != {"7", "14"} or data["excludedHorizons"] != [1]):
        raise ValueError("BOOTSTRAP_EVIDENCE_INVALID")
    decision = data["horizons"][str(horizon)]
    if (decision["candidate"] != data["recipeId"] or decision["horizon"] != horizon
            or not all(decision[k] is True for k in ("eligible", "qualityPassed", "causalEligible"))
            or not decision["checks"] or not all(v is True for v in decision["checks"].values())
            or decision["reasons"]):
        raise ValueError("BOOTSTRAP_EVIDENCE_INVALID")
    return decision
