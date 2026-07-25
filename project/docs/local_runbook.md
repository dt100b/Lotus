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
  reads `project/greeks/data/latest_gex_snapshot.json` and serves the built
  Vite frontend from `frontend/dist` when present.
- Phase 6 live ops:
  production-depth historical backfill into
  `project/data/phase1_history.sqlite3`, continuous
  `refresh_dashboard_live.py`, and the Vite terminal defaulting to live
  `/api/v1/terminal-snapshot`. See `project/docs/phase6_live_ops.md`.

For agent-facing architecture, methodology, invariants, and task boundaries,
start with `project/docs/agent_handbook.md`.

## Startup Order

1. Create a Python 3.11+ virtual environment and install the package.
2. Populate a production-depth Phase 1 database (`phase1_history.sqlite3`) via
   historical backfill (Phase 6). Do not rely on the thin prototype DB alone.
3. Materialize the Phase 5 snapshot file from that database.
4. Start the FastAPI server.
5. Keep the Phase 6 live refresher running in a second terminal.

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

**Preferred (Phase 6):** use a history-backed DB so dealer inventory has depth.
If `phase1_history.sqlite3` is empty, run historical backfill first (see below).

Populate recent trades on the history DB and build the dashboard snapshot:

```powershell
python project/scripts/refresh_dashboard_live.py --once --db-path project/data/phase1_history.sqlite3 --artifacts-dir project/runtime/dashboard_build --snapshot-path project/greeks/data/latest_gex_snapshot.json --lookback-minutes 180
```

Prototype-only smoke (thin DB, not production-depth inventory):

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

The `/dashboard` route serves the production Vite terminal after
`npm run build` has produced `frontend/dist`. If no build exists, it falls back
to the old holding page. The previous static dashboard is archived at:

```text
http://127.0.0.1:8000/legacy-dashboard
```

## Continuous Local Refresh (Phase 6)

Terminal 1 (history-backed live worker):

```powershell
python project/scripts/refresh_dashboard_live.py --db-path project/data/phase1_history.sqlite3 --artifacts-dir project/runtime/dashboard_build --snapshot-path project/greeks/data/latest_gex_snapshot.json --job-name btc_options_live_phase6 --lookback-minutes 180 --interval-seconds 120

# Live materialize defaults to --materialize-mode auto (inventory checkpoint).
# Sync start self-heals from MAX(raw_trades.timestamp_ms) when the worker was
# down longer than lookback (capped at ~20h on the main host).
# Force a full YTD replay only after methodology bumps or checkpoint issues:
# python project/scripts/refresh_dashboard_live.py --once --materialize-mode full ...
#
# Prefer a supervised process in production (see project/docs/phase6_live_ops.md §2b):
#   Linux:  deploy/lotus-live-refresh.service
#   Docker: deploy/docker-compose.live.yml
#   Windows: deploy/windows/Register-LotusLiveRefresh.ps1
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

Manual Phase 1 backfill for a fixed window (trades via history host by default):

```powershell
python project/scripts/backfill_phase1.py --start 2026-04-25T00:00:00Z --end 2026-04-26T00:00:00Z --db-path project/data/phase1.sqlite3 --job-name btc_options_2026_04_25
```

Re-open empty completed chunks after switching to the history host:

```powershell
python project/scripts/backfill_phase1.py --start <UTC-start> --end <UTC-end> --db-path project/data/phase1_history.sqlite3 --job-name btc_options_history_<label> --reset-empty-cursors
```

Production-depth **YTD** historical workflow (default ship bar), isolated from the prototype DB:

```powershell
python project/scripts/historical_backfill.py --db-path project/data/phase1_history.sqlite3 --validate-remote
```

Optional full public history (custom start, dedicated job name):

```powershell
python project/scripts/historical_backfill.py --start 2019-01-01T00:00:00Z --db-path project/data/phase1_history.sqlite3 --job-name btc_options_history_full --validate-remote
```

Rerun validation/materialization against an existing historical DB:

```powershell
python project/scripts/historical_backfill.py --skip-backfill --db-path project/data/phase1_history.sqlite3
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

The historical workflow writes `project/runtime/history_validation/validation_report.json`
and defaults to a **YTD** coverage threshold (span of 1 Jan UTC → now, minus 24h slack).

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

Terminal snapshot:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/v1/terminal-snapshot?expiry=ALL" -UseBasicParsing | Select-Object -ExpandProperty Content
```

Local tests:

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'
python -m pytest -q
```

## What Good Looks Like

- `inspect_phase1_db.py` shows non-zero `raw_instruments_count` and `raw_trades_count`.
- Historical validation reports no duplicate trade groups, no invalid taker sides,
  no missing `amount` values, no missing Greeks, and deterministic rematerialization.
- `materialize_dashboard_snapshot.py` reports non-zero `inventory_row_count` and `snapshot_row_count`.
- `/api/v1/health` returns `200` with `row_count > 0`.
- `/api/v1/gex-profile?expiry=ALL&view=net` returns `points` with length greater than zero.
- `/legacy-dashboard` shows the archived prototype dashboard; `/dashboard`
  shows the production terminal when `frontend/dist` exists.

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
