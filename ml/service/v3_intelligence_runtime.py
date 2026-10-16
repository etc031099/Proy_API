"""Local, immutable V3 intelligence serving adapters for the ML API."""
from __future__ import annotations

import hashlib
import json
import os
import time
import base64
import binascii
from collections import OrderedDict, deque
from datetime import date, datetime, timedelta
from pathlib import Path
from threading import RLock
from typing import Any

import psutil

from ml.service.v3_schemas import BUSINESS_ID, DATASET_SHA256, DATASET_VERSION, REFERENCE_DATE, SCENARIO_ID, TIMEZONE, V3Context, V3LiveMetadata
from ml.service.v3_package import verify_package
from ml.service.v3_source_pool import CanonicalRowPool
from ml.service.v3_live_context import LiveSnapshotError, LiveV3ContextStore, SNAPSHOT_MAX_BYTES
from ml.service.v3_live_business_customer import LiveBusinessCustomerAdapter, LiveDomainError
from ml.service.v3_live_inventory_supplier import LiveInventorySupplierAdapter
from ml.service.v3_live_forecast import LiveForecastAdapter
from ml.src import business_customer_supplier_v3 as m68
from ml.src import v3_baseline_bundle, v3_forecast
from ml.src.inventory_intelligence_v3 import INVENTORY_VERSION, InventoryIntelligenceV3

CONTRACT_VERSION = "m6.9b-v3-intelligence-v1"
BASKET_REPRODUCIBILITY_SHA256 = "5836aa9b5bc7d1729c0218c7336292d4985c0b997224fc64e1f8ab3ae726c086"
BASKET_ANALYSIS_VERSION = "MINIMARKET-PASCO-V3-MBA-v1"
BASKET_CUTOFF = date(2026, 10, 12)
FORECAST_STRATEGY_VERSION = v3_baseline_bundle.STRATEGY_VERSION


class V3FunctionalError(Exception):
    def __init__(self, code: str, status_code: int, message: str):
        super().__init__(message)
        self.code, self.status_code, self.message = code, status_code, message


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _rss_mb() -> float:
    return round(psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024), 2)


class V3IntelligenceRuntime:
    """Loads approved, local V3 artifacts once; never accepts a datasource URI."""

    def __init__(self, repository_root: Path | None = None):
        self.root = Path(repository_root or Path(__file__).resolve().parents[2]).resolve()
        self.alive = True
        self.ready = False
        self.load_error_code: str | None = None
        self.domains = {name: False for name in ("business", "inventory", "forecast", "crossSell", "customer", "supplier", "health")}
        self.domain_errors: dict[str, str] = {}
        self.loading_metrics: dict[str, float | int | None] = {
            "rssBaselineMb": _rss_mb(), "rssAfterForecastBundleMb": None,
            "rssAfterMarketBasketMb": None, "rssAfterFirstAnalyticsMb": None,
            "forecastBundleLoadMs": None, "marketBasketLoadMs": None,
        }
        self.latencies: dict[str, deque[float]] = {}
        self.dataset = None
        self.records: dict[str, Any] = {}
        self.static: dict[str, Any] = {}
        self.inventory_static: dict[str, Any] = {}
        self.basket: dict[str, Any] | None = None
        self.forecast_manifest: dict[str, Any] | None = None
        self.business = self.customers = self.suppliers = self.health = None
        self.inventory = None
        self._first_request = True
        self._derived_cache: OrderedDict[tuple[str, str], Any] = OrderedDict()
        self._cache_lock = RLock()
        self._cache_limits = {"inventory": 3, "customer": 4, "supplier": 4}
        self.live_contexts = LiveV3ContextStore(max_entries=2)
        self.live_adapter = None
        self.live_inventory_supplier = None
        self.live_forecast = None

    def load(self) -> None:
        if self.ready:
            return
        try:
            verify_package(self.root)
            self.dataset = v3_forecast.load_validated_dataset(self.root)
            source_pool = CanonicalRowPool()
            source_pool.share_dataset_strings(self.dataset)
            bundle_path = self.root / "ml/models/minimarket-pasco-v3/baseline-manifest.json"
            started = time.perf_counter()
            try:
                self.forecast_manifest = v3_baseline_bundle.load_manifest(bundle_path)
            except Exception:
                self.forecast_manifest = None
                self.domain_errors["forecast"] = "ARTIFACT_UNAVAILABLE"
                self.domain_errors["inventory"] = "ARTIFACT_UNAVAILABLE"
                self.domain_errors["health"] = "ARTIFACT_UNAVAILABLE"
            self.loading_metrics["forecastBundleLoadMs"] = round((time.perf_counter() - started) * 1000, 3)
            self.loading_metrics["rssAfterForecastBundleMb"] = _rss_mb()

            basket_path = self.root / "ml/data/minimarket-pasco-v3-market-basket-v1.json"
            started = time.perf_counter()
            try:
                artifact = _read_json(basket_path)
                digest_input = {key: value for key, value in artifact.items()
                                if key not in {"timingsMs", "matrixApproxBytes", "reproducibilitySha256"}}
                actual_basket_hash = hashlib.sha256(json.dumps(
                    digest_input, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
                ).encode("utf-8")).hexdigest()
                if (actual_basket_hash != BASKET_REPRODUCIBILITY_SHA256
                        or artifact.get("reproducibilitySha256") != BASKET_REPRODUCIBILITY_SHA256
                        or artifact.get("analysisVersion") != BASKET_ANALYSIS_VERSION
                        or artifact.get("scenarioId") != SCENARIO_ID
                        or artifact.get("datasetSha256") != DATASET_SHA256
                        or artifact.get("cutoffDate") != BASKET_CUTOFF.isoformat()):
                    raise ValueError("Approved M6.7 artifact lineage mismatch")
                self.basket = artifact
                self.domains["crossSell"] = True
            except Exception:
                self.basket = None
                self.domain_errors["crossSell"] = "ARTIFACT_UNAVAILABLE"
            self.loading_metrics["marketBasketLoadMs"] = round((time.perf_counter() - started) * 1000, 3)
            self.loading_metrics["rssAfterMarketBasketMb"] = _rss_mb()

            self.records = m68.load_local_sources(self.root, dataset=self.dataset, row_loader=source_pool.read)
            self.static = m68._load_static(self.root)
            definitions_root = self.root / "data/minimarket-pasco-v3"
            self.inventory_static = {
                "products": _read_json(definitions_root / "products.json")["catalog"],
                "suppliers": _read_json(definitions_root / "suppliers.json")["suppliers"],
                "offers": _read_json(definitions_root / "supplier-offers.json"),
            }
            self.business = m68.BusinessIntelligenceV3(self.root, self.records, self.static)
            self.customers = m68.CustomerIntelligenceV3(self.root, self.records, self.static, self.business)
            self.suppliers = m68.SupplierIntelligenceV3(self.root, self.records, self.static, self.business)
            self.domains["business"] = self.domains["customer"] = self.domains["supplier"] = True
            self.live_adapter = LiveBusinessCustomerAdapter(self.root, self.records, self.static, self.business)
            if self.forecast_manifest is not None:
                self.inventory = InventoryIntelligenceV3(
                    self.root, dataset=self.dataset, operational_records=self.records,
                    static_data=self.inventory_static,
                )
                self.domains["forecast"] = self.domains["inventory"] = True
                self.health = m68.BusinessHealthSnapshotV3(
                    self.root, self.business, self.customers, self.suppliers, basket_artifact=self.basket,
                    load_basket_artifact=False,
                )
                self.domains["health"] = True
            if self.inventory is not None:
                self.live_inventory_supplier = LiveInventorySupplierAdapter(
                    self.records, self.inventory_static, self.inventory, self.suppliers)
                if self.forecast_manifest is not None:
                    self.live_forecast = LiveForecastAdapter(self.dataset, self.records)
            self.ready = True
        except Exception:
            # Keep diagnostics stable and sanitized; V1 remains independently available.
            self.load_error_code = "ARTIFACT_UNAVAILABLE"
            self.ready = False
            raise

    def public_status(self) -> dict[str, Any]:
        return {"serviceAlive": True, "v3IntelligenceReady": self.ready,
                "domains": dict(self.domains),
                "liveDomains": {name: bool(self.ready and (
                                    (getattr(self, "live_adapter", None) is not None and name in {"business", "customer"})
                                    or (getattr(self, "live_inventory_supplier", None) is not None and name in {"inventory", "supplier"})
                                    or (getattr(self, "live_forecast", None) is not None and name == "forecast")
                                    or (getattr(self, "live_adapter", None) is not None
                                        and getattr(self, "live_forecast", None) is not None
                                        and getattr(self, "live_inventory_supplier", None) is not None
                                        and getattr(self, "health", None) is not None and name == "health")))
                                for name in self.domains},
                "loadingMetrics": dict(self.loading_metrics),
                "domainErrors": dict(self.domain_errors),
                "contractVersion": CONTRACT_VERSION,
                "scenarioId": SCENARIO_ID if self.ready else None,
                "errorCode": self.load_error_code}

    def resolve_context(self, context: V3Context) -> date:
        # Fixed scenario/date binding is server-owned; a request may only narrow its cutoff.
        if context.scenarioId != SCENARIO_ID:
            raise V3FunctionalError("SCENARIO_NOT_SUPPORTED", 422, "Scenario is not enabled for V3 intelligence.")
        if context.businessId != BUSINESS_ID:
            raise V3FunctionalError("TENANT_MISMATCH", 403, "Business is not authorized for this scenario.")
        if context.datasetSha256 and context.datasetSha256 != DATASET_SHA256:
            raise V3FunctionalError("SCENARIO_NOT_SUPPORTED", 409, "Dataset lineage does not match the approved scenario.")
        if context.datasetVersion and context.datasetVersion != DATASET_VERSION:
            raise V3FunctionalError("SCENARIO_NOT_SUPPORTED", 409, "Dataset version does not match the approved scenario.")
        if context.timezone != TIMEZONE:
            raise V3FunctionalError("SCENARIO_NOT_SUPPORTED", 409, "Timezone does not match the approved scenario.")
        cutoff = context.asOfDate or REFERENCE_DATE
        if cutoff > REFERENCE_DATE or cutoff < v3_forecast.HISTORY_START:
            raise V3FunctionalError("INVALID_PERIOD", 422, "Requested cutoff is outside the available V3 history.")
        return cutoff

    def ingest_request_context(self, request, *, request_body_bytes: int):
        """Select frozen history or validate/cache an authorized LIVE context.

        LIVE analytics consume this validated context and never fall back to the
        frozen cutoff for a post-cutoff request.
        """
        if request.dataMode == "HISTORICAL":
            if request.operationalSnapshot is not None:
                raise V3FunctionalError("LIVE_SNAPSHOT_INVALID", 422,
                                       "Historical requests cannot include an operational snapshot.")
            return self.resolve_context(request.context), None
        if request.dataMode != "LIVE":
            raise V3FunctionalError("INVALID_REQUEST", 422, "Unsupported V3 data mode.")
        if request.operationalSnapshot is None:
            raise V3FunctionalError("LIVE_SNAPSHOT_REQUIRED", 422,
                                   "A complete operational snapshot is required for LIVE requests.")
        try:
            context = request.context
            live = self.live_contexts.build(
                request.operationalSnapshot, base_records=self.records,
                request_business_id=context.businessId, request_scenario_id=context.scenarioId,
                request_dataset_version=context.datasetVersion, request_dataset_sha256=context.datasetSha256,
                request_timezone=context.timezone, request_as_of_date=context.asOfDate,
                request_body_bytes=request_body_bytes,
            )
        except LiveSnapshotError as error:
            raise V3FunctionalError(error.code, error.status_code, error.message) from None
        return live.as_of_date, live

    def _run(self, domain: str, fn):
        started = time.perf_counter()
        try:
            value = fn()
            return value
        finally:
            elapsed = round((time.perf_counter() - started) * 1000, 3)
            self.latencies.setdefault(domain, deque(maxlen=100)).append(elapsed)
            if self._first_request:
                self.loading_metrics["rssAfterFirstAnalyticsMb"] = _rss_mb()
                self._first_request = False

    def latency_p50(self, domain: str) -> float | None:
        values = sorted(self.latencies.get(domain, ()))
        if not values:
            return None
        return round(values[(len(values) - 1) // 2], 3)

    def _cached(self, domain: str, cutoff: date, parameters: dict[str, Any], compute):
        """Bounded worker-local cache for immutable outputs derived from the approved V3 source."""
        engine_versions = {"inventory": INVENTORY_VERSION, "customer": m68.CUSTOMER_VERSION,
                           "supplier": m68.SUPPLIER_VERSION}
        key_payload = {
            "businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID,
            "datasetVersion": DATASET_VERSION, "datasetSha256": DATASET_SHA256,
            "asOfDate": cutoff.isoformat(), "domain": domain,
            "engineVersion": engine_versions[domain], "parameters": parameters,
        }
        key = (domain, json.dumps(key_payload, sort_keys=True, separators=(",", ":"), default=str))
        with self._cache_lock:
            if key in self._derived_cache:
                self._derived_cache.move_to_end(key)
                return self._derived_cache[key]
            value = compute()
            self._derived_cache[key] = value
            same_domain = [cached_key for cached_key in self._derived_cache if cached_key[0] == domain]
            while len(same_domain) > self._cache_limits[domain]:
                oldest = same_domain.pop(0)
                self._derived_cache.pop(oldest, None)
            return value

    def _inventory_snapshot(self, cutoff: date):
        return self._cached("inventory", cutoff, {}, lambda: self.inventory.snapshot(cutoff))

    def _customer_snapshot(self, cutoff: date):
        return self._cached("customer", cutoff, {}, lambda: self.customers.snapshot(as_of_date=cutoff))

    def _supplier_snapshot(self, cutoff: date, period, inventory):
        return self._cached("supplier", cutoff, {"period": period},
                            lambda: self.suppliers.snapshot(as_of_date=cutoff, period=period, inventory=inventory))

    @staticmethod
    def _period(period: Any, cutoff: date) -> str | dict[str, str]:
        if period is None:
            return "LAST_30_DAYS"
        if period.startDate > period.endDate or period.endDate > cutoff:
            raise V3FunctionalError("INVALID_PERIOD", 422, "Period start must not be after period end.")
        if period.endDate < v3_forecast.HISTORY_START:
            raise V3FunctionalError("INVALID_PERIOD", 422, "Period is outside the available V3 history.")
        return {"startDate": period.startDate.isoformat(), "endDate": period.endDate.isoformat()}

    def business_data(self, request):
        cutoff = self.resolve_context(request.context)
        if request.mode == "anomalies":
            from ml.service.sales_anomalies import anomalies_data
            if cutoff != REFERENCE_DATE:
                raise V3FunctionalError("INVALID_PERIOD", 422, "Frozen anomaly analysis requires its cutoff.")
            period = self._period(request.period, cutoff) if request.period else {"startDate": v3_forecast.HISTORY_START.isoformat(), "endDate": cutoff.isoformat()}
            if period["startDate"] < v3_forecast.HISTORY_START.isoformat():
                raise V3FunctionalError("INVALID_PERIOD", 422, "Anomaly period is outside frozen history.")
            return anomalies_data(self.root, period["startDate"], period["endDate"], request.limit), cutoff
        if request.productSku and request.productSku not in self.dataset.product_by_sku:
            raise V3FunctionalError("PRODUCT_NOT_FOUND", 404, "Product SKU was not found.")
        if request.categoryCode and request.categoryCode not in self.business.categories:
            raise V3FunctionalError("SCENARIO_NOT_SUPPORTED", 422, "Category is not part of the approved scenario.")
        if request.subcategoryCode and request.subcategoryCode not in {
                item["subcategoryCode"] for item in self.business.products.values()}:
            raise V3FunctionalError("SCENARIO_NOT_SUPPORTED", 422, "Subcategory is not part of the approved scenario.")
        period = self._period(request.period, cutoff)
        def calculate():
            result = self.business.summary(period, as_of_date=cutoff, category_code=request.categoryCode,
                                           subcategory_code=request.subcategoryCode,
                                           product_sku=request.productSku,
                                           comparison_mode="EQUIVALENT_PREVIOUS" if request.mode == "compare" else "NONE")
            if request.mode != "rank":
                return {key: result[key] for key in (
                    "contractVersion", "scenarioId", "datasetVersion", "datasetSha256", "asOfDate", "timezone",
                    "period", "comparisonMode", "previousPeriod", "kpis", "trends", "customerMix", "filters",
                    "marginIntelligence", "ticketIntelligence", "sourceCounts",
                )}
            if request.entityType == "category":
                key = {"revenue": "revenueCents", "units": "units", "gross_margin": "grossMarginCents",
                       "tickets": "ticketCount"}.get(request.metric or "revenue")
                rows = list(result["categoryIntelligence"])
                if request.categoryCode:
                    rows = [row for row in rows if row["categoryCode"] == request.categoryCode]
                if key is None:
                    raise V3FunctionalError("INVALID_REQUEST", 422, "Requested category ranking metric is not supported.")
                rows.sort(key=lambda row: (-row[key], row["categoryCode"]))
                return {"entityType": "category", "metric": key, "total": len(rows),
                        "items": rows[request.offset:request.offset + request.limit],
                        "period": result["period"], "currency": "PEN"}
            key = {"gross_margin": "grossMargin", "tickets": "ticketFrequency"}.get(request.metric, request.metric or "revenue")
            rows = result["rankings"].get(key)
            if rows is None:
                raise V3FunctionalError("INVALID_REQUEST", 422, "Requested business ranking metric is not supported.")
            return {"metric": key, "total": len(rows), "items": rows[request.offset:request.offset + request.limit],
                    "period": result["period"], "currency": "PEN"}
        return self._run("business", calculate), cutoff

    def live_business_data(self, request, live):
        if getattr(self, "live_adapter", None) is None:
            raise V3FunctionalError("LIVE_ANALYTICS_NOT_READY", 501, "LIVE Business analytics are not enabled.")
        try:
            return self._run("business", lambda: self.live_adapter.business_data(request, live))
        except LiveDomainError as error:
            raise V3FunctionalError(error.code, error.status_code, error.message) from None
        except ValueError as error:
            code = "INVALID_PERIOD" if "Period" in str(error) or "period" in str(error) else "DATA_NOT_AVAILABLE"
            raise V3FunctionalError(code, 422, "LIVE Business request is not supported by the available evidence.") from None

    def live_customer_data(self, request, live):
        if getattr(self, "live_adapter", None) is None:
            raise V3FunctionalError("LIVE_ANALYTICS_NOT_READY", 501, "LIVE Customer analytics are not enabled.")
        try:
            return self._run("customer", lambda: self.live_adapter.customer_data(request, live))
        except LiveDomainError as error:
            raise V3FunctionalError(error.code, error.status_code, error.message) from None
        except ValueError as error:
            code = "INVALID_PERIOD" if "Period" in str(error) or "period" in str(error) else "DATA_NOT_AVAILABLE"
            raise V3FunctionalError(code, 422, "LIVE Customer request is not supported by the available evidence.") from None

    def live_inventory_data(self, request, live):
        if getattr(self, "live_inventory_supplier", None) is None:
            raise V3FunctionalError("LIVE_ANALYTICS_NOT_READY", 501, "LIVE Inventory analytics are not enabled.")
        try:
            forecasts = self.live_forecast.all_forecasts(live) if getattr(self, "live_forecast", None) else None
            return self._run("inventory", lambda: self.live_inventory_supplier.inventory_data(request, live, forecasts))
        except LiveDomainError as error:
            raise V3FunctionalError(error.code, error.status_code, error.message) from None

    def live_supplier_data(self, request, live):
        if getattr(self, "live_inventory_supplier", None) is None:
            raise V3FunctionalError("LIVE_ANALYTICS_NOT_READY", 501, "LIVE Supplier analytics are not enabled.")
        try:
            return self._run("supplier", lambda: self.live_inventory_supplier.supplier_data(request, live))
        except LiveDomainError as error:
            raise V3FunctionalError(error.code, error.status_code, error.message) from None

    def live_forecast_data(self, request, live):
        if getattr(self, "live_forecast", None) is None:
            raise V3FunctionalError("LIVE_ANALYTICS_NOT_READY", 501, "LIVE Forecast analytics are not enabled.")
        try:
            if getattr(request, "useLiveRidge", False):
                return self._run("forecast", lambda: self._live_ridge_forecast_data(request, live)), live.as_of_date
            return self._run("forecast", lambda: self.live_forecast.forecast_data(request, live))
        except LiveDomainError as error:
            raise V3FunctionalError(error.code, error.status_code, error.message) from None

    def _live_ridge_forecast_data(self, request, live):
        from types import SimpleNamespace
        from ml.service.v3_live_ridge import LiveRidgeError, ridge_live_forecast

        if request.mode != "detail" or len(request.skus) != 1 or request.horizonDays not in (1, 7, 14):
            raise V3FunctionalError("INVALID_REQUEST", 422, "LIVE Ridge supports one product and horizons 1, 7, or 14.")
        sku = request.skus[0]
        supplied = request.activeRidgeModel
        try:
            decoded, metadata = None, None
            if supplied is not None:
                metadata = supplied.metadata.model_dump(mode="python")
                decoded = base64.b64decode(supplied.artifactDataBase64, validate=True)
                if len(decoded) != metadata["artifactBytes"] or len(decoded) > 262_144:
                    raise LiveRidgeError("ARTIFACT_INVALID", "The ACTIVE Ridge artifact size does not match its metadata.")
            ridge = ridge_live_forecast(dataset=self.dataset, live=live,
                business_id=request.context.businessId, scenario_id=request.context.scenarioId,
                sku=sku, horizon_days=request.horizonDays,
                registry_loader=lambda **_: None if metadata is None else {"metadata": metadata, "artifactData": decoded})
        except (binascii.Error, ValueError, LiveRidgeError) as error:
            through = live.snapshot.metadata.observationsClosedThrough
            reason_code = error.code if isinstance(error, LiveRidgeError) else "ARTIFACT_INVALID"
            safe_status = {"INSUFFICIENT_HISTORY": "INSUFFICIENT_HISTORY",
                           "FEATURE_UNAVAILABLE": "FEATURE_UNAVAILABLE",
                           "PRODUCT_NOT_FOUND": "FEATURE_UNAVAILABLE",
                           "MODEL_NOT_APPROVED": "MODEL_NOT_APPROVED"}.get(reason_code, "MODEL_UNAVAILABLE")
            registered = metadata or {}
            ridge = {"sku": sku, "scenarioId": request.context.scenarioId, "horizonDays": request.horizonDays,
                "targetDefinition": "effective_units_sold_cumulative_t_plus_1_through_t_plus_h",
                "forecastStartDate": (through + timedelta(days=1)).isoformat(),
                "forecastEndDate": (through + timedelta(days=request.horizonDays)).isoformat(),
                "observationsThrough": through.isoformat(), "featureVersion": "RIDGE_CAUSAL27_V1",
                "promotionPolicyVersion": "M6.10A22-PROMOTION-v1", "dataVersion": str(live.data_version),
                "snapshotHash": live.context_hash, "status": safe_status, "reasonCode": reason_code,
                "predictionUnits": None, "modelFamily": "RIDGE_REGRESSION", "recipeId": "RIDGE-CAUSAL27",
                "modelVersion": registered.get("modelVersion"), "trainedAt": registered.get("trainedAt"),
                "trainedDataVersion": registered.get("trainedDataVersion"),
                "dataCutoff": registered.get("dataCutoff"), "activeModelStatus": registered.get("status", "UNKNOWN")}
        except Exception:
            through = live.snapshot.metadata.observationsClosedThrough
            ridge = {"sku": sku, "scenarioId": request.context.scenarioId, "horizonDays": request.horizonDays,
                "targetDefinition": "effective_units_sold_cumulative_t_plus_1_through_t_plus_h",
                "forecastStartDate": (through + timedelta(days=1)).isoformat(),
                "forecastEndDate": (through + timedelta(days=request.horizonDays)).isoformat(),
                "observationsThrough": through.isoformat(), "featureVersion": "RIDGE_CAUSAL27_V1",
                "promotionPolicyVersion": "M6.10A22-PROMOTION-v1", "dataVersion": str(live.data_version),
                "snapshotHash": live.context_hash, "status": "MODEL_UNAVAILABLE", "reasonCode": "SCORING_UNAVAILABLE",
                "predictionUnits": None, "modelFamily": "RIDGE_REGRESSION", "recipeId": "RIDGE-CAUSAL27",
                "modelVersion": None, "trainedAt": None, "trainedDataVersion": None,
                "dataCutoff": None, "activeModelStatus": "UNKNOWN"}

        baseline_units, observed_series = None, []
        if request.horizonDays in (7, 14):
            try:
                baseline_request = SimpleNamespace(horizonDays=request.horizonDays, categoryCode=None, subcategoryCode=None,
                    skus=[sku], mode="detail", offset=0, limit=1, includeObservedSeries=True)
                baseline_data, _ = self.live_forecast.forecast_data(baseline_request, live)
                baseline_row = (baseline_data.get("items") or [None])[0]
                if baseline_row and baseline_row.get("status") == "READY":
                    baseline_units = baseline_row.get(f"expectedUnitsNext{request.horizonDays}d")
                    observed_series = baseline_row.get("observedSeries") or []
            except LiveDomainError:
                pass
        ridge["baselineUnits"] = baseline_units
        ridge["baselineMethod"] = "MOVING_AVERAGE_28"
        ridge["observedSeries"] = observed_series
        return {"mode": "detail", "horizonDays": request.horizonDays, "total": 1,
                "items": [ridge], "availabilityStatus": ridge["status"]}

    def live_health_data(self, request, live):
        if (getattr(self, "live_forecast", None) is None or getattr(self, "live_adapter", None) is None
                or getattr(self, "live_inventory_supplier", None) is None or self.health is None):
            raise V3FunctionalError("LIVE_ANALYTICS_NOT_READY", 501, "LIVE Business Health is not enabled.")
        from types import SimpleNamespace
        try:
            common = {"period": request.period, "offset": 0, "limit": 100,
                      "mode": "summary", "metric": "revenue", "categoryCode": None,
                      "subcategoryCode": None, "productSku": None, "entityType": None,
                      "customerCode": None, "segment": None, "supplierCode": None,
                      "productSkus": [], "skus": [], "horizonDays": 7,
                      "risk": None, "abc": None, "xyz": None, "flag": None}
            business, _ = self.live_adapter.business_data(SimpleNamespace(**{**common, "mode": "compare"}), live)
            customer, _ = self.live_adapter.customer_data(SimpleNamespace(**common), live)
            forecasts = self.live_forecast.all_forecasts(live)
            inventory = self.live_inventory_supplier._inventory_rows(live, forecasts)
            supplier, _ = self.live_inventory_supplier.supplier_data(SimpleNamespace(**common), live)

            basket_artifact = self.basket if self.basket and live.as_of_date >= BASKET_CUTOFF else None
            basket = ({"available": True, "analysisVersion": basket_artifact["analysisVersion"],
                "stableCrossSellRuleCount": sum(r.get("classification") == "CROSS_SELL"
                    and r.get("stability", {}).get("status") == "STABLE" for r in basket_artifact.get("rules", [])),
                "usefulRuleCount": basket_artifact.get("summary", {}).get("rulesAfterRedundancyReduction"),
                "topExamples": [{"antecedentSkus": r.get("antecedentSkus"), "consequentSkus": r.get("consequentSkus"),
                    "ticketCount": r.get("ticketCount"), "support": r.get("support"), "confidence": r.get("confidence"),
                    "lift": r.get("lift"), "stability": r.get("stability", {}).get("status")}
                    for r in basket_artifact.get("rules", []) if r.get("classification") == "CROSS_SELL"
                    and r.get("stability", {}).get("status") == "STABLE"][:request.limit],
                "categoryAssociations": basket_artifact.get("categoryRules", [])[:request.limit],
                "sourceArtifactCutoff": BASKET_CUTOFF.isoformat(),
                "freshness": dict(live.freshness("marketBasket"))}
                if basket_artifact else {"available": False, "reasonCode": "ARTIFACT_UNAVAILABLE",
                    "freshness": dict(live.freshness("marketBasket"))})
            offer_rows = self.suppliers._offers(BASKET_CUTOFF)
            exposure = self.suppliers._critical_exposure(inventory, offer_rows)
            supplier_component = {"suppliers": [row for row in supplier["items"]
                    if row.get("purchaseSpendSharePct") is not None],
                "summary": supplier["summary"], "criticalInventorySupplierExposure": exposure}
            customer_summary = {"segmentDistribution": customer.get("segmentDistribution", {}),
                "registeredCustomerCount": customer.get("summary", {}).get("registeredCustomerCount",
                    sum(customer.get("segmentDistribution", {}).values())),
                "customers": customer.get("items", [])}
            inventory_summary = {**inventory["summary"],
                "overstockEstimatedValueCents": None,
                "forecastSource": "MOVING_AVERAGE_28", "forecastHorizons": [1, 7, 14]}
            ready_forecasts = [row for row in forecasts if row.get("status") == "READY"]
            forecast_totals = {f"forecastExpectedUnitsNext{h}d": round(sum(float(row[f"expectedUnitsNext{h}d"])
                for row in ready_forecasts), 4) if len(ready_forecasts) == len(inventory["products"]) else None
                for h in (1, 7, 14)}
            inventory_summary.update(forecast_totals)
            insights = self.health._insights(business, customer_summary, {"summary": inventory_summary},
                                             supplier_component, basket)
            if inventory_summary.get("overstockEstimatedValueCents") is None:
                insights = [row for row in insights if row.get("code") != "OVERSTOCK_VALUE"]
            alerts = sorted(insights, key=lambda row: ({"CRITICAL": 0, "WARNING": 1, "INFO": 2}.get(row.get("severity"), 3), row.get("code", "")))[:request.limit]
            alert_codes = {row["code"] for row in alerts}
            domain_codes = {"sales": {"SALES_DOWN_VS_PREVIOUS_PERIOD"}, "margin": {"MARGIN_DOWN"},
                "customers": {"CUSTOMER_AT_RISK_COUNT"}, "inventory": {"CRITICAL_STOCK_COUNT", "OVERSTOCK_VALUE", "SINGLE_SOURCE_INVENTORY_EXPOSURE"},
                "suppliers": {"HIGH_SUPPLIER_DEPENDENCY"}, "marketBasket": {"CROSS_SELL_OPPORTUNITIES"}}
            sections = {}
            for name, codes in domain_codes.items():
                sections[name] = {"alerts": [a for a in alerts if a["code"] in codes and a["code"] in alert_codes]}
            sections["sales"].update({"kpis": business.get("kpis"), "trends": business.get("trends"), "customerMix": business.get("customerMix")})
            sections["margin"].update(business.get("marginIntelligence", {}))
            sections["customers"].update({"segmentDistribution": customer_summary["segmentDistribution"],
                "atRiskCount": customer_summary["segmentDistribution"].get("AT_RISK", 0),
                "inactiveCount": customer_summary["segmentDistribution"].get("INACTIVE", 0),
                "newCount": customer_summary["segmentDistribution"].get("NEW", 0)})
            sections["inventory"].update(inventory_summary)
            sections["suppliers"].update({"summary": supplier["summary"],
                "topSpendShares": sorted([{"supplierCode": row["supplierCode"], "sharePct": row.get("purchaseSpendSharePct")}
                    for row in supplier["items"] if row.get("purchaseSpendSharePct") is not None],
                    key=lambda row: (-row["sharePct"], row["supplierCode"]))[:5],
                "criticalInventoryExposure": exposure})
            sections["marketBasket"].update(basket)
            freshness = {name: dict(live.freshness(name)) for name in
                         ("business", "inventory", "customer", "supplier", "marketBasket")}
            freshness["business"]["engineVersion"] = LiveBusinessCustomerAdapter.ENGINE_VERSION
            freshness["customer"]["engineVersion"] = LiveBusinessCustomerAdapter.ENGINE_VERSION
            freshness["inventory"]["engineVersion"] = LiveInventorySupplierAdapter.ENGINE_VERSION
            freshness["supplier"]["engineVersion"] = LiveInventorySupplierAdapter.ENGINE_VERSION
            freshness["forecast"] = self.live_forecast._freshness(live, [row.get("observationsThrough") for row in ready_forecasts])
            if isinstance(sections["marketBasket"].get("freshness"), dict):
                freshness["marketBasket"] = sections["marketBasket"]["freshness"]
            sections["forecast"] = {"source": "MOVING_AVERAGE_28", "horizons": [1, 7, 14],
                "knownCount": len(ready_forecasts), "missingCount": len(forecasts) - len(ready_forecasts),
                **forecast_totals, "freshness": freshness["forecast"]}
            sections["sales"]["freshness"] = freshness["business"]
            sections["margin"]["freshness"] = freshness["business"]
            for name in ("inventory", "customers", "suppliers", "marketBasket"):
                freshness_key = {"customers": "customer", "suppliers": "supplier"}.get(name, name)
                sections[name]["freshness"] = freshness[freshness_key]
            inventory_partial = any(int(inventory["summary"].get(key) or 0) > 0 for key in (
                "unavailableCount", "riskUnavailableCount", "recommendationUnavailableCount",
                "abcUnavailableCount", "xyzUnavailableCount", "slowMovingUnavailableCount",
                "deadStockUnavailableCount"))
            partial = (business.get("availabilityStatus") == "PARTIAL"
                       or customer.get("availabilityStatus") == "PARTIAL"
                       or inventory["summary"].get("forecastAvailability") != "AVAILABLE"
                       or inventory_partial
                       or len(ready_forecasts) != len(forecasts) or supplier.get("availabilityStatus") == "PARTIAL"
                       or not basket.get("available"))
            return {"contractVersion": m68.HEALTH_VERSION, "scenarioId": SCENARIO_ID,
                "datasetVersion": DATASET_VERSION, "datasetSha256": DATASET_SHA256,
                "asOfDate": live.as_of_date.isoformat(), "timezone": TIMEZONE,
                "period": business.get("period"), "businessHealth": sections,
                "alerts": alerts, "healthScore": None,
                "interpretation": "LIVE and frozen domain indicators with documented rule-based insights; no composite score.",
                "availabilityStatus": "PARTIAL" if partial else "AVAILABLE", "freshness": freshness}, live.as_of_date
        except LiveDomainError as error:
            raise V3FunctionalError(error.code, error.status_code, error.message) from None
        except Exception as error:
            raise V3FunctionalError("DATA_NOT_AVAILABLE", 422,
                "LIVE Business Health is unavailable because one or more required domains lack valid evidence.") from error

    def inventory_data(self, request):
        cutoff = self.resolve_context(request.context)
        snapshot = self._run("inventory", lambda: self._inventory_snapshot(cutoff))
        rows = snapshot["products"]
        if request.skus:
            unknown = sorted(set(request.skus) - set(self.dataset.product_by_sku))
            if unknown:
                raise V3FunctionalError("PRODUCT_NOT_FOUND", 404, "One or more product SKUs were not found.")
            rows = [row for row in rows if row["sku"] in set(request.skus)]
        if request.risk:
            rows = [row for row in rows if row["risk"]["level"] == request.risk]
        if request.abc:
            rows = [row for row in rows if row["classification"]["abc"] == request.abc]
        if request.xyz:
            rows = [row for row in rows if row["classification"]["xyz"] == request.xyz]
        if request.flag:
            predicate = {
                "low_stock": lambda r: r["risk"]["lowStock"],
                "overstock": lambda r: r["classification"]["overstock"],
                "slow_moving": lambda r: r["classification"]["slowMoving"],
                "dead_stock": lambda r: r["classification"]["deadStock"],
                "single_source": lambda r: r["supplier"]["dependencyStatus"] == "SINGLE_SOURCE",
                "should_reorder": lambda r: r["recommendation"]["shouldReorder"],
            }[request.flag]
            rows = [row for row in rows if predicate(row)]
        if request.mode == "detail" and not request.skus:
            raise V3FunctionalError("AMBIGUOUS_ENTITY", 409, "A resolved product SKU is required for inventory detail.")
        has_filters = bool(request.skus or request.risk or request.abc or request.xyz or request.flag)
        if request.mode == "detail" or (request.mode == "summary" and has_filters):
            total = len(rows)
            page = rows[request.offset:request.offset + request.limit]
            data = {"total": total, "items": [self._public_inventory_row(row) for row in page]}
        elif request.mode == "summary":
            data = {"summary": snapshot["summary"], "abcCounts": snapshot["abcCounts"],
                    "xyzCounts": snapshot["xyzCounts"], "abcXyzCounts": snapshot["abcXyzCounts"]}
        else:
            metric = request.metric
            ordered_skus = snapshot["rankings"].get(metric, [])
            order = {sku: index for index, sku in enumerate(ordered_skus)}
            ranked = sorted(rows, key=lambda row: (order.get(row["sku"], len(order)), row["sku"]))
            data = {"metric": metric, "total": len(ranked),
                    "items": [self._public_inventory_row(row) for row in ranked[request.offset:request.offset + request.limit]]}
        return data, cutoff

    @staticmethod
    def _public_inventory_row(row: dict[str, Any]) -> dict[str, Any]:
        """Expose analytic fields only; omit purchase codes and order-level data."""
        return {
            "sku": row["sku"], "productName": row["productName"],
            "stock": {key: row["stock"][key] for key in ("onHand", "incoming", "inventoryPosition",
                                                            "overdueOrUnknownExpectedArrivalUnits") if key in row["stock"]},
            "coverage": {key: row["coverage"].get(key) for key in ("daysCover", "status")},
            "demand": {key: row["demand"].get(key) for key in ("expectedDaily", "expectedUnitsNext1d",
                                                                 "expectedUnitsNext7d", "expectedUnitsNext14d")},
            "inventoryPolicy": {key: row["inventoryPolicy"].get(key) for key in ("configuredMinimumStock", "safetyStock", "reorderPoint")},
            "risk": {key: row["risk"].get(key) for key in ("level", "reasonCodes", "lowStock")},
            "classification": {key: row["classification"].get(key) for key in ("abc", "xyz", "abcXyz", "overstock",
                                                                                "slowMoving", "deadStock")},
            "recommendation": {key: row["recommendation"].get(key) for key in ("shouldReorder", "recommendedQty")},
            "supplier": {key: row["supplier"].get(key) for key in ("preferredSupplierCode", "dependencyStatus",
                                                                    "activeOfferCount")},
        }

    def forecast_data(self, request):
        if request.mode == "evaluation":
            from ml.service.forecast_evaluation import load_forecast_evaluation
            cutoff = self.resolve_context(request.context)
            if cutoff != REFERENCE_DATE:
                raise V3FunctionalError("INVALID_PERIOD", 422, "Evaluation evidence has a fixed historical cutoff.")
            return load_forecast_evaluation(self.root), cutoff
        cutoff = self.resolve_context(request.context)
        if request.horizonDays not in v3_forecast.PRIMARY_HORIZONS:
            raise V3FunctionalError("UNSUPPORTED_HORIZON", 422, "Only approved 1, 7, and 14 day horizons are supported.")
        if cutoff < v3_forecast.FIRST_ORIGIN:
            raise V3FunctionalError("INSUFFICIENT_HISTORY", 422, "The selected cutoff does not have the approved 28-day history.")
        if request.mode in {"detail", "compare"} and not request.skus:
            raise V3FunctionalError("AMBIGUOUS_ENTITY", 409, "At least one resolved product SKU is required for forecast detail.")
        skus = request.skus or list(sorted(self.dataset.product_by_sku))
        unknown = sorted(set(skus) - set(self.dataset.product_by_sku))
        if unknown:
            raise V3FunctionalError("PRODUCT_NOT_FOUND", 404, "One or more product SKUs were not found.")
        if request.mode in {"rank", "summary"} and not request.skus:
            skus = list(sorted(self.dataset.product_by_sku))
        def calculate():
            rows = v3_baseline_bundle.predict_many(self.dataset, skus=skus, cutoff=cutoff)
            rows = [row for row in rows if row["status"] == "READY"]
            if request.mode == "detail" and request.includeObservedSeries:
                for row in rows:
                    history = self.dataset.inventory.get(row["sku"], {})
                    series = []
                    for offset in range(27, -1, -1):
                        day = cutoff - timedelta(days=offset)
                        observed = history.get(day.isoformat())
                        if observed is None:
                            series.append({"date": day.isoformat(), "units": None, "status": "MISSING"})
                        else:
                            units = int(observed["unitsSold"])
                            status = ("PARTIAL" if observed.get("completeness") == "PARTIAL"
                                      else "ZERO" if units == 0 else "CLOSED")
                            series.append({"date": day.isoformat(), "units": units, "status": status})
                    row["observedSeries"] = series
            key = f"expectedUnitsNext{request.horizonDays}d"
            if request.mode == "rank":
                rows.sort(key=lambda row: (-(row.get(key) or 0), row["sku"]))
                total = len(rows)
                rows = rows[request.offset:request.offset + request.limit]
                return {"mode": "rank", "horizonDays": request.horizonDays, "metric": key, "total": total, "items": rows}
            if request.mode == "summary":
                return {"mode": "summary", "horizonDays": request.horizonDays,
                        "products": len(rows), "totalExpectedUnits": round(sum(row[key] for row in rows), 4)}
            total = len(rows)
            return {"mode": request.mode, "horizonDays": request.horizonDays, "total": total,
                    "items": rows[request.offset:request.offset + request.limit]}
        return self._run("forecast", calculate), cutoff

    def cross_sell_data(self, request):
        cutoff = self.resolve_context(request.context)
        if cutoff < BASKET_CUTOFF:
            return {"available": False, "reasonCode": "ARTIFACT_UNAVAILABLE",
                    "message": "Approved association artifact is only validated at its source cutoff."}, cutoff
        if self.basket is None:
            return {"available": False, "reasonCode": "ARTIFACT_UNAVAILABLE",
                    "message": "Approved association artifact is unavailable."}, cutoff
        if request.sku and request.sku not in self.dataset.product_by_sku:
            raise V3FunctionalError("PRODUCT_NOT_FOUND", 404, "Product SKU was not found.")
        if request.categoryCode and request.categoryCode not in self.business.categories:
            raise V3FunctionalError("SCENARIO_NOT_SUPPORTED", 422, "Category is not part of the approved scenario.")
        def calculate():
            if request.mode == "summary":
                summary = self.basket.get("summary", {})
                return {"available": True, "summary": {
                    "analysisCutoff": self.basket.get("cutoffDate", BASKET_CUTOFF.isoformat()),
                    "analysisVersion": self.basket.get("analysisVersion"),
                    "validTickets": summary.get("validTickets"),
                    "itemsetsCount": summary.get("frequentItemsets"),
                    "rulesCount": summary.get("rulesAfterRedundancyReduction"),
                    "qualityRulesCount": summary.get("rulesAfterQualityFilter"),
                    "crossSellCount": summary.get("skuCrossSellRules"),
                }, "total": len(self.basket.get("rules", [])), "items": [],
                    "interpretation": "Frozen observed co-occurrence; not causality or a future sales guarantee."}
            if request.sku:
                items = list(self.basket["recommendationsBySku"].get(request.sku, []))
                total = len(items)
                return {"available": True, "sourceSku": request.sku, "total": total,
                        "items": items[request.offset:request.offset + request.limit],
                        "interpretation": "Observed co-occurrence, not causality or a future sales guarantee."}
            if request.categoryCode:
                items = [row for row in self.basket["categoryRules"]
                         if request.categoryCode in row.get("antecedentCodes", [])
                         or request.categoryCode in row.get("consequentCodes", [])]
            else:
                items = [row for row in self.basket["rules"] if row.get("classification") == "CROSS_SELL"
                         and row.get("stability", {}).get("status") == "STABLE"]
            total = len(items)
            return {"available": True, "total": total,
                    "items": items[request.offset:request.offset + request.limit],
                    "interpretation": "Observed co-occurrence, not causality or a future sales guarantee."}
        return self._run("crossSell", calculate), cutoff

    def customer_data(self, request):
        cutoff = self.resolve_context(request.context)
        if request.mode == "clustering":
            from ml.service.customer_clustering import clustering_data
            if cutoff != REFERENCE_DATE:
                raise V3FunctionalError("INVALID_PERIOD", 422, "Frozen clustering requires its training cutoff.")
            try:
                return clustering_data(self.root, request.customerCode,
                    request.assignmentRfm.model_dump() if request.assignmentRfm is not None else None,
                    request.assignmentAsOfDate.isoformat() if request.assignmentAsOfDate else cutoff.isoformat()), cutoff
            except LookupError:
                raise V3FunctionalError("CUSTOMER_NOT_FOUND", 404, "Customer code was not found.") from None
        result = self._run("customer", lambda: self._customer_snapshot(cutoff))
        rows = result["customers"]
        if request.customerCode:
            found = [row for row in rows if row["customerCode"] == request.customerCode]
            if not found:
                raise V3FunctionalError("CUSTOMER_NOT_FOUND", 404, "Customer code was not found.")
            rows = found
        if request.segment:
            rows = [row for row in rows if row["segment"] == request.segment]
        period_summary = None
        if request.period is not None:
            period = self._period(request.period, cutoff)
            start, end = period["startDate"], period["endDate"]
            sales, lines = self.business._sales(cutoff)
            codes = {row["customerCode"] for row in rows}
            period_summary = m68._period_customer_metrics(
                sales, lines, self.business.products, date.fromisoformat(start), date.fromisoformat(end), codes
            )
        if request.mode == "rank":
            field = {"spend": "totalSpentCents", "tickets": "ticketCount", "recency": "recencyDays",
                     "gross_margin": "grossMarginContributionCents"}[request.metric]
            rows = sorted(rows, key=lambda r: ((r[field] is None), -(r[field] or 0), r["customerCode"]))
        data = {"total": len(rows), "items": [self._public_customer(row) for row in rows[request.offset:request.offset + request.limit]]}
        if period_summary is not None:
            data["period"] = {"startDate": start, "endDate": end, "timezone": TIMEZONE}
            data["periodMetrics"] = {code: period_summary[code] for code in sorted(period_summary)}
        if request.mode == "summary":
            data["segmentDistribution"] = result["segmentDistribution"]
        return data, cutoff

    @staticmethod
    def _public_customer(row: dict[str, Any]) -> dict[str, Any]:
        allowed = ("customerCode", "displayName", "firstPurchaseDate", "lastPurchaseDate", "recencyDays",
                   "ticketCount", "units", "totalSpentCents", "averageTicketCents", "grossMarginContributionCents",
                   "segment", "reasonCodes", "windows", "trends30d", "preferences", "rfm90d")
        return {key: row[key] for key in allowed if key in row}

    def supplier_data(self, request):
        cutoff = self.resolve_context(request.context)
        period = self._period(request.period, cutoff)
        inventory = self._run("inventory", lambda: self._inventory_snapshot(cutoff))
        result = self._run("supplier", lambda: self._supplier_snapshot(cutoff, period, inventory))
        rows = result["suppliers"]
        if request.supplierCode:
            found = [row for row in rows if row["supplierCode"] == request.supplierCode]
            if not found:
                raise V3FunctionalError("SUPPLIER_NOT_FOUND", 404, "Supplier code was not found.")
            rows = found
        if request.productSkus:
            unknown = sorted(set(request.productSkus) - set(self.dataset.product_by_sku))
            if unknown:
                raise V3FunctionalError("PRODUCT_NOT_FOUND", 404, "One or more product SKUs were not found.")
            wanted = set(request.productSkus)
            alternatives = {row["sku"]: row.get("alternatives", []) for row in result["productAlternatives"]}
            matching_suppliers = {offer["supplierCode"] for sku in wanted
                                  for offer in alternatives.get(sku, []) if offer.get("supplierCode")}
            rows = [{**row, "productsSupplied": [product for product in row.get("productsSupplied", [])
                                                   if product.get("sku") in wanted]}
                    for row in rows if row["supplierCode"] in matching_suppliers
                    or any(product.get("sku") in wanted for product in row.get("productsSupplied", []))]
        if request.mode == "rank":
            key = request.metric
            ranking = result["rankings"].get(key)
            if ranking is None:
                raise V3FunctionalError("INVALID_REQUEST", 422, "Requested supplier ranking metric is not supported.")
            by_code = {row["supplierCode"]: row for row in rows}
            ranked_codes = [row["supplierCode"] for row in ranking]
            rows = [by_code[code] for code in ranked_codes if code in by_code]
        safe_rows = [self._public_supplier(row) for row in rows[request.offset:request.offset + request.limit]]
        if request.mode == "alternatives" and request.productSkus:
            data = {"items": [{"sku": sku, "alternatives": alternatives.get(sku, [])}
                              for sku in request.productSkus], "total": len(request.productSkus)}
        elif request.mode == "dependency":
            data = {"singleSourceCriticalOrHigh": result["criticalInventorySupplierExposure"], "items": safe_rows,
                    "total": len(rows)}
        else:
            data = {"total": len(rows), "items": safe_rows, "summary": result["summary"] if request.mode == "summary" else None}
        if request.mode == "detail" and request.supplierCode:
            data["costTrends"] = [row for row in result.get("costIntelligence", [])
                                  if row.get("supplierCode") == request.supplierCode]
        return data, cutoff

    @staticmethod
    def _public_supplier(row: dict[str, Any]) -> dict[str, Any]:
        allowed = ("supplierCode", "displayName", "purchaseOrderCount", "receivedOrderCount", "pendingOrderCount",
                   "unitsOrdered", "unitsReceived", "receivedSpendCents", "committedSpendCents", "pendingCommitmentCents",
                   "purchaseSpendSharePct", "committedSpendSharePct", "categoriesSuppliedObserved", "productsSuppliedObservedCount",
                   "offeredSkuCount", "exclusiveOfferedSkuCount", "leadTime", "punctuality", "delayRatePct", "productsSupplied")
        return {key: row[key] for key in allowed if key in row}

    def health_data(self, request):
        cutoff = self.resolve_context(request.context)
        if self.health is None or self.inventory is None:
            raise V3FunctionalError("ARTIFACT_UNAVAILABLE", 503, "Required V3 health components are unavailable.")
        period = self._period(request.period, cutoff)
        def calculate():
            business = self.business.summary(period, as_of_date=cutoff)
            customer = self._customer_snapshot(cutoff)
            inventory = self._inventory_snapshot(cutoff)
            supplier = self._supplier_snapshot(cutoff, period, inventory)
            costs = {row["sku"]: int(row.get("endingAverageCostCents", 0)) for row in self.records["products"]}
            result = self.health.snapshot(as_of_date=cutoff, period=period, business_summary=business,
                                          customer_summary=customer, supplier_summary=supplier, inventory=inventory,
                                          inventory_unit_costs=costs, dataset=self.dataset)
            limit = request.limit
            alerts = sorted(result["alerts"], key=lambda row: (
                {"CRITICAL": 0, "WARNING": 1, "INFO": 2}.get(row.get("severity"), 3), row.get("code", "")
            ))[:limit]
            selected_codes = {row["code"] for row in alerts}
            result["alerts"] = alerts
            domain_codes = {
                "sales": {"SALES_DOWN_VS_PREVIOUS_PERIOD"}, "margin": {"MARGIN_DOWN"},
                "customers": {"CUSTOMER_AT_RISK_COUNT"},
                "inventory": {"CRITICAL_STOCK_COUNT", "OVERSTOCK_VALUE", "SINGLE_SOURCE_INVENTORY_EXPOSURE"},
                "suppliers": {"HIGH_SUPPLIER_DEPENDENCY"}, "marketBasket": {"CROSS_SELL_OPPORTUNITIES"},
            }
            for domain, codes in domain_codes.items():
                section = result["businessHealth"].get(domain)
                if section is not None:
                    section["alerts"] = [row for row in alerts if row["code"] in codes and row["code"] in selected_codes]
            basket = result["businessHealth"].get("marketBasket", {})
            for key in ("topExamples", "categoryAssociations"):
                if isinstance(basket.get(key), list):
                    basket[key] = basket[key][:limit]
            exposure = result["businessHealth"].get("suppliers", {}).get("criticalInventoryExposure", {})
            if isinstance(exposure.get("exposures"), list):
                exposure["exposures"] = exposure["exposures"][:limit]
            return result
        return self._run("health", calculate), cutoff

    def metadata(self, cutoff: date, domain: str, duration_ms: float) -> dict[str, Any]:
        versions = {"business": m68.BUSINESS_VERSION, "inventory": INVENTORY_VERSION,
                    "forecast": FORECAST_STRATEGY_VERSION,
                    "crossSell": self.basket.get("analysisVersion") if self.basket else BASKET_ANALYSIS_VERSION,
                    "customer": m68.CUSTOMER_VERSION, "supplier": m68.SUPPLIER_VERSION,
                    "health": m68.HEALTH_VERSION}
        return {"scenarioId": SCENARIO_ID, "asOfDate": cutoff, "timezone": TIMEZONE,
                "datasetVersion": v3_forecast.DATASET_VERSION, "datasetSha256": DATASET_SHA256,
                "contractVersion": CONTRACT_VERSION, "source": "CANONICAL_V3_BUNDLE",
                "engineVersion": versions[domain], "versions": versions,
                "durationMs": duration_ms, "latencyP50Ms": self.latency_p50(domain)}

    def live_metadata(self, cutoff: date, domain: str, duration_ms: float, live) -> V3LiveMetadata:
        versions = {"business": m68.BUSINESS_VERSION, "customer": m68.CUSTOMER_VERSION,
                    "inventory": INVENTORY_VERSION, "supplier": m68.SUPPLIER_VERSION,
                    "forecast": FORECAST_STRATEGY_VERSION, "health": m68.HEALTH_VERSION}
        engine_by_domain = {"business": LiveBusinessCustomerAdapter.ENGINE_VERSION,
            "customer": LiveBusinessCustomerAdapter.ENGINE_VERSION,
            "inventory": LiveInventorySupplierAdapter.ENGINE_VERSION,
            "supplier": LiveInventorySupplierAdapter.ENGINE_VERSION,
            "forecast": getattr(getattr(self, "live_forecast", None), "ENGINE_VERSION", None),
            "health": "m6.9f4e-live-business-health-v1"}
        freshness = dict(live.freshness(domain))
        freshness["engineVersion"] = engine_by_domain.get(domain)
        if domain == "forecast" and getattr(self, "live_forecast", None) is not None:
            freshness.update(self.live_forecast._freshness(live, [live.snapshot.metadata.observationsClosedThrough.isoformat()]))
        if domain == "health":
            freshness["domains"] = {name: dict(live.freshness(name)) for name in
                ("business", "inventory", "customer", "supplier", "marketBasket")}
            freshness["domains"]["forecast"] = self.live_forecast._freshness(live, [live.snapshot.metadata.observationsClosedThrough.isoformat()])
        freshness = json.loads(json.dumps(
            freshness, ensure_ascii=False, allow_nan=False,
            default=lambda value: value.isoformat() if isinstance(value, (date, datetime)) else str(value),
        ))
        return V3LiveMetadata(scenarioId=SCENARIO_ID, asOfDate=cutoff, timezone=TIMEZONE,
            datasetVersion=DATASET_VERSION, datasetSha256=DATASET_SHA256,
            contractVersion="m6.9f4-live-intelligence-v1", source="HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT",
            engineVersion=engine_by_domain.get(domain), versions=versions,
            durationMs=duration_ms, latencyP50Ms=self.latency_p50(domain),
            dataVersion=live.data_version, snapshotHash=live.context_hash,
            freshness=freshness)
