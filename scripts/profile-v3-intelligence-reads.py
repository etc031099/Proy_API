"""Local READ-only timings using approved runtime + F.4E synthetic snapshot, never Mongo/Atlas.

TestClient includes schema/serialization overhead; this does not measure cloud network or Mongo snapshot construction.
Run from the repository root with ml/.venv/Scripts/python.exe scripts/profile-v3-intelligence-reads.py.
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import statistics
import sys
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from ml.service.app import create_app
from ml.service.v3_intelligence_runtime import V3IntelligenceRuntime
from ml.tests.test_m6_9f4e1_live_http import _live_body, _V1Runtime, SECRET


def main():
    logging.disable(logging.CRITICAL)
    started = time.perf_counter()
    runtime = V3IntelligenceRuntime()
    runtime.load()
    report = {"runtimeLoadMs": round((time.perf_counter() - started) * 1000, 3), "samples": {}}
    base = _live_body(runtime)
    period = {"startDate": "2026-10-08", "endDate": "2026-10-14"}
    queries = {
        "business": {"mode": "summary", "period": period},
        "forecast": {"mode": "detail", "skus": ["PAN-FRE-001"], "horizonDays": 7, "includeObservedSeries": True},
        "inventory": {"mode": "rank", "metric": "stockout_risk", "limit": 20},
        "sales": {"mode": "compare", "period": period},
        "customers": {"mode": "rank", "metric": "spend", "limit": 20},
        "suppliers": {"mode": "rank", "metric": "spend", "period": period, "limit": 20},
        "associations": {"mode": "rules", "limit": 10},
        "health": {"period": period, "limit": 5},
    }
    with patch.dict(os.environ, {"ML_SERVICE_SECRET": SECRET}), TestClient(create_app(_V1Runtime(), runtime)) as client:
        if "--serve" in sys.argv:
            # Test-only loopback relay. Revision is from the synthetic fixture, NOT Mongo.
            class ReadHandler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_GET(self):
                    name = self.path.strip("/")
                    if name == "revision":
                        result = {"businessId": base["context"]["businessId"], "scenarioId": base["context"]["scenarioId"],
                            "datasetVersion": base["context"]["datasetVersion"], "asOf": base["context"]["asOfDate"],
                            "dataVersion": base["operationalSnapshot"]["metadata"]["dataVersion"]}
                    elif name in queries:
                        route = {"sales": "business", "associations": "cross-sell"}.get(name, name)
                        body = {**base, **queries[name]}
                        if route == "cross-sell":
                            body = {**body, "context": {**body["context"], "asOfDate": "2026-10-12"}, "dataMode": "HISTORICAL"}
                            body.pop("operationalSnapshot", None)
                        response = client.post("/v3/intelligence/" + route, json=body, headers={"X-ML-Service-Secret": SECRET})
                        if response.status_code != 200:
                            self.send_error(response.status_code)
                            return
                        result = {"success": True, "data": response.json()["data"]}
                    else:
                        self.send_error(404)
                        return
                    encoded = json.dumps(result, ensure_ascii=False).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)

            with ThreadingHTTPServer(("127.0.0.1", 0), ReadHandler) as server:
                print(json.dumps({"port": server.server_port, "runtimeLoadMs": report["runtimeLoadMs"]}), flush=True)
                server.serve_forever()
            return
        for name, args in queries.items():
            route = {"sales": "business", "associations": "cross-sell"}.get(name, name)
            body = {**base, **args}
            if route == "cross-sell":
                body = {**body, "context": {**body["context"], "asOfDate": "2026-10-12"}, "dataMode": "HISTORICAL"}
                body.pop("operationalSnapshot", None)
            durations, engines, hashes = [], [], []
            for _ in range(4):
                started = time.perf_counter()
                response = client.post("/v3/intelligence/" + route, json=body, headers={"X-ML-Service-Secret": SECRET})
                durations.append(round((time.perf_counter() - started) * 1000, 3))
                if response.status_code != 200:
                    raise RuntimeError(f"{name}: HTTP {response.status_code}")
                result = response.json()
                engines.append(result["metadata"].get("durationMs"))
                hashes.append(hashlib.sha256(json.dumps(result["data"], sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest())
            report["samples"][name] = {"firstMs": durations[0], "warmMedianMs": statistics.median(durations[1:]),
                "warmMaxMs": max(durations[1:]), "engineMs": engines, "stableDataHash": len(set(hashes)) == 1, "hash": hashes[-1]}
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
