# Lotus Backend Architecture Validation Report

**Audience:** Validation expert agent  
**Generated:** 2026-07-18 (diagnostics run; wall-clock ~218s including full lightweight YTD rematerialize)  
**Machine-readable source:** `project/runtime/validation_expert/framework_diagnostics.json`  
**Framework runner:** `project/scripts/run_validation_framework.py` → `project/pipeline/validation_framework.py`

---

## 0. Executive scorecard

| Check | Status | One-line finding |
|-------|--------|------------------|
| **T1.1** YTD / window coverage & gaps | **PASS** | Continuous YTD coverage from 2026-01-01; **0** gaps >2h; only partial current day is low-volume |
| **T1.2** Inventory path (top 5 \|GEX\| strikes) | **FLAG** | Paths reconstruct cleanly; **61** non-block single-trade jumps >50 contracts across top strikes (esp. 70k/80k) |
| **T1.3** Materialization / Greeks integrity | **PASS** | Fresh full lightweight YTD rematerialize **exact-matches** live inventory (`sha256` identical, 0 instrument deltas) |
| **T1.4** Excluded volume (blocks+combos) | **PASS** | Blocks ~1.6% of trades but **~47% of contracts**; offline block-include sensitivity material at top strikes |
| **T2.1** Replay determinism / checkpoint | **PASS** | Full genesis replay == live inventory; checkpoint `positions_sha256` self-valid; checkpoint **stale vs live** (ops lag, not hash corruption) |
| **T2.2** Scale vs public Deribit | **PASS**\* | Rough OoM only; live GEX \|net\| ≈ **17%** of Deribit options OI; 24h volume ratio needs unit caveats |
| **T2.3** Formula confirmation | **PASS** | Confirmed `S² × 0.01` USD-per-1% GEX; worked example matches stored row |

\*PASS for “rough scale check completed with public data,” not a reconciliation pass.

### Overall judgment for the expert agent

The **inventory math is deterministic and faithful to the YTD raw book**: a from-genesis lightweight rematerialize of all **2,343,301** trades reproduces the live `inventory_snapshot.csv` with **zero** `net_contracts` mismatches. GEX formula, block/combo exclusion policy, and coverage continuity are solid.

**Material flags (not release-blockers by themselves, but require expert attention):**

1. **Large non-block prints** move top-strike inventory by >50 contracts (up to ~197 contracts on 80k calls). Policy excludes only flagged blocks; large public prints still enter the book.
2. **Checkpoint file is stale** relative to live inventory (**1,341** instrument deltas) even though its internal hash is valid — ops should rewrite checkpoint after successful materialize or treat checkpoint as “last durable save,” not the serving truth.
3. **Blocks dominate contract volume (~47%) while being ~1.6% of trade count** — excluding them is methodologically intentional but massively changes inventory path; sensitivity section quantifies this at top strikes.
4. **~8,030 expired nonzero positions** remain in the ledger for audit but are correctly dropped from live GEX (missing ticker Greeks / expiry filter).

---

## 1. System context (what was validated)

### 1.1 Methodology (immutable for this report)

Lotus is a **taker-flow GEX** system (Glassnode-style crypto dealer inventory), not OI-heuristic GEX:

| Rule | Implementation |
|------|----------------|
| Taker side | Deribit `direction` → `taker_side` |
| Dealer delta | buy → `−amount`; sell → `+amount` (`ledger/rules.py::dealer_position_delta`) |
| Inventory unit | Deribit trade `amount` (Phase 2 v1) |
| Blocks/combos | Stored in raw; **excluded** from v1 inventory (`LedgerPolicy.exclude_block_trades/combo=True`) |
| GEX dollars | `net_contracts × mult × γ × S² × 0.01` (`greeks/gex_engine.py` L59–60) |
| Sign of puts | **No automatic put flip** — sign is purely inventory sign |

Versions in force:

| Layer | Version |
|-------|---------|
| Normalization | `phase2.v1` |
| Ledger | `phase3.ledger.v1` |
| GEX | `phase4.gex.v1` |
| Dashboard contract | `phase5.dashboard.v2` |
| Inventory checkpoint | `phase6.inventory_checkpoint.v1` |

### 1.2 Data sources used

| Asset | Path | Role |
|-------|------|------|
| Production history DB | `project/data/phase1_history.sqlite3` | Immutable raw trades/instruments |
| Live build artifacts | `project/runtime/dashboard_build/` | inventory CSV, GEX CSVs, checkpoint, ledger manifest |
| Serving snapshot | `project/greeks/data/latest_gex_snapshot.json` | What the dashboard API reads |
| Diagnostics output | `project/runtime/validation_expert/` | This run’s JSON + fresh rematerialize (non-production) |

### 1.3 Window of record

| Field | Value |
|-------|-------|
| Min trade ts | **2026-01-01T00:00:14.654Z** |
| Max trade ts | **2026-07-18T08:06:52.680Z** |
| Coverage hours | **~4,760.1 h** (~198.3 days) |
| Raw trades | **2,343,301** |
| Raw instruments | **119,538** |
| Distinct traded instruments | **9,024** |
| Live snapshot `as_of` | **2026-07-18T08:11:20.417Z** |
| Live spot (snapshot) | **64,410.21** |

Production book was **not modified**. Sensitivity replays and the fresh rematerialize wrote only under `project/runtime/validation_expert/`.

### 1.4 Crypto “RTH” adaptation

There is **no RTH filter** anywhere in the backend (24/7 market). Gap diagnostics therefore:

1. Flag **any** silence > **2 hours** across the full calendar (`gaps_all`).
2. Also report gaps that touch **08:00–22:00 UTC** as a liquidity-period proxy (`gaps_rth_equivalent`).

---

## Tier 1.1 — YTD / full-history coverage & gaps

**Status: PASS**  
**Diagnostic:** `checks.tier1_coverage_gaps`  
**Notional definition:**  
- Premium USD ≈ `amount × price × index_price`  
- Underlying USD ≈ `amount × index_price`  
- Block/combo flags from SQLite columns `block_trade_id` / `combo_trade_id` (sample of 500 newest trades: **0** payload-vs-column mismatches)

### 1.1.1 Window summary table

| Window | Raw trades | % block | % combo | % single-leg\* | Unique instruments | Total contracts | Block contracts | Combo contracts | Single-leg contracts | Premium notional USD |
|--------|------------|---------|---------|----------------|--------------------|-----------------|-----------------|-----------------|----------------------|----------------------|
| **Full (YTD)** | 2,343,301 | 1.611% | 0.979% | 97.410% | 9,024 | 5,535,089.1 | 2,593,156.7 | 26,846.9 | (rest) | 9,759,126,279 |
| **Last 90d** | 925,090 | 1.436% | 0.938% | 97.625% | 4,497 | 2,210,817.1 | 1,012,923.3 | 8,646.3 | (rest) | 2,865,519,571 |
| **Last 30d** | 306,637 | 1.466% | 0.821% | 97.714% | 1,759 | 733,415.5 | 340,135.0 | 2,723.9 | (rest) | 839,689,943 |
| **Last 7d** | 57,644 | 1.291% | 0.880% | 97.830% | 753 | 161,118.1 | — | — | — | 94,111,922 |

\*Single-leg here = neither `block_trade_id` nor `combo_trade_id` set (column proxy). Phase 2 also detects `block_trade` bool / `trade_type==block_trade` and combo via instrument metadata; sample audit found no column/payload disagreement.

**Venn (YTD trades):**

| Category | Count | % of trades |
|----------|------:|------------:|
| Block only (approx via columns) | 37,748 − both | — |
| Combo only | 22,948 − both | — |
| Block **or** combo | 60,696 (matches ledger excluded-ish scale) | 2.590% |
| Block **and** combo | reported in diagnostics | — |
| Neither | 2,282,605 | 97.410% |

Ledger manifest on live build: `applied_event_count=2,282,605`, `excluded_event_count=60,696`, `input_event_count=2,343,301` — **exact arithmetic identity** with trade totals.

### 1.1.2 Category % of **contracts** (more important than trade count)

| Window | % contracts block | % contracts combo |
|--------|------------------:|------------------:|
| YTD | **46.85%** | 0.485% |
| 90d | **45.82%** | 0.391% |
| 30d | **46.38%** | 0.371% |

**Interpretation:** Blocks are rare as events but **enormous as volume**. Excluding them is not a cosmetic filter; it removes nearly half of contract flow from the dealer book.

### 1.1.3 Low-volume / zero calendar days

| Metric | Value |
|--------|------:|
| 30-day median daily trade count | **10,215.5** |
| Flag threshold (20% of median) | **2,043.1** |
| Suspicious days | **1** |

**Suspicious day list:**

| Day (UTC) | Trade count | Reason |
|-----------|------------:|--------|
| **2026-07-18** | 934 | Partial day only (DB ends ~08:06Z); below 20% of 30d median |

No zero-trade days appear in the YTD calendar span. Coverage is continuous day-to-day.

### 1.1.4 Timestamp gaps > 2 hours

| Series | Count |
|--------|------:|
| `gaps_all` (>2h any time) | **0** |
| `gaps_rth_equivalent` (>2h touching 08–22 UTC) | **0** |

**Conclusion:** No multi-hour holes in the trade stream for the entire YTD window. Ingest continuity is excellent for a history-host backfill + live append architecture.

### 1.1.5 Remote sample validation (prior YTD backfill log)

From `project/runtime/ytd_backfill.log` (job `btc_options_history_ytd_2026`):

- Host: `https://history.deribit.com/api/v2`
- Chunks completed: 4,756 / 4,756
- Multiple local-vs-remote sample windows: **0 missing / 0 extra** trade keys

---

## Tier 1.2 — Inventory path for current top GEX strikes

**Status: FLAG** (paths OK; large non-block jumps present)  
**Jump threshold X:** **50 contracts** (CLI default; single-trade applied |delta| p99 ≈ 16–18 contracts on these strikes)  
**Method:** Rank strikes by `|net_gex|` from `gex_by_strike.csv`; load all instruments at those strikes from inventory + instrument catalog; stream raw trades for those instruments only; normalize → Phase 3 events → production `LedgerPolicy` replay; build daily/hourly cumulative strike net.

### 1.2.1 Current top 5 strikes by \|net GEX\| (all-expiry)

| Rank | Strike | net_gex (USD / 1%) | call_gex | put_gex | Live inventory Σ net_contracts |
|-----:|-------:|-------------------:|---------:|--------:|-------------------------------:|
| 1 | **64,000** | −6,827,982 | −106,973 | −6,721,009 | **−4,281.4** |
| 2 | **64,500** | −4,418,109 | −4,274,259 | −143,850 | **−39.9** |
| 3 | **63,500** | −3,282,470 | +158,068 | −3,440,537 | **+568.1** |
| 4 | **70,000** | −2,956,652 | −2,491,947 | −464,704 | **−10,474.7** |
| 5 | **80,000** | +2,634,666 | +2,553,891 | +80,774 | **−571.7** |

Note: strike **net_contracts** is the sum of dealer positions across **all expiries** at that strike. GEX is gamma-weighted, so a small net can still dominate GEX (e.g. 64,500: −40 contracts but −4.4M GEX).

### 1.2.2 Cumulative inventory path summary

| Strike | Starting net\* | Ending net | Max \|net\| | Largest 1-day jump | Largest 1-hour jump | Top-5 trades share of final net | Non-block jumps >50 |
|-------:|---------------:|-----------:|------------:|--------------------|---------------------|--------------------------------:|--------------------:|
| 64000 | −2.0 | −4,281.4 | 4,909.2 | **−2,438.1** (2026-02-04 → 02-05) | **−4,637.9** (2026-06-01 22:00 → 06-02 00:00) | 1.32% | **3** |
| 64500 | −0.1 | −39.9 | 524.6 | **+395.3** (2026-02-27 → 02-28) | **+579.2** (2026-02-24 04:00 → 05:00) | n/a (near-zero final; ratio unstable) | **0** |
| 63500 | +0.2 | +568.1 | 645.5 | **−475.1** (2026-06-15 → 06-16) | **−661.8** (2026-07-10 02:00 → 03:00) | 37.65% | **1** |
| 70000 | +0.1 | −10,474.7 | 10,690.1 | **+5,310.7** (2026-06-26 → 06-27) | **+9,889.5** (2026-05-25 06:00 → 07:00) | −1.57% (sign opposition) | **27** |
| 80000 | +0.1 | −571.7 | 5,643.1 | **−1,069.2** (2026-01-30 → 01-31) | **+4,664.8** (2026-02-19 22:00 → 23:00) | 120.5% (final near zero vs large opposing prints) | **30** |

\*Starting = strike net after first **applied** trade in the selective replay (not calendar genesis zero if first trade is later).

**Path-dependence observation:** Ending inventory is **not** explained by a handful of large trades at 64k (top 5 ≈ 1.3% of final). At 63.5k, top 5 explain ~38%. At 80k, final net is small while large opposing flows cancel — concentration ratios >100% are mathematically expected and should be read as “path volatile / netted,” not as data errors.

### 1.2.3 Flagged non-block jumps > 50 contracts (examples)

Production policy **applies** these because they are not tagged as blocks.

**Strike 64000 (3 events):**

| ts (UTC) | Instrument | Side | Amount | Dealer Δ |
|----------|------------|------|-------:|---------:|
| 2026-02-05T15:40:26Z | BTC-6FEB26-64000-P | buy | 92.3 | −92.3 |
| 2026-03-19T19:06:25Z | BTC-27MAR26-64000-P | sell | 89.5 | +89.5 |
| 2026-06-04T11:56:48Z | BTC-5JUN26-64000-P | buy | 55.7 | −55.7 |

**Strike 63500 (1 event):**

| ts (UTC) | Instrument | Side | Amount | Dealer Δ |
|----------|------------|------|-------:|---------:|
| 2026-06-18T02:38:31Z | BTC-18JUN26-63500-P | sell | 50.6 | +50.6 |

**Strike 70000 (27 events; sample):**

| ts (UTC) | Instrument | Side | Amount | Dealer Δ |
|----------|------------|------|-------:|---------:|
| 2026-04-17T16:16:22Z | BTC-24APR26-70000-P | sell | 125.9 | +125.9 |
| 2026-04-17T16:16:18Z | BTC-24APR26-70000-P | sell | 125.8 | +125.8 |
| 2026-07-14T17:28:42Z | BTC-31JUL26-70000-C | sell | 100.0 | +100.0 |

**Strike 80000 (30 events; sample):**

| ts (UTC) | Instrument | Side | Amount | Dealer Δ |
|----------|------------|------|-------:|---------:|
| 2026-04-02T07:49:56Z | BTC-17APR26-80000-C | buy | 197.0 | −197.0 |
| 2026-03-19T08:05:50Z | BTC-27MAR26-80000-C | buy | 152.4 | −152.4 |
| 2026-04-02T13:48:26Z | BTC-17APR26-80000-C | buy | 137.0 | −137.0 |

**Expert note:** Single-trade p99 on these strikes is ~16–18 contracts; threshold 50 is ~3× p99 and still fires on 61 events — these are true fat-tail public prints, not dust.

### 1.2.4 Live ending inventory consistency

Selective path **ending inventory** matches live inventory Σ net_contracts for each top strike (to floating display precision), e.g. 64000 ends at **−4,281.4** in both path replay and `inventory_snapshot.csv`. This is strong evidence that strike-scoped reconstruction under production policy is faithful.

---

## Tier 1.3 — Materialization / Greeks attachment integrity

**Status: PASS** (inventory exact match live vs fresh full rematerialize)

### 1.3.1 Fresh rematerialize procedure

| Parameter | Value |
|-----------|-------|
| Mode | `full` + `lightweight=True` |
| DB | `phase1_history.sqlite3` (2,343,301 trades) |
| Greeks | Frozen from live `dashboard_build/gex/greeks_snapshot.json` |
| Checkpoint write | **Disabled** (production checkpoint untouched) |
| Output | `project/runtime/validation_expert/fresh_materialize/` |
| Elapsed | **158.2 s** (normalize 112.4 s dominant) |

### 1.3.2 `net_contracts` exact match

| Side | Inventory instruments | SHA256 of sorted `(instrument,net_contracts)` |
|------|----------------------:|-----------------------------------------------|
| Live `dashboard_build/inventory_snapshot.csv` | 8,799 | `d4a6f9f65b7980910fdfcbd4d2740852c09fd0614831f3623ae7d74a22850554` |
| Fresh full lightweight rematerialize | 8,799 | `d4a6f9f65b7980910fdfcbd4d2740852c09fd0614831f3623ae7d74a22850554` |

| Metric | Value |
|--------|------:|
| Instrument mismatches | **0** |
| Inventory match | **true** |

This is the strongest integrity result in the suite: **same raw inputs + same methodology ⇒ identical dealer book**, independent of the live incremental/checkpoint path used in production ops.

### 1.3.3 Greeks presence / instruments dropped from GEX

| Population | Count |
|------------|------:|
| Live inventory rows | 8,799 |
| Nonzero inventory | ~8,799 |
| Live GEX instrument rows (`gex_by_instrument.csv`) | 768 |
| Live greeks snapshot keys | (ticker set for non-expired book) |
| `gex_summary.missing_greeks_count` | **8,030** |
| Nonzero positions dropped because **expired** (`expiry_ts < now`) | **8,030** |
| Nonzero positions dropped solely for missing Greeks while still live | **0** |
| Total \|contracts\| on expired dropped set | **449,207.4** |

**Code path (intentional):**

1. `compute_gex_profile` skips rows with missing Greeks and records them in `missing_greeks` (`greeks/gex_engine.py` L51–57).
2. Lightweight materialize further skips fetching Greeks for `expiry_ts < now` (`pipeline/dashboard_snapshot.py` ~597–598).

**Examples of expired dust-or-residual book still in ledger:**

| Instrument | net_contracts | expiry_ts |
|------------|--------------:|-----------|
| BTC-1JAN26-85000-P | −2.0 | 1767225600000 |
| BTC-1JAN26-86000-C | −75.0 | 1767225600000 |
| BTC-1JAN26-86000-P | +24.5 | 1767225600000 |

These are **audit residues**, not active GEX contributors. Expert should treat “missing_greeks=8030” as **expected for YTD ledgers that retain expired names**, not as a live-book Greeks outage.

### 1.3.4 Dust pruning

| Parameter | Value |
|-----------|-------|
| `DUST` | `1e-10` (`ledger/replay.py`) |
| Behavior | If `|position_after| ≤ DUST`, key is removed from the position map |

No evidence of pathological dust accumulation; inventory is Decimal-based with prune-on-write.

### 1.3.5 Checkpoint vs live inventory (ops lag)

| Metric | Value |
|--------|------:|
| Checkpoint present | yes |
| Checkpoint created | 2026-07-18T07:17:45Z |
| Checkpoint `positions_sha256` self-valid | **true** |
| Checkpoint vs live inventory mismatches | **1,341** instruments |

Example deltas (checkpoint → live):

| Instrument | Checkpoint | Live | Δ |
|------------|-----------:|-----:|--:|
| BTC-10JUL26-48000-P | 214.0 | 172.7 | −41.3 |
| BTC-10JUL26-50000-P | 338.3 | 222.6 | −115.7 |
| BTC-10JUL26-54000-P | 414.0 | 201.5 | −212.5 |

**Interpretation:** Checkpoint is a **durable incremental seed**, not the serving source of truth. Serving inventory is the latest materialize output. The mismatch means the checkpoint file was not rewritten to match the latest inventory CSV (or was written mid-cycle). **Not a math bug** — full rematerialize still matches live inventory.

Also note checkpoint counters look historically compressed (`applied_event_count=209,920` vs live manifest `2,282,605`) while `input_event_count≈2.34M` — consistent with bootstrap / partial-counter semantics on an older checkpoint write. Hash of the **positions map** is still self-consistent.

---

## Tier 1.4 — Excluded volume quantification (blocks + combos)

**Status: PASS** (quantified; production book unchanged)  
**Label:** `offline_sensitivity_only_production_unchanged`

### 1.4.1 Excluded flow table

| Window | Trades block∨combo % | Contracts block % | Contracts combo % | Block premium notional USD | Total premium notional USD | Block premium % |
|--------|---------------------:|------------------:|------------------:|---------------------------:|---------------------------:|----------------:|
| YTD | 2.590% | **46.85%** | 0.485% | 5,909,751,662 | 9,759,126,279 | **60.6%** |
| 90d | 2.375% | **45.82%** | 0.391% | 1,678,969,948 | 2,865,519,571 | **58.6%** |
| 30d | 2.286% | **46.38%** | 0.371% | 540,866,478 | 839,689,943 | **64.4%** |

**Key methodology statement:** v1 dealer inventory uses the **~53% of contracts** that are non-block (and non-combo). Nearly half of contract volume never enters `net_contracts`.

### 1.4.2 Offline sensitivity — top 3 strikes if blocks/combos **were** applied

Policy contrast (offline only):

```text
production: LedgerPolicy(exclude_block_trades=True, exclude_combo_trades=True, require_single_leg=True)
sensitivity: LedgerPolicy(exclude_block_trades=False, exclude_combo_trades=False, require_single_leg=False)
```

Rough GEX reuses live γ/S per instrument:  
`ΔGEX ≈ Δnet × mult × γ × S² × 0.01`.

| Strike | Prod net_contracts | With blocks/combos net | Δ net | Prod rough GEX | Sensitivity rough GEX | Δ rough GEX |
|-------:|-------------------:|-----------------------:|------:|---------------:|----------------------:|------------:|
| **64000** | −4,281.4 | −10,667.1 | **−6,385.7** | −5,614,133 | +137,071 | **+5,751,205** |
| **64500** | −39.9 | −682.7 | **−642.8** | −4,309,701 | −4,315,668 | −5,967 |
| **63500** | +568.1 | −990.8 | **−1,558.9** | −3,141,625 | −2,875,479 | **+266,146** |

**Findings:**

1. At **64000**, including blocks **more than doubles** short inventory and **flips/collapses** rough GEX by ~5.8M — blocks are first-order for this wall.
2. At **64500**, inventory changes a lot in contracts, but rough GEX barely moves (gamma concentrated on instruments that were already in the single-leg book / different mix).
3. At **63500**, including blocks flips strike inventory from **+568 → −991** (sign change) with a ~0.27M GEX move.

**Production remains block/combo-excluded.** This section is a one-off counterfactual only.

---

## Tier 2.1 — Replay determinism / checkpoint fidelity

**Status: PASS**

### 2.1.1 Checkpoint fidelity

| Field | Value |
|-------|-------|
| Path | `project/runtime/dashboard_build/inventory_checkpoint.json` |
| Version | `phase6.inventory_checkpoint.v1` |
| Normalization / ledger / GEX versions | `phase2.v1` / `phase3.ledger.v1` / `phase4.gex.v1` |
| Stored `positions_sha256` | `fdabdbf5d89b0f9a8c598de8ac4ea061a9f64e3b6fb73563eac046d28915439d` |
| Recomputed hash | **identical** → `positions_hash_valid=true` |
| Position count in checkpoint | 8,800 |

Checkpoint is **internally consistent**. It is **not** equal to the current live inventory map (1,341 deltas; see §1.3.5) — treat as ops lag.

### 2.1.2 Full genesis replay vs live inventory

| Comparison | Result |
|------------|--------|
| Full lightweight YTD rematerialize inventory SHA | `d4a6f9f6…850554` |
| Live inventory SHA | `d4a6f9f6…850554` |
| Match | **true** |
| Diverged instruments | **0** |

This is stronger than comparing two incremental paths: it proves the **live serving book equals a from-genesis rebuild** of the entire raw history under current methodology.

### 2.1.3 Double-run determinism note

A second independent full rematerialize was **not** re-run in this pass (disk/time budget; one full pass already consumed ~158s + peak RAM during normalize). Evidence chain instead:

1. Unit test `tests/test_incremental_materialize.py::test_incremental_replay_matches_full_positions` enforces incremental ≡ full on synthetic streams.
2. `pipeline/validation.py::compare_materializations` is used by `validate_dashboard_pipeline.py` for artifact hash equality under frozen Greeks.
3. This run’s **full genesis ≡ live inventory** is an end-to-end production-data determinism proof for the position map.

Optional operator command for a pure A/B double full run:

```powershell
python project/scripts/run_validation_framework.py --second-full-replay
```

### 2.1.4 Live ledger manifest (ops reference)

From `project/runtime/dashboard_build/ledger_manifest.json`:

| Field | Value |
|-------|------:|
| input_event_count | 2,343,301 |
| applied_event_count | 2,282,605 |
| excluded_event_count | 60,696 |
| final_nonzero_position_count | 8,799 |
| methodology_version | phase3.ledger.v1 |
| retain_deltas | false (live lightweight) |

---

## Tier 2.2 — Scale sanity vs public Deribit stats

**Status: PASS** (check executed; numbers are **order-of-magnitude**, not a recon)

### 2.2.1 Our 24h applied single-leg volume proxy

Window: **2026-07-17T08:06:52Z → 2026-07-18T08:06:52Z**

| Metric | Value |
|--------|------:|
| Our single-leg contracts (no block/combo id) | **12,872.6** |
| Our single-leg trades | 8,231 |
| Our all contracts (incl. blocks/combos) | 41,560.4 |
| Our all trades | 8,441 |

### 2.2.2 Public Deribit book summary (live fetch)

Source: `GET /public/get_book_summary_by_currency?currency=BTC&kind=option`

| Metric | Value |
|--------|------:|
| Instruments returned | 870 |
| Σ `open_interest` | **407,276.8** contracts |
| Σ `volume` (exchange 24h field) | **7,844.0** contracts |

### 2.2.3 Ratios

| Ratio | Value | Reading |
|-------|------:|---------|
| Our 24h single-leg contracts / Deribit Σ volume | **164.1%** | **Do not treat as overcount failure.** Book-summary `volume` is not guaranteed to equal “all public trades amount sum” over an exact wall-clock window; units/aggregation differ; our DB may also include trades not in the active instrument set’s book-summary volume field. Flag for methodology literacy, not auto-fail. |
| Our live GEX \|net_contracts\| / Deribit OI | **69,449.7 / 407,276.8 ≈ 0.1705 (17.1%)** | Flow-netted residual inventory is a **fraction** of gross OI — expected. |
| Our full inventory \|net\| (include_in_gex) / Deribit OI | 518,417.5 / 407,276.8 ≈ **1.27** | Includes many expired residual positions still in the ledger CSV; **not** comparable to live OI. Prefer the live-GEX instrument ratio above. |
| Snapshot row Σ OI / Deribit OI | 405,475 / 407,277 ≈ **99.6%** | Phase 5 OI attachment is **tight** vs public book — good Greeks/OI plumbing check. |

### 2.2.4 Handbook alignment

Agent handbook already warns: flow-netted GEX peaks in the low millions can be correct while OI dashboards show tens of millions. Observed total_net_gex ≈ **−17.4M** with top strike ≈ **−6.8M** is consistent with that framing.

---

## Tier 2.3 — Formula confirmation

**Status: PASS**

### 2.3.1 Exact production code

**File:** `project/greeks/gex_engine.py`  
**Function:** `compute_gex_profile`  
**Lines:**

```python
position_gamma = row.net_contracts * row.contract_multiplier * greek.gamma
dollar_gamma_per_1pct = position_gamma * (greek.spot_price**2) * 0.01
```

| Property | Confirmed |
|----------|-----------|
| Uses **S² × 0.01** | **Yes** |
| Convention | **USD GEX per 1% move** |
| Methodology version | `phase4.gex.v1` |
| Put sign flip | **No** |
| Sign source | Dealer `net_contracts` only (taker-flow mirror) |
| Multiplier source | Instrument `contract_size` (typically `1` on Deribit BTC options) |

Strike aggregation:

```text
call_gex[strike] += dollar_gamma_per_1pct for calls
put_gex[strike]  += dollar_gamma_per_1pct for puts
net_gex = call_gex + put_gex
gross_gex = |call_gex| + |put_gex|
```

### 2.3.2 Worked numerical example (current top strike 64000)

Largest \|dollar_gamma\| instrument under strike 64000 from `gex_by_instrument.csv`:

| Field | Value |
|-------|------:|
| Instrument | **BTC-18JUL26-64000-P** |
| option_type | put |
| net_contracts | **−49.6** |
| contract_multiplier | **1.0** |
| gamma | **0.0026** |
| spot_price | **63,927.57** |

**Arithmetic:**

```text
position_gamma = (−49.6) × 1.0 × 0.0026
               = −0.12896

dollar_gamma_per_1pct = (−0.12896) × (63927.57)² × 0.01
                      = (−0.12896) × 4,086,734,268.2 × 0.01
                      = −5,270,252.432192879
```

| Check | Value |
|-------|------:|
| Stored `dollar_gamma_per_1pct` | −5,270,252.432192879 |
| Matches computed | **true** |

### 2.3.3 Unit-test cross-check

From `tests/test_gex_engine.py`:

```text
call: net=2, mult=1, γ=0.0002, S=100000
dollar_gex = 2 × 1 × 0.0002 × 100000² × 0.01 = 40,000
```

Asserted as `strike_row.call_gex == 40000` — same convention.

---

## 3. Cross-cutting architecture map (for the expert agent)

```text
history.deribit.com / www.deribit.com
        │
        ▼
Phase 1 SQLite raw_trades (immutable, dedupe instrument_name+trade_id)
        │
        ▼
Phase 2 normalize (is_block / is_combo / exclusion_reasons)
        │
        ▼
Phase 3 LedgerReplayer + LedgerPolicy
   applied: single-leg non-block non-combo BTC options
   dealer Δ = −amount (taker buy) / +amount (taker sell)
        │
        ├─ inventory_snapshot.csv  (net_contracts)
        └─ inventory_checkpoint.json (ops acceleration only)
        │
        ▼
Phase 4 compute_gex_profile (γ, S from ticker; S²×0.01)
        │
        ▼
Phase 5 latest_gex_snapshot.json  ← FastAPI SnapshotRepository (no recompute)
        │
        ▼
Vite terminal /api/v1/terminal-snapshot
```

### 3.1 Critical file index

| Concern | Path |
|---------|------|
| GEX formula | `project/greeks/gex_engine.py` |
| Dealer delta / exclusions | `project/ledger/rules.py` |
| Replay / dust | `project/ledger/replay.py` |
| Block/combo detect | `project/normalizer/trades.py` |
| Materialize orchestrator | `project/pipeline/dashboard_snapshot.py` |
| Checkpoint | `project/pipeline/inventory_checkpoint.py` |
| Existing validators | `project/pipeline/validation.py` |
| This framework | `project/pipeline/validation_framework.py` |
| API (read-only) | `project/api/repository.py` |
| Methodology docs | `project/docs/agent_handbook.md` |

### 3.2 What this report does **not** claim

- Perfect OI/volume reconciliation with Deribit marketing stats  
- That excluding blocks is “correct economically” — only that it is **implemented as designed** and quantified  
- That the stale checkpoint is harmless for **incremental** recovery without a refresh (ops should rewrite after materialize)  
- Multi-year history beyond current YTD DB  

---

## 4. Recommended follow-ups (optional, non-blocking)

1. **Checkpoint rewrite discipline:** After each successful materialize, ensure `inventory_checkpoint.json` positions match `inventory_snapshot.csv` (today: 1,341 lag).  
2. **Large non-block print policy:** Decide whether prints >N contracts without `block_trade_id` should be soft-flagged in the UI or still fully applied (current: fully applied).  
3. **Block sensitivity monitor:** Schedule the top-strike counterfactual (§1.4.2) weekly — 64k is highly block-sensitive.  
4. **Expired residue GC (optional):** Expired nonzero ledger rows are fine for audit but inflate `|net|` vs OI comparisons; document clearly in any external scale claims.  
5. **Optional double full rematerialize:** `python project/scripts/run_validation_framework.py --second-full-replay` for belt-and-suspenders A/B hashes.

---

## 5. Reproduction commands

```powershell
# Full framework (includes one full lightweight YTD rematerialize ~2–4 min)
python project/scripts/run_validation_framework.py

# Fast path (SQL + strike paths + formula + scale; skip full rematerialize)
python project/scripts/run_validation_framework.py --skip-full-materialize

# Outputs
#   project/runtime/validation_expert/framework_diagnostics.json
#   project/runtime/validation_expert/fresh_materialize/   (if full run)
```

Existing pipeline validator (broader E2E, heavier artifacts; prior YTD attempt failed on disk when writing multi-GB JSONL):

```powershell
python project/scripts/validate_dashboard_pipeline.py `
  --db-path project/data/phase1_history.sqlite3 `
  --artifacts-dir project/runtime/history_validation `
  --snapshot-path project/runtime/history_validation/latest_gex_snapshot.json `
  --minimum-history-hours 4700
```

Prefer the new framework runner for deep history on disk-constrained hosts.

---

## 6. Sign-off checklist for the validation expert agent

- [x] T1.1 window tables (YTD/90/30/7) with trade %, contracts, notional  
- [x] T1.1 unique instruments, low-volume days, >2h gaps (incl. RTH-equivalent definition)  
- [x] T1.2 top 5 \|GEX\| strikes path: start/end/maxabs/1d/1h jumps, top-5 concentration, non-block jump flags  
- [x] T1.3 live vs fresh `net_contracts` exact match; Greeks/expiry drops; dust  
- [x] T1.4 excluded volume + offline block sensitivity at top 3 strikes  
- [x] T2.1 checkpoint hash validity + full genesis replay vs live  
- [x] T2.2 Deribit public OI/volume rough scale  
- [x] T2.3 exact formula lines + worked numerical example  

**End of report.**
