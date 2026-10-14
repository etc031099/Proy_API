from __future__ import annotations

import unittest

from ml.service.v3_schemas import V3OperationalSnapshot
from ml.tests.test_m6_9f3_live_context import empty_snapshot


class M69F5ASnapshotContractTests(unittest.TestCase):
    def test_v2_receive_and_deferred_purchase_fields_are_schema_supported(self):
        payload = empty_snapshot()
        payload["metadata"]["snapshotVersion"] = "v3-operational-snapshot-v2"
        payload["metadata"]["contractVersion"] = "2"
        payload["metadata"]["counts"]["transactionChanges"] = 1
        purchase = payload["purchases"][1]
        purchase.update({"contractVersion": 2, "fulfillmentMode": "DEFERRED", "initialStatus": "completed",
                         "receiptEvidence": "NONE", "promisedAtUtc": "2026-10-15T15:00:00.000Z"})
        payload["transactionChanges"] = [{
            "eventKey": "2:0:transaction:LIVE-PO-RECEIVED:RECEIVE",
            "effectiveAtUtc": "2026-10-14T18:00:00.000Z", "revision": "2",
            "entityType": "transaction", "entityKey": "LIVE-PO-RECEIVED",
            "transactionKey": "LIVE-PO-RECEIVED", "transactionOrigin": "LIVE", "kind": "RECEIVE",
            "receiptKey": "receipt-1", "supplierKey": "OP-S-new",
            "lineChanges": [{"lineKey": "LIVE-PO-RECEIVED:0", "receivedQty": 3,
                              "productKey": "OP-P-new", "sku": "P2", "orderedQty": 3,
                              "purchaseUnitCostCents": 150, "costBasis": "OBSERVED_RECEIPT_COST", "currency": "PEN"}],
        }]
        snapshot = V3OperationalSnapshot.model_validate(payload)
        self.assertEqual(snapshot.metadata.contractVersion, "2")
        self.assertEqual(snapshot.transactionChanges[0].lineChanges[0].orderedQty, 3)
        self.assertEqual(snapshot.purchases[1].fulfillmentMode, "DEFERRED")

    def test_v1_contract_remains_accepted(self):
        snapshot = V3OperationalSnapshot.model_validate(empty_snapshot())
        self.assertEqual(snapshot.metadata.contractVersion, "1")


if __name__ == "__main__":
    unittest.main()
