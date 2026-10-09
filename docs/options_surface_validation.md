# Options Surface Validation

## How to run

From the repository root, with the project venv:

```powershell
.\.venv\Scripts\python.exe -m pytest project/tests/options_surface -q
.\.venv\Scripts\python.exe -m pytest project/tests/options_surface project/tests/test_iv_signal_scanner.py -q
```

The first command is the new engine suite. The second also runs the
legacy scanner unit tests (isolated prototype math) plus the migrated
API adapter tests.

Corpus capture / analyzer (offline fixtures, no live Deribit):

```powershell
.\.venv\Scripts\python.exe -m pytest project/tests/options_surface/test_corpus_capture.py project/tests/options_surface/test_corpus_expiries.py project/tests/options_surface/test_corpus_collector.py project/tests/options_surface/test_corpus_analyzer.py project/tests/options_surface/test_shadow_modes.py -q
```

One-shot capture and analysis (live market; not a unit test):

```powershell
.\.venv\Scripts\python.exe -m project.scripts.capture_options_surface --underlying BTC --curated-expiries --dry-run
.\.venv\Scripts\python.exe -m project.scripts.analyze_options_surface_corpus --input project/runtime/options_surface_snapshots
```

Last run (2026-08-16 validation-corpus pass): **79 passed** in
`project/tests/options_surface`; **108 passed** with
`test_iv_signal_scanner.py`; full backend **304 passed, 1 skipped**.

## Mandatory numerical gates

| # | Gate | Test |
| --- | --- | --- |
| 1 | Flat-vol Black-76 recovery (mass, sign, mean, lognormal quantiles) | `test_black76_density.py::test_flat_vol_density_recovers_lognormal`, `test_flat_vol_quantiles_match_lognormal` |
| 2 | Strike monotonicity `C(K[i+1]) ≤ C(K[i])` | `test_strike_monotonicity_and_convexity` |
| 3 | Strike convexity / butterfly | same |
| 4 | Density mass ≈ 1 | `test_density_mass_and_forward_moment` |
| 5 | Forward moment ≈ `F_T` | same |
| 6 | CDF monotone and bounded | `test_cdf_monotone_and_bounded` |
| 7 | Digital reconciliation at ATM, 25Δ, 10Δ, wings | `test_digital_reconciliation_atm_and_wings` |
| 8 | Grid convergence | `test_grid_convergence` |
| 9 | Smile recovers accepted knots | `test_pchip_exact_at_knots` |
| 10 | Calendar `w(k,T)` consistency | `test_calendar_ok_for_flat_vol_term_structure`, `test_calendar_detects_decreasing_total_variance` |
| 11 | Forward source hierarchy | `test_forward_and_quality.py` |
| 12 | Quote reason codes | `test_quality_reason_codes` |
| 13 | API contract | `test_api_contract.py` |
| 14 | Frozen live-style fixture | `test_service.py` + synthetic Deribit-like chain |
| 15 | Constrained SVI recovery / robustness | `test_constrained_svi.py` |
| 16 | No silent PCHIP fallback | `test_no_silent_pchip_fallback` |
| 17 | Aug. 21 frozen honesty (PCHIP still fails) | `test_frozen_aug21_pchip_failure_and_constrained_honesty` |
| 18 | Capture round-trip / replay | `test_corpus_capture.py` |
| 19 | Partial-write and schema isolation | `test_partial_jsonl_line_is_skipped`, `test_legacy_schema_is_identified_not_mixed` |
| 20 | Curated expiry selection | `test_corpus_expiries.py` |
| 21 | Capture isolation and analyzer / rubric export | `test_corpus_collector.py`, `test_corpus_analyzer.py` |
| 22 | Shadow modes, no PCHIP restore | `test_shadow_modes.py` |

Rejected densities emit no headline percentiles
(`test_rejected_density_has_no_headline_quantiles`,
`test_sparse_book_fails_closed`).

A smooth constrained fit is not required to recover accepted knots
exactly. That is PCHIP’s property (`test_pchip_exact_at_knots`) and
is why PCHIP is no longer the served density model.

## Tolerances

- Mass: \|∫q − 1\| < 0.03 for an accepted/degraded flat-vol recovery
- Forward moment: relative error < 0.02
- Quantiles vs analytical lognormal: relative < 0.03
- Digital ATM / wing error: < 0.03
- Grid p50 relative change: < 0.005
- Knot recovery (PCHIP): 1e-10
- Inverse parity recovery: 1e-10 relative
- Parity fail-closed: dispersion > 1.5% or < 2 pairs

These are numerical gates, not a backtest. A historical evaluation
against independently observed outcomes is a separate project.

## Fail-closed policy

The engine does **not**:

- clip fitted IV to 1e-4 to hide negative variance
- renormalize a broken density and call it HIGH
- Gaussian-smooth the PDF and then integrate that for headlines
- convert inverse BTC premiums to USD vanillas for B–L
- emit LONG/SHORT

It **does**:

- report raw negative mass
- omit percentiles when `density.status = rejected`
- label `constrained_svi` as `diagnostic_candidate`, `tv_pchip` as
  `diagnostic`, and `svi_raw` as `research`
- refuse to select PCHIP or raw SVI for density serving
- mark maturity/`k` queries outside the observed range as
  `extrapolated` / unavailable

Last run (2026-08-16 validation-corpus pass): **79 passed** in
`project/tests/options_surface`; **108 passed** with the scanner
adapter; full backend **304 passed, 1 skipped**.

Frontend:

```powershell
.\frontend\node_modules\.bin\tsc -p frontend\tsconfig.app.json --noEmit
node frontend\scripts\check-options-surface-display.mjs
node frontend\scripts\check-options-surface-serving.mjs
```

Last run: clean.

Harness:

```powershell
.\.venv\Scripts\python.exe -m project.scripts.run_smile_calibration_harness
```

Artifacts: `runtime/options_surface_debug/calibration_harness/`.
