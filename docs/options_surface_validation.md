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

Last run (2026-08-16 display-state pass): **69 passed**.

Frontend typecheck:

```powershell
.\frontend\node_modules\.bin\tsc -p frontend\tsconfig.app.json --noEmit
```

Last run: clean.

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

Rejected densities emit no headline percentiles
(`test_rejected_density_has_no_headline_quantiles`,
`test_sparse_book_fails_closed`).

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
- label `tv_pchip` as `diagnostic` and `svi_raw` as `research`
- mark maturity/`k` queries outside the observed range as
  `extrapolated` / unavailable
