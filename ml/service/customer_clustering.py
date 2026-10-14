"""Verified frozen K-Means inference. No fitting in HTTP requests."""
from functools import lru_cache
import hashlib
import json
from pathlib import Path
from typing import Literal
import joblib
import numpy as np
import sklearn
from pydantic import BaseModel, ConfigDict, Field
from ml.src.customer_kmeans_v3 import ARTIFACT_DIR, CUTOFF, VERSION, FEATURES, logical_hash
from ml.service.v3_schemas import DATASET_SHA256, DATASET_VERSION


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class RfmInput(Schema):
    recency: float | None = Field(default=None, ge=0)
    frequency: float = Field(ge=0)
    monetary: float = Field(ge=0)


class Candidate(Schema):
    k: int
    scaler: str
    silhouetteMean: float
    silhouetteStd: float
    inertia: float
    seedAriMean: float
    subsampleAriMean: float
    subsampleAriMin: float
    clusterSizes: list[int]


class Cluster(Schema):
    cluster: int
    name: str
    size: int
    proportion: float
    centroidOriginal: RfmInput
    mean: RfmInput
    median: RfmInput
    silhouetteMean: float


class Assignment(RfmInput):
    customerRef: str
    status: Literal["ELIGIBLE", "ASSIGNED", "INSUFFICIENT_HISTORY"]
    rfmSegment: str | None = None
    cluster: int | None = None
    clusterName: str | None = None
    distance: float | None = Field(default=None, ge=0)
    pc1: float | None = None
    pc2: float | None = None


class Pca(Schema):
    explainedVarianceRatio: list[float]
    visualizationOnly: Literal[True]


class ClusteringResponse(Schema):
    contractVersion: str
    modelId: str
    version: str
    algorithm: Literal["KMeans"]
    learningType: Literal["unsupervised"]
    task: Literal["customer_segmentation"]
    trainingCutoff: str
    sampleCount: int
    excludedCount: int
    features: list[str]
    featureWindow: str
    transformations: list[str]
    scaler: str
    k: int
    randomState: int
    nInit: int
    status: Literal["EXPLORATORY"]
    artifactHash: str
    metrics: Candidate
    candidates: list[Candidate]
    scalerSensitivityAri: float
    selectionReason: str
    protocolDeviation: str
    limitations: list[str]
    clusters: list[Cluster]
    assignments: list[Assignment]
    pca: Pca
    assignmentAsOfDate: str
    assignmentSource: Literal["FROZEN_TRAINING_RFM", "AUTHORIZED_CURRENT_RFM"]


@lru_cache(maxsize=4)
def _load(root, signature):
    directory = Path(root) / ARTIFACT_DIR
    meta = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
    rows = json.loads((directory / "training-rfm.json").read_text(encoding="utf-8"))
    artifact = directory / "model.joblib"
    if (meta["version"] != VERSION or meta["sourceLogicalHash"] != DATASET_SHA256
            or meta["datasetVersion"] != DATASET_VERSION or meta["scenarioId"] != "minimarket-pasco-v3"
            or meta["trainingCutoff"] != CUTOFF or meta["features"] != FEATURES
            or meta["sklearnVersion"] != sklearn.__version__
            or logical_hash(rows) != meta["trainingDataHash"]
            or hashlib.sha256(artifact.read_bytes()).hexdigest() != meta["artifactHash"]):
        raise ValueError("Frozen clustering lineage mismatch")
    # Trusted deployment-owned path only; never a caller-provided pickle/file.
    bundle = joblib.load(artifact)
    if bundle["version"] != VERSION or bundle["pipeline"][-1].n_clusters != meta["k"]:
        raise ValueError("Frozen clustering artifact mismatch")
    fields = ClusteringResponse.model_fields
    public = {k: meta[k] for k in fields if k in meta}
    candidate_keys = Candidate.model_fields
    public["metrics"] = {k: meta["metrics"][k] for k in candidate_keys}
    public["candidates"] = [{k: c[k] for k in candidate_keys} for c in meta["candidates"]]
    public["assignmentAsOfDate"] = CUTOFF
    public["assignmentSource"] = "FROZEN_TRAINING_RFM"
    return bundle, ClusteringResponse.model_validate(public)


def load_clustering(root):
    directory = Path(root).resolve() / ARTIFACT_DIR
    signature = tuple((directory / name).stat().st_mtime_ns for name in ("metadata.json", "model.joblib", "training-rfm.json"))
    return _load(str(Path(root).resolve()), signature)


def clustering_data(root, customer_ref=None, rfm=None, as_of=CUTOFF):
    bundle, frozen = load_clustering(root)
    data = frozen.model_dump(mode="json")
    if customer_ref is None:
        return data
    if customer_ref == "CONSUMER_FINAL":
        raise LookupError("Consumer Final is not an individual customer")
    if rfm is None:
        found = [r for r in data["assignments"] if r["customerRef"] == customer_ref]
        if not found:
            raise LookupError("Customer not found")
        data["assignments"] = found
        return data
    values = RfmInput.model_validate(rfm).model_dump()
    result = {**values, "customerRef": customer_ref, "status": "INSUFFICIENT_HISTORY"}
    if values["recency"] is not None:
        x = np.array([[values[f] for f in FEATURES]])
        transformed = bundle["pipeline"][:-1].transform(x)
        raw_label = int(bundle["pipeline"][-1].predict(transformed)[0])
        cluster = bundle["labelMapping"][raw_label]
        profile = next(c for c in data["clusters"] if c["cluster"] == cluster)
        pc = bundle["pca"].transform(transformed)[0]
        result.update(status="ASSIGNED", cluster=cluster, clusterName=profile["name"],
                      distance=float(bundle["pipeline"][-1].transform(transformed)[0, raw_label]),
                      pc1=float(pc[0]), pc2=float(pc[1]))
    data["assignments"] = [Assignment.model_validate(result).model_dump(mode="json")]
    data["assignmentAsOfDate"] = as_of
    data["assignmentSource"] = "AUTHORIZED_CURRENT_RFM"
    return ClusteringResponse.model_validate(data).model_dump(mode="json")
