# Options Surface Live Rejection — 20260816T230839Z

Immutable forensic artifact. Validation thresholds were not changed.
The diagnostic PCHIP fitter remains diagnostic.

## A. Request and market context

- API request: `GET /api/v1/options-surface?expiry=2026-08-21`
- Response schema: `options_surface.v1`
- as_of_utc: `2026-08-16T23:00:57.159956+00:00`
- expiry_utc: `2026-08-21T08:00:00+00:00`
- T: `0.0119844888` years / `4.3743` days / `104.98` hours
- selected index/spot: `62860.5500`
- selected F_T: `62885.0`
- forward source: `matching_future`
- forward quality: `high`
- supporting instruments: `['BTC-21AUG26']`
- parity pair count / dispersion: `3` / `0.00011984367368018927`
- futures−option difference: `10.748502994014416`
- fallback reason: `None`
- forward validation flags: `[]`
- warnings: `['density_rejected', 'synthetic_atm_anchor_inserted']`
- model_status: `rejected`
- smile_status: `degraded`
- density_status: `rejected`
- surface_display_status: `rejected`
- quote_status: `degraded`

Matching future book: the snapshot stores the selected mid (`F_T`) and
instrument name. Bid/ask/age of the listed future are not persisted on
the options-surface snapshot; the rebuild uses that mid as the matching
future. Live `source_quality` on this expiry was `high` with no fallback.

## B. Quote acceptance

- input rows: `36`
- accepted rows: `16` (calls `7`, puts `9`)
- rejected rows: `20`
- unique accepted strikes / k count: `13` / `13`
- lower / upper strikes vs forward: `7` / `6`
- observed k_min / k_max: `-0.133974476266648` / `0.07820004367698787`
- center log-moneyness gap: `0.01600034134644112`
- preferred / fallback / ATM merge / synthetic ATM: `13` / `0` / `0` / `True`
- rejection reason counts: `{'invalid_iv_market': 15, 'zero_bid': 5}`

Displayed “13 liquid strikes · 7/6 around ATM” is **not** a 7.6 strike
count. It was `accepted_strikes` plus `lower_strikes/upper_strikes`
(`13` · `7/6`).
The slash was misread as a decimal. Meaningful replacements:

- `13` accepted observations
- `7` strikes within ±5% of the forward
- Center gap: `0.01600034134644112` log-moneyness

Per-option table is in `runtime/options_surface_debug/20260816T230839Z/extra.json` (`quote_rows`).

## C. Smile calibration

### tv_pchip (served, diagnostic)

- status / grade: `degraded` / `diagnostic`
- optimizer: `interpolating_pchip`
- parameters: `{'knot_count': 14.0}`
- residual RMS / weighted: `0.0` / `0.0`
- k domain: `-0.133974476266648` → `0.07820004367698787` (observed only; no extrapolation served)
- notes: `['Baseline interpolant in total variance. Diagnostic grade: not an arbitrage-free parametric smile.', 'call_not_convex_in_strike']`
- call monotone / convex / butterfly_ok: `True` / `False` / `False`
- min_call_step / min_butterfly / worst convexity strike: `-2.500383726806831` / `-0.7251970073921257` / `56179.427840553966`
- input points and residuals: see extra.json `tv_pchip`

### svi_raw (research only, not served)

- status / grade: `research` / `research`
- optimizer: ``gtol` termination condition is satisfied.`
- parameters: `{'a': 5.901182538194894e-11, 'b': 0.018567630804125188, 'rho': -0.4454090678036051, 'm': -0.02005570385088329, 'sigma': 0.045211341911110044}`
- residual RMS / weighted: `4.868719810143197e-05` / `5.0352353259121826e-05`
- k domain: `-0.133974476266648` → `0.07820004367698787` (observed only; no extrapolation served)
- notes: `['Research-grade raw SVI. Not production-ready.', 'optimizer_success=True', 'cost=1.33166e-08', 'call_not_convex_in_strike']`
- call monotone / convex / butterfly_ok: `True` / `False` / `False`
- min_call_step / min_butterfly / worst convexity strike: `-2.036523747557567` / `-0.6251048194753821` / `55194.83760336925`
- input points and residuals: see extra.json `svi_raw`

## D. Call-price and density diagnostics

- served fitter: `tv_pchip` / `diagnostic`
- grid: uniform strike, `401` points from observed k range; compare grid 201, `grid_converged=True`

- exact reject gates: `[{'code': 'cdf_not_monotone', 'criterion': 'min_cdf_step', 'measured': -2.3945554125109122e-05, 'threshold': -1e-08, 'comparison': 'lt', 'location': 'K=56105.0000->56137.5000', 'severity': 'reject', 'message': 'Raw CDF decreased between adjacent strikes'}]`
- mass: `0.9852080658968008` (accept |m-1|<0.02, reject >0.10)
- raw negative mass: `0.000238014396075586` (accept ≤1e-8, reject >0.01); negative knots: `16`
- CDF monotone: `False` start/end `0.0` / `0.9852080658968001`
- worst CDF step: `{'index': 34, 'step': -2.3945554125109122e-05, 'K_left': 56105.0, 'K_right': 56137.5}`
- forward moment / rel error: `62865.229075685515` / `0.00031439809675575187`
- digital ATM error: `0.009114788564310805` (accept 0.03, reject 0.08)
- grid converged: `True`
- truncation warning: `False`
- quantiles present: `{}`
- **primary failed gate**: `cdf_not_monotone` measured `-2.3945554125109122e-05` lt threshold `-1e-08` at `K=56105.0000->56137.5000`

## E. UI payload provenance

| Item | Backend path | Origin | Allowed in rejected-density state |
| --- | --- | --- | --- |
| FWD | `forward.forward_usd` | accepted | yes |
| MED | `density.quantiles.p50` | rejected | no |
| MODE | `density mode / markers.peakStrike` | rejected | no |
| density curve | `density.strikes_usd/raw_density` | rejected | no |
| ATM IV | `analytics.atm_iv` | degraded | yes |
| RR25 | `analytics.rr_25` | accepted | yes |
| BF25 | `analytics.bf_25` | accepted | yes |
| 1-sd implied move | `analytics.implied_move_1sd_*` | degraded | yes |
| central 50% | `analytics.central_range_50` | rejected | no |
| central 90% | `analytics.central_range_90` | rejected | no |
| fit quality | `display.*_status` | rejected | yes |
| liquid strikes / around ATM | `quotes.accepted_strikes + lower/upper` | accepted | yes |
| chart axes / forward marker | `forward.forward_usd` | accepted | yes |

## Root cause

Distribution unavailable: the implied density was not a valid monotone probability distribution.

fitter=tv_pchip/diagnostic; forward=matching_future/high; F_T=62885.0000; density_status=rejected; mass=0.985208; raw_negative_mass=0.000238014; forward_moment_error=0.000314398; digital_atm_error=0.00911479; grid_points=401; grid_converged=True; gate cdf_not_monotone: min_cdf_step=-2.39456e-05 lt -1e-08 @ K=56105.0000->56137.5000; gate negative_density_mass: raw_negative_mass=0.000238014 gt 1e-08 @ K=56105.0000; worst_convexity_strike=56179.43 min_butterfly=-0.7251970073921257; k_coverage=[-0.133974, 0.078200]; codes=call_not_convex_in_strike,cdf_not_monotone,negative_density_mass,density_rejected

This is **not** a forward mismatch and **not** a grid-resolution failure.
The listed future is high quality. Quote coverage (13 accepted strikes,
7/6 wings, center gap ≈ 0.016) clears the 3–14 DTE floors. The served
`tv_pchip` interpolant is exact at knots but does not enforce butterfly
arbitrage. The fitted call surface is not convex, so the Breeden–Litzenberger
second derivative is not a valid density: the raw CDF is not monotone.
Negative mass exists but is **below** the reject threshold; the reject
gate is specifically `cdf_not_monotone`.

Recommendation: **combination** — no validation-threshold change;
UX must fail closed (this work); a later calibration/model correction
is needed before any production smile promotion. Do not promote PCHIP.

## Live API echo

- live as_of: `2026-08-16T23:08:39.353291Z`
- live model_status: `degraded`
- live density notes: `[]`

