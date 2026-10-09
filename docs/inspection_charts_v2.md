# Volatility inspection views — v2

The inspection section now uses the same gated forward-ATM surface as the main
regime chips. The old VOL / TERM / SKEW / RV contents have been reorganized:

| View | Contents | Source |
| --- | --- | --- |
| Implied | Current constant-maturity ATM curve; ATM history by maturity; DVOL benchmark history | `desk_vol_surface.v2`; DVOL is separately labeled |
| IV − RV | 30d ATM/RV comparison; ATM minus trailing RV spread; spread z-score | Surface ATM history joined backward to completed Parkinson RV30 observations |
| Wings | Normalized 25Δ body skew; normalized 10Δ tail skew; 10Δ minus 25Δ risk reversal | Surface history, with selectable 7d/30d/90d/180d maturity |
| Realized | Independently selectable 24h, 7d and 30d Parkinson histories | Deribit BTC-PERPETUAL hourly candles |

The current curve never substitutes DVOL for a missing ATM tenor. Missing curve
points break the line. Benchmark visibility does not alter the curve's scale
when disabled. Wing normalization matches the header: `(put IV-call IV)/ATM`.
Tail gap is in volatility points, not percent. Historical views show their last
sample time in UTC, making old valid observations distinguishable from current
levels.

## Calculation and validity changes

- Greek snapshots preserve bid/ask premiums, amounts, IVs, and forward provenance.
  Live surface inputs require positive two-sided sized markets, uncrossed spreads,
  mark IV inside bid/ask IV, relative premium spread <=50%, age <=5 minutes,
  future timestamp tolerance <=5 seconds, and ticker-forward provenance.
- Venue mark IV and bid/ask IV are explicitly percent. Direct `SurfaceQuote`
  values remain decimal. The old magnitude heuristic is removed from this path.
- Expiry forwards reject dispersion >0.5%. Optional authoritative expiry
  timestamps are preferred; name-based 08:00 UTC settlement remains the fallback.
- Surface metrics require numerical Black price bounds, vertical spread bounds,
  and butterfly checks on supported strikes, with additional knot-interval
  sampling. Rejected source smiles cannot supply derived maturities.
- Calendar checks include shared-domain grids and piecewise-cubic extrema,
  addressing crossings between knots. Detected failures withhold derived metrics.
  Exact-expiry metrics also check adjacent calendar consistency.
- Constant-maturity variance is evaluated as the exact weighted source-smile
  blend. A second PCHIP refit no longer changes its between-knot values.
- Parkinson windows require unique hourly timestamps and complete contiguous
  coverage. Malformed rows retain holes; ambiguous duplicates invalidate their
  slot. Incomplete candles are excluded. RV observations are available at the
  final bar's **close**, preventing lookahead in joins.
- RV trend uses the same Deribit instrument and complete-window conventions as
  inspection histories. Error caches are capped at ten minutes.
- Surface/RV current comparisons reject timestamp mismatches beyond two hours.
  Historical ATM/RV joins use only backward RV observations within one hour.
  Frontend current levels are withheld for surface snapshots older than five
  minutes or with a legacy/unknown version. Historical data remains inspectable.
- Z-scores need 60 complete prior UTC daily observations. The current observation
  is outside that baseline; partial days and missing baseline days are excluded.
- The shared Lightweight Charts formatter uses a decimal native tick base,
  fixing the runtime `unexpected base` failure with arbitrary display steps.

These filters and tolerances are conservative initial serving budgets, not
empirically optimized crypto parameters. The surface is still a **marks PCHIP
with numerical gates**, not a globally certified arbitrage-free model. No
constrained-SVI production promotion or tail-density claim is implied. An invalid
fit may make ATM and wing views unavailable; rejection is preferable to hiding
the failure. A spread-aware constrained calibration and multi-regime promotion
study remain separate work.

## Migration and operation

`vol_surface_history_v2.json` holds only new gated samples. The v1 history file
is preserved and is not mixed into new histories. Writes use temporary-file
replacement. No DVOL or legacy 50Δ-ATM history is substituted when new histories
are empty. Z-scores will need fresh history before becoming available.

Normal backend restart/reload and materialization must run the updated provider
and snapshot builder before the live API can supply v2 data. No deployed service
was restarted by this refactor. The existing options-surface research view remains
separate from these dashboard inspection views.

## Validation

- Full backend: **344 passed, 1 skipped**.
- Targeted regression suite covers quote rejection, explicit units, invalid
  headlines, between-knot calendars, exact variance blending, RV timestamp
  coverage/availability, history definitions, and frozen Deribit replay.
- Frontend build and TypeScript checks pass.
- `node --import ./frontend/scripts/ts-hooks.mjs ./frontend/scripts/check-regime-inspection.mjs`
  checks historical joins, stale/legacy current-level rejection, full daily
  z-score baselines, and native tick formatting.
- Headless Chromium checked all inspection views/subviews with explicit mock
  data, including a 1280px compact viewport; no browser errors. Screenshots:
  `runtime/desk_surface_audit/inspection_ui/`.
- Frozen original evidence is preserved under `runtime/desk_surface_audit/2026-10-07/`.
  Updated replay results are under `runtime/desk_surface_audit/2026-10-07-v2/`.

No production data, ledger inventory, or deployment configuration was altered.
