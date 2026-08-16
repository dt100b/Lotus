# IV signal scanner quick-view contract

> **Superseded as the production Options Surface.** The live product path is
> `project/options_surface/` and `GET /api/v1/options-surface`. See
> `docs/options_surface_methodology.md`. This note remains as the historical
> prototype contract. Directional outlooks are retired.

The Regime rail scanner is the live, single-expiry portion of the supplied
open-source model. Its synthetic backtester is deliberately excluded from this
surface and reserved for a future dedicated dashboard tab.

Quote filtering and the option-implied forward use **DVOL-inspired data-quality
mechanics**, not the DVOL index calculation.  DVOL builds depth-aware instrument
prices, a variance-swap interpolant around 30 days, and an EMA.  This scanner
selects a canonical OTM smile, fits it, reprices calls, extracts a
maturity-specific Breeden–Litzenberger density, and turns properties of that
density into heuristic directional readings.

## Canonical IV input policy

Production scans use a server-owned Deribit WebSocket cache.  Each connection
bootstraps the active BTC option names once with `public/get_instruments`, then
subscribes to `incremental_ticker.<instrument>` and
`instrument.state.option.BTC`.  Initial ticker snapshots and later patches are
kept generation-scoped; a reconnect cannot promote fields retained from the
previous socket generation.  Subscription requests are batched below
Deribit's 500-channel limit and the worker responds to heartbeat
`test_request` messages with `public/test`.

The summary endpoint remains available only for reconciliation/diagnostics and
is explicitly unverified for signal eligibility.  Dealer-inventory/GEX rows
are also never used as an IV chain.

For one expiry, `otm_ticker_mark_iv_v4` applies these rules in order:

1. Require ticker state `open`, a venue ticker timestamp, positive best bid/ask
   prices and sizes, and a positive bid/ask/mark-IV market.
2. Reject crossed price or IV markets.  Mark IV must sit inside bid/ask IV with
   at most 0.25 volatility points of numerical tolerance.
3. Reject ticker rows older than the configured maximum age.  Feed readiness
   separately requires a connected, current-generation, complete and fresh
   expiry subscription.
4. Exclude a quote from density fitting when `bid <= 0`, `ask <= 0`, or there
   is no valid two-sided market.  A zero bid is never coerced into IV = 0.
5. Apply a dynamic spread screen.  IV bid/ask width is the primary cap
   (15 vol points at ATM, widening to 35 on the wings).  Relative premium
   spread is only applied when mid price is at least 0.01 BTC, because cheaper
   Deribit books are tick-granular and a one-tick market can look "wide."
6. Derive an option-implied forward from valid near-ATM call/put mids, using
   Deribit's inverse synthetic `F = K / (1 - (C - P))`.  The winning pair is
   the lowest `|C − P|` among at least two full strikes inside 8% of spot,
   matching the DVOL-inspired market-synthetic rule.  If that book is unusable, fall
   back to venue `underlying_price`, then to spot.  Book-summary/parity inputs
   still classify against spot.
7. Keep a near-forward core so the smile still brackets the synthetic.  The
   core is every hard-valid strike inside `max(5%, 1.5 σ √T)`, expanded with
   the nearest remaining strikes until the tenor floor is met when the chain
   is dense enough.  Live bid/ask quality stays the primary gate inside that
   core.
8. Outside the core, drop far-OTM quotes with `|Δ| < 0.05` and deep-ITM
   quotes with `|Δ| > 0.95`.  Venue ticker greeks are preferred;
   Black-Scholes delta from mark IV is the fallback.
9. Treat open interest as a secondary wing screen, never as proof that a
   quote is tradable.  ATM quotes are never dropped for modest OI.  Non-ATM
   quotes need a low nonzero floor (1 / 2 / 5 / 10 by tenor, doubled on far
   wings).  Missing OI fails open.
10. Select put mark IV below the implied forward and call mark IV above it.
    Bid/ask IV is a validation envelope; the model input remains mark IV.
11. If the preferred side is unavailable, use the valid opposite side at the
    same strike. The response counts every fallback.
12. At a listed strike equal to the implied forward, merge valid call and put
    IVs robustly; use the single valid side only when a merge is impossible.
13. If the forward lies between listed strikes, insert one synthetic ATM
    anchor by interpolating the nearest lower/upper canonical IVs in
    log-moneyness.

The API returns the resulting `iv_curve` point-by-point, including source,
side, quote age, and whether a point is synthetic. `selection` reports all
preferred selections, fallbacks, ATM handling, and rejection counts.

Here, quote age comes from each ticker's venue `timestamp`; local receive time
is used only for transport silence diagnostics.  With incremental messages, a
field retained inside the current connection generation inherits the newest
ticker event timestamp.  This is stronger than summary-row age but is still an
instrument-event clock, not proof that every unchanged field itself changed.

The top-level `feed` object reports transport, channel mode, connection status,
generation, active-universe currency, expected/subscribed/initialized/fresh
instrument counts, last-message age and reconnect count.  A response is
trade-eligible only at `READY` with 100% selected-expiry completeness.  On
disconnect or reconnect, retained data is diagnostic only and the scanner
fails closed.

These transport diagnostics remain in the API for operations and audit use.
The customer-facing panel reduces them to plain `Live data`, `Updating`, or
`Data delayed` states.

## Time to expiry

Time is evaluated at request time against the actual 08:00 UTC settlement
instant.  Each quote keeps its own ticker timestamp for staleness checks.
Calendar-day rounding from the prototype is not used.

## Density quality and signal eligibility

The Breeden-Litzenberger, spline, and voting math remains unchanged. Negative
density is still clipped only for signal integrations, matching the prototype.
The response makes the numerical distortion visible:

- `HIGH`: integrated negative area is at most `1e-8`.
- `CAUTION`: negative area is above `1e-8` and at most `0.01` (one percentage
  point of probability mass). The model may remain eligible.
- `LOW`: negative area is above `0.01`, or normalization is invalid. The final
  verdict is forced to `NO_TRADE`.

`curve_quality` also reports negative grid count/fraction, negative and
positive areas, the normalization integral, and whether clipping occurred.
The API retains `model_verdict` and all four votes for diagnosis while
`verdict` is the trade-eligible result. Stale/unverified inputs and strike
coverage that does not bracket spot are independent hard suppression reasons.
Ticker-backed scans treat eight accepted strikes as a *floor*, not a success
criterion.  Eligibility uses tenor-aware counts plus a maximum ATM
log-moneyness hole:

- 0–2 DTE: at least 8 accepted strikes, 3+ on each side of the forward.
  Center gap at most 6% log-moneyness.
- 3–14 DTE: at least 12 accepted strikes, 4+ each side.  Center gap at most
  4%.
- 15+ DTE: at least 16 accepted strikes, 5+ each side.  Center gap at most
  5%.

A sparse hole next to ATM forces curve quality to `LOW` and suppresses the
verdict, even if the spline still produces a number.  The 35% hard-valid
listed-strike coverage screen is unchanged and is still measured *before*
secondary wing filters.  Four points remain sufficient to render a
diagnostic curve for prototype parity, but cannot emit a trade-eligible live
verdict.

Directional labels apply a 1-point hysteresis band (0.25% for the peak) so a
small quote perturbation cannot flip an active reading until the opposite
evidence clears the wider gate.  Regular expiries also keep a published
outlook until the raw verdict appears in two of the last three scans; the
raw state is exposed as `forming` and is not used for 0DTE.  Mass above
versus below the forward is a body metric and can disagree with 5% wing
probabilities (`rnd.p_left_5` / `rnd.p_right_5`).  Wing-sign tests assert
those tail probabilities first.

The `rnd` object logs P(S<0.95F), P(S>1.05F), one-sigma wings
`ln(K/F)/(σ_ATM √T)`, the 5/25/50/75/95 percentiles, the risk-neutral mean,
the raw normalization integral, and unclipped negative area.

The customer-facing panel leads with quality, center outlook, wing risk,
expected move, and central 50%/90% ranges.  Prototype sliders and the old
driver table live only under Model Diagnostics.  Chart overlays are the
implied forward, spot, the 25–75 probability band, optional ±1σ lines, and
fixed 5% wing edges.

The customer-facing panel keeps three independent reads:

1. **Curve quality** — HIGH / CAUTION / LOW.
2. **Center outlook** — mass above versus below the implied forward.
3. **Wing risk** — fixed 5% far-tail imbalance, with the 1-sigma reading
   shown as a second line.

The prototype 2% / mass-above-spot votes remain for parity under
**Legacy drivers**.  They measure central-distribution asymmetry, not
downside protection.

## Product expiry and 0DTE policy

The panel does not expose every listed contract. It presents the next live
Friday (`EOW`), the following weekly, the next month-end, and the following
monthly or quarterly expiry. Dates that serve more than one role are shown
once with combined labels. A same-day contract is excluded from every
structural alias unless it clears the dedicated 0DTE gate, so an ineligible
Friday cannot reappear as EOW or EOM.

0DTE is defined by the exact UTC settlement date, not by a rounded day count or
by whichever expiry happens to be first in a list. A same-day response may
expose a directional outlook only when all of the following are true:

1. More than four hours remain before the 08:00 UTC settlement.
2. Density curve quality is `HIGH` (the general-tenor `CAUTION` allowance does
   not apply).
3. At least two preferred canonical OTM strikes exist on each side of spot
   inside a ±3% corridor, with the nearest preferred strike on each side no
   farther than 1.5% from spot. Opposite-side fallbacks and synthetic anchors
   do not satisfy this requirement.
4. The full selected snapshot is no more than ten seconds old. The independent
   five-second feed-silence and WebSocket completeness gates still apply.
5. The parity model has a directional unanimous-active verdict and at least
   two of its four readings align. A single active reading is never enough for
   0DTE.

The response exposes these checks under `eligibility`. Direct API requests are
subject to the same gate as the dropdown and receive a final `NO_TRADE` verdict
when any check fails; `model_verdict` remains available for internal parity and
diagnostics.

The server recommends a 600-second UI sampling interval for regular expiries
and 120 seconds only while 0DTE remains eligible. This controls recomputation
of the visible panel, not the continuously running Deribit WebSocket or its
safety freshness thresholds. The refresh icon can request an earlier sample.

## Parity policy

The supplied `D:/app.py` is pinned by SHA-256
`5F528547A2828B00D5FF44457CF013CEBDAB2178CF257486D6DCE129CFE5D024`.
Parity tests run its pure numerical functions without loading Tk/Matplotlib and
compare staged outputs across frozen expiries:

1. prototype call/put observations plus calendar-day time;
2. canonical IV inputs plus calendar-day time;
3. canonical IV inputs plus exact settlement time through reference math;
4. the production scanner, including quality gating.

This staging attributes differences to duplicate-strike cleanup, the OTM/ATM
policy, invalid-input rejection, exact time-to-expiry, or the quality gate.
Canonical-versus-prototype vote changes are review items; production math must
match reference math when both receive identical inputs and exact time.
