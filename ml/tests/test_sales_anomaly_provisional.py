"""Read-only provisional inference; never execute the training test suite here."""
import hashlib
import json
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from ml.service.sales_anomalies import load_anomalies, provisional_daily_inference
from ml.service.v3_live_context import LiveV3ContextStore
from ml.src.sales_isolation_forest_v3 import ARTIFACT_DIR, FEATURES, aggregate_daily_sales, matrix, model_matrix
from ml.tests.test_m6_9f4c_live_business_customer import _adapter, _live_context
from ml.service.v3_live_business_customer import LiveDomainError
from ml.service.v3_schemas import BUSINESS_ID, SCENARIO_ID, BusinessRequest

ROOT = Path(__file__).resolve().parents[2]


class ProvisionalAnomalyTests(unittest.TestCase):
    def infer(self, cents=1000, tickets=3, units=5, **kw):
        return provisional_daily_inference(ROOT, local_date=kw.pop("local_date", "2026-10-20"),
            expected_date="2026-10-20", revenue_cents=cents, tickets=tickets, units=units, **kw)

    def test_365_day_feature_score_decision_parity_without_fit_or_artifact_changes(self):
        directory = ROOT / ARTIFACT_DIR
        files = [directory / name for name in ("model.joblib", "metadata.json", "training-daily.json", "daily-results.json")]
        before = [hashlib.sha256(path.read_bytes()).hexdigest() for path in files]
        rows = json.loads(files[2].read_text(encoding="utf-8"))
        daily = json.loads(files[3].read_text(encoding="utf-8"))
        bundle, _ = load_anomalies(ROOT)
        transformed = bundle["preprocessing"].transform(matrix(rows))
        with patch("ml.src.sales_isolation_forest_v3.IsolationForest.fit", side_effect=AssertionError("fit forbidden")), \
             patch("ml.src.sales_isolation_forest_v3.WeeklyLogResiduals.fit", side_effect=AssertionError("fit forbidden")), \
             patch("ml.src.sales_isolation_forest_v3.train", side_effect=AssertionError("train forbidden")):
            for index, row in enumerate(rows):
                result = provisional_daily_inference(ROOT, local_date=row["date"], expected_date=row["date"],
                    revenue_cents=round(row["revenue"] * 100), tickets=row["tickets"], units=row["units"])
                self.assertTrue(result["provisional"])
                np.testing.assert_allclose([result["modelInput"][name] for name in FEATURES], transformed[index], rtol=0, atol=1e-12)
                self.assertAlmostEqual(result["inference"]["anomalyScore"], daily[index]["anomalyScore"], places=12)
                self.assertAlmostEqual(result["inference"]["decisionFunction"], daily[index]["decisionFunction"], places=12)
                self.assertEqual(result["inference"]["prediction"], daily[index]["prediction"])
                self.assertEqual(result["modelIdentity"]["threshold"], -.5)
        self.assertEqual(before, [hashlib.sha256(path.read_bytes()).hexdigest() for path in files])

    def test_first_sale_invalid_values_date_and_currency_never_fabricate_score(self):
        for kwargs, reason in [({"tickets": 0}, "NO_TICKETS"), ({"cents": 0}, "INVALID_AVERAGE_TICKET"),
            ({"cents": float("nan")}, "INVALID_DAILY_AGGREGATE"), ({"cents": None}, "INVALID_DAILY_AGGREGATE"),
            ({"currency": "USD"}, "UNSUPPORTED_CURRENCY"), ({"local_date": "2026-10-21"}, "DATE_MISMATCH"),
            ({"local_date": "20261020"}, "INVALID_DATE")]:
            row = self.infer(**kwargs)
            self.assertEqual(row["status"], "NOT_EVALUABLE"); self.assertEqual(row["reason"], reason)
            self.assertIsNone(row["inference"]); self.assertIsNone(row["modelInput"])
        first = self.infer(cents=500, tickets=1, units=3)
        self.assertEqual(first["status"], "EVALUATED")
        self.assertEqual(first["aggregate"]["averageTicketPEN"], 5)
        self.assertEqual(self.infer()["aggregate"]["averageTicketPEN"], 10 / 3)
        with self.assertRaises(ValueError): model_matrix([[2, 1, None]])

    def test_daily_shared_reducer_multi_sku_and_quantity(self):
        sales = [{"saleCode": "A", "localDate": "2026-10-20", "totalCents": 1000},
                 {"saleCode": "B", "localDate": "2026-10-20", "totalCents": 300}]
        lines = {"A": [{"lineTotalCents": 600, "unitsSold": 3}, {"lineTotalCents": 400, "unitsSold": 2}],
                 "B": [{"lineTotalCents": 300, "unitsSold": 1}]}
        row = aggregate_daily_sales(sales, lines, "2026-10-20")
        self.assertEqual((row["tickets"], row["units"], row["revenueCents"]), (2, 6, 1300))
        before, after = self.infer(cents=1000, tickets=1, units=5), self.infer(cents=1300, tickets=2, units=6)
        self.assertEqual(before["modelInput"]["weekday"], after["modelInput"]["weekday"])
        self.assertEqual(before["modelIdentity"], after["modelIdentity"])
        self.assertEqual(after["inference"]["prediction"], -1 if after["inference"]["anomalyScore"] < -.5 else 1)

    def test_oct21_provisional_open_day_only_uses_that_days_completed_sales(self):
        # Read-only fixture reproduction, not a claim about production tickets.
        adapter = _adapter(); adapter.root = ROOT

        def context(sale_date):
            live = self.live(sale_date=sale_date)
            live.as_of_date = date(2026, 10, 21)
            live.snapshot.metadata.operationalDate = date(2026, 10, 21)
            live.snapshot.metadata.capturedAtUtc = datetime(2026, 10, 21, 15, tzinfo=timezone.utc)
            live.snapshot.metadata.observationsClosedThrough = date(2026, 10, 20)
            return live

        with patch("ml.src.sales_isolation_forest_v3.IsolationForest.fit", side_effect=AssertionError("fit forbidden")), \
             patch("ml.src.sales_isolation_forest_v3.WeeklyLogResiduals.fit", side_effect=AssertionError("fit forbidden")), \
             patch("ml.src.sales_isolation_forest_v3.train", side_effect=AssertionError("train forbidden")):
            empty, _ = adapter.provisional_anomaly(context(date(2026, 10, 20)))
            self.assertEqual(empty["localDate"], "2026-10-21")
            self.assertEqual(empty["status"], "NOT_EVALUABLE")
            self.assertEqual(empty["reason"], "NO_TICKETS")
            self.assertEqual(empty["aggregate"], {"revenuePEN": 0, "units": 0, "tickets": 0, "averageTicketPEN": None})
            self.assertIsNone(empty["modelInput"]); self.assertIsNone(empty["inference"])
            current, _ = adapter.provisional_anomaly(context(date(2026, 10, 21)))
            self.assertEqual(current["status"], "EVALUATED")
            self.assertIsNone(current["reason"])
            self.assertEqual(current["aggregate"]["tickets"], 1)
            self.assertEqual(current["aggregate"]["units"], 2)
            self.assertEqual(current["modelInput"]["weekday"], 3)
            self.assertTrue(all(np.isfinite(current["modelInput"][name]) for name in FEATURES))
            self.assertEqual(current["modelIdentity"], empty["modelIdentity"])

    def live(self, **kw):
        live = _live_context(business_id=BUSINESS_ID, **kw)
        live.snapshot.metadata.scenarioId = SCENARIO_ID
        live.snapshot.metadata.operationalDate = date(2026, 10, 14)
        live.snapshot.metadata.capturedAtUtc = datetime(2026, 10, 14, 15, tzinfo=timezone.utc)
        return live

    def test_operational_view_completed_cancelled_empty_and_tenant_isolation(self):
        adapter = _adapter(); adapter.root = ROOT
        before, _ = adapter.provisional_anomaly(self.live(sale=False))
        after_context = self.live(version="2")
        after, _ = adapter.provisional_anomaly(after_context)
        self.assertEqual(after["observedAt"], after_context.snapshot.metadata.capturedAtUtc.isoformat())
        cancelled, _ = adapter.provisional_anomaly(self.live(version="3", cancelled=("LIVE-1",)))
        self.assertEqual(before["reason"], "NO_TICKETS")
        self.assertEqual(after["aggregate"]["tickets"], 1); self.assertEqual(after["aggregate"]["units"], 2)
        self.assertEqual(after["status"], "EVALUATED"); self.assertEqual(cancelled["reason"], "NO_TICKETS")
        foreign = self.live(); foreign.snapshot.metadata.businessId = "OTHER"
        with self.assertRaises(LiveDomainError): adapter.provisional_anomaly(foreign)
        usd = self.live(version="4"); usd.snapshot.sales[0].currency = "USD"
        unsupported, _ = adapter.provisional_anomaly(usd)
        self.assertEqual(unsupported["reason"], "UNSUPPORTED_CURRENCY")
        self.assertIsNone(unsupported["inference"])

    def test_live_context_cache_identity_includes_snapshot_capture_instant(self):
        def snapshot(captured_at):
            return SimpleNamespace(metadata=SimpleNamespace(
                businessId=BUSINESS_ID, scenarioId=SCENARIO_ID,
                historicalDatasetVersion="dataset-v1", historicalDatasetSha256="a" * 64,
                snapshotVersion="v3-operational-snapshot-v2", dataVersion="184",
                snapshotHash="b" * 64, capturedAtUtc=captured_at,
                asOfDate=date(2026, 10, 20), observationsClosedThrough=date(2026, 10, 19),
                testEpoch=None,
            ))

        first = LiveV3ContextStore.cache_key(snapshot(datetime(2026, 10, 20, 15, tzinfo=timezone.utc)))
        second = LiveV3ContextStore.cache_key(snapshot(datetime(2026, 10, 20, 15, 0, 1, tzinfo=timezone.utc)))
        self.assertNotEqual(first, second)

    def test_provisional_request_cannot_open_historical_mode_or_select_dates(self):
        context = {"businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID, "asOfDate": "2026-10-20"}
        for extra in [{"dataMode": "HISTORICAL"}, {"dataMode": "LIVE", "period": {"startDate": "2026-10-19", "endDate": "2026-10-19"}},
                      {"dataMode": "LIVE", "productSku": "SKU-1"}]:
            with self.assertRaises(ValueError): BusinessRequest(requestId="fixture", context=context, mode="anomalies_provisional", **extra)

    def test_authenticated_python_http_uses_real_snapshot_and_keeps_frozen_guard(self):
        import os
        from fastapi.testclient import TestClient
        from ml.service.app import create_app
        from ml.tests.test_m6_9f4c_live_http import _runtime, _base_body, _V1Runtime
        runtime = _runtime(); runtime.live_adapter.root = ROOT
        secret = "test-only-provisional-service-secret-123456"
        with patch.dict(os.environ, {"ML_SERVICE_SECRET": secret}), TestClient(create_app(_V1Runtime(), runtime)) as client, \
             patch("ml.src.sales_isolation_forest_v3.IsolationForest.fit", side_effect=AssertionError("fit forbidden")):
            body = _base_body(); body["mode"] = "anomalies_provisional"
            route = "/v3/intelligence/business"; headers = {"X-ML-Service-Secret": secret}
            self.assertEqual(client.post(route, json=body).status_code, 401)
            response = client.post(route, headers=headers, json=body)
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()["data"]
            self.assertEqual(data["aggregate"]["tickets"], 1)
            self.assertEqual(data["revision"], "1"); self.assertTrue(data["provisional"])
            body["context"]["businessId"] = "OTHER"
            self.assertEqual(client.post(route, headers=headers, json=body).status_code, 403)
            body = _base_body(); body["mode"] = "anomalies"
            self.assertEqual(client.post(route, headers=headers, json=body).status_code, 422)


if __name__ == "__main__": unittest.main()
