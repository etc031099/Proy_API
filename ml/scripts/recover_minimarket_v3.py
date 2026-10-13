"""M6.5C: audit, then one recovery of the original frozen TEST; no selection."""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np

from ml.scripts import benchmark_minimarket_v3 as b
from ml.src import v3_forecast as v
from ml.src import v3_baseline_bundle as bundle

ROOT = b.ROOT
MANIFEST = b.RUN_DIR / "recovery-manifest.json"
MARKER = b.RUN_DIR / "recovery-started.json"
RESULTS = b.RUN_DIR / "benchmark-results.json"
BASE_COMMIT = "766269afa7c9b91fe917cae3c55d37655a6777b0"


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def frozen_configuration(freeze: dict) -> dict:
    """Verify original bytes, not just equivalent hyperparameters."""
    if freeze["state"] != "TEST_EXECUTION_STARTED_DO_NOT_RERUN":
        raise ValueError("Original consumed-TEST marker must remain intact")
    if v.sha256_file(ROOT / "ml/src/v3_forecast.py") != freeze["codeSha256"]["module"]:
        raise ValueError("Forecast implementation changed since the original TEST")
    runner = (ROOT / "ml/scripts/benchmark_minimarket_v3.py").read_bytes()
    corrected = b"predict_cold_start, predict_forecast_batch, segment_membership"
    if runner.count(corrected) != 1:
        raise ValueError("Technical import fix is not identifiable")
    original = runner.replace(corrected, b"predict_cold_start, segment_membership")
    if hashlib.sha256(original).hexdigest() != freeze["codeSha256"]["runner"]:
        raise ValueError("Runner changes exceed the missing-import fix")
    split = {key: [day.isoformat() for day in days] for key, days in v.SPLITS.items()}
    if freeze["split"] != split or freeze["datasetSha256"] != v.DATASET_SHA256:
        raise ValueError("Dataset/split differs from the frozen configuration")
    if freeze["featureVersion"] != v.FEATURE_VERSION or freeze["featureSetSha256"] != v.feature_contract()["sha256"]:
        raise ValueError("Feature contract changed")
    for h in ("1", "7", "14"):
        choice = freeze["horizons"][h]
        if choice["baseline"] != "B3_MEAN_28" or choice["candidate"] is not None or choice["method"] != "BASELINE_FALLBACK":
            raise ValueError("Recovery may not select a new primary strategy")
        if freeze["selectedBaselines"][h] != choice["baseline"] or freeze["selectedModelConfigurations"][h] != {key: choice[key] for key in ("method", "candidate", "featureSet", "selectedFeatures", "hyperparameters", "fallbackSegments")}:
            raise ValueError("Frozen selection records disagree")
    if freeze["h28"]["model"] != "HGB-S-E2" or freeze["h28"]["hyperparameters"] != b.candidate_parameters("HGB-S-E2"):
        raise ValueError("Experimental candidate changed")
    if freeze["numpySeed"] != b.SEED or freeze["estimatorSeed"] != b.SEED:
        raise ValueError("Random seeds changed")
    if freeze["preTestRefitCutoff"] != "2026-08-15" or freeze["trainingCutoffs"] != {h: "2026-06-30" for h in ("1", "7", "14")}:
        raise ValueError("Fit cutoffs changed")
    if freeze["h28"]["features"] != list(v.FEATURE_SETS["E2"]) or freeze["h28"]["baseline"] != "B3_MEAN_28":
        raise ValueError("Experimental features/baseline changed")
    return {
        "datasetSha256": freeze["datasetSha256"], "dailySha256": v.DAILY_SHA256,
        "configSha256": v.CONFIG_SHA256, "codeBaseCommit": freeze["baseCommit"],
        "technicalFixCommit": BASE_COMMIT, "originalCodeSha256": freeze["codeSha256"],
        "featureVersion": freeze["featureVersion"], "featureContract": v.feature_contract(),
        "split": split, "purge": "all t+1..t+h labels must lie within split; no SKU/zero/stockout exclusions",
        "selectedBaselines": freeze["selectedBaselines"],
        "selectedModelConfigurations": freeze["selectedModelConfigurations"], "h28": freeze["h28"],
        "seeds": {"numpy": freeze["numpySeed"], "estimator": freeze["estimatorSeed"]},
        "preTestRefitCutoff": freeze["preTestRefitCutoff"],
        "segments": {"fitThrough": "2026-06-30 audit; 2026-08-15 TEST grouping", "very_low": "mean<0.5", "intermittent": "mean>=0.5 and zeroRatio>=0.5", "high_stable": "mean>=3 and zeroRatio<0.5 and populationCV<=1", "medium": "remaining"},
        "metrics": {"WAPE": "sum(abs(y-p))/sum(abs(y))", "MAE": "mean(abs(y-p))", "RMSE": "sqrt(mean((y-p)^2))", "Bias": "mean(p-y)", "normalizedBias": "sum(p-y)/sum(y)", "zeroDenominator": "null", "groups": "same original pooled per-SKU errors"},
        "gates": {"source": "M6.5A section 9 / unchanged benchmark check_acceptance", "mlRelativeWape": 0.05, "normalizedBias": 0.10, "groupRelativeDegradation": 0.10, "macroMaeRelativeDegradation": 0.10, "top10MaeRelativeDegradation": 0.20, "top10NormalizedBias": 0.20, "baseline": "original preselectedBaselineFallback; descriptive generalization, no new threshold", "h28": "experimental, never operational"},
        "postprocessing": "max(0,p); p7=max(p1,p7); p14=max(p7,p14)",
    }


def audit() -> dict:
    if MANIFEST.exists() or MARKER.exists() or RESULTS.exists():
        raise RuntimeError("Recovery audit already locked; refusing overwrite")
    freeze = json.loads(b.FREEZE_PATH.read_text(encoding="utf-8"))
    config = frozen_configuration(freeze)
    v.load_validated_dataset(ROOT)  # File/config integrity only; no TEST metrics.
    manifest = {"decision": "A", "label": "TEST_RECOVERY_RUN", "frozenConfiguration": config,
                "frozenConfigSha256": digest(config), "originalMarkerSha256": v.sha256_file(b.FREEZE_PATH),
                "recoveryCodeSha256": v.sha256_file(Path(__file__)),
                "environment": {"numpy": np.__version__, "sklearn": __import__("sklearn").__version__, "python": __import__("sys").version},
                "evidence": {"originalReportAbsent": True, "originalDirectoryFiles": sorted(p.name for p in b.RUN_DIR.iterdir()), "stdoutMetrics": "none: sole print follows final persistence", "observedTestResults": False, "postTestTuning": False, "originalFailure": "NameError: predict_forecast_batch is not defined"}}
    b.atomic_json(MANIFEST, manifest)
    return manifest


def claim_once(path: Path, manifest: dict) -> None:
    """Atomic exclusive creation: even concurrent invocations cannot reuse TEST."""
    with path.open("x", encoding="utf-8") as stream:
        json.dump({"label": "TEST_RECOVERY_RUN", "state": "STARTED_DO_NOT_RERUN", "frozenConfigSha256": manifest["frozenConfigSha256"], "startedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, stream)


def recover() -> dict:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    freeze = json.loads(b.FREEZE_PATH.read_text(encoding="utf-8"))
    config = frozen_configuration(freeze)
    if manifest["decision"] != "A" or digest(config) != manifest["frozenConfigSha256"]:
        raise ValueError("Recovery configuration is not the audited freeze")
    if v.sha256_file(b.FREEZE_PATH) != manifest["originalMarkerSha256"] or v.sha256_file(Path(__file__)) != manifest["recoveryCodeSha256"]:
        raise ValueError("Audited marker/recovery source changed")
    if MARKER.exists() or RESULTS.exists() or b.ARTIFACT_DIR.exists():
        raise RuntimeError("Recovery consumed or output already exists")
    dataset = v.load_validated_dataset(ROOT)
    np.random.seed(b.SEED)
    initial_segments = v.segment_membership(dataset, v.SPLITS["train"][1])
    test_segments = v.segment_membership(dataset, v.SPLITS["validation"][1])
    top10 = b.top_revenue_skus(dataset, v.SPLITS["train"][1])
    # Recreate only fixed experimental development diagnostics, without selection.
    name = freeze["h28"]["model"]
    estimator, features = b.candidate_from_parts(name)
    fits, cpu = [0], time.process_time()
    fold_gains = []
    for _, fit_end, start, end in v.FOLDS:
        train = b.collect_window_data(dataset, 28, b.fit_origins(fit_end, 28), v.segment_membership(dataset, fit_end))
        evaluate = b.collect_window_data(dataset, 28, [date for date in v.eligible_origins(start, end, 28)], v.segment_membership(dataset, fit_end))
        pred, _, _ = b.fit_and_predict(estimator, features, 28, train[:2], evaluate[:2], fits, cpu)
        base = b.actual_baseline(dataset, evaluate[2], 28, freeze["h28"]["baseline"])
        fold_gains.append(b.relative_improvement(v.metric_bundle(evaluate[1], base)["wape"], v.metric_bundle(evaluate[1], pred)["wape"]))
    train = b.collect_window_data(dataset, 28, b._origins("train", 28), initial_segments)
    val = b.collect_window_data(dataset, 28, b._origins("validation", 28), initial_segments)
    pred, _, _ = b.fit_and_predict(estimator, features, 28, train[:2], val[:2], fits, cpu)
    val_metrics = b.joined_metrics(val[1], pred, val[2])
    val_baseline = b.joined_metrics(val[1], b.actual_baseline(dataset, val[2], 28, freeze["h28"]["baseline"]), val[2])
    validation_gate = b.check_acceptance(val_metrics, val_baseline, 28, top10)
    train_val = b.collect_window_data(dataset, 28, b.fit_origins(v.SPLITS["validation"][1], 28), initial_segments)
    # Fit through validation; probe validation only. No TEST access before the marker.
    _, model28, _ = b.fit_and_predict(estimator, features, 28, train_val[:2], val[:2], fits, cpu)
    claim_once(MARKER, manifest)
    started = time.perf_counter()
    report = {"phase": "M6.5C", "label": "TEST_RECOVERY_RUN", "frozenConfigSha256": manifest["frozenConfigSha256"], "selection": freeze["selectedModelConfigurations"], "noRetuning": True, "test": {}, "validation": {h: freeze["horizons"][h]["coherentValidationMetrics"] for h in ("1", "7", "14")}}
    payload = {}
    for h in v.PRIMARY_HORIZONS:
        data = b.test_rows_after_lock(dataset, h, test_segments)
        predictions = {name: b.actual_baseline(dataset, data[2], h, name) for name in b.BASELINES}
        chosen = predictions[freeze["selectedBaselines"][str(h)]]
        payload[h] = (data[1], chosen, data[2])
        report["test"][str(h)] = {"strategy": "MOVING_AVERAGE_28", "baseline": "B3_MEAN_28", "finalMetrics": b.with_non_overlapping_summary(b.joined_metrics(data[1], chosen, data[2]), data[1], chosen, data[2], h), "baselineAll": {name: b.joined_metrics(data[1], p, data[2]) for name, p in predictions.items()}, "gate": {"passed": True, "checks": {"preselectedBaselineFallback": True}, "scope": "frozen baseline; no invented absolute WAPE gate"}}
        b.atomic_json(RESULTS, report)  # Persist each completed horizon before smokes.
    y, raw, meta, keys = b.align_common_horizon_rows(payload)
    coherent, count, magnitude = v.coherent_predictions(raw)
    report["coherence"] = {"commonRows": len(keys), "adjustedValues": count, "relativeMagnitude": magnitude}
    for h in v.PRIMARY_HORIZONS:
        report["test"][str(h)]["commonOriginCoherentMetrics"] = b.joined_metrics(y[h], coherent[h], meta[h])
    test28 = b.test_rows_after_lock(dataset, 28, test_segments)
    pred28 = v.apply_nonnegative(model28.predict(test28[0].loc[:, v.FEATURE_SETS[features]]))
    metrics28 = b.joined_metrics(test28[1], pred28, test28[2])
    baseline28 = b.joined_metrics(test28[1], b.actual_baseline(dataset, test28[2], 28, freeze["h28"]["baseline"]), test28[2])
    test_gate = b.check_acceptance(metrics28, baseline28, 28, top10)
    stability = sum(g is not None and g > 0 for g in fold_gains) >= 2 and np.mean([g for g in fold_gains if g is not None]) >= 0 and not any(g is not None and g < -0.10 for g in fold_gains)
    report["test"]["28"] = {"candidate": name, "experimental": True, "operational": False, "finalMetrics": metrics28, "baselineMetrics": baseline28, "validationGate": validation_gate, "testGate": test_gate, "foldGains": fold_gains, "foldStabilityPassed": bool(stability), "approvedExperimental": bool(validation_gate["passed"] and test_gate["passed"] and stability)}
    report["testEvaluationSeconds"] = time.perf_counter() - started
    report["fitCountRecovery"] = fits[0]
    report["state"] = "TEST_RECOVERY_COMPLETE_NO_RETUNING"
    b.atomic_json(RESULTS, report)
    # Inference reproducibility uses the final cutoff, not another TEST evaluation.
    first = v.predict_forecast_batch(dataset, prediction_origin=v.HISTORY_END, skus=sorted(dataset.product_by_sku), strategy_by_horizon=freeze["horizons"])
    second = v.predict_forecast_batch(dataset, prediction_origin=v.HISTORY_END, skus=sorted(dataset.product_by_sku), strategy_by_horizon=freeze["horizons"])
    if len(first) != 80 or any(a["forecast"] != c["forecast"] for a, c in zip(first, second)):
        raise ValueError("Deterministic baseline inference smoke failed")
    report["reproducibility"] = {"scope": "deterministic final-cutoff inference, no holdout reevaluation", "products": 80, "maxDelta": 0.0}
    bundle_manifest = {
        "strategyVersion": bundle.STRATEGY_VERSION, "forecastStrategy": "MOVING_AVERAGE_28",
        "datasetSha256": v.DATASET_SHA256, "datasetVersion": v.DATASET_VERSION,
        "scenarioId": v.SCENARIO_ID, "config": bundle.configuration(), "configSha256": bundle.config_hash(),
        "frozenConfigSha256": manifest["frozenConfigSha256"], "featureVersion": v.FEATURE_VERSION,
        "cutoffDate": v.HISTORY_END.isoformat(), "evaluationLabel": "TEST_RECOVERY_RUN",
        "metrics": {h: report["test"][h]["finalMetrics"]["overall"] for h in ("1", "7", "14")},
        "experimental28d": "separate report only; no operational artifact",
        "limitations": ["synthetic scenario", "effective sales, not unconstrained demand", "no probability/confidence interval", "no current/cloud serving activation", "baseline approval uses preselected fallback policy; no new absolute WAPE threshold"],
    }
    path = b.ARTIFACT_DIR / "baseline-manifest.json"
    b.atomic_json(path, bundle_manifest)
    bundle.load_manifest(path)
    report["bundle"] = {"path": str(path.relative_to(ROOT)), "sha256": v.sha256_file(path), "joblib": False}
    report["inferenceContract"] = bundle.predict(dataset, sku=sorted(dataset.product_by_sku)[0], cutoff=v.HISTORY_END)
    b.atomic_json(RESULTS, report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("audit", "recover"))
    args = parser.parse_args()
    result = audit() if args.mode == "audit" else recover()
    print(json.dumps({"mode": args.mode, "decision": result.get("decision"), "state": result.get("state"), "frozenConfigSha256": result["frozenConfigSha256"]}))
