# Constrained Smile Calibration Plan

Status: design locked for implementation. This document is the
Phase-0 contract for a production-*candidate* constrained smile
fitter. It does not promote that fitter to production and it does
not change any existing density-serving gate.

Product identity is unchanged: a market-implied risk engine. It
describes how the listed Deribit BTC options book prices a forward,
a volatility smile, and a risk-neutral terminal-price distribution.
It is not a forecast and it does not emit directional labels.

---

## 1. Current PCHIP failure mechanism

The served baseline `tv_pchip` is an exact, shape-preserving cubic
Hermite interpolant in total variance \(w(k)=\sigma(k)^2 T\) on the
accepted OTM knots. Residual RMS at those knots is identically zero.

Exact interpolation is the defect, not a numerical accident.

Live Deribit mark IVs are noisy. Bid/ask IV markets are wide,
especially in the wings. Consecutive accepted knots therefore do
not lie on a convex Black-76 call-price curve. PCHIP preserves the
*local slope sign of \(w(k)\)* between knots. It does **not**
preserve:

- butterfly convexity of \(C(K)\)
- non-negativity of \(\partial^2 C/\partial K^2\)
- monotonicity of the raw Breeden–Litzenberger CDF

On a uniform-\(K\) serving grid the second-difference of Black-76
calls becomes negative near a noisy knot. The implied density then
takes a small negative patch, the raw CDF decreases, and the
engine correctly reject-closes.

Frozen evidence, expiry 2026-08-21, as-of 2026-08-16T23:00:57Z
(`docs/diagnostics/options_surface_live_rejection_20260816T230839Z.md`):

| Item | Value |
| --- | --- |
| Forward | matching listed future `BTC-21AUG26`, \(F_T=62885\), quality high |
| Coverage | 13 accepted strikes, 7 below / 6 above, center gap \(0.016\) |
| Served fitter | `tv_pchip` / diagnostic |
| Residual RMS | \(0\) (exact at 14 knots including synthetic ATM) |
| Call monotone | true |
| Call convex | **false** (`min_butterfly ≈ -0.725` at \(K≈56179\)) |
| Density reject gate | `cdf_not_monotone` (`min_cdf_step = -2.39e-5` at \(K=56105→56137.5\)) |
| Mass / moment / digital / grid | all inside accept or degrade bands |

Unconstrained research `svi_raw` on the same book also failed
convexity (`min_butterfly ≈ -0.625`). Optimizer convergence is
therefore not a no-arbitrage certificate.

This is expected PCHIP behaviour. It is **not** a reason to loosen
call-price, CDF, mass, moment, digital, or grid-convergence
thresholds. `tv_pchip` remains a diagnostic baseline only.

---

## 2. Candidate models considered

| Candidate | Parameters | Smoothing | No-arb handle | Role in this pass |
| --- | --- | --- | --- | --- |
| `tv_pchip` | one knot per observation | none; exact interpolant | none | Diagnostic baseline. Never selected for density serving. |
| `svi_raw` | raw Gatheral \((a,b,\rho,m,\sigma)\) | unconstrained weighted LS | none beyond optimizer bounds | Research benchmark. Cannot reject or contaminate a passing served candidate. |
| **`constrained_svi`** | same raw SVI, constrained | Huber + quality weights + mild curvature / ridge | parameter bounds, Lee moment, \(w>0\), \(g(k)≥-ε\), then **serving-grid** Black-76 monotone/convex | Serving candidate. Grade `diagnostic_candidate`. |
| SSVI / eSSVI slice | \((\theta,\varphi,\rho)\) | parametric | closed-form butterfly bound \(\theta\varphi(1+\lvert\rho\rvert)≤4\) | Evaluated as an initialization / nested start only. Not the served model. |
| SSVI surface (multi-expiry) | term-structure of \(\theta,\varphi,\rho\) | calendar-consistent | Gatheral–Jacquier calendar + butterfly | **Deferred.** |
| Kernel / QP projection of \(w(k)\) onto a convex-call cone | high-dimensional | strong | discrete convexity by construction | Deferred. More interpolating than a consensus smile; risks fitting noise if the cone is the only regularizer. |
| Wing-extrapolated SVI (Lee / power-law) | extra tail params | invented wings | Roger Lee moment formula | **Deferred.** First pass serves only inside observed \(k\). |

### Tradeoff and selection

**Served model: `constrained_svi` (constrained raw SVI).**

Reasons:

1. The charter’s starting specification is raw SVI in
   \(w(k)=a+b[\rho(k-m)+\sqrt{(k-m)^2+\sigma^2}]\).
2. The existing research baseline is already raw SVI, so the new
   candidate is a constrained upgrade of a known object rather than
   a second, incomparable parameterization.
3. Five parameters are enough to express BTC weekly skew and a
   displaced minimum without inventing wings.
4. SSVI’s three-parameter slice is a nested special case. It is
   used as one deterministic start (mapped into raw SVI) because
   its butterfly bound is cheap and stable. It is not flexible
   enough, by itself, for a displaced ATM minimum that BTC books
   often show.
5. A discrete convex-call QP would pass the serving grid by
   construction, but it would also track noisy marks unless a
   separate smoothness budget were imposed. That is a different
   product (an arbitrage-projected interpolant), not a consensus
   smile. It is left for a later comparison, not this pass.

The serving decision is **never** “the optimizer converged” or
“analytical \(g(k)≥0\) on a log-\(k\) plot grid.” The serving
decision is the existing uniform-\(K\) Black-76 curve used for
Breeden–Litzenberger extraction.

---

## 3. Exact model

For one expiry, on quality-filtered canonical OTM marks plus the
tagged synthetic ATM interpolant:

\[
k=\ln(K/F_T),\qquad
w(k)=a+b\bigl[\rho(k-m)+\sqrt{(k-m)^2+\sigma^2}\bigr].
\]

The same selected \(F_T\) already used for OTM, ATM, forward delta,
25-delta roots, implied move, Black-76, density moments, and UI
markers is the only forward in this fit.

Queries with \(k\notin[k_{\min},k_{\max}]\) (the observed canonical
range) return `extrapolated` / unavailable. No asymptotic wing is
fitted or served.

Native inverse BTC premiums are never converted into USD vanillas
for this fit, for parity, or for B–L. The smile observation is
mark IV; the density layer is analytical Black-76 on \(F_T\).

---

## 4. Parameterization and constraints

Parameters \(\theta=(a,b,\rho,m,\sigma)\).

### 4.1 Bounds (always on)

| Parameter | Bound | Reason |
| --- | --- | --- |
| \(a\) | \([0,\,4]\) | level of total variance; non-negative at this grade |
| \(b\) | \([0,\,4]\) | wing slope scale |
| \(\rho\) | \([-0.999,\,0.999]\) | \(\lvert\rho\rvert<1\) |
| \(m\) | \([k_{\min}-0.5,\,k_{\max}+0.5]\) clipped to \([-2,2]\) | smile minimum near observed domain |
| \(\sigma\) | \([10^{-4},\,2]\) | \(\sigma>0\) |

### 4.2 Hard analytic inequalities

Evaluated during constrained projection and as post-fit gates.
They are **not** a substitute for the serving-grid call test.

1. **Positive total variance** on the observed domain and on a
   dense constraint grid of 41 log-moneyness nodes:
   \(w(k_j)≥w_{\min}=10^{-8}\). No clipping of negative \(w\) into
   a positive floor in the served output.
2. **Interior minimum**
   \(w_{\min}^{\mathrm{SVI}}=a+b\sigma\sqrt{1-\rho^2}≥w_{\min}\).
3. **Roger Lee moment / wing slope**
   \(b(1+\lvert\rho\rvert)≤4-\varepsilon_{\mathrm{Lee}}\) with
   \(\varepsilon_{\mathrm{Lee}}=10^{-6}\). Necessary, not
   sufficient.
4. **Gatheral butterfly factor** on the same 41-node \(k\)-grid:
   \[
   g(k)=\Bigl(1-\frac{k\,w'(k)}{2w(k)}\Bigr)^2
   -\frac{w'(k)^2}{4}\Bigl(\frac{1}{w(k)}+\frac14\Bigr)
   +\frac{w''(k)}{2}
   ≥ -ε_g,\qquad ε_g=10^{-8}.
   \]
   A start that cannot meet this after projection is not eligible
   for serving. It is still recorded with reason codes.

### 4.3 Serving-grid constraints (the actual gate)

After a numerical fit, Black-76 calls are priced on the **same
uniform-\(K\) grid** used by `extract_density` (default 401 points
from \(F e^{k_{\min}}\) to \(F e^{k_{\max}}\), \(r=0\)).

Existing tolerances, unchanged:

- monotone: \(\max_i(C_{i+1}-C_i)≤10^{-10}\)
- convex: \(\min_i(C_{i-1}-2C_i+C_{i+1})≥-10^{-8}\)

These are applied by the existing `apply_served_call_curve_gates`.
Mass, moments, digitals, and grid convergence **cannot** override
them. A candidate that fails them is not served, even if \(g(k)\)
looked clean on the log-\(k\) grid.

---

## 5. Objective function and weighting

Observations: quality-filtered OTM mark IVs and the tagged
synthetic ATM point, each with the existing `fit_weight`
(spread × premium × age × OI × moneyness × two-sided quality).
A fallback or one-sided quote cannot dominate.

Work in total variance. Let \(r_i=w_\theta(k_i)-w_i^{\mathrm{obs}}\).

**Primary loss:** quality-weighted Huber

\[
L_{\mathrm{fit}}(\theta)=\sum_i \omega_i\,\rho_\delta(r_i),
\qquad
\rho_\delta(r)=\begin{cases}
\tfrac12 r^2 & \lvert r\rvert≤\delta\\
\delta(\lvert r\rvert-\tfrac12\delta) & \lvert r\rvert>\delta
\end{cases}
\]

\(\delta=\max(\delta_{\mathrm{floor}},\,0.15\,w_{\mathrm{ATM}})\)
with \(\delta_{\mathrm{floor}}=10^{-6}\). Isolated noisy marks
therefore contribute linearly, not quadratically.

Unconstrained `svi_raw` remains a plain weighted least-squares
benchmark so the comparison is honest.

---

## 6. Regularization / smoothing

Two *small* quadratic terms, never used to hide a failed gate:

\[
L_{\mathrm{reg}}
= \lambda_{\kappa}\,\overline{(w''(k))^2}
+ \lambda_{r}\bigl((b-b_0)^2 + m^2 + \rho^2\bigr)
\]

- \(\lambda_{\kappa}=10^{-6}\) on the 41-node \(k\)-grid. Penalises
  unnecessary curvature so a single wing print cannot kink the
  smile.
- \(\lambda_{r}=10^{-4}\), \(b_0=0.05\). Weak preference for a
  moderate, near-ATM smile.

No Gaussian smoothing of the output density. No post-hoc clip of
\(w\), IV, \(C(K)\), \(q(K)\), or the CDF. No renormalization of a
failed density into acceptance.

The served curve is *allowed* to miss individual mark IVs. That is
the point of a consensus fit. Residuals are reported, not erased.

---

## 7. Initialization and multi-start

All starts are **deterministic**. No RNG.

For usable points \(\{(k_i,w_i,\omega_i)\}\):

1. **Zeliade inner grid.** Fix \((m,\sigma)\) on a \(7\times 5\)
   grid (\(m\) at the 10/25/40/50/60/75/90% weighted quantiles of
   \(k\); \(\sigma\) in a deterministic ladder from \(0.05\) to
   \(0.40\) times the observed \(k\)-span, floored at \(10^{-3}\)).
   For each pair, solve weighted linear least squares in the
   \((a,d,c)\) coordinates
   \(w=a+d(k-m)+c\sqrt{(k-m)^2+\sigma^2}\), project onto
   \(c≥\lvert d\rvert\), \(a+c\sigma≥w_{\min}\), and Lee, then map
   back to \((a,b,\rho,m,\sigma)\). Keep the three lowest-Huber
   projected starts.
2. **Flat ATM.** \(a=w_{\mathrm{ATM}}\), \(b=0.05\), \(\rho=0\),
   \(m=0\), \(\sigma=\max(0.1,0.25(k_{\max}-k_{\min}))\).
3. **Near-ATM slope.** Finite-difference \(\rho,b\) from a
   weighted linear fit of \(w\) on \(k\) inside
   \(\lvert k\rvert≤0.05\).
4. **SSVI nested start.** Fit \((\theta,\varphi,\rho)\) by bounded
   least squares with \(\theta\varphi(1+\lvert\rho\rvert)≤4\), map
   to raw SVI:
   \(a=\frac\theta2(1-\rho^2)\), \(b=\frac{\theta\varphi}2\),
   \(m=-\rho/\varphi\), \(\sigma=\sqrt{1-\rho^2}/\varphi\).
5. **Unconstrained `svi_raw` projection.** Take the existing
   research fitter’s \(\theta\) and project onto the bounds in
   §4.1–4.2. This start is for robustness, not for serving that
   unconstrained smile.

Each start is refined by bounded Huber least squares, then, if
\(g(k)\) or \(w(k)\) fails, by SLSQP (fallback: `trust-constr`)
with the inequalities in §4.2. The refined start is scored on
\(L_{\mathrm{fit}}+L_{\mathrm{reg}}\).

A start that does not improve, or that yields non-finite \(w\), is
recorded as `start_failed:<index>` and discarded.

---

## 8. Optimizer and failure handling

| Stage | Tool | Failure |
| --- | --- | --- |
| Unconstrained refine | `scipy.optimize.least_squares`, `loss='huber'` | keep last \(\theta\) if finite; mark `ls_not_converged` |
| Constrained projection | `minimize(..., method='SLSQP')`, `maxiter=300` | retry once with `trust-constr`; else `projection_failed` |
| Serving-grid check | existing `diagnose_slice_arbitrage` on 401-point uniform \(K\) | `served_call_not_convex` / `served_call_not_decreasing` |
| Residual budget | §10 | `residual_budget_exceeded` |

Typed failure states (never silent, never a PCHIP swap):

- `insufficient_observations`
- `duplicate_log_moneyness`
- `optimizer_failed`
- `non_positive_total_variance`
- `svi_butterfly_g_negative`
- `lee_moment_violated`
- `served_call_not_convex`
- `served_call_not_decreasing`
- `residual_budget_exceeded`
- `coverage_too_narrow`

If fitting fails, the fitter emits `SmileFitResult` with
`status=rejected`, empty knots, and the reason codes. The
orchestrator does **not** replace it with `tv_pchip`.

If fitting succeeds but serving gates fail, the smile may be
retained as a degraded diagnostic curve. Density is not served.
`tv_pchip` remains side-by-side in `candidate_comparison` only.

---

## 9. Numerical grids

| Grid | Spacing | Use |
| --- | --- | --- |
| Observation knots | market strikes | Huber residual |
| Constraint \(k\)-grid | 41 uniform in \([k_{\min},k_{\max}]\) | \(w>0\), \(g(k)\), \(w''\) regularizer |
| Smile plot / arb diagnostic | existing 61 log-\(k\) nodes | `SmileSlice.arbitrage` (diagnostic) |
| **Density serving** | existing 401 **uniform \(K\)** | B–L, monotone, convex, mass, CDF |
| Density compare | existing 201 uniform \(K\) | grid-convergence gate |
| Dense fit polyline | existing 81 log-\(k\) nodes | UI smile curve, inside coverage only |

No values are served outside \([k_{\min},k_{\max}]\). 25-delta
metrics emit only when both model-delta roots solve inside that
interval (existing `solve_delta_strike` + eligibility gate).

---

## 10. Residual budget

A convex, low-residual smile that ignores the book is not a market
smile. A smile that weaves through every mark is PCHIP.

Budget, evaluated in **IV points** on observations with
\(\omega_i ≥ \mathrm{median}(\omega)\):

- Let \(e_i=\lvert\sigma_\theta(k_i)-\sigma_i^{\mathrm{obs}}\rvert\).
- Let \(s_i\) be the bid/ask IV half-spread when both sides exist,
  else \(0.02\).
- Weighted RMS of \(e_i\) must be
  \(≤ \max(0.02,\; 2.5\,\overline{s}_ω,\; 0.08\,\sigma_{\mathrm{ATM}})\).
- Max \(e_i\) on high-weight points must be \(≤ 0.06\).

Low-weight outliers may exceed the max; they must appear in the
residual table. Crossing the budget is a **selection** failure, not
a reason to clip residuals.

---

## 11. Serving acceptance criteria

A candidate may be *selected* only if all of the following hold.
Thresholds are the existing ones in
`project/options_surface/distribution/validate.py`.

1. Converged or accepted-as-best-finite after multi-start, with
   `observation_count ≥ 4` and the existing tenor coverage floors.
2. \(w(k)>0\) and finite IV on the observed \(k\) domain.
3. Serving-grid Black-76 calls monotone and convex.
4. Density validation does not reject:
   - raw negative mass \(≤ 0.01\) (reject) / \(≤ 10^{-8}\) (accept)
   - \(\lvert\int q-1\rvert ≤ 0.10\) (reject) / \(≤ 0.02\) (accept)
   - CDF min step \(≥ -10^{-8}\)
   - forward-moment relative error \(≤ 0.05\) (reject) / \(≤ 0.01\)
     (accept)
   - ATM digital error \(≤ 0.08\) (reject) / \(≤ 0.03\) (accept)
   - grid p50 relative change \(≤ 0.005\) (else degrade, not
     accept)
5. Residual budget in §10.
6. 25-delta RR/BF remain coverage-gated independently. They do not
   rescue a failed density and they do not fail a passing one.

`density_status` may be `accepted` or `degraded` when 1–5 hold.
`surface_display_status` is **`degraded`** for this pass because
the fitter grade is `diagnostic_candidate`, not `production`.

Promotion to `production` / `ready` is a later, evidence-backed
decision on a frozen live-snapshot corpus. It is not granted by
this implementation.

---

## 12. Model-selection policy

Candidates evaluated on every build:

| Name | Grade | Can be selected for density? |
| --- | --- | --- |
| `constrained_svi` | `diagnostic_candidate` | yes, if §11 holds |
| `tv_pchip` | `diagnostic` | **no** (this pass; no silent fallback) |
| `svi_raw` | `research` | **no** |

Policy, in order:

1. Drop any candidate that did not converge and does not meet
   quote/coverage floors.
2. Drop any candidate that fails a hard density-serving gate on
   the serving grid.
3. Drop any candidate that misses the residual budget.
4. If `constrained_svi` remains, select it.
5. If it does not remain, return the existing rejected-density
   state. Do **not** select PCHIP even if PCHIP happens to pass
   the serving grid on that book.
6. Record `selection_reason` and per-candidate reason codes.
7. `svi_raw` failures stay in `research` / `candidate_comparison`.
   They cannot flip customer `density_status` or
   `surface_display_status`.

Tie-breakers, reserved for a later pass in which more than one
serving-eligible model exists:

1. fewer free parameters
2. larger serving-grid `min_butterfly` (more convex slack)
3. smaller high-weight max \(\lvert e_i\rvert\)
4. documented name order: `constrained_svi`, then others

This pass has a single serving-eligible name, so the tie-breakers
are recorded but unused.

---

## 13. Fallback policy

| Event | Customer path | Diagnostic path |
| --- | --- | --- |
| `constrained_svi` selected, density accepted/degraded | Serve constrained smile + density. Copy: “Market-implied distribution — diagnostic fit” / “Served constrained smile — diagnostic candidate.” | PCHIP and raw SVI in `candidate_comparison` |
| Fit ok, serving gates fail | Smile may display as degraded. Density rejected. No MED/MODE/quantiles/ranges/tails. | PCHIP retained for comparison only |
| Fit fails | Smile rejected or unavailable. Density not built. | PCHIP + raw SVI comparison |
| Sparse / one-sided / stale / no forward | Existing fail-closed path. No fabricated density. | unchanged |
| PCHIP serving-grid pass, constrained fail | **No fallback.** Density remains rejected. | PCHIP pass is a diagnostic note |
| Raw SVI fail | Ignored for serving. | research disclosure only |

There is no hidden clip, no density renormalization, and no
Gaussian-smoothed series used for primary metrics.

---

## 14. Why this does not weaken existing gates

- Call-price monotone/convex tolerances stay \(10^{-10}\) /
  \(10^{-8}\).
- CDF, negative-mass, mass, moment, digital, and grid-convergence
  thresholds are unchanged.
- Serving gates still run on the uniform-\(K\) Black-76 curve
  inside `extract_density` / `apply_served_call_curve_gates`.
- A rejected density still emits no headline percentiles.
- `tv_pchip` is not restored as the default serving model.
- `svi_raw` remains research.
- No inverse-premium → USD vanilla conversion is introduced.
- Forward hierarchy is untouched.
- This pass is not tuned to force the Aug. 21 snapshot through
  the gates. That snapshot is a regression fixture: PCHIP must
  still demonstrate the known failure; the new candidate’s result
  is recorded honestly.

---

## 15. API / UI contract (minimal)

New or extended fields (additive):

- `fitter_name` (`constrained_svi` when selected)
- `fitter_grade` (`diagnostic_candidate`)
- `selection_reason`
- `fit_residual_summary` (rms, weighted rms, max abs, budget)
- `fit_converged`
- `fit_parameters` remain on the smile object (developer /
  snapshot; not a customer headline)
- `served_call_monotone`, `served_call_convex`
- `served_density_grid`
- `selected_model_status`
- `candidate_comparison` on the snapshot / developer diagnostics
  only; not a customer chart

Customer copy when gates pass:

- “Market-implied distribution — diagnostic fit”
- “Served constrained smile — diagnostic candidate”

Forbidden copy: “arbitrage-free”, “production-grade”, “forecast”,
LONG/SHORT, bullish/bearish.

Independent legend dimensions remain Forward / Smile /
Distribution. Data quality, fit grade, and distribution validity
stay separate.

---

## 16. Scope explicitly deferred

- Full SSVI / eSSVI **surface** calibration with calendar
  constraints across expiries.
- Any invented asymptotic wing (Lee power, quadratic wings,
  SVI extrapolation outside observed \(k\)).
- Promotion of `constrained_svi` from `diagnostic_candidate` to
  `production`.
- Silent or explicit PCHIP fallback as a serving policy.
- Discrete convex-call QP / kernel projection as a served model.
- Changes to GEX, dealer positioning, heatmap, vol-compare.
- Threshold loosening of any serving gate.
- Directional labels, synthetic backtests, P-measure claims.
- ETH as a first-class book (interfaces stay currency-generic).
- Streaming listed futures (REST matching-future path stays).

---

## 17. Implementation stages (this milestone)

0. This design note. No production code before it exists.
1. Research harness: three candidates × synthetic + frozen
   fixtures, deterministic artifacts under
   `runtime/options_surface_debug/calibration_harness/`.
2. `ConstrainedSviFitter` under `project/options_surface/surface/`,
   returning a typed `SmileFitResult`.
3. Selection policy in the orchestrator. Default served name
   becomes `constrained_svi`. PCHIP is comparison-only.
4. Additive API diagnostics + minimal frontend captions.
5. Methodology, data dictionary, validation, and implementation
   report updates.

Mandatory tests are listed in the milestone brief (flat-vol
recovery, known-SVI recovery, noisy robustness, outlier
robustness, sparse fail-closed, non-arb inputs, serving-gate
integrity, research isolation, forward consistency, delta-root
coverage, Aug. 21 frozen snapshot honesty, full existing suites).
