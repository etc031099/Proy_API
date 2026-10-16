"""F.4E focused tests for closed-day MA28 semantics and LIVE contracts."""
from __future__ import annotations

import unittest
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from ml.service.v3_live_forecast import LiveForecastAdapter


AS_OF = date(2026, 10, 14)
THROUGH = date(2026, 10, 13)


def _forecast_fixture(*, value=3, version="1", missing=False, new=False, partial_units=900,
                      cancelled=()):
    sku = "NEW-1" if new else "SKU-1"
    product_key = "P-NEW" if new else "P-1"
    start = date(2026, 9, 16)
    rows = {}
    for offset in range(27):
        day = start + timedelta(days=offset)
        rows[day.isoformat()] = {"unitsSold": 1, "localDate": day.isoformat()}
    rows["2026-10-12"] = {"unitsSold": 1, "localDate": "2026-10-12"}
    dataset = SimpleNamespace(product_by_sku={} if new else {"SKU-1": {"sku": "SKU-1"}},
        inventory={} if new else {"SKU-1": rows})
    closed = {}
    if not missing:
        closed[(product_key, THROUGH)] = SimpleNamespace(unitsSold=value, completeness="COMPLETE")
    live_product = {"sku": sku, "productKey": product_key, "name": "fixture", "categoryCode": "CAT"}
    metadata = SimpleNamespace(businessId="B", scenarioId="minimarket-pasco-v3",
        observationsClosedThrough=THROUGH, dataVersion=version)
    snapshot = SimpleNamespace(metadata=metadata, closedSalesDays=list(closed.values()), catalogChanges=[])
    live = SimpleNamespace(snapshot=snapshot, data_version=version, context_hash=f"hash-{version}",
        as_of_date=AS_OF, closed_sales_by_product_day=closed, products_by_key={product_key: live_product},
        products_by_sku={sku: live_product}, cancelled_transaction_keys=frozenset(cancelled),
        base_records={"sales": [], "saleItems": []}, freshness=lambda domain: {"mode": "LIVE", "domain": domain})
    # Deliberately present a partial current-day sale: it must never enter MA28.
    live.snapshot.sales = [SimpleNamespace(saleKey="PARTIAL", initialStatus="completed", localDate=AS_OF,
        lines=(SimpleNamespace(sku=sku, quantity=partial_units),))]
    return dataset, live


def _request(sku="SKU-1", horizon=7, mode="detail"):
    return SimpleNamespace(horizonDays=horizon, mode=mode, skus=[] if sku is None else [sku], categoryCode=None,
        subcategoryCode=None, offset=0, limit=5)


def _real_runtime_fixture():
    from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
    from ml.service.v3_live_context import LiveV3Context
    from ml.service.v3_schemas import BUSINESS_ID, SCENARIO_ID

    runtime = V3IntelligenceRuntime()
    runtime.load()
    products = {row["productKey"]: row for row in runtime.inventory_static["products"]}
    by_sku = {row["sku"]: row for row in products.values()}
    product_day = {}
    closed_rows = []
    for key in products:
        item = SimpleNamespace(productKey=key, localDate=THROUGH, unitsSold=0,
            completeness="COMPLETE", availability="OBSERVED", availableHours=15, onHandUsableAtOrigin=10)
        product_day[(key, THROUGH)] = item
        closed_rows.append(item)
    snapshot_metadata = SimpleNamespace(businessId=BUSINESS_ID, scenarioId=SCENARIO_ID,
        dataVersion="1", snapshotHash="a" * 64, asOfDate=AS_OF,
        dataThroughUtc=datetime(2026, 10, 14, 23, 59), observationsClosedThrough=THROUGH)
    snapshot = SimpleNamespace(metadata=snapshot_metadata, catalogChanges=[], closedSalesDays=closed_rows,
        sales=[], purchases=[], transactionChanges=[])
    live = LiveV3Context(base_records=runtime.records, snapshot=snapshot, context_hash="a" * 64,
        products_by_key=products, products_by_sku=by_sku, customers_by_key={}, suppliers_by_key={},
        stock_by_product_key={key: 10 for key in products},
        stock_by_sku={sku: 10 for sku in by_sku}, closed_sales_by_product_day=product_day,
        cancelled_transaction_keys=frozenset(), received_by_purchase_line={})
    return runtime, live


class M69F4ELiveForecastTests(unittest.TestCase):
    def test_closed_live_day_is_in_ma28_and_partial_current_day_is_excluded(self):
        dataset, live = _forecast_fixture(value=3, partial_units=1)
        adapter = LiveForecastAdapter(dataset, {})
        data, _ = adapter.forecast_data(_request(mode="rank"), live)
        row = data["items"][0]
        self.assertEqual(row["status"], "READY")
        self.assertEqual(row["observationsThrough"], "2026-10-13")
        self.assertAlmostEqual(row["expectedUnitsNext1d"], 30 / 28)
        self.assertAlmostEqual(row["expectedUnitsNext7d"], 7 * 30 / 28)
        self.assertAlmostEqual(row["expectedUnitsNext14d"], 14 * 30 / 28)
        _, larger_partial = _forecast_fixture(value=3, partial_units=999)
        unchanged, _ = adapter.forecast_data(_request(mode="rank"), larger_partial)
        self.assertEqual(row["expectedUnitsNext7d"], unchanged["items"][0]["expectedUnitsNext7d"])

    def test_write_read_partial_then_day_close_advances_forecast_window(self):
        dataset, first = _forecast_fixture(value=3, version="10", partial_units=1)
        adapter = LiveForecastAdapter(dataset, {})
        initial, _ = adapter.forecast_data(_request(mode="rank"), first)

        # N+1: a large current-day sale is still partial and therefore has no effect.
        _, partial = _forecast_fixture(value=3, version="11", partial_units=1000)
        unchanged, _ = adapter.forecast_data(_request(mode="rank"), partial)
        self.assertEqual(initial["items"][0]["expectedUnitsNext7d"],
                         unchanged["items"][0]["expectedUnitsNext7d"])

        # N+2: after advancing the operational date, Oct 14 is explicitly certified
        # CLOSED and becomes the newest observation; Oct 13 remains in the window.
        closed = SimpleNamespace(unitsSold=28, completeness="COMPLETE")
        second = SimpleNamespace(**vars(first))
        second.as_of_date = date(2026, 10, 15)
        second.data_version = "12"
        second.context_hash = "hash-12"
        second.snapshot = SimpleNamespace(**vars(first.snapshot))
        second.snapshot.metadata = SimpleNamespace(**vars(first.snapshot.metadata))
        second.snapshot.metadata.observationsClosedThrough = date(2026, 10, 14)
        second.closed_sales_by_product_day = dict(first.closed_sales_by_product_day)
        second.closed_sales_by_product_day[("P-1", date(2026, 10, 14))] = closed
        second.snapshot.closedSalesDays = [*first.snapshot.closedSalesDays, closed]
        final, _ = adapter.forecast_data(_request(mode="rank"), second)
        self.assertEqual(final["items"][0]["observationsThrough"], "2026-10-14")
        self.assertAlmostEqual(final["items"][0]["expectedUnitsNext7d"], 7 * 57 / 28)
        self.assertNotEqual(initial["items"][0]["expectedUnitsNext7d"],
                            final["items"][0]["expectedUnitsNext7d"])

    def test_certified_zero_is_observation_and_missing_day_is_not_zero(self):
        dataset, live = _forecast_fixture(value=0)
        data, _ = LiveForecastAdapter(dataset, {}).forecast_data(_request(mode="rank"), live)
        self.assertEqual(data["items"][0]["status"], "READY")
        self.assertAlmostEqual(data["items"][0]["expectedUnitsNext7d"], 7 * 27 / 28)
        dataset, live = _forecast_fixture(missing=True)
        data, _ = LiveForecastAdapter(dataset, {}).forecast_data(_request(mode="rank"), live)
        self.assertEqual(data["items"][0]["status"], "INSUFFICIENT_HISTORY")
        self.assertIsNone(data["items"][0]["expectedUnitsNext7d"])

    def test_new_sku_is_cold_start_and_28_day_horizon_stays_rejected(self):
        dataset, live = _forecast_fixture(new=True)
        data, _ = LiveForecastAdapter(dataset, {}).forecast_data(_request("NEW-1", mode="rank"), live)
        self.assertEqual(data["items"][0]["status"], "COLD_START")
        with self.assertRaises(Exception) as raised:
            LiveForecastAdapter(dataset, {}).forecast_data(_request("NEW-1", 28), live)
        self.assertEqual(raised.exception.code, "UNSUPPORTED_HORIZON")

    def test_detail_requires_resolved_sku_and_reports_insufficient_history(self):
        dataset, live = _forecast_fixture(missing=True)
        adapter = LiveForecastAdapter(dataset, {})
        with self.assertRaises(Exception) as ambiguous:
            adapter.forecast_data(_request(sku=None, mode="detail"), live)
        self.assertEqual(ambiguous.exception.code, "AMBIGUOUS_ENTITY")
        with self.assertRaises(Exception) as insufficient:
            adapter.forecast_data(_request(mode="detail"), live)
        self.assertEqual(insufficient.exception.code, "INSUFFICIENT_HISTORY")

    def test_new_snapshot_revision_invalidates_forecast_cache(self):
        dataset, first = _forecast_fixture(value=0, version="1")
        adapter = LiveForecastAdapter(dataset, {})
        before, _ = adapter.forecast_data(_request(), first)
        dataset2, second = _forecast_fixture(value=28, version="2")
        # Same adapter/base, distinct immutable snapshot revision and hash.
        after, _ = adapter.forecast_data(_request(), second)
        self.assertNotEqual(before["items"][0]["expectedUnitsNext7d"], after["items"][0]["expectedUnitsNext7d"])

    def test_frozen_historical_cancel_is_subtracted_once_from_original_day(self):
        dataset, live = _forecast_fixture(value=3, cancelled=("SALE-H",))
        historical_day = "2026-10-12"
        dataset.inventory["SKU-1"][historical_day]["unitsSold"] = 5
        live.base_records = {"sales": [{"saleCode": "SALE-H", "localDate": historical_day}],
            "saleItems": [{"saleCode": "SALE-H", "sku": "SKU-1", "unitsSold": 2,
                            "transactionStatus": "completed"}]}
        data, _ = LiveForecastAdapter(dataset, live.base_records).forecast_data(_request(), live)
        # 26 historical days at 1 + (5-2) on the frozen cancel date + 3 on Oct 13.
        self.assertAlmostEqual(data["items"][0]["expectedUnitsNext1d"], 32 / 28)

    def test_health_composes_live_domains_and_frozen_market_basket_with_freshness(self):
        from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
        runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
        runtime.live_adapter = SimpleNamespace(
            business_data=lambda _request, _live: ({"kpis": {}, "trends": {}, "marginIntelligence": {},
                "customerMix": {}, "period": {"startDate": "2026-10-13", "endDate": "2026-10-14"},
                "availabilityStatus": "AVAILABLE"}, AS_OF),
            customer_data=lambda _request, _live: ({"segmentDistribution": {"NEW": 1}, "items": [],
                "availabilityStatus": "AVAILABLE"}, AS_OF))
        forecast = [{"sku": "SKU-1", "status": "READY", "observationsThrough": "2026-10-13",
            "expectedUnitsNext1d": 1.0, "expectedUnitsNext7d": 7.0, "expectedUnitsNext14d": 14.0}]
        runtime._live_inventory_ridge_forecasts = lambda _request, _live: forecast
        runtime.live_forecast = None
        inv = {"products": [{"sku": "SKU-1", "risk": {"level": None}, "supplier": {"dependencyStatus": "MULTI_SOURCE"},
            "recommendation": {"recommendedQty": 0}}], "summary": {"products": 1, "forecastAvailability": "AVAILABLE",
                "critical": None, "overstock": 0, "inventoryValueCents": None, "riskUnavailableCount": 1,
                "recommendationUnavailableCount": 1}}
        supplier = {"items": [], "summary": {"suppliers": 1}, "availabilityStatus": "AVAILABLE"}
        runtime.live_inventory_supplier = SimpleNamespace(_inventory_rows=lambda _live, _forecast: inv,
            supplier_data=lambda _req, _live: (supplier, AS_OF), ENGINE_VERSION="inventory-supplier-v1")
        runtime.suppliers = SimpleNamespace(_offers=lambda _day: {},
            _critical_exposure=lambda _inventory, _offers: {"singleSourceCriticalOrHighSkuCount": 0, "exposures": []})
        runtime.health = SimpleNamespace(_insights=lambda *_args: [])
        runtime.basket = {"analysisVersion": "basket-v1", "summary": {"rulesAfterRedundancyReduction": 1},
            "rules": [{"classification": "CROSS_SELL", "stability": {"status": "STABLE"}}], "categoryRules": []}
        runtime.latencies, runtime._first_request = {}, False
        runtime.loading_metrics, runtime.domains = {}, {}
        runtime.records = {}
        live = SimpleNamespace(as_of_date=AS_OF,
            snapshot=SimpleNamespace(metadata=SimpleNamespace(observationsClosedThrough=THROUGH)),
            freshness=lambda domain: ({"mode": "HISTORICAL", "analysisCutoff": "2026-10-12", "artifactVersion": "basket-v1"}
                if domain == "marketBasket" else {"mode": "LIVE", "domain": domain, "dataVersion": "3"}))
        data, _ = runtime.live_health_data(SimpleNamespace(period=None, limit=5), live)
        self.assertIsNone(data["healthScore"])
        self.assertEqual(data["availabilityStatus"], "PARTIAL")
        self.assertEqual(data["businessHealth"]["inventory"]["status"], "PARTIAL")
        self.assertIsNone(data["businessHealth"]["suppliers"]["criticalInventoryExposure"]["singleSourceCriticalOrHighSkuCount"])
        self.assertTrue(data["businessHealth"]["marketBasket"]["available"])
        self.assertEqual(data["freshness"]["marketBasket"]["analysisCutoff"], "2026-10-12")
        self.assertEqual(data["freshness"]["forecast"]["mode"], "LIVE")

    def test_inventory_completion_invokes_m66_with_live_forecast(self):
        from ml.service.v3_live_inventory_supplier import LiveInventorySupplierAdapter
        from ml.src import inventory_intelligence_v3 as m66

        class Dataset:
            daily_by_sku = {"SKU-1": [{"localDate": (THROUGH - timedelta(days=i)).isoformat(),
                "unitsSold": 1, "availableHours": 15, "onHandUsableAtOrigin": 10,
                "effectiveUnitCostAtSale": 50} for i in range(27, -1, -1)]}

        class SupplierEngine:
            def _offers(self, _cutoff):
                return {}

        class InventoryEngine:
            dataset = Dataset()

        static = {"products": [{"sku": "SKU-1", "productKey": "P1", "name": "Fixture",
            "categoryCode": "CAT", "minStockInitial": 2, "preferredSupplierCode": "S1",
            "leadTimeDays": 7, "perishable": False, "shelfLifeDays": None, "supplierOffers": []}],
            "suppliers": [{"supplierCode": "S1", "displayName": "Supplier", "leadTimeStdDays": 1}],
            "offers": {"packMultipleBySupplier": {}}}
        records = {"products": [{"sku": "SKU-1", "productKey": "P1"}], "purchases": [],
            "purchaseLines": [], "sales": [], "saleItems": []}
        adapter = LiveInventorySupplierAdapter(records, static, InventoryEngine(), SupplierEngine())
        context = SimpleNamespace(as_of_date=AS_OF, snapshot=SimpleNamespace(metadata=SimpleNamespace(
            businessId="B", scenarioId="minimarket-pasco-v3"), purchases=[], transactionChanges=[],
            closedSalesDays=[], sales=[]), context_hash="h", data_version="2", products_by_key={"P1": {
                "productKey": "P1", "sku": "SKU-1", "name": "Fixture", "minStock": 2,
                "preferredSupplierCode": "S1", "supplierOffers": []}}, products_by_sku={},
            stock_for=lambda **_kw: 4, cancelled_transaction_keys=frozenset(), received_by_purchase_line={},
            freshness=lambda domain: {"mode": "LIVE", "domain": domain})
        forecast = {"SKU-1": {"sku": "SKU-1", "status": "READY", "horizon7Status": "READY",
            "horizon14Status": "READY", "cutoffDate": AS_OF.isoformat(),
            "expectedUnitsNext1d": None, "expectedUnitsNext7d": 14.0, "expectedUnitsNext14d": 28.0,
            "modelVersion7": 3, "modelVersion14": 5}}
        with patch.object(m66, "evaluate_sku", wraps=m66.evaluate_sku) as evaluate:
            result, _ = adapter.inventory_data(SimpleNamespace(mode="detail", skus=["SKU-1"], limit=5,
                offset=0, risk=None, abc=None, xyz=None, flag=None, metric="reorder"), context,
                [forecast["SKU-1"]])
        self.assertEqual(evaluate.call_count, 1)
        row = result["items"][0]
        self.assertEqual(row["forecast"]["source"], "RIDGE_CAUSAL27")
        self.assertIsNone(row["forecast"]["expected1d"])
        self.assertEqual(row["forecast"]["expected7d"], 14.0)
        self.assertEqual(row["forecast"]["expected14d"], 28.0)
        self.assertEqual(row["recommendation"]["status"], "AVAILABLE")
        self.assertIsNotNone(row["inventoryPolicy"]["reorderPoint"])
        self.assertEqual(row["forecast"]["modelVersion7"], 3)
        self.assertEqual(row["forecast"]["modelVersion14"], 5)

        adapter._cache.clear()
        summary_request = SimpleNamespace(mode="summary", skus=[], supplierCode=None, productSkus=[],
            risk=None, abc=None, xyz=None, flag=None, metric="reorder", limit=5, offset=0, period=None)
        detail_request = SimpleNamespace(mode="detail", skus=["SKU-1"], supplierCode=None, productSkus=[],
            risk=None, abc=None, xyz=None, flag=None, metric="reorder", limit=5, offset=0, period=None)
        with patch.object(adapter, "_inventory_rows", wraps=adapter._inventory_rows) as build_rows:
            adapter.inventory_data(summary_request, context, [forecast["SKU-1"]])
            detail, _ = adapter.inventory_data(detail_request, context, [forecast["SKU-1"]])
            self.assertEqual(build_rows.call_count, 1)
        self.assertEqual(detail["items"][0]["sku"], "SKU-1")

        # Configured lead time without a supported variability value must not
        # be silently treated as zero uncertainty.
        no_variability = LiveInventorySupplierAdapter(records,
            {"products": [dict(static["products"][0])],
             "suppliers": [{"supplierCode": "S1", "displayName": "Supplier"}],
             "offers": static["offers"]}, InventoryEngine(), SupplierEngine())
        unavailable, _ = no_variability.inventory_data(SimpleNamespace(mode="detail", skus=["SKU-1"], limit=5,
            offset=0, risk=None, abc=None, xyz=None, flag=None, metric="reorder"), context,
            [forecast["SKU-1"]])
        unavailable_row = unavailable["items"][0]
        self.assertIsNone(unavailable_row["risk"]["level"])
        self.assertIsNone(unavailable_row["inventoryPolicy"]["reorderPoint"])
        # Coverage is derivable from stock and the approved 7/14 demand rate;
        # missing lead-time variance blocks safety stock/reorder, not days-cover.
        self.assertEqual(unavailable_row["coverage"]["availabilityStatus"], "AVAILABLE")
        self.assertEqual(unavailable_row["inventoryPolicy"]["safetyStockStatus"], "PARTIAL")
        self.assertEqual(unavailable_row["inventoryPolicy"]["reorderStatus"], "PARTIAL")

        no_forecast, _ = adapter.inventory_data(detail_request, context, None)
        partial_row = no_forecast["items"][0]
        self.assertEqual(no_forecast["availabilityStatus"], "PARTIAL")
        self.assertEqual(partial_row["stock"]["onHand"], 4)
        self.assertEqual(partial_row["stock"]["incoming"], 0)
        self.assertEqual(partial_row["stock"]["availabilityStatus"], "AVAILABLE")
        self.assertFalse(partial_row["risk"]["lowStock"])
        self.assertIsNone(partial_row["risk"]["level"])
        self.assertIsNone(partial_row["recommendation"]["recommendedQty"])

    def test_forecast_and_health_routes_are_registered_without_changing_historical_route(self):
        from ml.service.app import create_app

        runtime = SimpleNamespace(available=True)
        v3_runtime = SimpleNamespace(ready=True, public_status=lambda: {
            "v3IntelligenceReady": True, "domains": {}, "liveDomains": {},
            "domainErrors": {}, "loadingMetrics": {}})
        app = create_app(runtime, v3_runtime)
        routes = {(route.path, tuple(sorted(route.methods or ()))) for route in app.routes}
        self.assertIn(("/v3/intelligence/forecast", ("POST",)), routes)
        self.assertIn(("/v3/intelligence/health", ("POST",)), routes)
        self.assertIn(("/v1/predict/demand", ("POST",)), routes)

    def test_live_health_readiness_requires_all_composed_engines(self):
        from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime

        runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
        runtime.ready = True
        runtime.loading_metrics, runtime.domain_errors = {}, {}
        runtime.load_error_code = None
        runtime.alive = True
        runtime.domains = {name: True for name in ("business", "inventory", "forecast", "crossSell", "customer", "supplier", "health")}
        runtime.live_adapter = object()
        runtime.live_inventory_supplier = object()
        runtime.health = None
        self.assertFalse(runtime.public_status()["liveDomains"]["health"])
        runtime.health = object()
        self.assertTrue(runtime.public_status()["liveDomains"]["health"])

    def test_inventory_health_scorer_uses_only_ridge_seven_and_fourteen_without_baseline(self):
        from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime

        runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
        runtime.dataset = SimpleNamespace(products=[{"sku": "SKU-1"}])
        runtime.live_forecast = SimpleNamespace(all_forecasts=lambda _live: self.fail("MA28 LIVE must not be called"))
        scored = []
        def score(request, _live, *, include_baseline=True):
            scored.append((request.horizonDays, request.activeRidgeModel.metadata.horizonDays, include_baseline))
            return {"items": [{"status": "READY", "predictionUnits": float(request.horizonDays),
                "modelVersion": request.activeRidgeModel.metadata.modelVersion}]}
        runtime._live_ridge_forecast_data = score
        models = [SimpleNamespace(metadata=SimpleNamespace(horizonDays=horizon, modelVersion=version,
                artifactHash="a" * 64, featureHash="b" * 64, promotionPolicyHash="c" * 64))
            for horizon, version in ((7, 3), (14, 5))]
        request = SimpleNamespace(activeRidgeModels=models, context=SimpleNamespace(
            businessId="B", scenarioId="minimarket-pasco-v3"))
        live = SimpleNamespace(products_by_key={}, snapshot=SimpleNamespace(metadata=SimpleNamespace(
            observationsClosedThrough=THROUGH)), data_version="2", context_hash="h")
        result = runtime._live_inventory_ridge_forecasts(request, live)
        self.assertEqual(scored, [(7, 7, False), (14, 14, False)])
        self.assertEqual(result[0]["expectedUnitsNext7d"], 7.0)
        self.assertEqual(result[0]["expectedUnitsNext14d"], 14.0)
        self.assertIsNone(result[0].get("expectedUnitsNext1d"))
        self.assertEqual((result[0]["modelVersion7"], result[0]["modelVersion14"]), (3, 5))

    def test_real_runtime_composes_forecast_inventory_and_health_on_certified_fixture(self):
        runtime, live = _real_runtime_fixture()

        forecast, _ = runtime.live_forecast_data(_request(sku=None, mode="summary"), live)
        inventory, _ = runtime.live_inventory_data(SimpleNamespace(mode="summary", skus=[], supplierCode=None,
            productSkus=[], risk=None, abc=None, xyz=None, flag=None, metric="reorder", limit=5, offset=0,
            period=None), live)
        inventory_detail, _ = runtime.live_inventory_data(SimpleNamespace(mode="detail", skus=["PAN-FRE-001"],
            supplierCode=None, productSkus=[], risk=None, abc=None, xyz=None, flag=None, metric="reorder",
            limit=5, offset=0, period=None), live)
        health, _ = runtime.live_health_data(SimpleNamespace(period=None, limit=5), live)
        self.assertEqual(forecast["availabilityStatus"], "AVAILABLE")
        self.assertEqual(forecast["products"], 80)
        self.assertIn(inventory["summary"]["forecastAvailability"], {"AVAILABLE", "PARTIAL"})
        self.assertEqual(inventory["summary"]["products"], 80)
        item = inventory_detail["items"][0]
        self.assertEqual(item["forecast"]["source"], "RIDGE_CAUSAL27")
        self.assertIsNone(item["forecast"]["expected1d"])
        self.assertEqual(item["stock"]["onHand"], 10)
        if item["forecast"]["status"] == "PARTIAL":
            self.assertIsNone(item["risk"]["level"])
            self.assertIsNone(item["recommendation"]["recommendedQty"])
        self.assertIn(health["availabilityStatus"], {"AVAILABLE", "PARTIAL"})
        self.assertIsNone(health["healthScore"])
        self.assertEqual(health["freshness"]["marketBasket"]["analysisCutoff"], "2026-10-12")


if __name__ == "__main__":
    unittest.main()
