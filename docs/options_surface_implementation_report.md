# Options Surface Implementation Report

Date: 2026-08-17 (constrained-smile pass; original rebuild 2026-08-16)

## 1. What was built

A new market-implied risk engine under `project/options_surface/`, a
versioned API `GET /api/v1/options-surface`, a retired-field adapter on
`GET /api/v1/iv-signal-scan`, and a frontend that no longer presents
the Options Surface as a directional forecast.

The GEX / dealer-positioning / vol-compare / heatmap paths were not
rewritten.

## 2. Architecture

```
Deribit WS ticker cache          Deribit REST future book
(pipeline/deribit_ticker_stream) (options_surface/market_data/futures)
              │                              │
              ▼                              ▼
     native option quotes              NativeFutureQuote
              │                              │
              └──────────┬───────────────────┘
                         ▼
              normalization.quotes  (reason codes)
                         ▼
              forward.estimate      (future → parity → venue → spot)
                         ▼
              normalization.otm     (same F_T)
                         ▼
              surface.smile         (constrained_svi diagnostic candidate;
                                     tv_pchip diagnostic; svi_raw research)
                         ▼
              distribution.black76 + B–L + validate
                         ▼
              analytics.metrics     (no directional composite)
                         ▼
         /api/v1/options-surface    + snapshot JSONL
                         ▼
         IvSignalScannerQuickView   (market-implied copy)
```

## 3. Changed files

### New

- `docs/options_surface_rebuild_plan.md`
- `docs/options_surface_methodology.md`
- `docs/options_surface_data_dictionary.md`
- `docs/options_surface_validation.md`
- `docs/options_surface_implementation_report.md`
- `project/options_surface/**` (types, time, market_data, normalization,
  forward, surface, distribution, analytics, service, api_adapter)
- `project/tests/options_surface/**`

### Updated (Options Surface path only)

- `project/api/schemas.py` — new response + extended forward enum +
  deprecation on the legacy scan response
- `project/api/repository.py` — `get_options_surface`, legacy adapter
- `project/api/main.py` — new endpoint; futures provider on the live repo
- `project/tests/test_iv_signal_scanner.py` — four API/repository
  assertions migrated off LONG/SHORT and the 100-point spline contract
- `frontend/src/api/ivSignalScanner.ts` — fetches `/options-surface`
- `frontend/src/hooks/useIvSignalScan.ts`
- `frontend/src/data/ivSignalOutlook.ts` — approved labels only
- `frontend/src/components/terminal/IvSignalScannerQuickView.tsx`

### Intentionally untouched

- `project/greeks/**`, GEX heatmap / profile / forward-Greek surface
- `project/pipeline/vol_compare.py`, `skew_25d.py`, `flow_regime.py`
- `project/collector/**`, `ledger/**`, `normalizer/**`
- `project/pipeline/iv_signal_scanner.py` (legacy prototype math,
  still importable; not on the production API path)
- `project/scripts/compare_iv_signal_parity.py` (parity vs the
  prototype; not a production backtest)

## 4. Retained / replaced / deprecated / deferred

| Item | Disposition |
| --- | --- |
| Live Deribit WS ticker cache | Retained |
| Native BTC premiums, bid/ask IV, OI, venue timestamps | Retained |
| Inverse `F = K / (1 − (C − P))` | Retained after validation |
| Exact/365 time | Retained; prefer instrument expiry timestamp |
| Frontend pane shell, expiry aliases, smile/density layout | Retained |
| Matching listed future as preferred forward | **Added** |
| Black-76 + B–L on `F_T` | **Replaced** Black–Scholes-on-spot PDF |
| Total-variance PCHIP smile | **Replaced** unconstrained IV(K) spline as the served fitter |
| Quote reason codes | **Replaced** silent drop counts |
| LONG/SHORT votes, outlook hysteresis, 0DTE directional gate | **Retired** from API/UI |
| Prototype sliders / synthetic-backtest hooks | **Isolated**; not in the production path |
| `tv_pchip` production promotion | **Deferred** — diagnostic baseline only |
| Constrained SVI serving candidate | **Added** — `constrained_svi`, grade `diagnostic_candidate` |
| Constrained SVI/SSVI production promotion | **Deferred** |
| Full SSVI surface / wing extrapolation | **Deferred** |
| Futures on the option WebSocket | **Deferred** — REST book-summary |
| ETH | **Deferred** — interfaces are currency-generic |
| True historical evaluation | **Deferred** — not a backtest |

## 5. Tests

```
.\.venv\Scripts\python.exe -m pytest project/tests/options_surface project/tests/test_iv_signal_scanner.py -q
```

Result: **93 passed** (2026-08-17 constrained-smile pass, including harness).

```
.\frontend\node_modules\.bin\tsc -p frontend\tsconfig.app.json --noEmit
```

Result: clean.

Browser verification of the live pane was not executed in this pass
(no browser tool session against a running API). The UI contract is
covered by the TypeScript compile and the API adapter tests. A live
click-through remains recommended before calling the pane
production-ready.

## 6. Known limitations

- Served fitter is **`constrained_svi` / `diagnostic_candidate`**.
  Overall `model_status` is therefore `degraded` even on a clean
  flat-vol book with a matching future and an accepted density.
- `tv_pchip` is a diagnostic baseline only. It is never selected for
  density serving, including when it happens to pass the serving grid.
- `svi_raw` is research-only. A butterfly failure on raw SVI cannot
  reject or contaminate a passing constrained candidate.
- Density lives only inside the observed `k` range. Far-tail mass is a
  truncation warning, not an invented wing.
- `r = 0` in Black-76.
- Futures are REST, not streamed; a missing future book silently falls
  through the hierarchy.
- Legacy `/iv-signal-scan` still exists with retired directional fields
  (`NO_TRADE` / `false`) for one migration window.
- Live Aug 21 2026 rejection was frozen:
  `docs/diagnostics/options_surface_live_rejection_20260816T230839Z.md`
  and `runtime/options_surface_debug/20260816T230839Z/`.

## 7. Example payloads

### Good-quality expiry (matching future, dense book)

Status is `degraded` only because the served fitter is diagnostic.

```json
{
  "schema_version": "options_surface.v1",
  "as_of_utc": "2030-08-15T12:00:00+00:00",
  "expiry_utc": "2030-08-16T08:00:00+00:00",
  "underlying": "BTC",
  "index_usd": 99800.0,
  "forward": {
    "forward_usd": 100000.0,
    "source": "matching_future",
    "source_quality": "high",
    "supporting_instruments": ["BTC-16AUG30"],
    "parity_pair_count": 3,
    "parity_dispersion": 0.0049,
    "futures_option_difference": 0.0,
    "fallback_reason": null
  },
  "quotes": {
    "accepted_strikes": 10,
    "lower_strikes": 4,
    "upper_strikes": 5,
    "tenor_bucket": "0_2_dte"
  },
  "model_status": "degraded",
  "fitter_name": "constrained_svi",
  "fitter_grade": "diagnostic_candidate",
  "selection_reason": "selected_constrained_svi_diagnostic_candidate"
}
```

### Degraded / rejected expiry (sparse book)

```json
{
  "schema_version": "options_surface.v1",
  "forward": {
    "forward_usd": 100000.0,
    "source": "matching_future",
    "source_quality": "high"
  },
  "quotes": {
    "accepted_strikes": 3,
    "lower_strikes": 1,
    "upper_strikes": 1,
    "center_log_gap": 0.105
  },
  "density": null,
  "analytics": {
    "central_range_50": null,
    "p_below_forward": null
  },
  "model_status": "rejected",
  "warnings": ["insufficient_or_sparse_observations", "density_skipped_sparse_book"]
}
```

Headline percentiles are absent. The UI shows “Surface not accepted”.

## 8. Requirement checklist

| Charter requirement | Where |
| --- | --- |
| Not a directional forecast | API schemas, frontend copy, `test_public_dict_has_no_directional_tokens` |
| Risk-neutral language | methodology + UI titles/tooltips |
| Same `F_T` everywhere | `service.py`, `test_same_forward_used_everywhere` |
| Native inverse units | `ticker_adapter.py`, `inverse_option_forward` tests |
| No USD vanilla conversion for B–L | `distribution/black76.py` |
| Forward source + quality always exposed | `ForwardEstimate`, API `forward` object |
| Future > parity > venue > spot | `forward/estimate.py` + tests |
| `k = ln(K/F)`, `w = σ²T` | `surface/coordinates.py` |
| 25Δ by solving model delta | `solve_delta_strike` + test |
| Quality-weighted fit, distinct origins | `weights.py`, `SmilePoint.origin` |
| Three candidate fitters | `constrained_svi` diagnostic candidate (served), `tv_pchip` diagnostic, `svi_raw` research |
| No silent IV/density clip | density validation, no `np.clip` on IV |
| Calendar interpolation, no T extrapolation | `surface/interpolate.py` |
| B–L fail-closed | `distribution/validate.py` |
| Mandatory numerical tests 1–14 | `project/tests/options_surface/` |
| UI approved labels / no forbidden labels | `ivSignalOutlook.ts`, QuickView |
| GEX/terminal preserved | no edits to those modules |
| Versioned endpoint + legacy adapter | `/options-surface`, retired `/iv-signal-scan` |
| Snapshot persistence | `market_data/snapshots.py` |
| Docs | plan, methodology, dictionary, validation, this report |
| Honest research-grade labeling | `fitter_grade`, methodology §6 |

## 9. Definition of done

- Options Surface UI/API paths do not emit directional or forecast
  language (legacy directional fields are retired constants).
- The same forward is used in OTM, smile, delta, implied move, Black-76,
  and density.
- Inverse premiums are not converted to USD vanillas for parity or B–L.
- Every result has data/model quality (`forward.source_quality`,
  `model_status`, `fitter_grade`).
- Invalid densities fail closed.
- Validation suite: 64 options-surface tests in isolation; 93 with
  the scanner adapter; 289 passed, 1 skipped in the full backend suite.
- Remaining research-grade component: **`constrained_svi` is a
  `diagnostic_candidate`. It is not production-promoted. `tv_pchip`
  is diagnostic-only. `svi_raw` is research.**

## 10. Live rejection follow-up (2026-08-16)

A first live pane run on expiry **2026-08-21** correctly fail-closed
(`Surface not accepted`) but still rendered a jagged raw density,
FWD/MED/MODE, RR/BF inconsistently, and “quality low · listed-future
forward”. That mixed rejected density with a usable smile.

### Root cause

Not a forward mismatch and not a grid bug.

- Forward: matching listed future `BTC-21AUG26`, quality **high**,
  `F_T ≈ 62,885`.
- Quotes: 36 in, 16 accepted (7 calls / 9 puts), 13 unique strikes,
  7 below / 6 above, center gap `0.016`. 15 `invalid_iv_market`,
  5 `zero_bid`. Coverage clears the 3–14 DTE floors. The screenshot
  “7.6 around ATM” was `7/6` lower/upper strikes, not 7.6.
- Smile: served `tv_pchip` diagnostic, exact at 14 knots, **not
  convex** (`min_butterfly ≈ -0.73` near `K ≈ 56,179`).
- Density reject gate: **`cdf_not_monotone`**. Measured
  `min_cdf_step = -2.39e-5` (threshold `-1e-8`) at
  `K=56105→56137.5`. Mass `0.985`, moment error `3e-4`, digital ATM
  `0.009`, grid 401 vs 201 converged. Negative mass `2.4e-4` is
  **below** the `0.01` reject threshold and did not cause the reject.
- RR25/BF25 backend values were both present. The UI hid only RR25
  when `surface_rejected` was set — a presentation bug, not a
  delta-root disagreement.

**Recommendation: combination.** No validation-threshold change.
UX fail-closed (this pass). A later calibration/model correction is
required before any production smile promotion. Do not promote PCHIP.

### UX changes

- Typed `display` object: `quote_status`, `smile_status`,
  `density_status`, `surface_display_status`, `reason_codes`,
  `human_readable_reason`, `diagnostic_detail`, `metric_eligibility`.
- Rejected density default payload has empty `strikes_usd` /
  `raw_density` / quantiles. Raw curve is opt-in
  `density.diagnostic` only.
- Pane: “Risk-neutral distribution unavailable” empty state, no
  MED/MODE/bands/percentiles. Forward kept with source/quality.
  Diagnostic plot behind “View diagnostic details”.
- Smile labeled “Diagnostic volatility smile”. Fit quality split
  into data / smile / distribution. Coverage labeled as accepted
  observations + below/above forward + center gap. RR25 and BF25
  share one 25Δ-root gate. 1-sd move labeled diagnostic
  smile-implied move.

### Tests run

```
.\.venv\Scripts\python.exe -m pytest project/tests/options_surface project/tests/test_iv_signal_scanner.py -q
.\frontend\node_modules\.bin\tsc -p frontend\tsconfig.app.json --noEmit
node frontend\scripts\check-options-surface-display.mjs
```

69 options-surface + scanner tests passed; full backend suite
**265 passed, 1 skipped**; tsc clean; display copy checks passed.

Live API was restarted on :8000. A subsequent fetch of
`/options-surface?expiry=2026-08-21` returned
`density_status=accepted`, `surface_display_status=degraded`
(smile still `call_not_convex_in_strike`). The frozen 23:00 UTC
snapshot remains the rejected-density artifact. No browser MCP was
available; rejected UX is covered by fixtures and adapter tests.

### Still deferred (as of the 2026-08-16 UX pass)

- PCHIP production promotion
- Constrained SVI/SSVI production promotion (candidate now exists)
- Futures on the option WebSocket
- ETH
- True historical evaluation
- No validation-threshold loosening

## 11. Constrained smile calibration (2026-08-17)

### Fitted model

Served candidate: **`constrained_svi`**, raw Gatheral SVI in
\(w(k)=a+b[\rho(k-m)+\sqrt{(k-m)^2+\sigma^2}]\).

Grade: `diagnostic_candidate`. This is **not** a production
promotion.

### Constraints and validation

- Parameter bounds, Lee moment \(b(1+|\rho|)\le 4-\varepsilon\),
  \(w>0\), Gatheral \(g(k)\ge -10^{-8}\) on a log-\(k\) constraint
  grid.
- Huber residual in total variance with existing quality weights,
  plus small curvature / ridge regularisers.
- Deterministic multi-start (Zeliade inner grid, flat ATM, near-ATM
  slope, nested SSVI, no RNG).
- Serving decision is the existing 401-point **uniform-\(K\)**
  Black-76 call curve inside `extract_density`. Call monotone /
  convex tolerances are unchanged. Mass, moment, CDF, digital, and
  grid-convergence thresholds are unchanged.
- Residual budget in IV points versus bid/ask half-spread and ATM
  IV. Crossing the budget rejects density serving.
- No clipping of \(w\), IV, \(C(K)\), \(q(K)\), or the CDF. No
  density renormalization. No Gaussian headline smoothing. No
  silent PCHIP fallback.

### Fixture results

| Fixture | `tv_pchip` | `svi_raw` | `constrained_svi` |
| --- | --- | --- | --- |
| Flat vol | accepted (exact) | accepted | accepted; served |
| Known valid SVI | accepted | accepted | accepted; served |
| Noisy known SVI | accepted (exact, tracks noise) | accepted | accepted; served; residual > 0 |
| Outlier / kink | often non-convex, rejected | may pass | valid consensus or reject; never a non-convex served call curve |
| Sparse 3-strike | fail closed | fail closed | fail closed |
| Frozen Aug. 21 2026 23:00Z | **still non-convex** (`min_butterfly ≈ -0.725` at \(K≈56179\)) | serving-grid pass (research only) | **selected**; density **accepted**; mass \(0.987\); CDF monotone; residual budget ok; `surface_display_status=degraded` |

The frozen Aug. 21 snapshot is now a **valid diagnostic-candidate
distribution** under `constrained_svi`. PCHIP continues to
demonstrate the known interpolant failure. Thresholds were not
tuned to force this one book through.

### Promotion status

**Not ready for promotion beyond `diagnostic_candidate`.** One
liquid weekly fixture plus synthetics is not a production corpus.
SSVI surface calibration, wing extrapolation, and an explicit
PCHIP fallback policy remain deferred.

### Tests run

```
.\.venv\Scripts\python.exe -m pytest project/tests/options_surface -q
.\.venv\Scripts\python.exe -m pytest project/tests/options_surface project/tests/test_iv_signal_scanner.py -q
.\.venv\Scripts\python.exe -m pytest project/tests -q
.\frontend\node_modules\.bin\tsc -p frontend\tsconfig.app.json --noEmit
node frontend\scripts\check-options-surface-display.mjs
node frontend\scripts\check-options-surface-serving.mjs
.\.venv\Scripts\python.exe -m project.scripts.run_smile_calibration_harness
```

64 / 93 / 289 passed (1 skipped); tsc clean; display and serving
copy checks passed.

### Files added or updated in this pass

- `docs/constrained_smile_calibration_plan.md`
- `project/options_surface/surface/svi.py`
- `project/options_surface/surface/constrained_svi.py`
- `project/options_surface/surface/selection.py`
- `project/options_surface/surface/harness.py`
- `project/scripts/run_smile_calibration_harness.py`
- `project/tests/options_surface/test_constrained_svi.py`
- Orchestrator, display, API adapter/schemas, diagnostics, frontend
  captions, methodology / dictionary / validation / this report.
