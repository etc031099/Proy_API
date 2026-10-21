"""Serve approved frozen results and verify the trusted deployment-owned forest."""
from datetime import date
from functools import lru_cache
import hashlib
import json
from pathlib import Path
from typing import Literal
from math import isfinite
import joblib
import sklearn
from pydantic import BaseModel, ConfigDict, Field
from ml.src.sales_isolation_forest_v3 import ARTIFACT_DIR, VERSION, CUTOFF, TRAIN_END, FEATURES, START, logical_hash
from ml.src.sales_isolation_forest_v3 import average_ticket, model_matrix
from ml.service.v3_schemas import DATASET_SHA256, DATASET_VERSION


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Distribution(Schema):
    min: float
    q25: float
    median: float
    q75: float
    p90: float
    max: float
    mean: float
    skewness: float
    zeros: int
    iqrOutliers: int


class DailyResult(Schema):
    date: date
    status: Literal["COMPLETE"]
    revenue: float = Field(ge=0)
    units: int = Field(ge=0)
    tickets: int = Field(gt=0)
    averageTicket: float = Field(gt=0)
    weekday: int = Field(ge=1, le=7)
    weekend: bool
    holidayCode: str | None
    promotionTickets: int = Field(ge=0)
    anomalyScore: float
    decisionFunction: float
    isAnomaly: bool
    prediction: Literal[-1, 1]
    interpretation: str
    split: Literal["TRAIN", "VALIDATION", "RETROSPECTIVE"]


class Stability(Schema):
    jaccardMean: float
    jaccardMin: float
    top10JaccardMean: float
    rankCorrelationMean: float
    developmentJaccardMean: float
    developmentRankCorrelationMean: float


class Candidate(Schema):
    contamination: Literal["auto"] | float
    threshold: float
    anomalyCount: int
    anomalyRate: float
    dates: list[date]
    jaccardMean: float
    jaccardMin: float


class Period(Schema):
    startDate: date
    endDate: date


class AnomaliesResponse(Schema):
    contractVersion: str
    modelId: str
    version: str
    algorithm: Literal["IsolationForest"]
    learningType: Literal["unsupervised"]
    task: Literal["sales_anomaly_detection"]
    mode: Literal["FROZEN"]
    trainingCutoff: date
    analysisCutoff: date
    sampleCount: int
    analysisDays: int
    trainingTimestamp: str
    features: list[str]
    transformations: list[str]
    contamination: Literal["auto"]
    threshold: float
    anomalyCount: int
    anomalyRate: float
    stability: Stability
    scoreSemantics: str
    selectionReason: str
    status: Literal["EXPLORATORY"]
    artifactHash: str
    limitations: list[str]
    reference: dict[Literal["revenue", "units", "tickets", "averageTicket"], Distribution]
    candidates: list[Candidate]
    period: Period
    filteredDays: int
    filteredAnomalyCount: int
    topAnomalies: list[DailyResult] = Field(max_length=20)
    series: list[DailyResult] = Field(max_length=365)


@lru_cache(maxsize=4)
def _load(root, signature):
    directory = Path(root) / ARTIFACT_DIR
    meta = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
    daily = json.loads((directory / "daily-results.json").read_text(encoding="utf-8"))
    training = json.loads((directory / "training-daily.json").read_text(encoding="utf-8"))
    artifact = directory / "model.joblib"
    if (meta["version"] != VERSION or meta["scenarioId"] != "minimarket-pasco-v3"
            or meta["sourceLogicalHash"] != DATASET_SHA256 or meta["datasetVersion"] != DATASET_VERSION
            or meta["sklearnVersion"] != sklearn.__version__ or meta["features"] != FEATURES
            or meta["trainingCutoff"] != TRAIN_END or meta["analysisCutoff"] != CUTOFF
            or meta["dailyDataHash"] != logical_hash(training) or meta["resultsHash"] != logical_hash(daily)
            or hashlib.sha256(artifact.read_bytes()).hexdigest() != meta["artifactHash"]):
        raise ValueError("Frozen anomaly lineage mismatch")
    bundle = joblib.load(artifact)
    if (bundle["version"] != VERSION or bundle["features"] != FEATURES
            or bundle["trainingCutoff"] != TRAIN_END or bundle["analysisCutoff"] != CUTOFF
            or bundle["model"].offset_ != meta["threshold"] or bundle["sampleCount"] != meta["sampleCount"]):
        raise ValueError("Frozen anomaly artifact mismatch")
    # Returning JSON copies keeps the validated shared cache read-only for callers.
    public = {k: meta[k] for k in AnomaliesResponse.model_fields if k in meta}
    public.update(mode="FROZEN", period={"startDate": START, "endDate": CUTOFF},
                  filteredDays=len(daily), filteredAnomalyCount=sum(r["isAnomaly"] for r in daily), series=daily,
                  topAnomalies=sorted((r for r in daily if r["isAnomaly"]), key=lambda r: (r["anomalyScore"], r["date"]))[:20])
    public["candidates"] = [{k: c[k] for k in Candidate.model_fields} for c in meta["candidates"]]
    validated = AnomaliesResponse.model_validate(public)
    if len(daily) != 365 or meta["anomalyCount"] != public["filteredAnomalyCount"]:
        raise ValueError("Frozen anomaly count mismatch")
    return bundle, validated


def load_anomalies(root):
    directory = Path(root).resolve() / ARTIFACT_DIR
    signature = tuple((directory / name).stat().st_mtime_ns for name in ("metadata.json", "model.joblib", "daily-results.json", "training-daily.json"))
    return _load(str(Path(root).resolve()), signature)


def anomalies_data(root, start=START, end=CUTOFF, limit=10):
    if not START <= start <= end <= CUTOFF or not 1 <= limit <= 20:
        raise ValueError("Invalid frozen period/limit")
    date.fromisoformat(start)
    date.fromisoformat(end)
    _, response = load_anomalies(root)
    data = response.model_dump(mode="json")
    rows = [row for row in data["series"] if start <= row["date"] <= end]
    flagged = [row for row in rows if row["isAnomaly"]]
    data.update(period={"startDate": start, "endDate": end}, filteredDays=len(rows), filteredAnomalyCount=len(flagged),
                series=rows, topAnomalies=sorted(flagged, key=lambda r: (r["anomalyScore"], r["date"]))[:limit])
    return AnomaliesResponse.model_validate(data).model_dump(mode="json")


def provisional_daily_inference(root, *, local_date, expected_date, revenue_cents, tickets, units, currency="PEN"):
    """Read-only inference with the validated frozen bundle. Never certify an open day."""
    bundle, metadata = load_anomalies(root)
    reference = bundle["preprocessing"]
    identity = {"artifact": "model.joblib", "artifactHash": metadata.artifactHash,
                "weeklyReferenceHash": logical_hash({str(k): v.tolist() for k, v in reference.weekday_medians_.items()}),
                "trainingCutoff": TRAIN_END, "analysisCutoff": CUTOFF,
                "threshold": float(bundle["model"].offset_)}
    result = {"modelVersion": VERSION, "provisional": True, "localDate": local_date,
              "status": "NOT_EVALUABLE", "reason": None, "aggregate": None,
              "modelInput": None, "inference": None, "modelIdentity": identity}
    def unavailable(reason):
        result["reason"] = reason
        return result
    try:
        day = date.fromisoformat(local_date)
        if day.isoformat() != local_date:
            return unavailable("INVALID_DATE")
        if local_date != expected_date:
            return unavailable("DATE_MISMATCH")
    except (ValueError, TypeError):
        return unavailable("INVALID_DATE")
    if currency != "PEN":
        return unavailable("UNSUPPORTED_CURRENCY")
    if any(type(value) is not int or value < 0 or value > 9_007_199_254_740_991 for value in (revenue_cents, tickets, units)):
        return unavailable("INVALID_DAILY_AGGREGATE")
    average = average_ticket(revenue_cents, tickets)
    result["aggregate"] = {"revenuePEN": revenue_cents / 100, "units": units,
                           "tickets": tickets, "averageTicketPEN": average}
    if tickets == 0:
        return unavailable("NO_TICKETS")
    if average is None or not isfinite(average) or average <= 0:
        return unavailable("INVALID_AVERAGE_TICKET")
    x = model_matrix([[day.isoweekday(), tickets, average]])
    transformed = reference.transform(x)
    score = float(bundle["model"].score_samples(transformed)[0])
    decision = score - identity["threshold"]
    region = logical_hash([int(tree.apply(transformed[:, features])[0]) for tree, features in
                           zip(bundle["model"].estimators_, bundle["model"].estimators_features_)])
    result.update(status="EVALUATED", modelInput={"weekday": day.isoweekday(),
        **dict(zip(FEATURES, map(float, transformed[0])))}, inference={"anomalyScore": score,
        "decisionFunction": decision, "prediction": -1 if decision < 0 else 1,
        "label": "ANOMALOUS_SIGNAL" if decision < 0 else "WITHIN_PATTERN", "regionSignature": region})
    return result
