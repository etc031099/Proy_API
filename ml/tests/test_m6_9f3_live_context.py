from __future__ import annotations

import copy
import os
import unittest
from datetime import date
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from ml.service.app import create_app
from ml.service.v3_live_context import (
    LiveSnapshotError, LiveV3ContextStore, SNAPSHOT_MAX_BYTES, _json_bytes, _wire_value, snapshot_hash,
)
from ml.service.v3_schemas import (
    BUSINESS_ID, DATASET_SHA256, DATASET_VERSION, SCENARIO_ID, TIMEZONE,
    V3OperationalSnapshot,
)

SECRET = "test-only-v3-live-secret-value-000000000"
BASE_RECORDS = {
    "products": [{"productKey": "base.P1", "sku": "P1", "name": "Producto base"}],
    "customers": [{"customerCode": "C1", "displayName": "Cliente base"}],
    "suppliers": [{"supplierCode": "S1", "displayName": "Proveedor base"}],
    "sales": [{"saleCode": "HIST-SALE-1", "status": "completed", "cancelledAt": None,
                "localDate": "2026-10-12"}],
    "saleItems": [],
    "purchases": [{"purchaseCode": "HIST-PO-1", "status": "pending"}],
    "purchaseLines": [],
}


def product_projection(key: str, sku: str, name: str) -> dict:
    return {
        "productKey": key, "sku": sku, "name": name, "active": True,
        "priceCents": 250, "currency": "PEN", "costPriceCents": 120,
        "category": "Panadería", "categoryCode": "PAN", "subcategoryCode": "PAN-FRE",
        "brand": None, "presentation": "Unidad", "sizeValue": 1, "sizeUnit": "unit",
        "containedUnits": 1, "unit": "unit", "perishable": True, "shelfLifeDays": 1,
        "minStock": 2, "safetyStock": 3, "reorderPoint": 5,
        "demandProfileKey": None, "supplierOffers": [],
    }


def empty_snapshot() -> dict:
    products = [product_projection("base.P1", "P1", "Producto base"),
                product_projection("OP-P-new", "P2", "Producto nuevo")]
    sales = [{
        "saleKey": "LIVE-SALE-1", "occurredAtUtc": "2026-10-14T18:00:00.000Z",
        "localDate": "2026-10-14", "customerKey": "OP-C-new", "currency": "PEN",
        "totalCents": 500, "initialStatus": "completed", "lines": [{
            "lineKey": "LIVE-SALE-1:0", "productKey": "OP-P-new", "sku": "P2",
            "quantity": 2, "unitPriceCents": 250, "lineTotalCents": 500,
            "unitCostAtSaleCents": None, "costBasis": "UNKNOWN", "costKnown": False, "promo": False,
        }],
    }]
    purchases = [
        {"purchaseKey": "LIVE-PO-PENDING", "supplierKey": "S1", "orderedAtUtc": "2026-10-13T15:00:00.000Z",
         "currency": "PEN", "status": "pending", "receiptEvidence": "NONE", "promisedAtUtc": None,
         "lines": [{"lineKey": "LIVE-PO-PENDING:0", "productKey": "base.P1", "sku": "P1",
                    "quantityOrdered": 4, "purchaseUnitCostCents": 100, "lineTotalCents": 400}]},
        {"purchaseKey": "LIVE-PO-RECEIVED", "supplierKey": "OP-S-new", "orderedAtUtc": "2026-10-14T17:00:00.000Z",
         "currency": "PEN", "status": "completed", "receiptEvidence": "IMMEDIATE_PURCHASE", "promisedAtUtc": None,
         "lines": [{"lineKey": "LIVE-PO-RECEIVED:0", "productKey": "OP-P-new", "sku": "P2",
                    "quantityOrdered": 3, "purchaseUnitCostCents": 150, "lineTotalCents": 450}]},
    ]
    return {
        "metadata": {
            "snapshotVersion": "v3-operational-snapshot-v1", "contractVersion": "1",
            "businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID,
            "historicalDatasetVersion": DATASET_VERSION, "historicalDatasetSha256": DATASET_SHA256,
            "historicalCutoff": "2026-10-12", "deltaStart": "2026-10-13", "timezone": TIMEZONE,
            "operationalDate": "2026-10-14", "asOfDate": "2026-10-14",
            "capturedAtUtc": "2026-10-14T20:00:00.000Z", "dataThroughUtc": "2026-10-14T18:00:00.000Z",
            "observationsClosedThrough": "2026-10-13", "dataVersion": "1", "completeness": "COMPLETE",
            "counts": {"catalogChanges": 3, "sales": len(sales), "purchases": len(purchases),
                       "transactionChanges": 0, "stockStates": 2, "closedSalesDays": 2},
            "costCoverage": {"knownSaleLines": 0, "unknownSaleLines": 1},
            "availabilityCoverage": "UNKNOWN", "snapshotHash": "0" * 64, "payloadBytes": 1,
        },
        "catalogChanges": [
            {"eventKey": "1:0:product:OP-P-new:CREATE", "effectiveAtUtc": "2026-10-13T15:00:00.000Z",
             "revision": "1", "entityType": "product", "entityKey": "OP-P-new", "operation": "CREATE",
             "projection": {"entityType": "product", "before": None, "after": products[1]}},
            {"eventKey": "1:1:customer:OP-C-new:CREATE", "effectiveAtUtc": "2026-10-13T15:00:00.000Z",
             "revision": "1", "entityType": "customer", "entityKey": "OP-C-new", "operation": "CREATE",
             "projection": {"entityType": "contact", "before": None,
                            "after": {"entityKey": "OP-C-new", "name": "Cliente nuevo", "type": "customer",
                                      "active": True, "createdAtUtc": "2026-10-13T15:00:00.000Z"}}},
            {"eventKey": "1:2:supplier:OP-S-new:CREATE", "effectiveAtUtc": "2026-10-13T15:00:00.000Z",
             "revision": "1", "entityType": "supplier", "entityKey": "OP-S-new", "operation": "CREATE",
             "projection": {"entityType": "contact", "before": None,
                            "after": {"entityKey": "OP-S-new", "name": "Proveedor nuevo", "type": "vendor",
                                      "active": True, "createdAtUtc": "2026-10-13T15:00:00.000Z"}}},
        ],
        "sales": sales, "purchases": purchases, "transactionChanges": [],
        "stockStates": [
            {"productKey": "base.P1", "sku": "P1", "onHand": 7, "stockBasis": "MONGO_LEDGER"},
            {"productKey": "OP-P-new", "sku": "P2", "onHand": 3, "stockBasis": "MONGO_LEDGER"},
        ],
        "closedSalesDays": [
            {"productKey": key, "localDate": "2026-10-13", "unitsSold": units,
             "completeness": "COMPLETE", "availability": "UNKNOWN", "availableHours": None,
             "onHandUsableAtOrigin": None}
            for key, units in (("base.P1", 0), ("OP-P-new", 0))
        ],
    }


def signed_snapshot(raw: dict | None = None) -> V3OperationalSnapshot:
    payload = copy.deepcopy(raw if raw is not None else empty_snapshot())
    payload["metadata"]["payloadBytes"] = 1
    snapshot = V3OperationalSnapshot.model_validate(payload)
    payload["metadata"]["snapshotHash"] = snapshot_hash(snapshot)
    wire = _wire_value(snapshot.model_dump(mode="python", exclude_none=False))
    wire["metadata"]["snapshotHash"] = payload["metadata"]["snapshotHash"]
    wire["metadata"]["payloadBytes"] = 0
    payload_bytes = len(_json_bytes(wire))
    for _ in range(5):
        wire["metadata"]["payloadBytes"] = payload_bytes
        measured = len(_json_bytes(wire))
        if measured == payload_bytes:
            break
        payload_bytes = measured
    payload["metadata"]["payloadBytes"] = payload_bytes
    return V3OperationalSnapshot.model_validate(payload)


def validation_args(snapshot: V3OperationalSnapshot, *, body_bytes: int = 1) -> dict:
    return {
        "base_records": BASE_RECORDS,
        "request_business_id": BUSINESS_ID,
        "request_scenario_id": SCENARIO_ID,
        "request_dataset_version": DATASET_VERSION,
        "request_dataset_sha256": DATASET_SHA256,
        "request_timezone": TIMEZONE,
        "request_as_of_date": date(2026, 10, 14),
        "request_body_bytes": body_bytes,
    }


class M69F3LiveContextTests(unittest.TestCase):
    def test_snapshot_schema_hash_and_historical_delta_overlay(self):
        snapshot = signed_snapshot()
        # Golden hash generated with the backend's JS localeCompare canonicalizer.
        # This catches Python/JavaScript ordering drift, not just self-consistency.
        self.assertEqual(
            snapshot.metadata.snapshotHash,
            "9760fa99e2445ef7631a5c8fe1f30c1542c70d3dcac3d9647466d268a5d4edd9",
        )
        with self.assertRaises(ValidationError):
            snapshot.metadata.dataVersion = "99"
        store = LiveV3ContextStore()
        context = store.build(snapshot, **validation_args(snapshot))
        self.assertEqual(context.data_version, "1")
        self.assertEqual(context.stock_for(sku="P1"), 7)
        self.assertEqual(context.stock_for(sku="P2"), 3)
        self.assertIn("P2", context.products_by_sku)
        self.assertIn("OP-C-new", context.customers_by_key)
        self.assertIn("OP-S-new", context.suppliers_by_key)
        self.assertEqual(len(list(context.iter_sales())), 2)
        self.assertEqual({row.get("purchaseCode") for row in BASE_RECORDS["purchases"]}, {"HIST-PO-1"})
        self.assertEqual(context.market_basket_cutoff, date(2026, 10, 12))
        self.assertEqual(context.forecast_readiness("P2"), "COLD_START")

    def test_pending_purchase_is_visible_but_does_not_change_authoritative_stock(self):
        snapshot = signed_snapshot()
        context = LiveV3ContextStore().build(snapshot, **validation_args(snapshot))
        pending = next(row for row in context.iter_purchases() if getattr(row, "purchaseKey", None) == "LIVE-PO-PENDING")
        self.assertEqual(pending.status, "pending")
        self.assertEqual(context.stock_for(sku="P1"), 7)

    def test_same_snapshot_reuses_context_but_new_revision_gets_new_key(self):
        store = LiveV3ContextStore(max_entries=4)
        first = signed_snapshot()
        first_context = store.build(first, **validation_args(first))
        self.assertIs(first_context, store.build(first, **validation_args(first)))
        raw = first.model_dump(mode="json")
        raw["metadata"]["dataVersion"] = "2"
        raw["metadata"]["counts"]["catalogChanges"] = 3
        second = signed_snapshot(raw)
        second_context = store.build(second, **validation_args(second))
        self.assertIsNot(first_context, second_context)
        self.assertEqual(len(store._contexts), 2)

    def test_same_revision_same_boundary_with_different_hash_is_rejected(self):
        store = LiveV3ContextStore()
        first = signed_snapshot()
        store.build(first, **validation_args(first))
        raw = first.model_dump(mode="json")
        raw["sales"][0]["totalCents"] += 1
        second = signed_snapshot(raw)
        with self.assertRaises(LiveSnapshotError) as raised:
            store.build(second, **validation_args(second))
        self.assertEqual(raised.exception.code, "SNAPSHOT_VERSION_MISMATCH")

    def test_hash_tenant_oversize_and_future_leakage_fail_closed(self):
        snapshot = signed_snapshot()
        args = validation_args(snapshot)
        args["request_body_bytes"] = SNAPSHOT_MAX_BYTES + 1
        with self.assertRaisesRegex(LiveSnapshotError, "size limit"):
            LiveV3ContextStore().build(snapshot, **args)
        wrong = validation_args(snapshot)
        wrong["request_business_id"] = "OTHER-TENANT"
        with self.assertRaises(LiveSnapshotError) as raised:
            LiveV3ContextStore().build(snapshot, **wrong)
        self.assertEqual(raised.exception.code, "TENANT_MISMATCH")
        malformed_raw = snapshot.model_dump(mode="json")
        malformed_raw["metadata"]["snapshotHash"] = "f" * 64
        malformed = V3OperationalSnapshot.model_validate(malformed_raw)
        with self.assertRaises(LiveSnapshotError) as raised:
            LiveV3ContextStore().build(malformed, **validation_args(malformed))
        self.assertEqual(raised.exception.code, "SNAPSHOT_HASH_MISMATCH")
        future_raw = snapshot.model_dump(mode="json")
        future_raw["sales"][0]["occurredAtUtc"] = "2026-10-15T10:00:00.000Z"
        future_raw["sales"][0]["localDate"] = "2026-10-15"
        future = signed_snapshot(future_raw)
        with self.assertRaisesRegex(LiveSnapshotError, "outside the LIVE delta"):
            LiveV3ContextStore().build(future, **validation_args(future))

    def test_pre_cutoff_delta_and_referential_integrity_are_rejected(self):
        raw = empty_snapshot()
        raw["sales"][0]["occurredAtUtc"] = "2026-10-12T22:00:00.000Z"
        raw["sales"][0]["localDate"] = "2026-10-12"
        bad = signed_snapshot(raw)
        with self.assertRaisesRegex(LiveSnapshotError, "outside the LIVE delta"):
            LiveV3ContextStore().build(bad, **validation_args(bad))
        raw = empty_snapshot()
        raw["sales"][0]["lines"][0]["productKey"] = "FOREIGN-PRODUCT"
        bad = signed_snapshot(raw)
        with self.assertRaises(LiveSnapshotError) as raised:
            LiveV3ContextStore().build(bad, **validation_args(bad))
        self.assertEqual(raised.exception.code, "POST_CUTOFF_DATA_INVALID")

    def test_new_catalog_update_uses_overlay_without_mutating_frozen_rows(self):
        original = BASE_RECORDS["products"][0]["name"]
        raw = empty_snapshot()
        raw["catalogChanges"].append({
            "eventKey": "1:3:product:base.P1:UPDATE", "effectiveAtUtc": "2026-10-14T14:00:00.000Z",
            "revision": "1", "entityType": "product", "entityKey": "base.P1", "operation": "UPDATE",
            "projection": {"entityType": "product", "before": product_projection("base.P1", "P1", "Producto base"),
                           "after": product_projection("base.P1", "P1", "Nombre live")},
        })
        raw["metadata"]["counts"]["catalogChanges"] = 4
        bad = signed_snapshot(raw)
        context = LiveV3ContextStore().build(bad, **validation_args(bad))
        self.assertEqual(BASE_RECORDS["products"][0]["name"], original)
        self.assertEqual(context.products_by_key["base.P1"].name, "Nombre live")


class _FakeV1:
    available = True
    def load(self):
        pass


class M69F3LiveApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = patch.dict(os.environ, {"ML_SERVICE_SECRET": SECRET}, clear=False)
        cls.env.start()
        from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
        cls.runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
        cls.runtime.ready = True
        cls.runtime.domains = {"business": True}
        cls.runtime.records = BASE_RECORDS
        cls.runtime.live_contexts = LiveV3ContextStore()
        cls.runtime.load = lambda: None
        cls.runtime.ingest_calls = 0
        original = cls.runtime.ingest_request_context
        def ingest(*args, **kwargs):
            cls.runtime.ingest_calls += 1
            return original(*args, **kwargs)
        cls.runtime.ingest_request_context = ingest
        cls.client_context = TestClient(create_app(_FakeV1(), cls.runtime))
        cls.client = cls.client_context.__enter__()
        cls.headers = {"X-ML-Service-Secret": SECRET}

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        cls.env.stop()

    def request_body(self, *, mode="LIVE", snapshot=True):
        value = {"requestId": "m69f3-api", "context": {
            "businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID, "datasetVersion": DATASET_VERSION,
            "datasetSha256": DATASET_SHA256, "timezone": TIMEZONE, "asOfDate": "2026-10-14",
        }, "dataMode": mode}
        if snapshot:
            value["operationalSnapshot"] = signed_snapshot().model_dump(mode="json")
        return value

    def test_live_snapshot_is_validated_but_not_answered_by_historical_engines(self):
        previous_calls = self.runtime.ingest_calls
        response = self.client.post("/v3/intelligence/business", headers=self.headers, json=self.request_body())
        self.assertEqual(response.status_code, 501, response.text)
        self.assertEqual(response.json()["detail"]["code"], "LIVE_ANALYTICS_NOT_READY")
        self.assertEqual(self.runtime.ingest_calls, previous_calls + 1)
        self.assertEqual(len(self.runtime.live_contexts._contexts), 1)

    def test_live_missing_snapshot_hash_tenant_and_auth_errors(self):
        missing = self.client.post("/v3/intelligence/business", headers=self.headers,
                                   json=self.request_body(snapshot=False))
        self.assertEqual(missing.status_code, 422)
        self.assertEqual(missing.json()["detail"]["code"], "LIVE_SNAPSHOT_REQUIRED")
        no_auth = self.client.post("/v3/intelligence/business", json=self.request_body())
        self.assertEqual(no_auth.status_code, 401)
        bad_auth = self.client.post("/v3/intelligence/business", headers={"X-ML-Service-Secret": "wrong"},
                                    json=self.request_body())
        self.assertEqual(bad_auth.status_code, 403)
        wrong_tenant = self.request_body()
        wrong_tenant["context"]["businessId"] = "OTHER-TENANT"
        response = self.client.post("/v3/intelligence/business", headers=self.headers, json=wrong_tenant)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"]["code"], "TENANT_MISMATCH")

    def test_historical_mode_rejects_snapshot_and_v3_body_limit_is_early_413(self):
        historical_with_snapshot = self.request_body(mode="HISTORICAL")
        historical_with_snapshot["context"]["asOfDate"] = "2026-10-12"
        response = self.client.post("/v3/intelligence/business", headers=self.headers, json=historical_with_snapshot)
        self.assertEqual(response.status_code, 422)
        # Even payloads above the legacy 2 MiB global cap keep the V3 error contract.
        content = b" " * (2 * 1024 * 1024 + 1)
        response = self.client.post("/v3/intelligence/business", headers=self.headers, content=content)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["code"], "LIVE_SNAPSHOT_TOO_LARGE")


if __name__ == "__main__":
    unittest.main()
