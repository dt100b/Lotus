# Current ATM term structure

## October 8 methodology hardening

The [implementation review](atm_methodology_review_2026-10-08.md) supersedes the
older cadence, expiry, and hourly-retention descriptions below. The collector
now defaults to ten-minute UTC boundaries, archives every successful capture,
and exposes estimated bid/ask IV plus independently solved price-midpoint IV.
Captured curves retain their actual timestamp and become visibly overdue when
the next capture is missed. ATM History now uses this same collector's archive,
sampled hourly, rather than the broader smile fitter. Skew and IV-RV keep their
existing surface histories. Existing running services require a restart to load
these changes; none was restarted during the review.

The remaining sections record the previous implementation and dated UI checks.

The current curve now reads `atm_term_curve.v1`, independently of `desk_vol_surface.v2` and its whole-smile wing gates. This is a descriptive forward-ATM estimator, not a certification of a complete arbitrage-free surface. Skew, IV-RV and existing surface histories retain their existing definitions and gates.

## Collection and estimation

The independent ATM collector discovers the full BTC option chain, selects the six closest OTM put and call candidates per expiry, and fetches their tickers with existing concurrency and rate-limit retries. Selection is independent of reconstructed dealer inventory. It does not subscribe to or fit every wing. Failed ticker candidates preserve their expiry as unavailable rather than silently widening a tenor bracket.

Accepted quotes must satisfy the existing five-minute quote age, two-sided positive book size, uncrossed bid/ask, spread, explicit percentage IV and ticker-forward provenance checks. Each expiry's forward dispersion must stay within 0.5%. The closest OTM strikes must bracket the forward with each side within 0.025 log-moneyness. Mark total variance is interpolated linearly in log-forward moneyness at K=F. Local normalized Black call price bounds, vertical-spread bounds and convexity are checked on 129 points inside that bracket. Distant wings do not affect this local test.

Listed ATM total variance is interpolated between the immediate source expiries for exactly 1, 7, 30, 60, 90, 180 and 365 calendar days (ACT/365). Missing source ATM estimates, decreasing ATM total variance and unbracketed maturities remain unavailable. No nearest-expiry or DVOL replacement and no maturity extrapolation are used.

`as_of_ms` is calculation time. Original quote timestamps are retained in the saved inputs and bounds metadata. `valid_until_ms` uses the oldest accepted quote timestamp plus five minutes, so rebuilding with cached inputs cannot renew their lifetime. The frontend applies both calculation freshness and this input expiry.

The continuous collector uses an isolated zero-TTL cache and requests fresh near-ATM tickers every 60 seconds. It runs on its own thread, throughout trade ingestion, inventory replay and the larger GEX quote batch. Inventory caching remains unchanged. The older one-shot collection path allows at most 60 seconds of cached exchange quote age. If refreshes stop or take longer than the five-minute quote lifetime, the chart still withholds expired values and explicitly reports expired ATM quotes.

## Serving and operations

The chart's horizontal axis is linear in calendar days from 7D to 180D, rather than four equally spaced categories. The successive intervals are 23, 30 and 120 days, so Long sits materially farther from 60D. Long remains the same fixed 180D estimator, with only Long displayed on the axis. IV labels use bundled Inter at medium weight with tabular numerals and stagger vertically when necessary on narrow, nearly flat curves; dot positions and IV values remain unchanged. Cayo's [published bucket definitions](https://cayolargo.fi/api-doc/vol/surface) identify its Long as 60+ DTE, rather than a fixed 180D maturity.

The continuous artifact is `project/runtime/dashboard_build/atm_term_curve_live.json`; the API prefers it over the older one-shot `atm_term_curve.json`. Older running inventory workers cannot overwrite the dedicated artifact. Reads remain independent of the inventory snapshot cache. The term chip and Implied > Curve use this same estimator. The chart displays 7D, 30D, 60D and Long (180D), with compact filled markers without outer rings, a monotone visual curve through the tenor observations and matching shaded area. Missing tenors break both paths. Browser tooltips and hover cards are removed; accessible source-expiry labels and a subtle selection guide remain. Smoothing changes rendering only, not backend estimation or tenor values.

The inspection header combines category and subchart navigation in one 34px row. A compact category selector offers **Implied, VRP, Skew and Realized**; its subchart tabs sit alongside it, with a subtle family-colored underline on active choices. The 24px metric title row remains visible below, including **Term Structure**, the 180D-minus-7D regime/spread and relevant chart controls. This removes the separate subchart row while preserving the displayed heading and reading. The index history view is labeled **DVOL**. All four Implied views omit their source subtitle. **ATM IV By Tenor** overlays validated 7D, 30D, 60D and Long (180D) history in one chart with distinct colors and independent maturity buttons, initially enabled. Maturities with no validated history are disabled. Visibility survives tab and time-range changes; all maturities can be switched off and re-enabled with the keyboard. The time-range selector remains shared, while Skew retains its separate maturity selector. The separate dashed-swatch overlay control has the accessible name **DVOL overlay**, distinguishing it from the DVOL history view. Navigation, maturity/time selectors and keyboard focus remain available at narrow panel widths. Switching categories uses the selector; subcharts remain directly accessible in the navigation row.

The displayed title is **Term Structure**. IV labels are permanently visible; DVOL remains optional. Hover or keyboard focus shows the exact constant maturity and two-decimal ATM IV in a bottom readout, with IV matching the blue curve. The footer is empty when nothing is selected, and the axis reserves room for it at compact sizes. The header keeps the regime and numeric spread without the parenthetical maturity annotation; spread calculation remains 180D minus 7D. A fine opal line sits above a faint dotted field and restrained area wash. The dots fade toward the baseline; small baseline ticks align with the four tenor observations. The texture uses the same segmented area path, so missing tenors remain gaps. A red gradient on the line, underlying fill and dotted field highlights the front premium when 7D IV exceeds 30D IV. It extends through 60D and Long only while consecutive supported tenors remain strictly below 7D IV, and fades back to the ordinary color at its boundary. An equal/higher tenor or missing observation stops the highlighted span. This local front-premium display is separate from the header's 180D-minus-7D regime classification.

`refresh_dashboard_live.py` starts the independent collector automatically for continuous live runs. Frozen and `--once` runs do not start it. A cross-process OS lock allows only one collector per artifacts directory and releases automatically on process exit. An already running older inventory worker can remain in place while the separate collector starts:

```powershell
.\.venv\Scripts\python.exe project/scripts/collect_atm_term_curve.py
```

`atm_term_refresh_status.json` records collector PID, interval, state, attempt/completion/success times, refresh duration, supported tenor count, quote expiry, errors and consecutive failures. A failed or wholly unsupported quote pass retains the prior valid artifact with its original timestamps; it cannot manufacture freshness. Intermediate writes use unique temporary files and atomic replacement. Windows sharing conflicts during replacement/opening get short bounded retries. When the dedicated collector is running, the updated materializer skips its redundant ATM fetch.

The older diagnostic one-shot command updates only the fallback artifact and does not replace a dedicated curve or write inventory/checkpoints:

```powershell
.\.venv\Scripts\python.exe project/scripts/refresh_atm_term_curve.py
```

## Live verification, 2026-10-07 22:38 UTC

| Fixed tenor | ATM IV |
|---|---:|
| 1D | 29.76% |
| 7D | 32.14% |
| 30D | 35.01% |
| 60D | 36.54% |
| 90D | 36.99% |
| 180D | 37.59% |
| 365D | Unavailable: no maturity bracket |

The 30D point uses Oct 30 (~22.39D, 33.91% ATM) and Nov 27 (~50.39D, 36.28% ATM). It is not an average of all contracts in a 7-30D bucket. The Cayo reference screenshot shows 32.2%, 32.4%, 36.1% and 38.1% at its bucket labels. Collection time and cohort weights are unknown, so those are contextual comparisons, not ground-truth calibration targets. Their Long bucket does not correspond to a fixed 180D/365D target.

No legacy ATM history is reclassified under the new estimator. The temporary mock preview has been removed; only retained observations can generate historical curves.

## Daily lookback snapshots, 2026-10-08

The independent collector now retains the first valid observation in each UTC hour under `project/runtime/dashboard_build/atm_term_history/`. Each immutable JSON contains the full `atm_term_curve.v1` payload, including source-expiry provenance, unavailable tenors and original quote validity. Hourly files survive collector restarts; there is no automatic deletion. At typical payload sizes this is approximately 70 MB per year. Existing latest-only artifacts cannot backfill missing hours.

The terminal API exposes available whole-day lookbacks from 1 through 365 days relative to the current curve's calculation time. It selects an observation at or before the target time, at most two hours earlier. It never substitutes a different day, combines observations from different times, or applies current-quote freshness to historical observations. A missing, corrupt or incompatible snapshot leaves that lookback unavailable. Collection started October 8; the first 1D comparison becomes available after a full day of collection, subject to collector uptime.

The chart offers a Rewind disclosure, collapsed by default. Opening it reveals independent 1D/3D/7D/14D/30D toggles plus other available historical days; closing it preserves active curves. There is no additional-day picker. Historical curves use thin, muted solid lines without point markers. Overlays share the current curve's maturity and IV scales, retain missing-tenor gaps, and show their actual capture time. Historical overlays use a compact static color legend; hover and keyboard focus show only the current curve readout. Exact historical capture times remain in accessible curve descriptions. The controls and comparison readouts scroll horizontally in narrow panels.

Historical 1D/3D/7D/14D/30D curves use blue, teal, yellow-green, amber and coral to encode snapshot age, matching their controls and legend. Colors do not encode IV magnitude; intermediate days interpolate through the same age palette. Historical lines use 60% opacity with no endpoint labels or connectors, preserving the original horizontal span. Mock curves, controls and captions have been removed. Rewind is an absolute overlay at the top of the chart, with the original 24px top plot margin (16px in compact charts), so it does not reserve a separate strip above the curve. Unused overlay space lets pointer events pass through to the chart. When no historical curves are visible, the original bottom margin is also restored. Rewind unravels over 520 ms, with 45 ms staggered day-button reveals and a rotating chevron. Its fixed-height row and scrollbar-free horizontal scroller prevent vertical shifts. Collapsed controls are inert immediately, and reduced-motion preferences disable both animation and delays.

Validation: full backend suite 360 passed, 1 skipped; frontend build and targeted lint passed; inspection freshness checks passed. Live Chromium verification rendered six curve points with source-expiry labels and no page errors. Evidence: runtime/desk_surface_audit/atm_term_curve_live.png.

## Independent refresh and presentation validation, 2026-10-07

Full backend suite: 371 passed, 1 skipped. Tests include repeated ATM updates while inventory work is blocked, single-collector ownership and recovery after an abrupt process termination, network failure recovery without renewed timestamps, invalid-cycle retention, frozen/one-shot isolation, and API preference for the dedicated artifact over older worker writes. Frontend build and targeted lint passed. A rendering check samples cubic segments to verify the curve passes through observations without overshoot and breaks at missing tenors.

The live dashboard remained visible continuously for six minutes (25 observations), spanning eight distinct ATM updates while the older inventory worker remained active. Input quote age stayed below 62 seconds and the remaining expiry margin stayed above 238 seconds. Observed fetches took approximately 5–8 seconds. Two rate-limited requests recovered via existing retries with no skipped tickers. The run also covered a collector/API restart without losing the displayed curve. Evidence: `runtime/desk_surface_audit/atm_continuity.json` and `lotus_curve_smooth_live.png`. Narrow-width, hover-card removal, keyboard-focus, gap and reduced-motion browser checks passed without page errors.

## Listed-expiry chart, 2026-10-08

**Implied → Listed expiries** plots every actual expiry in the independent ATM collector's `listed_expiries`, without maturity buckets or extrapolation. This uses the existing forward-ATM mark estimate (interpolation between nearby OTM strikes at K=forward), rather than the nearest-to-spot strike described in the reference image. Dates, days to expiry and point values come from the same collector generation as the constant-maturity curve. The default **√** spacing uses square-root maturity coordinates. The optional **Spaced** toggle gives each listed contract equal horizontal space; distance on that axis does not represent elapsed time. Toggle descriptions remain accessible without native browser tooltips. The listed chart omits the source subtitle, BTC beside the heading and idle footer caption; the footer shows selected-expiry details only during hover or keyboard focus. Straight segments preserve individual expiry humps; unsupported observations break both the line and shaded area.

The frontend applies the same version and quote-expiry checks to incoming listed values as to constant-maturity values. At the user's request, the frontmost listed contract keeps its last valid display value through subsequent quote failures, without an added label. The next valid observation replaces it immediately; DTE continues to advance. This display cache survives chart-tab changes, resets when the front contract changes, disappears or settles, and clears on an incompatible source version. It does not change backend validation, constant-maturity estimates or other expiry values. Dates remain horizontal, with days to expiry directly underneath. Labels closer than 36px are omitted to keep one clear axis row; every observation remains plotted and inspectable by pointer or keyboard, including unsupported rows. The first and last expiry and the lowest-IV expiry receive date-label priority. Full dates and precise DTE remain in the selection readout and accessible marker descriptions. The navigation row scrolls horizontally when its four Implied choices cannot fit.

Validation: frontend build and targeted lint passed; browser checks cover current observations, equal-expiry and square-root coordinates, horizontal dates with DTE, reduced label density, clipping and label overlap at 924/424/320/250px, keyboard selection, missing-expiry path gaps, stale/version rejection and switching back to the existing Curve. Cleanup checks verify the shortened Implied dropdown description fits inside the menu, the renamed spacing toggles have no tooltip attributes, and the footer is empty until a marker is selected. Existing term geometry and inspection checks also passed. Evidence: `runtime/desk_surface_audit/listed_expiries_424.png` and `listed_expiries_924.png`.
