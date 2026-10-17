"""Sequential Health prerequisites preserve the previous concurrent assembly contract."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from threading import get_ident
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ml.service.v3_live_business_customer import LiveDomainError
from ml.service.v3_intelligence_runtime import V3FunctionalError
from ml.tests import test_m6_10a36113_health_completeness as fixtures
from ml.tests import test_m6_9f4e_live_forecast_health as real_fixtures


def previous_concurrent_dependencies(runtime, request, live, common):
    """Test-only reference for the pre-fix Health scheduling, never used in serving."""
    def business_customer():
        business, _ = runtime.live_adapter.business_data(SimpleNamespace(**{**common, "mode": "compare"}), live)
        customer, _ = runtime.live_adapter.customer_data(SimpleNamespace(**common), live)
        return business, customer

    def forecast_inventory():
        forecasts = runtime._live_inventory_ridge_forecasts(request, live)
        return forecasts, runtime.live_inventory_supplier._inventory_rows(live, forecasts)

    with ThreadPoolExecutor(max_workers=3) as pool:
        analytics = pool.submit(business_customer)
        inventory_work = pool.submit(forecast_inventory)
        supplier_work = pool.submit(runtime.live_inventory_supplier.supplier_data, SimpleNamespace(**common), live)
        business, customer = analytics.result()
        forecasts, inventory = inventory_work.result()
        supplier, _ = supplier_work.result()
    return business, customer, forecasts, inventory, supplier


class DiagnosticsConcurrencyTests(unittest.TestCase):
    def test_dependencies_are_sequential_in_canonical_order_before_assembly_on_same_context(self):
        fixture = fixtures.health_fixture()
        runtime, live = fixture.runtime, fixture.live
        completed, observed_contexts, threads = [], [], set()
        expected_order = ["business", "customer", "forecast", "inventory", "supplier", "assembly"]
        caller_thread = get_ident()
        calls = Counter()
        request = SimpleNamespace(period=None, limit=5, activeRidgeModels=[object(), object()])
        pinned_pair = request.activeRidgeModels

        def start(name, received_live):
            self.assertEqual(completed, expected_order[:expected_order.index(name)])
            self.assertEqual(get_ident(), caller_thread)
            calls[name] += 1
            observed_contexts.append(received_live)
            threads.add(get_ident())

        def business(_request, received_live):
            start("business", received_live)
            completed.append("business")
            return fixture.business, live.as_of_date

        def customer(_request, received_live):
            start("customer", received_live)
            completed.append("customer")
            return fixture.customer, live.as_of_date

        def forecasts(received_request, received_live):
            start("forecast", received_live)
            self.assertIs(received_request, request)
            self.assertIs(received_request.activeRidgeModels, pinned_pair)
            completed.append("forecast")
            return fixture.forecasts

        def inventory(received_live, received_forecasts):
            start("inventory", received_live)
            self.assertIs(received_forecasts, fixture.forecasts)
            completed.append("inventory")
            return fixture.inventory

        def supplier(_request, received_live):
            start("supplier", received_live)
            completed.append("supplier")
            return fixture.supplier, live.as_of_date

        def assembly(*_args):
            start("assembly", live)
            completed.append("assembly")
            return []

        runtime.live_adapter.business_data = business
        runtime.live_adapter.customer_data = customer
        runtime._live_inventory_ridge_forecasts = forecasts
        runtime.live_inventory_supplier._inventory_rows = inventory
        runtime.live_inventory_supplier.supplier_data = supplier
        runtime.health._insights = assembly
        result, _ = runtime.live_health_data(request, live)
        self.assertEqual(result["availabilityStatus"], "AVAILABLE")
        self.assertEqual(threads, {caller_thread})
        self.assertEqual(completed, expected_order)
        self.assertTrue(all(value is live for value in observed_contexts))
        self.assertEqual(calls, Counter({name: 1 for name in ("business", "customer", "forecast", "inventory", "supplier", "assembly")}))

    def test_sequential_and_previous_concurrent_assembly_are_identical_for_ready_and_partial_fixtures(self):
        for cause in (None, "forecast", "inventory", "supplier", "customer", "business", "xyz", "marketBasket"):
            with self.subTest(cause=cause):
                serial = fixtures.health_fixture()
                parallel = fixtures.health_fixture()
                for fixture in (serial, parallel):
                    if cause == "forecast":
                        fixture.forecasts[0]["horizon14Status"] = "MODEL_UNAVAILABLE"
                        fixture.forecasts[0]["expectedUnitsNext14d"] = None
                    elif cause == "inventory":
                        fixture.inventory["summary"]["riskUnavailableCount"] = 1
                        fixture.inventory["products"][0]["risk"]["level"] = None
                    elif cause == "xyz":
                        fixture.inventory["summary"]["xyzAvailable"] = False
                    elif cause == "marketBasket":
                        fixture.runtime.basket = None
                    elif cause:
                        getattr(fixture, cause)["availabilityStatus"] = "PARTIAL"
                with patch.object(serial.runtime, "_live_health_dependencies", side_effect=lambda *args:
                                  previous_concurrent_dependencies(serial.runtime, *args)):
                    expected = fixtures.assemble(serial)
                actual = fixtures.assemble(parallel)
                self.assertEqual(actual, expected)
                self.assertEqual(actual["healthCompletenessPolicyVersion"], "m6.10a36113-abc-informational-v1")
                self.assertIsNone(actual["healthScore"])

    def test_original_error_precedence_and_safe_failure_are_preserved(self):
        fixture = fixtures.health_fixture()

        def business_failure(*_args):
            raise LiveDomainError("DATA_NOT_AVAILABLE", 422, "Safe business failure")

        def inventory_failure(*_args):
            raise TypeError("private internal details")

        fixture.runtime.live_adapter.business_data = business_failure
        fixture.runtime._live_inventory_ridge_forecasts = inventory_failure
        with patch.object(fixture.runtime.health, "_insights") as assembly:
            with self.assertRaises(V3FunctionalError) as raised:
                fixtures.assemble(fixture)
        self.assertEqual(raised.exception.code, "DATA_NOT_AVAILABLE")
        self.assertEqual(raised.exception.message, "Safe business failure")
        assembly.assert_not_called()

    def test_sequential_failure_does_not_start_later_dependencies_or_assembly(self):
        fixture = fixtures.health_fixture()
        with patch.object(fixture.runtime.live_adapter, "business_data", side_effect=
                          LiveDomainError("DATA_NOT_AVAILABLE", 422, "Safe business failure")), \
                patch.object(fixture.runtime.live_adapter, "customer_data") as customer, \
                patch.object(fixture.runtime, "_live_inventory_ridge_forecasts") as forecasts, \
                patch.object(fixture.runtime.live_inventory_supplier, "_inventory_rows") as inventory, \
                patch.object(fixture.runtime.live_inventory_supplier, "supplier_data") as supplier, \
                patch.object(fixture.runtime.health, "_insights") as assembly:
            with self.assertRaises(V3FunctionalError):
                fixtures.assemble(fixture)
        for dependency in (customer, forecasts, inventory, supplier, assembly):
            dependency.assert_not_called()

    def test_actual_adapters_return_the_same_health_body_with_previous_concurrent_prerequisites(self):
        runtime, live = real_fixtures._real_runtime_fixture()
        request = SimpleNamespace(period=None, limit=5)
        with patch.object(runtime, "_live_health_dependencies", side_effect=lambda *args:
                          previous_concurrent_dependencies(runtime, *args)):
            expected, _ = runtime.live_health_data(request, live)
        actual, _ = runtime.live_health_data(request, live)
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
