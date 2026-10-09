# Constrained SVI Promotion Rubric

Status: evidence contract. This document does **not** perform a
promotion. `constrained_svi` remains `diagnostic_candidate`.

The question this rubric will later answer is:

> Across a representative sample of real BTC option snapshots and
> expiries, how often does constrained SVI produce a statistically
> and economically credible, valid market-implied distribution when
> data is sufficiently liquid — and how does it fail when it should?

This is a calibration-validity decision, not a predictive-performance
study. It is not a backtest.

Analyzer export: `rubric_metrics.json` from
`python -m project.scripts.analyze_options_surface_corpus`.

---

## 1. What promotion would change

Promotion would change only:

```
fitter_grade = diagnostic_candidate  →  a higher documented grade
```

and, if warranted, allow `surface_display_status = ready` when every
existing serving gate passes.

Promotion would **not** change:

- hard serving gates or their numerical thresholds
- residual-budget formula or quote-quality weights
- forward hierarchy or native inverse premium conventions
- the fail-closed density policy
- the rule that `tv_pchip` never serves density
- the research-only status of `svi_raw`

A later, separate decision is required for any of: SSVI surface
calibration, wing extrapolation, or calendar-arbitrage serving.

---

## 2. Corpus minimums (provisional)

These numbers are **provisional**. They are sized so that a single
market day, a single expiry family, or a single volatility regime
cannot dominate the decision. They will be revised only by a
documented change proposal, synthetic re-tests, corpus reanalysis,
and a version bump of this rubric.

| Minimum | Provisional bar | Why this is the floor |
| --- | --- | --- |
| Immutable snapshots | **400** successful `options_surface_capture.v1` records | About 4 curated expiries × 4 captures/day × 25 sessions. Enough to see adjacent-snapshot stability without pretending to be a year of data. |
| Calendar duration | **20 distinct UTC dates** spanning **≥ 4 calendar weeks** | One week of BTC options is one expiry-roll story. Four weeks covers at least one EOW roll and typical weekend/weekday liquidity change. |
| Distinct expiries | **12** listed contracts | Prevents promoting on one weekly family. Should include more than one EOW, at least one EOM, and at least one longer-dated contract. |
| Tenor representation | **≥ 20** snapshots in each of 0–2, 3–7, 8–14, 15–30 DTE; **≥ 10** in 31–90 DTE; **≥ 5** in >90 DTE if listed | Short-dated BTC books are noisier and fail residual/coverage more often. Longer-dated books are sparser. Uneven bars are intentional. If a bucket cannot be filled because Deribit does not list it, record the gap; do not invent snapshots. |
| Volatility regimes | **≥ 3** of the ATM-IV buckets `<40%`, `40–60%`, `60–80%`, `≥80%`, each with **≥ 30** snapshots | BTC realized/implied vol clusters. A rubric that only saw 40-vol weeklies is not general. Regime is descriptive ATM IV, not a forecast label. |
| Matching listed-future, high quality | **≥ 70%** of successful captures | The preferred forward is the matching future. If the corpus is mostly parity/spot fallbacks, availability says more about data than about the fitter. |

If any minimum is missed, the rubric outcome is **insufficient
evidence**, not a fail and not a pass.

---

## 3. Reliability metrics

Rates below are computed on **successful captures** unless noted.
“Pass” means the existing gate passed. Thresholds are provisional
and conservative. They are not to be loosened to make the current
sample look better.

### 3.1 Fit and serving

| Metric | Analyzer key | Provisional range | Notes |
| --- | --- | --- | --- |
| Constrained-SVI optimizer convergence | `fit_convergence_rate` | **≥ 0.90** on books that meet observation/coverage floors | Convergence is not a no-arbitrage certificate. Count only attempted fits. |
| Density accepted | `density_accepted_rate` | Report only; **no target that forces more passes** | Accepted means all hard gates and the residual budget passed. A high rate on illiquid tenors is suspicious. |
| Density degraded | `density_degraded_rate` | Report; degraded is a valid served state | Diagnostic-candidate surfaces remain customer-`degraded` even when density is accepted. Do not confuse those two statuses. |
| Density rejected | `density_rejected_rate` | Must be **materially above 0** on 0–2 DTE and on sparse books | A fitter that almost never rejects is not fail-closed. |
| Unavailable from market data | `density_unavailable_market_data_rate` | Not a fitter defect | Sparse, stale, or forward-unavailable books. |
| Residual-budget pass | `residual_budget_pass_rate` | **≥ 0.75** on books with ≥ coverage floors and matching-future high | The budget is the economic credibility check. Do not retune it to raise this rate. |
| Hard serving-gate pass | `hard_gate_pass_rate` | **≥ 0.85** on the same liquid subset | Monotone, convex, CDF, mass, moment, digital, grid. Residual-budget failures are counted separately. |

Segment every rate above by tenor bucket. A pass in 8–14 DTE does
not excuse a collapse in 0–2 DTE.

### 3.2 Stability

| Metric | Analyzer key | Provisional bar |
| --- | --- | --- |
| Unexplained adjacent-snapshot flips | `unexplained_adjacent_instability_rate` | **≤ 0.10** of adjacent pairs on the same expiry whose accepted-strike count and forward moved ≤ 0.2% |
| Parameter stability given stable inputs | `parameter_stability_when_inputs_stable` | Mean relative change of `(a,b,ρ,m,σ)` **≤ 0.25** on those same stable pairs |
| Digital-reconciliation stability | `digital_reconciliation_stability` | Std. dev. of ATM digital error on accepted/degraded snapshots **≤ 0.02** |
| Grid-convergence stability | `grid_convergence_stability` | **≥ 0.95** of accepted/degraded snapshots keep `grid_converged=true` |

### 3.3 Integrity

| Metric | Analyzer key | Bar |
| --- | --- | --- |
| Accepted but later found invalid | `accepted_later_invalid_count` | **0** after any serving-gate bug is classified | A single such incident blocks promotion until the bug is fixed and the corpus is re-analyzed. |
| Data-quality vs model-driven rejection | `data_quality_rejection_rate`, `model_driven_rejection_rate` | Both reported. Promotion requires that model-driven rejects are **inspectable** (reason codes, not silent). |

### 3.4 Comparison candidates

| Metric | Analyzer key | Use |
| --- | --- | --- |
| PCHIP fails serving grid while constrained SVI passes | `pchip_fail_constrained_pass_count` | Expected often. This is the reason constrained SVI exists. |
| Constrained SVI rejected while PCHIP passes | `constrained_fail_pchip_pass_count` | Must remain **non-serving**. A high count is a residual/coverage story, not a reason to restore PCHIP. |

Suspicious “almost always accepted” or “almost always rejected”
patterns in any tenor bucket are **disqualifying until explained**.

---

## 4. Governance

1. **Hard gates stay hard.** Call monotone/convex, density sign,
   mass, forward moment, CDF monotone, digital reconciliation, and
   grid convergence cannot be relaxed in a promotion.
2. **Any threshold change** (including this rubric’s provisional
   bars, residual budget, or quote-quality floors) requires:
   - a written change proposal
   - synthetic tests that the new bar still fail-closes known bad
     books (including the frozen Aug. 21 2026 23:00Z PCHIP failure)
   - full corpus reanalysis
   - a version bump of the serving config and of this rubric
3. **Fitter and configuration version** must be stored on every
   snapshot (`config_version`, `config_hash`, `code_version`).
4. **Promotion is reversible.** Serving mode remains a local
   configuration (`diagnostic_candidate` / `shadow_compare` /
   `disabled`). Rolling back must not rewrite historical records.
5. **Shadow period.** After a tentative grade change, run
   `shadow_compare` long enough to cover the corpus minimums again
   with the new marker. Candidate comparison stays available.
6. **Manual review** of representative accepted and rejected
   cases is required. Automated rates are not sufficient.
7. **No promotion** from a single market day or a single expiry
   family.

---

## 5. Out of scope

| Decision | This rubric |
| --- | --- |
| Per-expiry smile promotion of `constrained_svi` | In scope, later |
| Cross-expiry / calendar-arbitrage **surface** promotion | Out of scope |
| Wing extrapolation outside observed `k` | Out of scope |
| Forecasting or physical-measure claims | Permanently out of scope |

---

## 6. Current status

`constrained_svi` is `diagnostic_candidate`.

The capture and analyzer machinery exists so that a later review
can fill the table above with corpus evidence. Until the corpus
minimums are met and the reliability bars are reviewed by hand,
the grade does not change.
