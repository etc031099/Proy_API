"""Focused validation for the LIVE Ridge API envelope."""
from __future__ import annotations

import unittest

from pydantic import ValidationError

from ml.service.v3_schemas import ForecastRequest


def _request(**overrides):
    body = {
        "requestId": "forecast-live-test",
        "context": {"businessId": "MINIMARKET-PASCO-V3", "scenarioId": "minimarket-pasco-v3",
                    "timezone": "America/Lima", "asOfDate": "2026-10-16"},
        "dataMode": "LIVE", "mode": "detail", "skus": ["PAN-FRE-001"],
        "horizonDays": 7, "useLiveRidge": True, "activeRidgeModel": None,
    }
    body.update(overrides)
    return body


class LiveRidgeForecastRequestTests(unittest.TestCase):
    def test_live_ridge_accepts_one_sku_and_missing_active_artifact_as_fail_closed_input(self):
        request = ForecastRequest.model_validate(_request())
        self.assertTrue(request.useLiveRidge)
        self.assertIsNone(request.activeRidgeModel)

    def test_one_day_is_allowed_for_explicit_not_approved_response_without_artifact(self):
        request = ForecastRequest.model_validate(_request(horizonDays=1))
        self.assertEqual(request.horizonDays, 1)
        self.assertIsNone(request.activeRidgeModel)

    def test_live_ridge_rejects_historical_mode_or_multiple_skus(self):
        with self.assertRaises(ValidationError):
            ForecastRequest.model_validate(_request(dataMode="HISTORICAL"))
        with self.assertRaises(ValidationError):
            ForecastRequest.model_validate(_request(skus=["PAN-FRE-001", "ABA-PAS-001"]))

    def test_active_artifact_cannot_be_attached_to_untrusted_or_one_day_request(self):
        with self.assertRaises(ValidationError):
            ForecastRequest.model_validate(_request(useLiveRidge=False, activeRidgeModel={}))
        with self.assertRaises(ValidationError):
            ForecastRequest.model_validate(_request(horizonDays=1, activeRidgeModel={}))


if __name__ == "__main__":
    unittest.main()
