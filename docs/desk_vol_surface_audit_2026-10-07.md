# Dashboard volatility surface audit — 7 October 2026

Verdict: **the dashboard surface does not yet meet a defensible production
standard for a validated volatility surface.** Its coordinates, time convention,
delta equations, and Parkinson formula are reasonable. Its data-quality,
arbitrage, time-window, and downstream consistency controls need work.

This was a review of the current working tree, including the user's uncommitted
upgrade. No dashboard or production calculation was changed. An independent
audit script and frozen evidence were added.

## Scope and evidence

The live dashboard path is:

`dashboard_snapshot.py` → `vol_surface/snapshot.py` → `vol_surface/surface.py`
→ `TotalVariancePchipFitter`.

This is different from the `project/options_surface` constrained-SVI/density
service described in `docs/options_surface_methodology.md`. Passing the older
service's gates does not validate the new dashboard path. The dashboard calls
the PCHIP fitter directly, bypassing `calibrate_smile` and its arbitrage report.

Validation performed:

- `python -m pytest project/tests/test_vol_surface.py project/tests/test_vol_compare.py project/tests/options_surface -q`: **107 passed**, 54.28 seconds.
- Independent flat-volatility recovery, butterfly counterexample, calendar
  counterexamples, stale-quote/unit checks, and missing/malformed/duplicate-hour
  Parkinson checks.
- One frozen public Deribit BTC option book-summary response at
  **2026-10-07 20:35:42.697 UTC / 3:35:42.697 PM America/Chicago**:
  950 rows, 950 converted quotes, 12 fitted listed expiries.
- Black call monotonicity, convexity, and digital slope bounds on uniform
  normalized-strike grids of 1,001, 2,001, and 4,001 points for listed smiles;
  2,001 points for constant-maturity smiles and adjacent-expiry calendar checks.

Evidence: `runtime/desk_surface_audit/2026-10-07/audit_results.json` and
`deribit_book_summary.json`. Canonical JSON response SHA-256:
`785ab9a99dd20e694cc66f107934e94fa2b125168938bacb74037390d665d9b6`.

The public summary reproduces the mark-IV/underlying-price surface inputs; it
is **not** the actual deployed dashboard Greek snapshot. Its creation timestamps
are not treated as true last-quote timestamps. No private credentials were used.
One snapshot demonstrates defects, not long-run failure rates or executable
trading opportunities. Grid checks are evidence of violations; a clean finite
grid alone would not prove global absence of arbitrage.

## What passes

- `k = log(K/F)` and `w = sigma² T` are appropriate surface coordinates.
- ACT/365, continuous time-to-expiry, 08:00 UTC settlement, and 365-day hourly
  RV annualization are consistent with a continuously traded crypto market.
- Listed ticker `underlying_price` is a defensible venue-forward input: Deribit
  uses the matching future mark, or a synthetic future when none is listed.
- OTM put selection below the forward and OTM call selection above it is sensible.
- ATM means forward ATM, `k=0`, in the new engine.
- Delta strikes are numerical Black forward-delta roots. No normal-quantile
  strike shortcut is used.
- Out-of-range strike and maturity queries are unavailable rather than given
  invented wings. Flat-vol recovery passes independent call-price checks.
- Parkinson's `sum(log(H/L)²)/(4 N log(2))`, annualized with 8,760 hourly bars,
  is correctly implemented. Zero-range bars remain in the denominator.
- Put-minus-call risk reversal is explicitly declared. This sign convention is
  usable, but differs from the common call-minus-put quote and must stay labeled.

These design choices agree with
[Deribit's contract and pricing conventions](https://support.deribit.com/hc/en-us/articles/31424939096093-Inverse-Options)
and the total-variance formulation in
[Gatheral and Jacquier](https://arxiv.org/html/1204.0646v4).

## Findings

### 1. High: no butterfly or price-bound serving gate

Locations: `project/vol_surface/surface.py:93` and `:228`;
`project/options_surface/surface/fitters.py:106`.

PCHIP preserves the shape of the total-variance data. It does not guarantee
that the resulting call prices decrease and remain convex in strike. The
fitter explicitly reports diagnostic/degraded status, but `build_slices`
accepts it and `metrics_for_smile` reports `ok` whenever ATM exists.

In the frozen live input, **10 of 12 listed smiles had negative curvature** at
all three grid resolutions. Three listed smiles also had increasing call-price
segments at the 2,001-point resolution. All five published constant maturities
had negative curvature, including **176 interior points at 30 days**. Their
rows nevertheless reported `status=ok` and `calendar_ok=true`.

A controlled five-knot smile with IVs `[.55, .52, .70, .48, .50]` over
`k=[-.30,-.15,0,.15,.30]` also produces 299 negative-curvature points while
reporting `ok`. These are materially negative values, not just roundoff.

This does not establish that the displayed 30d ATM level itself is numerically
wrong. It establishes that the smile supplying it cannot be certified as an
internally consistent option-pricing surface over its advertised domain.

Required: diagnose call price bounds, slopes, and convexity before serving;
preserve quality status in API/UI. Use a spread-aware constrained fit or an
arbitrage-constrained price interpolation. PCHIP can remain an observation
benchmark. SVI is an option, not an industry requirement; changing the model
name without enforcing constraints would not solve this.

### 2. High: calendar violations are publishable and can be missed

Location: `project/vol_surface/surface.py:161`.

The interpolation checks calendar ordering only at the union of source knots
plus ATM. Independent PCHIPs can cross between those points. A deterministic
seeded example returns `calendar_ok=true` even though the dense-grid minimum
`w_long-w_short` is **-0.00040748857**. The input arrays and seed are saved.

A plainly decreasing total-variance term structure (7d at 90% versus 90d at
15%) is correctly flagged `calendar_ok=false` but still publishes a 30d ATM of
**39.4121%**, with `status=ok`. The existing test
`test_calendar_violation_is_flagged_and_still_published` explicitly expects
this behavior. It is a behavioral test, not a production-quality gate.

The frontend mapper at `frontend/src/api/liveTerminal.ts:599` drops
`calendar_ok` and the fitting grade. Thus the flag does not reach the surface
chips. Exact-expiry queries also return `calendar_ok=true` without an
adjacent-expiry calendar check.

Required: evaluate calendar consistency on the common supported domain,
including between knots, before constructing or publishing derived maturities.
For piecewise cubics, interval extrema can supplement adaptive grids.
Use tolerance scales that reflect numerical precision and quote uncertainty.
Reject or explicitly degrade unresolved violations and propagate the reason.

The standard fixed-forward-moneyness condition is increasing total variance
with maturity, under the carry assumptions in
[Gatheral and Jacquier](https://arxiv.org/html/1204.0646v4). Crypto funding and
collateral conventions deserve explicit modeling; a calendar-consistency
failure under this analytical convention is not automatically an executable
cross-maturity arbitrage in inverse contracts.

### 3. High: input quality and forward provenance are lost

Locations: `project/vol_surface/surface.py:62`, `:301`;
`project/greeks/providers.py:489`; `project/vol_surface/snapshot.py:87`.

The Greek-to-surface conversion ignores `snapshot_ts`. `SurfaceQuote` has no
bid/ask premium, bid/ask IV, size, update time, or venue state. Every selected
point gets weight 1.0; OI only chooses among duplicate strikes. A quote with
timestamp 1 is accepted by the conversion. There is no surface-level stale,
one-sided, crossed, wide, or outlier rejection.

The live summary included **48 of 950 rows without positive, uncrossed,
two-sided premiums**. That count is for all source rows, not selected OTM
knots. It illustrates why mark availability and market availability must be
tracked separately. Deribit describes marks as outputs of its risk management
system, usually based on the bid/ask midpoint with additional checks:
[venue specification](https://support.deribit.com/hc/en-us/articles/31424939096093-Inverse-Options).

The provider falls back from `underlying_price` to index/other price fields,
but stores all of them as `spot_price`. The surface always labels the result
`ticker_underlying_price` and takes a median without a dispersion check.
Consumers cannot distinguish a real forward from a spot fallback.

`decimal_iv` guesses the input unit: raw values above 3 are divided by 100.
Deribit raw `mark_iv=2.0` would therefore decode to **200%**, rather than 2%.
This boundary defect is demonstrated independently. Use explicit units per
source rather than a magnitude threshold; synthetic decimal inputs should
use a separate declared conversion.

Required: carry quote timestamps, book quality, source units, actual expiry
timestamps, and forward provenance through a dedicated market-data object.
Apply sensible near-expiry and liquidity rules; quantify quote-age/forward
dispersion and residuals against spreads. Marks-only estimates may be useful,
but must be identified as such.

### 4. High: nominal Parkinson time windows can span the wrong duration

Locations: `project/vol_surface/parkinson.py:59`, `:108`, `:141`;
`project/api/repository.py:1501`.

Rolling windows count rows rather than enforce hourly timestamp coverage.
An absent hour is not inserted as a hole. Malformed numerical rows are removed
before windowing, even when their timestamp is known. Duplicate timestamps
are counted twice by the standalone estimator. Consequently all three
independent examples publish a nominal 24-hour estimate from the wrong set
of hours. The same defect applies to 168/720-bar windows.

The API fetcher deduplicates timestamps, reducing duplicate risk in that
specific path, but removes invalid rows and does not restore missing hourly
slots. It therefore still permits the missing-hour/window-length defect.

Required: build a unique UTC hourly grid, retain invalid/missing slots as
holes, and demand full time coverage before computing a fixed-duration RV.
Use completed candles and expose start, end, coverage, and source timestamps.
The current-hour cutoff should be explicitly validated; no closed-bar guarantee
was found in the reviewed fetch/estimation path.

Parkinson's estimator is a diffusion range estimator, not a universal measure
of all jump-inclusive crypto variance. Keep close-to-close and preferably
finer sampled squared-return RV alongside it; compare estimator behavior on
jumps, liquidations, strong trends, and different sampling frequencies. The
original work is [Parkinson (1980)](https://doi.org/10.1086/296071).

### 5. Medium: dashboard chips and inspection charts use different engines

Locations: `frontend/src/components/terminal/RegimePanel.tsx:418`;
`RegimeAnalyticsPanel.tsx:120`; `RegimeTermStructureChart.tsx:377`;
`frontend/src/lib/volCompareModes.ts:104`.

The main IV−RV chip uses surface 30d forward-ATM minus Parkinson RV30. The
VRP history and its z-score still use **DVOL minus Parkinson RV30**. The term
inspection chart reads the separate `skew_25d` payload, whose listed ATM
estimation uses call/put IV interpolation at absolute delta 0.50. Its
constant-maturity interpolation does not make that definition equivalent
to the new surface's `k=0` ATM. Skew inspection also uses the separate engine.

This means a chip and the chart opened to inspect it need not explain the
same calculation. Keep explicitly named benchmarks if desired, but serve
surface-derived inspection/history from the same validated source.

### 6. Medium: IV−RV is a useful spread, but does not identify variance premium

Location: `project/vol_surface/snapshot.py:143` and the VRP chart helpers.

ATM IV is one point on the smile. DVOL aggregates an option strip using a
variance-swap methodology; replacing DVOL with ATM IV changes the economic
quantity. See [Deribit's DVOL methodology](https://insights.deribit.com/exchange-updates/dvol-deribit-implied-volatility-index/).

Current calculations subtract volatility levels in percentage points and
compare forward implied volatility with trailing realized volatility. Label
that as an **ATM IV−trailing RV spread** or **DVOL−trailing RV spread**.
It is a descriptive proxy, not an estimate of expected option-selling profit.

If the target is variance risk premium, separately construct option-implied
expected integrated variance with stated wing/truncation conventions, then
compare with a same-horizon physical variance forecast. A trailing-RV proxy
can be retained and explicitly named. Squaring ATM IV alone does not recover
the option-strip implied variance. An ex-post study should align today's
implied measure with the subsequent realized window, without lookahead.
See the definitions in this
[Federal Reserve research paper](https://www.federalreserve.gov/pubs/feds/2011/201145/index.html).

### 7. Lower priority: maturity interpolation is refitted, not exact everywhere

Location: `project/vol_surface/surface.py:207`.

The code samples a weighted total-variance blend at knots and then fits a new
PCHIP. Because PCHIP is nonlinear in its knot values, this is not necessarily
the exact weighted combination of the two original smiles between knots.
The saved example shows **0.080306 vol points** of maximum discrepancy.
ATM is explicitly included as a knot, so this finding does not establish an
ATM interpolation error; delta roots can sample the affected intervals.

Required: evaluate the blended smile directly, or document/refine the
approximation and include it in the error budget. Recheck butterfly consistency
after cross-expiry interpolation; linear total-variance interpolation by itself
does not certify butterfly freedom.

The `exp(±sigma sqrt(T))` implied-move display is a heuristic centered on the
forward. It is not a 68% confidence interval or a quantile interval of the
skewed risk-neutral distribution. Even a flat lognormal equal-tail interval
has the `-w/2` location term. Retain the heuristic with that definition or
derive probabilities only from a validated distribution.

## Promotion criteria adapted to crypto

Before describing this as a validated production surface:

1. Preserve and gate quote quality, freshness, explicit IV units, expiry
   metadata, forward source, and supported strike/delta coverage.
2. Enforce appropriate analytical call bounds/convexity and calendar
   consistency over the served domain. Compare fit residuals with executable
   spreads rather than requiring exact recovery of noisy marks.
3. Propagate degraded/rejected status to every consumer; block headline
   metrics whose inputs fail their validity requirements.
4. Fix fixed-duration RV coverage, enforce completed bars, and timestamp
   the RV/IV join. Cached fallbacks need an explicit maximum age.
5. Unify surface chips and their historical/inspection charts; preserve
   benchmark definitions and methodology versions when migrating histories.
6. Replay a frozen multi-regime corpus covering expiry rolls, short maturities,
   quiet/stressed periods, sparse books, disconnections, and basis changes.
   Measure availability, spread-normalized residuals, temporal stability,
   delta coverage, arbitrage diagnostics, and interpolation error.

Crypto adaptation changes the data filters, annualization, carry assumptions,
and validation corpus. It does not make negative analytical densities or
silently stale data acceptable. There is no single universal certification
or prescribed model; acceptance budgets must be documented for the use case.
Do not infer risk-neutral tail probabilities from an unvalidated or truncated
smile, and do not infer physical forecasts from risk-neutral quantities.

## Reproduce

From the repository root:

```powershell
.\.venv\Scripts\python.exe -m project.scripts.audit_desk_vol_surface
.\.venv\Scripts\python.exe -m project.scripts.audit_desk_vol_surface --replay runtime/desk_surface_audit/2026-10-07/deribit_book_summary.json
```

For a new public-market sample, use a separate output directory so the
original evidence is retained:

```powershell
.\.venv\Scripts\python.exe -m project.scripts.audit_desk_vol_surface --live --output runtime/desk_surface_audit/new_capture
```

Replay reads the original capture time from the adjacent `audit_results.json`.
Outputs are audit evidence only; the script never writes dashboard artifacts.
