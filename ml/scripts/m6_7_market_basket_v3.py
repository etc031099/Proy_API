"""Run reproducible M6.7 Market Basket Analysis on the canonical local V3 bundle."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ml.src.market_basket_v3 import load_and_analyze

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "ml/data/minimarket-pasco-v3-market-basket-v1.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="small reproducible summary artifact path")
    parser.add_argument("--single-run", action="store_true", help="skip the reproducibility rerun")
    args = parser.parse_args()
    try:
        first = load_and_analyze(ROOT)
        if not args.single_run:
            second = load_and_analyze(ROOT)
            if first["reproducibilitySha256"] != second["reproducibilitySha256"]:
                raise RuntimeError("Repeated analysis hash did not match")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(first, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        print(json.dumps({
            "status": "PASS", "artifact": str(args.output.relative_to(ROOT)) if args.output.is_relative_to(ROOT) else "external-path",
            "reproducibilitySha256": first["reproducibilitySha256"], "tickets": first["transactionCount"],
            "frequentItemsets": first["summary"]["frequentItemsets"],
            "rules": first["summary"]["rulesBeforeQualityFilter"],
            "filteredRules": first["summary"]["rulesAfterQualityFilter"],
            "runtimeMs": first["timingsMs"],
        }, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        # Print only a bounded, sanitized error category; never dump source data.
        safe = str(error) if str(error) in {
            "Canonical V3 source manifest mismatch", "Completed ticket has no sale items",
            "Sale ticket identifiers must be present and unique", "Sale item has no corresponding ticket",
            "Sale item references an unknown V3 SKU", "Repeated analysis hash did not match",
        } else "M6_7_ANALYSIS_FAILED"
        print(json.dumps({"status": "FAILED", "error": safe}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
