# Lotus Agent Handbook

This is the operating guide for agents working on Lotus, a Deribit BTC options
Gamma Exposure terminal. Read this before changing backend behavior.

## Methodology

Lotus uses a taker-flow-based GEX methodology inspired by Glassnode's crypto
options GEX research. The core modeling assumption is:

- Deribit trade `direction` is the taker side.
- The taker is treated as end-user flow.
- Dealer inventory is the mirror image of cumulative taker flow.
- Taker `buy` means dealer inventory decreases by trade `amount`.
- Taker `sell` means dealer inventory increases by trade `amount`.

This is intentionally not an open-interest heuristic. Do not infer dealer signs
from call/put type, and do not flip put signs in the presentation layer.

### Taker-flow GEX vs naive OI-only GEX

| | **Lotus (taker-flow)** | **Naive OI GEX (common dashboards)** |
|--|------------------------|--------------------------------------|
| Position | Cumulative public taker flow, mirrored to dealers | Exchange open interest by strike |
| Sign | From taker buy/sell only | Often assumed (dealers short calls / long puts, or “customers long calls”) |
| Call vs put | No automatic put flip | Frequently `call_gex = +OI·γ`, `put_gex = −OI·γ` by convention |
| Path dependence | Yes — order flow builds inventory | No — OI snapshot only |
| Blocks/combos | Audited, excluded from v1 inventory | Usually ignored or mixed into OI |
| Strength | Closer to dealer hedging pressure from flow | Fast, but wrong when flow ≠ residual OI |

GEX dollars still use the standard conversion
`position_gamma · spot² · 0.01` once inventory and γ are known; the material
difference is **how net_contracts is obtained**.

### Magnitudes vs OI dashboards

Flow-netted dealer inventory is usually **much smaller** than naive OI GEX.
Peak strike GEX in the low millions (for example ~−4M near an ATM short-dated
cluster) can be correct. Do not treat “OI terminals show ±30M so Lotus is
broken” as a methodology failure without checking:

- opposing taker buy/sell nets out of inventory;
- only live instruments with Greeks contribute to the snapshot;
- expired names may remain in the ledger for audit but are skipped when Greeks
  are unavailable (active missing Greeks would be a release blocker).

### Frontend presentation rules

- **Active chart modes:** Net (bars), Net Profile (area), Heatmap. These are
  all **signed net GEX** views compatible with taker-flow inventory.
- **Archived (not in UI):** Split and ABS. Call/put leg decomposition and
  absolute-magnitude charts do not match how taker-flow GEX should be read;
  reintroduce only after a fresh design. `normalizeExposureMode` maps
  `split` / `abs` / legacy `call` / `put` → `net`.
- Tooltips may still show signed call/put for audit; regime / walls use
  **signed net GEX** only.
- GEX chart axis domains are **dynamic** (`frontend/src/lib/gexChartDomain.ts`):
  - ~**22%** outer margin (peak at ~78% of its side); ~18% opposite pad if one-sided.
  - **Asymmetric** signed domains (left from max |neg|, right from max pos) so
    short-gamma books don't waste half the pane on an empty positive side.
  - Edges follow `peak / (1 − margin)` and are **not** hard-snapped to ticks.
  Do not reintroduce fixed ±10M/±20M floors sized for mock data.

Phase 2 v1 uses Deribit trade `amount` as the inventory unit. Deribit `contracts`
is optional in historical payloads and is audited when present, but it does not
drive dealer inventory in the current methodology version.

Phase 6 live refresh keeps a durable **inventory checkpoint** so deep history is
not fully replayed every cycle. Checkpoints are an ops optimization only; they
must not change methodology outputs relative to a full replay of the same raw
trades.

## Phase Boundaries

- Phase 1 raw ingestion stores immutable Deribit payloads in SQLite.
- Phase 2 normalization maps raw payloads into canonical instruments and trades.
- Phase 3 replay reconstructs dealer inventory from normalized taker flow.
- Phase 4 GEX combines dealer inventory with Greeks and spot.
- Phase 5 API/dashboard only reads validated snapshots and may not recompute
  methodology.
- Phase 6 live ops keeps a production-depth raw DB + continuous snapshot refresh
  and serves the Vite terminal in live mode. See
  `project/docs/phase6_live_ops.md`. Phase 6 does not change inventory or GEX
  math.

Breaking changes to normalization, replay, or GEX math require explicit
methodology version bumps and side-by-side validation.

## Backend Commands

Install and test:

```powershell
python -m pip install -e .[dev]
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'
python -m pytest -q
```

Phase 6 deep historical pull uses **history.deribit.com** by default
(`DERIBIT_HISTORY_BASE_URL`, `DERIBIT_USE_HISTORY_FOR_BACKFILL=true`). Live
rolling appends still use the main host. **Ship minimum is year-to-date (YTD);**
full history is optional. See `phase6_live_ops.md`.

YTD backfill + validation (defaults: 1 Jan UTC → now):

```powershell
python project/scripts/historical_backfill.py --db-path project/data/phase1_history.sqlite3 --validate-remote
```

Direct Phase 1 CLI for a custom window:

```powershell
python project/scripts/backfill_phase1.py --start <UTC-start> --end <UTC-end> --db-path project/data/phase1_history.sqlite3 --job-name btc_options_history_<label> --reset-empty-cursors
```

Validate an existing historical DB without fetching more trades:

```powershell
python project/scripts/historical_backfill.py --skip-backfill --db-path project/data/phase1_history.sqlite3
```

The validation report is written to
`project/runtime/history_validation/validation_report.json` by default.

## Invariants

- Raw trade payloads are source of truth and must remain immutable.
- Raw trades are deduped by `(instrument_name, trade_id)`.
- Replay ordering is `(trade_seq, ts_ms, event_id)`.
- Combo and block trades remain auditable but excluded from v1 dealer inventory.
- Same inputs plus same methodology versions must produce identical artifacts.
- **Archived (dormant):** secondary include-OTC GEX mode — not on the live desk;
  dual materialize off by default. Restore guide:
  `project/docs/archived_include_otc_prints.md`.
- Missing Greeks, duplicate trade groups, invalid taker sides, invalid amounts,
  and non-deterministic materialization are release blockers.

## Frontend Rule

The terminal frontend defaults to the live `/api/v1/terminal-snapshot` contract
(Phase 6). Mock mode remains available for local UI work through
`VITE_LOTUS_DATA_MODE=mock`. The old static dashboard is archived at
`/legacy-dashboard` only for backend validation and comparison.

## Phase 6 Live Defaults

- Live raw DB: `project/data/phase1_history.sqlite3` (not the thin prototype
  `phase1.sqlite3`).
- Snapshot path: `project/greeks/data/latest_gex_snapshot.json`.
- Continuous worker: `project/scripts/refresh_dashboard_live.py` with
  `--db-path project/data/phase1_history.sqlite3` (default
  `--materialize-mode auto` = checkpointed incremental).
  Live trade window self-heals from `MAX(raw_trades.timestamp_ms)` (capped at
  ~20h on the main host). Prefer a supervised process
  (`deploy/lotus-live-refresh.service`, Docker, or Windows scheduled task).
- Inventory checkpoint: `project/runtime/dashboard_build/inventory_checkpoint.json`.
- Historical bring-up: `project/scripts/historical_backfill.py`.
