"""Read-only, same-cutoff M6.6 operational parity check for local Mongo and Atlas."""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any

from ml.src import v3_forecast
from ml.src.inventory_intelligence_v3 import InventoryIntelligenceV3

ROOT = Path(__file__).resolve().parents[2]
READER = ROOT / "ml/scripts/m6_6a_read_mongo.js"
CUTOFF = date(2026, 10, 12)
FLOAT_TOLERANCE = 1e-8
FLOAT_DIGITS = 8
ENVIRONMENT_KEYS = {"environment", "executionEnvironment", "sourceEnvironment", "sourceHost", "runtimeMs"}
REPRESENTATIVE_SKUS = [
    "BEB-GAS-003", "BEB-GAS-004", "ABA-ARR-001", "DES-LEC-001", "LIM-DET-001",
    "CON-ATU-002", "PAN-FRE-001", "BEB-GAS-001", "REG-MAC-001", "SNA-CHO-002",
]
RANKINGS = ("stockout_risk", "low_stock", "overstock", "slow_moving", "abc_a", "az", "single_source_critical", "reorder")


def normalize_for_hash(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: normalize_for_hash(child) for key, child in sorted(value.items()) if key not in ENVIRONMENT_KEYS}
    if isinstance(value, list):
        return [normalize_for_hash(child) for child in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Intelligence snapshot contains a non-finite float")
        return round(value, FLOAT_DIGITS)
    return value


def intelligence_sha256(snapshot: dict[str, Any]) -> str:
    canonical = json.dumps(normalize_for_hash(snapshot), ensure_ascii=False, sort_keys=True,
                           separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def compare_values(left: Any, right: Any, path: str = "$") -> list[str]:
    if isinstance(left, (float, int)) and not isinstance(left, bool) and isinstance(right, (float, int)) and not isinstance(right, bool):
        if not math.isclose(float(left), float(right), rel_tol=0.0, abs_tol=FLOAT_TOLERANCE):
            return [path]
        return []
    if isinstance(left, dict) and isinstance(right, dict):
        paths: list[str] = []
        for key in sorted(set(left) | set(right)):
            if key not in left or key not in right:
                paths.append(f"{path}.{key}")
            else:
                paths.extend(compare_values(left[key], right[key], f"{path}.{key}"))
        return paths
    if isinstance(left, list) and isinstance(right, list):
        paths = []
        if len(left) != len(right):
            paths.append(f"{path}.length")
        for index, (l_item, r_item) in enumerate(zip(left, right)):
            paths.extend(compare_values(l_item, r_item, f"{path}[{index}]"))
        return paths
    return [] if left == right else [path]


def read_mongo_target(target: str) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    try:
        completed = subprocess.run(["node", str(READER), "--target", target], cwd=ROOT,
                                   check=True, capture_output=True, text=True, timeout=240)
        payload = json.loads(completed.stdout)
    except Exception as error:
        # Never echo subprocess text: it can contain driver diagnostics.
        raise RuntimeError(f"{target.upper()}_READ_FAILED") from None
    return payload, round((time.perf_counter() - started) * 1000, 2)


def _compact_product(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "sku": row["sku"], "productName": row["productName"],
        "onHand": row["stock"]["onHand"], "incoming": row["stock"]["incoming"],
        "expectedDaily": row["demand"]["expectedDaily"],
        "daysCover": row["coverage"]["daysCover"],
        "safetyStock": row["inventoryPolicy"]["safetyStock"],
        "reorderPoint": row["inventoryPolicy"]["reorderPoint"],
        "risk": row["risk"]["level"],
        "shouldReorder": row["recommendation"]["shouldReorder"],
        "recommendedQty": row["recommendation"]["recommendedQty"],
        "abc": row["classification"]["abc"], "xyz": row["classification"]["xyz"],
        "dependencyStatus": row["supplier"]["dependencyStatus"],
    }


def run_parity() -> dict[str, Any]:
    engine = InventoryIntelligenceV3(ROOT)
    outputs: dict[str, dict[str, Any]] = {}
    read_times: dict[str, float] = {}
    compute_times: dict[str, float] = {}
    for target in ("local", "atlas"):
        extracted, read_times[target] = read_mongo_target(target)
        if extracted.get("source") != target or extracted.get("database") != "inventory_billing":
            raise RuntimeError(f"{target.upper()}_PREFLIGHT_FAILED")
        started = time.perf_counter()
        outputs[target] = engine.snapshot(CUTOFF, operational_records=extracted["operationalRecords"])
        compute_times[target] = round((time.perf_counter() - started) * 1000, 2)

    local, atlas = outputs["local"], outputs["atlas"]
    differences = compare_values(local, atlas)
    local_hash, atlas_hash = intelligence_sha256(local), intelligence_sha256(atlas)
    if local_hash != atlas_hash and not differences:
        differences.append("$.normalizedHash")
    by_local = {row["sku"]: row for row in local["products"]}
    by_atlas = {row["sku"]: row for row in atlas["products"]}
    pan_fields = ("onHand", "incoming", "inventoryPosition")
    pan_local = {key: by_local["PAN-FRE-001"]["stock"][key] for key in pan_fields}
    pan_local.update({"expectedDaily": by_local["PAN-FRE-001"]["demand"]["expectedDaily"],
                      "safetyStock": by_local["PAN-FRE-001"]["inventoryPolicy"]["safetyStock"],
                      "reorderPoint": by_local["PAN-FRE-001"]["inventoryPolicy"]["reorderPoint"],
                      "targetStock": by_local["PAN-FRE-001"]["inventoryPolicy"]["targetStock"],
                      "shouldReorder": by_local["PAN-FRE-001"]["recommendation"]["shouldReorder"],
                      "recommendedQty": by_local["PAN-FRE-001"]["recommendation"]["recommendedQty"],
                      "risk": by_local["PAN-FRE-001"]["risk"]["level"],
                      "daysCover": by_local["PAN-FRE-001"]["coverage"]["daysCover"],
                      "packMultiple": by_local["PAN-FRE-001"]["recommendation"]["packMultiple"],
                      "perishableCap": by_local["PAN-FRE-001"]["risk"]["reasonCodes"].count("PERISHABLE_CAP") > 0})
    pan_atlas = {key: by_atlas["PAN-FRE-001"]["stock"][key] for key in pan_fields}
    pan_atlas.update({"expectedDaily": by_atlas["PAN-FRE-001"]["demand"]["expectedDaily"],
                      "safetyStock": by_atlas["PAN-FRE-001"]["inventoryPolicy"]["safetyStock"],
                      "reorderPoint": by_atlas["PAN-FRE-001"]["inventoryPolicy"]["reorderPoint"],
                      "targetStock": by_atlas["PAN-FRE-001"]["inventoryPolicy"]["targetStock"],
                      "shouldReorder": by_atlas["PAN-FRE-001"]["recommendation"]["shouldReorder"],
                      "recommendedQty": by_atlas["PAN-FRE-001"]["recommendation"]["recommendedQty"],
                      "risk": by_atlas["PAN-FRE-001"]["risk"]["level"],
                      "daysCover": by_atlas["PAN-FRE-001"]["coverage"]["daysCover"],
                      "packMultiple": by_atlas["PAN-FRE-001"]["recommendation"]["packMultiple"],
                      "perishableCap": by_atlas["PAN-FRE-001"]["risk"]["reasonCodes"].count("PERISHABLE_CAP") > 0})
    representatives = {sku: {"local": _compact_product(by_local[sku]), "atlas": _compact_product(by_atlas[sku]),
                             "equal": not compare_values(_compact_product(by_local[sku]), _compact_product(by_atlas[sku]))}
                       for sku in REPRESENTATIVE_SKUS}
    rank_order = {key: {"equal": local["rankings"][key] == atlas["rankings"][key],
                        "top5": local["rankings"][key][:5]} for key in RANKINGS}
    result = {
        "status": "PASS" if not differences and len(local["products"]) == 80 and len(atlas["products"]) == 80 else "FAIL",
        "parity": "INVENTORY_INTELLIGENCE_LOCAL_ATLAS_PARITY=PASS" if not differences else "INVENTORY_INTELLIGENCE_LOCAL_ATLAS_PARITY=FAIL",
        "asOfDate": CUTOFF.isoformat(), "scenarioId": v3_forecast.SCENARIO_ID,
        "datasetSha256": v3_forecast.DATASET_SHA256, "forecastSource": "MOVING_AVERAGE_28", "horizons": [1, 7, 14],
        "skuComparison": {"local": len(local["products"]), "atlas": len(atlas["products"]),
                          "equivalent": len(local["products"]) == len(atlas["products"]) == 80},
        "localHash": local_hash, "atlasHash": atlas_hash,
        "floatComparison": {"absoluteTolerance": FLOAT_TOLERANCE, "hashRoundingDecimalPlaces": FLOAT_DIGITS},
        "localSummary": local["summary"], "atlasSummary": atlas["summary"],
        "localRisk": {key: local["summary"][key] for key in ("critical", "high", "medium", "low")},
        "atlasRisk": {key: atlas["summary"][key] for key in ("critical", "high", "medium", "low")},
        "localABC": local["abcCounts"], "atlasABC": atlas["abcCounts"],
        "localXYZ": local["xyzCounts"], "atlasXYZ": atlas["xyzCounts"],
        "localMatrix": local["abcXyzCounts"], "atlasMatrix": atlas["abcXyzCounts"],
        "rankings": rank_order, "panFre001": {"local": pan_local, "atlas": pan_atlas,
                                                "equal": not compare_values(pan_local, pan_atlas)},
        "representatives": representatives,
        "runtimesMs": {target: {"mongoReadAndTransfer": read_times[target], "snapshotCompute": compute_times[target],
                                "total": round(read_times[target] + compute_times[target], 2)}
                       for target in ("local", "atlas")},
        "differences": differences[:50], "differenceCount": len(differences),
    }
    return result


def main() -> int:
    try:
        result = run_parity()
    except Exception as error:
        # Error text is intentionally restricted to static safe categories.
        safe = str(error) if str(error) in {"LOCAL_READ_FAILED", "ATLAS_READ_FAILED", "LOCAL_PREFLIGHT_FAILED", "ATLAS_PREFLIGHT_FAILED"} else "M6_6A_READ_ONLY_PARITY_FAILED"
        print(json.dumps({"status": "BLOCKED", "error": safe}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
