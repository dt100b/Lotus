# Surface Validation Corpus Plan

Status: implementation contract for historical snapshot capture,
calibration observability, and promotion-readiness evidence.
This document does **not** promote `constrained_svi`.

Product identity is unchanged: a market-implied risk engine. The
corpus answers a calibration-quality question, not a predictive one.

> Across a representative sample of real BTC option snapshots and
> expiries, how often does constrained SVI produce a statistically
> and economically credible, valid market-implied distribution when
> data is sufficiently liquid — and how does it fail when it should?

This is **not** a backtest, not a forecast study, and not a reason
to loosen any serving gate.

---

## 1. Why this exists

One or two live snapshots of a single End-of-Week BTC expiry are
not evidence of reliability. The first accepted `constrained_svi`
density on a liquid weekly is a milestone, not a production
promotion. Earlier snapshots of the same expiry correctly failed
the residual-quality budget. Both outcomes must be replayable.

The corpus is the evidence layer required before any later decision
to change:

```
fitter_grade = diagnostic_candidate
```

to a higher grade. Promotion criteria live in
`docs/constrained_svi_promotion_rubric.md`. This plan only defines
how evidence is captured, stored, replayed, and summarized.

---

## 2. Non-negotiable invariants

These remain true and are not in scope to change:

1. The product is a market-implied risk engine, not a forecast or
   directional scanner.
2. The selected forward hierarchy and `F_T` consistency rules stay
   as specified in `docs/options_surface_methodology.md`.
3. Native inverse BTC premium conventions stay native.
4. The selected density remains fail-closed unless all serving
   gates pass.
5. `constrained_svi` remains `diagnostic_candidate`.
6. `tv_pchip` remains a non-serving exact-interpolant diagnostic
   baseline. It is never used to serve density.
7. `svi_raw` remains research-only.
8. No IV, price, density, or CDF clipping; no density
   renormalization; no Gaussian smoothing of headline statistics;
   no invented wings or extrapolated density.
9. Existing hard serving gates and residual-budget thresholds are
   unchanged.
10. GEX, dealer positioning, heatmap, vol-compare, and unrelated
    terminal code are out of scope.

A feature-flag or serving-mode change must not alter historical
replay results without a recorded configuration / version marker.

---

## 3. Existing stores and why a capture schema is added

Two persistence paths already exist:

| Path | Schema | Purpose |
| --- | --- | --- |
| `project/runtime/dashboard_build/options_surface/snapshots.jsonl` | `options_surface.v1` | Live API latest-pointer plus append-only served result |
| `runtime/options_surface_debug/<stamp>/` | forensic dump | One-off rejection / harness artifacts |

`options_surface.v1` is the served result. It is **not** enough to
replay the complete serving decision without re-querying Deribit:

- No unique snapshot ID, code version, or config hash.
- Matching-future bid / ask / age / quality are not stored; rebuild
  reconstructs a mid-only future.
- Quote-weight components are collapsed to a scalar `fit_weight`.
- Candidate optimizer starts, residual-vs-envelope, and per-start
  notes are summarized, not archived.
- Serving mode is implicit.

The live API store is retained unchanged in role. The validation
corpus uses a **new, versioned capture envelope** that embeds the
served result plus the market inputs required for offline replay.

Default corpus root:

```
project/runtime/options_surface_snapshots/
```

This is not a second live-serving store. It is the analysis
archive. Analyzer commands default to this root.

---

## 4. Capture schema

Schema id: `options_surface_capture.v1`

Format: UTF-8 JSONL, one complete record per line, keys sorted,
separators compact, no `NaN`/`Infinity`. Each record is also
written as an atomic sidecar JSON for random access.

### 4.1 Snapshot metadata

- `schema_version`
- `snapshot_id` (UUIDv4, generated at persist time)
- `capture_utc`, `as_of_utc`
- `code_version` (`git_commit`, `git_dirty`, `package_version`)
- `config_version`, `config_hash`, `serving_mode`
- `underlying`, `expiry`, `expiry_utc`
- `time_to_expiry` seconds / years / days / hours
- `source` (API / chain identifiers only)
- `environment.host_id` (hashed hostname; no user data)

### 4.2 Market inputs

Enough to call `build_options_surface` without Deribit:

- selected index / spot
- every native option ticker field required by the normalizer
- option instrument metadata present at capture
- future instrument metadata
- matching and candidate future bid, ask, mark/mid, timestamp,
  and quality fields
- all candidate forward inputs required to reproduce hierarchy /
  fallback (`matching_future`, `inverse_put_call_parity`,
  `venue_underlying_price`, `spot_fallback`)
- feed-health / freshness state and API failure details

### 4.3 Normalization outputs

- accepted and rejected observations
- exact rejection reason codes
- canonical OTM selection outcome
- quote weights **and** every component used to build them
- origin tags: raw observed, merged ATM, synthetic ATM, fallback,
  excluded

### 4.4 Fit outputs for every candidate

Always recorded when the book is fitable, even if not served:

- `constrained_svi` (`diagnostic_candidate`)
- `tv_pchip` (`diagnostic`)
- `svi_raw` (`research`)

Per candidate: identity, grade, attempted / converged, optimizer
status / message, parameters, initialization / start identifier,
objective, weighted RMS, max residual, residual-versus-bid/ask-IV
envelope summary, observed coverage bounds, model / arbitrage
diagnostics, rejection / selection reason codes.

In `disabled` mode, `constrained_svi` is recorded as
`not_attempted` and is never selected.

### 4.5 Serving result

- selected candidate and selection reason
- forward estimate and quality metadata
- served call-price grid diagnostics
- density diagnostics and metric eligibility
- smile / density / surface display statuses
- customer-safe reason
- detailed developer reason codes
- primary failure category when unavailable:
  `market_data` | `fit_quality` | `hard_gate` | `none`

The existing `options_surface.v1` public result is embedded under
`served_result` for convenience. Replay must use `market_inputs`,
not the embedded result, as the source of truth.

---

## 5. Reliability requirements

- **Append-only.** Records are never updated in place. A later
  recapture is a new `snapshot_id`.
- **Atomic writes.** Sidecar JSON is written to `*.tmp` and
  renamed. JSONL append is a complete line plus `fsync`.
- **Deterministic serialization.** Sorted keys, ISO-8601 UTC,
  enum values, finite numbers only.
- **Partial / corrupt records.** A truncated last line or invalid
  JSON is skipped, counted, and never mixed into analysis totals
  as a valid snapshot.
- **No secrets.** Credentials, tokens, authorization headers, and
  unrelated user data are stripped on write.
- **Retention.** Configurable
  `LOTUS_SURFACE_CAPTURE_RETENTION_DAYS` (default 180). Deletion
  is an explicit compact operation, not silent overwrite.
- **Analysis without live API.** Replay uses only persisted market
  inputs and the recorded serving config.

Partition layout:

```
project/runtime/options_surface_snapshots/
  manifest.json
  YYYY/MM/captures-YYYY-MM-DD.jsonl
  records/<snapshot_id>.json
  locks/collector.lock
  logs/collector.log
```

The live `options_surface.v1` JSONL remains at
`project/runtime/dashboard_build/options_surface/`. The analyzer
may **identify** those records but will not silently mix them into
`options_surface_capture.v1` totals.

---

## 6. Capture and collection jobs

### One-shot capture

```
python -m project.scripts.capture_options_surface --underlying BTC --expiry 2026-08-21
```

### Curated-expiry capture

```
python -m project.scripts.capture_options_surface --underlying BTC --curated-expiries
```

When available, the curated set is at most a configured maximum
(default 4) and prefers:

1. nearest eligible End-of-Week
2. following weekly
3. nearest End-of-Month
4. following monthly or quarterly

Expired or missing contracts are skipped, not invented. The job
does not scrape every listed expiry by default.

### Repeatable collector

```
python -m project.scripts.collect_options_surface --once
python -m project.scripts.collect_options_surface --loop
```

Properties:

- disabled unless `LOTUS_SURFACE_COLLECT_ENABLED=true`
- conservative default cadence (3600 s), not hardcoded aggressive
- single-instance lock
- UTC timestamps
- stdout + file logging
- one bad expiry cannot kill the batch
- bounded retries, rate-limit pause between expiries
- dry-run, one-shot, and loop modes
- batch summary on completion

No cloud scheduler. Windows Task Scheduler / PowerShell wrapper
is documented. Local loop is for test and desk use.

---

## 7. Replay

Replay is the unit of truth for capture quality:

```
capture -> persist -> load -> build_options_surface(market_inputs, recorded_config)
```

A successful round-trip requires:

- same selected candidate
- same density / smile / surface display statuses
- same primary failure category and serving reason codes
- same residual-budget pass / fail
- same forward source and quality

Replay uses the **recorded** serving mode and config hash. Current
process flags must not change a historical replay.

---

## 8. Analyzer

```
python -m project.scripts.analyze_options_surface_corpus `
  --input project/runtime/options_surface_snapshots `
  --from 2026-08-16 --to 2026-09-30
```

Reports, overall and by analysis tenor bucket:

- capture attempts / successes / failures
- expiries evaluated, unique snapshot count
- availability: `density_status` accepted / degraded / rejected /
  unavailable due to market-data failure
- forward-source and quality distribution
- candidate selection and fit-failure rates
- serving-gate failure rates by reason family
- residual, quote-width, observation-count, wing-balance,
  center-gap, and DTE distributions
- density-metric stability (forward, ATM IV, RR25, BF25, implied
  move, eligible quantiles)
- candidate parameter and optimizer-health distributions
- PCHIP-fail / constrained-pass and the reverse
- suspicious “almost always accepted” or “almost always rejected”
  patterns

Analysis tenor buckets (descriptive only; they do **not** change
serving coverage floors):

- 0–2, 3–7, 8–14, 15–30, 31–90, >90 DTE

Outputs: machine-readable JSON + CSV, human-readable Markdown, a
run manifest (input files, schema versions, software / config
version, analysis timestamp). Charts only if they have a documented
data source and honest scales.

Language forbidden in analyzer output: predictive accuracy,
performance, alpha, backtest, forecast, LONG / SHORT.

---

## 9. Shadow-mode guardrails

Typed, versioned, logged configuration
(`surface_serving_config.v1`):

| Mode | Constrained SVI | Serving |
| --- | --- | --- |
| `diagnostic_candidate` | attempted | may serve only if existing gates pass; surface stays `degraded` |
| `shadow_compare` | attempted | selection recorded; publish policy is explicit (`serve` or `record_only`) |
| `disabled` | **not** attempted | rejected / unavailable, or an explicit non-PCHIP baseline |

There is no hidden PCHIP fallback in any mode. `tv_pchip` may be
compared and recorded; it cannot be selected for density serving.

Each persisted snapshot records `serving_mode`, `config_version`,
`config_hash`, and the selected candidate.

---

## 10. UI / API observability (minimal)

Additive fields only. Customer copy stays non-directional.

For an accepted diagnostic-candidate density:

- “Market-implied distribution — diagnostic fit”
- forward source and quality
- smile fitter and grade
- distribution availability and validation status
- as-of timestamp / staleness
- compact diagnostics: residual-budget result, accepted
  observation count, observed coverage, serving-gate summary,
  selected candidate, model / config id

For rejected / unavailable:

- existing unavailable state preserved
- primary failed reason
- compact category: market-data / coverage, fit-quality, or hard
  no-arbitrage / numerical failure

No SVI parameter dump, no optimizer log, no forecast language.

---

## 11. Implementation order

1. This plan.
2. Typed serving config and shadow-mode wiring (no gate changes).
3. Capture record + atomic store + replay.
4. One-shot and curated-expiry CLI.
5. Collection runner + Windows wrapper + env section.
6. Offline analyzer and rubric-metric export.
7. Promotion rubric document.
8. Minimal API / UI observability.
9. Deterministic tests listed in the milestone brief.
10. Methodology, data dictionary, validation, and implementation
    report updates.

Do not redesign the fitter. Do not loosen gates. Do not change
model-selection policy so that more expiries pass. Do not implement
SSVI surface calibration, wing extrapolation, or cross-maturity
serving in this pass.

---

## 12. What this pass will not claim

At the end of this work:

- `constrained_svi` is still `diagnostic_candidate`.
- A working capture / analyze pipeline is not a production
  promotion.
- Empty or short corpora are reported as insufficient evidence,
  not as a passing grade.
