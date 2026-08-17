# Options Surface Data Dictionary

Schema version: `options_surface.v1`

Canonical endpoint: `GET /api/v1/options-surface?expiry=YYYY-MM-DD`

Deprecated adapter: `GET /api/v1/iv-signal-scan` (directional fields retired).

## Top-level result

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | string | Document version |
| `as_of_utc` | datetime | Valuation clock |
| `expiry_utc` | datetime | Instrument expiry (UTC) |
| `expiry` | date | ISO expiry date |
| `underlying` | string | `BTC` now; ETH-ready |
| `index_usd` | float | Venue index / spot. Not the model center. |
| `time_to_expiry_years` | float | `T` in actual/365 |
| `forward` | object | `ForwardEstimate` |
| `quotes` | object | Accept/reject summary |
| `smile` | object | Observed / synthetic / fit |
| `density` | object or null | Validated B–L result |
| `analytics` | object | Descriptive metrics |
| `validation` | object | Status + arb + reasons |
| `model_status` | enum | `accepted` `degraded` `rejected` `research` |
| `fitter_name` | string | `constrained_svi`, `tv_pchip`, or `svi_raw` |
| `fitter_grade` | enum | `production` `diagnostic` `diagnostic_candidate` `research` |
| `selection_reason` | string | Why the served candidate was chosen or rejected |
| `fit_converged` | bool | Optimizer / multi-start produced a finite smile |
| `fit_residual_summary` | object | RMS, weighted RMS, max residual, residual budget |
| `served_call_monotone` | bool? | Uniform-`K` Black-76 monotone on the density grid |
| `served_call_convex` | bool? | Uniform-`K` Black-76 convex on the density grid |
| `served_density_grid` | int? | Serving-grid size used for the call-curve gates |
| `selected_model_status` | string | `selected` `explicit` `rejected` `not_evaluated` |
| `display` | object | Explicit customer-facing state. Frontends must not infer this from nulls. |
| `feed` | object | Ticker transport health |
| `freshness` | object | Snapshot age vs threshold |
| `warnings` | string[] | Human-readable flags |

## Display state

`display` is the typed UI contract.

| Field | Values | Meaning |
| --- | --- | --- |
| `quote_status` | `accepted` `degraded` `rejected` | Book quality after reason-coded filters |
| `smile_status` | `accepted` `degraded` `rejected` `research` | Served fitter status |
| `density_status` | `accepted` `degraded` `rejected` `unavailable` | B–L validation. `unavailable` = not built |
| `surface_display_status` | `ready` `degraded` `rejected` `unavailable` | What the pane may present |
| `reason_codes` | string[] | Machine-readable failed checks |
| `human_readable_reason` | string | One-line customer-safe explanation |
| `diagnostic_detail` | string | Developer/debug only |
| `failed_checks` | string[] | Concise customer labels |
| `metric_eligibility` | list | Per-metric `{metric, available, reason_code, reason}` |

A smile can be `degraded` while density is `rejected`. That combination
yields `surface_display_status = rejected`. A diagnostic fitter or
`diagnostic_candidate` cannot produce `ready`.

`fitter_grade = diagnostic_candidate` means the served model passed
the current serving gates on this book and is still provisional. It
is not a production promotion. Customer copy is “Market-implied
distribution — diagnostic fit” / “Served constrained smile —
diagnostic candidate.” It must not say arbitrage-free or
production-grade.

Residuals are in total variance unless a field is named `*_iv`.
A smooth constrained fit is *supposed* to differ from individual
mark IVs; `fit_residual_summary` records how far, and
`residual_budget_ok` says whether that distance is still consistent
with quote quality. `candidate_comparison` is developer/snapshot
only and never changes customer `density_status` for a research row.

### Metric eligibility

| Metric | Rejected density? | Condition |
| --- | --- | --- |
| `forward` | yes | forward exists; show source/quality |
| `index` | yes | index exists |
| `quote_coverage` | yes | always |
| `atm_iv` | yes, labeled diagnostic | ATM `k=0` inside observed coverage |
| `implied_move_1sd` | yes, as diagnostic smile-implied move | ATM IV valid |
| `rr_25` / `bf_25` | yes, same gate | both 25Δ roots solve inside observed `k` |
| `density_chart` | no | density `accepted` only |
| `median` / `mode` | no | density `accepted` only |
| `central_range_50` / `central_range_90` | no | density `accepted` only |
| `tail_probabilities` / `digital_probabilities` | no | density `accepted` only |

When `density.status = rejected`, the default `density.strikes_usd` /
`raw_density` / `cdf` / `quantiles` arrays are empty. The raw curve is
only in `density.diagnostic`, labeled
“Diagnostic only — not a valid probability distribution”.

## ForwardEstimate

| Field | Type | Meaning |
| --- | --- | --- |
| `forward_usd` | float? | Selected `F_T` |
| `source` | enum | `matching_future` `inverse_put_call_parity` `venue_underlying_price` `spot_fallback` |
| `source_quality` | enum | `high` `medium` `low` `unavailable` |
| `supporting_instruments` | string[] | Futures or option names used |
| `parity_pair_count` | int | Inverse pairs that entered the estimator |
| `parity_dispersion` | float? | `stdev(F)/mean(F)` of those pairs |
| `futures_option_difference` | float? | Future mid − parity forward |
| `fallback_reason` | string? | Why a lower source was used |
| `validation_flags` | string[] | Non-fatal diagnostics |

## Quote quality

Rejection reasons:

`malformed_contract`, `expired`, `non_open`, `missing_quote`, `zero_bid`,
`zero_ask`, `crossed_price`, `one_sided_price`, `invalid_iv`,
`invalid_iv_market`, `mark_iv_outside_market`, `crossed_iv`,
`stale_quote`, `missing_size`, `wide_spread`, `low_delta`,
`low_open_interest`, `duplicate`, `sparse_expiry`, `out_of_range`,
`future_timestamp`, `insufficient_observations`.

Native quote units: bid/ask **BTC**; strike/index/forward **USD**; IVs
stored as absolute vol (0.50 = 50%). Deribit percentage-point IVs are
converted on ingest.

## Smile points

| `origin` | Meaning |
| --- | --- |
| `raw_observed` | Quality-filtered mark IV |
| `synthetic_atm` | Log-moneyness interpolant at `F` |
| `fitted` | Model value inside observed `k` |
| `interpolated` | Cross-expiry or in-slice interpolation |
| `extrapolated` | Outside observed coverage (not served as a price) |

`classification`: `preferred` `fallback` `synthetic` `fit`.

## Density

| Field | Meaning |
| --- | --- |
| `status` | `accepted` / `degraded` / `rejected` |
| `method` | `breeden_litzenberger_black76` |
| `raw_density` | Unclipped `q(K)` |
| `quantiles` | Present only when status ≠ `rejected` |
| `raw_negative_mass` | ∫ max(−q, 0) dK |
| `mass` | ∫ q dK (raw) |
| `forward_moment` | ∫ K q⁺ dK / ∫ q⁺ |
| `truncation_warning` | Material mass outside the grid |
| `grid_converged` | p50 stable across two resolutions |
| `digital_atm_error` | \|Q(S>F) − vertical-spread digital\| |

Rejected densities omit headline percentiles and tail probabilities.

## Analytics

| Field | Definition |
| --- | --- |
| `atm_iv` | Fitted IV at `k = 0` |
| `implied_move_1sd_up` | `F (e^{σ√T} − 1)` |
| `implied_move_1sd_down` | `F (1 − e^{−σ√T})` |
| `rr_25` | `(σ_{25c} − σ_{25p}) × 100` vol points |
| `bf_25` | `((σ_{25c} + σ_{25p})/2 − σ_ATM) × 100` |
| `downside_wing_richness` | Mean OTM-put IV − ATM, vol points |
| `p_*` | Risk-neutral probabilities (Q-measure) |
| `central_range_50` | RN 25th–75th percentile |
| `central_range_90` | RN 5th–95th percentile |

## Legacy field map

| Old `/iv-signal-scan` | New | Status |
| --- | --- | --- |
| `spot_price` | `index_usd` | kept as index |
| `selection.implied_forward` | `forward.forward_usd` | replaced |
| `selection.forward_source` | `forward.source` | enum extended |
| `verdict`, `model_verdict`, `signals.*`, `outlook.*` | — | retired; always `NO_TRADE` |
| `eligibility.directional_eligible` | — | always `false` |
| `rnd.percentile_*` | `density.quantiles` | fail closed |
| `density[].smoothed` | unused for stats | no Gaussian headline |

## Persistence

Append-only JSONL: `project/runtime/dashboard_build/options_surface/snapshots.jsonl`

Latest pointer: `latest_BTC_YYYY-MM-DD.json`
