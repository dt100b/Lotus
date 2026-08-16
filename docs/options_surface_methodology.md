# Options Surface Methodology

This document is the economic specification of the Lotus market-implied
BTC options surface. It describes how the Deribit options market prices
forwards, volatility, and a risk-neutral terminal-price distribution. It
is not a directional forecast.

## 1. Product identity

The surface answers:

- What forward does the listed book imply?
- What ATM volatility and 1-standard-deviation implied move does that
  book price?
- What skew and curvature (25-delta risk reversal and butterfly) are
  in the smile?
- What risk-neutral terminal-price density is consistent with the smile
  under Black-76?
- How good is the data and the fit?

It does not answer “will BTC go up?” and it does not emit LONG, SHORT,
bullish, bearish, confidence, or forecast fields.

All probabilities are **risk-neutral / Q-measure / market-implied**.

## 2. Venue conventions

- Venue: Deribit. Asset: BTC (ETH-ready interfaces).
- Options: inverse, premium stored in **native BTC**.
- Strikes, index, futures, and the analytical Black-76 layer: **USD**.
- Inverse premiums are never multiplied by spot to invent a USD vanilla
  price for parity or Breeden–Litzenberger.

## 3. Time

Prefer the instrument `expiration_timestamp` in UTC. If missing, infer
Deribit’s 08:00 UTC settlement on the listed date and flag
`expiry_timestamp_inferred`.

```
T = (expiry_utc − as_of_utc).total_seconds() / (365 × 24 × 60 × 60)
```

Every result stores `as_of_utc` and `expiry_utc`.

## 4. Forward

`ForwardEstimate` is selected in this order:

1. **matching_future** — listed Deribit future mid (two-sided) or mark.
   Quality `high` / `medium`.
2. **inverse_put_call_parity** — Deribit coin synthetic
   `F = K / (1 − (C − P))` on native BTC mids. Requires ≥ 2 near-ATM
   pairs and relative dispersion ≤ 1.5%. Quality `medium` or `low`.
   Invalid parity fails closed.
3. **venue_underlying_price** — option ticker `underlying_price` /
   estimated delivery. Quality `low`.
4. **spot_fallback** — index. Quality `low`, with `fallback_reason`.

The same `F_T` is used for OTM classification, `k = ln(K/F)`, ATM,
forward delta, implied move, Black-76, density moments, and the UI
forward marker.

## 5. Quote quality

Live ticker quotes are accepted only when they are open, two-sided in
price and (when required) IV, uncrossed, with mark IV inside the IV
market, sized, and fresh. Every rejection has an explicit reason code.

OTM selection against `F_T`:

- put mark IV for `K < F`
- call mark IV for `K > F`
- merge at exact ATM
- optional synthetic ATM interpolant in log-moneyness, tagged
  `synthetic` and never treated as a raw observation

Fit weights combine IV bid/ask width, premium spread, quote age, OI, and
`|k|`. A fallback or one-sided quote cannot receive a full two-sided
weight.

## 6. Smile coordinates and fit

- `k = ln(K / F_T)`
- `w(k, T) = σ(k, T)² · T`
- Forward delta from Black-76. 25-delta strikes are **roots of the
  model delta equation**, not a normal-quantile shortcut.

Two candidate fitters:

| Name | Space | Grade | Role |
| --- | --- | --- | --- |
| `tv_pchip` | interpolating PCHIP in `(k, w)` | `diagnostic` | Served baseline. Exact at accepted knots. Does not invent wings. |
| `svi_raw` | Gatheral raw SVI in `w(k)` | `research` | Compared, not served. Convergence is not no-arbitrage. |

`tv_pchip` is **not production-ready**. Promotion requires clean
butterfly and calendar reports on frozen live-style fixtures, plus a
documented residual budget. Until then every served surface is at best
`degraded` even when the density validates.

No IV clipping. `w ≤ 0` is a diagnostic failure. Queries outside
`[k_min, k_max]` return `extrapolated` / unavailable.

## 7. Cross-expiry interpolation

Inside the observed maturity range only:

```
w(k,T) = w(k,T1) + ((T−T1)/(T2−T1)) · (w(k,T2) − w(k,T1))
```

`w(k,T2) < w(k,T1)` beyond tolerance is a calendar violation. Forward
interpolation is a separate object.

## 8. Risk-neutral density

USD-equivalent Black-76 **analytical layer only**:

```
C(K,T) = e^{−rT} [ F N(d1) − K N(d2) ]
q(K,T) = e^{rT} ∂²C/∂K²
```

`r = 0` in this version. Second derivatives use a local stencil on the
fitted smile. The raw density is validated before any headline
percentile or probability is emitted. Negative mass is reported, not
clipped into a plausible PDF. Visual smoothing is not used for
statistics.

A rejected density produces no central range, no tail probabilities, and
no risk-neutral mean.

## 9. Analytics

Descriptive only:

- ATM IV at `k = 0`
- 1-standard-deviation implied move
- 25-delta risk reversal and butterfly
- downside / upside wing richness as IV differences
- futures–option basis
- Q-measure central ranges and tail probabilities, if the density is
  accepted or degraded (not rejected)

No composite score and no directional verdict.

## 10. What this is not

- Not a physical (P-measure) distribution.
- Not a price forecast or confidence interval.
- Not evidence of predictive alpha.
- Not a reason to convert inverse BTC premiums into USD vanillas.
