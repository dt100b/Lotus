# Local Runbook

## System Map

- Phase 1 raw ingestion:
  `project/scripts/backfill_phase1.py`
  writes `raw_instruments`, `raw_trades`, `ingest_runs`, `backfill_jobs`, and `backfill_cursors` into SQLite.
- Phase 2 normalization:
  handled inside `project/pipeline/dashboard_snapshot.py`
  using `normalizer/`.
- Phase 3 ledger replay:
  handled inside `project/pipeline/dashboard_snapshot.py`
  using `ledger/`.
- Phase 4 GEX:
  handled inside `project/pipeline/dashboard_snapshot.py`
  using live Deribit ticker greeks or a frozen greeks JSON.
- Phase 5 dashboard/API:
  `uvicorn project.api.main:app`
  reads `project/greeks/data/latest_gex_snapshot.json`.

## Startup Order

1. Create a Python 3.11+ virtual environment and install the package.
2. Populate or refresh the Phase 1 SQLite database.
3. Materialize the Phase 5 snapshot file from that database.
4. Start the FastAPI server.
5. For a live-ish local terminal, keep a refresher worker running in a second terminal.

## Fresh Setup

From the repo root:

```powershell
python -m venv .venv
. .\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e .[dev]
```

Optional environment file:

```powershell
Copy-Item .env.example .env
```

## One-Shot Bring-Up Using Live Deribit Data

Populate a rolling three-hour database window and build the dashboard snapshot:

```powershell
python project/scripts/refresh_dashboard_live.py --once --db-path project/data/phase1.sqlite3 --artifacts-dir project/runtime/dashboard_build --snapshot-path project/greeks/data/latest_gex_snapshot.json --lookback-minutes 180
```

Start the API:

```powershell
python -m uvicorn project.api.main:app --host 127.0.0.1 --port 8000
```

Open:

```text
http://127.0.0.1:8000/dashboard
```

## Continuous Local Refresh

Terminal 1:

```powershell
python project/scripts/refresh_dashboard_live.py --db-path project/data/phase1.sqlite3 --artifacts-dir project/runtime/dashboard_build --snapshot-path project/greeks/data/latest_gex_snapshot.json --lookback-minutes 180 --interval-seconds 30
```

Terminal 2:

```powershell
python -m uvicorn project.api.main:app --host 127.0.0.1 --port 8000
```

## Manual Layer-by-Layer Commands

Raw DB summary:

```powershell
python project/scripts/inspect_phase1_db.py --db-path project/data/phase1.sqlite3
```

Manual Phase 1 backfill for a fixed window:

```powershell
python project/scripts/backfill_phase1.py --start 2026-04-25T00:00:00Z --end 2026-04-26T00:00:00Z --db-path project/data/phase1.sqlite3 --job-name btc_options_2026_04_25
```

Materialize the dashboard snapshot from an existing DB:

```powershell
python project/scripts/materialize_dashboard_snapshot.py --db-path project/data/phase1.sqlite3 --artifacts-dir project/runtime/dashboard_build --snapshot-path project/greeks/data/latest_gex_snapshot.json
```

Validation pass with replay, snapshot math, expiry filtering, determinism, and optional live Deribit sample-window checks:

```powershell
python project/scripts/validate_dashboard_pipeline.py --db-path project/data/phase1.sqlite3 --artifacts-dir project/runtime/validation_build --snapshot-path project/runtime/validation_build/latest_gex_snapshot.json --validate-remote
```

This writes `project/runtime/validation_build/validation_report.json` and will fail the history audit by default unless the raw trade window spans at least 24 hours.

## Verification Commands

API health:

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:8000/api/v1/health -UseBasicParsing | Select-Object -ExpandProperty Content
```

Expiry list:

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:8000/api/v1/expiries -UseBasicParsing | Select-Object -ExpandProperty Content
```

Net GEX profile:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/v1/gex-profile?expiry=ALL&view=net" -UseBasicParsing | Select-Object -ExpandProperty Content
```

Local tests:

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'
python -m pytest -q
```

## What Good Looks Like

- `inspect_phase1_db.py` shows non-zero `raw_instruments_count` and `raw_trades_count`.
- `materialize_dashboard_snapshot.py` reports non-zero `inventory_row_count` and `snapshot_row_count`.
- `/api/v1/health` returns `200` with `row_count > 0`.
- `/api/v1/gex-profile?expiry=ALL&view=net` returns `points` with length greater than zero.
- `/dashboard` shows spot, freshness, contract, expiries, and visible strikes.

## Troubleshooting

- `503 Snapshot file not found`:
  run `materialize_dashboard_snapshot.py` or `refresh_dashboard_live.py --once` before starting the API.
- Empty `raw_trades`:
  widen the lookback window in `refresh_dashboard_live.py` or rerun `backfill_phase1.py` with a larger fixed window.
- `pytest` crashes before running local tests:
  set `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` because global pytest plugins on the machine may interfere.
- Snapshot turns stale quickly:
  this is expected unless the refresh worker is running. Start `refresh_dashboard_live.py` in a second terminal.
- Script import errors from the repo root:
  the repaired scripts are meant to be run exactly as shown above from the repository root.
