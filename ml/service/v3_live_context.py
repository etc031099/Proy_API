"""Validate and build immutable, request-scoped V3 historical + live contexts.

This module ingests the backend-owned snapshot only. It intentionally does not
run live analytics; M6.9F.4 owns engine adapters and calculations.
"""
from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from threading import RLock
from types import MappingProxyType
from typing import Any, Iterator, Mapping
from zoneinfo import ZoneInfo

from ml.service.v3_schemas import (
    BUSINESS_ID, DATASET_SHA256, DATASET_VERSION, REFERENCE_DATE, SCENARIO_ID,
    TIMEZONE, V3OperationalSnapshot,
)

SNAPSHOT_VERSION = "v3-operational-snapshot-v1"
SNAPSHOT_MAX_BYTES = 1_572_864
MAX_INT64 = 9_223_372_036_854_775_807
LIMA = ZoneInfo(TIMEZONE)
ENGINE_VERSION = "m6.9f3-live-context-v1"
BASKET_ANALYSIS_VERSION = "MINIMARKET-PASCO-V3-MBA-v1"


class LiveSnapshotError(Exception):
    def __init__(self, code: str, status_code: int, message: str):
        super().__init__(message)
        self.code, self.status_code, self.message = code, status_code, message


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=False, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def _wire_value(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise LiveSnapshotError("LIVE_SNAPSHOT_INVALID", 422, "Snapshot timestamps must include a UTC offset.")
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _wire_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_wire_value(item) for item in value]
    return value


def _canonical(value: Any) -> Any:
    if isinstance(value, list):
        items = [_canonical(item) for item in value]
        # Backend uses JS localeCompare(JSON.stringify(row)); case-folding the
        # compact UTF-8 JSON preserves its locale ordering for the contract's
        # stable identifiers/names while avoiding host-locale dependence.
        return sorted(items, key=lambda item: _json_bytes(item).decode("utf-8").casefold())
    if isinstance(value, dict):
        return {key: _canonical(value[key]) for key in sorted(value)}
    return value


def snapshot_hash(snapshot: V3OperationalSnapshot | dict[str, Any]) -> str:
    raw = (_wire_value(snapshot.model_dump(mode="python", exclude_none=False)) if isinstance(snapshot, V3OperationalSnapshot)
           else json.loads(json.dumps(snapshot, ensure_ascii=False, allow_nan=False)))
    metadata = raw["metadata"]
    metadata.pop("snapshotHash", None)
    metadata.pop("capturedAtUtc", None)
    # The backend computes snapshotHash before enforcePayloadLimit adds this field.
    metadata.pop("payloadBytes", None)
    # This mirrors JS `{ capturedAtUtc: undefined }` followed by JSON.stringify.
    encoded = _json_bytes(_canonical(raw))
    return hashlib.sha256(encoded).hexdigest()


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise LiveSnapshotError("LIVE_SNAPSHOT_INVALID", 422, "Snapshot timestamps must include a UTC offset.")
    return value.astimezone(timezone.utc)


def _day_start_utc(day: date) -> datetime:
    local_start = datetime.combine(day, time.min, tzinfo=LIMA)
    return local_start.astimezone(timezone.utc)


def _allowed_through(metadata) -> datetime:
    captured = _as_utc(metadata.capturedAtUtc)
    if metadata.asOfDate == metadata.operationalDate:
        return captured
    return _day_start_utc(metadata.asOfDate + timedelta(days=1)) - timedelta(milliseconds=1)


def _raise_invalid(message: str, status_code: int = 422, code: str = "LIVE_SNAPSHOT_INVALID") -> None:
    raise LiveSnapshotError(code, status_code, message)


def _base_identity_sets(base_records: Mapping[str, Any]) -> tuple[set[str], set[str], set[str], set[str], set[str]]:
    products = set()
    skus = set()
    customers = set()
    suppliers = set()
    sales = set()
    purchases = set()
    for row in base_records.get("products", ()):
        if row.get("productKey"):
            products.add(str(row["productKey"]))
        if row.get("sku"):
            skus.add(str(row["sku"]))
    for row in base_records.get("customers", ()):
        key = row.get("customerCode") or row.get("customerKey")
        if key:
            customers.add(str(key))
    for row in base_records.get("suppliers", ()):
        key = row.get("supplierCode") or row.get("supplierKey")
        if key:
            suppliers.add(str(key))
    for row in base_records.get("sales", ()):
        key = row.get("saleCode")
        if key:
            sales.add(str(key))
    for row in base_records.get("purchases", ()):
        key = row.get("purchaseCode")
        if key:
            purchases.add(str(key))
    return products, skus, customers, suppliers, sales, purchases


def validate_snapshot(snapshot: V3OperationalSnapshot, *, base_records: Mapping[str, Any],
                      request_business_id: str, request_scenario_id: str,
                      request_dataset_version: str | None, request_dataset_sha256: str | None,
                      request_timezone: str, request_as_of_date: date | None,
                      request_body_bytes: int) -> None:
    """Fail closed on lineage, size, time boundaries, hash, duplicates, or refs."""
    meta = snapshot.metadata
    if request_body_bytes > SNAPSHOT_MAX_BYTES or meta.payloadBytes > SNAPSHOT_MAX_BYTES:
        _raise_invalid("V3 live snapshot exceeds the request size limit.", 413, "LIVE_SNAPSHOT_TOO_LARGE")
    if (meta.businessId != BUSINESS_ID or request_business_id != BUSINESS_ID
            or meta.businessId != request_business_id):
        _raise_invalid("Snapshot business is not authorized for V3.", 403, "TENANT_MISMATCH")
    if (meta.scenarioId != SCENARIO_ID or request_scenario_id != SCENARIO_ID
            or meta.scenarioId != request_scenario_id):
        _raise_invalid("Snapshot scenario is not authorized for V3.", 403, "TENANT_MISMATCH")
    if (meta.historicalDatasetVersion != DATASET_VERSION or meta.historicalDatasetSha256 != DATASET_SHA256
            or (request_dataset_version and request_dataset_version != DATASET_VERSION)
            or (request_dataset_sha256 and request_dataset_sha256 != DATASET_SHA256)):
        _raise_invalid("Snapshot historical lineage is not approved.", 409, "SCENARIO_NOT_SUPPORTED")
    if (meta.historicalCutoff != REFERENCE_DATE or meta.deltaStart != REFERENCE_DATE + timedelta(days=1)
            or meta.timezone != TIMEZONE or request_timezone != TIMEZONE):
        _raise_invalid("Snapshot cutoff, delta start, or timezone differs from the approved V3 boundary.")
    if request_as_of_date is None or request_as_of_date != meta.asOfDate or request_as_of_date <= REFERENCE_DATE:
        _raise_invalid("LIVE requires a matching asOfDate after the frozen historical cutoff.")
    if meta.operationalDate < meta.asOfDate:
        _raise_invalid("Snapshot operationalDate cannot precede asOfDate.")
    if meta.observationsClosedThrough != min(meta.asOfDate - timedelta(days=1), meta.operationalDate - timedelta(days=1)):
        _raise_invalid("Snapshot closed-observation boundary is inconsistent.")
    if _as_utc(meta.capturedAtUtc).date() < _day_start_utc(meta.asOfDate).date():
        _raise_invalid("Snapshot capture timestamp precedes its as-of day.")
    try:
        data_version = int(meta.dataVersion)
    except (TypeError, ValueError):
        _raise_invalid("Snapshot dataVersion is invalid.")
    if data_version < 0 or data_version > MAX_INT64:
        _raise_invalid("Snapshot dataVersion is outside BSON int64 range.")
    through = _allowed_through(meta)
    if meta.dataThroughUtc is not None:
        data_through = _as_utc(meta.dataThroughUtc)
        if data_through < _day_start_utc(meta.deltaStart) or data_through > through:
            _raise_invalid("Snapshot data watermark is outside its authorized time boundary.")
    for timestamp in (meta.capturedAtUtc, meta.dataThroughUtc):
        if timestamp is not None:
            _as_utc(timestamp)

    expected_counts = {
        "catalogChanges": len(snapshot.catalogChanges), "sales": len(snapshot.sales),
        "purchases": len(snapshot.purchases), "transactionChanges": len(snapshot.transactionChanges),
        "stockStates": len(snapshot.stockStates), "closedSalesDays": len(snapshot.closedSalesDays),
    }
    if meta.counts.model_dump() != expected_counts:
        _raise_invalid("Snapshot counts do not match the supplied records.")
    sale_lines = [line for sale in snapshot.sales for line in sale.lines]
    if meta.costCoverage.model_dump() != {
        "knownSaleLines": sum(line.costKnown for line in sale_lines),
        "unknownSaleLines": sum(not line.costKnown for line in sale_lines),
    }:
        _raise_invalid("Snapshot cost coverage does not reconcile with sales lines.")

    calculated_hash = snapshot_hash(snapshot)
    if calculated_hash != meta.snapshotHash:
        _raise_invalid("Snapshot logical hash does not match its contents.", 422, "SNAPSHOT_HASH_MISMATCH")
    measured = _wire_value(snapshot.model_dump(mode="python", exclude_none=False))
    measured["metadata"]["payloadBytes"] = 0
    payload_bytes = len(_json_bytes(measured))
    for _ in range(5):
        measured["metadata"]["payloadBytes"] = payload_bytes
        actual = len(_json_bytes(measured))
        if actual == payload_bytes:
            break
        payload_bytes = actual
    if payload_bytes > SNAPSHOT_MAX_BYTES or meta.payloadBytes != payload_bytes:
        _raise_invalid("Snapshot payload size marker is invalid or oversized.", 413, "LIVE_SNAPSHOT_TOO_LARGE")

    base_products, _, base_customers, base_suppliers, base_sales, base_purchases = _base_identity_sets(base_records)
    base_transactions = base_sales | base_purchases
    base_product_rows = {str(row.get("productKey") or row.get("sku")): row
                         for row in base_records.get("products", ())}
    product_states = {key: row.get("sku") for key, row in base_product_rows.items()}
    sku_owner = {sku: key for key, sku in product_states.items() if sku}
    product_keys, skus = set(product_states), set(sku_owner)
    customer_keys, supplier_keys = set(base_customers), set(base_suppliers)
    catalog_events: set[str] = set()
    ordered_catalog = sorted(snapshot.catalogChanges,
                             key=lambda row: (_as_utc(row.effectiveAtUtc), int(row.revision), row.eventKey))
    for change in ordered_catalog:
        if change.eventKey in catalog_events:
            _raise_invalid("Snapshot contains duplicate catalog event keys.")
        catalog_events.add(change.eventKey)
        effective = _as_utc(change.effectiveAtUtc)
        if effective < _day_start_utc(meta.deltaStart) or effective > through:
            _raise_invalid("Catalog change is outside the LIVE delta boundary.")
        if int(change.revision) > data_version:
            _raise_invalid("Catalog change revision exceeds the snapshot dataVersion.")
        if change.entityType == "product":
            if change.projection.entityType != "product" or change.projection.after.productKey != change.entityKey:
                _raise_invalid("Product change projection does not match its stable key.")
            after = change.projection.after
            for offer in after.supplierOffers:
                if offer.supplierKey not in supplier_keys:
                    _raise_invalid("Product offer references a supplier outside the authorized context.",
                                   422, "POST_CUTOFF_DATA_INVALID")
            if change.operation == "CREATE" and change.entityKey in product_states:
                _raise_invalid("Catalog CREATE duplicates an existing product key.", 422, "POST_CUTOFF_DATA_INVALID")
            if change.operation != "CREATE" and change.entityKey not in product_states:
                _raise_invalid("Catalog update references a product outside the base/live catalog.", 422, "POST_CUTOFF_DATA_INVALID")
            before = change.projection.before
            if change.operation != "CREATE" and (before is None or before.productKey != change.entityKey):
                _raise_invalid("Catalog update is missing its prior product identity.", 422, "POST_CUTOFF_DATA_INVALID")
            if change.operation != "CREATE" and before.sku != product_states[change.entityKey]:
                _raise_invalid("Catalog update prior SKU does not match the current as-of state.", 422, "POST_CUTOFF_DATA_INVALID")
            if change.operation == "DEACTIVATE" and after.active:
                _raise_invalid("DEACTIVATE product change must mark the product inactive.", 422, "POST_CUTOFF_DATA_INVALID")
            if before is not None and before.sku:
                sku_owner.pop(before.sku, None)
                skus.discard(before.sku)
            if after.sku:
                owner = sku_owner.get(after.sku)
                if owner is not None and owner != change.entityKey:
                    _raise_invalid("Catalog change duplicates a commercial SKU.", 422, "POST_CUTOFF_DATA_INVALID")
                sku_owner[after.sku] = change.entityKey
                skus.add(after.sku)
            product_states[change.entityKey] = after.sku
            product_keys.add(after.productKey)
        else:
            if change.projection.entityType != "contact" or change.projection.after.entityKey != change.entityKey:
                _raise_invalid("Contact change projection does not match its stable key.")
            after = change.projection.after
            known_entities = customer_keys if change.entityType == "customer" else supplier_keys
            if change.operation == "CREATE" and change.entityKey in known_entities:
                _raise_invalid("Catalog CREATE duplicates an existing contact key.", 422, "POST_CUTOFF_DATA_INVALID")
            if change.operation != "CREATE" and change.entityKey not in known_entities:
                _raise_invalid("Catalog update references a contact outside the base/live catalog.", 422, "POST_CUTOFF_DATA_INVALID")
            before = change.projection.before
            if change.operation != "CREATE" and (before is None or before.entityKey != change.entityKey):
                _raise_invalid("Catalog update is missing its prior contact identity.", 422, "POST_CUTOFF_DATA_INVALID")
            if change.entityType == "customer" and after.type != "customer":
                _raise_invalid("Customer projection has the wrong entity type.")
            if change.entityType == "supplier" and after.type != "vendor":
                _raise_invalid("Supplier projection has the wrong entity type.")
            (customer_keys if change.entityType == "customer" else supplier_keys).add(change.entityKey)

    sale_keys: set[str] = set()
    sale_line_keys: set[str] = set()
    for sale in snapshot.sales:
        occurred = _as_utc(sale.occurredAtUtc)
        if occurred < _day_start_utc(meta.deltaStart) or occurred > through or sale.localDate <= REFERENCE_DATE or sale.localDate > meta.asOfDate:
            _raise_invalid("Sale is outside the LIVE delta boundary.")
        if sale.saleKey in sale_keys or sale.saleKey in base_sales:
            _raise_invalid("Snapshot contains duplicate stable sale keys.")
        sale_keys.add(sale.saleKey)
        expected_local = occurred.astimezone(LIMA).date()
        if sale.localDate != expected_local:
            _raise_invalid("Sale localDate does not match its America/Lima event time.")
        if sale.customerKey and sale.customerKey not in customer_keys:
            _raise_invalid("Sale references a customer outside the authorized context.", 422, "POST_CUTOFF_DATA_INVALID")
        for line in sale.lines:
            if line.lineKey in sale_line_keys:
                _raise_invalid("Snapshot contains duplicate sale line keys.")
            sale_line_keys.add(line.lineKey)
            if line.productKey not in product_keys or (line.sku and line.sku not in skus):
                _raise_invalid("Sale line references a product outside the authorized context.", 422, "POST_CUTOFF_DATA_INVALID")
            if line.costKnown != (line.unitCostAtSaleCents is not None) or (line.costKnown and line.costBasis != "CAPTURED"):
                _raise_invalid("Sale cost evidence is inconsistent.", 422, "POST_CUTOFF_DATA_INVALID")

    purchase_keys: set[str] = set()
    purchase_line_keys: set[str] = set()
    for purchase in snapshot.purchases:
        ordered = _as_utc(purchase.orderedAtUtc)
        if ordered < _day_start_utc(meta.deltaStart) or ordered > through:
            _raise_invalid("Purchase is outside the LIVE delta boundary.")
        if purchase.purchaseKey in purchase_keys or purchase.purchaseKey in base_purchases:
            _raise_invalid("Snapshot contains duplicate stable purchase keys.")
        purchase_keys.add(purchase.purchaseKey)
        if purchase.supplierKey not in supplier_keys:
            _raise_invalid("Purchase references a supplier outside the authorized context.", 422, "POST_CUTOFF_DATA_INVALID")
        if purchase.promisedAtUtc is not None and _as_utc(purchase.promisedAtUtc) < ordered:
            _raise_invalid("Purchase promise cannot precede its order time.")
        for line in purchase.lines:
            if line.lineKey in purchase_line_keys:
                _raise_invalid("Snapshot contains duplicate purchase line keys.")
            purchase_line_keys.add(line.lineKey)
            if line.productKey not in product_keys or (line.sku and line.sku not in skus):
                _raise_invalid("Purchase line references a product outside the authorized context.", 422, "POST_CUTOFF_DATA_INVALID")

    transaction_event_keys: set[str] = set()
    transaction_event_targets: set[tuple[str, str]] = set()
    transaction_keys = base_transactions | sale_keys | purchase_keys
    for change in snapshot.transactionChanges:
        effective = _as_utc(change.effectiveAtUtc)
        if effective < _day_start_utc(meta.deltaStart) or effective > through:
            _raise_invalid("Transaction change is outside the LIVE delta boundary.")
        if change.eventKey in transaction_event_keys:
            _raise_invalid("Snapshot contains duplicate transaction event keys.")
        transaction_event_keys.add(change.eventKey)
        if int(change.revision) > data_version or change.entityKey != change.transactionKey:
            _raise_invalid("Transaction event revision or identity is inconsistent.")
        target_key = (change.transactionKey, change.kind)
        if target_key in transaction_event_targets:
            _raise_invalid("Snapshot contains duplicate transaction state changes.")
        transaction_event_targets.add(target_key)
        if change.transactionKey not in transaction_keys:
            # Historical Mongo ObjectIds are not currently mapped to canonical
            # saleCode/purchaseCode; reject rather than silently miss a cancel.
            _raise_invalid("Transaction change references an unknown stable transaction key.", 422, "POST_CUTOFF_DATA_INVALID")
        target = next((sale for sale in snapshot.sales if sale.saleKey == change.transactionKey), None)
        if target and change.kind == "CANCEL" and effective < _as_utc(target.occurredAtUtc):
            _raise_invalid("Cancellation cannot precede its transaction.")
        if change.kind == "RECEIVE":
            purchase = next((item for item in snapshot.purchases if item.purchaseKey == change.transactionKey), None)
            if purchase is None:
                _raise_invalid("Receipt event must reference a purchase in the live context.", 422, "POST_CUTOFF_DATA_INVALID")
            line_by_key = {line.lineKey: line for line in purchase.lines}
            received_totals: dict[str, int] = {}
            for line_change in change.lineChanges:
                line = line_by_key.get(line_change.lineKey)
                if line is None or line_change.receivedQty is None:
                    _raise_invalid("Receipt line is missing or exceeds the ordered quantity.", 422, "POST_CUTOFF_DATA_INVALID")
                received_totals[line_change.lineKey] = received_totals.get(line_change.lineKey, 0) + line_change.receivedQty
                if received_totals[line_change.lineKey] > line.quantityOrdered:
                    _raise_invalid("Receipt quantity exceeds the ordered quantity.", 422, "POST_CUTOFF_DATA_INVALID")

    stock_keys: set[str] = set()
    stock_skus: set[str] = set()
    for row in snapshot.stockStates:
        if row.productKey not in product_keys or row.productKey in stock_keys:
            _raise_invalid("Stock state has an unknown or duplicate product key.", 422, "POST_CUTOFF_DATA_INVALID")
        stock_keys.add(row.productKey)
        if row.sku:
            if row.sku not in skus or row.sku in stock_skus:
                _raise_invalid("Stock state has an unknown or duplicate SKU.", 422, "POST_CUTOFF_DATA_INVALID")
            if product_states.get(row.productKey) != row.sku:
                _raise_invalid("Stock state SKU does not match the visible product version.", 422, "POST_CUTOFF_DATA_INVALID")
            stock_skus.add(row.sku)
        elif product_states.get(row.productKey) is not None:
            _raise_invalid("Stock state omitted a visible commercial SKU.", 422, "POST_CUTOFF_DATA_INVALID")
    if stock_keys != product_keys:
        _raise_invalid("Stock state must cover exactly the products visible at the snapshot boundary.", 422, "POST_CUTOFF_DATA_INVALID")
    day_keys: set[tuple[str, date]] = set()
    for row in snapshot.closedSalesDays:
        key = (row.productKey, row.localDate)
        if row.productKey not in product_keys or row.localDate < meta.deltaStart or row.localDate > meta.observationsClosedThrough or key in day_keys:
            _raise_invalid("Closed sales day has invalid boundary, product, or duplicate key.", 422, "POST_CUTOFF_DATA_INVALID")
        day_keys.add(key)
        if row.availability == "UNKNOWN" and (row.availableHours is not None or row.onHandUsableAtOrigin is not None):
            _raise_invalid("Unknown availability cannot contain observed exposure values.")
    expected_day_keys = {(product_key, day)
                         for day in (meta.deltaStart + timedelta(days=offset)
                                     for offset in range(max(0, (meta.observationsClosedThrough - meta.deltaStart).days + 1)))
                         for product_key in product_keys}
    if day_keys != expected_day_keys:
        _raise_invalid("Closed-day rows must completely cover each visible product through observationsClosedThrough.",
                       422, "POST_CUTOFF_DATA_INVALID")
    cancelled_keys = {change.transactionKey for change in snapshot.transactionChanges if change.kind == "CANCEL"}
    sold_by_product_day: dict[tuple[str, date], int] = {}
    for sale in snapshot.sales:
        if (sale.initialStatus != "completed" or sale.saleKey in cancelled_keys
                or sale.localDate > meta.observationsClosedThrough):
            continue
        for line in sale.lines:
            key = (line.productKey, sale.localDate)
            sold_by_product_day[key] = sold_by_product_day.get(key, 0) + line.quantity
    if any(row.unitsSold != sold_by_product_day.get((row.productKey, row.localDate), 0)
           for row in snapshot.closedSalesDays):
        _raise_invalid("Closed-day totals do not reconcile with completed uncancelled sales.",
                       422, "POST_CUTOFF_DATA_INVALID")


@dataclass(frozen=True, slots=True)
class LiveV3Context:
    """Immutable overlay over the process's frozen historical V3 sources."""
    base_records: Mapping[str, Any]
    snapshot: V3OperationalSnapshot
    context_hash: str
    products_by_key: Mapping[str, Any]
    products_by_sku: Mapping[str, Any]
    customers_by_key: Mapping[str, Any]
    suppliers_by_key: Mapping[str, Any]
    stock_by_product_key: Mapping[str, int]
    stock_by_sku: Mapping[str, int]
    closed_sales_by_product_day: Mapping[tuple[str, date], Any]
    cancelled_transaction_keys: frozenset[str]
    received_by_purchase_line: Mapping[str, int]

    @property
    def data_version(self) -> str:
        return self.snapshot.metadata.dataVersion

    @property
    def as_of_date(self) -> date:
        return self.snapshot.metadata.asOfDate

    @property
    def market_basket_cutoff(self) -> date:
        return REFERENCE_DATE

    def iter_sales(self) -> Iterator[Any]:
        for sale in self.base_records.get("sales", ()):
            if (sale.get("status") == "completed" and not sale.get("cancelledAt")
                    and sale.get("localDate", "") <= self.as_of_date.isoformat()
                    and sale.get("saleCode") not in self.cancelled_transaction_keys):
                yield sale
        for sale in self.snapshot.sales:
            if sale.initialStatus == "completed" and sale.saleKey not in self.cancelled_transaction_keys:
                yield sale

    def iter_purchases(self) -> Iterator[Any]:
        yield from self.base_records.get("purchases", ())
        yield from self.snapshot.purchases

    def freshness(self, domain: str) -> Mapping[str, Any]:
        if domain == "marketBasket":
            return MappingProxyType({"mode": "HISTORICAL", "analysisCutoff": REFERENCE_DATE.isoformat(),
                                     "artifactVersion": BASKET_ANALYSIS_VERSION})
        return MappingProxyType({"mode": "LIVE", "asOfDate": self.as_of_date.isoformat(),
                                 "dataThroughUtc": self.snapshot.metadata.dataThroughUtc,
                                 "dataVersion": self.data_version,
                                 "historicalCutoff": REFERENCE_DATE.isoformat(),
                                 "engineVersion": ENGINE_VERSION})

    def stock_for(self, *, product_key: str | None = None, sku: str | None = None) -> int | None:
        if product_key is not None:
            return self.stock_by_product_key.get(product_key)
        return self.stock_by_sku.get(sku) if sku is not None else None

    def forecast_readiness(self, sku: str) -> str:
        if sku in self.products_by_sku and sku not in {row["sku"] for row in self.base_records.get("products", ()) if row.get("sku")}:
            return "COLD_START"
        return "HISTORICAL_INPUTS_AVAILABLE"


class LiveV3ContextStore:
    """Small worker-local context cache keyed by complete snapshot identity."""
    def __init__(self, max_entries: int = 2):
        self.max_entries = max_entries
        self._contexts: OrderedDict[tuple[str, ...], LiveV3Context] = OrderedDict()
        self._hash_by_boundary: OrderedDict[tuple[str, ...], str] = OrderedDict()
        self._lock = RLock()

    @staticmethod
    def cache_key(snapshot: V3OperationalSnapshot, engine_version: str = ENGINE_VERSION,
                  *, period: Any = None, entity_filter: Any = None) -> tuple[str, ...]:
        meta = snapshot.metadata
        return (meta.businessId, meta.scenarioId, meta.historicalDatasetVersion,
                meta.historicalDatasetSha256, meta.snapshotVersion, meta.dataVersion,
                meta.snapshotHash, meta.asOfDate.isoformat(), meta.observationsClosedThrough.isoformat(),
                engine_version, json.dumps(period, sort_keys=True, separators=(",", ":"), default=str),
                json.dumps(entity_filter, sort_keys=True, separators=(",", ":"), default=str))

    def build(self, snapshot: V3OperationalSnapshot, *, base_records: Mapping[str, Any],
              request_business_id: str, request_scenario_id: str,
              request_dataset_version: str | None, request_dataset_sha256: str | None,
              request_timezone: str, request_as_of_date: date | None,
              request_body_bytes: int) -> LiveV3Context:
        validate_snapshot(snapshot, base_records=base_records,
                          request_business_id=request_business_id, request_scenario_id=request_scenario_id,
                          request_dataset_version=request_dataset_version, request_dataset_sha256=request_dataset_sha256,
                          request_timezone=request_timezone, request_as_of_date=request_as_of_date,
                          request_body_bytes=request_body_bytes)
        with self._lock:
            return self._build_validated(snapshot, base_records)

    def _build_validated(self, snapshot: V3OperationalSnapshot, base_records: Mapping[str, Any]) -> LiveV3Context:
        boundary = (snapshot.metadata.businessId, snapshot.metadata.scenarioId, snapshot.metadata.dataVersion,
                    snapshot.metadata.asOfDate.isoformat(), snapshot.metadata.observationsClosedThrough.isoformat())
        previous_hash = self._hash_by_boundary.get(boundary)
        if previous_hash is not None and previous_hash != snapshot.metadata.snapshotHash:
            _raise_invalid("Same revision and as-of boundary produced different content.", 409, "SNAPSHOT_VERSION_MISMATCH")
        self._hash_by_boundary[boundary] = snapshot.metadata.snapshotHash
        self._hash_by_boundary.move_to_end(boundary)
        while len(self._hash_by_boundary) > self.max_entries * 4:
            self._hash_by_boundary.popitem(last=False)
        key = self.cache_key(snapshot)
        cached = self._contexts.get(key)
        if cached is not None:
            self._contexts.move_to_end(key)
            return cached

        products: dict[str, Any] = {}
        products_by_sku: dict[str, Any] = {}
        for row in base_records.get("products", ()):
            products[str(row.get("productKey") or row.get("sku"))] = row
            if row.get("sku"):
                products_by_sku[str(row["sku"])] = row
        customers = {str(row.get("customerCode") or row.get("customerKey")): row
                     for row in base_records.get("customers", ()) if row.get("customerCode") or row.get("customerKey")}
        suppliers = {str(row.get("supplierCode") or row.get("supplierKey")): row
                     for row in base_records.get("suppliers", ()) if row.get("supplierCode") or row.get("supplierKey")}
        ordered_catalog = sorted(snapshot.catalogChanges,
                                 key=lambda row: (_as_utc(row.effectiveAtUtc), int(row.revision), row.eventKey))
        for change in ordered_catalog:
            projection = change.projection.after
            if change.entityType == "product":
                before = change.projection.before
                if before is not None and before.sku:
                    products_by_sku.pop(before.sku, None)
                products[projection.productKey] = projection
                if projection.sku:
                    products_by_sku[projection.sku] = projection
            elif change.entityType == "customer":
                customers[projection.entityKey] = projection
            else:
                suppliers[projection.entityKey] = projection
        stock_product = {row.productKey: row.onHand for row in snapshot.stockStates}
        stock_sku = {row.sku: row.onHand for row in snapshot.stockStates if row.sku}
        closed = {(row.productKey, row.localDate): row for row in snapshot.closedSalesDays}
        cancelled = frozenset(row.transactionKey for row in snapshot.transactionChanges if row.kind == "CANCEL")
        received: dict[str, int] = {}
        for change in sorted(snapshot.transactionChanges,
                             key=lambda row: (_as_utc(row.effectiveAtUtc), int(row.revision), row.eventKey)):
            if change.kind == "RECEIVE":
                for line_change in change.lineChanges:
                    received[line_change.lineKey] = received.get(line_change.lineKey, 0) + int(line_change.receivedQty or 0)
        context = LiveV3Context(
            base_records=MappingProxyType(dict(base_records)), snapshot=snapshot,
            context_hash=snapshot.metadata.snapshotHash,
            products_by_key=MappingProxyType(products), products_by_sku=MappingProxyType(products_by_sku),
            customers_by_key=MappingProxyType(customers), suppliers_by_key=MappingProxyType(suppliers),
            stock_by_product_key=MappingProxyType(stock_product), stock_by_sku=MappingProxyType(stock_sku),
            closed_sales_by_product_day=MappingProxyType(closed), cancelled_transaction_keys=cancelled,
            received_by_purchase_line=MappingProxyType(received),
        )
        self._contexts[key] = context
        while len(self._contexts) > self.max_entries:
            self._contexts.popitem(last=False)
        return context


__all__ = ["LiveSnapshotError", "LiveV3Context", "LiveV3ContextStore", "snapshot_hash",
           "validate_snapshot", "SNAPSHOT_MAX_BYTES", "ENGINE_VERSION"]
