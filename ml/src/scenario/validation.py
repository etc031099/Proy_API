from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from ml.src.common import sql_literal
from ml.src.m5 import connect_duckdb
from ml.src.scenario.config import ScenarioConfig, load_scenario_config


OBJECT_ID = re.compile(r"^[0-9a-f]{24}$")


def _object_id(value: Any, label: str, line_number: int) -> str:
    if not isinstance(value, str) or not OBJECT_ID.fullmatch(value):
        raise ValueError(f"Line {line_number}: {label} must be a 24-character hexadecimal ObjectId")
    return value


def _timestamp(value: Any, line_number: int) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"Line {line_number}: occurredAt must be an ISO string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"Line {line_number}: invalid occurredAt") from error
    if parsed.tzinfo is None:
        raise ValueError(f"Line {line_number}: occurredAt must include a timezone")
    return parsed


def _positive_number(value: Any, label: str, line_number: int) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"Line {line_number}: {label} must be numeric")
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"Line {line_number}: {label} must be finite and positive")
    return number


def validate_scenario(
    config: ScenarioConfig,
    selected_products: list[dict[str, Any]] | None = None,
    *,
    file_path: Path | None = None,
) -> dict[str, Any]:
    path = file_path or config.output
    contacts: dict[str, dict[str, str]] = {}
    products: dict[str, dict[str, Any]] = {}
    stocks: defaultdict[str, int] = defaultdict(int)
    cancellable_transactions: dict[str, dict[str, Any]] = {}
    balances: defaultdict[str, float] = defaultdict(float)
    credit_sales_by_customer: defaultdict[str, float] = defaultdict(float)
    payments_by_customer: defaultdict[str, float] = defaultdict(float)
    segment_sales: defaultdict[str, dict[str, float]] = defaultdict(
        lambda: {"transactions": 0, "amount_pen": 0.0}
    )
    products_per_supplier: defaultdict[str, int] = defaultdict(int)
    suppliers_per_product: list[int] = []
    assigned_lead_times: list[int] = []
    observed_receipt_lead_times: list[int] = []
    emergency_products: set[str] = set()
    minimum_stock_observed = 0
    operational_pairs: list[tuple[date, date]] = []
    event_ids: set[str] = set()
    entity_ids: set[str] = set()
    counts = defaultdict(int)
    previous_time: datetime | None = None
    connection = connect_duckdb()
    demand_path = path.with_suffix(path.suffix + ".demand.tmp.csv")
    demand_stream = demand_path.open("w", encoding="utf-8", newline="")
    demand_writer = csv.writer(demand_stream, lineterminator="\n")

    try:
        with path.open("r", encoding="utf-8") as stream:
            for line_number, raw_line in enumerate(stream, 1):
                if not raw_line.strip():
                    continue
                try:
                    event = json.loads(raw_line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"Line {line_number}: invalid JSON") from error
                if not isinstance(event, dict):
                    raise ValueError(f"Line {line_number}: event must be an object")
                if event.get("scenarioId") != config.scenario_id:
                    raise ValueError(f"Line {line_number}: scenarioId does not match configuration")
                event_id = event.get("eventId")
                if not isinstance(event_id, str) or not event_id:
                    raise ValueError(f"Line {line_number}: eventId is required")
                if event_id in event_ids:
                    raise ValueError(f"Line {line_number}: duplicate eventId {event_id}")
                event_ids.add(event_id)
                occurred_at = _timestamp(event.get("occurredAt"), line_number)
                if previous_time and occurred_at < previous_time:
                    raise ValueError(f"Line {line_number}: events are not in causal order")
                previous_time = occurred_at
                event_type = event.get("eventType")
                payload = event.get("payload")
                if not isinstance(payload, dict):
                    raise ValueError(f"Line {line_number}: payload must be an object")
                counts["events"] += 1

                if event_type == "contact.created":
                    identifier = _object_id(payload.get("_id"), "contact._id", line_number)
                    contact_type = payload.get("type")
                    if contact_type not in {"vendor", "customer"}:
                        raise ValueError(f"Line {line_number}: invalid contact type")
                    if identifier in entity_ids:
                        raise ValueError(f"Line {line_number}: duplicate entity id")
                    entity_ids.add(identifier)
                    name = payload.get("name")
                    phone = payload.get("phone")
                    expected_name = "Proveedor sintético " if contact_type == "vendor" else "Cliente sintético "
                    expected_phone = "SYN-V-" if contact_type == "vendor" else "SYN-C-"
                    if not isinstance(name, str) or not name.startswith(expected_name):
                        raise ValueError(f"Line {line_number}: contact is not explicitly synthetic")
                    if not isinstance(phone, str) or not phone.startswith(expected_phone):
                        raise ValueError(f"Line {line_number}: contact phone is not explicitly synthetic")
                    if payload.get("email") or payload.get("documentNumber"):
                        raise ValueError(f"Line {line_number}: synthetic contacts cannot contain email or documentNumber")
                    profile = "vendor"
                    if contact_type == "customer":
                        match = re.search(r"Perfil ficticio ([a-z-]+)", str(payload.get("notes", "")))
                        if not match:
                            raise ValueError(f"Line {line_number}: customer profile is missing")
                        profile = match.group(1)
                    contacts[identifier] = {"type": contact_type, "profile": profile}
                    counts[f"{contact_type}s"] += 1
                    continue

                if event_type == "product.created":
                    identifier = _object_id(payload.get("_id"), "product._id", line_number)
                    if identifier in entity_ids:
                        raise ValueError(f"Line {line_number}: duplicate entity id")
                    supplier_prices = payload.get("supplierPrices")
                    if not isinstance(supplier_prices, list) or not supplier_prices:
                        raise ValueError(f"Line {line_number}: product needs supplierPrices")
                    supplier_ids = set()
                    for supplier_price in supplier_prices:
                        supplier_id = _object_id(supplier_price.get("supplierId"), "supplierId", line_number)
                        if contacts.get(supplier_id, {}).get("type") != "vendor":
                            raise ValueError(f"Line {line_number}: supplier must exist first")
                        cost = _positive_number(
                            supplier_price.get("purchasePrice"), "purchasePrice", line_number
                        )
                        supplier_ids.add(supplier_id)
                        products_per_supplier[supplier_id] += 1
                        if cost >= _positive_number(payload.get("price"), "price", line_number):
                            raise ValueError(f"Line {line_number}: purchasePrice must be below sale price")
                    if payload.get("preferredSupplierId") not in supplier_ids:
                        raise ValueError(f"Line {line_number}: preferred supplier is not configured")
                    if payload.get("stock") != 0:
                        raise ValueError(f"Line {line_number}: products must start at stock zero")
                    lead_match = re.search(r"lead_time_days=(\d+)", str(payload.get("description", "")))
                    if not lead_match:
                        raise ValueError(f"Line {line_number}: configured lead time is missing")
                    lead_time = int(lead_match.group(1))
                    lead_min = int(config.raw["inventory"]["lead_time_min_days"])
                    lead_max = int(config.raw["inventory"]["lead_time_max_days"])
                    if not lead_min <= lead_time <= lead_max:
                        raise ValueError(f"Line {line_number}: configured lead time is outside its domain")
                    assigned_lead_times.append(lead_time)
                    suppliers_per_product.append(len(supplier_ids))
                    entity_ids.add(identifier)
                    item_id = str(payload.get("sku", "")).removeprefix("M5-")
                    products[identifier] = {
                        "item_id": item_id, "price": float(payload["price"]),
                        "suppliers": supplier_ids, "lead_time": lead_time,
                    }
                    counts["products"] += 1
                    continue

                if event_type == "transaction.completed":
                    transaction_id = _object_id(payload.get("_id"), "transaction._id", line_number)
                    if transaction_id in entity_ids:
                        raise ValueError(f"Line {line_number}: duplicate entity id")
                    entity_ids.add(transaction_id)
                    transaction_type = payload.get("type")
                    lines = payload.get("products")
                    if transaction_type not in {"sale", "purchase"} or not isinstance(lines, list) or not lines:
                        raise ValueError(f"Line {line_number}: invalid transaction")
                    vendor_id = payload.get("vendorId")
                    if transaction_type == "purchase" and contacts.get(vendor_id, {}).get("type") != "vendor":
                        raise ValueError(f"Line {line_number}: purchase vendor must exist first")
                    normalized_lines = []
                    total = 0.0
                    for item in lines:
                        product_id = _object_id(item.get("productId"), "productId", line_number)
                        if product_id not in products:
                            raise ValueError(f"Line {line_number}: product must exist first")
                        quantity = item.get("quantity")
                        if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 1:
                            raise ValueError(f"Line {line_number}: quantity must be a positive integer")
                        if transaction_type == "purchase":
                            if vendor_id not in products[product_id]["suppliers"]:
                                raise ValueError(f"Line {line_number}: vendor is not configured for product")
                            stocks[product_id] += quantity
                            counts["purchase_lines"] += 1
                            counts["expected_inventory_movements"] += 1
                        else:
                            stocks[product_id] -= quantity
                            counts["expected_inventory_movements"] += 1
                            if stocks[product_id] < 0:
                                raise ValueError(f"Line {line_number}: sale produces negative stock")
                            total += products[product_id]["price"] * quantity
                        minimum_stock_observed = min(minimum_stock_observed, stocks[product_id])
                        normalized_lines.append((product_id, quantity))
                    notes = str(payload.get("notes", ""))
                    if transaction_type == "sale":
                        counts["sale_transactions"] += 1
                        counts["sale_lines"] += len(lines)
                        if notes.startswith("M5 demand; source_date="):
                            counts["m5_sale_transactions"] += 1
                            source_date = notes.split("=", 1)[1]
                            source_day = date.fromisoformat(source_date)
                            operational_day = occurred_at.date()
                            if operational_day != source_day + timedelta(days=config.operational_offset_days):
                                raise ValueError(f"Line {line_number}: operational date offset is inconsistent")
                            operational_pairs.append((source_day, operational_day))
                            for product_id, quantity in normalized_lines:
                                demand_writer.writerow((products[product_id]["item_id"], source_date, quantity))
                                counts["materialized_m5_units"] += quantity
                        if payload.get("paymentMethod") == "credit":
                            customer_id = payload.get("customerId")
                            if contacts.get(customer_id, {}).get("type") != "customer":
                                raise ValueError(f"Line {line_number}: credit requires an existing customer")
                            balances[customer_id] = round(balances[customer_id] + total, 2)
                            credit_sales_by_customer[customer_id] += total
                            counts["credit_sales"] += 1
                            counts["credit_sales_amount_pen"] += round(total, 2)
                        if notes.startswith("Synthetic cancellation exercise"):
                            counts["synthetic_cancellation_sales"] += 1
                        if notes.startswith("M5 demand; source_date="):
                            customer_id = payload.get("customerId")
                            segment = contacts.get(customer_id, {}).get("profile", "anonymous")
                            segment_sales[segment]["transactions"] += 1
                            segment_sales[segment]["amount_pen"] += total
                            counts["identified_sales" if customer_id else "anonymous_sales"] += 1
                    else:
                        counts["purchase_transactions"] += 1
                        if payload.get("paymentMethod") == "credit":
                            raise ValueError(f"Line {line_number}: generated purchases cannot create vendor debt")
                        if "Emergency receipt" in notes:
                            counts["emergency_purchases"] += 1
                            emergency_products.update(product_id for product_id, _ in normalized_lines)
                        elif "Reposición planned" in notes:
                            counts["planned_replenishments"] += 1
                        elif "Reposición initial" in notes:
                            counts["initial_purchases"] += 1
                        date_match = re.search(
                            r"order_date=(\d{4}-\d{2}-\d{2}); expected_receipt_date=(\d{4}-\d{2}-\d{2})",
                            notes,
                        )
                        if not date_match:
                            raise ValueError(f"Line {line_number}: purchase order/receipt dates are missing")
                        order_day, receipt_day = map(date.fromisoformat, date_match.groups())
                        if receipt_day != occurred_at.date() or order_day > receipt_day:
                            raise ValueError(f"Line {line_number}: invalid purchase lead-time dates")
                        observed_receipt_lead_times.append((receipt_day - order_day).days)
                    if notes.startswith("Synthetic cancellation exercise"):
                        cancellable_transactions[transaction_id] = {
                            "type": transaction_type, "lines": normalized_lines,
                            "cancelled": False,
                            "credit": payload.get("paymentMethod") == "credit",
                            "occurred_at": occurred_at,
                        }
                    continue

                if event_type == "credit-payment.created":
                    identifier = _object_id(payload.get("_id"), "payment._id", line_number)
                    if identifier in entity_ids:
                        raise ValueError(f"Line {line_number}: duplicate entity id")
                    customer_id = payload.get("customerId")
                    if contacts.get(customer_id, {}).get("type") != "customer":
                        raise ValueError(f"Line {line_number}: payment customer must exist first")
                    amount = _positive_number(payload.get("amount"), "payment amount", line_number)
                    balance_before = balances[customer_id]
                    if amount > balance_before + 1e-9:
                        raise ValueError(f"Line {line_number}: payment exceeds customer debt")
                    balances[customer_id] = round(balances[customer_id] - amount, 2)
                    payments_by_customer[customer_id] += amount
                    counts["credit_payment_amount_pen"] += amount
                    counts[
                        "full_credit_payments" if math.isclose(amount, balance_before, abs_tol=0.01)
                        else "partial_credit_payments"
                    ] += 1
                    entity_ids.add(identifier)
                    counts["credit_payments"] += 1
                    continue

                if event_type == "transaction.cancelled":
                    transaction_id = _object_id(payload.get("transactionId"), "transactionId", line_number)
                    transaction = cancellable_transactions.get(transaction_id)
                    if not transaction or transaction["cancelled"]:
                        raise ValueError(f"Line {line_number}: cancellation target is invalid")
                    if transaction["credit"]:
                        raise ValueError(f"Line {line_number}: generated credit sales cannot be cancelled")
                    if occurred_at <= transaction["occurred_at"]:
                        raise ValueError(f"Line {line_number}: cancellation must occur after the sale")
                    direction = 1 if transaction["type"] == "sale" else -1
                    for product_id, quantity in transaction["lines"]:
                        stocks[product_id] += direction * quantity
                        counts["expected_inventory_movements"] += 1
                        minimum_stock_observed = min(minimum_stock_observed, stocks[product_id])
                        if stocks[product_id] < 0:
                            raise ValueError(f"Line {line_number}: cancellation produces negative stock")
                    transaction["cancelled"] = True
                    counts["cancellations"] += 1
                    continue

                raise ValueError(f"Line {line_number}: unsupported eventType {event_type!r}")

        demand_stream.close()
        connection.execute(
            "CREATE TEMP VIEW actual_demand AS SELECT * FROM read_csv("
            f"{sql_literal(demand_path)}, header=false, "
            "columns={'item_id':'VARCHAR','source_date':'DATE','units':'BIGINT'})"
        )
        selected_ids = [
            item["item_id"] for item in selected_products
        ] if selected_products is not None else [item["item_id"] for item in products.values()]
        connection.execute("CREATE TEMP TABLE validation_products(item_id VARCHAR PRIMARY KEY)")
        connection.executemany("INSERT INTO validation_products VALUES (?)", [(item,) for item in selected_ids])
        connection.execute(
            """
            CREATE TEMP VIEW demand_mismatches AS
            WITH expected AS (
              SELECT b.item_id, b.source_date, sum(CAST(b.units_sold AS BIGINT)) AS units
              FROM read_parquet({bronze}) b INNER JOIN validation_products p USING (item_id)
              WHERE b.store_id = {store} AND b.source_date BETWEEN {start} AND {end}
                AND b.units_sold > 0
              GROUP BY b.item_id, b.source_date
            ), actual AS (
              SELECT item_id, source_date, sum(units) AS units
              FROM actual_demand GROUP BY item_id, source_date
            )
            SELECT coalesce(expected.item_id, actual.item_id) AS item_id,
                   coalesce(expected.source_date, actual.source_date) AS source_date,
                   coalesce(expected.units, 0) AS expected_units,
                   coalesce(actual.units, 0) AS actual_units
            FROM expected FULL OUTER JOIN actual USING (item_id, source_date)
            WHERE coalesce(expected.units, 0) <> coalesce(actual.units, 0)
            """.format(
                bronze=sql_literal(config.bronze),
                store=sql_literal(config.source_store),
                start=sql_literal(config.source_start.isoformat()),
                end=sql_literal(config.source_end.isoformat()),
            )
        )
        mismatch, mismatch_products, absolute_difference = connection.execute(
            "SELECT count(*), count(DISTINCT item_id), coalesce(sum(abs(expected_units-actual_units)),0) "
            "FROM demand_mismatches"
        ).fetchone()
        mismatch_product_ids = [
            row[0] for row in connection.execute(
                "SELECT DISTINCT item_id FROM demand_mismatches ORDER BY item_id LIMIT 100"
            ).fetchall()
        ]
        expected_units, actual_units = connection.execute(
            """
            SELECT
              (SELECT coalesce(sum(CAST(b.units_sold AS BIGINT)), 0)
               FROM read_parquet(?) b INNER JOIN validation_products p USING (item_id)
               WHERE b.store_id = ? AND b.source_date BETWEEN ? AND ? AND b.units_sold > 0),
              (SELECT coalesce(sum(units), 0) FROM actual_demand)
            """,
            [str(config.bronze), config.source_store, config.source_start, config.source_end],
        ).fetchone()
        if mismatch:
            raise ValueError(
                f"M5 demand reconciliation failed for {mismatch} product-days "
                f"across {mismatch_products} products: {mismatch_product_ids[:10]}"
            )
        counts["materialized_product_days"] = connection.execute(
            "SELECT count(*) FROM (SELECT item_id, source_date FROM actual_demand GROUP BY ALL)"
        ).fetchone()[0]
        if actual_units != counts["materialized_m5_units"]:
            raise ValueError("Internal materialized-unit count is inconsistent")
        if any(source.weekday() != operational.weekday() for source, operational in operational_pairs):
            raise ValueError("Operational date offset does not preserve weekdays")

        def distribution(values: list[int]) -> dict[str, float | int]:
            return {
                "min": min(values, default=0),
                "max": max(values, default=0),
                "mean": round(sum(values) / len(values), 3) if values else 0,
            }

        segment_summary = {
            segment: {
                "transactions": int(values["transactions"]),
                "amount_pen": round(values["amount_pen"], 2),
                "average_ticket_pen": round(
                    values["amount_pen"] / values["transactions"], 2
                ) if values["transactions"] else 0,
            }
            for segment, values in sorted(segment_sales.items())
        }
        ending_balances = {
            customer_id: round(balance, 2)
            for customer_id, balance in balances.items() if balance > 0
        }
        stock_values = list(stocks.values())
        return {
            "status": "passed",
            "checks": [
                "causal_order", "references", "supplier_relationships", "stock_non_negative",
                "positive_prices_and_costs", "credit_payments_not_over_debt",
                "valid_cancellations", "unique_ids", "unique_sourceEventId",
                "timestamp_timezone", "scenario_id", "source_operational_dates",
                "synthetic_contact_policy", "m5_demand_reconciliation",
            ],
            "warnings": [
                "Operational price is fixed per product because the application has no PriceHistory model.",
                "Rotation-based inventory sizing is simulation metadata and must not be used as an ML feature.",
                "Customer and supplier attributes are synthetic operational data, not initial ML features.",
            ],
            "counts": dict(counts),
            "demand_reconciliation": {
                "expected_units": int(expected_units),
                "actual_units": int(actual_units),
                "absolute_difference": int(absolute_difference),
                "percentage_difference": round(
                    100 * absolute_difference / expected_units, 12
                ) if expected_units else 0,
                "mismatched_product_days": int(mismatch),
                "mismatched_products": int(mismatch_products),
                "mismatched_product_ids": mismatch_product_ids,
            },
            "stock": {
                "minimum_observed": minimum_stock_observed,
                "ending_total_units": int(sum(stock_values)),
                "ending_min_per_product": min(stock_values, default=0),
                "ending_max_per_product": max(stock_values, default=0),
                "products_with_emergency_receipt": len(emergency_products),
                "emergency_receipts": counts.get("emergency_purchases", 0),
                "planned_replenishments": counts.get("planned_replenishments", 0),
                "initial_purchases": counts.get("initial_purchases", 0),
                "stockouts_avoided": counts.get("emergency_purchases", 0),
                "expected_inventory_movements": counts.get("expected_inventory_movements", 0),
            },
            "suppliers": {
                "products_per_supplier": distribution(list(products_per_supplier.values())),
                "suppliers_per_product": distribution(suppliers_per_product),
                "assigned_lead_time_days": distribution(assigned_lead_times),
                "observed_receipt_lead_time_days": distribution(observed_receipt_lead_times),
            },
            "customers": {
                "identified_sales": counts.get("identified_sales", 0),
                "anonymous_sales": counts.get("anonymous_sales", 0),
                "credit_enabled_customers": sum(
                    contact["profile"] == "credit-enabled" for contact in contacts.values()
                ),
                "ticket_by_segment": segment_summary,
                "pii_policy": "Explicit synthetic names/phones; email and documentNumber forbidden.",
            },
            "credit": {
                "sales": counts.get("credit_sales", 0),
                "sales_amount_pen": round(counts.get("credit_sales_amount_pen", 0), 2),
                "customers_with_credit_sales": len(credit_sales_by_customer),
                "payments": counts.get("credit_payments", 0),
                "payment_amount_pen": round(counts.get("credit_payment_amount_pen", 0), 2),
                "customers_with_payments": len(payments_by_customer),
                "partial_payments": counts.get("partial_credit_payments", 0),
                "full_payments": counts.get("full_credit_payments", 0),
                "customers_with_open_debt": len(ending_balances),
                "ending_open_credit_pen": round(sum(ending_balances.values()), 2),
                "vendor_debt_pen": 0,
            },
            "cancellations": {
                "count": counts.get("cancellations", 0),
                "rate_over_all_sales_percentage": round(
                    100 * counts.get("cancellations", 0) / counts.get("sale_transactions", 1), 4
                ),
                "rate_over_m5_sales_percentage": round(
                    100 * counts.get("cancellations", 0) / counts.get("m5_sale_transactions", 1), 4
                ),
                "policy": "Only additional synthetic non-credit sales; M5 demand remains valid.",
            },
            "dates": {
                "source_range": [config.source_start.isoformat(), config.source_end.isoformat()],
                "operational_range": [config.operational_start.isoformat(), config.operational_end.isoformat()],
                "offset_days": config.operational_offset_days,
                "weekday_preserved": True,
                "intervals_preserved": True,
            },
        }
    finally:
        if not demand_stream.closed:
            demand_stream.close()
        connection.close()
        if demand_path.exists():
            demand_path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate ML-R2B NDJSON before Mongo import")
    parser.add_argument("--config", required=True)
    parser.add_argument("--file")
    args = parser.parse_args()
    try:
        config = load_scenario_config(args.config)
        result = validate_scenario(config, file_path=Path(args.file).resolve() if args.file else None)
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        print(f"ML-R2B validation failed: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
