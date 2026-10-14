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
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ml.service.model_runtime import (
    DuplicateBatchItemError,
    InvalidContextError,
    ModelRuntime,
    ModelUnavailableError,
)
from ml.service.schemas import PredictionRequest, PredictionResponse
from ml.service.v3_intelligence_runtime import V3FunctionalError, V3IntelligenceRuntime
from ml.service.v3_live_context import SNAPSHOT_MAX_BYTES
from ml.service.v3_schemas import (
    BusinessRequest, CrossSellRequest, CustomerRequest, ForecastRequest, HealthRequest,
    InventoryRequest, SupplierRequest, V3HealthResponse, V3Response,
)


MINIMUM_SECRET_LENGTH = 32
MAX_BODY_BYTES = 2 * 1024 * 1024
SECRET_ENVIRONMENT_NAMES = (
    "JWT_SECRET",
    "WEBHOOK_SECRET",
    "NODE_RED_CREDENTIAL_SECRET",
    "NODE_RED_ADMIN_PASSWORD",
)

logger = logging.getLogger("ml.service")
_DEFAULT_V3_RUNTIME: V3IntelligenceRuntime | None = None


def _default_v3_runtime() -> V3IntelligenceRuntime:
    global _DEFAULT_V3_RUNTIME
    if _DEFAULT_V3_RUNTIME is None:
        _DEFAULT_V3_RUNTIME = V3IntelligenceRuntime()
    return _DEFAULT_V3_RUNTIME


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        content_length = dict(scope["headers"]).get(b"content-length")
        if content_length:
            try:
                declared_size = int(content_length)
            except ValueError:
                await JSONResponse(status_code=400, content={"detail": "Invalid Content-Length header"})(scope, receive, send)
                return
            if (scope.get("path", "").startswith("/v3/intelligence/")
                    and declared_size > SNAPSHOT_MAX_BYTES):
                await JSONResponse(status_code=413, content={"code": "LIVE_SNAPSHOT_TOO_LARGE",
                                                              "message": "V3 request exceeds the 1.5 MiB limit."})(scope, receive, send)
                return
            if declared_size > MAX_BODY_BYTES:
                await JSONResponse(status_code=413, content={"detail": "Request payload is too large"})(scope, receive, send)
                return

        # Bound real bytes before JSON parsing, regardless of the declared size.
        # Replay original chunks without joining/copying the buffered body here.
        chunks: list[Message] = []
        received_size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            received_size += len(message.get("body", b""))
            if (scope.get("path", "").startswith("/v3/intelligence/")
                    and received_size > SNAPSHOT_MAX_BYTES):
                await JSONResponse(status_code=413, content={"code": "LIVE_SNAPSHOT_TOO_LARGE",
                                                              "message": "V3 request exceeds the 1.5 MiB limit."})(scope, receive, send)
                return
            if received_size > MAX_BODY_BYTES:
                await JSONResponse(status_code=413, content={"detail": "Request payload is too large"})(scope, receive, send)
                return
            if message.get("body") or not message.get("more_body", False):
                chunks.append(message)
            if not message.get("more_body", False):
                break

        messages = iter(chunks)

        async def replay() -> Message:
            message = next(messages, None)
            return message if message is not None else await receive()

        await self.app(scope, replay, send)


def load_service_secret() -> str:
    secret = os.environ.get("ML_SERVICE_SECRET")
    if not secret or len(secret) < MINIMUM_SECRET_LENGTH or secret != secret.strip():
        raise RuntimeError("ML_SERVICE_SECRET must be at least 32 characters")
    for name in SECRET_ENVIRONMENT_NAMES:
        other = os.environ.get(name)
        if other and hmac.compare_digest(secret, other):
            raise RuntimeError(f"ML_SERVICE_SECRET must differ from {name}")
    return secret


def create_app(runtime: ModelRuntime | None = None,
               v3_runtime: V3IntelligenceRuntime | None = None) -> FastAPI:
    selected_runtime = runtime or ModelRuntime()
    selected_v3_runtime = v3_runtime or _default_v3_runtime()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        application.state.service_secret = load_service_secret()
        try:
            selected_runtime.load()
        except ModelUnavailableError:
            logger.error(json.dumps({"event": "runtime_startup", "status": "unavailable"}))
        application.state.runtime = selected_runtime
        try:
            selected_v3_runtime.load()
        except Exception:
            logger.error(json.dumps({"event": "v3_runtime_startup", "status": "unavailable",
                                     "code": "ARTIFACT_UNAVAILABLE"}))
        application.state.v3_runtime = selected_v3_runtime
        yield

    application = FastAPI(
        title="Demand Forecast Inference",
        version="1.0.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    application.add_middleware(BodyLimitMiddleware)

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, error: RequestValidationError):
        oversized = any(item.get("type") == "too_long" for item in error.errors())
        invalid_period = any("period" in str(item.get("loc", ()))
                             and item.get("type") in {"date_from_datetime_parsing", "date_parsing", "greater_than"}
                             for item in error.errors())
        code = "INVALID_PERIOD" if invalid_period else "INVALID_REQUEST"
        if not request.url.path.startswith("/v3/"):
            return JSONResponse(
                status_code=(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE if oversized else status.HTTP_400_BAD_REQUEST),
                content={"detail": "Request validation failed"},
            )
        return JSONResponse(
            status_code=(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
                if oversized
                else status.HTTP_400_BAD_REQUEST
            ),
            content={"code": code, "message": "Request validation failed."},
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

    @application.get("/v3/intelligence/health", response_model=V3HealthResponse)
    async def v3_health(request: Request) -> V3HealthResponse:
        v3 = request.app.state.v3_runtime
        v1 = request.app.state.runtime
        public = v3.public_status()
        return V3HealthResponse(serviceAlive=True, v1Ready=bool(v1.available),
                                v3IntelligenceReady=bool(public["v3IntelligenceReady"]),
                                domains=public["domains"], liveDomains=public["liveDomains"],
                                domainErrors=public["domainErrors"],
                                loadingMetrics=public["loadingMetrics"])

    @application.get("/v3/intelligence/ready")
    async def v3_ready(request: Request) -> JSONResponse:
        v3 = request.app.state.v3_runtime
        if not v3.ready:
            return JSONResponse(status_code=503, content={"status": "unavailable", "code": "ARTIFACT_UNAVAILABLE"})
        return JSONResponse(status_code=200, content={"status": "ready", "scenarioId": "minimarket-pasco-v3"})

    async def execute_v3(request: Request, payload: Any, domain: str, method: str) -> V3Response:
        current: V3IntelligenceRuntime = request.app.state.v3_runtime
        live_context = None
        if payload.dataMode == "LIVE":
            body_bytes = len(await request.body())
            if body_bytes > SNAPSHOT_MAX_BYTES:
                raise HTTPException(status_code=413, detail={"code": "LIVE_SNAPSHOT_TOO_LARGE",
                                                            "message": "V3 live snapshot exceeds the request size limit."})
            if not current.ready:
                raise HTTPException(status_code=503, detail={"code": "ARTIFACT_UNAVAILABLE",
                                                            "message": "V3 historical base is unavailable."})
            try:
                _, live_context = current.ingest_request_context(payload, request_body_bytes=body_bytes)
            except V3FunctionalError as error:
                raise HTTPException(status_code=error.status_code,
                                    detail={"code": error.code, "message": error.message}) from None
            if domain not in {"business", "customer", "inventory", "supplier"}:
                raise HTTPException(status_code=501, detail={"code": "LIVE_ANALYTICS_NOT_READY",
                    "message": "This LIVE analytics domain is not enabled yet."})
            if ((domain in {"business", "customer"} and getattr(current, "live_adapter", None) is None)
                    or (domain in {"inventory", "supplier"}
                        and getattr(current, "live_inventory_supplier", None) is None)):
                raise HTTPException(status_code=501, detail={"code": "LIVE_ANALYTICS_NOT_READY",
                    "message": "This LIVE analytics domain is not enabled yet."})
            started = time.perf_counter()
            try:
                live_method = {"business": "live_business_data", "customer": "live_customer_data",
                               "inventory": "live_inventory_data", "supplier": "live_supplier_data"}[domain]
                data, cutoff = getattr(current, live_method)(payload, live_context)
                partial = data.get("availabilityStatus") == "PARTIAL"
                return V3Response(requestId=payload.requestId, status="PARTIAL" if partial else "OK",
                    data=json.loads(json.dumps(data, ensure_ascii=False, allow_nan=False, default=str)),
                    metadata=current.live_metadata(cutoff, domain,
                        round((time.perf_counter() - started) * 1000, 3), live_context))
            except V3FunctionalError as error:
                raise HTTPException(status_code=error.status_code,
                    detail={"code": error.code, "message": error.message}) from None
            except Exception:
                logger.exception(json.dumps({"event": "v3_live_request", "domain": domain,
                    "requestId": payload.requestId, "code": "INTERNAL_SERVICE_ERROR"}))
                raise HTTPException(status_code=500, detail={"code": "INTERNAL_SERVICE_ERROR",
                    "message": "V3 live intelligence request could not be completed."}) from None
        try:
            current.ingest_request_context(payload, request_body_bytes=len(await request.body()))
        except V3FunctionalError as error:
            raise HTTPException(status_code=error.status_code,
                                detail={"code": error.code, "message": error.message}) from None
        if not current.ready:
            raise HTTPException(status_code=503, detail={"code": "ARTIFACT_UNAVAILABLE", "message": "V3 intelligence artifacts are unavailable."})
        if not current.domains.get(domain, False) and domain != "crossSell":
            raise HTTPException(status_code=503, detail={"code": "ARTIFACT_UNAVAILABLE", "message": "Approved V3 domain artifact is unavailable."})
        started = time.perf_counter()
        try:
            data, cutoff = getattr(current, method)(payload)
            partial = data.get("available") is False
            if domain == "health":
                partial = partial or data.get("businessHealth", {}).get("marketBasket", {}).get("available") is False
            return V3Response(requestId=payload.requestId, status="PARTIAL" if partial else "OK",
                               data=json.loads(json.dumps(data, ensure_ascii=False, allow_nan=False, default=str)),
                               metadata=current.metadata(cutoff, domain,
                                                        round((time.perf_counter() - started) * 1000, 3)))
        except V3FunctionalError as error:
            raise HTTPException(status_code=error.status_code,
                                detail={"code": error.code, "message": error.message}) from None
        except (FileNotFoundError, KeyError, ValueError):
            # Missing lineage/entities are normalized; no raw paths or source values escape.
            raise HTTPException(status_code=503, detail={"code": "ARTIFACT_UNAVAILABLE",
                                                        "message": "Approved V3 intelligence source is unavailable."}) from None
        except Exception:
            logger.exception(json.dumps({"event": "v3_request", "domain": domain,
                                         "requestId": payload.requestId, "code": "INTERNAL_SERVICE_ERROR"}))
            raise HTTPException(status_code=500, detail={"code": "INTERNAL_SERVICE_ERROR",
                                                        "message": "V3 intelligence request could not be completed."}) from None

    @application.post("/v3/intelligence/business", response_model=V3Response,
                      dependencies=[Depends(require_service_secret)])
    async def v3_business(request: Request, payload: BusinessRequest) -> V3Response:
        return await execute_v3(request, payload, "business", "business_data")

    @application.post("/v3/intelligence/inventory", response_model=V3Response,
                      dependencies=[Depends(require_service_secret)])
    async def v3_inventory(request: Request, payload: InventoryRequest) -> V3Response:
        return await execute_v3(request, payload, "inventory", "inventory_data")

    @application.post("/v3/intelligence/forecast", response_model=V3Response,
                      dependencies=[Depends(require_service_secret)])
    async def v3_forecast(request: Request, payload: ForecastRequest) -> V3Response:
        return await execute_v3(request, payload, "forecast", "forecast_data")

    @application.post("/v3/intelligence/cross-sell", response_model=V3Response,
                      dependencies=[Depends(require_service_secret)])
    async def v3_cross_sell(request: Request, payload: CrossSellRequest) -> V3Response:
        return await execute_v3(request, payload, "crossSell", "cross_sell_data")

    @application.post("/v3/intelligence/customers", response_model=V3Response,
                      dependencies=[Depends(require_service_secret)])
    async def v3_customer(request: Request, payload: CustomerRequest) -> V3Response:
        return await execute_v3(request, payload, "customer", "customer_data")

    @application.post("/v3/intelligence/suppliers", response_model=V3Response,
                      dependencies=[Depends(require_service_secret)])
    async def v3_supplier(request: Request, payload: SupplierRequest) -> V3Response:
        return await execute_v3(request, payload, "supplier", "supplier_data")

    @application.post("/v3/intelligence/health", response_model=V3Response,
                      dependencies=[Depends(require_service_secret)])
    async def v3_business_health(request: Request, payload: HealthRequest) -> V3Response:
        return await execute_v3(request, payload, "health", "health_data")

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
