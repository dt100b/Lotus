import {
  memo,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  getDisplaySpot,
  type GammaBar,
  type Skew25d,
  type TerminalSnapshot,
  type VolCompare,
  type VolSeriesPoint,
} from '@/data/mockTerminal'
import { formatStrike } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import { VolCompareChart } from '@/components/terminal/VolCompareChart'

/**
 * Regime desk — structural polarity on the ALL book.
 *
 * Hierarchy: Dealer Γ headline → continuous net-GEX profile
 * → dense metrics strip (Net GEX / RV / Context)
 * → display-only vol chips (Tail risk / Term structure / IV−RV)
 * → IV vs RV chart (pinned near workspace bottom-row height).
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
}: {
  bookSnapshot: TerminalSnapshot
}) {
  const context = useMemo(() => getRegimeContext(bookSnapshot), [bookSnapshot])
  const volChips = useMemo(() => getRegimeVolChips(bookSnapshot), [bookSnapshot])

  const netGexUsd = bookSnapshot.bookStats?.netGexUsd ?? bookSnapshot.totalNetGexUsd
  const netTone: RegimeTone = netGexUsd > 0 ? 'green' : netGexUsd < 0 ? 'red' : 'muted'
  const dealerToneClassName = getRegimeToneClassName(context.dealerGammaTone)

  return (
    <section
      className="regime-panel mt-1 flex min-h-0 flex-1 flex-col overflow-hidden border-t pt-1.5 pb-1.5"
      aria-label="Regime"
    >
      {/* Upper stack flexes; chart below is height-capped to ~workspace bottom row */}
      <div className="regime-panel__upper">
        {/* ── Header ── */}
        <div className="regime-panel__header flex shrink-0 items-center justify-between gap-2">
          <span className="regime-panel__title">Regime</span>
          <span className="regime-panel__scope">ALL</span>
        </div>

        {/* ── Dealer Γ headline + score number ── */}
        <div className="regime-panel__headline-row grid shrink-0 grid-cols-[1fr_auto] items-end gap-2">
          <div className="min-w-0">
            <div className={cn('regime-panel__headline', dealerToneClassName)}>
              {context.dealerGammaLabel}
            </div>
          </div>
          <div className={cn('regime-panel__score text-right', dealerToneClassName)}>
            {formatRegimeScore(context.dealerGammaScore)}
          </div>
        </div>

        {/* ── Continuous net-GEX profile (live GEX surface) ── */}
        <NetGexProfile
          profile={context.profile}
          leftBound={context.leftBound}
          rightBound={context.rightBound}
          spotPosition={context.spotPosition}
          spot={context.spot}
        />

        {/* ── Dense secondary metrics strip ── */}
        <div
          className="regime-metrics shrink-0 grid grid-cols-3 gap-0 border-t border-[var(--desk-rule)]"
          role="group"
          aria-label="Regime metrics"
        >
          <CompactMetric
            label="Net GEX"
            value={formatSignedCompactUsd(netGexUsd)}
            tone={netTone}
            edge
          />
          <CompactMetric
            label="RV"
            value={context.rvTrendLabel}
            detail={context.rvTrendDetail}
            tone={context.rvTrendTone}
            edge
          />
          <CompactMetric
            label="Context"
            value={context.regimeReadLabel}
            tone={context.regimeReadTone}
          />
        </div>

        {/* ── Display-only vol chips (not in regime score) ── */}
        <RegimeVolChips chips={volChips} />
      </div>

      {/* ── IV vs RV — height pinned to ~default workspace bottom row (38%) ── */}
      <VolCompareZone
        volCompare={bookSnapshot.flowRegime?.volCompare ?? bookSnapshot.volCompare}
      />
    </section>
  )
})

/* ─────────────────────────────────────────────────────────────────────────── */
/* Display-only vol chips (Tail / Term / IV−RV) — never enter score math       */
/* ─────────────────────────────────────────────────────────────────────────── */

const EMPTY_VOL_SERIES: VolSeriesPoint[] = []

/**
 * Tail risk (skew) display bands — single source for number, marker, and prose.
 * Stored value is dimensionless normalized skew (decimal); display is Glassnode-style
 * percent: e.g. 0.064 → +6.4%. Marker domain: fixed [−20%, +20%] ≡ [−0.20, +0.20].
 *
 * Cutover thresholds (unchanged); secondary-line copy only:
 * |s| < 4%            → Muted
 * put  4%–10%         → Mild put
 * put 10%–18%         → Elevated put
 * put ≥ 18%           → Heavy put
 * call 4%–10%         → Mild call
 * call ≥ 10%          → Elevated call
 */
const TAIL_MUTED_ABS = 0.04
const TAIL_HIGH_ABS = 0.10
const TAIL_EXTREME_ABS = 0.18
/** Marker scale domain half-width (fixed; ±20% on the percent scale). */
const TAIL_SCALE_ABS = 0.20

/**
 * Term structure: |long − front| vol pts under this → Flat.
 * Long = DVOL (fallback 1m ATM); front = nearest-expiry ATM (not ~7d).
 */
const TERM_FLAT_POINTS = 1.0

/**
 * Absolute DVOL (fallback front) vol-regime buckets — display only.
 *   Very calm  < 30
 *   Calm       [30, 40)
 *   Normal     [40, 55)
 *   Elevated   [55, 75)
 *   Stressed   ≥ 75
 */
const VOL_REGIME_VERY_CALM = 30
const VOL_REGIME_CALM = 40
const VOL_REGIME_NORMAL = 55
const VOL_REGIME_ELEVATED = 75

/** IV−RV spread points: outside ±this → rich/cheap. */
const IV_RV_NEUTRAL_POINTS = 2.0

type PrimarySkew = {
  /** Normalized 25Δ skew from levels only (never series). */
  value: number
  /** Tenor that supplied the value: 1m | 1w | 3m */
  tenor: '1m' | '1w' | '3m'
}

type RegimeVolChipsModel = {
  tail: {
    /** Same skew value drives number, marker, and prose. */
    value: number | null
    tenor: '1m' | '1w' | '3m' | null
    prose: string
    tone: RegimeTone
    markerPct: number
  }
  term: {
    longVol: number | null
    frontVol: number | null
    label: string
    detail: string
    /** Absolute vol-regime secondary line (from DVOL, fallback front). */
    regime: string
    tone: RegimeTone
  }
  spread: {
    value: number | null
    label: string
    detail: string
    tone: RegimeTone
  }
}

function RegimeVolChips({ chips }: { chips: RegimeVolChipsModel }) {
  // Numeric readout is skew only — no tenor suffix (1m/1w/3m).
  const tailReadout =
    chips.tail.value == null ? '—' : formatSkewNormalized(chips.tail.value)

  return (
    <div
      className="regime-vol-chips shrink-0 border-t border-[var(--desk-rule)]"
      role="group"
      aria-label="Vol context chips display only"
    >
      {/* Tail risk (skew) — 25Δ normalized; display only */}
      <div className="regime-vol-chip regime-vol-chip--tail">
        <div className="regime-vol-chip__head">
          <span className="regime-vol-chip__label">Tail risk (skew)</span>
          <span
            className={cn(
              'regime-vol-chip__value regime-vol-chip__value--compact',
              getRegimeToneClassName(chips.tail.tone),
            )}
            title={
              chips.tail.value == null
                ? undefined
                : `Primary skew${chips.tail.tenor ? ` (${chips.tail.tenor})` : ''} · levels only`
            }
          >
            {tailReadout}
          </span>
        </div>
        <div className="regime-vol-chip__body regime-vol-chip__body--scale">
          <div
            className="regime-vol-chip__scale"
            role="img"
            aria-label={
              chips.tail.value == null
                ? 'Skew scale unavailable'
                : `Tail risk skew ${formatSkewNormalized(chips.tail.value)} on low to high scale`
            }
          >
            <span className="regime-vol-chip__scale-end">Low</span>
            <div className="regime-vol-chip__track">
              <div className="regime-vol-chip__track-mid" aria-hidden />
              {chips.tail.value != null ? (
                <div
                  className={cn(
                    'regime-vol-chip__marker',
                    getRegimeToneClassName(chips.tail.tone),
                  )}
                  style={{ left: `${chips.tail.markerPct}%` }}
                />
              ) : null}
            </div>
            <span className="regime-vol-chip__scale-end">High</span>
          </div>
        </div>
        <div
          className={cn(
            'regime-vol-chip__prose regime-vol-chip__prose--under-scale',
            getRegimeToneClassName(chips.tail.tone),
          )}
        >
          {chips.tail.prose}
        </div>
      </div>

      {/* Term structure — DVOL (or 1m ATM) vs nearest-expiry front ATM */}
      <div className="regime-vol-chip regime-vol-chip--term">
        {/*
          Two-column desk: left = label + detail, right = Contango / Calm stack.
          Keeps secondary vol-regime on the same status rail (not a free row).
        */}
        <div className="regime-vol-chip__term">
          <span className="regime-vol-chip__label">Term structure</span>
          <span className={cn('regime-vol-chip__flag', getRegimeToneClassName(chips.term.tone))}>
            {chips.term.label}
          </span>
          <span className="regime-vol-chip__value">{chips.term.detail}</span>
          <span className="regime-vol-chip__status-secondary regime-vol-chip__prose--muted">
            {chips.term.regime}
          </span>
        </div>
      </div>

      {/* IV−RV spread from vol_compare — flag colors match chart baseline palette */}
      <div className="regime-vol-chip">
        <div className="regime-vol-chip__head">
          <span className="regime-vol-chip__label">IV−RV</span>
          <span
            className={cn(
              'regime-vol-chip__flag',
              chips.spread.tone === 'blue' && 'regime-vol-chip__flag--iv-rich',
              chips.spread.tone === 'amber' && 'regime-vol-chip__flag--iv-cheap',
              chips.spread.tone === 'muted' && getRegimeToneClassName('muted'),
            )}
          >
            {chips.spread.label}
          </span>
        </div>
        <div className="regime-vol-chip__body">
          <span className="regime-vol-chip__value">{chips.spread.detail}</span>
        </div>
      </div>
    </div>
  )
}

function getRegimeVolChips(bookSnapshot: TerminalSnapshot): RegimeVolChipsModel {
  const skew = bookSnapshot.flowRegime?.skew25d
  const volCompare = bookSnapshot.flowRegime?.volCompare ?? bookSnapshot.volCompare
  const dvol =
    bookSnapshot.bookStats?.dvol
    ?? lastFiniteValue(volCompare?.dvolSeries ?? EMPTY_VOL_SERIES)

  return {
    tail: getTailRiskChip(skew),
    term: getTermStructureChip(skew, dvol),
    spread: getIvRvSpreadChip(volCompare),
  }
}

/**
 * Tail risk chip from a **single** primary 25Δ skew resolution.
 * Number, marker position, and prose all use the same skew value.
 * Readout shows skew only (no tenor suffix). Tenor kept for tooltip/source.
 * Source: levels only, order 1m → 1w → 3m (never series — avoids divergent paths).
 */
function getTailRiskChip(skew: Skew25d | undefined): RegimeVolChipsModel['tail'] {
  const primary = resolvePrimarySkew(skew)
  if (primary == null) {
    return {
      value: null,
      tenor: null,
      prose: '—',
      tone: 'muted',
      markerPct: 50,
    }
  }

  const { value, tenor } = primary
  const { prose, tone } = describeTailSkew(value)
  // Map fixed domain [−TAIL_SCALE_ABS, +TAIL_SCALE_ABS] → 0..100 (Low→High).
  // Soft edge inset is display-only (marker radius); same value as numeric readout.
  const markerPct = clamp(((value / TAIL_SCALE_ABS) + 1) * 50, 4, 96)
  return { value, tenor, prose, tone, markerPct }
}

/**
 * Secondary line + tone from sign/magnitude of the same primary skew (decimal).
 * Thresholds unchanged — copy bands only (Mild / Elevated / Heavy put|call).
 */
function describeTailSkew(value: number): { prose: string; tone: RegimeTone } {
  const abs = Math.abs(value)
  if (abs < TAIL_MUTED_ABS) {
    return {
      prose: 'Balanced skew (puts and calls similar)',
      tone: 'muted',
    }
  }
  if (value > 0) {
    // Put skew (positive normalized) → mild / elevated / heavy
    if (abs >= TAIL_EXTREME_ABS) {
      return {
        prose: 'Heavy put skew (downside premium rich)',
        tone: 'red',
      }
    }
    if (abs >= TAIL_HIGH_ABS) {
      return {
        prose: 'Elevated put skew (downside premium bid)',
        tone: 'red',
      }
    }
    return {
      prose: 'Mild put skew (modest downside premium)',
      tone: 'red',
    }
  }
  // Call skew (negative): mild 4%–10%, elevated ≥ 10%
  if (abs >= TAIL_HIGH_ABS) {
    return {
      prose: 'Elevated call skew (upside premium bid)',
      tone: 'green',
    }
  }
  return {
    prose: 'Mild call skew (modest upside premium)',
    tone: 'green',
  }
}

/**
 * Term structure ≈ VIX/VIX1D: DVOL (or 1m ATM) vs nearest-listed-expiry front ATM.
 *
 * Detail string (when both legs present):
 *   `{longTag} {long}% / Front ({dte}d) {front}%`
 *   e.g. DVOL 38.2% / Front (2d) 36.4%
 * Flag: Contango | Flat | Backwardation. Secondary: Calm…Stressed.
 *
 * Fallbacks (display only):
 * 1. long = DVOL if available, else 1m ATM IV from chain
 * 2. front = skew.frontAtm (nearest expiry DTE ≥ MIN_DTE), not closest-to-7d
 * 3. if front missing → show long only, label "—" (cannot classify shape)
 * 4. if both missing → "—"
 * Shape: long − front in vol points; |diff| < 1.0 → Flat.
 * Secondary: absolute vol regime from DVOL (fallback front).
 */
function getTermStructureChip(
  skew: Skew25d | undefined,
  dvol: number | null | undefined,
): RegimeVolChipsModel['term'] {
  const atm = skew?.atmIvPercent
  const frontAtm = skew?.frontAtm
  // Prefer explicit nearest-expiry front; fall back to 1w only if front missing
  // (legacy payloads before front field existed).
  const frontVol =
    finiteVol(frontAtm?.atmIvPercent ?? null)
    ?? finiteVol(atm?.['1w'] ?? null)
  const frontDte = frontAtm?.dteDays ?? null
  const longFromDvol = finiteVol(dvol ?? null)
  const longFrom1m = finiteVol(atm?.['1m'] ?? null)
  const longVol = longFromDvol ?? longFrom1m
  const longSource = longFromDvol != null ? 'DVOL' : longFrom1m != null ? '1M ATM' : null

  const regimeVol = longFromDvol ?? frontVol
  const regime = describeVolRegime(regimeVol)

  if (longVol == null && frontVol == null) {
    return {
      longVol: null,
      frontVol: null,
      label: '—',
      detail: '—',
      regime,
      tone: 'muted',
    }
  }

  const frontTag = formatFrontLegTag(frontVol, frontDte, frontAtm?.status)

  if (frontVol == null) {
    return {
      longVol,
      frontVol: null,
      label: '—',
      detail: longVol != null && longSource
        ? `${longSource} ${formatVolPercent(longVol)} / Front n/a`
        : '—',
      regime,
      tone: 'muted',
    }
  }

  if (longVol == null) {
    return {
      longVol: null,
      frontVol,
      label: '—',
      detail: `${frontTag} · long n/a`,
      regime,
      tone: 'muted',
    }
  }

  const diff = longVol - frontVol
  let label: string
  let tone: RegimeTone
  if (Math.abs(diff) < TERM_FLAT_POINTS) {
    label = 'Flat'
    tone = 'muted'
  } else if (diff > 0) {
    label = 'Contango'
    tone = 'blue'
  } else {
    label = 'Backwardation'
    tone = 'amber'
  }

  // Detail: "DVOL 38.2% / Front (2d) 36.4%" (or 1M ATM fallback for long).
  const longTag = longSource === 'DVOL' ? 'DVOL' : '1M ATM'
  return {
    longVol,
    frontVol,
    label,
    detail: `${longTag} ${formatVolPercent(longVol)} / ${frontTag}`,
    regime,
    tone,
  }
}

/**
 * Front leg display tag. Prefer "Front ({dte}d) {vol}%" when dte is known.
 * Example: Front (2d) 36.4%
 */
function formatFrontLegTag(
  frontVol: number | null,
  dteDays: number | null,
  status: string | null | undefined,
): string {
  if (frontVol == null) return 'Front n/a'
  const vol = formatVolPercent(frontVol)
  if (dteDays != null && Number.isFinite(dteDays) && dteDays >= 0) {
    return `Front (${formatFrontDteLabel(dteDays)}) ${vol}`
  }
  if (status && status !== 'ok') return `Front ${vol}`
  return `Front ${vol}`
}

/**
 * Compact DTE from front.dte_days (display only — does not change selection math).
 *
 * Rule:
 * - dte &lt; 1 day → one decimal (e.g. 0.9d) so sub-day front stays legible
 * - dte ≥ 1 day  → nearest whole day (e.g. 1d, 2d, 14d) — avoids "2.0d" noise
 */
function formatFrontDteLabel(dteDays: number): string {
  if (dteDays < 1) return `${dteDays.toFixed(1)}d`
  return `${Math.round(dteDays)}d`
}

/**
 * Absolute vol regime from DVOL (fallback front ATM). Display only.
 * Buckets: Very calm &lt;30 · Calm [30,40) · Normal [40,55) · Elevated [55,75) · Stressed ≥75.
 */
function describeVolRegime(volPercent: number | null): string {
  if (volPercent == null || !Number.isFinite(volPercent) || volPercent <= 0) {
    return 'Vol regime —'
  }
  if (volPercent < VOL_REGIME_VERY_CALM) return 'Very calm'
  if (volPercent < VOL_REGIME_CALM) return 'Calm'
  if (volPercent < VOL_REGIME_NORMAL) return 'Normal'
  if (volPercent < VOL_REGIME_ELEVATED) return 'Elevated'
  return 'Stressed'
}

/**
 * IV−RV spread points from vol_compare (DVOL − RV). Display only.
 * Flag colors match the IV vs RV chart baseline palette:
 *   positive spread (IV rich)  → chart spreadPos blue
 *   negative spread (IV cheap) → chart spreadNeg amber/brown
 */
function getIvRvSpreadChip(volCompare: VolCompare | undefined): RegimeVolChipsModel['spread'] {
  const value = lastFiniteValue(volCompare?.spreadSeries ?? EMPTY_VOL_SERIES)
  if (value == null) {
    return { value: null, label: '—', detail: '—', tone: 'muted' }
  }

  let label: string
  let tone: RegimeTone
  if (value > IV_RV_NEUTRAL_POINTS) {
    label = 'IV rich'
    tone = 'blue'
  } else if (value < -IV_RV_NEUTRAL_POINTS) {
    label = 'IV cheap'
    tone = 'amber'
  } else {
    label = 'Neutral'
    tone = 'muted'
  }

  return {
    value,
    label,
    detail: `${formatSpreadPoints(value)} pts`,
    tone,
  }
}

/**
 * Resolve primary skew for Tail chip from **levels only**.
 * Order: 1m → 1w → 3m (aligned with backend primary_tenor_preference).
 * Does **not** fall back to series history — that was a divergent path that could
 * disagree with live levels (e.g. stale series vs fresh 1m).
 */
function resolvePrimarySkew(skew: Skew25d | undefined): PrimarySkew | null {
  if (!skew?.levels) return null
  const order: Array<'1m' | '1w' | '3m'> = ['1m', '1w', '3m']
  // Prefer declared primary tenor when it is one of the level keys and finite.
  const preferred = skew.primaryTenor
  if (preferred === '1w' || preferred === '1m' || preferred === '3m') {
    const v = finiteOrNull(skew.levels[preferred])
    if (v != null) return { value: v, tenor: preferred }
  }
  for (const key of order) {
    const v = finiteOrNull(skew.levels[key])
    if (v != null) return { value: v, tenor: key }
  }
  return null
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

/* ─────────────────────────────────────────────────────────────────────────── */
/* IV vs RV dual-pane (Lightweight Charts v5)                                  */
/* 25Δ skew is chip-only above. Chart height pinned ≈ workspace bottom row.    */
/* Structure/NY Session polarity: archived/RegimePolarityBlock.tsx             */
/* ─────────────────────────────────────────────────────────────────────────── */

function VolCompareZone({ volCompare }: { volCompare: VolCompare | undefined }) {
  const dvolSeries = volCompare?.dvolSeries ?? EMPTY_VOL_SERIES
  const rvSeries = volCompare?.rvSeries ?? EMPTY_VOL_SERIES
  const spreadSeries = volCompare?.spreadSeries ?? EMPTY_VOL_SERIES
  const windowLabel = (volCompare?.meta?.window ?? '7d').toUpperCase()
  const showRvDefault = volCompare?.meta?.showRvDefault ?? true
  const showSpreadDefault = volCompare?.meta?.showSpreadDefault ?? true

  const [showRv, setShowRv] = useState(showRvDefault)
  const [showSpread, setShowSpread] = useState(showSpreadDefault)

  const lastDvol = lastFiniteValue(dvolSeries)
  const lastRv = lastFiniteValue(rvSeries)
  const lastSpread = lastFiniteValue(spreadSeries)

  const dvolPointCount = countFinite(dvolSeries)
  const hasChart = dvolPointCount >= 1
  const errorMsg = volCompare?.error ?? volCompare?.meta?.error
  const emptyLabel = errorMsg
    ? 'IV unavailable'
    : dvolSeries.length === 0
      ? 'No IV series'
      : '—'

  const title = showRv ? 'IV vs RV' : 'IV'
  const aria = hasChart
    ? `${title} ${windowLabel}${showRv ? ' with realized vol overlay' : ''}${
        showSpread ? ' and IV minus RV spread pane' : ''
      }`
    : `${title} series unavailable`

  return (
    <div
      className="regime-flow flex flex-col border-t border-[var(--desk-rule)]"
      aria-label={showRv ? 'IV versus realized vol' : 'Implied vol'}
    >
      <div className="regime-flow-zone regime-flow-zone--vol">
        <div className="regime-flow-zone__head">
          <span className="regime-flow-zone__title regime-flow-zone__title--vol">
            {title}
          </span>
          <div className="regime-vol__controls">
            <span className="regime-vol__window" aria-label={`Window ${windowLabel}`}>
              {windowLabel}
            </span>
            <button
              type="button"
              className={cn(
                'regime-vol__toggle regime-vol__toggle--rv',
                showRv && 'regime-vol__toggle--on',
              )}
              aria-pressed={showRv}
              aria-label="Toggle realized vol overlay"
              onClick={() => setShowRv((v) => !v)}
            >
              RV
            </button>
            <button
              type="button"
              className={cn(
                'regime-vol__toggle regime-vol__toggle--spread',
                showSpread && 'regime-vol__toggle--on',
              )}
              aria-pressed={showSpread}
              aria-label="Toggle IV minus RV spread pane"
              onClick={() => setShowSpread((v) => !v)}
            >
              Δ
            </button>
            <span className="regime-flow-zone__meta">
              {[
                lastDvol != null ? `IV ${formatVolPercent(lastDvol)}` : null,
                lastRv != null ? `RV ${formatVolPercent(lastRv)}` : null,
                lastSpread != null ? `Δ ${formatSpreadPoints(lastSpread)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        </div>

        <div
          className={cn(
            'regime-vol__chart',
            showSpread && 'regime-vol__chart--dual',
          )}
          role="img"
          aria-label={aria}
        >
          {hasChart ? (
            <VolCompareChart
              className="regime-vol__lwc"
              dvolSeries={dvolSeries}
              rvSeries={rvSeries}
              spreadSeries={spreadSeries}
              showRv={showRv}
              showSpread={showSpread}
            />
          ) : (
            <div className="regime-vol__empty" aria-hidden>
              {emptyLabel}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function lastFiniteValue(series: VolSeriesPoint[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i]?.value
    if (v != null && Number.isFinite(v)) return v
  }
  return null
}

function countFinite(series: VolSeriesPoint[]): number {
  let n = 0
  for (const p of series) {
    if (Number.isFinite(p.value) && Number.isFinite(p.tsMs)) n++
  }
  return n
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

function NetGexProfile({
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
/* Compact metrics                                                             */
/* ─────────────────────────────────────────────────────────────────────────── */

function CompactMetric({
  label,
  value,
  detail,
  tone,
  edge,
}: {
  label: string
  value: string
  detail?: string
  tone: RegimeTone
  edge?: boolean
}) {
  const toneClassName = getRegimeToneClassName(tone)

  return (
    <div
      className={cn(
        'regime-metric min-w-0 px-1.5 py-0.5',
        edge && 'border-r border-[var(--desk-rule)]',
      )}
    >
      <div className="regime-metric__label">
        {label}
      </div>
      {/* No terminal-value here — its global color would override tone classes. */}
      <div
        className={cn(
          'regime-metric__value mt-0.5 uppercase leading-tight tracking-tight',
          toneClassName,
        )}
      >
        {value}
      </div>
      {detail ? (
        <div className={cn('regime-metric__detail mt-0.5 leading-none', toneClassName)}>
          {detail}
        </div>
      ) : null}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Context / scoring (unchanged logic; presentation data only)                 */
/* ─────────────────────────────────────────────────────────────────────────── */

type RegimeTone = 'green' | 'red' | 'amber' | 'muted' | 'heading' | 'blue' | 'violet'

const DEALER_GAMMA_STRONG = 0.35
const DEALER_GAMMA_MILD = 0.12
/** Regime profile corridor: fixed half-width = 8% of spot, centered on spot. */
const CORRIDOR_HALF_PERCENT = 8
/** Dense sample count for continuous heat gradient source field. */
const PROFILE_SAMPLE_COUNT = 128

function getRegimeContext(bookSnapshot: TerminalSnapshot) {
  const netGexUsd = bookSnapshot.bookStats?.netGexUsd ?? bookSnapshot.totalNetGexUsd
  const dealerGammaScore = getDealerGammaScore(bookSnapshot, netGexUsd)
  const dealerGammaLabel = getDealerGammaLabel(dealerGammaScore)
  const dealerGammaTone = getDealerGammaTone(dealerGammaScore)

  // Profile spot marker + corridor center: live Deribit index (fallback: GEX spot).
  const spot = getDisplaySpot(bookSnapshot)

  const { leftBound, rightBound } = resolveCorridorBounds({ spot })
  const corridorSpan = rightBound - leftBound

  const positionFor = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) return undefined
    if (Math.abs(corridorSpan) < 1e-9) return 50
    return clamp(((value - leftBound) / corridorSpan) * 100, 0, 100)
  }

  const rv = getRvTrendMetrics(bookSnapshot)
  const regimeRead = getRegimeRead(dealerGammaScore, rv.label)

  const profile = buildLandscapeProfile(bookSnapshot.gammaBars, leftBound, rightBound)

  return {
    dealerGammaScore,
    dealerGammaLabel,
    dealerGammaTone,
    rvTrendLabel: rv.label,
    rvTrendDetail: rv.detail,
    rvTrendTone: rv.tone,
    regimeReadLabel: regimeRead.label,
    regimeReadTone: regimeRead.tone,
    spotPosition: positionFor(spot) ?? 50,
    spot,
    leftBound,
    rightBound,
    profile,
  }
}

/**
 * Build a continuous signed net-GEX profile from real gammaBars in the window.
 * unit ∈ [-1, 1] relative to max |net GEX| inside the corridor domain.
 * Samples are linearly interpolated so the path is smooth (no discrete bars).
 */
function buildLandscapeProfile(
  gammaBars: GammaBar[],
  leftBound: number,
  rightBound: number,
): LandscapeProfile {
  const span = rightBound - leftBound
  if (!(span > 0)) {
    return { samples: [], maxAbs: 1 }
  }

  const lo = Math.min(leftBound, rightBound)
  const hi = Math.max(leftBound, rightBound)

  const rows = gammaBars
    .map((row) => {
      const netGex = row.netGammaExposureUsd ?? row.gammaExposureUsd
      return {
        strike: row.strike,
        netGex: Number.isFinite(netGex) ? netGex : 0,
      }
    })
    .filter((row) => Number.isFinite(row.strike) && row.strike >= lo && row.strike <= hi)
    .sort((a, b) => a.strike - b.strike)

  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.netGex)), 1)

  if (rows.length === 0) {
    return { samples: [], maxAbs }
  }

  const count = Math.max(PROFILE_SAMPLE_COUNT, rows.length * 2)
  const samples: ProfileSample[] = []

  for (let i = 0; i < count; i++) {
    const xPct = (i / (count - 1)) * 100
    const strike = leftBound + (xPct / 100) * span
    const unit = sampleSignedUnitAtStrike(rows, strike, maxAbs)
    const netGex = unit * maxAbs
    samples.push({ strike, netGex, xPct, unit })
  }

  return { samples, maxAbs }
}

/** Piecewise-linear sample of signed net GEX unit at an arbitrary strike. */
function sampleSignedUnitAtStrike(
  rows: { strike: number; netGex: number }[],
  strike: number,
  maxAbs: number,
): number {
  if (rows.length === 0) return 0
  if (strike <= rows[0]!.strike) return clamp(rows[0]!.netGex / maxAbs, -1, 1)
  if (strike >= rows[rows.length - 1]!.strike) {
    return clamp(rows[rows.length - 1]!.netGex / maxAbs, -1, 1)
  }

  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]!
    const b = rows[i + 1]!
    if (strike >= a.strike && strike <= b.strike) {
      const t = (b.strike - a.strike) < 1e-9
        ? 0
        : (strike - a.strike) / (b.strike - a.strike)
      const net = a.netGex + (b.netGex - a.netGex) * t
      return clamp(net / maxAbs, -1, 1)
    }
  }

  return 0
}

/**
 * Corridor window **symmetric about spot** with fixed half-width
 * CORRIDOR_HALF_PERCENT (8%) of spot. Does not expand for walls.
 */
function resolveCorridorBounds({
  spot,
}: {
  spot: number
}): { leftBound: number; rightBound: number } {
  const safeSpot = Number.isFinite(spot) && spot > 0 ? spot : 1
  const half = safeSpot * (CORRIDOR_HALF_PERCENT / 100)

  return {
    leftBound: safeSpot - half,
    rightBound: safeSpot + half,
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

function getDealerGammaLabel(score: number): string {
  if (score > DEALER_GAMMA_STRONG) return 'Strong Long Gamma'
  if (score >= DEALER_GAMMA_MILD) return 'Long Gamma'
  if (score > -DEALER_GAMMA_MILD) return 'Balanced'
  if (score >= -DEALER_GAMMA_STRONG) return 'Short Gamma'
  return 'Strong Short Gamma'
}

function getDealerGammaTone(score: number): RegimeTone {
  if (score > DEALER_GAMMA_MILD) return 'green'
  if (score < -DEALER_GAMMA_MILD) return 'red'
  return 'amber'
}

type RvTrendLabel = 'Expanding' | 'Neutral' | 'Compressing' | '—'

function getRvTrendMetrics(bookSnapshot: TerminalSnapshot): {
  label: RvTrendLabel
  detail: string | undefined
  tone: RegimeTone
} {
  const stats = bookSnapshot.bookStats
  const trend = stats?.rvTrend ?? null
  const ratio = stats?.rvRatio ?? null

  if (!trend) {
    return { label: '—', detail: undefined, tone: 'muted' }
  }

  const detail = ratio !== null && Number.isFinite(ratio)
    ? `${ratio.toFixed(2)}× d/w`
    : undefined

  // RV confirmation: expanding = warm pressure, compressing = cool calm
  if (trend === 'Expanding') return { label: trend, detail, tone: 'amber' }
  if (trend === 'Compressing') return { label: trend, detail, tone: 'blue' }
  return { label: trend, detail, tone: 'muted' }
}

/**
 * Context = polarity × RV only (never "Short Gamma" / "Long Gamma").
 * Polarity wording stays on the Dealer Γ headline; this cell is the interaction read.
 * Values unchanged: Trend / Soft trend / Fragile / Pin / Range / Unstable pin / Balanced.
 *
 *   Short + Expanding  → Trend
 *   Short + Neutral    → Soft trend   (also when RV unavailable)
 *   Short + Compressing → Fragile
 *   Long  + Compressing → Pin
 *   Long  + Neutral    → Range        (also when RV unavailable)
 *   Long  + Expanding  → Unstable pin
 *   Balanced           → Balanced
 */
function getRegimeRead(
  dealerGammaScore: number,
  rvLabel: RvTrendLabel,
): { label: string; tone: RegimeTone } {
  const isShort = dealerGammaScore < -DEALER_GAMMA_MILD
  const isLong = dealerGammaScore > DEALER_GAMMA_MILD

  if (!isShort && !isLong) {
    return { label: 'Balanced', tone: 'amber' }
  }

  // Treat missing RV as Neutral for the matrix (still polarity × RV only).
  const rv: 'Expanding' | 'Neutral' | 'Compressing' =
    rvLabel === 'Expanding' || rvLabel === 'Compressing' ? rvLabel : 'Neutral'

  if (isShort) {
    if (rv === 'Expanding') return { label: 'Trend', tone: 'red' }
    if (rv === 'Compressing') return { label: 'Fragile', tone: 'amber' }
    return { label: 'Soft trend', tone: 'red' }
  }

  if (rv === 'Compressing') return { label: 'Pin', tone: 'green' }
  if (rv === 'Expanding') return { label: 'Unstable pin', tone: 'amber' }
  return { label: 'Range', tone: 'green' }
}

function getRegimeToneClassName(tone: RegimeTone) {
  return {
    // Full-strength polarity for Net GEX / short-long context reads
    green: 'text-[var(--terminal-green-strong)]',
    red: 'text-[var(--terminal-red-strong)]',
    amber: 'text-[var(--terminal-yellow)]',
    muted: 'text-[var(--terminal-muted)]',
    heading: 'text-[var(--terminal-heading)]',
    // Cool non-GEX accent (RV compressing)
    blue: 'text-[var(--regime-accent-blue,var(--terminal-blue))]',
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
