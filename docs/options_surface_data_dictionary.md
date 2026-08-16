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
| `fitter_name` | string | `tv_pchip` or `svi_raw` |
| `fitter_grade` | enum | `production` `diagnostic` `research` |
| `feed` | object | Ticker transport health |
| `freshness` | object | Snapshot age vs threshold |
| `warnings` | string[] | Human-readable flags |

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
