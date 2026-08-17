# Options Surface live UI clarity

This note records the live Options Surface chart semantics after the
correctness and clarity pass. It does not change the model, quote
policy, residual budget, inverse-premium conventions, density math, or
any serving gate.

`constrained_svi` remains `diagnostic_candidate`.

## Scope

The default panel is a live Deribit BTC options-market view. Internal
fitter, residual, and serving-gate detail stays in:

- the `options_surface.v1` API
- immutable snapshots
- developer diagnostics
- a closed-by-default **Method & quality** disclosure

No diagnostic field is deleted. No validation is relaxed. No IV, total
variance, call, density, CDF, or probability is clipped or renormalized.

## Density arrays

Customer-facing density arrays are the accepted served Breeden–Litzenberger
result:

| Field | Meaning |
| --- | --- |
| `density.strikes_usd` / `scan.density[].strike` | Strike grid of the accepted served density |
| `density.raw_density` / `scan.density[].raw` | Unclipped served density values. `smoothed` is a compatibility alias of `raw` and is not a statistical source |
| `density.cdf` / `scan.servedCdf` | Backend-sourced CDF on the same strike grid. Absent when rejected, misaligned, or missing |
| `density.quantiles.p05/p25/p50/p75/p95` | Accepted density quantiles. Absent or ineligible when rejected |
| `density.diagnostic` | Opt-in residual curve only. Never a valid probability distribution |

`scan.density[].smoothed` is not a smoothed reconstruction. The UI must
plot the accepted served values and must not treat that alias as a
separate statistical object.

## Overlay semantics

### Retained on the default density chart

When the **current** serving response declares density eligible:

1. **Central 90% interval** — one contiguous fill from accepted `p05` to
   `p95`. Low opacity plus a sparse hatch. Not a forecast range.
2. **Central 50% interval** — one contiguous fill from accepted `p25` to
   `p75`, nested inside the 90% interval. Slightly higher opacity plus a
   denser hatch.
3. **Density curve** — accepted served density only.
4. **Forward marker** — solid vertical line at selected
   `forward.forward_usd`. Labeled `FWD`.
5. **Quantile hairlines** — optional subordinate lines at P5 / P25 / P75 /
   P95. On narrow viewports, labels move to hover / legend rather than
   persistent on-chart text.

A compact persistent legend distinguishes these layers by line style,
pattern, and text, not color alone:

```text
— Density
│ Forward
▒ Central 50%
░ Central 90%
```

### Removed from the default density chart

| Overlay | Previous meaning | Why it left the default view |
| --- | --- | --- |
| `layers.wings` rectangles at ~0.95F / 1.05F | Legacy decorative columns | Not probability bands, PDF tails, or smile wings |
| Dashed ATM-IV 1σ strike lines | `implied_move_1sd` strikes | Not P5/P95 quantile boundaries. ATM 1σ remains a metric, not an unlabeled chart boundary |
| `MODE` marker | Mapped from `quantiles.p50` | That value is the risk-neutral median, not a density argmax. No validated mode is served |

ATM 1σ and residual-budget / research-candidate overlays may appear only
inside Method & quality or an explicit diagnostic mode. They are not
default chart layers.

### Not added in this pass

- A backend density mode / argmax. No trivial validated source exists
  without changing density math or clipping the served grid.
- A client-side CDF. Hover uses `density.cdf` only when the accepted
  payload supplies an aligned array. Otherwise cumulative probability is
  omitted.
- A last-known-good / delayed-cache density. That would require an
  explicit “Delayed — last updated [timestamp]” product state.

## Data / API changes

No fitter, quote, residual-budget, or serving-gate policy change.

Display-contract corrections only:

1. **`display.metric_eligibility.mode`** is not available. The backend
   does not serve a validated density mode. The previous mapping from
   `p50` is incorrect and is no longer treated as customer-facing mode.
   The `mode` row remains for compatibility with reason
   `mode_not_served` (or the density-rejection reason when the density
   itself is ineligible).
2. **`forward.source_quality`** is passed through to the UI as
   `selection.forwardSourceQuality`. The frontend must not upgrade
   medium / low / unavailable to high.
3. **`density.cdf`** is mapped to `scan.servedCdf` only when density is
   eligible and the CDF length matches the served strike grid. Rejected
   density continues to return an empty public CDF.

`median` remains an eligible API metric on an accepted density. This
pass does not render MED or MODE in the default UI.

## Rejected / loading / refresh behavior

Rendering is driven by the **current** typed eligibility and status, not
by leftover non-null arrays.

| State | Title | Density chart | Ranges / hover |
| --- | --- | --- | --- |
| Loading / skeleton | Loading copy | Skeleton only | Hidden |
| Accepted current density | Live options-implied distribution | Current served PDF + 50/90 fills | Current eligible metrics only |
| Rejected / unavailable density | Distribution unavailable | No PDF, no fills, no quantile markers | Hidden |
| Refresh failure with prior accepted payload | Delayed / live-book copy. Not the rejected title | Prior PDF must not remain visible | Prior ranges / hover must not remain visible |
| Research-only SVI failure, served density accepted | Live accepted presentation | Served density remains | Research detail stays in Method & quality |

`placeholderData` is not used to keep a previous scan as the current
surface. React Query may still hold the last successful payload after a
failed refetch; the UI must treat `refreshFailed` as “no current valid
density” and must not paint that payload under an unavailable title.

Customer rejected-density categories, from `primary_failure_category`:

- `market_data` → Insufficient market coverage
- `fit_quality` → The market quotes could not support a reliable fitted distribution
- `hard_gate` → Distribution validation failed

Supporting copy: `Ranges and percentile estimates are withheld for this expiry.`

## Accessibility

- Density and smile SVGs have descriptive `aria-label` / `<desc>` text
  for the curve, forward, central 50%, central 90%, and unavailable
  states.
- Interval fills use opacity **and** hatch patterns plus a text legend.
  Forward is a solid line. These distinctions do not rely on red/green.
- Method & quality is a keyboard-focusable button with `aria-expanded`.
- Essential labels (legend, FWD, interval names, unavailable
  explanation) are persistent. Hover is not the only way to discover
  them.

## Explicit non-changes

- `constrained_svi` remains `diagnostic_candidate`.
- No change to the constrained-SVI fitter, parameters, optimizer,
  residual budget, selection policy, quote policy, forward hierarchy,
  inverse-premium conventions, or density math.
- Monotonicity, convexity, CDF, negative-mass, mass, moment, digital,
  and grid-convergence gates are unchanged.
- No clipping or renormalization of IV, total variance, calls, density,
  CDF, or probabilities.
- No hidden PCHIP fallback and no invented wing extrapolation.
- GEX, dealer-positioning, regime, and vol-compare paths are untouched.
- Stored and API diagnostics remain.
