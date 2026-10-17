"""Internal, fail-closed Ridge27 trainer. JSON stdin/stdout; never a public API."""
from __future__ import annotations

import hashlib
import json
import math
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from ml.service import v3_live_ridge as live_ridge
from ml.service import v3_ridge_policy as policy
from ml.service import v3_bootstrap_evidence as bootstrap_evidence
from ml.src import v3_forecast

ROOT = Path(__file__).resolve().parents[2]
LIMA = ZoneInfo("America/Lima")
HISTORICAL = v3_forecast.HISTORY_END
FIRST_ORIGIN = v3_forecast.FIRST_ORIGIN
BUSINESS_ID = "MINIMARKET-PASCO-V3"
EVIDENCE = bootstrap_evidence.EVIDENCE_PATH
POLICY = policy.POLICY_PATH


class TrainingError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def recipe() -> Pipeline:
    """The frozen A.1/A.2.2 Ridge27 estimator, using A.3.2's feature order."""
    cats = list(live_ridge.CATEGORICAL_FEATURES)
    nums = list(live_ridge.NUMERIC_FEATURES)
    pre = ColumnTransformer([
        ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=True), cats),
        ("num", StandardScaler(), nums),
    ], sparse_threshold=1.0)
    return Pipeline([("preprocessing", pre),
                     ("estimator", Ridge(alpha=10.0, solver="lsqr", tol=0.0001))])


def _day(value: str) -> date:
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() == value:
            return parsed
    except (ValueError, TypeError):
        pass
    raise TrainingError("DATASET_INVALID")


def _timestamp(value: object) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo and parsed.utcoffset() is not None:
            return parsed
    except ValueError:
        pass
    raise TrainingError("DATASET_INVALID")


def _journal_overlay(dataset: v3_forecast.V3Dataset, journal: list[dict], closed: date):
    """Replay the complete version-pinned journal, including historical cancellations."""
    if not isinstance(journal, list):
        raise TrainingError("DATASET_INVALID")
    ordered = sorted(journal, key=lambda row: (int(row["revision"]), row["eventOrdinal"]))
    if len({(row["revision"], row["eventOrdinal"]) for row in ordered}) != len(ordered):
        raise TrainingError("DATASET_INVALID")
    catalog = []
    sales = {}
    cancelled = set()
    for row in ordered:
        if row.get("entityType") == "product":
            change = dict(row)
            change["effectiveAtUtc"] = _timestamp(row["effectiveAtUtc"])
            catalog.append(change)
        elif row.get("entityType") == "sale" and row.get("operation") == "CREATE":
            sale = row.get("projection")
            if not isinstance(sale, dict) or not sale.get("saleKey") or sale["saleKey"] in sales:
                raise TrainingError("DATASET_INVALID")
            sales[sale["saleKey"]] = sale
        elif row.get("entityType") == "transaction" and row.get("operation") == "CANCEL":
            projection = row.get("projection") or {}
            if projection.get("type") == "sale":
                key = projection.get("transactionKey")
                if not isinstance(key, str) or key in cancelled:
                    raise TrainingError("DATASET_INVALID")
                cancelled.add(key)
    historic_cancels = cancelled.difference(sales)
    if historic_cancels:
        sale_rows = v3_forecast.read_ndjson(ROOT / "data/minimarket-pasco-v3/generated/sales.ndjson")
        known = {row["saleCode"]: row for row in sale_rows}
        if not historic_cancels.issubset(known):
            raise TrainingError("DATASET_INVALID")
        for line in v3_forecast.read_ndjson(ROOT / "data/minimarket-pasco-v3/generated/sale-items.ndjson"):
            code = line["saleCode"]
            if code not in historic_cancels:
                continue
            old = known[code]
            if old.get("status") != "completed":
                raise TrainingError("DATASET_INVALID")
            record = dataset.inventory[line["sku"]][old["localDate"]]
            remaining = record["unitsSold"] - int(line["unitsSold"])
            if remaining < 0:
                raise TrainingError("DATASET_INVALID")
            record["unitsSold"] = remaining
    product_keys = {row["productKey"]: row["sku"] for row in dataset.products}
    daily = {}
    for row in catalog:
        if row["effectiveAtUtc"].astimezone(LIMA).date() > closed:
            continue
        projection = row.get("projection") or {}
        after = projection.get("after") or {}
        if after.get("productKey") and after.get("sku"):
            if after["productKey"] not in product_keys:
                # New SKU quality is not certified by the frozen bootstrap evidence.
                raise TrainingError("FEATURE_UNAVAILABLE")
            product_keys[after["productKey"]] = after["sku"]
    for key, sale in sales.items():
        if key in cancelled or sale.get("initialStatus") != "completed":
            continue
        day = _day(sale.get("localDate"))
        if day > closed:
            continue  # open operational day is journaled but is not a mature observation
        if day <= HISTORICAL or _timestamp(sale.get("occurredAtUtc")).astimezone(LIMA).date() != day:
            raise TrainingError("DATASET_INVALID")
        for line in sale.get("lines", []):
            product_key = line.get("productKey")
            sku = product_keys.get(product_key)
            quantity = line.get("quantity")
            if sku != line.get("sku") or isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 0:
                raise TrainingError("DATASET_INVALID")
            daily[(product_key, day)] = daily.get((product_key, day), 0) + quantity
    closed_rows = {}
    for product_key in product_keys:
        for offset in range(max(0, (closed - HISTORICAL).days)):
            day = HISTORICAL + timedelta(days=offset + 1)
            closed_rows[(product_key, day)] = {
                "unitsSold": daily.get((product_key, day), 0), "completeness": "COMPLETE"}
    return catalog, closed_rows, product_keys


def _live_row(dataset, catalog, closed_rows, *, business_id, horizon, sku, origin, data_version):
    metadata = SimpleNamespace(scenarioId=v3_forecast.SCENARIO_ID, businessId=business_id,
                               snapshotHash="training", dataVersion=data_version,
                               asOfDate=origin + timedelta(days=1), observationsClosedThrough=origin)
    context = SimpleNamespace(snapshot=SimpleNamespace(metadata=metadata, catalogChanges=catalog),
                              context_hash="training", data_version=data_version,
                              closed_sales_by_product_day=closed_rows)
    return live_ridge.build_live_features(dataset, context, business_id=business_id,
                                         scenario_id=v3_forecast.SCENARIO_ID, sku=sku,
                                         horizon_days=horizon)


def _approved_evidence(horizon: int, expected_hash=bootstrap_evidence.EVIDENCE_HASH) -> dict:
    if not POLICY.is_file() or not EVIDENCE.is_file():
        raise TrainingError("BOOTSTRAP_EVIDENCE_UNAVAILABLE")
    if hashlib.sha256(POLICY.read_bytes()).hexdigest() != live_ridge.PROMOTION_POLICY_HASH:
        raise TrainingError("PROMOTION_POLICY_MISMATCH")
    try:
        return bootstrap_evidence.load_evidence(horizon, expected_hash)
    except (ValueError, KeyError, OSError) as error:
        code = str(error) if str(error).startswith("BOOTSTRAP_") else "BOOTSTRAP_EVIDENCE_INVALID"
        raise TrainingError(code) from None


def _artifact(model: Pipeline, *, business_id: str, horizon: int) -> dict:
    pre = model.named_steps["preprocessing"]
    encoded = pre.named_transformers_["cat"]
    scaler = pre.named_transformers_["num"]
    ridge = model.named_steps["estimator"]
    return {
        "schemaVersion": live_ridge.ARTIFACT_SCHEMA_VERSION, "businessId": business_id,
        "scenarioId": v3_forecast.SCENARIO_ID, "horizonDays": horizon,
        "modelFamily": live_ridge.MODEL_FAMILY, "recipeId": live_ridge.RECIPE_ID,
        "featureVersion": live_ridge.FEATURE_VERSION, "featureHash": live_ridge.FEATURE_HASH,
        "modelVersion": None,
        "categoricalFeatures": list(live_ridge.CATEGORICAL_FEATURES),
        "numericFeatures": list(live_ridge.NUMERIC_FEATURES),
        "categories": {name: list(map(str, values)) for name, values in
                       zip(live_ridge.CATEGORICAL_FEATURES, encoded.categories_)},
        "scalerMean": scaler.mean_.astype(float).tolist(),
        "scalerScale": scaler.scale_.astype(float).tolist(),
        "coefficients": ridge.coef_.astype(float).tolist(), "intercept": float(ridge.intercept_),
        "alpha": 10.0, "solver": "lsqr", "tol": 0.0001,
    }


def revenue_history(journal):
    """Observed revenue only, keyed by sale date; no future revenue ranking."""
    cancelled = {(r.get("projection") or {}).get("transactionKey") for r in journal
                 if r.get("entityType") == "transaction" and r.get("operation") == "CANCEL"}
    sales = {r["saleCode"]: r for r in v3_forecast.read_ndjson(ROOT / "data/minimarket-pasco-v3/generated/sales.ndjson")}
    revenue = []
    for line in v3_forecast.read_ndjson(ROOT / "data/minimarket-pasco-v3/generated/sale-items.ndjson"):
        sale = sales[line["saleCode"]]
        if sale["status"] == "completed" and sale["saleCode"] not in cancelled:
            revenue.append((sale["localDate"], line["sku"], line["lineTotalCents"]))
    for change in journal:
        if change.get("entityType") != "sale" or change.get("operation") != "CREATE":
            continue
        sale = change["projection"]
        if sale["saleKey"] in cancelled or sale.get("initialStatus") != "completed":
            continue
        for line in sale["lines"]:
            cents = line.get("lineTotalCents")
            if isinstance(cents, bool) or not isinstance(cents, int) or cents < 0:
                raise TrainingError("FEATURE_UNAVAILABLE")
            revenue.append((sale["localDate"], line["sku"], cents))
    return revenue


def evaluate_temporal(frame, labels, origins, horizon, protocol, daily_units, revenue,
                      estimator_factory=recipe):
    """Three causal fits; final production refit remains separate from validation fits."""
    folds = []
    skus = sorted(set(frame["sku"]))
    for cut in protocol["folds"]:
        first, last = _day(cut["startOrigin"]), _day(cut["endOrigin"])
        train_indices = [i for i, origin in enumerate(origins) if origin + timedelta(days=horizon) < first]
        eval_indices = [i for i, origin in enumerate(origins) if first <= origin <= last]
        if not train_indices or len(eval_indices) != cut["origins"] * len(skus):
            raise TrainingError("INSUFFICIENT_EVALUATION_HISTORY")
        fit_end = first - timedelta(days=1)
        segments = {}
        for sku in skus:
            values = []
            day = v3_forecast.HISTORY_START
            while day <= fit_end:
                values.append(daily_units(sku, day))
                day += timedelta(days=1)
            mean = float(np.mean(values))
            zero_rate = float(np.mean(np.asarray(values) == 0))
            cv = float(np.std(values) / mean) if mean else None
            segments[sku] = ("very_low" if mean < .5 else "intermittent" if zero_rate >= .5 else
                             "high_stable" if mean >= 3 and cv is not None and cv <= 1 else "medium")
        totals = {sku: 0 for sku in skus}
        for day, sku, cents in revenue:
            if day <= fit_end.isoformat() and sku in totals:
                totals[sku] += cents
        top10 = sorted(skus, key=lambda sku: (-totals[sku], sku))[:10]
        model = estimator_factory().fit(frame.iloc[train_indices], np.asarray(labels)[train_indices])
        predicted = np.maximum(np.asarray(model.predict(frame.iloc[eval_indices]), dtype=float), 0.0)
        samples = []
        for index, prediction in zip(eval_indices, predicted):
            row = frame.iloc[index]
            samples.append({"sku": row["sku"], "origin": origins[index].isoformat(),
                            "category": row["categoryCode"], "segment": segments[row["sku"]],
                            "actual": float(labels[index]), "prediction": float(prediction),
                            "baseline": float(row["rollingMean_28"]) * horizon,
                            "observedUnits": daily_units(row["sku"], origins[index])})
        fold = policy.fold_from_samples(cut["split"], samples, top10)
        fold["temporalBoundary"] = {**cut, "actualMaxTrainOrigin": max(origins[i] for i in train_indices).isoformat(),
                                    "actualMaxTrainLabelDate": (max(origins[i] for i in train_indices) + timedelta(days=horizon)).isoformat(),
                                    "evalRows": len(eval_indices), "trainRows": len(train_indices)}
        folds.append(fold)
    result = policy.evaluate_policy(folds, horizon)
    result["protocol"] = protocol
    return result


def train(request: dict) -> dict:
    start = time.perf_counter()
    if not isinstance(request, dict) or request.get("businessId") != BUSINESS_ID or request.get("scenarioId") != v3_forecast.SCENARIO_ID:
        raise TrainingError("INVALID_SCOPE")
    horizon = request.get("horizonDays")
    if horizon not in (7, 14) or isinstance(horizon, bool):
        raise TrainingError("MODEL_NOT_APPROVED")
    policy.load_policy()
    closed = _day(request.get("observationsClosedThrough"))
    if closed > datetime.now(LIMA).date() - timedelta(days=1) or closed < HISTORICAL:
        raise TrainingError("DATASET_INVALID")
    version = request.get("inputDataVersion")
    if not isinstance(version, str) or not version.isdecimal():
        raise TrainingError("DATASET_INVALID")
    latest = closed - timedelta(days=horizon)
    if latest < FIRST_ORIGIN:
        raise TrainingError("INSUFFICIENT_MATURE_LABELS")
    protocol = policy.temporal_protocol(closed, horizon)
    bootstrap = request.get("mode") == "bootstrap"
    if not bootstrap and protocol["status"] != "READY":
        source_hash = digest({"historicalDatasetSha256": v3_forecast.DATASET_SHA256,
                              "inputDataVersion": version, "closed": closed.isoformat(),
                              "horizon": horizon, "journal": request.get("journal")})
        return {"evaluationStatus": "INSUFFICIENT_EVALUATION_HISTORY", "artifact": None,
                "sourceDatasetHash": source_hash, "trainedDataVersion": version,
                "featureHash": live_ridge.FEATURE_HASH, "promotionPolicyHash": policy.POLICY_HASH,
                "checks": {"policyVersion": policy.POLICY_VERSION, "policyHash": policy.POLICY_HASH,
                           "status": "INSUFFICIENT_EVALUATION_HISTORY", "protocol": protocol,
                           "reasons": ["INSUFFICIENT_EVALUATION_HISTORY"]}}
    dataset = v3_forecast.load_validated_dataset(ROOT)
    catalog, closed_rows, product_keys = _journal_overlay(dataset, request.get("journal"), closed)
    dataset_ms = (time.perf_counter() - start) * 1000
    post_mature = (latest - HISTORICAL).days
    if bootstrap and any(row.get("entityType") == "transaction" and row.get("operation") == "CANCEL"
           and (row.get("projection") or {}).get("transactionOrigin") == "HISTORICAL"
           for row in request["journal"]):
        raise TrainingError("BOOTSTRAP_EVIDENCE_NOT_APPLICABLE")
    evidence = _approved_evidence(horizon, request.get("expectedEvidenceHash", bootstrap_evidence.EVIDENCE_HASH)) if bootstrap else None
    rows, labels, origins = [], [], []
    sku_to_key = {value: key for key, value in product_keys.items()}
    def daily_units(sku, day):
        if day <= HISTORICAL:
            item = dataset.inventory.get(sku, {}).get(day.isoformat())
            if item is None:
                raise TrainingError("FEATURE_UNAVAILABLE")
            return int(item["unitsSold"])
        item = closed_rows.get((sku_to_key.get(sku), day))
        if item is None:
            raise TrainingError("FEATURE_UNAVAILABLE")
        return int(item["unitsSold"])
    origin = FIRST_ORIGIN
    while origin <= latest:
        for sku in sorted(dataset.product_by_sku):
            if origin <= HISTORICAL:
                values = dataset.feature_row(sku, origin, horizon)
                row = {name: values[name] for name in live_ridge.FEATURE_ORDER}
            else:
                row = _live_row(dataset, catalog, closed_rows, business_id=BUSINESS_ID,
                                horizon=horizon, sku=sku, origin=origin, data_version=version)
            total = sum(daily_units(sku, origin + timedelta(days=step)) for step in range(1, horizon + 1))
            rows.append(row)
            labels.append(total)
            origins.append(origin)
        origin += timedelta(days=1)
    if not rows:
        raise TrainingError("INSUFFICIENT_MATURE_LABELS")
    dataset_hash = digest({"historicalDatasetSha256": v3_forecast.DATASET_SHA256,
                           "version": version, "closed": closed.isoformat(),
                           "horizon": horizon, "rows": rows, "labels": labels})
    frame = pd.DataFrame(rows, columns=live_ridge.FEATURE_ORDER)
    if request.get("dryRun") is True:
        if not bootstrap:
            raise TrainingError("INVALID_DRY_RUN_MODE")
        # The same complete dataset/features/labels as fit, but no estimator is constructed.
        return {"status": "FEASIBLE", "horizonDays": horizon, "trainRows": len(rows),
                "sourceDatasetHash": dataset_hash, "trainedDataVersion": version,
                "observationsClosedThrough": closed.isoformat(),
                "latestMatureOrigin": latest.isoformat(),
                "evidenceHash": bootstrap_evidence.EVIDENCE_HASH,
                "featureHash": live_ridge.FEATURE_HASH, "promotionPolicyHash": policy.POLICY_HASH}
    before_evaluation = time.perf_counter()
    evaluation = (None if bootstrap else evaluate_temporal(frame, labels, origins, horizon, protocol,
                                                           daily_units, revenue_history(request["journal"])))
    evaluation_ms = (time.perf_counter() - before_evaluation) * 1000
    before_fit = time.perf_counter()
    model = recipe().fit(frame, np.asarray(labels, dtype=float))
    fit_ms = (time.perf_counter() - before_fit) * 1000
    before_artifact = time.perf_counter()
    artifact = _artifact(model, business_id=BUSINESS_ID, horizon=horizon)
    batch = frame.iloc[:min(80, len(frame))]
    predicted = np.maximum(np.asarray(model.predict(batch), dtype=float), 0.0)
    differences = [abs(float(expected) - live_ridge.score_ridge(rows[index], artifact))
                   for index, expected in enumerate(predicted)]
    maximum = max(differences, default=0.0)
    if not math.isfinite(maximum) or maximum > 1e-10:
        raise TrainingError("ARTIFACT_PARITY_FAILED")
    if len(canonical(artifact)) > live_ridge.MAX_ARTIFACT_BYTES:
        raise TrainingError("ARTIFACT_TOO_LARGE")
    artifact_ms = (time.perf_counter() - before_artifact) * 1000
    metrics = evidence["model"] if evidence else evaluation["model"]
    evaluation_status = ("BOOTSTRAP_FROM_APPROVED_HISTORICAL_EVIDENCE" if bootstrap else
                         evaluation["status"])
    return {"artifact": artifact, "sourceDatasetHash": dataset_hash,
            "trainedDataVersion": version, "dataCutoff": closed.isoformat(),
            "trainingWindow": {"startDate": FIRST_ORIGIN.isoformat(), "endDate": latest.isoformat()},
            "labelClosedThrough": closed.isoformat(), "featureVersion": live_ridge.FEATURE_VERSION,
            "featureHash": live_ridge.FEATURE_HASH,
            "promotionPolicyVersion": live_ridge.PROMOTION_POLICY_VERSION,
            "promotionPolicyHash": live_ridge.PROMOTION_POLICY_HASH,
            "globalWape": float(metrics["wape"]) if metrics else None,
            "globalMae": float(metrics["mae"]) if metrics else None,
            "globalBias": float(metrics["normalized_bias"]) if metrics else None,
            "checks": ({"mode": evaluation_status, "historicalDecision": evidence,
                        "postCutoffMatureOrigins": max(0, post_mature)} if bootstrap else evaluation),
            "lineage": {"historicalDatasetSha256": v3_forecast.DATASET_SHA256,
                        "approvedEvidenceSha256": hashlib.sha256(EVIDENCE.read_bytes()).hexdigest() if bootstrap else None,
                        "sourceDatasetHash": dataset_hash,
                        "historicalTestPreviouslyInspected": True},
            "performanceMs": {"datasetLoad": round(dataset_ms, 3), "fit": round(fit_ms, 3),
                              "serializeParity": round(artifact_ms, 3), "evaluation": round(evaluation_ms, 3)},
            "parityMaxAbsoluteError": maximum, "trainRows": len(rows),
            "evaluationStatus": evaluation_status}


if __name__ == "__main__":
    try:
        outcome = train(json.load(sys.stdin))
        print(json.dumps({"ok": True, "result": outcome}, ensure_ascii=False, allow_nan=False))
    except (TrainingError, live_ridge.LiveRidgeError, policy.PolicyError) as error:
        print(json.dumps({"ok": False, "code": error.code}))
    except Exception:
        print(json.dumps({"ok": False, "code": "TRAINING_FAILED"}))
