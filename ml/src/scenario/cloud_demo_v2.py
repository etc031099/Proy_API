"""Local v2 projection of verified large replay; never imports into Mongo.

Bootstrap movements are retained (not invented opening purchases). Tickets are
projected to the selected lines, payments rebuilt from the existing credit policy,
and all entities re-keyed under v2. No targets or TEST errors enter selection.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
from collections import Counter, defaultdict
from dataclasses import replace
from datetime import date, timedelta

import numpy as np
import pandas as pd

from ml.service.model_runtime import ModelRuntime
from ml.src.common import atomic_write_json, repository_path, sha256_file
from ml.src.inference.demand_v1 import predict_demand7d
from ml.src.m5 import connect_duckdb
from ml.src.scenario.config import load_scenario_config
from ml.src.scenario.generator import deterministic_id, stable_rank
from ml.src.scenario.validation import validate_scenario
from ml.src.serving.build_cloud_demo_lineage import build_cloud_demo_lineage
from ml.src.serving.demand_features import DemandFeatureBuilder

CONFIG = "ml/config/scenario_cloud_demo_v2.toml"
GOLD = "ml/data/gold/demand_features_v1.parquet"


def recommendation(prediction, stock, minimum):
    # Mirrors the frozen Node rule only for local reporting, not serving.
    safety = max(minimum, prediction * .20)
    quantity = math.ceil(max(0, prediction + safety - stock))
    status = "REPONER" if quantity else "VIGILAR" if stock <= prediction * 1.5 else "OK"
    return {"safetyStock": safety, "recommendedQty": quantity, "inventoryStatus": status}


def read_replay(path, anchor):
    events = []
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            event = json.loads(line)
            if event["occurredAt"][:10] <= anchor.isoformat():
                events.append(event)
    cancelled = {e["payload"]["transactionId"] for e in events if e["eventType"] == "transaction.cancelled"}
    # Extra cancellation exercises with a future cancellation are not demand.
    return [e for e in events if not (
        e["eventType"] == "transaction.completed"
        and e["payload"].get("notes", "").startswith("Synthetic cancellation exercise")
        and e["payload"]["_id"] not in cancelled)]


def balances(events, before=None):
    stocks = defaultdict(int)
    transactions = {}
    for event in events:
        if before and event["occurredAt"][:10] >= before.isoformat():
            continue
        payload = event["payload"]
        if event["eventType"] == "transaction.completed":
            transactions[payload["_id"]] = payload
            for line in payload["products"]:
                stocks[line["productId"]] += line["quantity"] * (1 if payload["type"] == "purchase" else -1)
        elif event["eventType"] == "transaction.cancelled":
            transaction = transactions[payload["transactionId"]]
            for line in transaction["products"]:
                stocks[line["productId"]] += line["quantity"] * (1 if transaction["type"] == "sale" else -1)
        if event["eventType"] in ("transaction.completed", "transaction.cancelled") and any(
            stocks[line["productId"]] < 0 for line in payload.get("products", transactions.get(payload.get("transactionId"), {}).get("products", []))
        ):
            raise ValueError("Replay produces negative stock")
    return dict(stocks)


def choose_products(candidates, quotas, seed):
    """Greedy coverage within exact dept quotas; stable hash breaks ties.

    Explicitly preserves available VIGILAR examples. Remaining slots maximize
    coverage of observed status/rotation/demand/price/stock/quantity/coverage bins.
    """
    selected = []
    for dept, count in sorted(quotas.items()):
        pool = [p for p in candidates if p["dept_id"] == dept]
        if len(pool) < count:
            raise ValueError(f"Insufficient eligible products in {dept}")
        order = lambda p: (stable_rank(seed, p["item_id"]), p["item_id"])
        chosen = sorted([p for p in pool if p["inventoryStatus"] == "VIGILAR"], key=order)[:1]
        seen = Counter()
        def tags(p):
            return [(key, p[key]) for key in ("inventoryStatus", "rotation", "demandBand", "priceBand", "stockBand", "quantityBand", "coverageBand", "intermittent")]
        for p in chosen:
            seen.update(tags(p))
        while len(chosen) < count:
            remaining = [p for p in pool if p not in chosen]
            candidate = min(remaining, key=lambda p: (sum(seen[t] for t in tags(p)), *order(p)))
            chosen.append(candidate)
            seen.update(tags(candidate))
        selected.extend(chosen)
    return sorted(selected, key=lambda p: p["item_id"])


def project_events(events, selected, config):
    by_id = {p["originalId"]: p for p in selected}
    products = {e["payload"]["_id"]: e["payload"] for e in events if e["eventType"] == "product.created"}
    retained = []
    transaction_ids = set()
    for original in events:
        event = copy.deepcopy(original)
        payload = event["payload"]
        kind = event["eventType"]
        if kind == "product.created":
            if payload["_id"] not in by_id:
                continue
            row = by_id[payload["_id"]]
            payload["name"] = row["displayName"]
        elif kind == "transaction.completed":
            payload["products"] = [line for line in payload["products"] if line["productId"] in by_id]
            if not payload["products"]:
                continue
            transaction_ids.add(payload["_id"])
            if payload.get("paymentMethod") == "credit":
                # Rebuild payment from retained priced lines, never copy original
                # pooled customer payment amounts after reducing the ticket.
                amount = round(round(sum(products[line["productId"]]["price"] * line["quantity"]
                    for line in payload["products"]), 2) * config.raw["transactions"]["credit_payment_fraction"], 2)
                payment_day = date.fromisoformat(event["occurredAt"][:10]) + timedelta(days=config.raw["transactions"]["credit_payment_delay_days"])
                if amount > 0 and payment_day <= config.operational_end:
                    retained.append({"eventType": "credit-payment.created",
                        "eventId": event["eventId"] + ":projected-payment",
                        "occurredAt": payment_day.isoformat() + "T21:00:00Z",
                        "payload": {"_id": deterministic_id(config.scenario_id, "payment", payload["_id"]),
                            "customerId": payload["customerId"], "amount": amount, "currency": payload["currency"],
                            "paymentMethod": "bank_transfer", "notes": "Synthetic payment recalculated from projected credit lines"}})
        elif kind == "transaction.cancelled":
            if payload["transactionId"] not in transaction_ids:
                continue
        else:
            continue  # Contacts below; original credit payments are not copied.
        event["sourceEventId"] = original["eventId"]
        retained.append(event)
    contact_ids = set()
    for event in retained:
        payload = event["payload"]
        for key in ("vendorId", "customerId", "preferredSupplierId"):
            if payload.get(key):
                contact_ids.add(payload[key])
        contact_ids.update(row["supplierId"] for row in payload.get("supplierPrices", []))
    retained.extend(copy.deepcopy(e) for e in events if e["eventType"] == "contact.created" and e["payload"]["_id"] in contact_ids)
    ids = {e["payload"]["_id"] for e in retained if "_id" in e["payload"]}
    mapping = {old: deterministic_id(config.scenario_id, "entity", old) for old in ids}
    def remap(value):
        if isinstance(value, dict):
            return {key: remap(item) for key, item in value.items()}
        if isinstance(value, list):
            return [remap(item) for item in value]
        return mapping.get(value, value) if isinstance(value, str) else value
    for event in retained:
        event["payload"] = remap(event["payload"])
        event["eventId"] = config.scenario_id + ":projection:" + stable_rank(config.seed, event["eventId"])
        event["scenarioId"] = config.scenario_id
    return sorted(retained, key=lambda e: (e["occurredAt"], e["eventId"])), mapping


def describe(rows, name):
    values = [row[name] for row in rows]
    return {"min": float(min(values)), "max": float(max(values)), "median": float(np.median(values)), "total": float(sum(values))}


def generate(config_path=CONFIG):
    config = load_scenario_config(config_path)
    if (config.scenario_id, config.source_store, config.source_start, config.source_end, config.operational_offset_days, config.seed, config.product_count) != (
        "m5-ca3-cloud-demo-v2", "CA_3", date(2015, 11, 1), date(2016, 5, 15), 3654, 2026, 60):
        raise ValueError("Unexpected v2 scenario contract")
    settings = config.raw["v2"]
    source_manifest_path = repository_path(settings["source_scenario_manifest"])
    source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    source_config = load_scenario_config(settings["source_scenario_config"])
    if (source_manifest["config_sha256"] != source_config.config_hash
            or source_manifest["scenarioId"] != source_config.scenario_id
            or source_manifest["selected_store"] != config.source_store
            or settings["business_id"] != "ML-CLOUD-DEMO-V2"
            or source_config.operational_offset_days != config.operational_offset_days):
        raise ValueError("Source scenario/configuration identity mismatch")
    for section in ("inventory", "pricing", "margins", "transactions", "payment_methods"):
        if config.raw[section] != source_config.raw[section]:
            raise ValueError(f"V2 must preserve existing source {section} policy")
    source_file = repository_path(source_manifest["ndjson"])
    if sha256_file(source_file) != source_manifest["ndjson_sha256"] or sha256_file(config.bronze) != source_manifest["source_bronze_sha256"]:
        raise ValueError("Source replay/Bronze hash mismatch")
    report_path = config.manifest.with_name("scenario_cloud_demo_v2_validation.json")
    lineage_dir = repository_path(settings["lineage_directory"])
    if any(p.exists() for p in (config.output, config.manifest, report_path, lineage_dir)):
        raise FileExistsError("V2 outputs already exist; no implicit overwrite")
    runtime = ModelRuntime()
    runtime.load()  # Official SHA-256 and size checked before joblib loading.
    events = read_replay(source_file, config.operational_end)
    stock = balances(events)
    original_opening = balances(events, config.operational_start)
    product_events = {e["payload"]["sku"][3:]: e["payload"] for e in events if e["eventType"] == "product.created"}
    connection = connect_duckdb()
    try:
        # Aggregate only observed history <= anchor. Gold targets/split are never
        # selected: model inference/strata use exactly contract feature columns.
        stats = connection.execute("""SELECT item_id, min(cat_id) cat_id, min(dept_id) dept_id,
            sum(units_sold) units, avg(units_sold) mean_units,
            count_if(units_sold > 0)::DOUBLE/count(*) positive_ratio,
            median(sell_price) FILTER(WHERE sell_price > 0) price
            FROM read_parquet(?) WHERE store_id=? AND source_date BETWEEN ? AND ?
            GROUP BY item_id HAVING sum(units_sold)>0 AND price>0""",
            [str(config.bronze), config.source_store, config.source_start, config.source_end]).fetch_df()
        names = ["item_id", *runtime.contract["feature_order"]]
        columns = ','.join('"' + name + '"' for name in names)
        gold = connection.execute(f"SELECT {columns} FROM read_parquet(?) WHERE source_date=?",
            [str(repository_path(GOLD)), config.source_end]).fetch_df()
        frame = stats.merge(gold, on=["item_id", "cat_id", "dept_id"])
        active_dates = dict(connection.execute("SELECT item_id,min(source_date) FILTER(WHERE sell_price IS NOT NULL) FROM read_parquet(?) GROUP BY item_id", [str(config.bronze)]).fetchall())
        frame = frame[frame.item_id.isin(product_events)].copy()
        frame["predictedDemand7d"] = predict_demand7d(runtime.pipeline, frame[runtime.contract["feature_order"]], runtime.contract)
        for column, label in [("mean_units", "rotation"), ("price", "priceBand"), ("predictedDemand7d", "demandBand")]:
            ordered = frame.sort_values([column, "item_id"])
            bands = {item: ("low", "medium", "high")[min(2, index * 3 // len(frame))] for index, item in enumerate(ordered.item_id)}
            frame[label] = frame.item_id.map(bands)
        candidates = []
        for row in frame.to_dict("records"):
            product = product_events[row["item_id"]]
            # Only existing products introduced before the complete serving window.
            active = active_dates[row["item_id"]]
            if active > config.source_start:
                continue
            row.update(originalId=product["_id"], stock=stock[product["_id"]], minStockLevel=product["minStockLevel"], intermittent=row["positive_ratio"] < .20)
            row.update(recommendation(row["predictedDemand7d"], row["stock"], row["minStockLevel"]))
            row["stockBand"] = "critical" if row["stock"] <= row["minStockLevel"] else "healthy"
            row["quantityBand"] = "none" if row["recommendedQty"] == 0 else "moderate" if row["recommendedQty"] <= 20 else "high"
            ratio = row["stock"] / row["predictedDemand7d"] if row["predictedDemand7d"] else float('inf')
            row["coverageBand"] = "below_demand" if ratio < 1 else "close" if ratio <= 1.5 else "above"
            category = {"FOODS": "Alimentos", "HOBBIES": "Hobbies", "HOUSEHOLD": "Hogar"}[row["cat_id"]]
            row["displayName"] = f"{category} M5 · {row['dept_id']} · Ítem {row['item_id'].rsplit('_', 1)[1]}"
            candidates.append({key: value for key, value in row.items() if key not in runtime.contract["feature_order"] or key in ("cat_id", "dept_id")})
        selected = choose_products(candidates, config.raw["selection"]["department_quotas"], config.seed)
        projected, mapping = project_events(events, selected, config)
        config.output.parent.mkdir(parents=True, exist_ok=True)
        with config.output.open("x", encoding="utf-8", newline="\n") as stream:
            for event in projected:
                stream.write(json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
        # Validate all bootstrap+window demand, not merely the latest window.
        replay_config = replace(config, source_start=date.fromisoformat(source_manifest["source_date_range"][0]))
        validation = validate_scenario(replay_config, selected)
        opening = balances(projected, config.operational_start)
        final = balances(projected)
        for row in selected:
            row["productId"] = mapping[row["originalId"]]
            if final[row["productId"]] != row["stock"] or opening.get(row["productId"], 0) != original_opening.get(row["originalId"], 0):
                raise ValueError("Projected stock differs from source movements")
            row["openingStock"] = opening.get(row["productId"], 0)
        counts = Counter()
        for e in projected:
            if e["eventType"] == "transaction.completed":
                counts[e["payload"]["type"] + "s"] += 1
                if e["occurredAt"][:10] >= config.operational_start.isoformat():
                    counts["window_" + e["payload"]["type"] + "s"] += 1
                if e["occurredAt"][:4] == "2026":
                    counts["transactions_2026"] += 1
            else:
                counts[e["eventType"]] += 1
        manifest = {"scenarioId": config.scenario_id, "businessId": settings["business_id"], "seed": config.seed,
            "selected_store": config.source_store, "source_date_range": [config.source_start.isoformat(), config.source_end.isoformat()],
            "operational_date_range": [config.operational_start.isoformat(), config.operational_end.isoformat()],
            "replay_source_start": replay_config.source_start.isoformat(), "bootstrap_policy": "Preserve original prior movements; openingStock is their net balance, not a new purchase",
            "selected_products": [r["item_id"] for r in selected], "products": selected,
            "counts": {**counts, "products": len(selected), "transactions": counts["sales"] + counts["purchases"]},
            "ndjson": config.output.relative_to(repository_path('.')).as_posix(), "ndjson_sha256": sha256_file(config.output),
            "source_replay_sha256": source_manifest["ndjson_sha256"], "source_manifest_sha256": sha256_file(source_manifest_path),
            "source_bronze_sha256": sha256_file(config.bronze), "config_sha256": config.config_hash,
            "model_sha256": runtime.joblib_sha256, "validation": validation,
            "selection_policy": "Exact department quotas; observed diversity coverage; stable seed/item hash; no targets or TEST errors"}
        atomic_write_json(config.manifest, manifest)
        lineage = build_cloud_demo_lineage(config_path, config.manifest, output_directory=lineage_dir,
            expected_scenario_id=config.scenario_id, business_id=settings["business_id"], lineage_version="cloud-demo-lineage-v2")
        builder = DemandFeatureBuilder(lineage_dir / "cloud_demo_lineage_manifest.json",
            expected_business_id=settings["business_id"], expected_scenario_id=config.scenario_id)
        parity = validate_features(connection, config, projected, selected, builder, runtime)
        report = {"scenarioId": config.scenario_id, "businessId": settings["business_id"], "parity": parity,
            "departments": dict(Counter(r["dept_id"] for r in selected)),
            "states": dict(Counter(r["inventoryStatus"] for r in selected)),
            "rotation": dict(Counter(r["rotation"] for r in selected)), "priceBands": dict(Counter(r["priceBand"] for r in selected)),
            "intermittent": sum(r["intermittent"] for r in selected),
            "salesUnitsByDepartment": {d: int(sum(r["units"] for r in selected if r["dept_id"] == d)) for d in config.raw["selection"]["department_quotas"]},
            "prediction": describe(selected, "predictedDemand7d"), "replenishment": describe(selected, "recommendedQty"),
            "stock": describe(selected, "stock"), "priceUsd": describe(selected, "price"),
            "lineage_sha256": sha256_file(lineage_dir / "cloud_demo_lineage_manifest.json"), "counts": manifest["counts"],
            "not_accuracy_evaluation": True}
        atomic_write_json(report_path, report)
        return report
    finally:
        connection.close()


def validate_features(connection, config, events, selected, builder, runtime):
    demand = defaultdict(Counter)
    by_id = {r["productId"]: r["item_id"] for r in selected}
    for event in events:
        p = event["payload"]
        if event["eventType"] == "transaction.completed" and p["type"] == "sale" and p.get("notes", "").startswith("M5 demand; source_date="):
            for line in p["products"]:
                demand[by_id[line["productId"]]][event["occurredAt"][:10]] += line["quantity"]
    categorical = {r["name"] for r in runtime.contract["features"] if r["type"] == "categorical"}
    frames = []
    for row in selected:
        days = (config.operational_end - config.operational_start).days + 1
        history = [{"date": (config.operational_start + timedelta(days=i)).isoformat(),
            "unitsSold": demand[row["item_id"]][(config.operational_start + timedelta(days=i)).isoformat()]} for i in range(days)]
        actual = builder.build("M5-" + row["item_id"], config.operational_end, history,
            business_id=config.raw["v2"]["business_id"], scenario_id=config.scenario_id)
        expected = connection.execute("SELECT * FROM read_parquet(?) WHERE item_id=? AND source_date=?",
            [str(repository_path(GOLD)), row["item_id"], config.source_end]).fetch_df()
        if len(expected) != 1 or actual.status != "READY" or list(actual.features.columns) != runtime.contract["feature_order"]:
            raise ValueError(f"Invalid feature row for {row['item_id']}")
        for name in runtime.contract["feature_order"]:
            a, b = actual.features.iloc[0][name], expected.iloc[0][name]
            equal = (pd.isna(a) and pd.isna(b)) or (a == b if name in categorical else math.isclose(float(a), float(b), rel_tol=1e-5, abs_tol=1e-5))
            if not equal:
                raise ValueError(f"Parity: SKU=M5-{row['item_id']} feature={name} Gold={b!r} serving={a!r}")
        frames.append(actual.features)
    values = predict_demand7d(runtime.pipeline, pd.concat(frames, ignore_index=True), runtime.contract)
    for row, value in zip(selected, values):
        if not math.isclose(row["predictedDemand7d"], float(value), rel_tol=1e-5, abs_tol=1e-5):
            raise ValueError(f"Prediction parity failed for {row['item_id']}")
    return {"ready": len(frames), "features": 31, "comparisons": len(frames) * 31, "differences": 0, "tolerance": 1e-5}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=CONFIG)
    print(json.dumps(generate(parser.parse_args().config), indent=2, ensure_ascii=False))
