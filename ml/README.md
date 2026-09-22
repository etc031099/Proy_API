# ML data pipeline

This directory contains the reproducible data preparation pipeline for the
Inventory & Billing Management System. ML-R2A handles only the real public M5
source, profiling and a one-store bronze table. It does not train models,
generate synthetic operational records or write to MongoDB.

## Source and license

The primary source is the Kaggle **M5 Forecasting Accuracy** competition:

https://www.kaggle.com/competitions/m5-forecasting-accuracy/data

The dataset is subject to the Kaggle competition rules. Accept those rules and
download the files through your own Kaggle account. Do not commit the original
files to this repository.

## Expected source files

After downloading `m5-forecasting-accuracy.zip`, extract these official files:

- `calendar.csv`
- `sell_prices.csv`
- `sales_train_validation.csv`
- `sales_train_evaluation.csv`
- `sample_submission.csv`

The pipeline prefers `sales_train_evaluation.csv` and falls back to the
validation file. It validates the actual schema instead of silently assuming
that every expected file is present.

Place the extracted CSV files directly in:

```text
ml/data/raw/m5/
```

Raw CSV files are immutable inputs. The pipeline reads and hashes them but
never edits or replaces them.

## Environment

From the repository root on Windows PowerShell:

```powershell
python -m venv ml/.venv
ml/.venv/Scripts/python.exe -m pip install -r ml/requirements.txt
```

Only DuckDB and psutil are required for ML-R2A. DuckDB performs streaming CSV
queries and writes Parquet without Pandas, Polars or PyArrow. Polars can be
added later only when ML-R3 has a concrete use for it.

## Configuration

`ml/config/base.toml` records the source, currencies, seven-day future horizon,
seed and paths. `selected_store = "auto"` lets the profiler produce a
deterministic recommendation. The bronze builder deliberately refuses `auto`:
after the first real profile, review the ranking and pin the chosen store ID in
the configuration.

The ranking does not simply choose the highest-volume store. It weights product
coverage, category diversity, day continuity, exact weekly price coverage,
non-zero observations, sales stability and closeness to median store volume.

## Profile M5

```powershell
ml/.venv/Scripts/python.exe -m ml.src.ingest.profile_m5 --write-manifest
```

This command:

- verifies the expected schema;
- computes SHA-256 hashes and raw metadata;
- profiles files, calendar, sales and prices;
- ranks every store;
- profiles product rotation for the selected store;
- writes `ml/reports/m5_profile.json`;
- updates the small versionable `ml/data/raw/m5_manifest.json`.

The profile report records input hashes, elapsed time and peak process memory.

## Build bronze

```powershell
ml/.venv/Scripts/python.exe -m ml.src.normalize.build_bronze
```

The result is a single Zstandard-compressed Parquet file at:

```text
ml/data/bronze/m5_store_daily.parquet
```

Its grain is one `store_id + item_id + source_date` row. The original M5 date
is preserved. Sales are unpivoted from `d_*`, calendar data is joined exactly
through `d`, and weekly prices are joined exactly through
`store_id + item_id + wm_yr_wk`.

Missing prices remain null. The pipeline never forward-fills or back-fills
prices because an absent price may indicate that the product was not yet in the
assortment or was no longer offered.

The bronze columns are real M5 values plus two transparent projections:

- `has_sell_price`: whether the exact weekly price exists;
- `snap_active`: the SNAP flag corresponding to the store state.

Neither field is an ML feature yet.

## Zero-sales policy

`units_sold = 0` is not automatically interpreted as zero demand. It may mean:

- active product with no sale;
- product not introduced yet;
- product discontinued;
- unobserved stockout.

M5 does not provide inventory or explicit assortment status. A future
`is_active_assortment` may be derived conservatively from the interval bounded
by observed weekly prices, supported by first/last positive sale. It must be
labelled **derived**, and gaps inside that interval must remain distinguishable
from known active weeks. It is not used as a feature in ML-R2A.

## Generated and ignored data

The following remain outside Git:

- raw CSV/archives;
- bronze, silver, gold and operational datasets;
- model binaries;
- DuckDB temporary databases;
- the local virtual environment.

Source code, configuration, README files, tests and the small raw manifest are
versioned.

## Tests

Tests use a tiny hand-authored M5-shaped fixture; they do not generate an
operational scenario.

```powershell
ml/.venv/Scripts/python.exe -m unittest discover -s ml/tests -v
```

They cover schema enforcement, manifests and hashes, configured-store checks,
calendar/price joins, key uniqueness, raw immutability and deterministic bronze
output.

## Out of scope

ML-R2A does not create suppliers, customers, purchases, stock, credit,
cancellations or recent operational dates. It never connects to MongoDB and it
does not train or evaluate a machine-learning model.

## ML-R2B deterministic operational scenarios

ML-R2B projects a reproducible, operational sample over the real CA_3 demand
without changing Bronze. It uses no LLM or paid API. The generator reads
Parquet with DuckDB, keeps only one day of positive demand in memory, writes
UTF-8 NDJSON incrementally, validates it before publishing the file and creates
a small manifest with hashes, lineage, volume and resource measurements.

Available profiles are:

| Profile | Products | Source period | Purpose |
| --- | ---: | --- | --- |
| `demo` | 120 | 90 days | Fast demonstration and review |
| `normal` | 600 | 3 years | Operationally representative history |
| `large` | 1,200 | Full 1,941 days | Broad operational sample; ML Bronze remains all 3,049 products |
| `smoke` | 5 | 5 days | Importer compatibility only; deliberately elevated credit/cancellation coverage |

The counts are bounded deliberately: the future ML dataset remains the complete
5.9M product-day Bronze table, while Mongo receives a representative stratified
sample rather than one document per product-day. Sampling crosses category,
rotation, intermittent demand and price level, using the configured seed.

Generate and validate a profile from the repository root:

```powershell
ml/.venv/Scripts/python.exe -m ml.src.scenario.generator --config ml/config/scenario_demo.toml
ml/.venv/Scripts/python.exe -m ml.src.scenario.validation --config ml/config/scenario_demo.toml
```

Existing output is never overwritten without `--overwrite`. Generated NDJSON
under `ml/data/operational/` remains ignored. The versionable manifest is
written under `ml/reports/` only after validation succeeds.

### Operational policies

- IDs, assignments, tickets and dates are deterministic for identical config
  and Bronze hashes. `source_date` remains in each M5 sale note and
  `operational_date` uses a configured whole-week offset, preserving weekday,
  spacing and seasonality without producing future dates.
- Suppliers and synthetic customers are created before use. Product activation
  is progressive, based on first price/sale evidence. Names and phone identifiers
  are explicitly synthetic and are not real PII.
- A product starts at stock zero. Initial, planned and emergency receipts are
  purchase transactions using the configured canonical supplier cost. Internal
  order dates and lead time are simulation state only because the current app
  persists a purchase at receipt.
- Daily M5 units are split into category-affine, multi-line tickets without
  changing product/day totals. Emergency receipts preserve demand and prevent
  negative stock.
- Product price is the median source price in the selected period, converted
  once from USD to PEN with configured FX. Weekly M5 price remains in Bronze;
  the current backend has no price-history model, so ML-R2B does not invent one.
- Costs use a configured rotation-class margin plus a small deterministic
  supplier variation, always positive and below sale price.
- Credit is limited to registered credit-enabled customers. Partial payments
  occur after sales and never exceed debt; some balance intentionally remains
  open for demonstrations.
- Cancellations are additional synthetic cash sales followed by a reversal.
  Therefore completed, non-cancelled M5-labelled sales still reconcile exactly
  to real demand.

Rotation calculated over the selected simulation period may size operational
stock. It is labelled future-aware simulation metadata and must never become a
forecast feature. Future Gold features must be causal and remain principally
M5-based; synthetic customer/vendor attributes are excluded.

### Validation gate and import

The validator checks causal order, references, supplier relationships, positive
prices/costs, non-negative stock, credit/payment arithmetic, cancellations,
ObjectIds, event IDs, timezone-aware timestamps and exact M5 product/day demand.
Failure returns a non-zero exit and does not publish the temporary NDJSON.
Every generated event also carries the configured `scenarioId`; validation
rejects a mixed or incorrectly labelled file.

ML-R2C performs the independent final review and builds the versionable NORMAL
presentation summary after verifying the Bronze, raw-manifest, configuration
and NDJSON hashes:

```powershell
ml/.venv/Scripts/python.exe -m ml.src.scenario.validation --config ml/config/scenario_normal.toml
ml/.venv/Scripts/python.exe -m ml.src.scenario.report --config ml/config/scenario_normal.toml --output ml/reports/scenario_normal_summary.md
```

The summary and manifest distinguish the complete 5,918,109-row ML Bronze
dataset from the NORMAL Mongo operational sample. They report demand and stock
reconciliation, expected inventory movements, suppliers, customer segments,
credit, cancellations, dates, field-level provenance and known limitations.

Generation does not connect to MongoDB. After human approval, an isolated smoke
file may be passed to the existing importer and then reset explicitly:

```powershell
ml/.venv/Scripts/python.exe -m ml.src.scenario.generator --config ml/config/scenario_smoke.toml
cd backend
npm run import:historical-scenario -- --file=../ml/data/operational/scenario_smoke.ndjson --business-id=ML_R2B_SMOKE --scenario-id=m5-ca3-smoke-v1
npm run reset:historical-scenario -- --business-id=ML_R2B_SMOKE --scenario-id=m5-ca3-smoke-v1
```

Use only a test replica set for the smoke import. Demo, normal and large are not
imported automatically.

## ML-PREP and future cloud model

ML-PREP is operational-history preparation, not feature engineering or model
training. Its future end-to-end flow is:

```text
M5 -> Bronze -> operational scenario -> Gold/features -> train -> evaluate
   -> ml/models/demand_forecast_v1.joblib -> Cloud ML API -> Node backend -> UI
```

The first forecast model will continue to use M5 demand, lags, rolling statistics,
calendar, price, events/promotions and category. `InventoryMovement` is an
operational audit log, not an automatic ML feature. Forecasting returns a
consultative `predictedDemand7d`; a separate operational rule combines that demand
with current stock to obtain `recommendedReorderQuantity`.

ML-R4 should persist the complete compatible scikit-learn preprocessing + estimator
pipeline in `ml/models/demand_forecast_v1.joblib`, plus `model_metadata.json` with
model version, training time, dataset hashes/version, feature names, target,
horizon, train/validation/test periods, metrics and library versions.

The initial deployment assumption is reproducible local training and cloud
inference, while keeping scripts portable enough for later cloud training. The
cloud service will use Python + FastAPI with conceptual `GET /health`,
`GET /model-info` and `POST /predict` endpoints. Only Node/Express may call it:

```text
Frontend -> Node backend -> Cloud ML API + joblib -> Node backend -> Frontend
```

Forecast failure must never block login, sales, purchases or inventory. A later
Node integration will use a deterministic baseline when the cloud service is
unavailable. No `.joblib`, FastAPI service, deployment or fallback implementation
is part of ML-PREP.
