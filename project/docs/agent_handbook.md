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

Phase 2 v1 uses Deribit trade `amount` as the inventory unit. Deribit `contracts`
is optional in historical payloads and is audited when present, but it does not
drive dealer inventory in the current methodology version.

## Phase Boundaries

- Phase 1 raw ingestion stores immutable Deribit payloads in SQLite.
- Phase 2 normalization maps raw payloads into canonical instruments and trades.
- Phase 3 replay reconstructs dealer inventory from normalized taker flow.
- Phase 4 GEX combines dealer inventory with Greeks and spot.
- Phase 5 API/dashboard only reads validated snapshots and may not recompute
  methodology.

Breaking changes to normalization, replay, or GEX math require explicit
methodology version bumps and side-by-side validation.

## Backend Commands

Install and test:

```powershell
python -m pip install -e .[dev]
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'
python -m pytest -q
```

Run the first production-depth historical workflow without touching the
prototype DB:

```powershell
python project/scripts/historical_backfill.py --start 2026-01-26T00:00:00Z --end 2026-04-26T00:00:00Z --db-path project/data/phase1_history.sqlite3 --job-name btc_options_history_2026_01_26_2026_04_26 --validate-remote
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
- Missing Greeks, duplicate trade groups, invalid taker sides, invalid amounts,
  and non-deterministic materialization are release blockers.

## Frontend Rule

The new terminal frontend is mock-data first. Do not connect it to live backend
data until the mock-data UI is visually approved. The old static dashboard is
archived at `/legacy-dashboard` only for backend validation and comparison.
