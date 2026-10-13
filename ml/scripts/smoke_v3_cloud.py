"""Seven-domain parity/resource smoke; cloud mode sends only approved read requests."""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import statistics
import threading
import time
from pathlib import Path

import httpx
import psutil

from ml.service.model_runtime import ModelRuntime
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.service import v3_schemas as s

CLOUD_URL = "https://inventory-billing-ml.onrender.com"


def canonical(value):
    if isinstance(value, float):
        return round(value, 10)
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def digest(value):
    return hashlib.sha256(json.dumps(canonical(value), ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), default=str, allow_nan=False).encode()).hexdigest()


def smoke(*, cloud=False):
    secret = os.environ.get("ML_SERVICE_SECRET") if cloud else None
    if cloud and (not secret or len(secret) < 32):
        raise RuntimeError("Cloud smoke requires existing internal auth via environment")
    process = psutil.Process()
    samples, family_samples, stop = [], [], threading.Event()

    def sample():
        while not stop.wait(0.01):
            rss = process.memory_info().rss
            samples.append(rss / 1048576)
            family_rss = rss
            for child in process.children(recursive=True):
                try:
                    family_rss += child.memory_info().rss
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            family_samples.append(family_rss / 1048576)

    sampling = threading.Thread(target=sample, daemon=True)
    sampling.start()
    report = {"mode": "cloud" if cloud else "local", "resourceMb": {}, "domains": {}}
    try:
        report["resourceMb"]["startup"] = process.memory_info().rss / 1048576
        old = ModelRuntime()
        old.load()
        report["v1Ready"] = old.available
        report["resourceMb"]["afterV1"] = process.memory_info().rss / 1048576
        runtime = V3IntelligenceRuntime()
        started = time.perf_counter()
        runtime.load()
        report["loadMs"] = round((time.perf_counter() - started) * 1000, 3)
        report["resourceMb"]["afterV3"] = process.memory_info().rss / 1048576
        context = s.V3Context(businessId=s.BUSINESS_ID, scenarioId=s.SCENARIO_ID,
                              datasetVersion=s.DATASET_VERSION, datasetSha256=s.DATASET_SHA256,
                              timezone=s.TIMEZONE)
        customers = runtime.records["customers"]
        victor = next(row["customerCode"] for row in customers if row.get("displayName", row.get("name")) == "Víctor Poma Salas")
        cases = [
            ("business", "business_data", s.BusinessRequest(requestId="m69e-business", context=context,
                period=s.PeriodRange(startDate="2026-10-06", endDate="2026-10-12"))),
            ("inventory", "inventory_data", s.InventoryRequest(requestId="m69e-inventory", context=context, mode="detail", skus=["PAN-FRE-001"])),
            ("forecast", "forecast_data", s.ForecastRequest(requestId="m69e-forecast", context=context, mode="detail", skus=["BEB-GAS-004"], horizonDays=7)),
            ("cross-sell", "cross_sell_data", s.CrossSellRequest(requestId="m69e-basket", context=context, sku="PAN-FRE-001")),
            ("customers", "customer_data", s.CustomerRequest(requestId="m69e-customer", context=context, mode="detail", customerCode=victor)),
            ("suppliers", "supplier_data", s.SupplierRequest(requestId="m69e-supplier", context=context, mode="detail", supplierCode="SUP-05")),
            ("health", "health_data", s.HealthRequest(requestId="m69e-health", context=context)),
        ]
        outputs = {}
        with httpx.Client(timeout=60) as client:
            for domain, method, request in cases:
                times, actual = [], None
                direct_started = time.perf_counter()
                expected, _ = getattr(runtime, method)(request)
                direct_first_ms = round((time.perf_counter() - direct_started) * 1000, 3)
                for _ in range(3):
                    started = time.perf_counter()
                    if cloud:
                        response = client.post(f"{CLOUD_URL}/v3/intelligence/{domain}",
                                               headers={"X-ML-Service-Secret": secret},
                                               json=request.model_dump(mode="json"))
                        if response.status_code != 200:
                            raise RuntimeError(f"Cloud smoke {domain} HTTP {response.status_code}")
                        actual = response.json()["data"]
                    else:
                        actual, _ = getattr(runtime, method)(request)
                    times.append(round((time.perf_counter() - started) * 1000, 3))
                    if digest(actual) != digest(expected):
                        raise RuntimeError(f"Cloud/direct parity mismatch: {domain}")
                outputs[domain] = actual
                report["domains"][domain] = {"parity": "MATCH", "hash": digest(actual),
                                             "localInitialMs": direct_first_ms, "firstMs": times[0],
                                             "warmMedianMs": statistics.median(times[1:]), "samplesMs": times}
        report["outputHash"] = digest(outputs)
        gc.collect()
        report["resourceMb"]["steady"] = process.memory_info().rss / 1048576
    finally:
        stop.set()
        sampling.join()
        report["resourceMb"]["sampledPeak"] = max(samples, default=0)
        report["resourceMb"]["sampledProcessFamilyPeak"] = max(family_samples, default=0)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cloud", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = smoke(cloud=args.cloud)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
