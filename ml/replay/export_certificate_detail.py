"""Development-only export of the fixed cert-stable-2020 replay. No runtime entrypoint.

Reconstructs the saved replay dataset, repeats only its six temporal fits, and
captures samples at the existing aggregation boundary without changing ML code.
Publication fails closed unless the whole evaluation matches the saved result.
"""
import os
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_name, "1")

import hashlib
import json
import math
import sys
from pathlib import Path
from unittest.mock import patch

from threadpoolctl import threadpool_limits
from ml.replay import policy
from ml.replay.dataset import ReplayDataset, load_source
from ml.replay.run_store import RunStore
from ml.service import v3_ridge_training as trainer, v3_ridge_policy as numerical

ROOT = Path(__file__).resolve().parents[2]
RUN_ID = "cert-stable-2020"
DESTINATION = ROOT / "backend/src/evidence/forecast-replay/cert-stable-2020-detail.json"
SUMMARY = DESTINATION.with_name("cert-stable-2020.json")


def require(condition, code="REPLAY_CERTIFICATE_MISMATCH"):
    if not condition:
        raise ValueError(code)


def equivalent(actual, expected):
    if isinstance(actual, dict) and isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(equivalent(actual[k], expected[k]) for k in actual)
    if isinstance(actual, list) and isinstance(expected, list):
        return len(actual) == len(expected) and all(equivalent(a, b) for a, b in zip(actual, expected))
    if type(actual) in (float, int) and type(expected) in (float, int):
        return math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-10)
    return type(actual) is type(expected) and actual == expected


def origin_rows(split, samples):
    # One origin groups all SKU evaluation rows. These are overlapping horizon
    # targets, not distinct operational sales or independent statistical samples.
    rows = []
    for origin in sorted({s["origin"] for s in samples}):
        selected = [s for s in samples if s["origin"] == origin]
        actual = [s["actual"] for s in selected]
        rows.append({"origin": origin, "fold": split, "sampleCount": len(selected),
            "actualUnits": sum(actual),
            "candidateUnits": sum(s["prediction"] for s in selected),
            "baselineUnits": sum(s["baseline"] for s in selected),
            "candidate": numerical.metric_bundle(actual, [s["prediction"] for s in selected]),
            "baseline": numerical.metric_bundle(actual, [s["baseline"] for s in selected])})
    return rows


def focal_evidence(decision):
    rule = "P_FOLD_CATA_MAE:F3:BEB-GAS-003"
    require(rule in decision["reasons"] and decision["checks"][rule] is False)
    fold = next(f for f in decision["folds"] if f["split"] == "F3")
    sku = "BEB-GAS-003"
    priority = next(s for s in decision["prioritySkuChecks"]["items"] if s["sku"] == sku)
    check = next(f for f in priority["supportedFoldChecks"] if f["split"] == "F3")
    threshold = numerical.load_policy()["priority"]["supportedFoldMaeRatioCatastrophicMax"]
    return {"horizonDays": 14, "fold": "F3", "sku": sku, "ruleKey": rule,
        "support": check["support"], "candidateMae": fold["metrics"]["sku"][sku]["mae"],
        "baselineMae": fold["baseline"]["sku"][sku]["mae"], "ratio": check["maeRatio"],
        "threshold": threshold, "operator": "<=", "passed": decision["checks"][rule]}


def export():
    store = RunStore(RUN_ID)
    store.owned()
    require(not (store.path / "run.lock").exists(), "REPLAY_RUN_BUSY")
    manifest = store.read("manifest.json")
    formal = store.read("formal-evaluation.json")
    report = store.read("report.json")
    summary = json.loads(SUMMARY.read_text(encoding="utf-8"))
    require(all(manifest[k] == v for k, v in {"demoRunId": RUN_ID, "seed": 2020,
        "profile": "STABLE", "purpose": "REPLAY_ONLY", "requiredOrigins": 107,
        "currentLevel": policy.LEVELS[-1], "policyHash": numerical.POLICY_HASH,
        "numericPolicy": numerical.POLICY_VERSION, "replayPolicy": policy.VERSION}.items()))
    require(all(summary[k] == manifest[k] for k in ("demoRunId", "seed", "profile", "purpose", "requiredOrigins")))
    require(equivalent(manifest["formalEvaluation"], formal))
    require(report["stages"] == manifest["candidateResults"])
    source = load_source(ROOT)
    require(source.manifest["hashes"]["logicalDatasetSha256"] == manifest["sourceDatasetHash"])
    evidence = store.read(f"evidence/{policy.LEVELS[-1]}.json")
    view = ReplayDataset(source, evidence)
    require(view.hash == manifest["datasetHash"])
    horizons = []
    original_fold = numerical.fold_from_samples
    with threadpool_limits(limits=1):
        for h in (7, 14):
            captured = []

            def capture(split, samples, top10):
                result = original_fold(split, samples, top10)
                captured.extend(origin_rows(split, samples))
                return result

            frame, labels, origins = view.examples(h)
            with patch.object(numerical, "fold_from_samples", side_effect=capture):
                decision = trainer.evaluate_temporal(frame, labels.tolist(), origins, h,
                    policy.protocol(h, view.closed), view.units, view.revenue())
            require(equivalent(decision, formal[str(h)]), "REPLAY_REEVALUATION_MISMATCH")
            certified = next(s for s in summary["horizons"] if s["horizonDays"] == h)
            require(decision["status"] == certified["status"] and decision["reasons"] == certified["reasons"])
            require(equivalent({"wape": decision["model"]["wape"], "mae": decision["model"]["mae"],
                "normalizedBias": decision["model"]["normalized_bias"],
                "relativeWapeImprovement": decision["relativeWapeImprovement"]}, certified["metrics"]))
            require(len(captured) == len({r["origin"] for r in captured}) == 107)
            folds = [{"order": i + 1, "key": f["split"], **f["temporalBoundary"]}
                     for i, f in enumerate(decision["folds"])]
            horizons.append({"horizonDays": h, "status": decision["status"],
                "candidate": decision["model"], "baseline": decision["baseline"],
                "globalChecks": decision["globalChecks"], "foldChecks": decision["foldChecks"],
                "allCheckCount": len(decision["checks"]),
                "passedCheckCount": sum(decision["checks"].values()),
                "reasons": decision["reasons"], "folds": folds, "origins": captured,
                "focalEvidence": focal_evidence(decision) if h == 14 else None})
    # No timestamps, paths, coefficients or full per-SKU samples are published.
    result = {"schemaVersion": "FORECAST_REPLAY_DETAIL_V1", "demoRunId": RUN_ID,
        "purpose": "REPLAY_ONLY", "seed": 2020, "profile": "STABLE", "requiredOrigins": 107,
        "reference": "MA28", "policy": {**summary["policy"], "numericPolicySha256": numerical.POLICY_HASH},
        "provenance": {"sourceDatasetSha256": manifest["sourceDatasetHash"],
            "replayDatasetSha256": manifest["datasetHash"], "formalEvaluationSha256": trainer.digest(formal),
            "summaryFileSha256": hashlib.sha256(SUMMARY.read_bytes()).hexdigest(),
            "comparisonTolerance": {"relative": 1e-10, "absolute": 1e-10}},
        "liveImpact": summary["liveImpact"], "horizons": horizons}
    raw = trainer.canonical(result) + b"\n"
    DESTINATION.write_bytes(raw)
    return {"status": "CERTIFIED", "demoRunId": RUN_ID, "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(), "originsPerHorizon": 107}


if __name__ == "__main__":
    try:
        print(json.dumps(export()))
    except Exception as error:
        code = str(error)
        safe = code if code.startswith("REPLAY_") and code.replace("_", "").isalnum() else "REPLAY_CERTIFICATE_EXPORT_FAILED"
        print(json.dumps({"status": "FAILED", "code": safe, "exceptionType": type(error).__name__}))
        sys.exit(1)
