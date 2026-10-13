"""Integrity boundary for a reproducible V3 cloud package (no database access)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

SCENARIO_ID = "minimarket-pasco-v3"
DATASET_VERSION = "minimarket-pasco-v3-seed2026-v1"
SOURCE_HASH = "a90b913b6ee83174165b39eaab1526525b3aacc53cae1abe6c3f5a54a469cac8"
BUNDLE_VERSION = "v3-cloud-runtime-v1"
COUNTS = {
    "cancelledSales": 127, "categories": 10, "completedSales": 12647, "customers": 40,
    "inventorySnapshotRows": 80, "movements": 40445, "pendingPurchases": 29,
    "pendingSales": 79, "priceChanges": 25, "productDailyRows": 29200, "products": 80,
    "promotions": 130, "purchaseItems": 3408, "purchases": 2155, "saleItems": 37621,
    "sales": 12853, "subcategories": 42, "supplierCostChanges": 27, "supplierOffers": 103,
    "suppliers": 10,
}
ROW_COUNTS = {
    "categories.ndjson": "categories", "customers.ndjson": "customers",
    "inventory-movements.ndjson": "movements", "inventory-snapshot.ndjson": "inventorySnapshotRows",
    "price-history.ndjson": "priceChanges", "product-daily.ndjson": "productDailyRows",
    "products.ndjson": "products", "promotions.ndjson": "promotions",
    "purchase-items.ndjson": "purchaseItems", "purchases.ndjson": "purchases",
    "sale-items.ndjson": "saleItems", "sales.ndjson": "sales",
    "supplier-cost-history.ndjson": "supplierCostChanges", "suppliers.ndjson": "suppliers",
}
ARTIFACTS = (
    "ml/models/minimarket-pasco-v3/baseline-manifest.json",
    "ml/data/minimarket-pasco-v3-market-basket-v1.json",
)


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def describe_package(root: Path) -> dict:
    root = Path(root).resolve()
    generated = root / "data/minimarket-pasco-v3/generated"
    manifest_path = generated / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (manifest.get("scenarioId") != SCENARIO_ID
            or manifest.get("datasetVersion") != DATASET_VERSION
            or manifest.get("referenceDate") != "2026-10-12"
            or manifest.get("counts") != COUNTS):
        raise ValueError("V3 package lineage/counts do not match the approved source")
    expected_files = manifest.get("hashes", {}).get("files", {})
    if len(expected_files) != 20 or not set(ROW_COUNTS).issubset(expected_files):
        raise ValueError("V3 package file inventory is incomplete")
    hashes, sizes = {}, {}
    for name, expected in sorted(expected_files.items()):
        if Path(name).name != name or "/" in name or "\\" in name:
            raise ValueError("V3 package contains an invalid file name")
        source = generated / name
        actual = file_hash(source)
        if actual != expected:
            raise ValueError("V3 package file integrity mismatch")
        hashes[name], sizes[name] = actual, source.stat().st_size
        if name in ROW_COUNTS:
            with source.open("rb") as stream:
                rows = sum(bool(line.strip()) for line in stream)
            if rows != COUNTS[ROW_COUNTS[name]]:
                raise ValueError("V3 package row count mismatch")
    logical = hashlib.sha256(json.dumps(hashes, sort_keys=True, ensure_ascii=False,
                                        separators=(",", ":")).encode("utf-8")).hexdigest()
    if logical != SOURCE_HASH or manifest.get("hashes", {}).get("logicalDatasetSha256") != SOURCE_HASH:
        raise ValueError("V3 package logical hash mismatch")
    artifacts = {name: {"sha256": file_hash(root / name), "bytes": (root / name).stat().st_size}
                 for name in ARTIFACTS}
    return {"scenarioId": SCENARIO_ID, "datasetVersion": DATASET_VERSION,
            "referenceDate": "2026-10-12", "sourceLogicalHash": SOURCE_HASH,
            "bundleVersion": BUNDLE_VERSION, "counts": dict(COUNTS), "hashes": hashes,
            "manifestSha256": file_hash(manifest_path), "fileBytes": sizes, "artifacts": artifacts}


def verify_package(root: Path) -> dict:
    generated = Path(root) / "data/minimarket-pasco-v3/generated"
    descriptor = json.loads((generated / "runtime-package.json").read_text(encoding="utf-8"))
    if descriptor != describe_package(root):
        raise ValueError("V3 runtime package descriptor does not match its contents")
    return descriptor
