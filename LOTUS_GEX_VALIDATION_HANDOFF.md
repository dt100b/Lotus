# Lotus — GEX Engine Validation Handoff

**To:** Validation reviewer  
**From:** Lotus (Deribit BTC options taker-flow GEX terminal)  
**Date:** 2026-07-23  
**Scope:** Backend only — data fetchers, inventory ledger, GEX engine, materialization pipeline, API, tests, and ops. **No frontend required.**

This document is the index for validating the live Deribit gamma exposure model. Pair it with the companion archive `lotus-gex-validation-backend.zip` (source + docs + tests + small artifacts). The production-depth raw trade database is **not** in the zip (~1.2 GB); see [Data assets](#data-assets).

---

## 1. What you are validating

Lotus computes **taker-flow-based GEX** (Glassnode-style crypto dealer inventory), **not** open-interest heuristic GEX.

| Rule | Behavior |
|------|----------|
| Taker side | Deribit trade `direction` is the taker |
| Dealer inventory | Mirror of cumulative taker flow |
| Taker buy | Dealer inventory **decreases** by trade `amount` |
| Taker sell | Dealer inventory **increases** by trade `amount` |
| Inventory unit | Deribit trade `amount` (Phase 2 v1) |
| Blocks / combos | Stored in raw for audit; **excluded** from v1 inventory |
| GEX dollars | `net_contracts × mult × γ × S² × 0.01` (USD per 1% move) |
| Call vs put | **No automatic put flip** — sign is inventory sign only |

### Taker-flow GEX vs naive OI GEX

| | **Lotus (taker-flow)** | **Naive OI GEX** |
|--|------------------------|------------------|
| Position | Cumulative public taker flow, mirrored to dealers | Exchange OI by strike |
| Sign | From taker buy/sell only | Often assumed (dealers short calls / long puts) |
| Path dependence | Yes — order flow builds inventory | No — OI snapshot only |
| Blocks/combos | Audited, excluded from v1 | Usually ignored or mixed into OI |

**Scale note:** Flow-netted dealer inventory is usually **much smaller** than naive OI GEX. Peak strike GEX in the low millions can be correct. Do not treat “OI terminals show ±30M so Lotus is broken” as a methodology failure without checking netting, live-instrument filters, and exclusions.

### Methodology versions (current)

| Layer | Version |
|-------|---------|
| Normalization | `phase2.v1` |
| Ledger | `phase3.ledger.v1` |
| GEX | `phase4.gex.v1` |
| Dashboard contract | `phase5.dashboard.v2` (env may still label `v1`) |
| Inventory checkpoint | `phase6.inventory_checkpoint.v1` |

### Phase map

| Phase | Responsibility |
|-------|----------------|
| 1 | Raw Deribit payloads → immutable SQLite |
| 2 | Normalize → canonical instruments & trades |
| 3 | Replay taker flow → dealer inventory |
| 4 | Inventory + Greeks + spot → GEX profile |
| 5 | API reads validated snapshots only (no recompute) |
| 6 | Live refresh, history DB, inventory checkpoint (ops; must not change math) |

---

## 2. Package contents

### 2.1 Companion zip (`lotus-gex-validation-backend.zip`)

Included:

- Repo packaging: `README.md`, `pyproject.toml`, `.env.example`
- This handoff: `LOTUS_GEX_VALIDATION_HANDOFF.md`
- Full backend under `project/`:
  - `collector/` — Deribit HTTP client, instrument sync, trade backfill
  - `normalizer/` — raw → canonical trades/instruments
  - `ledger/` — inventory policy, replay, raw store
  - `greeks/` — **GEX engine**, Greeks providers, types
  - `pipeline/` — materialize, validation framework, checkpoint, adjacent analytics
  - `api/` — FastAPI read layer (schemas, repository, routes)
  - `scripts/` — all CLIs (backfill, materialize, validate, live refresh)
  - `tests/` — unit/integration suite + fixtures
  - `docs/` — methodology, contracts, runbooks, prior validation report
  - `PHASE1_RAW_SCHEMA_CONTRACT.md`
- `deploy/` — live refresh supervision (systemd / Docker / Windows)
- Lightweight serving artifacts:
  - `project/greeks/data/latest_gex_snapshot.json`
  - `project/runtime/dashboard_build/gex/*` (summary, by strike/expiry/instrument, greeks snapshot)
  - `project/runtime/dashboard_build/inventory_snapshot.csv`
  - `project/runtime/dashboard_build/ledger_manifest.json`
  - `project/runtime/dashboard_build/inventory_checkpoint.json` (if present)
- Prior validation outputs under `project/runtime/validation_expert/` and `validation_build/` when small enough

Excluded from zip (by design):

| Exclusion | Reason |
|-----------|--------|
| `frontend/` | Out of scope for engine validation |
| `project/data/phase1_history.sqlite3` | ~1.2 GB — share separately or re-backfill |
| Large intermediate JSONL (e.g. full `canonical_instruments.jsonl`) | Rebuildable; bulk |
| `__pycache__/`, `.venv/`, logs, node_modules | Noise |

### 2.2 Data assets (provide separately if possible)

| Asset | Path | Role |
|-------|------|------|
| **Production history DB** | `project/data/phase1_history.sqlite3` | Book of record for YTD inventory (~1.2 GB) |
| Live build dir | `project/runtime/dashboard_build/` | Full materialize outputs |
| Serving snapshot | `project/greeks/data/latest_gex_snapshot.json` | What the API serves |

Without the history DB, you can still review code, run unit tests, and **re-pull** YTD trades yourself (network + time). With the DB, you can reproduce inventory and GEX without re-fetching Deribit history.

---

## 3. Read order (recommended)

1. **This handoff** (you are here)
2. `project/docs/agent_handbook.md` — methodology + invariants
3. `project/docs/backend_architecture_validation_report.md` — prior expert scorecard + known flags
4. `project/docs/local_runbook.md` — install, backfill, materialize, API
5. `project/docs/phase6_live_ops.md` — live path + checkpoint behavior
6. Contracts as needed:
   - `project/PHASE1_RAW_SCHEMA_CONTRACT.md`
   - `project/docs/phase3_schema_contract.md`
   - `project/docs/phase5_dashboard_contract.md`
7. Code core (in this order):
   - `project/ledger/rules.py` — dealer delta + block/combo policy
   - `project/ledger/replay.py` — deterministic inventory
   - `project/greeks/gex_engine.py` — GEX formula + aggregation
   - `project/greeks/providers.py` — live/frozen Greeks
   - `project/pipeline/dashboard_snapshot.py` — end-to-end materialize
   - `project/collector/deribit_client.py` — fetchers
   - `project/api/main.py` + `repository.py` — read-only API

Secondary / archived (not required for v1 desk math):

- `project/docs/archived_include_otc_prints.md` — OTC include sensitivity path
- `project/docs/archived_regime_polarity.md`
- `project/docs/replay_recovery_policy.md`

---

## 4. File map by concern

### 4.1 Methodology & docs

| Path | Why |
|------|-----|
| `project/docs/agent_handbook.md` | Source of truth for methodology |
| `project/docs/backend_architecture_validation_report.md` | Prior Tier 1/2 validation |
| `project/docs/local_runbook.md` | Operator commands |
| `project/docs/phase6_live_ops.md` | Live production path |
| `project/PHASE1_RAW_SCHEMA_CONTRACT.md` | Raw schema |
| `project/docs/phase3_schema_contract.md` | Ledger contract |
| `project/docs/phase5_dashboard_contract.md` | Snapshot/API contract |

### 4.2 Data fetchers (Deribit)

| Path | Role |
|------|------|
| `project/collector/deribit_client.py` | HTTP client (main + history hosts) |
| `project/collector/config.py` | Env defaults |
| `project/collector/instruments.py` | Instrument sync |
| `project/collector/phase1_sync.py` | Phase 1 orchestration |
| `project/collector/trades_backfill.py` | Windowed trade backfill |
| `project/scripts/backfill_phase1.py` | Fixed-window raw pull CLI |
| `project/scripts/historical_backfill.py` | YTD/full history + remote validate |
| `project/scripts/inspect_phase1_db.py` | Raw DB summary |
| `.env.example` | `DERIBIT_*`, paths, snapshot config |

**Hosts:**

- Live: `https://www.deribit.com/api/v2`
- History (deep backfill default): `https://history.deribit.com/api/v2`

### 4.3 Inventory path (hard part of correctness)

| Path | Role |
|------|------|
| `project/normalizer/` | Raw → canonical |
| `project/ledger/rules.py` | `dealer_position_delta`, `LedgerPolicy` exclusions |
| `project/ledger/replay.py` | Ordered replay |
| `project/ledger/raw_store.py` | Raw access |
| `project/ledger/models.py` | Event models |
| `project/pipeline/dashboard_snapshot.py` | P2→P3→P4 materialize |
| `project/pipeline/inventory_checkpoint.py` | Phase 6 checkpoint (must match full replay of same trades) |
| `project/scripts/build_ledger.py` | Standalone ledger |
| `project/scripts/export_inventory_snapshot.py` | Inventory CSV |
| `project/scripts/materialize_dashboard_snapshot.py` | Full snapshot CLI |

### 4.4 GEX engine (core math)

| Path | Role |
|------|------|
| **`project/greeks/gex_engine.py`** | Formula + strike/expiry aggregation |
| `project/greeks/providers.py` | Ticker / frozen Greeks |
| `project/greeks/types.py` | Row types |
| `project/scripts/build_gex_profile.py` | Standalone GEX build |

**Independent recompute check:**

```text
position_gamma        = net_contracts × contract_multiplier × gamma
dollar_gamma_per_1pct = position_gamma × spot² × 0.01
net_gex (strike)      = call_gex + put_gex     # no put flip
```

Implementation reference (`gex_engine.py`):

```python
position_gamma = row.net_contracts * row.contract_multiplier * greek.gamma
dollar_gamma_per_1pct = position_gamma * (greek.spot_price ** 2) * 0.01
```

### 4.5 API (must not recompute methodology)

| Path | Role |
|------|------|
| `project/api/main.py` | Routes |
| `project/api/repository.py` | Snapshot load/query |
| `project/api/schemas.py` | Response models |
| `project/api/config.py` | Config |

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/health` | Liveness / freshness |
| `GET /api/v1/config` | Contract versions / defaults |
| `GET /api/v1/expiries` | Expiry list |
| `GET /api/v1/gex-profile?expiry=ALL&view=net` | Net GEX profile |
| `GET /api/v1/terminal-snapshot?expiry=ALL` | Full terminal payload |
| `GET /api/v1/gex-heatmap-surface` | Heatmap surface |

### 4.6 Validation tooling

| Path | Role |
|------|------|
| `project/pipeline/validation.py` | History / pipeline checks |
| `project/pipeline/validation_framework.py` | Expert Tier 1 + Tier 2 diagnostics |
| `project/scripts/validate_dashboard_pipeline.py` | Isolated full validation run |
| `project/scripts/run_validation_framework.py` | Expert framework runner |
| `project/scripts/run_backfill_smoke.py` | Backfill smoke |
| `project/runtime/validation_expert/` | Prior diagnostics (if present) |

### 4.7 Priority tests

| Test | Focus |
|------|--------|
| `project/tests/test_gex_engine.py` | GEX formula / aggregation |
| `project/tests/test_phase3_ledger.py` | Inventory deltas & exclusions |
| `project/tests/test_greeks_provider_cache.py` | Greeks provider |
| `project/tests/test_api_gex.py` | API GEX contract |
| `project/tests/test_incremental_materialize.py` | Checkpoint vs full replay |
| `project/tests/test_live_refresh_window.py` | Live window behavior |
| `project/tests/test_raw_store.py` / `test_schema_contract.py` | Raw integrity |
| `project/tests/test_phase1_sync.py` / `test_deribit_connection.py` | Fetchers (network) |
| `project/tests/test_validation.py` | Validation pipeline |
| `project/tests/fixtures/` | Small fixtures |

### 4.8 Live ops (production-depth path)

| Path | Role |
|------|------|
| `project/scripts/refresh_dashboard_live.py` | Continuous live worker |
| `deploy/lotus-live-refresh.service` | Linux systemd unit |
| `deploy/docker-compose.live.yml` | Docker compose |
| `deploy/windows/Register-LotusLiveRefresh.ps1` | Windows task registration |

### 4.9 Adjacent analytics (optional)

Not required to confirm core GEX formula, but part of the full backend model:

- `project/pipeline/flow_regime.py`
- `project/pipeline/skew_25d.py`
- `project/pipeline/vol_compare.py`
- `project/pipeline/gex_window_backfill.py`
- Related scripts under `project/scripts/`

---

## 5. Setup & commands

From the **extracted package root** (or monorepo root):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e .[dev]

# Optional
Copy-Item .env.example .env
```

Requires **Python 3.11+**. Dependencies are minimal (`httpx`, `fastapi`, `uvicorn`; `pytest` in `[dev]`).

### 5.1 Unit / integration tests

```powershell
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD='1'
python -m pytest -q
```

(`PYTEST_DISABLE_PLUGIN_AUTOLOAD` avoids global pytest plugins crashing the suite.)

### 5.2 Historical DB (if not provided)

YTD ship bar (network; can take a long time):

```powershell
python project/scripts/historical_backfill.py --db-path project/data/phase1_history.sqlite3 --validate-remote
```

Validate an existing DB without fetching more trades:

```powershell
python project/scripts/historical_backfill.py --skip-backfill --db-path project/data/phase1_history.sqlite3
```

### 5.3 Full pipeline validation (isolated artifacts)

```powershell
python project/scripts/validate_dashboard_pipeline.py `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/validation_build `
  --snapshot-path project/runtime/validation_build/latest_gex_snapshot.json `
  --validate-remote
```

Writes `project/runtime/validation_build/validation_report.json`.

### 5.4 Expert Tier 1 / Tier 2 diagnostics

```powershell
python project/scripts/run_validation_framework.py
```

See `project/docs/backend_architecture_validation_report.md` for interpretation of a prior full run.

### 5.5 Materialize snapshot + start API

```powershell
python project/scripts/materialize_dashboard_snapshot.py `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/dashboard_build `
  --snapshot-path project/greeks/data/latest_gex_snapshot.json

python -m uvicorn project.api.main:app --host 127.0.0.1 --port 8000
```

Smoke:

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:8000/api/v1/health -UseBasicParsing | Select-Object -ExpandProperty Content
Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/v1/gex-profile?expiry=ALL&view=net" -UseBasicParsing | Select-Object -ExpandProperty Content
Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/v1/terminal-snapshot?expiry=ALL" -UseBasicParsing | Select-Object -ExpandProperty Content
```

### 5.6 One-shot live refresh (if you have network + history DB)

```powershell
python project/scripts/refresh_dashboard_live.py --once `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/dashboard_build `
  --snapshot-path project/greeks/data/latest_gex_snapshot.json `
  --lookback-minutes 180
```

---

## 6. Validation checklist

Use this as a structured review plan.

### Tier A — Methodology & policy

- [ ] Confirm taker-flow model (not OI-signed GEX)
- [ ] Confirm dealer delta: buy → −amount, sell → +amount (`ledger/rules.py`)
- [ ] Confirm blocks + combos excluded from v1 inventory (`LedgerPolicy`)
- [ ] Confirm **no** automatic put sign flip in GEX aggregation
- [ ] Confirm API does not recompute inventory/GEX math

### Tier B — Fetchers & raw integrity

- [ ] Raw trades immutable; dedupe key `(instrument_name, trade_id)`
- [ ] History host used for deep backfill; main host for live appends
- [ ] Schema matches `PHASE1_RAW_SCHEMA_CONTRACT.md`
- [ ] Run `inspect_phase1_db.py` on provided or backfilled DB

### Tier C — Inventory determinism

- [ ] Replay ordering documented: `(trade_seq, ts_ms, event_id)` (see handbook)
- [ ] Full genesis rematerialize matches live `inventory_snapshot.csv` (zero `net_contracts` deltas expected for same raw book)
- [ ] Checkpoint is ops optimization: internal hash self-valid; lag vs live ≠ formula bug
- [ ] Quantify excluded volume (blocks often small % of **trades**, large % of **contracts**)

### Tier D — GEX formula

- [ ] Recompute sample instruments from inventory row + Greeks → match `gex_by_instrument.csv` / snapshot
- [ ] Strike net = call + put; no put flip
- [ ] Missing Greeks: expired/audit positions may remain in ledger but drop from live GEX; **active** missing Greeks are a release blocker
- [ ] Magnitude vs public OI: rough order-of-magnitude only; flow net << OI GEX is expected

### Tier E — API contract

- [ ] `/api/v1/health` → 200, non-zero rows when snapshot present
- [ ] `/api/v1/gex-profile?expiry=ALL&view=net` → non-empty `points`
- [ ] Snapshot contract versions consistent with docs

### Tier F — Automated gates

- [ ] `pytest -q` green
- [ ] `validate_dashboard_pipeline.py` report clean (or flags understood)
- [ ] Optional: `run_validation_framework.py` vs prior report

---

## 7. Prior validation highlights (as of 2026-07-18 report)

From `project/docs/backend_architecture_validation_report.md` (run against YTD book; do not treat as automatic pass for later data):

| Check | Status (that run) | Note |
|-------|-------------------|------|
| YTD coverage / gaps | PASS | Continuous coverage; no multi-hour gaps of concern |
| Inventory path (top strikes) | FLAG | Large non-block single prints can jump inventory |
| Materialization / Greeks integrity | PASS | Full lightweight rematerialize matched live inventory hash |
| Block/combo exclusion | PASS (policy) | Blocks ~1.6% of trades but ~47% of contracts — material sensitivity |
| Replay determinism / checkpoint | PASS math; FLAG ops | Checkpoint can lag live inventory without hash corruption |
| Formula `S² × 0.01` | PASS | Worked example matched stored row |
| Scale vs public Deribit OI | PASS (OoM only) | Flow GEX \|net\| roughly smaller share of OI; not full recon |

**Interpretation for a new review:** re-run diagnostics on the book you are given; treat the report as a template of what good looks like and which flags to re-check.

---

## 8. Invariants (release blockers if broken)

From the agent handbook:

1. Raw trade payloads are source of truth and remain immutable.
2. Raw trades deduped by `(instrument_name, trade_id)`.
3. Replay ordering is deterministic.
4. Combo and block trades remain auditable but excluded from v1 dealer inventory.
5. Same inputs + same methodology versions → identical artifacts.
6. Missing Greeks on **active** names, duplicate trade groups, invalid taker sides, invalid amounts, and non-deterministic materialization are release blockers.
7. Phase 5 API may only read validated snapshots; it must not recompute methodology.
8. Phase 6 checkpoints must not change outputs relative to a full replay of the same raw trades.

---

## 9. Environment variables (from `.env.example`)

| Variable | Role |
|----------|------|
| `PHASE1_DB_PATH` | Default prototype DB path |
| `DERIBIT_BASE_URL` | Live API host |
| `DERIBIT_HISTORY_BASE_URL` | History API host |
| `DERIBIT_USE_HISTORY_FOR_BACKFILL` | Prefer history host for deep pulls |
| `DERIBIT_PAGE_SIZE` / `DERIBIT_HISTORY_PAGE_SIZE` | Pagination |
| `GEX_SNAPSHOT_PATH` | Serving snapshot path |
| `GEX_ARTIFACTS_DIR` | Build artifacts / heatmap history dir |
| `GEX_CONTRACT_VERSION` | Dashboard contract label |
| `GEX_DEFAULT_EXPIRY` / `GEX_DEFAULT_VIEW` | API defaults (`ALL` / `net`) |

Production live path typically uses:

- DB: `project/data/phase1_history.sqlite3`
- Snapshot: `project/greeks/data/latest_gex_snapshot.json`
- Artifacts: `project/runtime/dashboard_build/`

---

## 10. Suggested questions to answer in your write-up

1. Does dealer inventory from public Deribit taker flow match the coded policy on a held-out window?
2. Does excluding blocks/combos match the intended desk product (and how sensitive are top strikes if included)?
3. Do GEX dollars recompute exactly from inventory × γ × S² × 0.01?
4. Is materialization deterministic (byte/hash identity) for fixed raw input + fixed methodology versions?
5. Does the live checkpoint path ever diverge from full replay for the same raw trades?
6. Is the API a pure reader of snapshots?
7. Are magnitudes plausible relative to flow-netting (not OI terminals)?

---

## 11. Contact / package notes

- **In scope:** Backend pipeline from Deribit fetch → inventory → GEX → snapshot API.
- **Out of scope for this package:** Vite terminal UI (`frontend/`), chart theming, layout.
- **Large DB:** If `phase1_history.sqlite3` was provided via a separate link, place it at `project/data/phase1_history.sqlite3` before materialize/validate commands.
- **Frontend not required** to validate the engine; API + CSV/JSON artifacts are sufficient.

Thank you for reviewing the model.
```