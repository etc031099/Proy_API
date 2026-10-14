"""Read persisted evaluation evidence. Never fits or predicts a model."""
from __future__ import annotations

import hashlib
import json
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class EvidenceSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class EvaluationPeriod(EvidenceSchema):
    startDate: date
    endDate: date
    rows: int | None = Field(default=None, ge=0)


class EvaluationMetrics(EvidenceSchema):
    wape: float = Field(ge=0)
    mae: float = Field(ge=0)
    rmse: float | None = Field(default=None, ge=0)
    rmsse: float | None = Field(default=None, ge=0)


class EvaluationDataset(EvidenceSchema):
    name: str
    version: str
    synthetic: bool
    rows: int = Field(gt=0)
    products: int = Field(gt=0)
    logicalHash: str = Field(pattern=r"^[a-f0-9]{64}$")


class BaselineEvaluation(EvidenceSchema):
    algorithm: str
    modelStatus: Literal["BASELINE"] = "BASELINE"
    testMetrics: EvaluationMetrics


class ModelEvaluation(EvidenceSchema):
    modelId: str
    algorithm: Literal["HistGradientBoostingRegressor"]
    modelType: Literal["MACHINE_LEARNING_REGRESSOR"] = "MACHINE_LEARNING_REGRESSOR"
    learningType: Literal["SUPERVISED_REGRESSION"] = "SUPERVISED_REGRESSION"
    task: str
    target: str
    horizonDays: int
    features: list[str]
    featureGroups: list[str]
    dataset: EvaluationDataset
    trainPeriod: EvaluationPeriod
    validationPeriod: EvaluationPeriod
    testPeriod: EvaluationPeriod
    metrics: dict[Literal["validation", "test"], EvaluationMetrics]
    baseline: BaselineEvaluation
    relativeTestWapeImprovementPct: float | None = None
    modelStatus: Literal["EVALUATED", "REJECTED_FOR_OPERATIONAL_USE"]
    version: str
    trainingCutoff: date
    artifactHash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    evaluationEvidenceHash: str = Field(pattern=r"^[a-f0-9]{64}$")
    limitations: list[str]


class OperationalMethod(EvidenceSchema):
    algorithm: Literal["MOVING_AVERAGE_28"] = "MOVING_AVERAGE_28"
    label: str
    modelType: Literal["STATISTICAL_BASELINE"] = "STATISTICAL_BASELINE"
    learningType: Literal["NOT_APPLICABLE"] = "NOT_APPLICABLE"
    modelStatus: Literal["OPERATIONAL"] = "OPERATIONAL"
    horizons: list[Literal[1, 7, 14]]
    version: str
    selectionReason: str


class OperationalEvaluation(EvidenceSchema):
    horizonDays: Literal[1, 7, 14]
    modelStatus: Literal["BASELINE"] = "BASELINE"
    testMetrics: EvaluationMetrics


class HistoricalSeries(EvidenceSchema):
    available: Literal[False] = False
    reasonCode: Literal["TEST_PREDICTIONS_NOT_PERSISTED"] = "TEST_PREDICTIONS_NOT_PERSISTED"
    points: list[dict] = Field(default_factory=list, max_length=0)


class ForecastEvaluation(EvidenceSchema):
    contractVersion: Literal["forecast-model-evaluation-v1"] = "forecast-model-evaluation-v1"
    modelEvaluation: list[ModelEvaluation]
    selectedOperationalMethod: OperationalMethod
    operationalEvaluation: list[OperationalEvaluation]
    analysisCutoff: date
    historicalSeries: HistoricalSeries


def _read(root: Path, relative: str) -> dict:
    return json.loads((root / relative).read_text(encoding="utf-8"))


def _metrics(value: dict) -> dict:
    # Only task-appropriate metrics. No derived accuracy or percentage complement.
    return {key: value[key] for key in ("wape", "mae", "rmse", "rmsse") if key in value}


@lru_cache(maxsize=4)
def _load(root: Path) -> ForecastEvaluation:
    m5 = _read(root, "ml/models/model_metadata.json")
    m5_report = _read(root, "ml/reports/ml_r4_final_evaluation.json")
    periods = _read(root, "ml/data/forecast-evaluation-periods-v1.json")
    frozen = _read(root, "docs/M6.5C-FROZEN-CONFIG.json")["frozenConfiguration"]
    h28 = _read(root, "ml/reports/m6_5c/h28.json")
    baseline = _read(root, "ml/reports/m6_5c/baseline-manifest.json")
    if (periods["dataset"]["logicalHash"] != m5["gold_logical_hash"]
            or any(periods[f"{name}Period"]["rows"] != m5_report[key] for name, key in
                   (("train", "training_rows"), ("validation", "validation_rows"), ("test", "test_rows")))
            or sum(periods[f"{name}Period"]["rows"] for name in ("train", "validation", "test")) != periods["dataset"]["rows"]
            or m5["model_type"] != "HistGradientBoostingRegressor"
            or m5["final_test_metrics"] != m5_report["test_metrics"]
            or m5["baseline_test"]["wape"] != m5_report["baseline_test_metrics"]["four_week_average"]["wape"]
            or h28["approvedExperimental"] or h28["operational"]
            or baseline["forecastStrategy"] != "MOVING_AVERAGE_28"):
        raise ValueError("Persisted evaluation lineage is inconsistent")
    legacy_hash = hashlib.sha256((root / "ml/models/demand_forecast_v1.joblib").read_bytes()).hexdigest()
    if legacy_hash != m5["joblib_sha256"]:
        raise ValueError("Legacy artifact hash differs from evaluated metadata")
    split = frozen["split"]
    period = lambda key: {"startDate": split[key][0], "endDate": split[key][1]}
    evidence_hash = lambda relative: hashlib.sha256((root / relative).read_bytes()).hexdigest()
    result = {
        "modelEvaluation": [{
            "modelId": "demand_forecast_v1", "algorithm": m5["model_type"],
            "task": "Predecir unidades vendidas en los siguientes 7 días",
            "target": m5["target"], "horizonDays": m5["prediction_horizon_days"],
            "features": m5["feature_names"],
            "featureGroups": ["Ventas históricas y variables derivadas", "Calendario y eventos", "Categoría y departamento", "Precio observado y cambios de precio"],
            "dataset": periods["dataset"],
            **{key: periods[key] for key in ("trainPeriod", "validationPeriod", "testPeriod")},
            "metrics": {"validation": _metrics(m5["validation_metrics"]), "test": _metrics(m5_report["test_metrics"])},
            "baseline": {"algorithm": "four_week_average", "testMetrics": _metrics(m5_report["baseline_test_metrics"]["four_week_average"])},
            "relativeTestWapeImprovementPct": m5["relative_test_improvement_pct"],
            "modelStatus": "EVALUATED", "version": m5["model_version"],
            "trainingCutoff": periods["validationPeriod"]["endDate"], "artifactHash": legacy_hash,
            "evaluationEvidenceHash": evidence_hash("ml/reports/ml_r4_final_evaluation.json"),
            "limitations": ["Evaluación M5/CA_3; no representa el forecast LIVE de V3.",
                             "Las métricas son del modelo de evaluación; el artefacto final se reajustó con TRAIN + VALIDATION, sin TEST.",
                             "Último origen del refit: 2016-02-14; labels hasta 2016-02-21. TEST tiene labels hasta 2016-05-22.",
                             "Sin serie TEST persistida por fecha; RMSSE inestable en series de demanda baja."],
        }, {
            "modelId": "v3-hgb-28d", "algorithm": frozen["h28"]["hyperparameters"]["estimator"],
            "task": "Evaluar ventas efectivas acumuladas a 28 días", "target": "sum(unitsSold[t+1…t+28])", "horizonDays": 28,
            "features": frozen["h28"]["features"],
            "featureGroups": ["Ventas históricas y variables derivadas", "Calendario conocido al origen", "Atributos y presentación del producto", "Precios y promociones conocidos al origen", "Stock y disponibilidad observados"],
            "dataset": {"name": "Minimarket Pasco V3 · escenario sintético", "version": baseline["datasetVersion"],
                        "synthetic": True, "rows": 29200, "products": 80, "logicalHash": frozen["datasetSha256"]},
            "trainPeriod": period("train"), "validationPeriod": period("validation"), "testPeriod": period("test"),
            "metrics": {"test": _metrics(h28["finalMetrics"]["overall"])},
            "baseline": {"algorithm": frozen["h28"]["baseline"], "testMetrics": _metrics(h28["baselineMetrics"]["overall"])},
            "modelStatus": "REJECTED_FOR_OPERATIONAL_USE", "version": frozen["h28"]["model"],
            "trainingCutoff": frozen["preTestRefitCutoff"], "artifactHash": None,
            "evaluationEvidenceHash": evidence_hash("ml/reports/m6_5c/h28.json"),
            "limitations": ["No superó los gates por categoría y productos prioritarios, aunque mejoró WAPE global frente a su baseline.",
                             "28 días no está aprobado para operación. No se creó artefacto HGB V3.",
                             "TEST_RECOVERY_RUN congelado; no retuning. Datos sintéticos y ventas restringidas por disponibilidad."],
        }],
        "selectedOperationalMethod": {"label": "Media móvil de 28 días", "horizons": baseline["config"]["horizons"],
            "version": baseline["strategyVersion"],
            "selectionReason": "En V3 se seleccionó MA28 para 1/7/14 días según el benchmark de validación y la política congelada de selección. La operación LIVE usa 28 días cerrados hasta D−1."},
        "operationalEvaluation": [{"horizonDays": h, "testMetrics": _metrics(baseline["metrics"][str(h)])} for h in baseline["config"]["horizons"]],
        "analysisCutoff": baseline["cutoffDate"], "historicalSeries": {},
    }
    return ForecastEvaluation.model_validate(result)


def load_forecast_evaluation(root: Path) -> dict:
    # Serialization returns a fresh structure; callers cannot mutate cached evidence.
    return _load(root.resolve()).model_dump(mode="json")
