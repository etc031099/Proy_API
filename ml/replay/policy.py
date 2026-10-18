"""Replay dates are explicit data boundaries, never a replacement LIVE clock."""
from datetime import date, timedelta

from ml.service import v3_ridge_policy as numerical
from ml.service.v3_live_ridge import FEATURE_HASH, FEATURE_ORDER

VERSION = "REPLAY-CAUSAL27-107-v1"
GENERATOR_VERSION = "REPLAY-EVIDENCE-v1"
BASELINE_ID = "canonical-prefix-2026-04-16-v1"
BASELINE_CLOSED = date(2026, 4, 16)
FINAL_CLOSED = date(2026, 8, 15)
EVALUATION_START = date(2026, 4, 17)
HORIZONS = (7, 14)
LEVELS = ("LEVEL_1_ONE_RECORD", "LEVEL_2_SEVEN_RECORDS", "LEVEL_3_FOURTEEN_RECORDS",
          "LEVEL_4_SEVEN_DAYS", "LEVEL_5_FOURTEEN_DAYS", "LEVEL_6_THIRTY_DAYS",
          "LEVEL_7_FULL_EVALUATION")


def protocol(horizon, closed):
    if horizon not in HORIZONS or isinstance(horizon, bool):
        raise ValueError("REPLAY_HORIZON_INVALID")
    numerical.load_policy()  # unchanged byte/hash checks
    start, folds = EVALUATION_START, []
    for name, length in zip(("F2", "F3", "VALIDATION"), numerical.FOLD_LENGTHS):
        end = start + timedelta(days=length - 1)
        folds.append({"split": name, "startOrigin": start.isoformat(), "endOrigin": end.isoformat(),
                      "origins": length, "trainLabelClosedThrough": (start - timedelta(days=1)).isoformat(),
                      "trainLatestOrigin": (start - timedelta(days=horizon + 1)).isoformat()})
        start = end + timedelta(days=1)
    latest = min(closed - timedelta(days=horizon), start - timedelta(days=1))
    available = max(0, (latest - EVALUATION_START).days + 1)
    return {"protocolVersion": VERSION, "purpose": "HISTORICAL_DEMONSTRATION",
            "horizonDays": horizon, "observationsClosedThrough": closed.isoformat(),
            "availableOrigins": available, "requiredOrigins": 107, "foldLengths": [31, 30, 46],
            "status": "READY" if available == 107 else "INSUFFICIENT_EVALUATION_HISTORY",
            "folds": folds}


def contract():
    numerical.load_policy()
    assert len(FEATURE_ORDER) == 27
    return {"replayPolicy": VERSION, "numericPolicy": numerical.POLICY_VERSION,
            "policyHash": numerical.POLICY_HASH, "causal27Hash": FEATURE_HASH,
            "horizons": list(HORIZONS), "requiredOrigins": 107,
            "baselineClosedThrough": BASELINE_CLOSED.isoformat(),
            "finalClosedThrough": FINAL_CLOSED.isoformat(),
            "comparisonContext": "IMMUTABLE_BASELINE_FEATURES_MODEL_SENSITIVITY_NOT_BACKTEST"}
