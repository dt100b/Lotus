# Options Surface Rebuild Plan

Status: reconnaissance complete; implementation follows this document in
small verified stages. This is not a design-fiction rewrite. It is a
migration of the live Deribit BTC options market-implied risk path into a
correct, testable engine.

Product identity: a live Deribit BTC options **market-implied risk
dashboard**. It describes how the listed options market prices forwards,
ATM volatility, skew, term structure, and risk-neutral terminal-price
distributions. It is **not** a directional BTC forecast system.

---

## 1. Current-state architecture map

### 1.1 What exists today

The Options Surface in this repository is the **IV signal scanner
quick-view**, not a separate surface engine. It sits beside (and must
not disturb) the taker-flow GEX terminal.

```
Deribit public WS
  incremental_ticker.<option> + instrument.state.option.BTC
        │
        ▼
pipeline/deribit_ticker_stream.py     immutable quote cache
        │
        ▼
pipeline/deribit_iv_chain.py          DeribitTickerIvChainProvider
        │                            (book-summary adapter exists for
        │                             parity/diagnostics only)
        ▼
api/repository.get_iv_signal_scan()
        │
        ▼
pipeline/iv_signal_scanner.py
   normalize_expiry_iv_curve  → OTM mark-IV smile
   derive_implied_forward     → inverse parity / underlying / spot
   build_canonical_smile      → UnivariateSpline(s=1) on raw IV(K)
   _build_pdf_with_quality    → BS(spot) calls + d²C/dK² + clip
   compute_signals            → LONG / SHORT / NO_TRADE votes
        │
        ▼
GET /api/v1/iv-signal-scan  →  IvSignalScanResponse
        │
        ▼
frontend IvSignalScannerQuickView + smile/density charts
```

Unrelated surfaces that **must stay intact**:

| Path | Role |
| --- | --- |
| `greeks/`, `pipeline/dashboard_snapshot.py`, GEX API | Taker-flow GEX |
| `pipeline/forward_gamma_surface.py` | Dealer-Greek projection on a future time×price grid. Name collision only. |
| `pipeline/vol_compare.py`, `pipeline/skew_25d.py` | Regime DVOL/RV and 25Δ history. Separate product. |
| `collector/`, `ledger/`, `normalizer/` | Phase 1–3 trade ledger |

### 1.2 File inventory (Options Surface path)

**Ingestion and snapshots**

- `project/pipeline/deribit_ticker_stream.py` — WS ticker cache, generation
  scoping, incremental merge, immutable `TickerStreamSnapshot`.
- `project/pipeline/deribit_iv_chain.py` — ticker → scanner rows; REST
  book-summary fallback marked unverified.
- `project/collector/deribit_client.py` — REST `get_instruments` (option
  or future), trades. Futures book is **not** consumed by the scanner.

**Quote selection, forward, smile, density, signals**

- `project/pipeline/iv_signal_scanner.py` (~1950 lines) — entire economic
  engine in one module.
- `project/docs/iv_signal_scanner.md` — current product contract,
  including directional outlook and synthetic-backtest exclusion.

**API**

- `project/api/main.py` — `GET /api/v1/iv-signal-scan`
- `project/api/schemas.py` — `IvSignalScanResponse` and directional
  types (`IvSignalDirection = LONG | SHORT | NO_TRADE`)
- `project/api/repository.py` — feed-health gates, 0DTE eligibility,
  published-verdict hysteresis

**Frontend**

- `frontend/src/api/ivSignalScanner.ts`
- `frontend/src/hooks/useIvSignalScan.ts`
- `frontend/src/components/terminal/IvSignalScannerQuickView.tsx`
- `frontend/src/components/terminal/IvSignalSmileChart.tsx`
- `frontend/src/components/terminal/IvSignalDensityChart.tsx`
- `frontend/src/components/terminal/IvSurfacePopover.tsx`
- `frontend/src/data/ivSignalOutlook.ts` — LONG/SHORT/upside/downside copy
- `frontend/src/data/ivSignalSmileCopy.ts`
- `frontend/src/data/ivScannerExpiries.ts`
- `frontend/src/data/ivScannerDiagnostics.ts`
- `frontend/src/data/ivScannerChartLayout.ts`
- `frontend/src/data/ivSignalSmileGeometry.ts`
- CSS block `.iv-signal-*` in `frontend/src/index.css`

**Tests, fixtures, scripts**

- `project/tests/test_iv_signal_scanner.py`
- `project/tests/test_iv_signal_parity.py`
- `project/tests/test_deribit_ticker_stream.py`
- `project/tests/fixtures/iv_signal_parity_2026-08-14.json`
- `project/tests/reference/legacy_iv_signal_reference.py`
- `project/scripts/compare_iv_signal_parity.py`

### 1.3 Strengths to retain

- Live Deribit WebSocket ticker ingestion with generation-scoped
  incremental merge and immutable snapshots.
- Native inverse quote fields: bid/ask premium (BTC), bid/ask/mark IV,
  sizes, OI, venue timestamp, state, underlying price, delta.
- Quote-quality gates: open state, two-sided price and IV, crossed-market
  rejection, mark-IV-inside-market, quote age, zero-bid exclusion.
- Inverse synthetic `F = K / (1 − (C − P))` on BTC-denominated mids.
  This is the venue-consistent inverse parity formula and will be
  **validated, not invented**.
- Exact settlement-second `T` (`seconds / (365·24·3600)`), not
  calendar-day rounding.
- Point-level source tags (preferred OTM, opposite-side fallback,
  ATM merge, synthetic ATM anchor).
- Feed-health object (READY / WARMING / DEGRADED / DISCONNECTED).
- Existing frontend shell: expiry picker, smile + density layout,
  quality strip, diagnostic fold.

### 1.4 Spot-versus-forward inconsistencies

These are the economic defects that force a rebuild rather than a
relabel.

| # | Location | What happens | Why it is wrong |
| --- | --- | --- | --- |
| F1 | `derive_implied_forward` | Matching listed future is never considered. Hierarchy is parity → `underlying_price` → spot. | Charter requires listed future mid/mark first. |
| F2 | `derive_implied_forward` | Near-ATM pair window is `|K/S − 1| ≤ 8%` vs **spot**, not vs a candidate forward. | Spot-centered pair selection can drop the true ATM future pair. |
| F3 | `normalize_expiry_iv_curve` | Live path uses implied forward as OTM reference; book-summary/parity path still classifies OTM vs **spot**. | Same smile policy is not used on every input source. |
| F4 | `_apply_ticker_density_filters` | Core corridor, ATM moneyness, and OI screens are computed vs the OTM reference, but the parameter is named `spot` and ATM IV is a near-spot median. | Naming hides whether the filter is forward-centered. |
| F5 | `bs_delta` fallback | Delta from `bs_delta(spot, K, T, r, σ, side)` — Black–Scholes spot delta. | 25Δ and wing screens should use forward/Black-76 delta. |
| F6 | `build_canonical_smile` | 25Δ IVs interpolated on a dense **fitted IV(K)** grid by linear interpolation in signed delta, not by solving the model delta equation. | Charter requires numerical solution of the model delta. |
| F7 | `_build_pdf_with_quality` | Calls priced with `bs_call_price(spot, K, T, r, σ)` — Black–Scholes on **spot**. | Density, moments, and digitals are not forward-centered. Smile log-moneyness uses F; PDF uses S. |
| F8 | `compute_signals` | Mass-above/below, tails, peak, and band are all vs **spot**. `reference_price` (the forward) is accepted then discarded (`_ = reference_price`). | Prototype votes stay on spot by design. Product now forbids that. |
| F9 | `rnd_diagnostics` | Percentiles and 5% wings use the forward; `compute_signals` and `markers` still use spot. | One scan emits two different centers. |
| F10 | API `markers` | `tail_lower/upper` and `band_lower/upper` are spot × (1 ± ε). | UI overlays are not options-implied-forward centered. |
| F11 | 0DTE eligibility | Near-spot corridor and nearest-gap tests are vs **spot**. | Coverage gate is not the same F used for OTM/ATM. |
| F12 | No futures snapshot | Ticker universe is `kind=option` only. | Matching-future source cannot be computed. |
| F13 | Time | Settlement is `date + 08:00 UTC`, not the instrument `expiration_timestamp` when present. | Charter requires the instrument’s actual expiry timestamp. |

### 1.5 Directional, forecast, and unsupported “fair probability” labels

**Backend / API (production path)**

- `IvSignalDirection = LONG | SHORT | NO_TRADE`
- `IvDirectionalSignal`, `IvPeakSignal`, `IvBandSignal`
- `signals.skew / tails / peak / band`
- `model_verdict`, `verdict`
- `outlook.raw_verdict / published_verdict / forming`
- `eligibility.directional_eligible`, `zero_dte_eligible` (directional gate)
- `rnd.wing_signal`, `rnd.sigma_signal`
- Docstring: “product-safe directional outlook”
- `project/docs/iv_signal_scanner.md`: “heuristic directional readings”,
  “Center outlook”, “0DTE outlook”, synthetic-backtest reserved for a
  future tab

**Frontend**

- `frontend/src/data/ivSignalOutlook.ts`: Upside/Downside bias, Clear
  upside, Strong downside, directional outlook paused, “favor upside”
- `IvSignalScannerQuickView.tsx`: Prototype outlook, LONG/SHORT arrows,
  “Upside” / “Downside”, “directional outlook is paused”
- CSS `.iv-signal-direction--long/short`, `.iv-signal-verdict`

**Tests / reference (to isolate, not delete immediately)**

- `legacy_iv_signal_reference.py` vote math
- `compare_iv_signal_parity.py` LONG/SHORT vote comparison
- Scanner unit tests asserting verdicts

**Not Options Surface (leave alone)**

- GEX “one-sided (short)/(long)” empty-state copy
- Regime “SHORT GAMMA / LONG GAMMA”
- Vol-compare `rv_short` / `rv_long` (window names, not directional)

### 1.6 Silent clipping, smoothing, normalizing, and fallbacks

| Behavior | Location | Effect |
| --- | --- | --- |
| `np.clip(iv_spline(K), 1e-4, None)` | smile + PDF | Negative/tiny fitted IV becomes 1bp. Hides arb and bad knots. |
| `UnivariateSpline(..., s=1.0)` on raw IV(K) | smile + PDF | Unconstrained smoothing in strike-IV, not total variance. |
| `raw_density / area` | PDF | Always renormalizes, including when area ≠ 1 because of negative mass. |
| `gaussian_filter1d(..., sigma=2)` | PDF | Visual/signal smoothing applied before votes; headline stats mix raw and smooth. |
| `np.clip(density, 0, None)` then integrate | signals + RND | Negative mass discarded so probabilities look valid. |
| Quality still `CAUTION` up to 1% negative area and remains signal-eligible | curve quality | Invalid density can still emit a directional verdict. |
| Opposite-side IV fallback at a strike | OTM selector | Counted, but then treated as a first-class smile point. |
| Synthetic ATM log-moneyness interpolant | OTM selector | Mixed into the same `iv_curve` used for fitting. |
| Book-summary path marked unverified but still builds a full scan | chain provider | Diagnostic source can look like a live surface. |
| Median IV across duplicate (strike, side) rows | selector | Silent collapse of conflicting quotes. |
| Forward fallback to underlying then spot with only a source string | forward | No quality, dispersion, pair diagnostics, or futures-option basis. |
| 25Δ linear interpolation in signed-delta space | smile metrics | Can invent a 25Δ IV off the model delta equation. |

None of these may remain as **concealed** production behavior. Fallbacks
that survive must emit source, quality, and reason codes.

---

## 2. Target architecture

New package `project/options_surface/`. Existing `project/normalizer/`
is the trade-ledger normalizer and must not be reused or renamed.

```
project/options_surface/
  types.py                 domain models (frozen dataclasses)
  timeutil.py              T, as_of_utc, expiry_utc
  market_data/
    instruments.py         option + future name/timestamp parsing
    futures.py             listed-future book snapshot (REST, injectable)
    ticker_adapter.py      adapt existing WS cache → native quotes
    snapshots.py           immutable persisted snapshot schema
  normalization/
    quotes.py              quality rules + reason codes
    otm.py                 canonical OTM vs selected F_T
    weights.py             robust fit weights
  forward/
    estimate.py            ForwardEstimate hierarchy + diagnostics
    curve.py               curve object + interpolation metadata
  surface/
    coordinates.py         k = ln(K/F), w = σ²T, forward delta
    fitters.py             two candidate fitters
    smile.py               per-expiry calibration + persistable params
    interpolate.py         w(k,T) linear in T at fixed k
    query.py               IV / w / delta / call / put queries
    arbitrage.py           butterfly + calendar diagnostics
  distribution/
    black76.py             USD-equivalent Black-76 (analytical layer)
    density.py             Breeden–Litzenberger extraction
    validate.py            mass, moment, CDF, digital, grid gates
  analytics/
    metrics.py             ATM, implied move, RR25, BF25, wings, TS
    history.py             snapshot-to-snapshot changes
  service.py               orchestrator for one as-of snapshot
```

API and frontend stay in their current packages and call `service.py`.

```
market_data snapshot
        │
        ▼
normalization (accept / reject + reason)
        │
        ▼
forward.estimate  →  one ForwardEstimate per expiry
        │
        ▼
normalization.otm  (same F_T)
        │
        ▼
surface.smile + surface.arbitrage
        │
        ▼
distribution.black76 + density + validate
        │
        ▼
analytics.metrics
        │
        ▼
typed API  +  persisted immutable snapshot
```

ETH: every public type carries `underlying: str` (initially `"BTC"`).
Instrument parsers already accept a currency prefix.

---

## 3. Canonical market conventions (implementation contract)

### Venue and units

- Venue: Deribit. Asset: BTC now; ETH later via the same interfaces.
- Options: inverse, premium stored in **native BTC**. Never multiply by
  spot to invent a USD vanilla price for parity or B–L.
- Strikes, index, futures, and the analytical Black-76 layer: **USD**.
- Listed BTC futures are the preferred observed forward when a matching
  expiry exists.

### Time

- Prefer the instrument `expiration_timestamp` (UTC). If missing, fall
  back to Deribit 08:00 UTC on the expiry date and flag
  `expiry_timestamp_inferred`.
- `T = elapsed_seconds / (365 * 24 * 60 * 60)`.
- Every result stores `as_of_utc` and `expiry_utc`.

### Forward (`ForwardEstimate`)

Fields: `forward_usd`, `source`, `source_quality`,
`supporting_instruments`, `parity_pair_count`, `parity_dispersion`,
`futures_option_difference`, `fallback_reason`, `validation_flags`.

Hierarchy:

1. `matching_future` — listed future mid/mark, quality-checked (two-sided
   or mark with documented reason). Quality `high` when two-sided and
   fresh; `medium` when mark-only.
2. `inverse_put_call_parity` — existing `F = K / (1 − (C − P))` on native
   BTC mids, after the validation tests in this plan pass. Quality
   `medium` when pair count and dispersion clear gates; else fail closed.
3. `venue_underlying_price` — option ticker `underlying_price` /
   estimated delivery. Quality `low` or `medium` by freshness/coverage.
4. `spot_fallback` — index/spot. Quality `low`. Always emit
   `fallback_reason`.

Never emit a forward without source and quality. `unavailable` is a
legal quality; the expiry then cannot produce a production smile or
density.

### Smile coordinates

- `k = ln(K / F_T)`
- `w(k, T) = σ(k, T)² · T`
- Forward delta from Black-76. 25Δ strikes by **numerical solution** of
  the model delta, not a normal-quantile shortcut and not linear
  interpolation in a precomputed delta array unless that array itself
  came from the model delta on the fitted smile and the root is then
  refined.
- Keep raw observed, synthetic ATM, fitted, interpolated, and
  extrapolated points in distinct collections.

### Input IVs

- Quality-filtered Deribit **mark IV** is the smile observation.
- Persist bid IV, ask IV, mark IV, bid/ask premium, size, OI, volume if
  present, quote age, rejection reason.
- Fit weight from bid/ask-IV width, premium spread, quote age, OI/size,
  and |k|. A one-sided or fallback quote never receives the same weight
  as a verified two-sided quote.

---

## 4. Smile calibration plan

### Candidate A — baseline, labeled `diagnostic` until gates pass

Quality-weighted interpolant in `(k, w)`:

- Accepted OTM marks → `(k_i, w_i = σ_i² T)` with robust weights.
- Shape-preserving PCHIP (or equivalent piecewise cubic Hermite) on
  `w(k)` inside the observed k-range.
- No IV clipping. `w ≤ 0` is a diagnostic failure, not a floor.
- Outside `[k_min, k_max]`: query status `extrapolated` / `unavailable`.
  No silent wing invention.

This is the **first production-candidate** because it is exact at
accepted knots (test 9), does not pretend to be arbitrage-free, and
fails closed when the book is sparse.

### Candidate B — raw SVI, labeled `research`

Raw Gatheral SVI in total variance:

`w(k) = a + b (ρ (k − m) + sqrt((k − m)² + σ²))`

Fit with quality-weighted residual in `w`. Persist parameters, residual
RMS, optimizer status. Report butterfly `g(k)` and calendar conditions.
**Do not** promote to production merely because the optimizer converges.
Promotion requires: `w > 0`, butterfly `g(k) ≥ −ε` on a dense k-grid,
and no calendar violation vs adjacent accepted slices.

If those constraints are not proven in this pass, SVI remains
`research`. The baseline remains the served fitter and is itself labeled
`diagnostic` until butterfly/calendar reports are clean on frozen
fixtures.

### Cross-expiry

At fixed k, only inside the observed maturity range:

`w(k,T) = w(k,T1) + ((T−T1)/(T2−T1)) · (w(k,T2) − w(k,T1))`

- No silent maturity extrapolation.
- Report `w(k,T2) < w(k,T1)` beyond tolerance as a calendar violation.
- Forward interpolation is a separate object with its own source/quality.

### Arbitrage

Diagnose, do not conceal:

- `w(k,T) > 0`
- call prices decreasing in K
- call prices convex in K
- per-expiry butterfly
- cross-expiry calendar on a standard k-grid

No Gaussian density smoothing, no negative-density clip, no post-hoc
price clamp as a surface control.

---

## 5. Risk-neutral distribution plan

Analytical USD-equivalent Black-76 **only**:

```
C(K,T) = e^{−rT} [ F_T N(d1) − K N(d2) ]
d1 = [ln(F_T/K) + ½ σ² T] / (σ √T)
d2 = d1 − σ √T
q(K,T) = e^{rT} ∂²C/∂K²
```

`r = 0` unless a documented funding input is added later.

The same `F_T` is used for OTM, k, ATM, delta, implied move, Black-76,
density moments, and UI forward reference.

Rules:

- Inverse premiums are never converted into USD vanillas for B–L.
- Raw density is validated first. Headline percentiles and probabilities
  emit only when status is `accepted`.
- Report raw negative mass, total mass, CDF monotonicity, forward-moment
  error, edge-mass/truncation, grid convergence, method status.
- Visual smoothing, if any, is a **display layer** after acceptance and
  is not the source of primary statistics.

---

## 6. Analytics (no directional composite)

Per accepted expiry:

- ATM IV (k = 0 on the fitted smile)
- 1-standard-deviation implied move: `F · (e^{σ_ATM √T} − 1)` up /
  `F · (1 − e^{−σ_ATM √T})` down, labeled as such
- 25-delta risk reversal and butterfly
- Skew / wing richness as **descriptive** IV differences, not votes
- Futures–option basis when both exist
- Term structure of ATM total variance and ATM IV
- Changes versus the previous stored snapshot (ΔIV, ΔRR25, Δpercentiles)

No LONG/SHORT, no confidence, no forecast tilt, no composite score.

---

## 7. API and migration

### New canonical endpoint

`GET /api/v1/options-surface?underlying=BTC&expiry=YYYY-MM-DD`

Response (sketch; exact fields in the data dictionary):

- `as_of_utc`, `expiry_utc`, `underlying`
- `forward`: full `ForwardEstimate`
- `quotes`: accepted + rejected counts and reason histogram
- `smile`: raw / synthetic / fit / extrapolated collections
- `surface_query_status`
- `density`: status, grid, raw q(K), CDF, quantiles **or omitted**
- `validation`: report object
- `analytics`
- `feed`
- `model_status`: `accepted | degraded | rejected | research`
- `fitter`: name + grade (`diagnostic` | `research` | `production`)

Optional later: `GET /api/v1/options-surface/term` for the k-grid
calendar report. v1 includes calendar diagnostics inside the single
expiry payload when sibling slices are available.

### Legacy endpoint

`GET /api/v1/iv-signal-scan` remains temporarily.

- Implementation switches to the new engine.
- Directional fields (`verdict`, `model_verdict`, `signals.*`,
  `outlook.*`, `rnd.wing_signal`, `eligibility.directional_eligible`)
  are **retired**: schema-kept for one migration window, always
  `NO_TRADE` / `false`, with `deprecated: true` documentation.
- Response meaning of density/smile/quality changes to the new
  forward-centered, fail-closed engine. Frontend must not keep reading
  those fields as a forecast.
- Query parameters `tail_threshold`, `band_width`, `signal_delta` become
  no-ops and are documented as deprecated.

### Field map (legacy → new)

| Legacy | New | Action |
| --- | --- | --- |
| `spot_price` | `index_usd` (plus `forward.forward_usd`) | keep spot as index, stop using it as the model center |
| `selection.implied_forward` | `forward.forward_usd` | replace |
| `selection.forward_source` | `forward.source` (new enum includes `matching_future`) | replace |
| `smile` | `smile` with explicit collections | extend |
| `density[].raw/smoothed` | `density.raw` only when accepted; `display_smooth` optional | replace |
| `rnd.percentile_*` | `density.quantiles` if accepted else absent | fail closed |
| `rnd.p_left_5` etc. | `analytics.tail_probabilities` if accepted | rename, qualify as Q-measure |
| `signals`, `verdict`, `outlook` | — | retire |
| `eligibility.directional_*` | `eligibility.surface_displayable` | replace |

Old prototype scanner, parity script, and synthetic-backtest comments
stay on disk under `pipeline/iv_signal_scanner.py` and
`scripts/compare_iv_signal_parity.py` until the new suite is green.
They are not imported by the production repository path after the
adapter cutover.

---

## 8. Frontend

Keep the existing pane shell, expiry list, smile/density layout, and
refresh cadence.

Required copy replacements (approved language only):

- Options-implied forward
- Risk-neutral terminal-price distribution
- Market-implied central range
- 1-standard-deviation implied move
- 25-delta risk reversal / butterfly
- Downside wing richness
- Surface fit quality
- Quote coverage
- Extrapolated region
- Risk-neutral probability (never “fair probability” unqualified)

Remove LONG/SHORT arrows, upside/downside bias headlines, prototype
outlook, and directional eligibility messaging.

Each chart/metric gets a short explainer: definition, method, Q-measure
flag, caveat, quality status.

Visual: raw points, fit, and extrapolated wings use distinct marks.
Rejected density does not draw headline percentiles.

---

## 9. Snapshot persistence

New immutable JSON document, one record per successful orchestration:

- schema version
- `as_of_utc`, `expiry_utc`, `underlying`
- native quotes (accepted + rejected with reasons)
- `ForwardEstimate`
- smile fit parameters, residuals, optimizer status
- density validation report (not a clipped PDF)
- analytics
- feed health

Storage: `project/runtime/options_surface/snapshots.jsonl` (append-only)
plus `latest_<underlying>_<expiry>.json` for the API warm path.
This is independent of the GEX ledger and of `latest_gex_snapshot.json`.

---

## 10. Test plan and acceptance gates

New tests live under `project/tests/options_surface/`. Legacy scanner
unit tests remain until cutover is proven.

### Mandatory numerical tests (charter)

1. Flat-vol Black-76 recovery: mass ≈ 1, q ≥ −ε, mean ≈ F, quantiles
   match analytical lognormal.
2. Strike monotonicity: `C(K[i+1]) ≤ C(K[i])`.
3. Strike convexity: `C[i−1] − 2C[i] + C[i+1] ≥ −ε`.
4. Density mass ≈ 1.
5. Forward moment ≈ F_T.
6. CDF monotone, bounded, starts near 0, ends near 1.
7. Digital reconciliation at ATM, 25Δ, 10Δ, and both wings.
8. Grid convergence across at least two resolutions.
9. Smile interpolation recovers accepted knots.
10. Calendar consistency of `w(k,T)` on a standard k-grid.
11. Forward-source hierarchy, quality metadata, fail-closed parity.
12. Data-quality reason codes: stale, crossed, one-sided, invalid IV,
    out-of-range, malformed, duplicate, sparse, expired.
13. API contract: every client result has as-of, expiry, forward
    source/quality, model status, diagnostic summary.
14. Frozen Deribit-like fixture regression with tolerances, not
    time-dependent exact numbers.

A synthetic random-data experiment is **not** a backtest and will not be
named one.

### Acceptance gates (definition of done)

- No Options Surface UI/API path emits directional or forecast language.
- The same `F_T` is used in every named surface/density calculation.
- Native inverse pricing is not converted into a USD vanilla for parity
  or B–L.
- Every displayed surface/density shows data and model quality.
- Invalid results fail closed or are clearly degraded.
- Full new validation suite passes.
- Research-grade components (SVI; baseline until arb gates pass) are
  labeled honestly.

---

## 11. Implementation stages

Do not start a wholesale rewrite of GEX, ticker transport, or the
frontend shell. Each stage is committable and testable.

| Stage | Deliverable | Gate |
| --- | --- | --- |
| 0 | This plan | reviewed in-repo |
| 1 | Domain types, timeutil, reason codes | import + unit tests |
| 2 | market_data adapter + futures snapshot + persist schema | fixture round-trip |
| 3 | normalization + ForwardEstimate | quality + forward tests (11, 12) |
| 4 | surface fitters + query + arb diagnostics | tests 2, 3, 9, 10 |
| 5 | Black-76 + B–L + validation | tests 1, 4–8 |
| 6 | analytics + service orchestrator | no directional fields |
| 7 | API schemas + `/options-surface` + legacy adapter | test 13 |
| 8 | Frontend copy, quality badges, explainers | visual + typecheck |
| 9 | Methodology, data dictionary, validation docs, implementation report | docs complete |

---

## 12. Legacy behavior to retire

Retire from the **production Options Surface path** (isolate, then
delete after the new suite and UI work):

- `compute_signals` LONG/SHORT votes and hysteresis
- `confirm_published_verdict` forming-outlook state
- 0DTE directional eligibility (keep a *display* freshness gate)
- Black–Scholes-on-spot B–L
- Unconstrained `UnivariateSpline` on raw IV(K) as the served smile
- `np.clip` of fitted IV and of density for headline probabilities
- Gaussian smoothing as a source of statistics
- Spot-centered markers, tails, and bands
- Prototype parameter sliders (`tail_threshold`, `band_width`,
  `signal_delta`) as product controls
- Any synthetic-backtest hook or “predictive performance” claim
- Multiplying inverse premium by spot
- Linear USD put-call parity on BTC premiums

Do **not** retire:

- Ticker WebSocket cache
- Inverse `F = K / (1 − (C − P))` after validation
- Quote-quality screens (re-expressed as explicit reason codes)
- Frontend pane layout and expiry aliasing (EOW/EOM), minus directional
  0DTE outlook logic

---

## 13. Assumptions and unresolved items

Assumptions:

- `r = 0` in the Black-76 layer for this pass. Inverse parity already
  uses the undiscounted Deribit coin formula.
- Matching future means a listed Deribit BTC future whose expiration
  timestamp matches the option expiry within a documented tolerance
  (same calendar date / official expiration). Perpetual is never a
  matching future.
- Futures books are fetched by REST `get_book_summary_by_currency`
  (`kind=future`) with an injectable client. They are not added to the
  option ticker WebSocket in this pass.
- Baseline fitter grade is `diagnostic` until frozen-fixture butterfly
  and calendar reports are clean. SVI is `research`.
- Existing GEX “short/long gamma” language is out of scope.
- `project/normalizer` stays the trade normalizer.

Unresolved (decide during implementation, record in the methodology
doc):

1. Exact pair-count and dispersion gates for parity quality
   (`medium` vs fail closed).
2. Whether option-ticker `underlying_price` that already *is* the
   matching future’s mark should be treated as `matching_future` when
   the listed future book is missing, or remain `venue_underlying_price`.
   Plan default: remain `venue_underlying_price` unless the future
   instrument name is confirmed.
3. Density grid default (strike-even vs log-K) and the two resolutions
   used for the convergence gate.
4. Whether `/api/v1/iv-signal-scan` is removed in the same change set
   as the frontend cutover or one release later. Plan default: keep one
   migration window with retired directional fields.
5. Persistence retention (how many JSONL snapshots to keep). Plan
   default: unbounded append in runtime, not a product archive.

---

## 14. Risk register

| Risk | Mitigation |
| --- | --- |
| Breaking GEX / heatmap / vol-compare | New package + new endpoint; do not edit those modules except shared expiry helpers if needed |
| Legacy scanner tests fail during adapter cutover | Keep `iv_signal_scanner.py` importable; change only repository/API/frontend after stage 5 is green |
| Inverse parity formula is wrong for some tenors | Validate on synthetic inverse quotes and on frozen live-style pairs; fail closed on dispersion |
| Sparse 0DTE books | Fail closed / `degraded`; no synthetic verdict |
| SVI looks calibrated but is arb-violating | Never serve as production in this pass |
| Frontend still shows old copy | Grep gate for forbidden tokens on Options Surface files |

---

## 15. Immediate next step

Stage 1: land typed domain models, time convention, and rejection-reason
enums with unit tests. No API or frontend edits in that commit.
