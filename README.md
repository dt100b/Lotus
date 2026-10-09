# Lotus

Deribit BTC options **taker-flow GEX** terminal. Lotus rebuilds dealer inventory from public trade flow, attaches live Greeks, and serves a multi-pane desk UI for net gamma exposure by strike and expiry.

This is **not** open-interest GEX. Inventory comes from cumulative taker flow, not from residual OI sign heuristics.

## What you get

| Layer | Role |
|-------|------|
| Phase 1 | Raw Deribit instruments + trades into SQLite |
| Phase 2 | Normalize to canonical instruments/trades |
| Phase 3 | Replay taker flow → dealer inventory ledger |
| Phase 4 | Combine inventory + γ + spot → dollar GEX |
| Phase 5 | Read-only snapshot API + dashboard contract |
| Phase 6 | YTD+ history depth, continuous refresh, live terminal |

## Quick start (live desk)

For continuous ATM IV and skew collection on an always-on host, see
[Continuous worker hosting](docs/continuous_worker_hosting.md). For independent
supervision, start the dedicated collectors alongside the GEX refresher.
For a Google Cloud VM, use the [Google Cloud setup guide](docs/google_cloud_setup.md)
and its Ubuntu installer.

From the **repo root**, use two terminals after install and a history-backed DB (see [Historical backfill](#historical-backfill)).

**Terminal 1 — live refresher** (appends recent trades, rematerializes snapshot):

```powershell
python project/scripts/refresh_dashboard_live.py `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/dashboard_build `
  --snapshot-path project/greeks/data/latest_gex_snapshot.json `
  --job-name btc_options_live_phase6 `
  --lookback-minutes 30 `
  --interval-seconds 60
```

**Terminal 2 — API + dashboard:**

```powershell
python -m uvicorn project.api.main:app --host 127.0.0.1 --port 8000
```

Open:

```text
http://127.0.0.1:8000/dashboard
```

### Options Surface corpus (calibration evidence, not a backtest)

One-shot capture of the current book:

```powershell
python -m project.scripts.capture_options_surface --underlying BTC --expiry 2026-08-21
python -m project.scripts.capture_options_surface --underlying BTC --curated-expiries
```

Repeatable collector (disabled unless `LOTUS_SURFACE_COLLECT_ENABLED=true`):

```powershell
python -m project.scripts.collect_options_surface --once --enable
```

Analyze stored snapshots:

```powershell
python -m project.scripts.analyze_options_surface_corpus --input project/runtime/options_surface_snapshots
```

Windows wrapper: `deploy/windows/Run-LotusSurfaceCorpus.ps1`.
Constrained SVI remains a diagnostic candidate.

Health check:

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:8000/api/v1/health -UseBasicParsing | Select-Object -ExpandProperty Content
```

If port 8000 is already in use (Windows `WinError 10048`), stop the other process or use another port:

```powershell
netstat -ano | findstr :8000
# Stop-Process -Id <PID> -Force
python -m uvicorn project.api.main:app --host 127.0.0.1 --port 8001
```

---

## Fresh setup

**Requirements:** Python 3.11+, Node.js 20.19+ or 22.12+ (for the Vite terminal), network access to Deribit public APIs.

```powershell
# Python
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"

# Optional env (defaults work for local)
Copy-Item .env.example .env

# Frontend production build (served at /dashboard)
cd frontend
npm ci
npm run build
cd ..
```

Dev UI only (mock data, no API required):

```powershell
cd frontend
npm run dev
```

Live frontend mode is the default when the API serves `/dashboard` from `frontend/dist` with `VITE_LOTUS_DATA_MODE=live` (see `frontend/.env.production`).

---

## Historical backfill

Dealer inventory is **cumulative**. A few hours of trades cannot reconstruct the book. Production live path uses a dedicated history DB (not the thin prototype `phase1.sqlite3`).

| Host | Use |
|------|-----|
| `https://history.deribit.com/api/v2` | Deep trade archive (YTD / full history) |
| `https://www.deribit.com/api/v2` | Instruments + short rolling live append (~last day) |

**Ship minimum: year-to-date (YTD)** — defaults to 1 Jan UTC of the current year → now:

```powershell
python project/scripts/historical_backfill.py `
  --db-path project/data/phase1_history.sqlite3 `
  --validate-remote
```

This is resumable. Re-run the same command if interrupted. With `--validate-remote` it also materializes a validation snapshot and writes:

```text
project/runtime/history_validation/validation_report.json
```

Validate / rematerialize an existing DB without fetching more trades:

```powershell
python project/scripts/historical_backfill.py `
  --skip-backfill `
  --db-path project/data/phase1_history.sqlite3
```

Optional full public history:

```powershell
python project/scripts/historical_backfill.py `
  --start 2019-01-01T00:00:00Z `
  --db-path project/data/phase1_history.sqlite3 `
  --job-name btc_options_history_full `
  --validate-remote
```

Fixed window via Phase 1 CLI (history host by default):

```powershell
python project/scripts/backfill_phase1.py `
  --start 2026-01-01T00:00:00Z `
  --end 2026-01-08T00:00:00Z `
  --db-path project/data/phase1_history.sqlite3 `
  --job-name btc_options_history_week `
  --reset-empty-cursors
```

Inspect a DB:

```powershell
python project/scripts/inspect_phase1_db.py --db-path project/data/phase1_history.sqlite3
```

> **Note:** SQLite history files are large and **gitignored** (`project/data/*.sqlite3`). Each operator builds them locally via backfill.

---

## Live refresh details

One-shot prove-out (single cycle, then exit):

```powershell
python project/scripts/refresh_dashboard_live.py --once `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/dashboard_build `
  --snapshot-path project/greeks/data/latest_gex_snapshot.json `
  --lookback-minutes 30
```

Behavior:

- Appends trades for a rolling window (default **30** minutes), self-healing from the DB max trade time after short outages (capped by main-host retention ~20h).
- Rematerializes `project/greeks/data/latest_gex_snapshot.json` for the API.
- Default **`--materialize-mode auto`** uses an inventory checkpoint so deep history is not fully replayed every cycle.
- Force a full YTD replay after methodology changes or checkpoint issues:

```powershell
python project/scripts/refresh_dashboard_live.py --once --materialize-mode full `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/dashboard_build `
  --snapshot-path project/greeks/data/latest_gex_snapshot.json
```

Gaps longer than main-host retention need a history-host catch-up (`backfill_phase1.py` / `historical_backfill.py`), then another `--once` refresh.

Manual materialize from an existing DB:

```powershell
python project/scripts/materialize_dashboard_snapshot.py `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/dashboard_build `
  --snapshot-path project/greeks/data/latest_gex_snapshot.json
```

Supervised process helpers (optional): `deploy/` (Linux systemd, Docker Compose, Windows register script). See `project/docs/phase6_live_ops.md`.

---

## How inventory and GEX work

### Inventory reconstruction (Phase 3)

1. Public Deribit option trades are stored immutably in SQLite (deduped by instrument + trade id).
2. Trades are normalized and ordered for replay (`trade_seq`, timestamp, event id).
3. **Taker side** is the end-user side of each print. Dealer inventory is the **mirror**:
   - taker **buy** → dealer inventory **decreases** by trade `amount`
   - taker **sell** → dealer inventory **increases** by trade `amount`
4. Production policy uses **listed single-leg** flow only. Block and combo prints stay in the raw/audit path but are excluded from v1 inventory.
5. Signs are **never** inferred from call vs put type. Path-dependent flow builds the book; there is no OI-based flip of puts.

Inventory is therefore smaller and more path-dependent than naive open-interest GEX dashboards. That is expected: opposing buy/sell flow nets out.

### GEX engine (Phase 4)

For each instrument with non-zero inventory and live (or frozen) Greeks:

```text
position_gamma = net_contracts × contract_multiplier × gamma
dollar_gex_per_1% = position_gamma × spot² × 0.01
```

Rows aggregate to strike and expiry profiles (call / put / net). Missing Greeks on active names are treated as release blockers; expired names without Greeks are skipped.

The API does **not** recompute inventory or GEX. It serves the last validated snapshot (`latest_gex_snapshot.json`) to the terminal (`/api/v1/terminal-snapshot`, `/api/v1/gex-profile`, heatmap surface, etc.).

### Canonical live paths

| Artifact | Path |
|----------|------|
| Live raw DB | `project/data/phase1_history.sqlite3` |
| Build / checkpoint | `project/runtime/dashboard_build/` |
| Snapshot (API input) | `project/greeks/data/latest_gex_snapshot.json` |
| Thin prototype DB | `project/data/phase1.sqlite3` (smoke only) |

---

## Useful API routes

| Route | Purpose |
|-------|---------|
| `GET /api/v1/health` | Snapshot freshness + row count |
| `GET /api/v1/expiries` | Expiry filter list |
| `GET /api/v1/gex-profile?expiry=ALL&view=net` | Net GEX profile |
| `GET /api/v1/terminal-snapshot?expiry=ALL` | Full terminal payload |
| `GET /api/v1/gex-heatmap-surface` | Heatmap surface |
| `GET /dashboard` | Production Vite terminal (needs `frontend/dist`) |
| `GET /docs` | OpenAPI UI |

---

## Tests and validation

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = "1"
python -m pytest -q
```

Pipeline validation (replay, snapshot math, optional live sample window):

```powershell
python project/scripts/validate_dashboard_pipeline.py `
  --db-path project/data/phase1.sqlite3 `
  --artifacts-dir project/runtime/validation_build `
  --snapshot-path project/runtime/validation_build/latest_gex_snapshot.json `
  --validate-remote
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `WinError 10048` on port 8000 | Another process (often leftover uvicorn) is bound; kill it or change port |
| `503 Snapshot file not found` | Run `refresh_dashboard_live.py --once` or `materialize_dashboard_snapshot.py` before the API |
| Empty / thin GEX | Need YTD+ history in `phase1_history.sqlite3`, not only a short lookback |
| Snapshot goes stale | Keep the live refresher running in a second terminal |
| Empty historical chunks | Main host only keeps ~1 day of trades; use history host + `--reset-empty-cursors` |
| `pytest` crashes oddly | Set `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` |

---

## Documentation

| Doc | Contents |
|-----|----------|
| `project/docs/local_runbook.md` | Full local operator commands |
| `project/docs/phase6_live_ops.md` | Live ops, dual-host Deribit, checkpoints |
| `project/docs/agent_handbook.md` | Architecture, invariants, methodology boundaries |
| `project/docs/phase5_dashboard_contract.md` | Snapshot / API contract |
| `project/PHASE1_RAW_SCHEMA_CONTRACT.md` | Raw SQLite schema |
| `project/docs/phase3_schema_contract.md` | Ledger schema |

---

## What is not in git

Large and local-only artifacts are ignored (see `.gitignore`):

- `project/data/*.sqlite3` (history and prototype DBs)
- `project/runtime/` (build artifacts, checkpoints)
- `runtime/` (local audit captures and screenshots; existing frozen diagnostics stay tracked)
- `.env`, `.venv/`, `frontend/node_modules/`, `*.zip`

Rebuild data with the backfill and refresh scripts above.
