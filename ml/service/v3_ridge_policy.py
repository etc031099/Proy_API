"""Frozen M6.10A22-PROMOTION-v1, evaluated on chronological Ridge/MA28 pairs."""
from __future__ import annotations

import hashlib
import json
import math
import statistics
from datetime import date, timedelta
from pathlib import Path

POLICY_VERSION = "M6.10A22-PROMOTION-v1"
POLICY_HASH = "522a2af4ec30f83b016d7c9bc8886e775f1871a4bb9469963648e5539e25cdc3"
POLICY_PATH = Path(__file__).with_name("forecast_promotion_policy_v1.json")
CUTOFF = date(2026, 10, 12)
FOLD_LENGTHS = (31, 30, 46)


class PolicyError(Exception):
    code = "POLICY_COMPUTATION_FAILED"


def load_policy():
    raw = POLICY_PATH.read_bytes()
    if hashlib.sha256(raw).hexdigest() != POLICY_HASH:
        raise PolicyError("Frozen policy hash mismatch")
    policy = json.loads(raw)
    if policy["id"] != POLICY_VERSION:
        raise PolicyError("Frozen policy version mismatch")
    return policy


def temporal_protocol(closed: date, horizon: int) -> dict:
    if horizon not in (7, 14):
        raise PolicyError("MODEL_NOT_APPROVED")
    latest = closed - timedelta(days=horizon)
    count = max(0, (latest - CUTOFF).days + 1)
    base = {"protocolVersion": "M6.10A23-ROLLING107-v1", "horizonDays": horizon,
            "observationsClosedThrough": closed.isoformat(), "latestMatureOrigin": latest.isoformat(),
            "availableOrigins": count, "requiredOrigins": 107, "foldLengths": list(FOLD_LENGTHS)}
    if count < 107:
        return {**base, "status": "INSUFFICIENT_EVALUATION_HISTORY", "folds": []}
    start = latest - timedelta(days=106)
    folds = []
    for name, length in zip(("F2", "F3", "VALIDATION"), FOLD_LENGTHS):
        end = start + timedelta(days=length - 1)
        folds.append({"split": name, "startOrigin": start.isoformat(), "endOrigin": end.isoformat(),
                      "origins": length, "trainLabelClosedThrough": (start - timedelta(days=1)).isoformat(),
                      "trainLatestOrigin": (start - timedelta(days=horizon + 1)).isoformat()})
        start = end + timedelta(days=1)
    return {**base, "status": "READY", "folds": folds}


def metric_bundle(actual, predicted):
    if not actual or len(actual) != len(predicted):
        raise PolicyError("Metric universe is empty or incompatible")
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or x < 0
           for x in list(actual) + list(predicted)):
        raise PolicyError("Metrics require finite nonnegative paired values")
    n = len(actual)
    volume = float(sum(actual))
    error = sum(abs(p - y) for y, p in zip(actual, predicted))
    signed = sum(p - y for y, p in zip(actual, predicted))
    return {"rows": n, "actual_units": volume, "mae": error / n,
            "wape": error / volume if volume else None, "bias_units": signed / n,
            "normalized_bias": signed / volume if volume else None}


def fold_from_samples(split: str, samples: list[dict], top10: list[str]) -> dict:
    """Both predictors use exactly the same SKU/origin/label rows, no imputation."""
    if not samples or len({(r["sku"], r["origin"]) for r in samples}) != len(samples):
        raise PolicyError("Duplicate or missing evaluation rows")
    universes = {sku: {r["origin"] for r in samples if r["sku"] == sku}
                 for sku in sorted({r["sku"] for r in samples})}
    if len({tuple(sorted(days)) for days in universes.values()}) != 1:
        raise PolicyError("SKU evaluation origin coverage differs")
    if len(top10) != len(set(top10)) or not set(top10).issubset(universes):
        raise PolicyError("Priority membership differs from evaluation universe")
    result = {"split": split, "top10": list(top10), "support": {}}
    for field, output in (("prediction", "metrics"), ("baseline", "baseline")):
        metrics = {"overall": metric_bundle([r["actual"] for r in samples], [r[field] for r in samples])}
        for kind in ("category", "segment", "sku"):
            groups = {}
            for key in sorted({r[kind] for r in samples}):
                selected = [r for r in samples if r[kind] == key]
                groups[key] = metric_bundle([r["actual"] for r in selected], [r[field] for r in selected])
                if output == "metrics":
                    units = [r["observedUnits"] for r in selected]
                    if any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or v < 0 for v in units):
                        raise PolicyError("Invalid unique-day support")
                    result["support"].setdefault(kind, {})[key] = {
                        "origins": len({r["origin"] for r in selected}), "uniqueDayUnits": float(sum(units))}
            metrics[kind] = groups
        metrics["macroMaeBySku"] = statistics.mean(v["mae"] for v in metrics["sku"].values())
        result[output] = metrics
    return result


def pool(items):
    n = sum(x["rows"] for x in items)
    volume = sum(x["actual_units"] for x in items)
    if not n:
        raise PolicyError("Empty metric pool")
    ae = sum(x["mae"] * x["rows"] for x in items)
    signed = sum(x["bias_units"] * x["rows"] for x in items)
    return {"rows": n, "actual_units": volume, "mae": ae / n, "wape": ae / volume if volume else None,
            "bias_units": signed / n, "normalized_bias": signed / volume if volume else None}


def evaluate_policy(folds: list[dict], horizon: int) -> dict:
    p = load_policy()
    if horizon not in (7, 14) or len(folds) != 3 or {r["split"] for r in folds} != set(p["folds"]):
        raise PolicyError("Policy requires 7/14 and exactly three named folds")
    rs = sorted(folds, key=lambda r: p["folds"].index(r["split"]))
    checks, reasons = {}, []

    def check(key, condition):
        checks[key] = bool(condition)
        if not condition:
            reasons.append(key)

    def ratio(a, b):
        return a / b if b > 0 else None

    def support(rows, kind, key):
        values = [r["support"].get(kind, {}).get(key, {"origins": 0, "uniqueDayUnits": 0}) for r in rows]
        origins, units = sum(v["origins"] for v in values), sum(v["uniqueDayUnits"] for v in values)
        return {"origins": origins, "uniqueDayUnits": units,
                "sufficient": origins >= p["support"]["pooledOriginsMin"] and units >= p["support"]["observedUniqueDayUnitsMin"]}

    sku_keys = set(rs[0]["metrics"]["sku"])
    if not sku_keys or any(set(r[k]["sku"]) != sku_keys for r in rs for k in ("metrics", "baseline")):
        raise PolicyError("Model/baseline SKU universe differs")
    model_skus = {s: pool([r["metrics"]["sku"][s] for r in rs]) for s in sorted(sku_keys)}
    base_skus = {s: pool([r["baseline"]["sku"][s] for r in rs]) for s in sorted(sku_keys)}
    m, base = pool([r["metrics"]["overall"] for r in rs]), pool([r["baseline"]["overall"] for r in rs])
    mm = statistics.mean(x["mae"] for x in model_skus.values())
    bm = statistics.mean(x["mae"] for x in base_skus.values())
    g = p["global"]
    improvement = (base["wape"] - m["wape"]) / base["wape"] if base["wape"] else None
    check("G1_POOLED_WAPE_5PCT", improvement is not None and improvement >= g["pooledRelativeWapeImprovementMin"])
    check("G2_POOLED_BIAS_10PCT", m["normalized_bias"] is not None and abs(m["normalized_bias"]) <= g["pooledAbsoluteNormalizedBiasMax"])
    check("G3_POOLED_MACRO_MAE_110PCT", mm <= bm * g["pooledMacroMaeRatioMax"] if bm else mm <= .1 * horizon)
    wins = 0
    for r in rs:
        fm, fb = r["metrics"]["overall"], r["baseline"]["overall"]
        wr = ratio(fm["wape"], fb["wape"]) if fm["wape"] is not None and fb["wape"] is not None else None
        wins += int(wr is not None and wr < 1)
        check("G5_FOLD_WAPE_VETO:" + r["split"], wr is not None and wr <= g["eachFoldWapeRatioMax"])
        check("G6_FOLD_BIAS_VETO:" + r["split"], fm["normalized_bias"] is not None and abs(fm["normalized_bias"]) <= g["eachFoldAbsoluteNormalizedBiasMax"])
        check("G7_FOLD_MACRO_MAE:" + r["split"], r["metrics"]["macroMaeBySku"] <= r["baseline"]["macroMaeBySku"] * g["eachFoldMacroMaeRatioMax"] if r["baseline"]["macroMaeBySku"] else r["metrics"]["macroMaeBySku"] <= .1 * horizon)
    check("G4_AT_LEAST_2_POSITIVE_FOLDS", wins >= g["positiveImprovementFoldsMin"])
    last_m, last_b = rs[-1]["metrics"]["overall"]["wape"], rs[-1]["baseline"]["overall"]["wape"]
    check("G8_LATEST_NONINFERIOR", last_m is not None and last_b is not None and last_m <= last_b * g["latestFoldWapeRatioMax"])
    groups = {}
    for kind in ("category", "segment"):
        items, family = [], p["categoryAndSegment"]
        keys = sorted(set().union(*(set(r["metrics"][kind]) for r in rs)))
        for key in keys:
            cur = pool([r["metrics"][kind][key] for r in rs if key in r["metrics"][kind]])
            prior = pool([r["baseline"][kind][key] for r in rs if key in r["baseline"][kind]])
            sup = support(rs, kind, key)
            wr = ratio(cur["wape"], prior["wape"]) if cur["wape"] is not None and prior["wape"] is not None else None
            ordinary = sup["sufficient"] and ((wr is not None and wr <= family["pooledWapeRatioOrdinaryMax"]) or (wr is None and cur["mae"] <= prior["mae"] + .1 * horizon))
            if sup["sufficient"]:
                check(f"S_CATA_WAPE:{kind}:{key}", wr <= family["pooledWapeRatioCatastrophicMax"] if wr is not None else cur["mae"] <= prior["mae"] + .1 * horizon)
                check(f"S_CATA_BIAS:{kind}:{key}", cur["normalized_bias"] is None or abs(cur["normalized_bias"]) <= family["pooledAbsoluteNormalizedBiasCatastrophicMax"])
            else:
                check(f"S_LOW_SUPPORT_MAE:{kind}:{key}", cur["mae"] <= prior["mae"] + family["lowDemandMaeExcessMaxPerDay"] * horizon)
            items.append({"key": key, "model": cur, "baseline": prior, "support": sup, "wapeRatio": wr, "ordinaryPassed": ordinary})
        count = sum(x["ordinaryPassed"] for x in items) / len(items) if items else 0.0
        total = sum(x["model"]["actual_units"] for x in items)
        volume = sum(x["model"]["actual_units"] for x in items if x["ordinaryPassed"]) / total if total else 0.0
        check("S_GROUP_COVERAGE:" + kind, count >= family["ordinaryPassGroupFractionMin"])
        check("S_VOLUME_COVERAGE:" + kind, volume >= family["ordinaryPassTargetVolumeFractionMin"])
        groups[kind] = {"items": items, "countCoverage": count, "targetVolumeCoverage": volume}
    priority = sorted(set(s for r in rs for s in r["top10"]))
    pri, degr, pp = [], [], p["priority"]
    for sku in priority:
        cur, prior, sup = model_skus[sku], base_skus[sku], support(rs, "sku", sku)
        mr = ratio(cur["mae"], prior["mae"])
        ordinary = sup["sufficient"] and ((mr is not None and mr <= pp["pooledMaeRatioOrdinaryMax"]) or (mr is None and cur["mae"] <= prior["mae"] + pp["zeroBaselineMaeExcessMaxPerDay"] * horizon)) and (cur["normalized_bias"] is None or abs(cur["normalized_bias"]) <= pp["pooledAbsoluteNormalizedBiasOrdinaryMax"])
        degr.append(mr - 1 if mr is not None else 0.0 if cur["mae"] <= prior["mae"] else 1.0)
        check("P_CATA_MAE:" + sku, mr <= pp["pooledMaeRatioCatastrophicMax"] if mr is not None else cur["mae"] <= prior["mae"] + pp["zeroBaselineMaeExcessMaxPerDay"] * horizon)
        check("P_CATA_BIAS:" + sku, cur["normalized_bias"] is None or abs(cur["normalized_bias"]) <= pp["pooledAbsoluteNormalizedBiasCatastrophicMax"])
        local = []
        for r in rs:
            fs = support([r], "sku", sku)
            if not fs["sufficient"]:
                continue
            cm, cb = r["metrics"]["sku"][sku], r["baseline"]["sku"][sku]
            fr = ratio(cm["mae"], cb["mae"])
            check(f"P_FOLD_CATA_MAE:{r['split']}:{sku}", fr <= pp["supportedFoldMaeRatioCatastrophicMax"] if fr is not None else cm["mae"] <= cb["mae"] + pp["zeroBaselineMaeExcessMaxPerDay"] * horizon)
            check(f"P_FOLD_CATA_BIAS:{r['split']}:{sku}", cm["normalized_bias"] is None or abs(cm["normalized_bias"]) <= pp["supportedFoldAbsoluteNormalizedBiasCatastrophicMax"])
            local.append({"split": r["split"], "support": fs, "maeRatio": fr, "normalizedBias": cm["normalized_bias"]})
        pri.append({"sku": sku, "model": cur, "baseline": prior, "maeRatio": mr, "support": sup,
                    "ordinaryPassed": ordinary, "supportedFoldChecks": local})
    pc = sum(x["ordinaryPassed"] for x in pri) / len(pri) if pri else 0.0
    med = statistics.median(degr) if degr else None
    check("P_80PCT_COVERAGE", pc >= pp["ordinaryPassSkuFractionMin"])
    check("P_MEDIAN_NO_DEGRADATION", med is not None and med <= pp["medianRelativeMaeDegradationMax"])
    status = "PASS" if all(checks.values()) else "REJECTED"
    return {"policyVersion": POLICY_VERSION, "policyHash": POLICY_HASH, "status": status,
            "model": m, "baseline": base, "macroMae": mm, "baselineMacroMae": bm,
            "relativeWapeImprovement": improvement, "checks": checks, "reasons": reasons,
            "globalChecks": {k: v for k, v in checks.items() if k.startswith(("G1_", "G2_", "G3_"))},
            "foldChecks": {k: v for k, v in checks.items() if k.startswith(("G4_", "G5_", "G6_", "G7_", "G8_"))},
            "categoryChecks": groups["category"], "segmentChecks": groups["segment"],
            "prioritySkuChecks": {"items": pri, "countCoverage": pc, "medianRelativeMaeDegradation": med},
            "catastrophicVeto": [key for key in reasons if "CATA_" in key],
            "supportChecks": {kind: {item["key"]: item["support"] for item in groups[kind]["items"]}
                              for kind in ("category", "segment")},
            "folds": rs}
