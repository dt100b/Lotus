# Phase 6 Live Operations Contract

Current contract version: `phase6.live.v1`.

Phase 6 is the **operations and presentation-integration** layer that keeps a
validated Phase 5 snapshot fresh from Deribit and serves it to the production
Vite terminal. It does not change taker-flow inventory rules or GEX math.

## Boundary

| Phase | Responsibility |
|-------|----------------|
| 1–4 | Ingest, normalize, replay dealer inventory, compute GEX |
| 5 | Read-only snapshot API + terminal presentation contract |
| **6** | Historical depth, continuous refresh, live frontend default |

Phase 6 may:

- Backfill and append raw Deribit option trades into SQLite.
- Re-run the existing materialization pipeline to rewrite
  `project/greeks/data/latest_gex_snapshot.json`.
- Serve that snapshot through Phase 5 endpoints to the live frontend.

Phase 6 may **not**:

- Infer dealer signs from call/put type.
- Recompute inventory or GEX inside the frontend.
- Bypass Phase 5 validation of snapshot shape.

## Why Historical Depth Matters

Dealer inventory is the **cumulative** mirror of taker flow. A rolling 2–3 hour
lookback alone cannot reconstruct the book. Phase 6 therefore requires:

1. At least **year-to-date (YTD)** Phase 1 trade history from Deribit public
   APIs, stored in `phase1_history.sqlite3` (full history optional later).
2. A continuous live refresher that **appends** new trades and rematerializes
   the Phase 5 snapshot.
3. A frontend that defaults to `GET /api/v1/terminal-snapshot` (live mode).

### Deribit dual-host trade access

Deribit exposes two public hosts for trades:

| Host | Env | Use |
|------|-----|-----|
| `https://www.deribit.com/api/v2` | `DERIBIT_BASE_URL` | Instruments, live rolling append |
| `https://history.deribit.com/api/v2` | `DERIBIT_HISTORY_BASE_URL` | Deep historical backfill (YTD default; full history optional) |

The **main** host only retains roughly the last **~24 hours** of public trades
in its hot store. Older windows return empty pages there.

The **history** host serves the full public trade archive (same method:
`public/get_last_trades_by_currency_and_time`, `include_old=true`,
`kind=option`). It accepts larger pages (`DERIBIT_HISTORY_PAGE_SIZE`, default
10000) and typically returns `has_more` **without** a native `continuation`
token — the collector advances via synthetic `ts:<timestamp>` resume cursors
(`last_trade_timestamp + 1`).

Implications:

- Historical depth comes from **history.deribit.com** via
  `historical_backfill.py` / `backfill_phase1.py` (enabled by default with
  `DERIBIT_USE_HISTORY_FOR_BACKFILL=true`).
- Continuous live refresh still uses the **main** host for the short rolling
  window; it keeps the book current between deep backfills.
- If you previously backfilled older windows against the main host, those
  chunks may be marked `completed` with `fetched_rows=0`. Re-run with
  `--reset-empty-cursors` and/or a new `--job-name` against the history host.


## Canonical Live Paths

| Artifact | Path |
|----------|------|
| Live raw DB | `project/data/phase1_history.sqlite3` |
| Intermediate build | `project/runtime/dashboard_build/` |
| Phase 5 snapshot (API input) | `project/greeks/data/latest_gex_snapshot.json` |
| Production inventory checkpoint | `project/runtime/dashboard_build/inventory_checkpoint.json` |
| History validation report | `project/runtime/history_validation/validation_report.json` |

### Include-OTC secondary GEX (archived / dormant)

Not used by the live desk. Dual materialize is **off by default**
(`enable_include_otc_secondary=False`). Code and restore steps:
`project/docs/archived_include_otc_prints.md`.

The thin prototype DB `project/data/phase1.sqlite3` remains for smoke tests only.
Do not point the production live worker at it unless it has been replaced by a
history-backed copy.

## Operator Workflow

### 1. Historical backfill (resumable, history host)

Deep backfill routes trades through `history.deribit.com` by default. Instruments
still load from the main host.

**Ship minimum: year-to-date (YTD).** Defaults on `historical_backfill.py` are
`start=1 Jan UTC` of the current year, `end=now`, job
`btc_options_history_ytd_<year>`, and a matching coverage audit threshold.

```powershell
# YTD ship bar (defaults)
python project/scripts/historical_backfill.py `
  --db-path project/data/phase1_history.sqlite3 `
  --validate-remote
```

Optional full public history (when far-dated inventory needs more depth):

```powershell
python project/scripts/historical_backfill.py `
  --start 2019-01-01T00:00:00Z `
  --end <UTC-now> `
  --db-path project/data/phase1_history.sqlite3 `
  --job-name btc_options_history_full `
  --minimum-history-hours <hours-in-window> `
  --validate-remote
```

Direct Phase 1 CLI (same dual-host wiring), with empty-cursor recovery:

```powershell
python project/scripts/backfill_phase1.py `
  --start <UTC-start> `
  --end <UTC-end> `
  --db-path project/data/phase1_history.sqlite3 `
  --job-name btc_options_history_<label> `
  --reset-empty-cursors
```

Skip fetch and only validate/materialize:

```powershell
python project/scripts/historical_backfill.py --skip-backfill --db-path project/data/phase1_history.sqlite3
```

### 2. Continuous snapshot refresh

```powershell
python project/scripts/refresh_dashboard_live.py `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/dashboard_build `
  --snapshot-path project/greeks/data/latest_gex_snapshot.json `
  --job-name btc_options_live_phase6 `
  --lookback-minutes 180 `
  --interval-seconds 120
```

One-shot prove-out:

```powershell
python project/scripts/refresh_dashboard_live.py --once `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/dashboard_build `
  --snapshot-path project/greeks/data/latest_gex_snapshot.json `
  --job-name btc_options_live_phase6 `
  --lookback-minutes 180
```

#### Live sync window (self-heal)

Each cycle starts trade fetch at:

```text
start_ms = max(
  min(now - lookback, DB MAX(timestamp_ms) - 1s),
  now - 20h   # main-host hot-store floor
)
end_ms = now
```

Multi-hour outages **self-heal** on the next run without a manual catch-up
window, as long as the gap is within ~20 hours (main host public retention).
Gaps beyond that still need `backfill_phase1.py` / `historical_backfill.py`
against `history.deribit.com`.

Cycle JSON includes `sync_window` (`sync_window_source`, `db_max_timestamp_ms`,
`start_ms`, `end_ms`) for ops visibility.

#### Explicit catch-up (history host)

When the worker was down longer than main-host retention, or you want a
validated history-host fill:

```powershell
python project/scripts/backfill_phase1.py `
  --start <DB-max-or-earlier> `
  --end <UTC-now> `
  --db-path project/data/phase1_history.sqlite3 `
  --job-name btc_options_catchup_<label>

python project/scripts/refresh_dashboard_live.py --once `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/dashboard_build `
  --snapshot-path project/greeks/data/latest_gex_snapshot.json `
  --job-name btc_options_live_phase6 `
  --lookback-minutes 30 `
  --materialize-mode auto
```

#### Materialize path

Live rematerialization uses a **lightweight + checkpointed incremental** path:

- Same dealer inventory math (taker-flow mirror rule; methodology versions
  unchanged).
- Skips multi-GB intermediate JSONL and prunes leftovers
  (`normalized_trades_phase2.jsonl`, `normalized_events_phase3.jsonl`,
  `position_deltas.jsonl`).
- Retains only checkpoint/genesis + final ledger snapshots.
- Fetches Greeks only for non-expired, non-zero inventory.
- Persists `project/runtime/dashboard_build/inventory_checkpoint.json` with the
  final dealer book + per-instrument `trade_seq` cursors (atomic temp+rename).
- Writes `latest_gex_snapshot.json` via atomic temp+rename (same pattern).
- Subsequent cycles load only trades at/after the watermark and apply them to
  the checkpoint instead of replaying the entire YTD history.

Default interval is 120s; default lookback is **180** minutes. With incremental
materialize the cycle is dominated by the trade append + live Greeks fetch, not
full-history CPU. Force a full rebuild after methodology version bumps or
suspected checkpoint corruption:

```powershell
python project/scripts/refresh_dashboard_live.py --once --materialize-mode full ...
```

Do not drop historical depth to “make it faster.”

### 2b. Process supervision (do not leave the loop unattended)

The refresher is a long-running process. Without a restart policy it stays dead
after logout, OOM, or crash — which is how multi-hour inventory lag appears.

| Host | How |
|------|-----|
| **Linux systemd** | `deploy/lotus-live-refresh.service` — edit paths, then `systemctl enable --now lotus-live-refresh` |
| **Docker** | `docker compose -f deploy/docker-compose.live.yml up -d` (`restart: unless-stopped`) |
| **Windows** | Elevated: `deploy\windows\Register-LotusLiveRefresh.ps1` (Scheduled Task, restart on failure + logon) |

Always pair the worker with the API process. After recovery, confirm:

1. `inspect_phase1_db.py` max trade near live Deribit time
2. checkpoint `max_timestamp_ms` matches DB max
3. `GET /api/v1/health` → `is_fresh: true`

### 3. API + terminal

```powershell
python -m uvicorn project.api.main:app --host 127.0.0.1 --port 8000
```

Frontend defaults to live mode. For local UI-only work:

```powershell
$env:VITE_LOTUS_DATA_MODE='mock'
```

Optional API base override:

```powershell
$env:VITE_LOTUS_API_BASE_URL='http://127.0.0.1:8000'
```

Production-style: `npm run build` in `frontend/`, then open
`http://127.0.0.1:8000/dashboard`.

## Live Data Map (Terminal Surfaces)

| Surface | Source |
|---------|--------|
| GEX bars, totals, zero gamma | Phase 5 snapshot via `/api/v1/terminal-snapshot` |
| Levels, rankings, OPEX events | Derived in Phase 5 repository from the same snapshot |
| Book stats / DVOL | Snapshot OI + live Deribit DVOL (best-effort) |
| Deribit index (Price panel) | Live Deribit `get_index_price` `btc_usd` (serve-time, ~10s cache) |
| Hyperliquid perp + basis | Live HL mid; basis = HL mid − live Deribit `btc_usd` index |
| Chart / Regime spot line | Same `live_index` (fallback snapshot `spot`) |
| Rankings / Levels DIST % | vs `live_index` when present; else snapshot `spot` |
| GEX bars / Flip methodology | Snapshot `spot_price` (materialize median; not revalued) |
| Heatmap OHLC | Direct Hyperliquid REST + WebSocket (presentation only) |
| Heatmap color field | Live strike GEX profile with a temporal presentation envelope |

## Freshness

- Frontend treats snapshots older than ~120 seconds as **stale** in the TopBar.
- `/api/v1/health` exposes `is_fresh` from snapshot age vs configured threshold.
- Stale data remains readable; the UI must not invent replacement GEX.

## Definition of Done (Phase 6.v1)

- History DB exists with **YTD** trade coverage from **history.deribit.com**
  (not only the last ~24h hot store). Full history is optional.
- Live refresher keeps `latest_gex_snapshot.json` current via main-host appends.
- API health returns `row_count > 0` and recent `as_of`.
- Vite terminal (or `/dashboard`) runs with connection status **live**, not mock.
- Methodology versions for Phases 2–4 remain unchanged unless explicitly bumped.
