"""Bounded Health prerequisite concurrency preserves the existing assembly contract."""
from collections import Counter
from threading import Barrier, Event, Lock, current_thread
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ml.service.v3_live_business_customer import LiveDomainError
from ml.service.v3_intelligence_runtime import V3FunctionalError
from ml.tests import test_m6_10a36113_health_completeness as fixtures
from ml.tests import test_m6_9f4e_live_forecast_health as real_fixtures


def serial_dependencies(runtime, request, live, common):
    business, _ = runtime.live_adapter.business_data(SimpleNamespace(**{**common, "mode": "compare"}), live)
    customer, _ = runtime.live_adapter.customer_data(SimpleNamespace(**common), live)
    forecasts = runtime._live_inventory_ridge_forecasts(request, live)
    inventory = runtime.live_inventory_supplier._inventory_rows(live, forecasts)
    supplier, _ = runtime.live_inventory_supplier.supplier_data(SimpleNamespace(**common), live)
    return business, customer, forecasts, inventory, supplier


class DiagnosticsConcurrencyTests(unittest.TestCase):
    def test_three_branches_overlap_and_assembly_waits_for_all_on_the_same_context(self):
        fixture = fixtures.health_fixture()
        runtime, live = fixture.runtime, fixture.live
        barrier, lock = Barrier(3), Lock()
        business_done, forecast_done = Event(), Event()
        completed, observed_contexts, threads = Counter(), [], set()
        calls = Counter()
        request = SimpleNamespace(period=None, limit=5, activeRidgeModels=[object(), object()])
        pinned_pair = request.activeRidgeModels

        def start(name, received_live):
            with lock:
                calls[name] += 1
                observed_contexts.append(received_live)
                threads.add(current_thread().name)
            barrier.wait(timeout=5)

        def business(_request, received_live):
            start("business", received_live)
            business_done.set()
            completed["business"] += 1
            return fixture.business, live.as_of_date

        def customer(_request, received_live):
            self.assertTrue(business_done.is_set())
            self.assertIs(received_live, live)
            calls["customer"] += 1
            completed["customer"] += 1
            return fixture.customer, live.as_of_date

        def forecasts(received_request, received_live):
            start("forecast", received_live)
            self.assertIs(received_request, request)
            self.assertIs(received_request.activeRidgeModels, pinned_pair)
            forecast_done.set()
            completed["forecast"] += 1
            return fixture.forecasts

        def inventory(received_live, received_forecasts):
            self.assertTrue(forecast_done.is_set())
            self.assertIs(received_live, live)
            self.assertIs(received_forecasts, fixture.forecasts)
            calls["inventory"] += 1
            completed["inventory"] += 1
            return fixture.inventory

        def supplier(_request, received_live):
            start("supplier", received_live)
            completed["supplier"] += 1
            return fixture.supplier, live.as_of_date

        def assembly(*_args):
            self.assertEqual(completed, Counter({name: 1 for name in ("business", "customer", "forecast", "inventory", "supplier")}))
            calls["assembly"] += 1
            return []

        runtime.live_adapter.business_data = business
        runtime.live_adapter.customer_data = customer
        runtime._live_inventory_ridge_forecasts = forecasts
        runtime.live_inventory_supplier._inventory_rows = inventory
        runtime.live_inventory_supplier.supplier_data = supplier
        runtime.health._insights = assembly
        result, _ = runtime.live_health_data(request, live)
        self.assertEqual(result["availabilityStatus"], "AVAILABLE")
        self.assertEqual(len(threads), 3)
        self.assertTrue(all(value is live for value in observed_contexts))
        self.assertEqual(calls, Counter({name: 1 for name in ("business", "customer", "forecast", "inventory", "supplier", "assembly")}))

    def test_parallel_and_previous_serial_assembly_are_identical_for_ready_and_partial_fixtures(self):
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
                                  serial_dependencies(serial.runtime, *args)):
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

    def test_actual_adapters_return_the_same_health_body_with_serial_and_parallel_prerequisites(self):
        runtime, live = real_fixtures._real_runtime_fixture()
        request = SimpleNamespace(period=None, limit=5)
        with patch.object(runtime, "_live_health_dependencies", side_effect=lambda *args:
                          serial_dependencies(runtime, *args)):
            expected, _ = runtime.live_health_data(request, live)
        actual, _ = runtime.live_health_data(request, live)
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
