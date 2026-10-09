# IV–RV and independent delta skew

Implemented October 8, 2026 (America/Chicago).

## IV–RV

The inspection chart and spread chip now use the independent
`atm_term_curve.v1` estimator. The historical IV line comes from its existing
archive, with the last capture in each UTC hour. The full Parkinson RV30 line
remains available independently; neither IV nor the spread is backfilled with
DVOL or the older whole-smile surface.

Each spread observation joins to the most recent completed RV bar at or before
the ATM capture, at most one hour old. The current chip uses the same join.
The metric is forward-looking 30-day ATM IV minus trailing 30-day Parkinson RV
in annualized volatility points. It is descriptive, not a forecast or an
ex-post variance-risk-premium estimate. The z-score still requires 60 prior
completed consecutive UTC days and excludes the observation from its baseline.
Missing observation hours create chart gaps. The chart reports when ATM history
starts and when the scheduled capture is overdue.

## Skew estimator: `local_delta_skew.v1`

The old `desk_vol_surface.v2` PCHIP surface continues to exist with its existing
gates. It is no longer the source of the skew inspection or skew chip. Legacy
skew observations are retained on disk and never relabeled as the new estimator.

1. Discover the complete active BTC option chain independently of inventory.
   Book-summary marks select three candidates on either side of each 25Δ and
   10Δ target, plus near-ATM candidates. Actual ticker responses supply inputs.
   Failed fetches and discovered expiries without candidates remain explicit,
   so a missing immediate expiry cannot silently widen a tenor bracket.
2. Use existing quote filters: declared percent IV, ticker expiry forward,
   five-minute maximum age, two-sided positive book/size, uncrossed prices,
   relative premium spread <= 50%, and mark IV within bid/ask IV. Maximum
   expiry-forward dispersion is 0.5%.
3. Use OTM puts below the forward and OTM calls above it. Find adjacent accepted
   strikes that bracket the target Black-76 forward delta. Reject missing or
   ambiguous roots and delta brackets wider than 0.20. There is no nearest-delta
   fallback or wing extrapolation.
4. Interpolate total variance linearly in log(K/F) inside each local bracket.
   Check normalized Black call bounds, vertical-spread bounds, convexity, and
   delta monotonicity on 129 points in that segment. Solve the target delta
   numerically on the accepted interpolant.
5. For 7/30/60/90/180 calendar days (ACT/365), use the immediate listed expiries
   bracketing the target. Interpolate each put/call wing's total variance at
   fixed absolute delta, then convert back to IV. Do not extrapolate maturity.
   Source quotes for a metric and its ATM normalization must lie within 60 seconds.
6. Publish `(put IV - call IV) / forward ATM`, with positive values meaning puts
   are richer. Preserve raw risk reversals in vol points. The denominator uses
   the independent ATM algorithm on the same captured quotes, including its
   local price and ATM calendar checks. 25Δ and 10Δ have independent availability;
   tail gap requires both from the same capture and methodology.

This is a descriptive local-delta estimator. It does **not** certify an entire
smile as arbitrage-free. The maturity interpolation is at fixed delta, not fixed
log-moneyness; no full-wing calendar-arbitrage claim is made. Failed local gates
still withhold that metric. Far-wing failures do not automatically veto an
otherwise supported 25Δ measurement. The method and validation scope are
included in each payload.

## Collection and serving

`project/scripts/collect_skew.py` runs independently on ten-minute UTC boundaries.
It uses a separate zero-TTL ticker cache, three concurrent requests, a short
inter-batch delay, retry handling, and its own OS-owned lock. It is also started
by continuous `refresh_dashboard_live.py` runs; frozen and one-shot inventory
runs do not start it. A standalone collector and the integrated worker cannot
both own the same directory.

Artifacts under `project/runtime/dashboard_build`:

- `local_skew_live.json`: latest capture, original timestamps and source inputs.
- `local_skew_refresh_status.json`: process, schedule, support count and failures.
- `local_skew_history_v1/<capture_ms>.json`: immutable captures, including explicit
  missing tenors, with the complete ticker batch for replay. No automatic deletion.

The API attaches `flow_regime.skew_surface` at serve time, independently of the
cached inventory snapshot, strips raw quotes from dashboard responses, and
provides up to one year of hourly observations. Missing hours produce gaps.
Transport failures retain the previous observation and report the failed refresh;
they do not renew its timestamp. The UI withholds the current value when a
refresh fails or becomes overdue, while preserving the history chart and its
actual capture time. One observation is shown as a point while history grows.

Run manually from the repository root:

```powershell
.\.venv\Scripts\python.exe project/scripts/collect_skew.py
```

For a diagnostic capture, use `--once --artifacts-dir <separate-directory>`.
Collectors launched manually survive this chat but require the usual service or
scheduled-task startup after a machine restart. Existing continuous refresh
deployments pick up integrated startup when restarted with the new code.

## Validation

- 130 targeted backend checks passed, covering quote quality, delta recovery,
  total-variance interpolation, missing maturities, independent wing availability,
  local price violations, capture timing, collector ownership/failure, history
  gaps, API independence, ATM history, and RV joins.
- Frontend production build, targeted lint, and existing inspection join/z-score
  checks passed.
- Fresh independent public capture fetched 281 tickers in approximately 22 seconds,
  with no 429 responses, and supported all five skew tenors.
- Browser verification displayed 7D/30D/90D/180D, the ATM–RV comparison, the
  insufficient-history z-score state, and a simulated failed refresh retaining
  history. No page errors. Evidence lives in `runtime/skew_validation/`.

No purchased data or historical reconstruction was used. New skew history starts
with these captures; ATM history starts with the existing independent archive.
