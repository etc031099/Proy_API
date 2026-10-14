"""Frozen exploratory daily sales anomaly experiment; training is explicit/local."""
from __future__ import annotations
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import joblib
import numpy as np
import sklearn
from scipy.stats import skew, spearmanr
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.ensemble import IsolationForest
from threadpoolctl import threadpool_limits

VERSION = "sales-isolation-forest-v3-v1"
ARTIFACT_DIR = "ml/artifacts/sales-isolation-forest-v3"
START, CUTOFF = "2025-10-13", "2026-10-12"
TRAIN_END, VALIDATION_END = "2026-06-30", "2026-08-15"
FEATURES = ["weekdayLogTicketsDeviation", "weekdayLogAverageTicketDeviation"]
SEEDS = list(range(2026, 2036))
CONTAMINATIONS = ["auto", .01, .02, .03, .05]
PARAMS = {"n_estimators": 200, "max_samples": 256, "max_features": 1.0,
          "bootstrap": False, "n_jobs": 1, "random_state": 2026, "contamination": "auto", "warm_start": False}


def logical_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                   separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def build_daily(runtime):
    """Calendar + complete approved product-days certify zeros, never absence of tickets alone."""
    from ml.src.business_customer_supplier_v3 import _sale_data
    sales, lines = _sale_data(runtime.records, date.fromisoformat(CUTOFF))
    by_date = defaultdict(list)
    for sale in sales:
        if START <= sale["localDate"] <= CUTOFF:
            by_date[sale["localDate"]].append(sale)
    rows = []
    for index in range((date.fromisoformat(CUTOFF)-date.fromisoformat(START)).days+1):
        day = date.fromisoformat(START)+timedelta(days=index)
        iso = day.isoformat()
        calendar = runtime.dataset.calendar.get(iso)
        product_days = [runtime.dataset.inventory[sku].get(iso) for sku in runtime.dataset.product_by_sku]
        complete = calendar is not None and all(row is not None for row in product_days)
        if not complete:
            rows.append({"date": iso, "status": "DATA_INCOMPLETE"})
            continue
        tickets = by_date[iso]
        revenue_cents = units = promotion_tickets = 0
        for ticket in tickets:
            items = lines[ticket["saleCode"]]
            if sum(item["lineTotalCents"] for item in items) != ticket["totalCents"]:
                raise ValueError("Daily ticket revenue does not reconcile")
            revenue_cents += ticket["totalCents"]
            units += sum(item["unitsSold"] for item in items)
            promotion_tickets += int(bool(ticket.get("ticketDiscountCents") or ticket.get("itemDiscountCents")
                                          or any(item.get("promotionCode") for item in items)))
        if sum(row["unitsSold"] for row in product_days) != units:
            raise ValueError("Completed daily units do not reconcile with approved product-days")
        rows.append({"date": iso, "status": "COMPLETE" if tickets else "ZERO_ACTIVITY",
                     "revenue": revenue_cents/100, "units": units, "tickets": len(tickets),
                     "averageTicket": revenue_cents/100/len(tickets) if tickets else None,
                     "weekday": day.isoweekday(), "weekend": day.isoweekday() >= 6,
                     "holidayCode": calendar.get("holidayCode"), "promotionTickets": promotion_tickets})
    return rows


def matrix(rows):
    values = np.asarray([[row["weekday"], row["tickets"], row["averageTicket"]]
                         for row in rows if row["status"] == "COMPLETE"], dtype=float)
    if (values.ndim != 2 or values.shape[1] != 3 or not np.isfinite(values).all()
            or (values[:, 1:] <= 0).any()):
        raise ValueError("Daily sales features must be complete, positive and finite")
    return values


class WeeklyLogResiduals(TransformerMixin, BaseEstimator):
    """Calendar references fitted using past TRAIN only; no scaler."""
    def fit(self, x, y=None):
        self.weekday_medians_ = {weekday: np.median(np.log1p(x[x[:, 0] == weekday, 1:]), axis=0)
                                for weekday in range(1, 8)}
        if not all(np.isfinite(v).all() for v in self.weekday_medians_.values()):
            raise ValueError("Training needs every weekday")
        return self

    def transform(self, x):
        return np.log1p(x[:, 1:]) - np.asarray([self.weekday_medians_[int(weekday)] for weekday in x[:, 0]])


def stats(values):
    q = np.quantile(values, [0, .25, .5, .75, .9, 1])
    return dict(zip(("min", "q25", "median", "q75", "p90", "max"), map(float, q))) | {
        "mean": float(np.mean(values)), "skewness": float(skew(values)), "zeros": int((values == 0).sum()),
        "iqrOutliers": int(((values < q[1]-1.5*(q[3]-q[1])) | (values > q[3]+1.5*(q[3]-q[1]))).sum())}


def jaccard(a, b):
    return len(a & b)/len(a | b) if a | b else 1.0


def train(rows, source_hash, output_dir, training_timestamp=None):
    expected = [(date.fromisoformat(START)+timedelta(days=i)).isoformat() for i in range(365)]
    if [r["date"] for r in rows] != expected:
        raise ValueError("Daily history must contain unique, consecutive dates through cutoff")
    eligible = [row for row in rows if row["status"] == "COMPLETE"]
    if any(row["status"] == "DATA_INCOMPLETE" for row in rows):
        raise ValueError("DATA_INCOMPLETE: daily completeness is not certified")
    if any(row["status"] == "ZERO_ACTIVITY" for row in rows):
        raise ValueError("ZERO_ACTIVITY_NOT_SCORED: genuine zero activity has no average ticket; use descriptive rule, never impute")
    if len(eligible) != 365:
        raise ValueError("DATA_INCOMPLETE: approved experiment requires 365 certified days")
    x = matrix(rows)
    training = np.array([row["date"] <= TRAIN_END for row in rows])
    validation = np.array([TRAIN_END < row["date"] <= VALIDATION_END for row in rows])
    retrospective = np.array([row["date"] > VALIDATION_END for row in rows])
    pre = WeeklyLogResiduals().fit(x[training])
    transformed = pre.transform(x)
    with threadpool_limits(limits=1):
        models = [IsolationForest(**(PARAMS | {"random_state": seed})).fit(transformed[training]) for seed in SEEDS]
        scores = [m.score_samples(transformed) for m in models]
    candidates = []
    for contamination in CONTAMINATIONS:
        thresholds = [float(m.offset_) if contamination == "auto" else float(np.quantile(score[training], contamination))
                      for m, score in zip(models, scores)]
        detected = [{i for i, v in enumerate(score) if v < threshold} for score, threshold in zip(scores, thresholds)]
        overlap = [jaccard(detected[i], detected[j]) for i in range(len(SEEDS)) for j in range(i)]
        top10 = [set(np.argsort(score)[:10]) for score in scores]
        candidate = {"contamination": contamination, "threshold": thresholds[0],
                     "anomalyCount": len(detected[0]), "anomalyRate": len(detected[0])/len(rows),
                     "dates": [rows[i]["date"] for i in sorted(detected[0])],
                     "countsBySeed": [len(d) for d in detected], "jaccardMean": float(np.mean(overlap)),
                     "jaccardMin": float(min(overlap)),
                     "top10JaccardMean": float(np.mean([jaccard(top10[i], top10[j]) for i in range(10) for j in range(i)])),
                     "rankCorrelationMean": float(np.mean([spearmanr(scores[i], scores[j]).statistic for i in range(10) for j in range(i)])),
                     "scoreDistribution": stats(scores[0]),
                     "countsBySplit": {key: sum(i in detected[0] for i in np.flatnonzero(mask))
                                       for key, mask in (("train", training), ("validation", validation), ("retrospective", retrospective))}}
        development = set(np.flatnonzero(training | validation))
        candidate["developmentJaccardMean"] = float(np.mean([
            jaccard(detected[i] & development, detected[j] & development) for i in range(10) for j in range(i)]))
        candidate["developmentRankCorrelationMean"] = float(np.mean([
            spearmanr(scores[i][training | validation], scores[j][training | validation]).statistic
            for i in range(10) for j in range(i)]))
        candidates.append(candidate)
    selected = candidates[0]
    if selected["developmentJaccardMean"] < .7 or selected["developmentRankCorrelationMean"] < .9:
        raise ValueError("NEEDS_MORE_DATA: auto detector not stable across seeds")
    # Fixed auto threshold chosen in G.1; numeric contamination only changes offset,
    # not fitted trees/scores. No tuning on the retrospective block.
    model = models[0]
    # Two past-only expanding folds assess threshold sensitivity to changing history.
    folds = []
    for boundary in ("2026-03-31", "2026-05-31"):
        fit_mask = np.array([r["date"] <= boundary for r in rows])
        follow = (np.array([r["date"] > boundary for r in rows])) & training
        prep = WeeklyLogResiduals().fit(x[fit_mask])
        forest = IsolationForest(**(PARAMS | {"max_samples": min(256, int(fit_mask.sum()))})).fit(prep.transform(x[fit_mask]))
        index = np.flatnonzero(follow)
        flagged = set(index[forest.predict(prep.transform(x[follow])) == -1])
        full = set(index[model.predict(transformed[follow]) == -1])
        folds.append({"fitCutoff": boundary, "trainCount": int(fit_mask.sum()), "comparisonDays": int(follow.sum()),
                      "foldAnomalyCount": len(flagged), "referenceAnomalyCount": len(full), "jaccard": jaccard(flagged, full),
                      "comparisonNote": "Frozen full-TRAIN comparator uses more history; not a future-independent performance estimate."})
    raw_log = np.log1p(x[:, 1:])
    no_weekly = IsolationForest(**PARAMS).fit(raw_log[training])
    normalisation_sensitivity = jaccard(set(np.flatnonzero(no_weekly.predict(raw_log) == -1)), set(np.flatnonzero(model.predict(transformed) == -1)))
    quality = {"missingDays": 0, "zeroDays": 0, "excludedDays": 0, "outliersRemoved": 0,
               "original": {field: stats(np.array([r[field] for r in rows])) for field in ("revenue", "units", "tickets", "averageTicket")},
               "log1p": {field: stats(np.log1p(np.array([r[field] for r in rows]))) for field in ("revenue", "units", "tickets", "averageTicket")},
               "correlationFeatures": ["revenue", "units", "tickets", "averageTicket"],
               "correlationMatrix": np.corrcoef(np.array([[r[k] for k in ("revenue", "units", "tickets", "averageTicket")] for r in rows]).T).tolist()}
    reference = {field: quality["original"][field] for field in quality["original"]}
    daily = []
    for i, row in enumerate(rows):
        score = float(scores[0][i])
        decision = score-float(model.offset_)
        # Descriptive context relative to observed global history, never a cause.
        ref = reference["tickets"]
        interpretation = ("Volumen superior al rango intercuartílico histórico" if row["tickets"] > ref["q75"]+1.5*(ref["q75"]-ref["q25"])
                          else "Volumen inferior al rango intercuartílico histórico" if row["tickets"] < ref["q25"]-1.5*(ref["q75"]-ref["q25"])
                          else "Combinación atípica de volumen y ticket promedio respecto al patrón semanal")
        daily.append(row | {"anomalyScore": score, "decisionFunction": decision, "isAnomaly": decision < 0,
                           "prediction": -1 if decision < 0 else 1, "interpretation": interpretation if decision < 0 else "Dentro del patrón de referencia",
                           "split": "TRAIN" if training[i] else "VALIDATION" if validation[i] else "RETROSPECTIVE"})
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    artifact = output / "model.joblib"
    joblib.dump({"model": model, "preprocessing": pre, "features": FEATURES, "params": PARAMS,
                 "version": VERSION, "trainingCutoff": TRAIN_END, "analysisCutoff": CUTOFF,
                 "sampleCount": int(training.sum()), "threshold": float(model.offset_)}, artifact, compress=3)
    # Pickle bytes can vary with numpy dtype memoization after other models were
    # loaded. This hash compares actual learned trees/reference values, not aliases.
    learned_hash = logical_hash({"params": PARAMS, "threshold": float(model.offset_),
        "weekdayMedians": {str(k): v.tolist() for k, v in pre.weekday_medians_.items()},
        "trees": [{"nodes": tree.tree_.__getstate__()["nodes"].tolist(), "values": tree.tree_.value.tolist(),
                   "features": features.tolist()} for tree, features in zip(model.estimators_, model.estimators_features_)]})
    meta = {"contractVersion": VERSION, "modelId": "v3-daily-sales-isolation-forest", "version": VERSION,
            "algorithm": "IsolationForest", "learningType": "unsupervised", "task": "sales_anomaly_detection",
            "scenarioId": "minimarket-pasco-v3", "datasetVersion": "minimarket-pasco-v3-seed2026-v1",
            "sourceLogicalHash": source_hash, "dailyDataHash": logical_hash(rows), "resultsHash": logical_hash(daily),
            "learnedModelHash": learned_hash,
            "features": FEATURES, "transformations": ["log1p(tickets)", "log1p(averageTicketPEN)", "subtract TRAIN-only weekday medians"],
            "scaler": None, "params": PARAMS, "contamination": "auto", "threshold": float(model.offset_),
            "trainingCutoff": TRAIN_END, "analysisCutoff": CUTOFF, "sampleCount": int(training.sum()), "analysisDays": len(rows),
            "splits": {"train": [START, TRAIN_END], "validation": ["2026-07-01", VALIDATION_END], "retrospective": ["2026-08-16", CUTOFF]},
            "splitCounts": {"train": int(training.sum()), "validation": int(validation.sum()), "retrospective": int(retrospective.sum())},
            "trainingTimestamp": training_timestamp or datetime.now(timezone.utc).isoformat(), "sklearnVersion": sklearn.__version__,
            "anomalyCount": selected["anomalyCount"], "anomalyRate": selected["anomalyRate"],
            "stability": {k: selected[k] for k in ("jaccardMean", "jaccardMin", "top10JaccardMean", "rankCorrelationMean", "developmentJaccardMean", "developmentRankCorrelationMean")},
            "candidates": candidates, "quality": quality, "reference": reference, "temporalFolds": folds,
            "weekdaySensitivityJaccard": normalisation_sensitivity,
            "selectionReason": "Auto was predeclared in G.1; no labels justify a fixed anomaly proportion. Retained when development (TRAIN+VALIDATION only) seed Jaccard mean >=0.7 and score rank correlation >=0.9. Numeric candidates are threshold sensitivity only; retrospective block is descriptive, not used for tuning.",
            "scoreSemantics": "anomalyScore=sklearn.score_samples; lower/more negative means more atypical. decisionFunction=score-offset; isAnomaly iff decisionFunction<0. No calibrated probability.",
            "status": "EXPLORATORY", "artifactHash": hashlib.sha256(artifact.read_bytes()).hexdigest(),
            "limitations": ["Escenario sintético de un año, sin etiquetas independientes ni validación externa.",
                             "TRAIN, validación y bloque retrospectivo ya fueron inspeccionados en G.1; no son un holdout virgen.",
                             "El umbral auto es heurístico; una señal requiere revisar el contexto y no determina su causa.",
                             "El modelo solo puntúa el histórico congelado; no se aplica automáticamente a operaciones posteriores."]}
    for name, value in (("metadata.json", meta), ("daily-results.json", daily), ("training-daily.json", rows)):
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+"\n", encoding="utf-8")
    return meta
