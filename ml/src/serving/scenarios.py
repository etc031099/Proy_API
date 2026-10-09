"""Closed shared registry, also read by Node. No request-selected paths."""
import json
from types import MappingProxyType
from ml.src.common import repository_path

SCENARIOS = MappingProxyType({key: MappingProxyType(value) for key, value in
    json.loads(repository_path("backend/src/config/mlScenarios.json").read_text(encoding="utf-8")).items()})


def validate_lineage(builder, scenario):
    manifest = builder.manifest
    expected = {"business_id": scenario["businessId"], "scenario_id": scenario["scenarioId"],
        "source_anchor": scenario["sourceAnchor"], "operational_anchor": scenario["anchorOperationalDate"],
        "date_offset_days": scenario["offsetDays"], "products_count": scenario["productsCount"],
        "store_id": scenario["store"], "lineage_version": scenario["lineageVersion"]}
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError("Registered lineage identity/range differs from manifest")
    if builder.contract["feature_set_version"] != scenario["featureSet"] or len(builder.contract["feature_order"]) != scenario["featuresCount"]:
        raise ValueError("Registered feature contract mismatch")
