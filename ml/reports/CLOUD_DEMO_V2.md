# CLOUD-DEMO v2 — local only

Scenario `m5-ca3-cloud-demo-v2`, business `ML-CLOUD-DEMO-V2`, seed 2026.
Source window: 2015-11-01 through 2016-05-15; operational window:
2025-11-02 through 2026-05-17. The unchanged offset is 3654 days.
The seven-day horizon ends at source 2016-05-22 / operational 2026-05-24.

## Reproduction

Using Python 3.12 with `ml/requirements.txt`, from the repository root:

```sh
python -m ml.src.scenario.cloud_demo_v2
python -m unittest ml.tests.test_cloud_demo_v2 -v
python -m unittest discover -s ml/tests -v
```

Generation refuses existing v2 outputs; it never overwrites v1. It requires
the existing verified large NDJSON/manifest, Bronze, Gold and official joblib.
Heavy operational/Gold files remain unversioned; artifact-dependent tests skip
explicitly in a lightweight clone. There is no automatic data download.

## Selection and provenance

The pool is the existing large scenario within CA_3. Exactly 60 real M5 items
are selected with quotas 8/8/12/8/8/8/8 for FOODS_1, FOODS_2, FOODS_3,
HOBBIES_1, HOBBIES_2, HOUSEHOLD_1, HOUSEHOLD_2. Stable seeded hashes break ties.
Selection covers observed status, rotation, demand, price, stock, quantity,
coverage and intermittence bins, including existing VIGILAR cases.
Only contract features and observed history up to the anchor are used;
neither target values nor TEST errors influence selection. This is a curated
demonstration, NOT a new accuracy evaluation or a representative sample.

Names use only M5 category/department/item metadata, not invented commercial
identities. Vendors, customers, purchases and payment policies remain synthetic
from the existing large scenario. No stock/prediction is altered to force status.

## Opening balances and transactions

The complete NDJSON contains bootstrap history from the existing large replay,
not only the latest window. Pre-window purchases/sales/cancellations are retained
for the selected items. Their net movements define each `openingStock`; no
arbitrary opening purchase or stock adjustment is added. Manifest counts clearly
separate full replay and window transactions. A cloud import of the entire
bootstrap is NOT authorized by this phase and its volume must be evaluated in R2.

Mixed tickets are projected to selected lines, empty tickets removed, IDs re-keyed
under v2, and cancellations refer to their projected sale. Totals are determined
from retained quantities and unchanged product/supplier prices, as in the existing
scenario import contract. Credit payments are rebuilt at the existing 70%/14-day
policy from reduced credit tickets, not copied from original customer amounts.
Pending cancellation exercises and events after the anchor are excluded. All
retained positive product-days (bootstrap AND window) reconcile with Bronze;
the existing validator checks debt, payments, references and nonnegative stock.

## Local serving validation

Lineage lives in `ml/data/serving/cloud_demo_v2/`. Business/scenario identity is
explicitly opted into by the local builder; public ModelRuntime still defaults
to v1. The model, hash, contract, 31 features and seven-day target are unchanged.
Serving features use projected sales in the 197-day window, not future demand.
The validation report records 60 READY, 60×31 Gold parity at tolerance 1e-5,
exact categories and prediction agreement. Forecasts remain historical replay.

See `scenario_cloud_demo_v2_manifest.json` for opening balances/provenance and
`scenario_cloud_demo_v2_validation.json` for actual distribution/statistics.
No Atlas, Render, Vercel, assistant, Gemini or RAG changes are part of v2-R1.

## Observed local comparison

| Indicator | v1 | v2 |
| --- | ---: | ---: |
| Operational anchor | 2025-07-01 | 2026-05-17 |
| Products / departments | 60 / 7 | 60 / 7, explicit quotas |
| OK / VIGILAR / REPONER | 52 / 0 / 8 | 24 / 3 / 33 |
| Forecast total (units / 7 days) | 738.43 | 712.74 |
| Suggested replenishment total | 445 | 543 |
| Forecast min / median / max | 0.59 / 3.25 / 267.54 | 0.46 / 7.34 / 73.13 |
| Forecast population standard deviation | 35.31 | 15.19 |
| Stock min / median / max | 4 / 13 / 79 | 0 / 10 / 68 |
| Sales / purchases in demo window | 2,425 / 626 | 5,940 / 763 |
| Transactions in 2026 | 0 | 4,728 |

V2 rotation: 24 low, 18 medium, 18 high; 24 intermittent products.
Observed window median-price bands: 20 low, 21 medium, 19 high.
Window median M5 price (USD) min/median/max: 0.23 / 3.48 / 20.97;
these are selection statistics, not replacements for operational prices.
Window units by department: 2,886 / 1,637 / 6,899 / 1,449 / 973 / 4,157 / 1,133
in quota order. Total window units: 19,134.

Opening stock reconstructed from prior movements totals 1,073 units.
The whole replay has 44,983 sales, 5,459 purchases, 71 cancellations and 1,531
recomputed payments (50,442 transactions). Bootstrap events begin 2021-01-14;
this earlier history is disclosed, not described as activity only in 2026.
Within the demo window: 12 cancellations and 208 payments. Forecast status
and stock comparisons refer to the anchor, not current cloud inventory.

The smaller forecast dispersion indicates less domination by a single outlier;
it does not establish greater model accuracy. Published v1 artifacts stay intact.
