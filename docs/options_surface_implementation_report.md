# Options Surface Implementation Report

Date: 2026-08-16

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
              surface.smile         (tv_pchip diagnostic / svi_raw research)
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
| `tv_pchip` production promotion | **Deferred** — still `diagnostic` |
| Constrained SVI/SSVI | **Deferred** — `svi_raw` is `research` |
| Futures on the option WebSocket | **Deferred** — REST book-summary |
| ETH | **Deferred** — interfaces are currency-generic |
| True historical evaluation | **Deferred** — not a backtest |

## 5. Tests

```
.\.venv\Scripts\python.exe -m pytest project/tests/options_surface project/tests/test_iv_signal_scanner.py -q
```

Result: **60 passed**.

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

- Served fitter is **diagnostic**. Overall `model_status` is therefore
  `degraded` even on a clean flat-vol book with a matching future.
- SVI is research-only. A butterfly failure on a fitted SVI does not
  block the PCHIP baseline.
- Density lives only inside the observed `k` range. Far-tail mass is a
  truncation warning, not an invented wing.
- `r = 0` in Black-76.
- Futures are REST, not streamed; a missing future book silently falls
  through the hierarchy.
- Legacy `/iv-signal-scan` still exists with retired directional fields
  (`NO_TRADE` / `false`) for one migration window.
- No live Deribit snapshot was frozen in this pass; the “live-style”
  fixture is a deterministic Deribit-shaped synthetic chain.

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
  "fitter_name": "tv_pchip",
  "fitter_grade": "diagnostic"
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
| Two candidate fitters | `tv_pchip` diagnostic, `svi_raw` research |
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
- Validation suite: 60 passed.
- Remaining research-grade component: **`tv_pchip` is diagnostic;
  `svi_raw` is research. Neither is production-promoted.**
