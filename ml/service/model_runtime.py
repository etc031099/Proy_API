from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.pipeline import Pipeline

from ml.service.schemas import PredictionRequest, PredictionResult
from ml.src.common import repository_path, sha256_file
from ml.src.inference.demand_v1 import validate_and_order_features
from ml.src.serving.scenarios import SCENARIOS, validate_lineage
from ml.src.serving.demand_features import (
    EXPECTED_ANCHOR_STRATEGY,
    INVALID_HISTORY,
    FeatureBuildError,
    DemandFeatureBuilder,
)


EXPECTED_JOBLIB_SHA256 = "82f133a3390420556e69f090a5bdbeb4091bbe5f90f2260e790adf2b24741902"
DEFAULT_MODEL_PATH = "ml/models/demand_forecast_v1.joblib"
DEFAULT_METADATA_PATH = "ml/models/model_metadata.json"
DEFAULT_CONTRACT_PATH = "ml/models/demand_forecast_v1_contract.json"


class ModelUnavailableError(RuntimeError):
    pass


class InvalidContextError(ValueError):
    pass


class DuplicateBatchItemError(ValueError):
    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__(f"Duplicate {field} in request items")


@dataclass(frozen=True)
class BatchPrediction:
    results: list[PredictionResult]
    anchor_source_date: Any
    ready_count: int
    failed_count: int


class ModelRuntime:
    def __init__(
        self,
        *,
        model_path: str | Path = DEFAULT_MODEL_PATH,
        metadata_path: str | Path = DEFAULT_METADATA_PATH,
        contract_path: str | Path = DEFAULT_CONTRACT_PATH,
    ) -> None:
        self.model_path = repository_path(model_path).resolve()
        self.metadata_path = repository_path(metadata_path).resolve()
        self.contract_path = repository_path(contract_path).resolve()
        self.available = False
        self.error_code: str | None = "MODEL_UNAVAILABLE"
        self.pipeline: Pipeline | Any | None = None
        self.metadata: dict[str, Any] = {}
        self.contract: dict[str, Any] = {}
        self.builder: DemandFeatureBuilder | None = None
        self.builders: dict[str, DemandFeatureBuilder] = {}
        self.joblib_sha256: str | None = None
        self.startup_seconds: float | None = None

    def load(self) -> None:
        if self.available:
            return
        started = time.perf_counter()
        try:
            metadata = json.loads(self.metadata_path.read_text(encoding="utf-8"))
            contract = json.loads(self.contract_path.read_text(encoding="utf-8"))
            digest = sha256_file(self.model_path)
            if digest != EXPECTED_JOBLIB_SHA256 or digest != metadata.get("joblib_sha256"):
                raise ModelUnavailableError("Trusted model hash verification failed")
            if self.model_path.stat().st_size != metadata.get("joblib_size_bytes"):
                raise ModelUnavailableError("Trusted model size verification failed")
            if metadata.get("feature_names") != contract.get("feature_order"):
                raise ModelUnavailableError("Model metadata and feature contract disagree")
            if len(contract.get("feature_order", [])) != 31:
                raise ModelUnavailableError("Unexpected demand-v1 feature count")
            pipeline = joblib.load(self.model_path)
            if not isinstance(pipeline, Pipeline):
                raise ModelUnavailableError("Trusted artifact is not an sklearn Pipeline")
            if list(pipeline.named_steps) != ["preprocessing", "estimator"]:
                raise ModelUnavailableError("Trusted pipeline steps are invalid")
            builders = {}
            for key, scenario in SCENARIOS.items():
                if scenario["modelSha256"] != digest or scenario["horizonDays"] != 7:
                    raise ModelUnavailableError("Registered model contract mismatch")
                builder = DemandFeatureBuilder(scenario["manifest"], self.contract_path,
                    expected_business_id=scenario["businessId"], expected_scenario_id=scenario["scenarioId"])
                validate_lineage(builder, scenario)
                builders[key] = builder
            self.metadata = metadata
            self.contract = contract
            self.pipeline = pipeline
            self.builders = builders
            self.builder = builders["v1"]
            self.joblib_sha256 = digest
            self.error_code = None
            self.available = True
        except Exception as error:
            self.available = False
            self.error_code = "MODEL_UNAVAILABLE"
            self.pipeline = None
            self.builder = None
            self.builders = {}
            if isinstance(error, ModelUnavailableError):
                raise
            raise ModelUnavailableError("Inference runtime could not be initialized") from error
        finally:
            self.startup_seconds = time.perf_counter() - started

    def public_health(self) -> dict[str, Any]:
        return {
            "status": "ok" if self.available else "unavailable",
            "modelLoaded": self.available,
            "modelName": self.metadata.get("model_name"),
            "modelVersion": self.metadata.get("model_version"),
            "featureSetVersion": self.metadata.get("feature_set_version"),
            "featuresCount": len(self.contract.get("feature_order", [])),
            "joblibSha256": self.joblib_sha256[:12] if self.joblib_sha256 else None,
        }

    def validate_context(self, request: PredictionRequest) -> DemandFeatureBuilder:
        context = request.context
        key = next((key for key, entry in SCENARIOS.items()
            if context.businessId == entry["businessId"] and context.scenarioId == entry["scenarioId"]), None)
        if key is None:
            raise InvalidContextError("Unsupported business/scenario pair")
        if context.anchorStrategy != EXPECTED_ANCHOR_STRATEGY:
            raise InvalidContextError("Unsupported anchor strategy")
        if key not in self.builders:
            raise ModelUnavailableError("Inference runtime is unavailable")
        expected = SCENARIOS[key]["anchorOperationalDate"]
        if context.anchorOperationalDate.isoformat() != expected:
            raise InvalidContextError("Unsupported anchorOperationalDate")
        return self.builders[key]

    @staticmethod
    def _item_history(item: Any, anchor: Any) -> list[dict[str, Any]]:
        coverage = item.historyCoverage
        if not coverage.complete:
            raise FeatureBuildError(INVALID_HISTORY, "History coverage is not complete")
        if coverage.start > coverage.end or coverage.end != anchor:
            raise FeatureBuildError(INVALID_HISTORY, "History coverage range is invalid")
        if item.dailySales[0].date != coverage.start or item.dailySales[-1].date != coverage.end:
            raise FeatureBuildError(INVALID_HISTORY, "dailySales does not match historyCoverage")
        return [
            {"date": record.date.isoformat(), "unitsSold": record.unitsSold}
            for record in item.dailySales
        ]

    @staticmethod
    def _validate_batch_uniqueness(request: PredictionRequest) -> None:
        product_ids: set[str] = set()
        skus: set[str] = set()
        for item in request.items:
            if item.productId in product_ids:
                raise DuplicateBatchItemError("productId")
            if item.sku in skus:
                raise DuplicateBatchItemError("sku")
            product_ids.add(item.productId)
            skus.add(item.sku)

    def predict_batch(self, request: PredictionRequest) -> BatchPrediction:
        if not self.available or self.pipeline is None or self.builder is None:
            raise ModelUnavailableError("Inference runtime is unavailable")
        builder = self.validate_context(request)
        self._validate_batch_uniqueness(request)
        pending: list[tuple[int, pd.DataFrame]] = []
        results: list[PredictionResult | None] = [None] * len(request.items)
        source_anchor = request.context.anchorOperationalDate - timedelta(
            days=builder.manifest["date_offset_days"]
        )
        for index, item in enumerate(request.items):
            try:
                daily_sales = self._item_history(
                    item, request.context.anchorOperationalDate
                )
                built = builder.build(
                    item.sku,
                    request.context.anchorOperationalDate,
                    daily_sales,
                    business_id=request.context.businessId,
                    scenario_id=request.context.scenarioId,
                    anchor_strategy=request.context.anchorStrategy,
                )
                pending.append((index, built.features))
            except FeatureBuildError as error:
                results[index] = PredictionResult(
                    productId=item.productId,
                    sku=item.sku,
                    status=error.code,
                    message=str(error),
                )

        if pending:
            batch = pd.concat([frame for _, frame in pending], ignore_index=True)
            try:
                ordered = validate_and_order_features(batch, self.contract)
                raw = np.asarray(self.pipeline.predict(ordered), dtype=np.float64)
            except Exception as error:
                raise ModelUnavailableError("Model prediction failed") from error
            if raw.shape != (len(pending),) or not np.isfinite(raw).all():
                raise ModelUnavailableError("Model returned invalid predictions")
            clipped = np.maximum(raw, 0.0)
            for (result_index, _), prediction in zip(pending, clipped):
                item = request.items[result_index]
                value = float(prediction)
                if not math.isfinite(value):
                    raise ModelUnavailableError("Model returned an invalid scalar")
                results[result_index] = PredictionResult(
                    productId=item.productId,
                    sku=item.sku,
                    status="READY",
                    predictedDemand7d=value,
                )
        finalized = [result for result in results if result is not None]
        for result in finalized:
            lineage = builder.products.get(result.sku.removeprefix("M5-"))
            if lineage is not None:
                result.category = lineage.cat_id
                result.department = lineage.dept_id
        ready = sum(result.status == "READY" for result in finalized)
        return BatchPrediction(
            results=finalized,
            anchor_source_date=source_anchor,
            ready_count=ready,
            failed_count=len(finalized) - ready,
        )
