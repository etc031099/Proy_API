"""Regression coverage for the uniform (data, cutoff) serving contract."""
from __future__ import annotations

import unittest
from datetime import date
from unittest.mock import patch

from fastapi.testclient import TestClient

from ml.service.app import create_app
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service.v3_schemas import BUSINESS_ID, DATASET_SHA256, DATASET_VERSION, SCENARIO_ID, TIMEZONE
from ml.tests.test_m6_9f3_live_context import signed_snapshot


SECRET = "test-only-m610a35-serving-contract-secret-000000000"
LIVE_CUTOFF = date(2026, 10, 14)
HISTORICAL_CUTOFF = date(2026, 10, 12)


class _V1Runtime:
    available = True

    def load(self):
        return None

    def public_health(self):
        return {"status": "ok"}


class _V3Runtime(V3IntelligenceRuntime):
    def __init__(self):
        self.ready = True
        self.domains = {"forecast": True}
        self.live_forecast = object()
        self.latencies = {}
        self._first_request = False

    def load(self):
        return None

    def public_status(self):
        return {"v3IntelligenceReady": True, "domains": {"forecast": True},
                "liveDomains": {"forecast": True}, "domainErrors": {}, "loadingMetrics": {}}

    def ingest_request_context(self, request, *, request_body_bytes):
        if request.dataMode == "LIVE":
            return LIVE_CUTOFF, type("Live", (), {"as_of_date": LIVE_CUTOFF,
                "data_version": "1", "context_hash": "a" * 64})()
        return HISTORICAL_CUTOFF, None

    def _live_ridge_forecast_data(self, request, live):
        return {"mode": "detail", "horizonDays": request.horizonDays, "total": 1,
                "items": [{"sku": request.skus[0], "status": "MODEL_NOT_APPROVED",
                           "reasonCode": "PROMOTION_POLICY_FAILED", "predictionUnits": None,
                           "modelVersion": None, "forecastStartDate": "2026-10-14",
                           "forecastEndDate": "2026-10-14", "observationsThrough": "2026-10-13"}]}

    def forecast_data(self, request):
        return {"mode": "detail", "horizonDays": request.horizonDays, "total": 1,
                "items": [{"sku": request.skus[0], "status": "READY",
                           "expectedUnitsNext7d": 12.5, "observedSeries": []}]}, HISTORICAL_CUTOFF

    def live_metadata(self, cutoff, domain, duration_ms, live):
        return {"scenarioId": SCENARIO_ID, "asOfDate": cutoff, "timezone": TIMEZONE,
                "datasetVersion": DATASET_VERSION, "datasetSha256": DATASET_SHA256,
                "contractVersion": "m6.9f4-live-intelligence-v1",
                "source": "HISTORICAL_PLUS_OPERATIONAL_SNAPSHOT", "engineVersion": "test",
                "versions": {}, "durationMs": duration_ms, "latencyP50Ms": None,
                "dataVersion": live.data_version, "snapshotHash": live.context_hash, "freshness": {}}

    def metadata(self, cutoff, domain, duration_ms):
        return {"scenarioId": SCENARIO_ID, "asOfDate": cutoff, "timezone": TIMEZONE,
                "datasetVersion": DATASET_VERSION, "datasetSha256": DATASET_SHA256,
                "contractVersion": "m6.9b-v3-intelligence-v1", "source": "CANONICAL_V3_BUNDLE",
                "engineVersion": "test", "versions": {}, "durationMs": duration_ms,
                "latencyP50Ms": None}


class ForecastServingReturnContractTests(unittest.TestCase):
    def test_live_ridge_and_historical_forecast_preserve_data_cutoff_tuple_contract(self):
        with patch.dict("os.environ", {"ML_SERVICE_SECRET": SECRET}, clear=False):
            app = create_app(_V1Runtime(), _V3Runtime())
            with TestClient(app) as client:
                context = {"businessId": BUSINESS_ID, "scenarioId": SCENARIO_ID,
                           "datasetVersion": DATASET_VERSION, "datasetSha256": DATASET_SHA256,
                           "timezone": TIMEZONE, "asOfDate": LIVE_CUTOFF.isoformat()}
                live_body = {"requestId": "a35-return-contract-live", "context": context,
                             "dataMode": "LIVE", "operationalSnapshot": signed_snapshot().model_dump(mode="json"),
                             "mode": "detail", "skus": ["PAN-FRE-001"], "horizonDays": 1,
                             "useLiveRidge": True, "activeRidgeModel": None}
                live = client.post("/v3/intelligence/forecast",
                                   headers={"X-ML-Service-Secret": SECRET}, json=live_body)
                self.assertEqual(live.status_code, 200, live.text)
                live_result = live.json()
                live_row = live_result["data"]["items"][0]
                self.assertEqual(live_result["metadata"]["asOfDate"], LIVE_CUTOFF.isoformat())
                self.assertEqual(live_row["status"], "MODEL_NOT_APPROVED")
                self.assertEqual(live_row["reasonCode"], "PROMOTION_POLICY_FAILED")
                self.assertIsNone(live_row["predictionUnits"])
                self.assertIsNone(live_row["modelVersion"])

                historical_body = {"requestId": "a35-return-contract-historical",
                                   "context": {**context, "asOfDate": HISTORICAL_CUTOFF.isoformat()},
                                   "dataMode": "HISTORICAL", "mode": "detail",
                                   "skus": ["PAN-FRE-001"], "horizonDays": 7}
                historical = client.post("/v3/intelligence/forecast",
                                         headers={"X-ML-Service-Secret": SECRET}, json=historical_body)
                self.assertEqual(historical.status_code, 200, historical.text)
                historical_result = historical.json()
                self.assertEqual(historical_result["metadata"]["asOfDate"], HISTORICAL_CUTOFF.isoformat())
                self.assertEqual(historical_result["metadata"]["source"], "CANONICAL_V3_BUNDLE")
                self.assertEqual(historical_result["data"]["items"][0]["expectedUnitsNext7d"], 12.5)


if __name__ == "__main__":
    unittest.main()
