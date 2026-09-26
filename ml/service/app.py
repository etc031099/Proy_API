from __future__ import annotations

import hmac
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ml.service.model_runtime import (
    DuplicateBatchItemError,
    InvalidContextError,
    ModelRuntime,
    ModelUnavailableError,
)
from ml.service.schemas import PredictionRequest, PredictionResponse


MINIMUM_SECRET_LENGTH = 32
MAX_BODY_BYTES = 2 * 1024 * 1024
SECRET_ENVIRONMENT_NAMES = (
    "JWT_SECRET",
    "WEBHOOK_SECRET",
    "NODE_RED_CREDENTIAL_SECRET",
    "NODE_RED_ADMIN_PASSWORD",
)

logger = logging.getLogger("ml.service")


def load_service_secret() -> str:
    secret = os.environ.get("ML_SERVICE_SECRET")
    if not secret or len(secret) < MINIMUM_SECRET_LENGTH or secret != secret.strip():
        raise RuntimeError("ML_SERVICE_SECRET must be at least 32 characters")
    for name in SECRET_ENVIRONMENT_NAMES:
        other = os.environ.get(name)
        if other and hmac.compare_digest(secret, other):
            raise RuntimeError(f"ML_SERVICE_SECRET must differ from {name}")
    return secret


def create_app(runtime: ModelRuntime | None = None) -> FastAPI:
    selected_runtime = runtime or ModelRuntime()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        application.state.service_secret = load_service_secret()
        try:
            selected_runtime.load()
        except ModelUnavailableError:
            logger.error(json.dumps({"event": "runtime_startup", "status": "unavailable"}))
        application.state.runtime = selected_runtime
        yield

    application = FastAPI(
        title="Demand Forecast Inference",
        version="1.0.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @application.middleware("http")
    async def enforce_body_limit(request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > MAX_BODY_BYTES:
                    return JSONResponse(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        content={"detail": "Request payload is too large"},
                    )
            except ValueError:
                return JSONResponse(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    content={"detail": "Invalid Content-Length header"},
                )
        return await call_next(request)

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, error: RequestValidationError):
        oversized = any(item.get("type") == "too_long" for item in error.errors())
        return JSONResponse(
            status_code=(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
                if oversized
                else status.HTTP_400_BAD_REQUEST
            ),
            content={"detail": "Request validation failed"},
        )

    def require_service_secret(
        request: Request,
        supplied: str | None = Header(default=None, alias="X-ML-Service-Secret"),
    ) -> None:
        if supplied is None:
            raise HTTPException(status_code=401, detail="Service authentication required")
        expected = request.app.state.service_secret
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=403, detail="Service authentication failed")

    @application.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        return request.app.state.runtime.public_health()

    @application.get("/ready")
    async def ready(request: Request) -> JSONResponse:
        current: ModelRuntime = request.app.state.runtime
        if not current.available:
            return JSONResponse(
                status_code=503,
                content={"status": "unavailable", "code": "MODEL_UNAVAILABLE"},
            )
        return JSONResponse(status_code=200, content={"status": "ready"})

    @application.post(
        "/v1/predict/demand",
        response_model=PredictionResponse,
        response_model_exclude_none=True,
        dependencies=[Depends(require_service_secret)],
    )
    async def predict(request: Request, payload: PredictionRequest) -> PredictionResponse:
        started = time.perf_counter()
        current: ModelRuntime = request.app.state.runtime
        if not current.available:
            raise HTTPException(status_code=503, detail="MODEL_UNAVAILABLE")
        try:
            batch = current.predict_batch(payload)
        except DuplicateBatchItemError as error:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "DUPLICATE_BATCH_ITEM",
                    "message": str(error),
                    "field": error.field,
                },
            ) from error
        except InvalidContextError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except ModelUnavailableError as error:
            raise HTTPException(status_code=503, detail="MODEL_UNAVAILABLE") from error
        elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
        logger.info(
            json.dumps(
                {
                    "event": "demand_prediction",
                    "requestId": payload.requestId,
                    "items_count": len(payload.items),
                    "ready_count": batch.ready_count,
                    "failed_count": batch.failed_count,
                    "elapsed_ms": elapsed_ms,
                }
            )
        )
        return PredictionResponse(
            requestId=payload.requestId,
            model=current.metadata["model_name"],
            modelVersion=current.metadata["model_version"],
            featureSetVersion=current.metadata["feature_set_version"],
            anchorOperationalDate=payload.context.anchorOperationalDate,
            anchorSourceDate=batch.anchor_source_date,
            results=batch.results,
        )

    return application


app = create_app()
