import {
  memo,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { GexExpiry } from '@/api/mockGexData'
import {
  getDisplaySpot,
  type TerminalSnapshot,
  type VolSeriesPoint,
  type VolSurface,
  type VolSurfaceTenor,
} from '@/data/mockTerminal'
import { useTerminalSnapshot } from '@/hooks/useTerminalSnapshot'
import { formatStrike } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import {
  describeIvRvSignal,
} from '@/lib/volCompareModes'
import type { RegimeAnalyticsFamily } from '@/components/terminal/RegimeAnalyticsPanel'

/**
 * Regime desk.
 *
 * Gamma gauge, net GEX, and the two peaks are the front expiry (0DTE).
 * Market context reads the desk surface and Deribit Parkinson RV:
 *   IV−RV = 30d constant-maturity ATM minus Parkinson RV30
 *   Term structure = longest published tenor ATM minus 7d ATM
 *   25Δ skew = 30d constant-maturity (put IV − call IV) / ATM
 *   RV trend = Parkinson 24h / Parkinson 7d
 *
 * Structure / NY Session polarity is archived (not mounted):
 *   `@/components/terminal/archived/RegimePolarityBlock`
 *   `project/docs/archived_regime_polarity.md`
 *
 * Gamma Flip lives on the LEVELS tab only (not shown or scored here).
 * Vol chips are display only.
 */
export const RegimePanel = memo(function RegimePanel({
  bookSnapshot,
  onInspectFamily,
}: {
  bookSnapshot: TerminalSnapshot
  onInspectFamily?: (family: RegimeAnalyticsFamily) => void
}) {
  const frontExpiry = listedFrontExpiry(bookSnapshot)
  const zeroDteQuery = useTerminalSnapshot(frontExpiry ?? 'ALL')
  const zeroDte = frontExpiry && zeroDteQuery.data?.expiry === frontExpiry
    ? zeroDteQuery.data
    : null
  const context = useMemo(() => getRegimeContext(zeroDte), [zeroDte])
  const volChips = useMemo(() => getRegimeVolChips(bookSnapshot), [bookSnapshot])
  const netGexUsd = zeroDte?.totalNetGexUsd
  const netTone: RegimeTone = netGexUsd == null
    ? 'muted'
    : netGexUsd > 0
      ? 'green'
      : netGexUsd < 0
        ? 'red'
        : 'muted'

  return (
    <section
      className="regime-panel flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-label="Regime"
    >
      <div className="regime-panel__upper">
        <header className="regime-panel__masthead">
          <h2>Regime</h2>
          <span
            className="regime-panel__scope"
            title={frontExpiry ? `Front expiry ${frontExpiry}` : 'Front expiry unavailable'}
          >
            0DTE
          </span>
        </header>

        <DealerGammaGauge
          label={context.dealerGammaLabel}
          score={context.dealerGammaScore}
          tone={context.dealerGammaTone}
        />

        <RegimeVolChips
          chips={volChips}
          netGexUsd={netGexUsd ?? null}
          netTone={netTone}
          volCompare={bookSnapshot.flowRegime?.volCompare ?? bookSnapshot.volCompare}
          positiveGammaStrike={zeroDte?.maxPositiveGammaStrike}
          negativeGammaStrike={zeroDte?.maxNegativeGammaStrike}
          spot={getDisplaySpot(bookSnapshot)}
          onInspectFamily={onInspectFamily}
        />
      </div>
    </section>
  )
})

function listedFrontExpiry(snapshot: TerminalSnapshot): GexExpiry | null {
  return snapshot.expiries?.find((expiry) => expiry !== 'ALL') ?? null
}

function DealerGammaGauge({
  label,
  score,
  tone,
}: {
  label: string
  score: number | null
  tone: RegimeTone
}) {
  const markerPct = score == null ? 50 : clamp((score + 1) * 50, 2, 98)
  const toneClassName = getRegimeToneClassName(tone)

  return (
    <div
      className="regime-gauge"
      role="img"
      aria-label={
        score == null
          ? 'Dealer gamma regime unavailable'
          : `Dealer gamma regime ${label}, score ${formatRegimeScore(score)}`
      }
    >
      <div className="regime-gauge__readout">
        <div>
          <span>Dealer gamma</span>
          <strong className={toneClassName}>{label}</strong>
          <em>{score == null ? '—' : getDealerGammaBehavior(score)}</em>
        </div>
        <div className="regime-gauge__score">
          <span>Score</span>
          <strong className={toneClassName}>{score == null ? '—' : formatRegimeScore(score)}</strong>
        </div>
      </div>
      <div className="regime-gauge__plot" aria-hidden>
        <div className="regime-gauge__zones">
          <span className="regime-gauge__zone regime-gauge__zone--short" />
          <span className="regime-gauge__zone regime-gauge__zone--neutral" />
          <span className="regime-gauge__zone regime-gauge__zone--long" />
        </div>
        <div className="regime-gauge__center" />
        {score == null ? null : (
          <div
            className={cn('regime-gauge__marker', toneClassName)}
            style={{ left: `${markerPct}%` }}
          >
            <i />
          </div>
        )}
      </div>
      <div className="regime-gauge__axis" aria-hidden>
        <span>Short</span>
        <span>Neutral</span>
        <span>Long</span>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Display-only vol chips (Tail / Term / IV−RV) — never enter score math       */
/* ─────────────────────────────────────────────────────────────────────────── */

const EMPTY_VOL_SERIES: VolSeriesPoint[] = []

/**
 * Tail risk (skew) display bands — single source for number, marker, and prose.
 * Stored value is dimensionless normalized skew (decimal); display is Glassnode-style
 * percent: e.g. 0.064 → +6.4%. Marker domain: fixed [−20%, +20%] ≡ [−0.20, +0.20].
 *
 * Purpose-built states (what the options market is pricing):
 * put  ≥ 18%          → Extreme Downside Skew
 * put  10%–18%        → Downside Protection Bid
 * |s|  < 10%          → Tail Risk Neutral
 * call 10%–18%        → Downside Protection Cheap
 * call ≥ 18%          → Extreme Upside Skew
 */
const TAIL_HIGH_ABS = 0.10
const TAIL_EXTREME_ABS = 0.18
/** Marker scale domain half-width (fixed; ±20% on the percent scale). */
const TAIL_SCALE_ABS = 0.20

/**
 * Term structure shape: |long − 7d| vol pts under this → Flat Term Structure.
 * Long is the longest published constant-maturity tenor past 7d (180d, else 90d, else 30d).
 * Contango / Backwardation → |long − 7d| ≥ TERM_FLAT_POINTS
 * Steep Contango / Stressed Backwardation → |long − 7d| ≥ TERM_STEEP_POINTS
 */
const TERM_FLAT_POINTS = 1.5
/** Magnitude cut for STEEP CONTANGO / STRESSED BACKWARDATION. */
const TERM_STEEP_POINTS = 5.0

type RegimeVolChipsModel = {
  tail: {
    /** Same skew value drives number, marker, and prose. */
    value: number | null
    /** Purpose-built market-state label (Protection Bid, Upside Skew, …). */
    prose: string
    /** Hover interpretation for the state label. */
    hint: string
    tone: RegimeTone
    markerPct: number
  }
  term: {
    longVol: number | null
    frontVol: number | null
    longTenor: string | null
    /**
     * Shape only (+ spread pts). Never includes absolute vol calm/stressed.
     * Stressed Backwardation | Backwardation | Flat Term Structure | Contango | Steep Contango
     */
    label: string
    detail: string
    tone: RegimeTone
    title: string
  }
  spread: {
    value: number | null
    /** Short flag: IV EXTENDED / IV RICH / IV NEUTRAL / IV CHEAP / IV DEPRESSED. */
    label: string
    detail: string
    tone: RegimeTone
    title: string
  }
}

function RegimeVolChips({
  chips,
  netGexUsd,
  netTone,
  volCompare,
  positiveGammaStrike,
  negativeGammaStrike,
  spot,
  onInspectFamily,
}: {
  chips: RegimeVolChipsModel
  netGexUsd: number | null
  netTone: RegimeTone
  volCompare: TerminalSnapshot['volCompare']
  positiveGammaStrike: number | undefined
  negativeGammaStrike: number | undefined
  spot: number
  onInspectFamily?: (family: RegimeAnalyticsFamily) => void
}) {
  const tailReadout = chips.tail.value == null ? '—' : formatSkewNormalized(chips.tail.value)
  const termSpread = chips.term.longVol != null && chips.term.frontVol != null
    ? chips.term.longVol - chips.term.frontVol
    : null
  const dailyRv = lastFiniteValue(volCompare?.rv1Series ?? EMPTY_VOL_SERIES)
  const weeklyRv = lastFiniteValue(volCompare?.rv7Series ?? EMPTY_VOL_SERIES)
  const paceRatio = dailyRv != null && weeklyRv != null && weeklyRv > 0
    ? dailyRv / weeklyRv
    : null
  const gammaDistance = (strike: number | undefined) => {
    if (strike == null || !(spot > 0) || !Number.isFinite(strike) || !(strike > 0)) return '—'
    const pct = ((strike - spot) / spot) * 100
    const sign = pct > 0 ? '+' : pct < 0 ? '−' : ''
    return `${sign}${Math.abs(pct).toFixed(1)}%`
  }

  return (
    <div className="regime-positioning" role="group" aria-label="Dealer positioning and market context">
      <section className="regime-positioning__book" aria-label="0DTE dealer positioning">
        <div className="regime-positioning__net">
          <span>Net GEX</span>
          <strong className={getRegimeToneClassName(netTone)}>
            {netGexUsd == null ? '—' : formatSignedCompactUsd(netGexUsd)}
          </strong>
          <em>
            {netGexUsd == null
              ? '—'
              : netGexUsd < 0
                ? 'Dealer short'
                : netGexUsd > 0
                  ? 'Dealer long'
                  : 'Balanced book'}
          </em>
        </div>
        <div className="regime-positioning__levels">
          <PositioningLevel
            label="+Γ peak"
            strike={positiveGammaStrike}
            distance={gammaDistance(positiveGammaStrike)}
            tone="green"
          />
          <PositioningLevel
            label="−Γ peak"
            strike={negativeGammaStrike}
            distance={gammaDistance(negativeGammaStrike)}
            tone="red"
          />
        </div>
      </section>

      <section className="regime-evidence" aria-label="Market context">
        <EvidenceRow
          family="volatility"
          label="IV - RV (30D)"
          title={chips.spread.title}
          value={chips.spread.value == null ? '—' : `${formatSpreadPoints(chips.spread.value)} pts`}
          state={chips.spread.label}
          tone={chips.spread.tone}
          onInspect={onInspectFamily}
        />
        <EvidenceRow
          family="term"
          label="Term structure (Long − 7D)"
          title={chips.term.title}
          value={termSpread == null ? '—' : `${formatSpreadPoints(termSpread)} pts`}
          state={chips.term.label}
          tone={chips.term.tone}
          onInspect={onInspectFamily}
        />
        <EvidenceRow
          family="skew"
          label="25Δ skew (30D)"
          title={chips.tail.hint}
          value={tailReadout}
          state={chips.tail.prose}
          tone={chips.tail.tone}
          onInspect={onInspectFamily}
        />
        <EvidenceRow
          family="rv"
          label="RV trend (1D / 7D)"
          title="Parkinson realized vol, last 24 hourly bars divided by the last 168, Deribit BTC-PERPETUAL"
          value={paceRatio == null ? '—' : `${paceRatio.toFixed(2)}×`}
          state={formatRvTrendLabel(paceRatio)}
          tone={paceRatio == null ? 'muted' : paceRatio >= 1.1 ? 'amber' : paceRatio < 0.9 ? 'blue' : 'muted'}
          onInspect={onInspectFamily}
        />
      </section>
    </div>
  )
}

function PositioningLevel({
  label,
  strike,
  distance,
  tone,
}: {
  label: string
  strike: number | undefined
  distance: string
  tone: RegimeTone
}) {
  const shown = strike != null && Number.isFinite(strike) && strike > 0
  return (
    <div className="regime-positioning__level">
      <span>{label}</span>
      <strong className={getRegimeToneClassName(tone)}>{shown ? formatStrike(strike) : '—'}</strong>
      <em>{distance}</em>
    </div>
  )
}

function EvidenceRow({
  family,
  label,
  title,
  value,
  state,
  tone,
  onInspect,
}: {
  family: RegimeAnalyticsFamily
  label: string
  title: string
  value: string
  state: string
  tone: RegimeTone
  onInspect?: (family: RegimeAnalyticsFamily) => void
}) {
  const content = (
    <>
      <span>{label}</span>
      <strong className={getRegimeToneClassName(tone)}>{value}</strong>
      <em>{state}</em>
      {onInspect ? <i aria-hidden>›</i> : null}
    </>
  )

  return onInspect ? (
    <button
      type="button"
      className="regime-evidence__row regime-evidence__row--action"
      title={title}
      onClick={() => onInspect(family)}
    >
      {content}
    </button>
  ) : (
    <div className="regime-evidence__row" title={title}>{content}</div>
  )
}

function formatRvTrendLabel(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return 'Unavailable'
  if (ratio >= 1.3) return 'Accelerating'
  if (ratio >= 1.1) return 'Expanding'
  if (ratio >= 0.9) return 'Stable'
  if (ratio >= 0.7) return 'Contracting'
  return 'Collapsing'
}

const SKEW_TENOR = '30d'
const TERM_FRONT_TENOR = '7d'
const TERM_LONG_TENORS = ['180d', '90d', '30d'] as const

function getRegimeVolChips(bookSnapshot: TerminalSnapshot): RegimeVolChipsModel {
  return {
    tail: getTailRiskChip(bookSnapshot.flowRegime?.skewSurface),
    term: getTermStructureChip(bookSnapshot.flowRegime?.atmTermCurve),
    spread: getIvRvSpreadChip(bookSnapshot.flowRegime?.atmTermCurve),
  }
}

/**
 * Independent 30-day fixed-delta term interpolation of local 25Δ wings.
 * Unit: (put IV − call IV) / forward ATM.
 */
function getTailRiskChip(surface: VolSurface | undefined): RegimeVolChipsModel['tail'] {
  const value = surface?.captureDueMs != null && Date.now() > surface.captureDueMs ? null
    : tenorField(surface, SKEW_TENOR, (row) => row.skew25Normalized)
  if (value == null) {
    return {
      value: null,
      prose: '—',
      hint: '30-day constant-maturity 25-delta skew is unavailable',
      tone: 'muted',
      markerPct: 50,
    }
  }

  const described = describeTailSkew(value)
  const markerPct = clamp(((value / TAIL_SCALE_ABS) + 1) * 50, 4, 96)
  return {
    value,
    prose: described.prose,
    hint: '30-day constant-maturity 25-delta skew, put IV minus call IV, as a percent of ATM',
    tone: described.tone,
    markerPct,
  }
}

/**
 * Secondary line + tone from sign/magnitude of the same primary skew (decimal).
 * Purpose-built market-state labels (not “elevated / mild put skew” prose):
 *   extreme put → Extreme Downside Skew
 *   high put    → Downside Protection Bid
 *   midrange    → Tail Risk Neutral
 *   low put     → Downside Protection Cheap
 *   inverted    → Extreme Upside Skew
 */
function describeTailSkew(value: number): {
  prose: string
  hint: string
  tone: RegimeTone
} {
  if (value >= TAIL_EXTREME_ABS) {
    return {
      prose: 'Extreme Downside Skew',
      hint: 'Put wing exceptionally rich — downside tail heavily priced',
      tone: 'red',
    }
  }
  if (value >= TAIL_HIGH_ABS) {
    return {
      prose: 'Downside Protection Bid',
      hint: 'Put demand / tail premium elevated',
      tone: 'red',
    }
  }
  if (value > -TAIL_HIGH_ABS) {
    return {
      prose: 'Tail Risk Neutral',
      hint: 'Skew near its normal range',
      tone: 'muted',
    }
  }
  if (value > -TAIL_EXTREME_ABS) {
    return {
      prose: 'Downside Protection Cheap',
      hint: 'Downside insurance relatively inexpensive',
      tone: 'green',
    }
  }
  return {
    prose: 'Extreme Upside Skew',
    hint: 'Call wing exceptionally rich — upside premium heavily priced',
    tone: 'green',
  }
}

/**
 * Long constant-maturity ATM minus the 7-day ATM.
 * Long is 180d when that tenor is published, otherwise 90d, otherwise 30d.
 * A missing leg stays blank. DVOL is not a substitute for either leg.
 */
function getTermStructureChip(surface: VolSurface | undefined): RegimeVolChipsModel['term'] {
  const front = findTenor(surface, TERM_FRONT_TENOR)
  const long = TERM_LONG_TENORS
    .map((tenor) => findTenor(surface, tenor))
    .find((row) => row != null) ?? null
  const frontVol = finiteVol(front?.atmIvPercent)
  const longVol = finiteVol(long?.atmIvPercent)
  const longTenor = long?.tenor ?? null
  const title = termStructureTitle(longTenor, longVol, frontVol)

  if (frontVol == null || longVol == null) {
    return {
      longVol,
      frontVol,
      longTenor,
      label: '—',
      detail: '—',
      tone: 'muted',
      title,
    }
  }

  const diff = longVol - frontVol
  const absDiff = Math.abs(diff)
  let shape: string
  let tone: RegimeTone
  if (absDiff < TERM_FLAT_POINTS) {
    shape = 'Flat Term Structure'
    tone = 'muted'
  } else if (diff >= TERM_STEEP_POINTS) {
    shape = 'Steep Contango'
    tone = 'blue'
  } else if (diff >= TERM_FLAT_POINTS) {
    shape = 'Contango'
    tone = 'blue'
  } else if (diff <= -TERM_STEEP_POINTS) {
    shape = 'Stressed Backwardation'
    tone = 'amber'
  } else {
    shape = 'Backwardation'
    tone = 'amber'
  }

  return {
    longVol,
    frontVol,
    longTenor,
    label: `${shape} ${formatSpreadPoints(diff)}`,
    detail: `${formatTenorTag(TERM_FRONT_TENOR)} ${formatVolPercent(frontVol)} → ${formatTenorTag(longTenor)} ${formatVolPercent(longVol)}`,
    tone,
    title,
  }
}

function termStructureTitle(
  longTenor: string | null,
  longVol: number | null,
  frontVol: number | null,
): string {
  const longLabel = longTenor ? formatTenorTag(longTenor) : 'long'
  if (longVol == null || frontVol == null) {
    return `${longLabel} constant-maturity ATM minus 7-day ATM`
  }
  return `${longLabel} ATM ${formatVolPercent(longVol)} minus 7-day ATM ${formatVolPercent(frontVol)}`
}

function formatTenorTag(tenor: string | null): string {
  if (!tenor) return 'Long'
  return tenor.toUpperCase()
}

/**
 * IV−RV chip: 30d constant-maturity ATM minus Parkinson RV30.
 */
function getIvRvSpreadChip(surface: VolSurface | undefined): RegimeVolChipsModel['spread'] {
  const title = '30-day constant-maturity ATM minus 30-day Parkinson realized vol'
  const compared = surface?.captureDueMs != null && Date.now() > surface.captureDueMs ? undefined : surface?.atmVsRv
  const atm = finiteVol(compared?.atmIvPercent)
  const rv = finiteVol(compared?.rvPercent)
  const stored = finiteOrNull(compared?.spreadPercent)
  const value = stored ?? (atm != null && rv != null ? atm - rv : null)
  if (value == null) {
    return { value: null, label: '—', detail: '—', tone: 'muted', title }
  }
  const signal = describeIvRvSignal(value)
  return {
    value,
    label: signal.label,
    detail: `${formatSpreadPoints(value)} pts`,
    tone: signal.tone,
    title,
  }
}

function findTenor(surface: VolSurface | undefined, tenor: string): VolSurfaceTenor | null {
  const row = surface?.tenors.find((item) => item.tenor === tenor)
  if (!row || row.status !== 'ok') return null
  return row
}

function tenorField(
  surface: VolSurface | undefined,
  tenor: string,
  read: (row: VolSurfaceTenor) => number | null,
): number | null {
  const row = findTenor(surface, tenor)
  return row ? finiteOrNull(read(row)) : null
}

function finiteOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return value
}

function finiteVol(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  return value
}

/**
 * Glassnode-style 25Δ skew normalized as percent of ATM IV.
 * Decimal in (e.g. 0.064) → "+6.4%" out. Same value drives marker + prose.
 */
function formatSkewNormalized(value: number): string {
  const pct = value * 100
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : ''
  return `${sign}${Math.abs(pct).toFixed(1)}%`
}

function lastFiniteValue(series: VolSeriesPoint[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i]?.value
    if (v != null && Number.isFinite(v)) return v
  }
  return null
}

function formatVolPercent(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}%`
}

function formatSpreadPoints(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${Math.abs(value).toFixed(1)}`
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Net-GEX curve — signed profile by strike (replaces heat strip).             */
/* Quiet-desk stroke + soft pos/neg area fill. Spot rides the plot.            */
/* ─────────────────────────────────────────────────────────────────────────── */

const PROFILE = {
  width: 320,
  /**
   * Curve pane (taller after polarity archive — upper stack owns vertical air):
   * Top pad (~14 for hover readout) · plot (~40) · Spot (~14) → 68
   * Domain $ labels live in padX gutters. Keep padX just wide enough for
   * `$xx,xxx` + a thin outer buffer — extra width comes from CSS bleed into
   * the rail section padding (see .regime-profile margin-inline).
   */
  height: 68,
  /**
   * Gutter for mid-plot domain labels (textAnchor end/start outside the track).
   * ~$70,000 at 7.5px mono ≈ 34px; + gap + 2px outer ≈ 38–40.
   */
  padX: 38,
  padTop: 14,
  padBottom: 14,
  /** Gap between plot edge and domain $ labels (inside the padX gutter). */
  edgeLabelGap: 3,
  /** Vertical pad inside the plot so peaks don’t clip. */
  plotInsetY: 3,
} as const

/** Samples along strike for continuous GEX curve. */
type ProfileSample = { strike: number; netGex: number; xPct: number; unit: number }

type LandscapeProfile = {
  samples: ProfileSample[]
  maxAbs: number
}

type ProfileHover = {
  xPct: number
  strike: number
  netGex: number
  unit: number
}

type CurvePoint = { x: number; y: number; unit: number }

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Map unit ∈ [-1, 1] → SVG y (positive GEX draws above zero). */
function unitToY(unit: number, zeroY: number, halfH: number): number {
  return zeroY - clamp(unit, -1, 1) * halfH
}

function buildCurvePoints(
  samples: ProfileSample[],
  plotLeft: number,
  plotWidth: number,
  zeroY: number,
  halfH: number,
): CurvePoint[] {
  return samples.map((s) => ({
    x: plotLeft + (clamp(s.xPct, 0, 100) / 100) * plotWidth,
    y: unitToY(s.unit, zeroY, halfH),
    unit: s.unit,
  }))
}

function buildLinePath(points: CurvePoint[]): string {
  if (points.length === 0) return ''
  let d = `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`
  for (let i = 1; i < points.length; i++) {
    d += `L${points[i]!.x.toFixed(2)},${points[i]!.y.toFixed(2)}`
  }
  return d
}

/**
 * Signed geometry closed to the zero line.
 * Zero-crossings are interpolated so pos/neg bands meet cleanly.
 * Also builds separate stroke segments so pos/neg stay distinct.
 */
function buildSignedPaths(
  points: CurvePoint[],
  zeroY: number,
): { posArea: string; negArea: string; posLine: string; negLine: string } {
  if (points.length === 0) {
    return { posArea: '', negArea: '', posLine: '', negLine: '' }
  }

  const posAreaParts: string[] = []
  const negAreaParts: string[] = []
  const posLineParts: string[] = []
  const negLineParts: string[] = []

  let run: CurvePoint[] = []
  let runSign = 0 // +1 pos, -1 neg, 0 flat

  const flush = () => {
    if (run.length === 0 || runSign === 0) {
      run = []
      runSign = 0
      return
    }
    // Curve stroke for this run (skip pure zero anchors at ends for cleaner line)
    const strokePts = run.filter((p, i) => {
      if (i === 0 || i === run.length - 1) return Math.abs(p.unit) > 1e-9 || run.length === 1
      return true
    })
    // Always include endpoints for continuity through zero crossings
    const linePts = run.length >= 2 ? run : strokePts
    if (linePts.length >= 2) {
      let line = `M${linePts[0]!.x.toFixed(2)},${linePts[0]!.y.toFixed(2)}`
      for (let i = 1; i < linePts.length; i++) {
        line += `L${linePts[i]!.x.toFixed(2)},${linePts[i]!.y.toFixed(2)}`
      }
      if (runSign > 0) posLineParts.push(line)
      else negLineParts.push(line)
    }

    const first = run[0]!
    const last = run[run.length - 1]!
    let area = `M${first.x.toFixed(2)},${zeroY.toFixed(2)}`
    for (const p of run) {
      area += `L${p.x.toFixed(2)},${p.y.toFixed(2)}`
    }
    area += `L${last.x.toFixed(2)},${zeroY.toFixed(2)}Z`
    if (runSign > 0) posAreaParts.push(area)
    else negAreaParts.push(area)
    run = []
    runSign = 0
  }

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const sign = p.unit > 1e-6 ? 1 : p.unit < -1e-6 ? -1 : 0

    if (sign === 0) {
      if (run.length > 0) {
        run.push({ x: p.x, y: zeroY, unit: 0 })
        flush()
      }
      continue
    }

    if (runSign === 0) {
      runSign = sign
      run = [{ x: p.x, y: zeroY, unit: 0 }, p]
      continue
    }

    if (sign === runSign) {
      run.push(p)
      continue
    }

    const prev = points[i - 1]!
    const t = Math.abs(prev.unit) / (Math.abs(prev.unit) + Math.abs(p.unit))
    const crossX = lerp(prev.x, p.x, t)
    run.push({ x: crossX, y: zeroY, unit: 0 })
    flush()
    runSign = sign
    run = [{ x: crossX, y: zeroY, unit: 0 }, p]
  }
  flush()

  return {
    posArea: posAreaParts.join(''),
    negArea: negAreaParts.join(''),
    posLine: posLineParts.join(''),
    negLine: negLineParts.join(''),
  }
}

/** Archived renderer retained for future diagnostics; no longer mounted in Regime. */
export function NetGexProfile({
  profile,
  leftBound,
  rightBound,
  spotPosition,
  spot,
}: {
  profile: LandscapeProfile
  leftBound: number
  rightBound: number
  spotPosition: number
  spot: number
}) {
  const uid = useId().replace(/:/g, '')
  const wellRef = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<ProfileHover | null>(null)

  const plotLeft = PROFILE.padX
  const plotRight = PROFILE.width - PROFILE.padX
  const plotWidth = plotRight - plotLeft
  const plotTop = PROFILE.padTop
  const plotBottom = PROFILE.height - PROFILE.padBottom
  const plotH = plotBottom - plotTop
  const zeroY = plotTop + plotH / 2
  const halfH = Math.max(1, plotH / 2 - PROFILE.plotInsetY)
  const midY = zeroY

  const curve = useMemo(() => {
    const points = buildCurvePoints(profile.samples, plotLeft, plotWidth, zeroY, halfH)
    const signed = buildSignedPaths(points, zeroY)
    return {
      points,
      line: buildLinePath(points),
      posArea: signed.posArea,
      negArea: signed.negArea,
      posLine: signed.posLine,
      negLine: signed.negLine,
    }
  }, [profile.samples, plotLeft, plotWidth, zeroY, halfH])

  const spotLeft = clamp(spotPosition, 0, 100)
  const spotSvgX = plotLeft + (spotLeft / 100) * plotWidth
  const spotLabelX = pinLabelX(spotSvgX, plotLeft, plotRight, 12)

  const empty = profile.samples.length === 0 || curve.points.length === 0
  const hovering = hover != null

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (empty || profile.samples.length === 0) return
      const el = wellRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (!(rect.width > 0)) return
      const padFrac = PROFILE.padX / PROFILE.width
      const localX = (event.clientX - rect.left) / rect.width
      const xPct = clamp(((localX - padFrac) / (1 - 2 * padFrac)) * 100, 0, 100)
      const sample = nearestProfileSample(profile.samples, xPct)
      if (!sample) return
      setHover({
        xPct: sample.xPct,
        strike: sample.strike,
        netGex: sample.netGex,
        unit: sample.unit,
      })
    },
    [empty, profile.samples],
  )

  const onPointerLeave = useCallback(() => {
    setHover(null)
  }, [])

  const hoverSvgX =
    hover != null ? plotLeft + (hover.xPct / 100) * plotWidth : null
  const hoverSvgY =
    hover != null ? unitToY(hover.unit, zeroY, halfH) : null
  const hoverLabelX =
    hoverSvgX != null ? clamp(hoverSvgX, plotLeft + 44, plotRight - 44) : null
  const hoverLabelAnchor: 'start' | 'middle' | 'end' =
    hoverSvgX != null && hoverSvgX < plotLeft + 52
      ? 'start'
      : hoverSvgX != null && hoverSvgX > plotRight - 52
        ? 'end'
        : 'middle'

  return (
    <div
      ref={wellRef}
      className="regime-profile regime-profile__well relative shrink-0 select-none"
      aria-hidden={empty}
      onPointerMove={empty ? undefined : onPointerMove}
      onPointerLeave={empty ? undefined : onPointerLeave}
    >
      <svg
        viewBox={`0 0 ${PROFILE.width} ${PROFILE.height}`}
        className="regime-profile__svg block h-full w-full"
        role="img"
        aria-label={
          empty
            ? 'Net GEX curve unavailable'
            : `Net GEX curve from ${formatStrike(leftBound)} to ${formatStrike(rightBound)}; spot ${formatStrike(spot)}`
        }
      >
        <defs>
          {/* Stronger pos/neg fills — clear polarity without going neon */}
          <linearGradient
            id={`regime-curve-pos-fill-${uid}`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor="var(--terminal-green-strong)" stopOpacity="0.42" />
            <stop offset="55%" stopColor="var(--terminal-green)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--terminal-green)" stopOpacity="0.05" />
          </linearGradient>
          <linearGradient
            id={`regime-curve-neg-fill-${uid}`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor="var(--terminal-red)" stopOpacity="0.05" />
            <stop offset="45%" stopColor="var(--terminal-red)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--terminal-red-strong)" stopOpacity="0.4" />
          </linearGradient>
          <filter
            id={`regime-curve-glow-pos-${uid}`}
            x="-10%"
            y="-50%"
            width="120%"
            height="200%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.15" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter
            id={`regime-curve-glow-neg-${uid}`}
            x="-10%"
            y="-50%"
            width="120%"
            height="200%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.15" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id={`regime-curve-clip-${uid}`}>
            <rect
              x={plotLeft}
              y={plotTop}
              width={plotWidth}
              height={plotH}
            />
          </clipPath>
        </defs>

        {/* Plot well */}
        <rect
          className="regime-profile__track"
          x={plotLeft}
          y={plotTop}
          width={plotWidth}
          height={plotH}
          rx={2}
          ry={2}
          fill="transparent"
        />

        {!empty ? (
          <g clipPath={`url(#regime-curve-clip-${uid})`}>
            {/* Zero spine */}
            <line
              x1={plotLeft}
              x2={plotRight}
              y1={zeroY}
              y2={zeroY}
              stroke="color-mix(in srgb, var(--terminal-heading) 18%, transparent)"
              strokeWidth={0.9}
              strokeDasharray="2.5 2.5"
            />

            {/* Area under curve — pos green / neg red */}
            {curve.posArea ? (
              <path
                d={curve.posArea}
                fill={`url(#regime-curve-pos-fill-${uid})`}
                stroke="none"
              />
            ) : null}
            {curve.negArea ? (
              <path
                d={curve.negArea}
                fill={`url(#regime-curve-neg-fill-${uid})`}
                stroke="none"
              />
            ) : null}

            {/* Soft glow under each polarity stroke */}
            {curve.posLine ? (
              <path
                d={curve.posLine}
                fill="none"
                stroke="var(--terminal-green-strong)"
                strokeWidth={3.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.2}
                filter={`url(#regime-curve-glow-pos-${uid})`}
              />
            ) : null}
            {curve.negLine ? (
              <path
                d={curve.negLine}
                fill="none"
                stroke="var(--terminal-red-strong)"
                strokeWidth={3.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.2}
                filter={`url(#regime-curve-glow-neg-${uid})`}
              />
            ) : null}

            {/* Primary stroke — separate pos/neg colors (no muddy mid blend) */}
            {curve.posLine ? (
              <path
                className="regime-profile__curve regime-profile__curve--pos"
                d={curve.posLine}
                fill="none"
                stroke="var(--terminal-green-strong)"
                strokeWidth={1.55}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.95}
              />
            ) : null}
            {curve.negLine ? (
              <path
                className="regime-profile__curve regime-profile__curve--neg"
                d={curve.negLine}
                fill="none"
                stroke="var(--terminal-red-strong)"
                strokeWidth={1.55}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.95}
              />
            ) : null}
          </g>
        ) : null}

        {/* Spot — heading line + bottom pointer + label */}
        <g
          className={cn(
            'regime-profile__marker regime-profile__marker--spot',
            hovering && 'regime-profile__marker--dim',
          )}
        >
          <line
            x1={spotSvgX}
            x2={spotSvgX}
            y1={plotTop}
            y2={plotBottom}
            stroke="var(--desk-value, var(--terminal-heading))"
            strokeWidth={1.1}
            strokeLinecap="butt"
            opacity={0.72}
          />
          <polygon
            points={pointerUp(spotSvgX, plotBottom, 2.4)}
            fill="var(--desk-value, var(--terminal-heading))"
            opacity={0.85}
          />
          <text
            x={spotLabelX}
            y={plotBottom + 8.2}
            textAnchor="middle"
            fill="var(--desk-value, var(--terminal-heading))"
            fontSize={7.25}
            fontWeight={600}
            letterSpacing="0.06em"
            opacity={0.88}
          >
            Spot
          </text>
        </g>

        {/* Domain high/low — mid-plot, outside the track gutters */}
        <text
          className={cn(
            'regime-profile__edge regime-profile__edge--low',
            hovering && 'regime-profile__edge--dim',
          )}
          x={plotLeft - PROFILE.edgeLabelGap}
          y={midY}
          textAnchor="end"
          dominantBaseline="central"
          fill="var(--desk-label, var(--terminal-subtle))"
          fontSize={7.5}
          fontWeight={500}
          letterSpacing="0.01em"
          style={{ fontVariantNumeric: 'tabular-nums' }}
          opacity={0.88}
        >
          ${formatStrike(leftBound)}
        </text>
        <text
          className={cn(
            'regime-profile__edge regime-profile__edge--high',
            hovering && 'regime-profile__edge--dim',
          )}
          x={plotRight + PROFILE.edgeLabelGap}
          y={midY}
          textAnchor="start"
          dominantBaseline="central"
          fill="var(--desk-label, var(--terminal-subtle))"
          fontSize={7.5}
          fontWeight={500}
          letterSpacing="0.01em"
          style={{ fontVariantNumeric: 'tabular-nums' }}
          opacity={0.88}
        >
          ${formatStrike(rightBound)}
        </text>

        {/* Hover probe — hairline + bead on curve + readout */}
        {hover != null && hoverSvgX != null && hoverSvgY != null && hoverLabelX != null ? (
          <g className="regime-profile__hover" aria-hidden>
            <line
              x1={hoverSvgX}
              x2={hoverSvgX}
              y1={plotTop}
              y2={plotBottom}
              stroke="var(--desk-value, var(--terminal-heading))"
              strokeWidth={0.95}
              opacity={0.55}
            />
            <circle
              cx={hoverSvgX}
              cy={hoverSvgY}
              r={2.35}
              fill={hover.unit >= 0 ? 'var(--terminal-green-strong)' : 'var(--terminal-red-strong)'}
              stroke="var(--desk-value, var(--terminal-heading))"
              strokeWidth={0.85}
            />
            <text
              x={hoverLabelX}
              y={plotTop - 3.6}
              textAnchor={hoverLabelAnchor}
              fill="var(--desk-value, var(--terminal-heading))"
              fontSize={7.25}
              fontWeight={600}
              letterSpacing="0.02em"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {`$${formatStrike(hover.strike)} · ${formatSignedCompactUsd(hover.netGex)}`}
            </text>
          </g>
        ) : null}
      </svg>
    </div>
  )
}

function nearestProfileSample(
  samples: ProfileSample[],
  xPct: number,
): ProfileSample | null {
  if (samples.length === 0) return null
  let best = samples[0]!
  let bestDist = Math.abs(best.xPct - xPct)
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!
    const d = Math.abs(s.xPct - xPct)
    if (d < bestDist) {
      best = s
      bestDist = d
    }
  }
  return best
}

function pinLabelX(
  markerSvgX: number,
  plotLeft: number,
  plotRight: number,
  halfWidth = 11,
): number {
  return clamp(markerSvgX, plotLeft + halfWidth, plotRight - halfWidth)
}

/** Compact upward triangle on the track’s bottom edge (Spot). */
function pointerUp(cx: number, tipY: number, half = 2.4): string {
  return `${cx},${tipY} ${cx - half},${tipY + half} ${cx + half},${tipY + half}`
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Metrics strip / scoring (presentation data only)                            */
/* ─────────────────────────────────────────────────────────────────────────── */

type RegimeTone =
  | 'green'
  | 'red'
  | 'amber'
  | 'muted'
  | 'heading'
  | 'blue'
  | 'deepBlue'
  | 'violet'

const DEALER_GAMMA_STRONG = 0.35
const DEALER_GAMMA_MILD = 0.12

function getRegimeContext(gammaSnapshot: TerminalSnapshot | null) {
  if (!gammaSnapshot) {
    return {
      dealerGammaScore: null as number | null,
      dealerGammaLabel: '—',
      dealerGammaTone: 'muted' as RegimeTone,
    }
  }

  const netGexUsd = gammaSnapshot.totalNetGexUsd
  const dealerGammaScore = getDealerGammaScore(gammaSnapshot, netGexUsd)
  return {
    dealerGammaScore,
    dealerGammaLabel: getDealerGammaLabel(dealerGammaScore),
    dealerGammaTone: getDealerGammaTone(dealerGammaScore),
  }
}

/** Score ∈ [-1, 1] = netGex / Σ|netGex| — unchanged. */
function getDealerGammaScore(snapshot: TerminalSnapshot, netGexUsd: number) {
  const totalAbsGexUsd = snapshot.gammaBars.reduce((total, row) => {
    const value = row.gammaExposureUsd
    return total + (Number.isFinite(value) ? Math.abs(value) : 0)
  }, 0)

  if (!(totalAbsGexUsd > 0) || !Number.isFinite(netGexUsd)) {
    return 0
  }

  return clamp(netGexUsd / totalAbsGexUsd, -1, 1)
}

/**
 * Net-GEX polarity headline — purpose-built SHORT GAMMA ↔ LONG GAMMA pair.
 * Magnitude modifiers only at the extremes (Unstable / Pinned); mid = bare pair.
 */
function getDealerGammaLabel(score: number): string {
  if (score > DEALER_GAMMA_STRONG) return 'Long Gamma — Pinned'
  if (score >= DEALER_GAMMA_MILD) return 'Long Gamma'
  if (score > -DEALER_GAMMA_MILD) return 'Gamma Neutral'
  if (score >= -DEALER_GAMMA_STRONG) return 'Short Gamma'
  return 'Short Gamma — Unstable'
}

function getDealerGammaTone(score: number): RegimeTone {
  if (score > DEALER_GAMMA_MILD) return 'green'
  if (score < -DEALER_GAMMA_MILD) return 'red'
  return 'amber'
}

function getDealerGammaBehavior(score: number): string {
  if (score > DEALER_GAMMA_MILD) return 'Stabilizing'
  if (score < -DEALER_GAMMA_MILD) return 'Amplifying'
  return 'Balanced'
}

function getRegimeToneClassName(tone: RegimeTone) {
  return {
    // Full-strength polarity for Net GEX / short-long reads
    green: 'text-[var(--terminal-green-strong)]',
    red: 'text-[var(--terminal-red-strong)]',
    amber: 'text-[var(--terminal-yellow)]',
    muted: 'text-[var(--terminal-muted)]',
    heading: 'text-[var(--terminal-heading)]',
    // Cool non-GEX accent (RV contracting / DVOL COMPRESSED)
    blue: 'text-[var(--regime-accent-blue,var(--terminal-blue))]',
    // Deeper blue for DVOL FLOOR (lower historical tail)
    deepBlue: 'text-[var(--regime-accent-deep-blue)]',
    violet: 'text-[var(--regime-accent-violet)]',
  }[tone]
}

function formatRegimeScore(score: number) {
  return `${score >= 0 ? '+' : ''}${score.toFixed(2)}`
}

function formatSignedCompactUsd(value: number) {
  const sign = value >= 0 ? '+' : '-'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) {
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`
  }
  if (abs >= 1_000_000) {
    return `${sign}$${Math.round(abs / 1_000_000)}M`
  }
  if (abs >= 1_000) {
    return `${sign}$${Math.round(abs / 1_000)}K`
  }
  return `${sign}$${Math.round(abs)}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
