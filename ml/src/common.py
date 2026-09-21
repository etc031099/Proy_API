from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import tomllib
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


ML_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ML_ROOT.parent
EXPECTED_M5_FILES = (
    "calendar.csv",
    "sell_prices.csv",
    "sales_train_validation.csv",
    "sales_train_evaluation.csv",
    "sample_submission.csv",
)
REQUIRED_M5_FILES = ("calendar.csv", "sell_prices.csv")
SALES_FILE_PREFERENCE = (
    "sales_train_evaluation.csv",
    "sales_train_validation.csv",
)


def repository_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPOSITORY_ROOT / path


def load_config(path: str | Path = "ml/config/base.toml") -> dict[str, Any]:
    config_path = repository_path(path)
    with config_path.open("rb") as stream:
        return tomllib.load(stream)


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "size_bytes": stat.st_size,
        "size_mb": round(stat.st_size / (1024 * 1024), 3),
        "sha256": sha256_file(path),
        "modified_at_utc": datetime.fromtimestamp(
            stat.st_mtime, timezone.utc
        ).isoformat(),
    }


def discover_m5_files(raw_directory: Path) -> dict[str, Path]:
    if not raw_directory.exists():
        return {}
    return {
        path.name: path
        for path in raw_directory.iterdir()
        if path.is_file() and path.suffix.lower() == ".csv"
    }


def resolve_sales_file(files: dict[str, Path]) -> Path:
    for name in SALES_FILE_PREFERENCE:
        if name in files:
            return files[name]
    raise FileNotFoundError(
        "Missing sales data: expected sales_train_evaluation.csv or "
        "sales_train_validation.csv"
    )


def validate_required_files(files: dict[str, Path]) -> None:
    missing = [name for name in REQUIRED_M5_FILES if name not in files]
    if missing:
        raise FileNotFoundError(f"Missing required M5 files: {', '.join(missing)}")
    resolve_sales_file(files)


def sql_literal(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''").replace("\\", "/") + "'"


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, indent=2, ensure_ascii=False, default=str) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def assert_outside_raw(path: Path, raw_directory: Path) -> None:
    resolved_path = path.resolve()
    resolved_raw = raw_directory.resolve()
    if resolved_path == resolved_raw or resolved_raw in resolved_path.parents:
        raise ValueError(f"Output cannot be written inside immutable raw data: {path}")


def capture_hashes(files: dict[str, Path]) -> dict[str, str]:
    return {name: sha256_file(path) for name, path in sorted(files.items())}


def verify_hashes(files: dict[str, Path], expected: dict[str, str]) -> None:
    actual = capture_hashes(files)
    if actual != expected:
        raise RuntimeError("Raw M5 files changed while the pipeline was running")


class PeakMemoryMonitor:
    def __init__(self, interval_seconds: float = 0.1) -> None:
        self.interval_seconds = interval_seconds
        self.peak_rss_bytes = 0
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "PeakMemoryMonitor":
        try:
            import psutil
        except ImportError as error:
            raise RuntimeError(
                "psutil is required to measure peak memory; install ml/requirements.txt"
            ) from error

        process = psutil.Process()

        def sample() -> None:
            while not self._stopped.is_set():
                self.peak_rss_bytes = max(
                    self.peak_rss_bytes, process.memory_info().rss
                )
                self._stopped.wait(self.interval_seconds)

        self._thread = threading.Thread(target=sample, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stopped.set()
        if self._thread:
            self._thread.join(timeout=1)


@contextmanager
def measured_run() -> Iterator[dict[str, Any]]:
    metrics: dict[str, Any] = {}
    started = time.perf_counter()
    with PeakMemoryMonitor() as memory:
        yield metrics
    metrics["elapsed_seconds"] = round(time.perf_counter() - started, 3)
    metrics["peak_rss_bytes"] = memory.peak_rss_bytes
    metrics["peak_rss_mb"] = round(memory.peak_rss_bytes / (1024 * 1024), 3)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
