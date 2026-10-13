"""Share immutable repeated strings while retaining every canonical field/value."""
from __future__ import annotations

import json
import sys
from pathlib import Path

SHARED_VALUES = frozenset({
    "scenarioId", "businessKey", "sku", "productKey", "supplierCode", "customerCode",
    "categoryCode", "subcategoryCode", "currency", "status", "type", "movementType",
    "sourceType", "localDate", "date", "unit", "paymentMethod", "channel",
})


class CanonicalRowPool:
    """Worker-local parser; only immutable strings are shared across independent rows."""

    @staticmethod
    def object(row: dict) -> dict:
        return {sys.intern(key): sys.intern(value) if key in SHARED_VALUES and isinstance(value, str)
                else value for key, value in row.items()}

    def read(self, path: Path) -> list[dict]:
        with path.open("r", encoding="utf-8") as stream:
            return [json.loads(line, object_hook=self.object) for line in stream if line.strip()]

    def share_dataset_strings(self, dataset) -> None:
        for series in dataset.daily_by_sku.values():
            for index, row in enumerate(series):
                series[index] = self.object(row)
