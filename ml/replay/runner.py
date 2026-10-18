"""CLI: python -m ml.replay.runner run|prepare|advance|report|reset. Local only."""
import os
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_name, "1")

import argparse
import copy
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from threadpoolctl import threadpool_limits

from ml.service import v3_ridge_training as trainer
from ml.service import v3_ridge_policy as numerical
from ml.service.v3_live_ridge import FEATURE_ORDER
from . import artifacts, policy
from .dataset import ReplayDataset, empty_evidence, load_source
from .generator import Generator
from .run_store import RunStore

REPOSITORY = Path(__file__).resolve().parents[2]


def fit(view, horizon, run_id, identity, state):
    start = time.perf_counter()
    frame, labels, origins = view.examples(horizon)
    model = trainer.recipe().fit(frame, labels)
    envelope = artifacts.pack(model, run_id, horizon, identity, state)
    expected = np.maximum(model.predict(frame.iloc[-len(view.skus):]), 0)
    actual = artifacts.predictions(envelope, run_id, horizon,
        [{name: row[name] for name in FEATURE_ORDER} for row in frame.iloc[-len(view.skus):].to_dict("records")])
    parity = max(abs(float(a) - float(b)) for a, b in zip(expected, actual))
    if parity > 1e-10:
        raise ValueError("REPLAY_ARTIFACT_PARITY_FAILED")
    predicted = np.maximum(model.predict(frame), 0).tolist()
    details = {"trainingRows": len(frame), "trainingOrigins": len(set(origins)),
        "featureHash": trainer.digest(frame.to_dict("records")), "targetHash": trainer.digest(labels.tolist()),
        "inSampleMetrics": {"scope": "TRAIN_IN_SAMPLE_DIAGNOSTIC_NOT_POLICY",
                            **numerical.metric_bundle(labels.tolist(), predicted)},
        "parityMaxAbsoluteError": parity, "seconds": round(time.perf_counter() - start, 4)}
    return envelope, details, (frame, labels, origins)


def prepare(store, source, seed, profile, session=None):
    store.create()
    with store.lock(), threadpool_limits(limits=1):
        view = ReplayDataset(source, empty_evidence())
        gen = Generator(source, seed, profile)
        manifest = {**policy.contract(), "purpose": "REPLAY_ONLY", "demoRunId": store.run_id,
            "seed": seed, "profile": profile, "generatorVersion": policy.GENERATOR_VERSION,
            "baselineId": policy.BASELINE_ID, "datasetHash": view.hash,
            "sourceDatasetHash": source.manifest["hashes"]["logicalDatasetSha256"],
            "createdAt": datetime.now(timezone.utc).isoformat(), "currentLevel": "BASELINE",
            "generatedCounts": {"saleOperations": 0, "completeDays": 0, "replenishments": 0},
            "generatedRange": None, "baselineTransactionCount": source.replay_baseline_sale_count,
            "witnessSku": gen.witness_sku, "candidateResults": [], "formalEvaluation": None,
            "selectedVersions": {}, "baselineModels": {}, "sanitizedFailureCode": None}
        for h in policy.HORIZONS:
            identity = f"replay:{store.run_id}:{h}d:v1"
            envelope, info, _ = fit(view, h, store.run_id, identity, "REPLAY_REFERENCE")
            store.save(f"baseline/{h}.json", envelope, exclusive=True)
            probe = view.probe(h)
            store.save(f"baseline/probe-{h}.json", probe, exclusive=True)
            manifest["baselineModels"][str(h)] = {"identity": identity, "sha256": envelope["sha256"],
                "comparisonContextHash": trainer.digest(probe),
                "predictionMean": float(np.mean(artifacts.predictions(envelope, store.run_id, h, probe))), **info}
            manifest["selectedVersions"][str(h)] = identity
        store.save("baseline/manifest.json", manifest, exclusive=True)
        store.save("manifest.json", manifest)
        if session is not None:
            session.update(view=view, evidence=empty_evidence())
        return manifest


def advance(store, source, session=None):
    with store.lock(), threadpool_limits(limits=1):
        manifest = store.read("manifest.json")
        baseline_manifest = store.read("baseline/manifest.json")
        if manifest["replayPolicy"] != policy.VERSION or manifest["policyHash"] != numerical.POLICY_HASH:
            raise ValueError("REPLAY_CONTRACT_MISMATCH")
        previous = manifest["currentLevel"]
        index = 0 if previous == "BASELINE" else policy.LEVELS.index(previous) + 1
        if index == len(policy.LEVELS):
            return manifest
        evidence = empty_evidence() if index == 0 else store.read(f"evidence/{previous}.json")
        if session is not None and "view" in session:
            view = session["view"]
            if view.hash != manifest["datasetHash"]:
                raise ValueError("REPLAY_SESSION_MISMATCH")
        else:
            view = ReplayDataset(source, evidence)  # resume the durable checkpoint
        level = policy.LEVELS[index]
        gen = Generator(source, manifest["seed"], manifest["profile"])
        records_added = gen.append(evidence, level)
        view.apply(evidence)  # append to the same view throughout a run
        results, formal = {}, {}
        for h in policy.HORIZONS:
            original = store.read(f"baseline/{h}.json")
            if original["sha256"] != baseline_manifest["baselineModels"][str(h)]["sha256"]:
                raise ValueError("REPLAY_BASELINE_CHANGED")
            probe = store.read(f"baseline/probe-{h}.json")
            if trainer.digest(probe) != baseline_manifest["baselineModels"][str(h)]["comparisonContextHash"]:
                raise ValueError("REPLAY_BASELINE_CHANGED")
            identity = f"candidate:{store.run_id}:{h}d:{level}"
            candidate, info, (frame, labels, origins) = fit(view, h, store.run_id, identity, "REPLAY_CANDIDATE")
            old = artifacts.predictions(original, store.run_id, h, probe)
            new = artifacts.predictions(candidate, store.run_id, h, probe)
            changed_rows = sum(a != b for a, b in zip(probe, view.probe(h)))
            old_coeff = np.array(original["model"]["coefficients"])
            new_coeff = np.array(candidate["model"]["coefficients"])
            mean_old, mean_new = float(np.mean(old)), float(np.mean(new))
            coefficient_delta = float(np.linalg.norm(new_coeff - old_coeff))
            delta = mean_new - mean_old
            info.update(identity=identity, artifactHash=candidate["sha256"],
                inferenceFeatureRowsChangedAtBaselineOrigin=changed_rows,
                coefficientsL2Delta=coefficient_delta,
                interceptDelta=candidate["model"]["intercept"] - original["model"]["intercept"],
                trainingFeaturesChangedFromBaseline=info["featureHash"] != baseline_manifest["baselineModels"][str(h)]["featureHash"],
                trainingTargetsChangedFromBaseline=info["targetHash"] != baseline_manifest["baselineModels"][str(h)]["targetHash"],
                baselinePredictionMean=mean_old, candidatePredictionMean=mean_new,
                delta=delta, absoluteDelta=abs(delta), deltaPct=100 * delta / mean_old if mean_old else None,
                comparisonContextHash=trainer.digest(probe),
                measurablePredictionChange=any(abs(a - b) > 1e-10 for a, b in zip(old, new)),
                predictions=[{"sku": s, "baseline": a, "candidate": b, "delta": b - a}
                             for s, a, b in zip(view.skus, old, new)])
            proto = policy.protocol(h, view.closed)
            info["availableEvaluationOrigins"] = proto["availableOrigins"]
            if index == 6:
                if proto["status"] != "READY":
                    raise ValueError("REPLAY_HISTORY_INCOMPLETE")
                decision = trainer.evaluate_temporal(frame, labels.tolist(), origins, h, proto,
                    view.units, view.revenue())
                formal[str(h)] = decision
                if decision["status"] == "PASS":
                    selected = f"replay:{store.run_id}:{h}d:v2"
                    chosen = artifacts.transition(candidate, store.run_id, h, selected, "REPLAY_SELECTED")
                    store.save(f"candidates/selected-{h}.json", chosen)
                    manifest["selectedVersions"][str(h)] = selected
                else:
                    candidate = artifacts.transition(candidate, store.run_id, h, identity, "REPLAY_REJECTED")
            info["state"] = "REPLAY_SELECTED" if formal.get(str(h), {}).get("status") == "PASS" else candidate["state"]
            results[str(h)] = info
            store.save(f"candidates/{level}-{h}.json", candidate)
        stage = {"stage": level, "recordsAdded": records_added,
            "totalGeneratedRecords": len(evidence["operations"]),
            "totalRecords": manifest["baselineTransactionCount"] + len(evidence["operations"]),
            "recordSemantics": "COMPLETED_SALE_OPERATIONS_NOT_ORIGINS",
            "dateRange": [policy.BASELINE_CLOSED.isoformat(), view.closed.isoformat()],
            "datasetRowCount": view.row_count, "datasetHash": view.hash,
            "completeDaysAdded": len(evidence["completeDays"]), "horizons": results,
            "policyEvaluated": index == 6,
            "policyResult": {h: v["status"] for h, v in formal.items()} if formal else None,
            "selectedVersions": copy.deepcopy(manifest["selectedVersions"])}
        store.save(f"evidence/{level}.json", evidence)
        manifest.update(currentLevel=level, datasetHash=view.hash,
            generatedCounts={"saleOperations": len(evidence["operations"]),
                             "completeDays": len(evidence["completeDays"]), "replenishments": len(view.replenishments)},
            generatedRange=stage["dateRange"], sanitizedFailureCode=None)
        manifest["candidateResults"].append(stage)
        if formal:
            manifest["formalEvaluation"] = formal
            store.save("formal-evaluation.json", formal)
        store.save("manifest.json", manifest)  # checkpoint only after both horizons finish
        store.save("report.json", report(manifest))
        if session is not None:
            session.update(view=view, evidence=evidence)
        return manifest


def report(manifest):
    return {"purpose": "REPLAY_ONLY", "demoRunId": manifest["demoRunId"],
        "comparison": manifest["comparisonContext"],
        "warning": "Prediction changes are model sensitivity, not evidence of better forecasts. Intermediate metrics are in-sample.",
        "stages": manifest["candidateResults"], "selectedVersions": manifest["selectedVersions"]}


def table(manifest):
    header = "Stage | +Records | Total records | Date range | Origins 7/14 | P7 v1 | P7 candidate | Delta P7 | P14 v1 | P14 candidate | Delta P14 | Policy evaluated? | Policy result | Selected"
    baseline = [manifest["baselineModels"][str(h)]["predictionMean"] for h in (7, 14)]
    rows = [header, f"BASELINE | 0 | {manifest['baselineTransactionCount']} | 2025-10-13..2026-04-16 | 0/0 | "
            f"{baseline[0]:.12g} | {baseline[0]:.12g} | 0 | {baseline[1]:.12g} | {baseline[1]:.12g} | 0 | NO | NOT_EVALUATED | 7:v1,14:v1"]
    for stage in manifest["candidateResults"]:
        a, b = stage["horizons"]["7"], stage["horizons"]["14"]
        values = [stage["stage"], str(stage["recordsAdded"]), str(stage["totalRecords"]),
            "..".join(stage["dateRange"]), f"{a['availableEvaluationOrigins']}/{b['availableEvaluationOrigins']}"]
        values += [f"{row[key]:.12g}" for row in (a, b)
                   for key in ("baselinePredictionMean", "candidatePredictionMean", "delta")]
        values += ["YES" if stage["policyEvaluated"] else "NO",
                   json.dumps(stage["policyResult"]) if stage["policyEvaluated"] else "NOT_EVALUATED",
                   ",".join(f"{h}:{v.rsplit(':', 1)[-1]}" for h, v in stage["selectedVersions"].items())]
        rows.append(" | ".join(values))
    return "\n".join(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "advance", "run", "report", "reset"))
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--profile", choices=("STABLE", "SHIFT"))
    args = parser.parse_args()
    store = RunStore(args.run_id)
    start = time.perf_counter()
    try:
        if args.command == "reset":
            manifest = store.reset()
        elif args.command == "report":
            store.owned()
            manifest = store.read("manifest.json")
        else:
            source = load_source(REPOSITORY)
            session = {}
            if store.path.exists():
                existing = store.read("manifest.json")
                if ((args.seed is not None and args.seed != existing["seed"])
                        or (args.profile is not None and args.profile != existing["profile"])):
                    raise ValueError("REPLAY_GENERATOR_CONFIG_MISMATCH")
            if args.command == "prepare" or (args.command == "run" and not store.path.exists()):
                manifest = prepare(store, source, 2026 if args.seed is None else args.seed,
                                   args.profile or "STABLE", session)
            if args.command in ("advance", "run"):
                manifest = advance(store, source, session)
                while args.command == "run" and manifest["currentLevel"] != policy.LEVELS[-1]:
                    print(json.dumps({"completed": manifest["currentLevel"], "purpose": "REPLAY_ONLY"}), flush=True)
                    manifest = advance(store, source, session)
        print(table(manifest))
        print(json.dumps({"purpose": "REPLAY_ONLY", "currentLevel": manifest["currentLevel"],
            "seconds": round(time.perf_counter() - start, 3), "manifestDirectory": str(store.path)}))
        return 0
    except Exception as error:
        # No raw paths/payload/tracebacks; safe code plus type only.
        code = str(error) if str(error).startswith("REPLAY_") and len(str(error)) < 100 else "REPLAY_FAILED"
        if store.path.exists() and (store.path / "manifest.json").exists():
            try:
                with store.lock():
                    manifest = store.read("manifest.json")
                    manifest["sanitizedFailureCode"] = code
                    store.save("manifest.json", manifest)
            except Exception:
                pass
        print(json.dumps({"purpose": "REPLAY_ONLY", "code": code, "exceptionType": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
