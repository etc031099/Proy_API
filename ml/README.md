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
