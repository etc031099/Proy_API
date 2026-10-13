from __future__ import annotations

import concurrent.futures
import hashlib
import json
import threading
import time
import unittest
from datetime import date
from unittest.mock import patch

from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service import v3_intelligence_runtime as runtime_module
from ml.service.v3_schemas import (
    BUSINESS_ID, DATASET_SHA256, DATASET_VERSION, REFERENCE_DATE, SCENARIO_ID, TIMEZONE,
    BusinessRequest, CrossSellRequest, CustomerRequest, ForecastRequest, HealthRequest,
    InventoryRequest, PeriodRange, SupplierRequest, V3Context,
)
from ml.src import business_customer_supplier_v3 as m68
from ml.src import v3_baseline_bundle
from ml.src.v3_forecast import HISTORY_END


class M69B1ServingPerformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = V3IntelligenceRuntime()
        cls.runtime.load()

    def test_batch_forecast_matches_individual_approved_forecasts(self):
        dataset = self.runtime.dataset
        skus = sorted(dataset.product_by_sku)[:5]
        batch = v3_baseline_bundle.predict_many(dataset, skus=skus, cutoff=HISTORY_END)
        individual = [v3_baseline_bundle.predict(dataset, sku=sku, cutoff=HISTORY_END) for sku in skus]
        self.assertEqual(batch, individual)

    def test_forecast_manifest_lineage_is_verified(self):
        path = self.runtime.root / "ml/models/minimarket-pasco-v3/baseline-manifest.json"
        manifest = v3_baseline_bundle.load_manifest(path)
        self.assertEqual(manifest["scenarioId"], SCENARIO_ID)
        self.assertEqual(manifest["datasetSha256"], DATASET_SHA256)
        with patch.object(v3_baseline_bundle.v, "DATASET_SHA256", "wrong-lineage"):
            with self.assertRaisesRegex(ValueError, "lineage/version mismatch"):
                v3_baseline_bundle.load_manifest(path)

    def test_windows_node_json_output_uses_canonical_utf8_product_names(self):
        self.assertEqual(self.runtime.business.products["PAN-FRE-001"]["name"],
                         "Pan Francés fresco paquete 4 unidades")

    def test_derived_cache_separates_cutoff_period_and_engine_version(self):
        runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
        runtime._derived_cache = __import__("collections").OrderedDict()
        runtime._cache_lock = threading.RLock()
        runtime._cache_limits = {"inventory": 3, "customer": 4, "supplier": 4}
        calls = []

        def compute(value):
            def run():
                calls.append(value)
                return {"value": value}
            return run

        day = date(2026, 10, 12)
        a = runtime._cached("customer", day, {"period": "90d"}, compute("a"))
        self.assertIs(a, runtime._cached("customer", day, {"period": "90d"}, compute("duplicate")))
        runtime._cached("customer", date(2026, 10, 11), {"period": "90d"}, compute("other-date"))
        runtime._cached("customer", day, {"period": "30d"}, compute("other-period"))
        with patch.object(m68, "CUSTOMER_VERSION", "test-version-bump"):
            runtime._cached("customer", day, {"period": "90d"}, compute("other-version"))
        with patch.object(runtime_module, "SCENARIO_ID", "other-scenario"):
            runtime._cached("customer", day, {"period": "90d"}, compute("other-scenario"))
        with patch.object(runtime_module, "DATASET_VERSION", "other-dataset-version"):
            runtime._cached("customer", day, {"period": "90d"}, compute("other-dataset"))
        self.assertEqual(calls, ["a", "other-date", "other-period", "other-version", "other-scenario", "other-dataset"])

    def test_derived_cache_computes_same_key_once_under_concurrency(self):
        runtime = V3IntelligenceRuntime.__new__(V3IntelligenceRuntime)
        runtime._derived_cache = __import__("collections").OrderedDict()
        runtime._cache_lock = threading.RLock()
        runtime._cache_limits = {"inventory": 3, "customer": 4, "supplier": 4}
        calls = []

        def calculate():
            calls.append(1)
            time.sleep(0.02)
            return {"ready": True}

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: runtime._cached("inventory", date(2026, 10, 12), {}, calculate), range(6)))
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(result["ready"] for result in results))
        self.assertTrue(all(result is results[0] for result in results))

    def test_inventory_snapshot_is_reused_at_same_cutoff(self):
        first = self.runtime._inventory_snapshot(date(2026, 10, 12))
        second = self.runtime._inventory_snapshot(date(2026, 10, 12))
        self.assertIs(first, second)
        self.assertEqual(first["summary"]["products"], 80)

    def test_supplier_product_filter_does_not_mutate_cached_supplier_snapshot(self):
        cutoff = REFERENCE_DATE
        inventory = self.runtime._inventory_snapshot(cutoff)
        cached = self.runtime._supplier_snapshot(cutoff, "LAST_30_DAYS", inventory)
        original_counts = {row["supplierCode"]: len(row["productsSupplied"]) for row in cached["suppliers"]}
        context = V3Context(businessId=BUSINESS_ID, scenarioId=SCENARIO_ID, datasetVersion=DATASET_VERSION,
                             datasetSha256=DATASET_SHA256, timezone=TIMEZONE)
        request = SupplierRequest(requestId="supplier-filter-cache", context=context, mode="detail",
                                  productSkus=["PAN-FRE-001"])
        self.runtime.supplier_data(request)
        self.assertIs(cached, self.runtime._supplier_snapshot(cutoff, "LAST_30_DAYS", inventory))
        self.assertEqual(original_counts, {row["supplierCode"]: len(row["productsSupplied"]) for row in cached["suppliers"]})

    def test_seven_domain_outputs_match_approved_before_optimization_hash(self):
        context = V3Context(businessId=BUSINESS_ID, scenarioId=SCENARIO_ID, datasetVersion=DATASET_VERSION,
                            datasetSha256=DATASET_SHA256, timezone=TIMEZONE)
        requests = [
            ("business", "business_data", BusinessRequest(requestId="b", context=context,
                period=PeriodRange(startDate=date(2026, 10, 6), endDate=REFERENCE_DATE))),
            ("inventory", "inventory_data", InventoryRequest(requestId="i", context=context, mode="detail", skus=["PAN-FRE-001"])),
            ("forecast", "forecast_data", ForecastRequest(requestId="f", context=context, mode="detail", skus=["BEB-GAS-003"], horizonDays=7)),
            ("crossSell", "cross_sell_data", CrossSellRequest(requestId="x", context=context, sku="PAN-FRE-001")),
            ("customer", "customer_data", CustomerRequest(requestId="c", context=context, mode="detail", customerCode="CLI-001")),
            ("supplier", "supplier_data", SupplierRequest(requestId="s", context=context, mode="detail", supplierCode="SUP-05")),
            ("health", "health_data", HealthRequest(requestId="h", context=context)),
        ]
        outputs = {domain: getattr(self.runtime, method)(request)[0] for domain, method, request in requests}

        def normalize(value):
            if isinstance(value, float):
                return round(value, 10)
            if isinstance(value, dict):
                return {key: normalize(item) for key, item in sorted(value.items())}
            if isinstance(value, list):
                return [normalize(item) for item in value]
            return value

        canonical = json.dumps(normalize(outputs), ensure_ascii=False, sort_keys=True,
                               separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.assertEqual(hashlib.sha256(canonical).hexdigest(),
                         "5a4f77ca41e469b005f3a6b7404c205ab6796b5688e0e2007018c4f67b3d78e9")


if __name__ == "__main__":
    unittest.main()
