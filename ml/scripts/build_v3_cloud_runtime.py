"""Generate the approved seed during build, then seal/verify its runtime inventory."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

from ml.service.v3_package import describe_package, verify_package


def build(root: Path, *, verify_only: bool = False) -> dict:
    root = Path(root).resolve()
    if not shutil.which("node"):
        raise RuntimeError("Node.js is required for the approved V3 canonical generator")
    generated = root / "data/minimarket-pasco-v3/generated"
    if not (generated / "manifest.json").is_file():
        if verify_only:
            raise FileNotFoundError("V3 canonical package is missing")
        subprocess.run(["node", "scripts/generate-minimarket-v3.js", "--seed", "2026"],
                       cwd=root, check=True, stdout=subprocess.DEVNULL, timeout=300)
    descriptor = describe_package(root)
    destination = generated / "runtime-package.json"
    if destination.is_file():
        # A stale/corrupt descriptor is not silently replaced by a new seal.
        return verify_package(root)
    destination.write_text(json.dumps(descriptor, ensure_ascii=False, sort_keys=True,
                                      indent=2) + "\n", encoding="utf-8")
    return verify_package(root)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    descriptor = build(args.root, verify_only=args.verify_only)
    print(json.dumps({"status": "verified", "scenarioId": descriptor["scenarioId"],
                      "bundleVersion": descriptor["bundleVersion"],
                      "sourceLogicalHash": descriptor["sourceLogicalHash"],
                      "counts": descriptor["counts"],
                      "runtimeBytes": sum(descriptor["fileBytes"].values()),
                      "artifactBytes": sum(row["bytes"] for row in descriptor["artifacts"].values())}))


if __name__ == "__main__":
    main()
