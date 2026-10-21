"""Focal, offline-only coverage for the M6.10A.3.2 LIVE Ridge builder/scorer."""
from __future__ import annotations

import hashlib
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from sklearn.linear_model import Ridge
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from ml.service.v3_live_ridge import (
    ARTIFACT_SCHEMA_VERSION, CATEGORICAL_FEATURES, FEATURE_HASH, FEATURE_ORDER,
    FEATURE_VERSION, MODEL_FAMILY, NUMERIC_FEATURES, PROMOTION_POLICY_HASH,
    PROMOTION_POLICY_VERSION, RECIPE_ID, SCENARIO_ID,
    LiveRidgeError, build_live_features, feature_contract_hash, load_verified_ridge_artifact,
    ridge_cache_key, ridge_live_forecast, score_ridge,
)
from ml.src import v3_forecast

BUSINESS = "B-V3"
SKU = "SKU-1"
PRODUCT_KEY = "P-1"
THROUGH = date(2026, 10, 15)
AS_OF = date(2026, 10, 16)


def _product(**overrides):
    row = {
        "productKey": PRODUCT_KEY, "sku": SKU, "categoryCode": "CAT",
        "subcategoryCode": "SUB", "brand": "Marca", "presentation": "500 ml",
        "unit": "unit", "sizeValue": 500, "containedUnits": 1, "active": True,
        # Explicitly non-CAUSAL27 values prove that they are not read.
        "salePriceDemo": 9.99, "minStockInitial": 1,
    }
    row.update(overrides)
    return row


def _fixture(*, values=None, missing_day=None, partial_day=None, new_sku=False,
             catalog_changes=(), data_version="9", context_hash="a" * 64,
             closed_revision="9", tenant=BUSINESS, through=THROUGH):
    sku = "NEW-1" if new_sku else SKU
    product_key = "P-NEW" if new_sku else PRODUCT_KEY
    product = _product(sku=sku, productKey=product_key)
    days = [through - timedelta(days=offset) for offset in range(28, -1, -1)]
    units = list(values if values is not None else [offset % 6 for offset in range(29)])
    assert len(units) == 29
    inventory = {}
    closed = {}
    for day, amount in zip(days, units):
        if day == missing_day:
            continue
        if day <= v3_forecast.HISTORY_END:
            inventory.setdefault(sku, {})[day.isoformat()] = {
                "localDate": day.isoformat(), "unitsSold": amount,
                "availableHours": 15.0, "endingStock": 50,
                "completeness": "PARTIAL" if day == partial_day else "COMPLETE",
            }
        else:
            closed[(product_key, day)] = SimpleNamespace(
                productKey=product_key, localDate=day, unitsSold=amount,
                completeness="PARTIAL" if day == partial_day else "COMPLETE",
            )
    # The canonical reference row contains all 29 values only for established SKUs.
    reference_inventory = {sku: {day.isoformat(): {
        "localDate": day.isoformat(), "unitsSold": amount, "availableHours": 15.0,
        "endingStock": 50,
    } for day, amount in zip(days, units)}} if not new_sku else {}
    product_list = [] if new_sku else [product]
    dataset = SimpleNamespace(
        products=product_list,
        product_by_sku={} if new_sku else {sku: product},
        inventory=reference_inventory if not new_sku else {},
        calendar={}, prices={}, promotions=[], feature_cache={},
    )
    metadata = SimpleNamespace(
        businessId=tenant, scenarioId=SCENARIO_ID, snapshotHash=context_hash,
        dataVersion=data_version, asOfDate=max(AS_OF, through + timedelta(days=1)), observationsClosedThrough=through,
    )
    snapshot = SimpleNamespace(metadata=metadata, catalogChanges=list(catalog_changes),
                               closedSalesDays=list(closed.values()))
    if new_sku and not catalog_changes:
        creation = SimpleNamespace(entityType="product", effectiveAtUtc=datetime(2026, 10, 13, 12,
            tzinfo=timezone.utc), revision="1", eventKey="create-new",
            projection=SimpleNamespace(before=None, after=SimpleNamespace(
                productKey=product_key, sku=sku, categoryCode="CAT", subcategoryCode="SUB",
                brand="Marca", presentation="500 ml", unit="unit", sizeValue=500,
                containedUnits=1, active=True)))
        snapshot.catalogChanges = [creation]
    live = SimpleNamespace(
        snapshot=snapshot, context_hash=context_hash, data_version=closed_revision,
        closed_sales_by_product_day=closed,
    )
    return dataset, live, product, days, units


def _artifact(*, business=BUSINESS, scenario=SCENARIO_ID, horizon=7, categories=None,
              model_version=3):
    categories = categories or {
        "sku": ["SKU-1"], "categoryCode": ["CAT"], "subcategoryCode": ["SUB"],
        "brand": ["Marca"], "presentation": ["500 ml"], "unit": ["unit"],
    }
    width = sum(len(categories[name]) for name in CATEGORICAL_FEATURES) + len(NUMERIC_FEATURES)
    body = {
        "schemaVersion": ARTIFACT_SCHEMA_VERSION, "businessId": business,
        "scenarioId": scenario, "horizonDays": horizon, "modelFamily": MODEL_FAMILY,
        "recipeId": RECIPE_ID, "featureVersion": FEATURE_VERSION, "featureHash": FEATURE_HASH,
        "modelVersion": model_version, "categoricalFeatures": list(CATEGORICAL_FEATURES),
        "numericFeatures": list(NUMERIC_FEATURES), "categories": categories,
        "scalerMean": [float(index) / 3 for index in range(len(NUMERIC_FEATURES))],
        "scalerScale": [float(index + 1) / 10 for index in range(len(NUMERIC_FEATURES))],
        "coefficients": [float(index + 1) / 100 for index in range(width)],
        "intercept": 2.5, "alpha": 10.0, "solver": "lsqr", "tol": 0.0001,
    }
    raw = json.dumps(body, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    metadata = {
        "businessId": business, "scenarioId": scenario, "horizonDays": horizon,
        "status": "ACTIVE", "modelFamily": MODEL_FAMILY, "recipeId": RECIPE_ID,
        "featureVersion": FEATURE_VERSION, "featureHash": FEATURE_HASH,
        "promotionPolicyVersion": PROMOTION_POLICY_VERSION,
        "promotionPolicyHash": PROMOTION_POLICY_HASH,
        "modelVersion": model_version, "artifactBytes": len(raw),
        "artifactHash": hashlib.sha256(raw).hexdigest(), "trainedAt": datetime(2026, 10, 16, tzinfo=timezone.utc),
        "trainedDataVersion": "8", "dataCutoff": "2026-10-15",
    }
    return body, {"metadata": metadata, "artifactData": raw}


class LiveRidgeFeatureTests(unittest.TestCase):
    def test_response_exposes_exact_scored_row_once_with_same_snapshot_and_artifact(self):
        for horizon in (7, 14):
            dataset, live, *_ = _fixture()
            _, envelope = _artifact(horizon=horizon)
            with patch('ml.service.v3_live_ridge.build_live_features', wraps=build_live_features) as build, \
                 patch('ml.service.v3_live_ridge.score_ridge', wraps=score_ridge) as score:
                result = ridge_live_forecast(dataset=dataset, live=live, business_id=BUSINESS,
                    scenario_id=SCENARIO_ID, sku=SKU, horizon_days=horizon, registry_loader=lambda **_: envelope)
            self.assertEqual(build.call_count, 1)
            self.assertEqual(score.call_count, 1)
            self.assertIs(result['featureInputs'], score.call_args.args[0])
            self.assertEqual(tuple(result['featureInputs']), FEATURE_ORDER)
            self.assertEqual(len(result['featureInputs']), 27)
            self.assertEqual(result['featureVersion'], FEATURE_VERSION)
            self.assertEqual(result['featureHash'], FEATURE_HASH)
            self.assertEqual(result['predictionUnits'], score_ridge(result['featureInputs'], score.call_args.args[1]))
            self.assertEqual(result['artifactHash'], envelope['metadata']['artifactHash'])
            self.assertEqual(result['snapshotHash'], live.context_hash)
            self.assertEqual(result['dataVersion'], live.data_version)
            for internal in ('coefficients', 'categories', 'scalerMean', 'scalerScale', 'intercept'):
                self.assertNotIn(internal, result)

    def test_stock_purchase_and_adjustment_do_not_change_inputs_or_predictions(self):
        dataset, live, *_ = _fixture()
        _, envelope = _artifact()
        def infer():
            return ridge_live_forecast(dataset=dataset, live=live, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7, registry_loader=lambda **_: envelope)
        before = infer()
        for operation in ('STOCK_CHANGED', 'IMMEDIATE_PURCHASE', 'STOCK_ADJUSTMENT'):
            live.snapshot.stockStates = [SimpleNamespace(onHand=999, operation=operation)]
            live.snapshot.purchases = [SimpleNamespace(quantity=100, receiptEvidence=operation)]
            live.data_version = str(int(live.data_version) + 1)
            live.snapshot.metadata.dataVersion = live.data_version
            after = infer()
            self.assertEqual(before['featureInputs'], after['featureInputs'])
            self.assertEqual(before['predictionUnits'], after['predictionUnits'])

    def test_closed_boundary_advance_and_admissible_descriptor_change_use_same_active(self):
        _, envelope = _artifact()
        def infer(dataset, live):
            return ridge_live_forecast(dataset=dataset, live=live, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7, registry_loader=lambda **_: envelope)
        dataset, live, *_ = _fixture(values=[1] * 29)
        before = infer(dataset, live)
        change = SimpleNamespace(entityType='product', effectiveAtUtc=datetime(2026, 10, 16, 12, tzinfo=timezone.utc),
            revision='10', eventKey='descriptor', projection=SimpleNamespace(before=SimpleNamespace(sku=SKU),
                after=SimpleNamespace(**_product(brand='Admissible brand'))))
        dataset, live, *_ = _fixture(through=date(2026, 10, 16), values=[1] * 28 + [4],
            catalog_changes=[change], data_version='10', closed_revision='10')
        after = infer(dataset, live)
        self.assertEqual(before['modelVersion'], after['modelVersion'])
        self.assertEqual(before['artifactHash'], after['artifactHash'])
        self.assertNotEqual(before['observationsThrough'], after['observationsThrough'])
        for name in ('weekdayNext', 'currentUnits', 'rollingMean_7', 'brand'):
            self.assertNotEqual(before['featureInputs'][name], after['featureInputs'][name])

    def test_exact_27_feature_allowlist_and_order_for_7_and_14(self):
        dataset, live, _, _, _ = _fixture()
        for horizon in (7, 14):
            with self.subTest(horizon=horizon):
                result = build_live_features(dataset, live, business_id=BUSINESS,
                    scenario_id=SCENARIO_ID, sku=SKU, horizon_days=horizon)
                self.assertEqual(tuple(result), FEATURE_ORDER)
                self.assertEqual(len(result), 27)
                self.assertEqual(result["weekendNextDays"], sum(
                    (THROUGH + timedelta(days=step)).isoweekday() >= 6
                    for step in range(1, horizon + 1)))
                self.assertNotIn("salePriceDemo", result)
                self.assertNotIn("currentStockAtCutoff", result)
                self.assertNotIn("holidayDaysKnown", result)

    def test_causal_history_lags_and_rolling_match_frozen_feature_row(self):
        dataset, live, product, days, units = _fixture(through=v3_forecast.HISTORY_END)
        for horizon in (7, 14):
            actual = build_live_features(dataset, live, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, sku=SKU, horizon_days=horizon)
            reference = v3_forecast.V3Dataset.feature_row(dataset, SKU, v3_forecast.HISTORY_END, horizon)
            expected = {name: reference[name] for name in FEATURE_ORDER}
            self.assertEqual(actual, expected)

    def test_lag_offsets_and_rolling_windows_are_exact(self):
        values = list(range(1, 30))
        dataset, live, *_ = _fixture(values=values)
        features = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        expected = {"currentUnits": 29, "lag_1": 28, "lag_7": 22,
                    "lag_14": 15, "lag_28": 1}
        for name, value in expected.items():
            self.assertEqual(features[name], value)
        self.assertEqual(features["rollingMean_7"], sum(range(23, 30)) / 7)
        self.assertEqual(features["rollingMean_14"], sum(range(16, 30)) / 14)
        self.assertEqual(features["rollingMean_28"], sum(range(2, 30)) / 28)
        self.assertAlmostEqual(features["rollingStd_7"], float(np.std(range(23, 30), ddof=0)))
        self.assertAlmostEqual(features["rollingStd_28"], float(np.std(range(2, 30), ddof=0)))

    def test_zero_streak_days_since_sale_and_never_sold(self):
        values = [3] + [0] * 28
        dataset, live, *_ = _fixture(values=values)
        result = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        self.assertEqual(result["zeroSalesStreak"], 28)
        self.assertEqual(result["daysSinceLastSale"], 28)
        self.assertEqual(result["neverSoldInObservedWindow"], 0)
        dataset, live, *_ = _fixture(values=[0] * 29)
        result = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=14)
        self.assertEqual(result["zeroSalesStreak"], 29)
        self.assertEqual(result["daysSinceLastSale"], 29)
        self.assertEqual(result["neverSoldInObservedWindow"], 1)

    def test_calendar_payday_and_month_end_crossings_for_each_horizon(self):
        dataset, live, *_ = _fixture(through=date(2026, 10, 13))
        seven = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        fourteen = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=14)
        self.assertEqual(seven["weekdayNext"], 3)  # 2026-10-14, Wednesday.
        self.assertEqual(seven["monthNext"], 10)
        self.assertEqual(seven["dayOfMonthNext"], 14)
        self.assertEqual(seven["paydayDays"], 3)
        self.assertEqual(fourteen["paydayDays"], 3)
        dataset, live, *_ = _fixture(through=date(2026, 10, 25))
        seven = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        fourteen = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=14)
        self.assertEqual(seven["monthEndDays"], 1)
        self.assertEqual(fourteen["monthEndDays"], 1)

    def test_live_closed_days_replace_historical_overlay_after_cutoff(self):
        values = [0] * 29
        values[-1] = 7
        dataset, live, *_ = _fixture(values=values)
        features = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        self.assertEqual(features["currentUnits"], 7)
        self.assertEqual(features["lag_1"], 0)
        self.assertEqual(features["rollingMean_7"], 1)

    def test_partial_operational_day_is_not_used_as_closed_feature(self):
        dataset, live, *_ = _fixture(partial_day=AS_OF)
        live.snapshot.sales = [SimpleNamespace(localDate=AS_OF, unitsSold=100000)]
        features = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        self.assertEqual(features["currentUnits"], 4)
        self.assertNotEqual(features["currentUnits"], 100000)

    def test_missing_post_cutoff_day_is_unavailable_not_zero(self):
        missing = THROUGH - timedelta(days=1)
        dataset, live, *_ = _fixture(missing_day=missing)
        with self.assertRaises(LiveRidgeError) as caught:
            build_live_features(dataset, live, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        self.assertEqual(caught.exception.code, "FEATURE_UNAVAILABLE")

    def test_missing_historical_day_is_insufficient_not_zero(self):
        missing = v3_forecast.HISTORY_END - timedelta(days=2)
        dataset, live, *_ = _fixture(missing_day=missing)
        dataset.inventory[SKU].pop(missing.isoformat())
        with self.assertRaises(LiveRidgeError) as caught:
            build_live_features(dataset, live, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        self.assertEqual(caught.exception.code, "INSUFFICIENT_HISTORY")

    def test_partial_historical_day_is_rejected(self):
        partial = v3_forecast.HISTORY_END
        dataset, live, *_ = _fixture(partial_day=partial)
        dataset.inventory[SKU][partial.isoformat()]["completeness"] = "PARTIAL"
        with self.assertRaises(LiveRidgeError) as caught:
            build_live_features(dataset, live, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        self.assertEqual(caught.exception.code, "FEATURE_UNAVAILABLE")

    def test_new_sku_without_29_day_history_is_insufficient(self):
        dataset, live, *_ = _fixture(new_sku=True)
        with self.assertRaises(LiveRidgeError) as caught:
            build_live_features(dataset, live, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, sku="NEW-1", horizon_days=7)
        self.assertEqual(caught.exception.code, "INSUFFICIENT_HISTORY")

    def test_catalog_descriptor_is_projected_only_when_effective_by_t(self):
        before = SimpleNamespace(sku=SKU)
        after = SimpleNamespace(productKey=PRODUCT_KEY, sku=SKU, categoryCode="NEW-CAT",
            subcategoryCode="SUB", brand="Marca", presentation="500 ml", unit="unit",
            sizeValue=500, containedUnits=1, active=True, priceCents=99999)
        change = SimpleNamespace(entityType="product", effectiveAtUtc=datetime(2026, 10, 15, 12,
            tzinfo=timezone.utc), revision="1", eventKey="evt",
            projection=SimpleNamespace(before=before, after=after))
        dataset, live, *_ = _fixture(catalog_changes=[change])
        actual = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        self.assertEqual(actual["categoryCode"], "NEW-CAT")

    def test_catalog_changes_after_t_do_not_rewrite_history(self):
        change = SimpleNamespace(entityType="product", effectiveAtUtc=datetime(2026, 10, 16, 12,
            tzinfo=timezone.utc), revision="1", eventKey="evt",
            projection=SimpleNamespace(before=None, after=SimpleNamespace(
                productKey=PRODUCT_KEY, sku=SKU, categoryCode="FUTURE")))
        dataset, live, *_ = _fixture(catalog_changes=[change])
        actual = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        self.assertEqual(actual["categoryCode"], "CAT")

    def test_wrong_tenant_scenario_snapshot_hash_and_revision_fail_closed(self):
        dataset, live, *_ = _fixture()
        for kwargs, code in [
            ({"business_id": "OTHER"}, "INVALID_SCOPE"),
            ({"scenario_id": "other"}, "INVALID_SCOPE"),
        ]:
            params = {"business_id": BUSINESS, "scenario_id": SCENARIO_ID,
                      "sku": SKU, "horizon_days": 7, **kwargs}
            with self.subTest(kwargs=kwargs), self.assertRaises(LiveRidgeError) as caught:
                build_live_features(dataset, live, **params)
            self.assertEqual(caught.exception.code, code)
        live.context_hash = "b" * 64
        with self.assertRaises(LiveRidgeError) as caught:
            build_live_features(dataset, live, business_id=BUSINESS, scenario_id=SCENARIO_ID,
                sku=SKU, horizon_days=7)
        self.assertEqual(caught.exception.code, "FEATURE_UNAVAILABLE")
        live.context_hash = "a" * 64
        live.data_version = "8"
        with self.assertRaises(LiveRidgeError) as caught:
            build_live_features(dataset, live, business_id=BUSINESS, scenario_id=SCENARIO_ID,
                sku=SKU, horizon_days=7)
        self.assertEqual(caught.exception.code, "FEATURE_UNAVAILABLE")

    def test_cancelled_sale_is_not_subtracted_twice_from_certified_net_day(self):
        values = [1] * 29
        values[-1] = 2  # Backend closedSalesDays is already net of canceled lines.
        dataset, live, *_ = _fixture(values=values)
        live.cancelled_transaction_keys = frozenset({"sale-being-removed"})
        live.snapshot.sales = [SimpleNamespace(saleKey="sale-being-removed", units=5)]
        actual = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        self.assertEqual(actual["currentUnits"], 2)

    def test_one_day_is_rejected_before_registry_loader_and_never_falls_back(self):
        dataset, live, *_ = _fixture()
        calls = []
        result = ridge_live_forecast(dataset=dataset, live=live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=1,
            registry_loader=lambda **kwargs: calls.append(kwargs))
        self.assertEqual(calls, [])
        self.assertEqual(result["status"], "MODEL_NOT_APPROVED")
        self.assertEqual(result["reasonCode"], "PROMOTION_POLICY_FAILED")
        self.assertIsNone(result["predictionUnits"])
        self.assertIsNone(result["modelVersion"])

    def test_future_cache_key_includes_snapshot_and_active_version_dimensions(self):
        key = ridge_cache_key(business_id=BUSINESS, scenario_id=SCENARIO_ID, sku=SKU,
            horizon_days=14, observations_through=THROUGH, data_version="9",
            snapshot_hash="a" * 64, active_model_version=3)
        self.assertEqual(key, (BUSINESS, SCENARIO_ID, SKU, "14", "2026-10-15", "9", "a" * 64, "3"))

    def test_no_active_7_or_14_returns_null_without_ma28_fallback(self):
        dataset, live, *_ = _fixture()
        for horizon in (7, 14):
            result = ridge_live_forecast(dataset=dataset, live=live, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, sku=SKU, horizon_days=horizon,
                registry_loader=lambda **kwargs: None)
            self.assertEqual(result["status"], "MODEL_UNAVAILABLE")
            self.assertIsNone(result["predictionUnits"])
            self.assertEqual(result["activeModelStatus"], "NONE")
            self.assertNotIn("MOVING_AVERAGE_28", json.dumps(result))


class SafeArtifactAndScoringTests(unittest.TestCase):
    def test_safe_json_artifact_load_checks_hash_scope_and_schema(self):
        body, envelope = _artifact()
        loaded = load_verified_ridge_artifact(envelope, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, horizon_days=7)
        self.assertEqual(loaded, body)
        for bad_scope in (("OTHER", SCENARIO_ID, 7), (BUSINESS, "other", 7), (BUSINESS, SCENARIO_ID, 14)):
            with self.subTest(scope=bad_scope), self.assertRaises(LiveRidgeError):
                load_verified_ridge_artifact(envelope, business_id=bad_scope[0],
                    scenario_id=bad_scope[1], horizon_days=bad_scope[2])

    def test_artifact_hash_bytes_dimensions_nonfinite_duplicates_and_executable_format_rejected(self):
        _, envelope = _artifact()
        corrupt = dict(envelope)
        corrupt["artifactData"] = envelope["artifactData"] + b" "
        with self.assertRaises(LiveRidgeError):
            load_verified_ridge_artifact(corrupt, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, horizon_days=7)
        body = json.loads(envelope["artifactData"])
        body["coefficients"].pop()
        raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        invalid = {"metadata": {**envelope["metadata"], "artifactBytes": len(raw),
                    "artifactHash": hashlib.sha256(raw).hexdigest()}, "artifactData": raw}
        with self.assertRaises(LiveRidgeError):
            load_verified_ridge_artifact(invalid, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, horizon_days=7)
        raw = b'{"a":1,"a":2}'
        invalid = {"metadata": {**envelope["metadata"], "artifactBytes": len(raw),
                    "artifactHash": hashlib.sha256(raw).hexdigest()}, "artifactData": raw}
        with self.assertRaises(LiveRidgeError):
            load_verified_ridge_artifact(invalid, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, horizon_days=7)
        with self.assertRaises(LiveRidgeError):
            load_verified_ridge_artifact({"metadata": envelope["metadata"], "artifactData": b"PK\x03\x04"},
                business_id=BUSINESS, scenario_id=SCENARIO_ID, horizon_days=7)

    def test_artifact_rejects_feature_hash_horizon_and_nonfinite_values(self):
        _, envelope = _artifact()
        bad_meta = {**envelope["metadata"], "featureHash": "0" * 64}
        with self.assertRaises(LiveRidgeError):
            load_verified_ridge_artifact({"metadata": bad_meta, "artifactData": envelope["artifactData"]},
                business_id=BUSINESS, scenario_id=SCENARIO_ID, horizon_days=7)
        body = json.loads(envelope["artifactData"])
        body["horizonDays"] = 14
        raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        wrong_horizon = {"metadata": {**envelope["metadata"], "artifactBytes": len(raw),
            "artifactHash": hashlib.sha256(raw).hexdigest()}, "artifactData": raw}
        with self.assertRaises(LiveRidgeError):
            load_verified_ridge_artifact(wrong_horizon, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, horizon_days=7)
        body["horizonDays"] = 7
        body["scalerMean"][0] = float("nan")
        raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        nonfinite = {"metadata": {**envelope["metadata"], "artifactBytes": len(raw),
            "artifactHash": hashlib.sha256(raw).hexdigest()}, "artifactData": raw}
        with self.assertRaises(LiveRidgeError):
            load_verified_ridge_artifact(nonfinite, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, horizon_days=7)

    def test_score_matches_sklearn_ridge_predict_without_fit_or_training(self):
        for horizon in (7, 14):
            body, envelope = _artifact(horizon=horizon)
            artifact = load_verified_ridge_artifact(envelope, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, horizon_days=horizon)
            dataset, live, *_ = _fixture()
            features = build_live_features(dataset, live, business_id=BUSINESS,
                scenario_id=SCENARIO_ID, sku=SKU, horizon_days=horizon)
            actual = score_ridge(features, artifact)
            encoder = OneHotEncoder(handle_unknown="ignore", sparse_output=True)
            encoder.categories_ = [np.asarray(body["categories"][name], dtype=object)
                                   for name in CATEGORICAL_FEATURES]
            encoder.n_features_in_ = len(CATEGORICAL_FEATURES)
            encoder._infrequent_enabled = False
            encoder._drop_idx_after_grouping = None
            encoder._n_features_outs = [len(body["categories"][name]) for name in CATEGORICAL_FEATURES]
            categorical = encoder.transform([[features[name] for name in CATEGORICAL_FEATURES]]).toarray()
            scaler = StandardScaler()
            scaler.mean_ = np.asarray(body["scalerMean"], dtype=float)
            scaler.scale_ = np.asarray(body["scalerScale"], dtype=float)
            scaler.var_ = scaler.scale_ ** 2
            scaler.n_features_in_ = len(NUMERIC_FEATURES)
            scaler.n_samples_seen_ = 1
            numeric = scaler.transform([[features[name] for name in NUMERIC_FEATURES]])
            vector = np.hstack((categorical, numeric))[0]
            reference = Ridge(alpha=10.0, solver="lsqr", tol=0.0001)
            reference.coef_ = np.asarray(body["coefficients"], dtype=float)
            reference.intercept_ = float(body["intercept"])
            reference.n_features_in_ = len(vector)
            expected = max(0.0, float(reference.predict(vector.reshape(1, -1))[0]))
            self.assertAlmostEqual(actual, expected, places=12, msg=f"horizon={horizon}")

    def test_unknown_category_matches_one_hot_ignore_semantics_and_negative_clamps_zero(self):
        body, envelope = _artifact()
        artifact = load_verified_ridge_artifact(envelope, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, horizon_days=7)
        dataset, live, *_ = _fixture()
        features = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        features["brand"] = "unseen"
        self.assertTrue(score_ridge(features, artifact) >= 0)
        negative = dict(artifact)
        negative["intercept"] = -1_000_000
        negative["coefficients"] = [0.0] * len(negative["coefficients"])
        self.assertEqual(score_ridge(features, negative), 0.0)

    def test_nan_and_infinity_in_numeric_feature_are_rejected(self):
        _, envelope = _artifact()
        artifact = load_verified_ridge_artifact(envelope, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, horizon_days=7)
        dataset, live, *_ = _fixture()
        features = build_live_features(dataset, live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7)
        for bad in (float("nan"), float("inf"), float("-inf")):
            features["rollingMean_7"] = bad
            with self.subTest(value=bad), self.assertRaises(LiveRidgeError):
                score_ridge(features, artifact)

    def test_parity_feature_hash_is_stable_sha256_and_feature_list_is_causal27(self):
        self.assertEqual(len(FEATURE_HASH), 64)
        self.assertEqual(len(FEATURE_ORDER), 27)
        self.assertEqual(FEATURE_HASH, feature_contract_hash())

    def test_ready_envelope_contains_scoped_snapshot_and_model_metadata(self):
        dataset, live, *_ = _fixture()
        _, envelope = _artifact()
        result = ridge_live_forecast(dataset=dataset, live=live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7,
            registry_loader=lambda **kwargs: envelope)
        self.assertEqual(result["status"], "READY")
        self.assertEqual(result["forecastStartDate"], "2026-10-16")
        self.assertEqual(result["forecastEndDate"], "2026-10-22")
        self.assertEqual(result["observationsThrough"], "2026-10-15")
        self.assertEqual(result["dataVersion"], "9")
        self.assertEqual(result["snapshotHash"], "a" * 64)
        self.assertEqual(result["activeModelStatus"], "ACTIVE")
        self.assertTrue(np.isfinite(result["predictionUnits"]))
        required = {"status", "horizonDays", "predictionUnits", "targetDefinition",
            "forecastStartDate", "forecastEndDate", "observationsThrough", "modelFamily",
            "recipeId", "modelVersion", "trainedAt", "trainedDataVersion", "dataCutoff",
            "featureVersion", "promotionPolicyVersion", "activeModelStatus", "dataVersion", "snapshotHash"}
        self.assertTrue(required.issubset(result))

    def test_feature_unavailable_response_is_structured_and_has_no_prediction(self):
        missing = THROUGH - timedelta(days=1)
        dataset, live, *_ = _fixture(missing_day=missing)
        _, envelope = _artifact()
        result = ridge_live_forecast(dataset=dataset, live=live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7,
            registry_loader=lambda **kwargs: envelope)
        self.assertEqual(result["status"], "FEATURE_UNAVAILABLE")
        self.assertEqual(result["reasonCode"], "FEATURE_UNAVAILABLE")
        self.assertIsNone(result["predictionUnits"])

    def test_frozen_bundle_fixture_does_not_repair_7d_14d_coherence(self):
        dataset, live, *_ = _fixture()
        body7, envelope7 = _artifact(horizon=7)
        body14, envelope14 = _artifact(horizon=14)
        body7["coefficients"] = [0.0] * len(body7["coefficients"])
        body14["coefficients"] = [0.0] * len(body14["coefficients"])
        body7["intercept"], body14["intercept"] = 7.0, 14.0
        for body, envelope in ((body7, envelope7), (body14, envelope14)):
            raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
            envelope["artifactData"] = raw
            envelope["metadata"]["artifactBytes"] = len(raw)
            envelope["metadata"]["artifactHash"] = hashlib.sha256(raw).hexdigest()
        result7 = ridge_live_forecast(dataset=dataset, live=live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=7,
            registry_loader=lambda **kwargs: envelope7)
        result14 = ridge_live_forecast(dataset=dataset, live=live, business_id=BUSINESS,
            scenario_id=SCENARIO_ID, sku=SKU, horizon_days=14,
            registry_loader=lambda **kwargs: envelope14)
        self.assertEqual(result7["predictionUnits"], 7.0)
        self.assertEqual(result14["predictionUnits"], 14.0)
        self.assertLessEqual(result7["predictionUnits"], result14["predictionUnits"])


if __name__ == "__main__":
    unittest.main()
