"""Internal worker-only Inventory comparison, using persisted P7/P14 and one context.

No model loader, scoring, database connection, training, or public route.
"""
from __future__ import annotations
import json
import math
import re
import sys
from types import SimpleNamespace

from ml.service.v3_ridge_prediction_impact import load_audit_context
from ml.service.v3_live_inventory_supplier import LiveInventorySupplierAdapter
from ml.src.inventory_intelligence_v3 import InventoryIntelligenceV3
from ml.src import business_customer_supplier_v3 as m68


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def compare_inventory(adapter, live, prediction):
    pin = prediction['snapshot']
    products = pin['products']
    skus = [p['sku'] for p in products]
    details = prediction['detail']
    if (not 0 < len(skus) <= 200 or len(set(skus)) != len(skus)
            or len(details) != len(skus) or {r['sku'] for r in details} != set(skus)):
        raise ValueError('INVENTORY_IMPACT_INVALID')
    versions = {h['horizonDays']: h for h in prediction['versions']}
    by_sku = {r['sku']: r for r in details}
    output = {'predictionIdentity': prediction['idempotencyKey'], 'snapshotHash': pin['snapshotHash'],
        'dataVersion': pin['dataVersion'], 'asOf': pin['asOf'],
        'observationsClosedThrough': pin['observationsClosedThrough'], 'skuUniverse': skus,
        'ranking': {'metric': 'stockout_risk'}}
    for side, field, version_field in [('before', 'old', 'beforeVersion'), ('after', 'new', 'afterVersion')]:
        forecasts = []
        for sku in skus:
            p = by_sku[sku]
            p7, p14 = p['p7'][field], p['p14'][field]
            ready7, ready14 = _number(p7), _number(p14)
            forecasts.append({'sku': sku, 'expectedUnitsNext1d': None,
                'expectedUnitsNext7d': p7 if ready7 else None, 'expectedUnitsNext14d': p14 if ready14 else None,
                'horizon7Status': 'READY' if ready7 else 'MODEL_UNAVAILABLE',
                'horizon14Status': 'READY' if ready14 else 'MODEL_UNAVAILABLE',
                'status': 'READY' if ready7 and ready14 else 'PARTIAL',
                'modelVersion7': versions[7][version_field], 'modelVersion14': versions[14][version_field],
                'cutoffDate': pin['observationsClosedThrough']})
        def request(mode):
            return SimpleNamespace(mode=mode, skus=skus, limit=len(skus), offset=0,
                risk=None, abc=None, xyz=None, flag=None, metric='stockout_risk')
        data, _ = adapter.inventory_data(request('detail'), live, forecasts)
        ranked, _ = adapter.inventory_data(request('rank'), live, forecasts)
        rows = []
        for item in data['items']:
            risk, reco, policy, coverage = [item[k] for k in ('risk', 'recommendation', 'inventoryPolicy', 'coverage')]
            reasons = set(risk.get('reasonCodes', []))
            for section in (risk, reco, policy, coverage, item['stock'], item['demand']):
                if section.get('reasonCode'):
                    reasons.add(section['reasonCode'])
            reasons = sorted(reasons)
            if len(reasons) > 32 or any(not re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', code) for code in reasons):
                raise ValueError('INVENTORY_IMPACT_INVALID')
            row = {'sku': item['sku'], 'risk': risk.get('level'), 'shouldReorder': reco.get('shouldReorder'),
                'recommendedQty': reco.get('recommendedQty'), 'reorderPoint': policy.get('reorderPoint'),
                'daysCover': coverage.get('daysCover'), 'reasonCodes': reasons}
            row['availability'] = 'AVAILABLE' if (row['risk'] is not None
                and row['shouldReorder'] is not None and all(row[k] is not None
                    for k in ('recommendedQty', 'reorderPoint', 'daysCover'))
                and all(s.get('availabilityStatus', s.get('status', 'AVAILABLE')) == 'AVAILABLE'
                    for s in (risk, reco, coverage))) else 'PARTIAL'
            rows.append(row)
        output[side] = rows
        output['ranking'][side] = [item['sku'] for item in ranked['items']]
    return output


def evaluate(payload):
    prediction = payload['prediction']
    pin = prediction['snapshot']
    root, dataset, records, live = load_audit_context(payload['snapshot'], pin,
        len(json.dumps(payload).encode()))
    meta = payload['snapshot']['metadata']
    if (meta['snapshotHash'] != pin['snapshotHash'] or str(meta['dataVersion']) != pin['dataVersion']
            or meta['asOfDate'] != pin['asOf'] or meta['observationsClosedThrough'] != pin['observationsClosedThrough']
            or meta['capturedAtUtc'] != pin['capturedAtUtc']):
        raise ValueError('SNAPSHOT_MISMATCH')
    definitions = root / 'data/minimarket-pasco-v3'
    def read(name):
        return json.loads((definitions / name).read_text(encoding='utf-8'))
    inventory_static = {'products': read('products.json')['catalog'],
        'suppliers': read('suppliers.json')['suppliers'], 'offers': read('supplier-offers.json')}
    static = m68._load_static(root)
    business = m68.BusinessIntelligenceV3(root, records, static)
    suppliers = m68.SupplierIntelligenceV3(root, records, static, business)
    inventory = InventoryIntelligenceV3(root, dataset=dataset, operational_records=records, static_data=inventory_static)
    adapter = LiveInventorySupplierAdapter(records, inventory_static, inventory, suppliers)
    return compare_inventory(adapter, live, prediction)


if __name__ == '__main__':
    try:
        raw = sys.stdin.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError()
        print(json.dumps({'ok': True, 'result': evaluate(json.loads(raw))}, allow_nan=False))
    except Exception:
        print(json.dumps({'ok': False, 'code': 'INVENTORY_IMPACT_NOT_CAPTURED'}))
