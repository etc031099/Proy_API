from __future__ import annotations

import json
import unittest
from datetime import date
from pathlib import Path

from ml.service.v3_live_context import validate_snapshot
from ml.service.v3_schemas import (
    BUSINESS_ID, DATASET_SHA256, DATASET_VERSION, SCENARIO_ID, TIMEZONE,
    V3OperationalSnapshot,
)


FIXTURE = Path(__file__).parent / "fixtures" / "v3-immediate-purchase-snapshot.json"


class ImmediatePurchaseSnapshotHashTests(unittest.TestCase):
    def test_node_signed_immediate_purchase_snapshot_is_accepted(self):
        payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
        snapshot = V3OperationalSnapshot.model_validate(payload)
        purchase = snapshot.purchases[0]
        self.assertEqual(purchase.receiptEvidence, "IMMEDIATE_PURCHASE")
        self.assertIsNone(purchase.contractVersion)
        self.assertIsNone(purchase.fulfillmentMode)
        self.assertIsNone(purchase.initialStatus)

        validate_snapshot(
            snapshot,
            base_records={
                "products": [{"productKey": "base.P1", "sku": "P1"}],
                "customers": [],
                "suppliers": [{"supplierCode": "S1"}],
                "sales": [],
                "purchases": [],
            },
            request_business_id=BUSINESS_ID,
            request_scenario_id=SCENARIO_ID,
            request_dataset_version=DATASET_VERSION,
            request_dataset_sha256=DATASET_SHA256,
            request_timezone=TIMEZONE,
            request_as_of_date=date(2026, 10, 14),
            request_body_bytes=1,
        )


if __name__ == "__main__":
    unittest.main()
