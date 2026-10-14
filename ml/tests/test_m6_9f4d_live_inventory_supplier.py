"""F.4D focused tests: ledger-authorized inventory and supplier evidence."""
from __future__ import annotations

import unittest
import json
import os
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from ml.service.v3_live_inventory_supplier import LiveInventorySupplierAdapter, _risk_counts
from ml.service.v3_schemas import InventoryRequest, SupplierRequest, BUSINESS_ID
from ml.service.app import create_app
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service.v3_live_context import LiveV3ContextStore
from ml.tests.test_m6_9f3_live_context import BASE_RECORDS, signed_snapshot


class _InventoryEngine:
    dataset = None

    def snapshot(self, _cutoff):
        return {"products": []}


class _SupplierEngine:
    def snapshot(self, **_kwargs):
        return {"suppliers": [{"supplierCode": "S1", "displayName": "Proveedor uno",
            "purchaseOrderCount": 2, "receivedOrderCount": 1, "pendingOrderCount": 1,
            "unitsOrdered": 8, "unitsReceived": 4, "receivedSpendCents": 400,
            "committedSpendCents": 800, "pendingCommitmentCents": 400,
            "productsSupplied": [], "productsSuppliedObserved": ["SKU-1"],
            "leadTime": {"sampleSize": 1, "averageDays": 3.0, "medianDays": 3.0,
                "p90Days": None, "stdDevDays": 0, "sampleQuality": "LOW_SAMPLE"},
            "punctuality": {"onTimeOrders": 1, "receivedOrders": 1, "onTimeRatePct": 100,
                "delayedOrderCount": 0, "delayRatePct": 0, "sampleSize": 1}}]}


class _V1Runtime:
    available = True

    def load(self):
        return None


def _purchase(key, supplier="S1", qty=10, evidence="NONE", status="pending", promise=None):
    return SimpleNamespace(purchaseKey=key, supplierKey=supplier,
        orderedAtUtc=datetime(2026, 10, 13, tzinfo=timezone.utc), currency="PEN",
        status=status, receiptEvidence=evidence, promisedAtUtc=promise,
        lines=(SimpleNamespace(lineKey=f"{key}:1", productKey="P1", sku="SKU-1",
            quantityOrdered=qty, purchaseUnitCostCents=200, lineTotalCents=qty * 200),))


def _context(*, version="1", stock=21, purchases=(), receives=(), cancelled=()):
    changes = []
    received = {}
    for key, qty, received_at in receives:
        p = next(p for p in purchases if p.purchaseKey == key)
        line_key = p.lines[0].lineKey
        received[line_key] = qty
        changes.append(SimpleNamespace(kind="RECEIVE", eventKey=f"{key}:RECEIVE", transactionKey=key,
            effectiveAtUtc=received_at,
            lineChanges=(SimpleNamespace(lineKey=line_key, receivedQty=qty),)))
    return SimpleNamespace(
        snapshot=SimpleNamespace(metadata=SimpleNamespace(businessId="B1", scenarioId="minimarket-pasco-v3"),
            purchases=list(purchases), transactionChanges=changes, closedSalesDays=[], sales=[]),
        context_hash=f"hash-{version}", data_version=version, as_of_date=date(2026, 10, 14),
        stock_by_sku={"SKU-1": stock}, stock_for=lambda **_kw: stock,
        products_by_key={"P1": {"productKey": "P1", "sku": "SKU-1", "name": "Producto uno",
            "minStock": 5, "safetyStock": 2, "reorderPoint": 8, "preferredSupplierCode": "S1",
            "supplierOffers": []}}, suppliers_by_key={"S1": {"supplierCode": "S1", "name": "Proveedor uno"}},
        cancelled_transaction_keys=frozenset(cancelled), received_by_purchase_line=received,
        freshness=lambda domain: {"mode": "LIVE", "asOfDate": "2026-10-14", "dataVersion": version,
            "engineVersion": "fixture"})


def _adapter():
    records = {"products": [{"sku": "SKU-1", "productKey": "P1"}],
        "purchases": [], "purchaseLines": []}
    static = {"products": [{"sku": "SKU-1", "productKey": "P1", "name": "Producto uno",
        "minStockInitial": 5, "preferredSupplierCode": "S1", "safetyStock": 2, "reorderPoint": 8,
        "supplierOffers": []}],
        "suppliers": [{"supplierCode": "S1", "displayName": "Proveedor uno"}], "offers": {}}
    return LiveInventorySupplierAdapter(records, static, _InventoryEngine(), _SupplierEngine())


def _inventory_request(**kwargs):
    values = dict(mode="detail", skus=["SKU-1"], limit=5, offset=0, risk=None, abc=None,
        xyz=None, flag=None, metric="reorder")
    values.update(kwargs)
    return SimpleNamespace(**values)


def _supplier_request(**kwargs):
    values = dict(mode="detail", supplierCode=None, productSkus=[], limit=5,
        offset=0, metric="spend", period=None)
    values.update(kwargs)
    return SimpleNamespace(**values)


class M69F4DLiveInventorySupplierTests(unittest.TestCase):
    def test_risk_summary_counts_match_canonical_ranking_rows(self):
        rows = [
            {"sku": "CRIT-1", "risk": {"level": "CRITICAL"}},
            {"sku": "HIGH-1", "risk": {"level": "HIGH"}},
            {"sku": "HIGH-2", "risk": {"level": "HIGH"}},
            {"sku": "MED-1", "risk": {"level": "MEDIUM"}},
            {"sku": "LOW-1", "risk": {"level": "LOW"}},
        ]
        summary = _risk_counts(rows)
        ranked = [LiveInventorySupplierAdapter._public_inventory({**row, "productName": row["sku"]})
                  for row in rows]
        actual_from_ranking = {level.lower(): sum(row["risk"]["level"] == level for row in ranked)
                               for level in ("CRITICAL", "HIGH", "MEDIUM", "LOW")}

        self.assertEqual(summary, {"critical": 1, "high": 2, "medium": 1, "low": 1,
                                   "riskUnavailableCount": 0})
        self.assertEqual({key: summary[key] for key in actual_from_ranking}, actual_from_ranking)

    def test_risk_summary_counts_empty_inventory_as_zero(self):
        self.assertEqual(_risk_counts([]), {"critical": 0, "high": 0, "medium": 0, "low": 0,
                                            "riskUnavailableCount": 0})

    def test_risk_summary_normalizes_case_but_marks_missing_or_unknown_unavailable(self):
        normalized = _risk_counts([
            {"risk": {"level": "critical"}},
            {"risk": {"level": "HIGH"}},
        ])
        self.assertEqual(normalized, {"critical": 1, "high": 1, "medium": 0, "low": 0,
                                     "riskUnavailableCount": 0})

        unavailable = _risk_counts([
            {"risk": {"level": None}},
            {"risk": {"level": "UNKNOWN"}},
        ])
        self.assertEqual(unavailable, {"critical": None, "high": None, "medium": None,
                                       "low": None, "riskUnavailableCount": 2})

    def test_inventory_stock_is_snapshot_authority_and_revision_cache_isolated(self):
        adapter = _adapter()
        first, _ = adapter.inventory_data(_inventory_request(), _context(version="1", stock=21))
        after_sale, _ = adapter.inventory_data(_inventory_request(), _context(version="2", stock=17))
        self.assertEqual(first["items"][0]["stock"]["onHand"], 21)
        self.assertEqual(after_sale["items"][0]["stock"]["onHand"], 17)
        self.assertIsNone(after_sale["items"][0]["recommendation"]["recommendedQty"])
        self.assertEqual(after_sale["items"][0]["recommendation"]["status"], "LIVE_FORECAST_REQUIRED")

    def test_receive_decreases_incoming_without_double_adding_stock(self):
        adapter = _adapter()
        purchase = _purchase("PO-1", qty=10, promise=datetime(2026, 10, 20, tzinfo=timezone.utc))
        result, _ = adapter.inventory_data(_inventory_request(), _context(version="1", stock=21,
            purchases=(purchase,)))
        self.assertEqual(result["items"][0]["stock"]["incoming"], 10)
        purchase_received = _purchase("PO-1", qty=10, evidence="DATED_RECEIPT", status="completed",
                                       promise=datetime(2026, 10, 20, tzinfo=timezone.utc))
        received, _ = adapter.inventory_data(_inventory_request(), _context(version="2", stock=27,
            purchases=(purchase_received,), receives=(("PO-1", 10, datetime(2026, 10, 14, tzinfo=timezone.utc)),)))
        self.assertEqual(received["items"][0]["stock"]["onHand"], 27)
        self.assertEqual(received["items"][0]["stock"]["incoming"], 0)

    def test_write_read_sale_then_receive_uses_each_new_snapshot_revision(self):
        adapter = _adapter()
        initial, _ = adapter.inventory_data(_inventory_request(), _context(version="10", stock=21))
        sale_context = _context(version="11", stock=17)
        sale_context.snapshot.sales = [SimpleNamespace(saleKey="SALE-4", initialStatus="completed",
            localDate=date(2026, 10, 14), lines=(SimpleNamespace(productKey="P1", sku="SKU-1", quantity=4,
                costKnown=False, unitCostAtSaleCents=None),))]
        after_sale, _ = adapter.inventory_data(_inventory_request(), sale_context)
        purchase = _purchase("PO-WR", qty=10, evidence="DATED_RECEIPT", status="completed",
            promise=datetime(2026, 10, 20, tzinfo=timezone.utc))
        received_context = _context(version="12", stock=27, purchases=(purchase,),
            receives=(("PO-WR", 10, datetime(2026, 10, 14, tzinfo=timezone.utc)),))
        after_receive, _ = adapter.inventory_data(_inventory_request(), received_context)
        self.assertEqual(initial["items"][0]["stock"]["onHand"], 21)
        self.assertEqual(after_sale["items"][0]["stock"]["onHand"], 17)
        self.assertEqual(after_receive["items"][0]["stock"]["onHand"], 27)

    def test_cancelled_sale_does_not_mutate_or_recalculate_ledger_stock(self):
        live = _context(version="3", stock=21, cancelled=("SALE-1",))
        live.snapshot.sales = [SimpleNamespace(saleKey="SALE-1", initialStatus="completed",
            localDate=date(2026, 10, 13), lines=(SimpleNamespace(productKey="P1", sku="SKU-1", quantity=4),))]
        result, _ = _adapter().inventory_data(_inventory_request(), live)
        self.assertEqual(result["items"][0]["stock"]["onHand"], 21)

    def test_live_xyz_uses_only_13_complete_weeks_before_current_week(self):
        adapter = _adapter()
        start = date(2026, 7, 13)  # 13 full Monday-Sunday weeks before 2026-10-12.
        adapter.inventory_engine.dataset = SimpleNamespace(daily_by_sku={"SKU-1": [
            {"localDate": (start + timedelta(days=offset)).isoformat(), "unitsSold": 2,
             "availableHours": 24, "onHandUsableAtOrigin": 5, "effectiveUnitCostAtSale": 100}
            for offset in range(91)]})
        rows = adapter._inventory_rows(_context(version="xyz", stock=21))
        item = rows["products"][0]
        self.assertEqual(item["classification"]["xyzWeeksObserved"], 13)
        self.assertIsNotNone(item["classification"]["xyz"])

    def test_forecast_dependent_risk_filter_is_partial_not_empty_success(self):
        result, _ = _adapter().inventory_data(
            _inventory_request(risk="HIGH"), _context(version="risk", stock=21))
        self.assertEqual(result["availabilityStatus"], "PARTIAL")
        self.assertEqual(result["reasonCode"], "LIVE_FORECAST_REQUIRED")
        self.assertEqual(result["unavailableCount"], 1)

    def test_insufficient_slow_dead_evidence_is_null_not_false(self):
        result, _ = _adapter().inventory_data(_inventory_request(), _context(version="flags", stock=21))
        item = result["items"][0]["classification"]
        self.assertIsNone(item["slowMoving"])
        self.assertIsNone(item["deadStock"])
        self.assertEqual(item["slowMovingStatus"], "INSUFFICIENT_HISTORY")

    def test_forecast_derived_policy_is_not_mislabeled_as_current(self):
        result, _ = _adapter().inventory_data(_inventory_request(), _context(version="policy", stock=21))
        policy = result["items"][0]["inventoryPolicy"]
        self.assertIsNone(policy["safetyStock"])
        self.assertIsNone(policy["reorderPoint"])
        self.assertEqual(policy["configuredSafetyStock"], 2)
        self.assertEqual(policy["configuredReorderPoint"], 8)

    def test_supplier_new_pending_has_commitment_but_no_fabricated_lead_or_punctuality(self):
        adapter = _adapter()
        pending = _purchase("PO-NEW", supplier="S-NEW", qty=2)
        live = _context(version="4", purchases=(pending,))
        live.suppliers_by_key = {"S-NEW": {"entityKey": "S-NEW", "name": "Proveedor nuevo"}}
        adapter.static["suppliers"].append({"supplierCode": "S-NEW", "displayName": "Proveedor nuevo"})
        data, _ = adapter.supplier_data(_supplier_request(supplierCode="S-NEW"), live)
        row = data["items"][0]
        self.assertEqual(row["purchaseOrderCount"], 1)
        self.assertEqual(row["pendingOrderCount"], 1)
        self.assertEqual(row["pendingCommitmentCents"], 400)
        self.assertEqual(row["receivedOrderCount"], 0)
        self.assertIsNone(row["leadTime"]["averageDays"])
        self.assertIsNone(row["punctuality"]["onTimeRatePct"])

    def test_supplier_receive_uses_event_and_order_cost_not_current_product_cost(self):
        adapter = _adapter()
        purchase = _purchase("PO-2", qty=10, evidence="DATED_RECEIPT", status="completed")
        live = _context(version="5", stock=31, purchases=(purchase,), receives=(
            ("PO-2", 10, datetime(2026, 10, 14, tzinfo=timezone.utc)),))
        data, _ = adapter.supplier_data(_supplier_request(supplierCode="S1"), live)
        row = data["items"][0]
        self.assertEqual(row["receivedOrderCount"], 2)
        self.assertEqual(row["receivedSpendCents"], 2400)
        self.assertEqual(row["costProvenance"], ["HISTORICAL_COST", "ORDER_COST"])
        self.assertAlmostEqual(row["leadTime"]["averageDays"], 2.0)
        self.assertIsNone(row["leadTime"]["medianDays"])
        self.assertEqual(row["leadTime"]["sampleQuality"], "PARTIAL_DISTRIBUTION_UNAVAILABLE")
        self.assertEqual(data["costIntelligence"][0]["costProvenance"], ["ORDER_COST"])

    def test_supplier_frequency_period_filters_orders_without_mutating_cached_rows(self):
        adapter = _adapter()
        purchase_13 = _purchase("PO-13", qty=1)
        purchase_14 = _purchase("PO-14", qty=1)
        purchase_13 = SimpleNamespace(**{**purchase_13.__dict__,
            "orderedAtUtc": datetime(2026, 10, 13, 12, tzinfo=timezone.utc)})
        purchase_14 = SimpleNamespace(**{**purchase_14.__dict__,
            "orderedAtUtc": datetime(2026, 10, 14, 12, tzinfo=timezone.utc)})
        live = _context(version="period", purchases=(purchase_13, purchase_14))
        request_14 = _supplier_request(supplierCode="S1", period=SimpleNamespace(
            startDate=date(2026, 10, 14), endDate=date(2026, 10, 14),
            model_dump=lambda **_kwargs: {"startDate": "2026-10-14", "endDate": "2026-10-14"}))
        first, _ = adapter.supplier_data(request_14, live)
        self.assertEqual(first["items"][0]["purchaseFrequency"]["ordersInSelectedPeriod"], 1)
        request_13 = _supplier_request(supplierCode="S1", period=SimpleNamespace(
            startDate=date(2026, 10, 13), endDate=date(2026, 10, 13),
            model_dump=lambda **_kwargs: {"startDate": "2026-10-13", "endDate": "2026-10-13"}))
        second, _ = adapter.supplier_data(request_13, live)
        self.assertEqual(second["items"][0]["purchaseFrequency"]["ordersInSelectedPeriod"], 1)
        self.assertNotIn("purchaseFrequency", adapter._cache[next(iter(adapter._cache))]["suppliers"][0])

    def test_immediate_purchase_is_acquired_spend_but_not_lead_time_sample(self):
        adapter = _adapter()
        purchase = _purchase("PO-IMM", supplier="S-NEW", qty=2,
                             evidence="IMMEDIATE_PURCHASE", status="completed")
        live = _context(version="6", stock=23, purchases=(purchase,))
        live.suppliers_by_key = {"S-NEW": {"entityKey": "S-NEW", "name": "Proveedor nuevo"}}
        adapter.static["suppliers"].append({"supplierCode": "S-NEW", "displayName": "Proveedor nuevo"})
        data, _ = adapter.supplier_data(_supplier_request(supplierCode="S-NEW"), live)
        row = data["items"][0]
        self.assertEqual(row["purchaseOrderCount"], 1)
        self.assertEqual(row["receivedOrderCount"], 1)
        self.assertEqual(row["unitsReceived"], 2)
        self.assertEqual(row["receivedSpendCents"], 400)
        self.assertEqual(row["pendingOrderCount"], 0)
        self.assertEqual(row["leadTime"]["sampleSize"], 0)
        self.assertIsNone(row["leadTime"]["averageDays"])
        self.assertIsNone(row["punctuality"]["onTimeRatePct"])

    def test_cancelled_purchase_is_not_counted_as_live_pending_or_incoming(self):
        adapter = _adapter()
        purchase = _purchase("PO-CANCEL", qty=10,
            promise=datetime(2026, 10, 20, tzinfo=timezone.utc))
        live = _context(version="7", stock=21, purchases=(purchase,), cancelled=("PO-CANCEL",))
        inventory, _ = adapter.inventory_data(_inventory_request(), live)
        self.assertEqual(inventory["items"][0]["stock"]["incoming"], 0)
        supplier, _ = adapter.supplier_data(_supplier_request(supplierCode="S1"), live)
        self.assertEqual(supplier["items"][0]["purchaseOrderCount"], 2)
        self.assertEqual(supplier["items"][0]["pendingOrderCount"], 1)

    def test_live_readiness_enables_only_inventory_and_supplier_additively(self):
        from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
        runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
        runtime.ready = True
        runtime.domains = {name: True for name in ("business", "inventory", "forecast", "crossSell", "customer", "supplier", "health")}
        runtime.live_adapter = object()
        runtime.live_inventory_supplier = object()
        runtime.loading_metrics = {}
        runtime.domain_errors = {}
        runtime.load_error_code = None
        status = runtime.public_status()
        self.assertTrue(status["liveDomains"]["business"])
        self.assertTrue(status["liveDomains"]["customer"])
        self.assertTrue(status["liveDomains"]["inventory"])
        self.assertTrue(status["liveDomains"]["supplier"])
        self.assertFalse(status["liveDomains"]["forecast"])
        self.assertFalse(status["liveDomains"]["health"])

    def test_live_http_inventory_and_supplier_match_direct_adapter(self):
        secret = "test-only-m69f4d-live-http-secret"
        with patch.dict(os.environ, {"ML_SERVICE_SECRET": secret}, clear=False):
            runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
            runtime.ready = True
            runtime.domains = {name: True for name in ("business", "inventory", "forecast", "crossSell", "customer", "supplier", "health")}
            runtime.records = BASE_RECORDS
            runtime.live_contexts = LiveV3ContextStore()
            runtime.live_adapter = object()
            runtime.live_inventory_supplier = LiveInventorySupplierAdapter(
                BASE_RECORDS,
                {"products": [{"productKey": "base.P1", "sku": "P1", "name": "Producto base",
                    "minStockInitial": 2, "preferredSupplierCode": "S1", "supplierOffers": []}],
                 "suppliers": [{"supplierCode": "S1", "displayName": "Proveedor uno"}], "offers": {}},
                _InventoryEngine(), _SupplierEngine())
            runtime.loading_metrics = {}
            runtime.domain_errors = {}
            runtime.load_error_code = None
            runtime.latencies = {}
            runtime._first_request = True
            runtime.load = lambda: None
            app = create_app(_V1Runtime(), runtime)
            body = {
                "requestId": "m69f4d-http",
                "context": {"businessId": BUSINESS_ID, "scenarioId": "minimarket-pasco-v3",
                    "datasetVersion": "minimarket-pasco-v3-seed2026-v1",
                    "datasetSha256": "a90b913b6ee83174165b39eaab1526525b3aacc53cae1abe6c3f5a54a469cac8",
                    "timezone": "America/Lima", "asOfDate": "2026-10-14"},
                "dataMode": "LIVE", "operationalSnapshot": signed_snapshot().model_dump(mode="json"),
                "mode": "detail", "skus": ["P1"]}
            size = len(json.dumps(body, separators=(",", ":")).encode("utf-8"))
            request = InventoryRequest.model_validate(body)
            _, live = runtime.ingest_request_context(request, request_body_bytes=size)
            direct, _ = runtime.live_inventory_data(request, live)
            with TestClient(app) as client:
                response = client.post("/v3/intelligence/inventory", headers={"X-ML-Service-Secret": secret}, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["data"], json.loads(json.dumps(direct, ensure_ascii=False, default=str)))
                self.assertEqual(response.json()["status"], "PARTIAL")

                supplier_body = {**body, "requestId": "m69f4d-supplier-http", "mode": "detail", "skus": None,
                                 "supplierCode": "S1"}
                supplier_body.pop("skus")
                supplier_request = SupplierRequest.model_validate(supplier_body)
                supplier_size = len(json.dumps(supplier_body, separators=(",", ":")).encode("utf-8"))
                _, supplier_live = runtime.ingest_request_context(supplier_request, request_body_bytes=supplier_size)
                direct_supplier, _ = runtime.live_supplier_data(supplier_request, supplier_live)
                supplier_response = client.post("/v3/intelligence/suppliers",
                    headers={"X-ML-Service-Secret": secret}, json=supplier_body)
                self.assertEqual(supplier_response.status_code, 200, supplier_response.text)
                self.assertEqual(supplier_response.json()["data"],
                    json.loads(json.dumps(direct_supplier, ensure_ascii=False, default=str)))

    def test_live_without_snapshot_and_not_ready_forecast_errors_remain_controlled(self):
        secret = "test-only-m69f4d-live-errors-secret-000"
        with patch.dict(os.environ, {"ML_SERVICE_SECRET": secret}, clear=False):
            runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
            runtime.ready = True
            runtime.domains = {name: True for name in ("business", "inventory", "forecast", "crossSell", "customer", "supplier", "health")}
            runtime.records = BASE_RECORDS
            runtime.live_contexts = LiveV3ContextStore()
            runtime.live_adapter = object()
            runtime.live_inventory_supplier = _adapter()
            runtime.loading_metrics = {}
            runtime.domain_errors = {}
            runtime.load_error_code = None
            runtime.latencies = {}
            runtime._first_request = True
            runtime.load = lambda: None
            app = create_app(_V1Runtime(), runtime)
            body = {"requestId": "m69f4d-no-snapshot", "context": {
                "businessId": BUSINESS_ID, "scenarioId": "minimarket-pasco-v3",
                "timezone": "America/Lima", "asOfDate": "2026-10-14"}, "dataMode": "LIVE"}
            with TestClient(app) as client:
                response = client.post("/v3/intelligence/inventory", headers={"X-ML-Service-Secret": secret}, json=body)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()["detail"]["code"], "LIVE_SNAPSHOT_REQUIRED")
                forecast_body = {**body, "operationalSnapshot": signed_snapshot().model_dump(mode="json"), "horizonDays": 7}
                forecast = client.post("/v3/intelligence/forecast", headers={"X-ML-Service-Secret": secret}, json=forecast_body)
                self.assertEqual(forecast.status_code, 501)
                self.assertEqual(forecast.json()["detail"]["code"], "LIVE_ANALYTICS_NOT_READY")


if __name__ == "__main__":
    unittest.main()
