"""JSON replay envelope. It is deliberately incompatible with LIVE envelopes."""
import copy
from ml.service.v3_ridge_training import _artifact, digest
from ml.service.v3_live_ridge import FEATURE_HASH, FEATURE_ORDER, score_ridge

STATES = {"REPLAY_REFERENCE", "REPLAY_CANDIDATE", "REPLAY_SELECTED", "REPLAY_REJECTED"}


def pack(model, run_id, horizon, identity, state):
    if state not in STATES or horizon not in (7, 14):
        raise ValueError("REPLAY_ARTIFACT_INVALID")
    # Reuse the serializer's numerical extraction, binding the NEW in-memory
    # object to replay before hashing it. No persisted LIVE artifact is read.
    core = _artifact(model, business_id=f"REPLAY:{run_id}", horizon=horizon)
    core["scenarioId"] = "historical-ml-replay"
    core["modelVersion"] = None  # candidate is never implicitly called v2
    body = {"purpose": "REPLAY_ONLY", "demoRunId": run_id, "horizonDays": horizon,
            "identity": identity, "state": state, "featureHash": FEATURE_HASH, "model": core}
    return {**body, "sha256": digest(body)}


def verify(envelope, run_id, horizon):
    body = {k: v for k, v in envelope.items() if k != "sha256"}
    if (envelope.get("purpose") != "REPLAY_ONLY" or envelope.get("demoRunId") != run_id
            or envelope.get("horizonDays") != horizon or horizon not in (7, 14)
            or envelope.get("state") not in STATES or envelope.get("featureHash") != FEATURE_HASH
            or digest(body) != envelope.get("sha256")):
        raise ValueError("REPLAY_ARTIFACT_INTEGRITY_FAILED")
    model = envelope["model"]
    identity = envelope.get("identity", "")
    expected = (f"replay:{run_id}:{horizon}d:v1" if envelope["state"] == "REPLAY_REFERENCE" else
                f"replay:{run_id}:{horizon}d:v2" if envelope["state"] == "REPLAY_SELECTED" else None)
    if ((expected is not None and identity != expected)
            or (expected is None and not identity.startswith(f"candidate:{run_id}:{horizon}d:LEVEL_"))):
        raise ValueError("REPLAY_ARTIFACT_SCOPE_INVALID")
    if (model.get("businessId") != f"REPLAY:{run_id}" or model.get("scenarioId") != "historical-ml-replay"
            or model.get("horizonDays") != horizon or model.get("featureHash") != FEATURE_HASH):
        raise ValueError("REPLAY_ARTIFACT_SCOPE_INVALID")
    return model


def predictions(envelope, run_id, horizon, probe):
    model = verify(envelope, run_id, horizon)
    if any(set(row) != set(FEATURE_ORDER) for row in probe):
        raise ValueError("REPLAY_FEATURE_CONTRACT_INVALID")
    # Canonical JSON sorts object keys; reconstruct the strict scorer order.
    return [score_ridge({name: row[name] for name in FEATURE_ORDER}, model) for row in probe]


def transition(envelope, run_id, horizon, identity, state):
    verify(envelope, run_id, horizon)
    result = copy.deepcopy(envelope)
    result.update(identity=identity, state=state)
    result["sha256"] = digest({k: v for k, v in result.items() if k != "sha256"})
    return result
