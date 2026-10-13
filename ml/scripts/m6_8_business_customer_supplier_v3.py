"""Run the deterministic, read-only M6.8 V3 intelligence pipeline."""
from __future__ import annotations

import argparse
import json
import sys
from time import perf_counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.src.business_customer_supplier_v3 import (  # noqa: E402
    MinimarketPascoV3Intelligence,
    _as_date,
    run_local_atlas_parity,
    v3_forecast,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--as-of-date", default=v3_forecast.HISTORY_END.isoformat())
    parser.add_argument("--period", default="LAST_30_DAYS",
                        choices=("TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS",
                                 "CURRENT_MONTH", "PREVIOUS_MONTH", "YEAR_TO_DATE", "HISTORY"))
    parser.add_argument("--atlas-parity", action="store_true", help="read the exact V3 Atlas scope and compare hashes")
    args = parser.parse_args()

    try:
        started = perf_counter()
        cutoff = _as_date(args.as_of_date)
        engine = MinimarketPascoV3Intelligence(ROOT)
        snapshot = engine.snapshot(as_of_date=cutoff, period=args.period)
        parity = run_local_atlas_parity(ROOT, as_of_date=cutoff, period=args.period, local_engine=engine) if args.atlas_parity else None
        if parity and any(value != "PASS" for value in parity["parity"].values()):
            raise RuntimeError("M6.8 local/Atlas parity failed; artifact not written")
        result = {
            "status": "PASS", "scenarioId": snapshot["scenarioId"], "asOfDate": snapshot["asOfDate"],
            "period": snapshot["business"]["period"], "logicalHashes": snapshot["logicalHashes"],
            "business": snapshot["business"]["kpis"],
            "customerSegments": snapshot["customers"]["segmentDistribution"],
            "customerCount": snapshot["customers"]["registeredCustomerCount"],
            "supplierSummary": snapshot["suppliers"]["summary"],
            "healthAlerts": snapshot["businessHealth"]["alerts"],
            "sanityAudits": snapshot["sanityAudits"],
            "atlasParity": parity, "atlasWrites": 0,
            "runtimeMs": round((perf_counter() - started) * 1000, 2),
        }
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
        return 0
    except Exception:
        print("M6.8_FAILED (details sanitized)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
