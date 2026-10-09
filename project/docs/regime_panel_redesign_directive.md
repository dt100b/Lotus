# Regime Panel Redesign Directive

Status: architecture and product-design recommendation
Scope: right-side `RegimeRail` only; the existing IV/RV chart remains a separate companion surface
Primary objective: make the panel answer **state, cause, change, and invalidation** in under five seconds

## Executive directive

The panel should not be cosmetically rearranged. Its information model should be rebuilt around four desk questions:

1. **What regime are we in?**
2. **Which inputs are driving that read?**
3. **What has changed recently?**
4. **What price, flow, or expiry event can change it?**

The recommended design is a three-view panel:

- **Synthesis** (default): one behavioral headline, a short evidence sentence, and four ranked drivers.
- **Positioning**: dealer gamma, Net GEX, change by horizon, full-book/session agreement, active strikes, and expiry concentration.
- **Volatility**: DVOL level and percentile, matched-tenor IV/RV premium, realized-vol pace, term structure, and skew.

Do not create a new opaque “Regime Score.” The dealer-gamma score may remain, but the overall synthesis should be deterministic and inspectable: every word in the headline must be traceable to a visible input.

## Current architecture

### Mount and scope

`RegimeRail.tsx` mounts two independent cards:

1. `RegimePanel` for the upper positioning/volatility summary.
2. `VolComparePanel` for the lower historical IV/RV, VRP, and VRP Z-score chart.

The rail intentionally receives `allExpirySnapshot ?? snapshot`, so its structural read does not change when a chart pane changes expiry. This is correct and should be retained, but the UI should explicitly show **ALL EXPIRIES** so the scope is never inferred.

### Current upper-panel hierarchy

`RegimePanel.tsx` currently renders:

- Dealer-gamma gauge and normalized score.
- Net GEX.
- IV minus 30-day realized volatility plus a nested 24h/7d realized-vol pace read.
- A two-point term-structure comparison: fixed ~1d front ATM IV versus 30d DVOL.
- Normalized 25Δ skew, preferring 1m then 1w then 3m.

The UI is implemented as a gauge plus a 2×2 matrix. The lower IV/RV card repeats several values already shown in the upper matrix.

### Current analytical definitions

| Signal | Current definition | Current use | Design implication |
|---|---|---|---|
| Dealer gamma | `NetGEX / Σ|GEX by strike|`, clipped to `[-1, 1]` | Primary gauge and short/neutral/long label | Useful polarity/concentration measure, but not a historical rarity score. Label it as a model score, not a probability. |
| Net GEX | Full production book, USD per 1% move | Repeats dealer-gamma polarity in dollar terms | Keep as magnitude evidence, not a separate equal-weight “signal.” |
| ΔGEX | 1h, 4h, 24h cumulative change; 24 hourly period bars | Computed in backend but unavailable to live UI | Highest-value missing dimension: it answers whether the regime is strengthening or decaying. |
| Full vs NY session | Full-book and post-08:00 ET polarity plus Aligned/Mixed/Fighting | Computed and transported, then archived from UI | Reintroduce as supporting evidence, not another hero gauge. |
| Active strikes | Largest strike-level ΔGEX over 4h/24h | Computed in backend but unavailable to live UI | Use in a compact “where risk is moving” list or transition map. |
| DVOL | Deribit ~30d implied-volatility index | Absolute bucket and IV/RV pair | Prefer historical percentile; fixed level buckets should be fallback only. |
| IV−RV | DVOL minus matched 30d Hyperliquid realized vol | Rich/neutral/cheap chip and lower chart | Preserve matched tenor; summarize premium once in the upper panel and let history live below. |
| RV pace | 24h versus 7d annualized RV | Nested inside IV/RV cell | Use as change evidence, not as a second valuation measure. |
| Term structure | DVOL30 minus fixed ~1d front ATM | Two-point line and shape label | Accurate for short-vs-30d slope, but not a full “curve.” Label the spread precisely until more tenors are exposed. |
| 25Δ skew | `(put25Δ IV − call25Δ IV) / ATM IV` | Current normalized value and fixed bands | Add history/percentile by tenor; crypto skew is regime-dependent and fixed bands alone are weak context. |
| Gamma/HVL transition | Session/front-book cumulative zero crossing | Deliberately excluded from Regime | Reintroduce only as a distance-to-transition fact, never inside the score. Null/no-cross must remain explicit. |

### Important transport gap

The backend `flow_regime.v1` payload already computes `velocity` and `active_strikes`, but the frontend `FlowRegime` type and `toFlowRegime()` mapper retain only `horizon`, `volCompare`, and `skew25d`.

This means the most useful “what changed?” data is currently discarded at the API-to-view-model boundary. The redesign should repair that contract before adding new backend math.

### Existing strengths to preserve

- Full-book rail scope is isolated from chart-expiry controls.
- IV and RV use matched ~30d tenors.
- Missing data has honest `—` states rather than synthetic neutral values.
- 25Δ skew has a documented sign and normalized formula.
- The lower volatility chart already supports IV/RV, VRP, and rolling 60d VRP Z-score modes.
- A DVOL historical-percentile helper already exists and only needs to be promoted into the live information hierarchy.

## Why the current panel feels visually weak

The problem is not simply spacing or color.

1. **Polarity is duplicated.** The gamma gauge, gamma label, gamma score, Net GEX value, and “dealer short/long” footer all communicate essentially the same fact.
2. **State and valuation are mixed.** Gamma polarity, absolute DVOL, IV/RV premium, RV momentum, curve shape, and tail skew appear as equal peers even though they answer different questions.
3. **The time dimension is missing.** A current value without its recent change or historical percentile cannot distinguish a persistent regime from a fresh transition.
4. **The lower chart and upper matrix repeat each other.** The upper card should interpret; the lower chart should provide history and verification.
5. **Several classifications are absolute.** Fixed DVOL, term-spread, VRP, and skew thresholds are simple and readable, but they can misclassify a structurally different BTC volatility environment.
6. **The panel does not expose invalidation.** It says “Short Gamma” but does not show what could make that read obsolete: GEX change, an HVL crossing, session flow divergence, or concentrated gamma expiry.
7. **Source age is invisible.** Deribit index, option-chain skew, materialized GEX, and Hyperliquid RV do not update on identical clocks.

## External product patterns worth borrowing

These are patterns, not templates to copy.

### 1. Separate regime context from directional prediction

SpotGamma explicitly frames GEX as volatility-regime and level context rather than a standalone directional signal. Its product materials pair Net GEX with flip/trigger levels, walls, expiry decomposition, and live flow. The useful design lesson is to phrase the headline as expected **market behavior**—stabilizing, mixed, or amplifying—rather than bullish/bearish direction.

Sources: [SpotGamma GEX overview](https://spotgamma.com/gamma-exposure-gex/), [SpotGamma GEX metrics and workflow](https://support.spotgamma.com/hc/en-us/articles/15214161607827-GEX-Gamma-Exposure-Explained-What-It-Is-and-How-SpotGamma-Uses-It)

### 2. Show current level, historical position, recent change, and expiry source together

MenthorQ’s summary workflow combines historical Net GEX, current gamma percentile, GEX change, expiring GEX, and gamma by upcoming expiration. It then separates volatility into IV, realized volatility, volatility risk premium, skew, and term structure. This is the closest external validation of the proposed four-question hierarchy.

Sources: [MenthorQ Ticker Summary](https://menthorq.com/guide/ticker-summary-page-your-complete-market-dashboard-for-faster-smarter-trading-decisions/), [MenthorQ Intraday Liquidity Summary](https://menthorq.com/guide/intraday-liquidity-summary-a-real-time-view-of-market-positioning-and-liquidity/)

### 3. Use percentile context instead of color alone

SpotGamma overlays historical statistics on term structure and uses historical Z-score coloring in its fixed-strike matrix. ORATS pairs IV, slope, price, and contango cards with directional pills, while using dedicated descriptive charts for term structure and skew and including one-year percentile context.

Sources: [SpotGamma term-structure dashboard](https://support.spotgamma.com/hc/en-us/articles/23982205386131-What-is-the-Term-Structure-tab-inside-the-Volatility-Dashboard), [SpotGamma statistical mode](https://support.spotgamma.com/hc/en-us/articles/24155600468627-What-does-the-Statistical-Mode-in-the-Volatility-Dashboard-Fixed-Strike-Matrix-do), [ORATS charting and analysis](https://orats.com/university/charting-and-analysis)

### 4. Keep surface dimensions distinct but connected

Amberdata exposes constant maturities, term structure with forward vol, GEX, and volatility curves as related but distinct tools. CME QuikVol likewise keeps implied volatility, realized volatility, skew, constant maturity, and term-structure views explicit. The lesson is not to compress the entire volatility surface into one ambiguous “vol regime” label.

Sources: [Amberdata Derivatives](https://www.amberdata.io/derivatives-info), [CME QuikVol](https://www.cmegroup.com/education/courses/introduction-to-cme-direct-and-quikstrike-analytics/quikvol-tool)

## Recommended information architecture

### Header

Show only:

- `REGIME · ALL EXPIRIES`
- `POSITIONING × VOLATILITY`
- Latest composite freshness state: `LIVE`, `DELAYED`, or `PARTIAL`
- Hover/click detail with source-level timestamps

Do not spend header space repeating BTC, spot, or DVOL; those already live in the global top bar.

### Synthesis view (default)

#### Behavioral headline

Use a behavior-first vocabulary:

- `STABILIZING` — materially long gamma
- `BALANCED` — gamma near neutral
- `AMPLIFYING` — materially short gamma

The visible title remains the recognizable position state (`Long Gamma`, `Gamma Neutral`, `Short Gamma`). The behavior pill explains the expected hedging dynamic without implying direction.

#### Evidence sentence

Generate one deterministic sentence from the strongest confirming and conflicting inputs, for example:

> Breaks can travel, but options are only modestly rich to realized volatility. Downside protection is the strongest confirming signal.

Rules:

- Maximum two clauses.
- Mention one confirming and one conflicting driver when they disagree.
- Never output a trade recommendation.
- Never synthesize a missing input as neutral.

#### Primary readouts

Keep only four small facts beside the headline:

- Dealer-gamma score.
- Net GEX magnitude.
- Count of live/usable driver families.
- Book scope.

#### Ranked driver list

Use four rows, ordered by decision importance:

1. Dealer gamma.
2. Tail skew.
3. IV−RV premium.
4. Term shape.

Every row contains: metric label, centered scale, current value, and plain-language interpretation. This replaces the current 2×2 tile matrix and makes disagreement scannable vertically.

#### Three next-question links

The bottom strip should answer where to drill next:

- `WHAT CHANGED?` → ΔGEX 1h/4h/24h.
- `WHAT CAN FLIP IT?` → spot/HVL distance and OPEX rolloff.
- `WHERE IS RISK MOVING?` → active strikes near spot.

These are compact summaries that switch to the Positioning detail view, not navigation to a separate page.

### Positioning view

Use four modules:

1. **Dealer gamma:** score, Net GEX, historical percentile, full/session agreement.
2. **Change by horizon:** 1h, 4h, and 24h ΔGEX, with a 24-hour sparkline or histogram.
3. **Transition map:** spot, HVL/flip distance, no-cross state, and expected stabilizing/amplifying side.
4. **Expiry concentration:** gamma by 0–1D, 2–7D, and 8D+ plus the amount rolling at next OPEX.

Active strikes should appear only after ranking by both absolute ΔGEX and distance to spot. A far-away large change should not outrank a smaller change directly around spot without an explicit reason.

### Volatility view

Use four modules:

1. **Volatility level:** current DVOL, 1-year percentile, and a concise state (`Floor`, `Compressed`, `Baseline`, `Elevated`, `Extreme`).
2. **Volatility risk premium:** DVOL, RV30, spread, and 60d spread Z-score.
3. **Term structure:** front 1d, 1w ATM, 1m ATM/DVOL, 3m ATM when available; headline the front/30d spread but draw the available curve.
4. **Tail pricing:** normalized 25Δ skew, primary tenor, historical percentile, and 1w/1m/3m comparison.

The existing lower `VolComparePanel` remains the historical chart. In the upper panel, show the current VRP once; do not redraw mini IV/RV bars that duplicate the chart below.

## Classification framework

### Dealer gamma

Retain the current `±0.12` mild and `±0.35` strong thresholds for continuity in the first redesign. Add a 90-day or one-year historical percentile as a second dimension once enough trustworthy history exists.

Display examples:

- `Short Gamma · −0.20 · P23`
- `Long Gamma — Pinned · +0.41 · P91`

The percentile refers to the signed score distribution, not raw Net GEX dollars.

### DVOL level

Promote the existing 252-daily-observation percentile helper into the live panel. Classification should be percentile-first:

- `P90+` Extreme
- `P70–89` Elevated
- `P30–69` Baseline
- `P10–29` Compressed
- `<P10` Floor

Until 60 observations exist, show `WARMING UP` and the raw value. Do not fall back to a confident percentile label.

### IV−RV premium

Continue to use matched 30d DVOL and RV30. Show both raw vol points and rolling 60d Z-score:

- Raw spread answers “how much premium?”
- Z-score answers “how unusual is it?”

The headline should prioritize Z-score once it has a full window; fixed ±4/±8 vol-point bands remain a readable fallback.

### Term structure

Do not label a two-point comparison as the complete term structure. Until the full curve is transported, use:

- Label: `FRONT / 30D SLOPE`
- Value: `+3.7 vol pts`
- State: `Contango`, `Flat`, or `Backwardation`

Once 1w/1m/3m ATM points are consistently available, render the curve and calculate:

- Front-to-30d slope.
- 30d-to-90d slope.
- Curvature/event premium.

### Skew

Keep the normalized formula and sign convention. Add historical percentile by tenor. The primary state should become:

`+17.1% · P84 · Protection bid`

rather than relying only on fixed ±10%/±18% thresholds.

## Data-contract recommendation

### Immediate frontend contract repair

Extend `FlowRegime` and `toFlowRegime()` to retain the already-computed backend fields:

```ts
type FlowRegimeVelocity = {
  windows: Record<'1h' | '4h' | '24h', {
    deltaNetGex: number | null
    rel: number | null
    sampleAgeS: number | null
  }>
  periodDeltas: Array<{
    startTsMs: number
    endTsMs: number
    deltaNetGex: number | null
  }>
}

type ActiveStrikeWindow = {
  window: '4h' | '24h'
  strikes: Array<{
    strike: number
    deltaGex: number
    distancePct: number
  }>
}
```

Do this before creating new API fields.

### New backend fields for v2

Add only after the existing contract is consumed:

- `gamma_score_history` or a server-computed score percentile.
- `gamma_by_expiry` with stable tenor buckets and exact expiry rows.
- `expiring_net_gex` for the next OPEX.
- `skew_percentile` by tenor.
- `term_curve` with ATM IV and forward-IV points.
- `freshness` per source family: inventory/GEX, option chain/skew, DVOL, and Hyperliquid RV.

Version this additively (`flow_regime.v2`) and keep nullability explicit.

## Component and file plan

Split the 1,700-line `RegimePanel.tsx` into focused units:

```text
frontend/src/components/terminal/regime/
  RegimePanel.tsx
  RegimeSynthesis.tsx
  RegimePositioning.tsx
  RegimeVolatility.tsx
  RegimeDriverRow.tsx
  RegimeFreshness.tsx
  regimeModel.ts
  regimeNarrative.ts
```

Keep `VolCompareChart.tsx` independent. Move dormant `NetGexProfile` and archived renderers out of the live module so their hooks, geometry helpers, and CSS do not obscure the active design path.

Primary integration points:

- `frontend/src/api/liveTerminal.ts`: transport mapping.
- `frontend/src/data/mockTerminal.ts`: types and realistic fixtures.
- `frontend/src/components/terminal/RegimeRail.tsx`: card sizing and view ownership.
- `frontend/src/index.css`: new rail layout; remove obsolete live selectors only after the new panel lands.
- `project/api/schemas.py` and `project/api/repository.py`: additive v2 fields.
- `project/pipeline/flow_regime.py`: percentile and expiry decomposition only after existing data is surfaced.

## Delivery phases

### Phase 1 — Information hierarchy with existing data

- Introduce Synthesis/Positioning/Volatility views.
- Replace the 2×2 matrix with ranked driver rows.
- Promote the existing DVOL percentile helper.
- Stop duplicating mini IV/RV bars above the full IV/RV chart.
- Add explicit `ALL EXPIRIES` scope and source freshness status.

### Phase 2 — Recover existing hidden analytics

- Transport `velocity`, `period_deltas`, and `active_strikes` to the frontend.
- Re-enable full/session agreement as one supporting row.
- Add the 24h ΔGEX history visual and active-strike list.

### Phase 3 — Historical context and transition risk

- Persist dealer-gamma score history and skew history by tenor.
- Add percentile ranks and minimum-sample gates.
- Add gamma-by-expiry and next-OPEX rolloff.
- Add spot-to-HVL transition distance without feeding it into the dealer-gamma score.

### Phase 4 — Validation

- Backtest synthesis labels against subsequent realized-vol expansion/compression; do not optimize for price direction.
- Compare percentile stability across high-vol and low-vol BTC eras.
- Test `ok`, `partial`, `stale`, `pre_open`, `no_cross`, and empty-chain states.
- Run an expert scan test: state/cause/change/invalidation should be recoverable in under five seconds.

## Acceptance criteria

- The default view has one regime headline, one evidence sentence, and no more than four driver rows.
- Every visible value exposes scope, horizon/tenor, and freshness on hover or focus.
- No missing value is styled or narrated as neutral.
- Color is paired with a word, sign, or marker position.
- Net GEX is not treated as an independent confirmation of the score derived from it.
- The upper panel interprets current state; the lower chart owns history.
- The panel remains legible at the current rail width without 6–7px essential text.
- Full-book/session disagreement and ΔGEX changes are visible without opening another dashboard.
- A no-cross HVL state is explicit and never converted into a fabricated level.
- The implementation adds no composite score until its definition and validation target are agreed.

## Recommended decision

Proceed with **Phase 1 and Phase 2 together**. They deliver the largest improvement without inventing new analytics: a clearer information hierarchy plus data the backend already computes. Treat historical percentiles, expiry decomposition, and transition-risk enrichment as the next iteration, not prerequisites for shipping the redesigned shell.
