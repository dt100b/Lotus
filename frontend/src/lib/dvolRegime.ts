/**
 * DVOL absolute IV-regime card helpers (REGIME metrics strip).
 *
 * Purpose: where is 30d forward implied vol (Deribit DVOL) relative to its own
 * historical distribution? Not an IV−RV valuation read — never RICH/CHEAP/FAIR.
 *
 * Percentile model:
 *   history = last ≤252 valid daily DVOL closes (from the live DVOL series)
 *   percentile = 100 * count(history_values < current_dvol) / count(valid)
 * Warm-up: need ≥60 valid daily observations before computing percentile.
 */

import type { VolSeriesPoint } from '../data/mockTerminal'
import { downsampleToDailyLast } from './volCompareModes'

/** Rolling window for DVOL daily-close percentile (trading-year style). */
export const DVOL_PERCENTILE_WINDOW = 252
/** Minimum valid daily observations before a percentile is shown. */
export const DVOL_PERCENTILE_MIN_OBS = 60

export type DvolRegimeLabel =
  | 'EXTREME'
  | 'ELEVATED'
  | 'BASELINE'
  | 'COMPRESSED'
  | 'FLOOR'
  | 'WARMING UP'
  | 'NO DATA'

/** Tone keys aligned with RegimePanel metric styling. */
export type DvolRegimeTone =
  | 'red'
  | 'amber'
  | 'muted'
  | 'heading'
  | 'blue'
  | 'deepBlue'

export type DvolRegimeMetrics = {
  label: DvolRegimeLabel
  /** Secondary line: "{dvol_1dp} | P{n}" · "{dvol_1dp} | —" · "—" */
  detail: string
  tone: DvolRegimeTone
  dvol: number | null
  percentile: number | null
  historyCount: number
}

/**
 * Map percentile ∈ [0, 100] → absolute IV regime (position only).
 *
 *   P ≥ 90          EXTREME
 *   70 ≤ P < 90     ELEVATED
 *   30 ≤ P < 70     BASELINE
 *   10 ≤ P < 30     COMPRESSED
 *   P < 10          FLOOR
 */
export function classifyDvolRegime(percentile: number): Exclude<
  DvolRegimeLabel,
  'WARMING UP' | 'NO DATA'
> {
  if (percentile >= 90) return 'EXTREME'
  if (percentile >= 70) return 'ELEVATED'
  if (percentile >= 30) return 'BASELINE'
  if (percentile >= 10) return 'COMPRESSED'
  return 'FLOOR'
}

export function dvolRegimeTone(label: DvolRegimeLabel): DvolRegimeTone {
  switch (label) {
    case 'EXTREME':
      return 'red'
    case 'ELEVATED':
      return 'amber'
    case 'BASELINE':
      return 'heading'
    case 'COMPRESSED':
      return 'blue'
    case 'FLOOR':
      return 'deepBlue'
    case 'WARMING UP':
    case 'NO DATA':
    default:
      return 'muted'
  }
}

/**
 * Empirical percentile rank of ``current`` vs ``history`` (strict less-than).
 * Returns null when history is empty. Caller enforces the warm-up floor.
 */
export function computeDvolPercentile(
  current: number,
  history: readonly number[],
): number | null {
  if (!Number.isFinite(current) || history.length === 0) return null
  let below = 0
  let n = 0
  for (const v of history) {
    if (!Number.isFinite(v)) continue
    n += 1
    if (v < current) below += 1
  }
  if (n === 0) return null
  return (100 * below) / n
}

/** Last ≤``window`` valid values from a daily series (already sorted ascending). */
export function takeRollingHistory(
  daily: readonly VolSeriesPoint[],
  window: number = DVOL_PERCENTILE_WINDOW,
): number[] {
  const values: number[] = []
  for (const p of daily) {
    if (Number.isFinite(p.value)) values.push(p.value)
  }
  if (values.length <= window) return values
  return values.slice(values.length - window)
}

function formatDvol1dp(dvol: number): string {
  return dvol.toFixed(1)
}

function formatDetail(dvol: number, percentile: number | null): string {
  if (percentile == null || !Number.isFinite(percentile)) {
    return `${formatDvol1dp(dvol)} | —`
  }
  const pInt = Math.round(Math.min(100, Math.max(0, percentile)))
  return `${formatDvol1dp(dvol)} | P${pInt}`
}

/**
 * Build DVOL card metrics from live book stats + existing vol-compare DVOL series.
 * Does not substitute ATM IV, IV rank, or any non-DVOL source.
 */
export function getDvolRegimeMetrics(opts: {
  /** Live DVOL print (preferred current). */
  currentDvol?: number | null
  /** Existing Deribit DVOL series used by IV−RV / chart (hourly OK). */
  dvolSeries?: readonly VolSeriesPoint[] | null
}): DvolRegimeMetrics {
  const series = opts.dvolSeries ?? []
  const daily = downsampleToDailyLast([...series])
  const history = takeRollingHistory(daily, DVOL_PERCENTILE_WINDOW)
  const historyCount = history.length

  const live =
    opts.currentDvol != null && Number.isFinite(opts.currentDvol) && opts.currentDvol > 0
      ? opts.currentDvol
      : null
  const fromSeries =
    historyCount > 0 && Number.isFinite(history[historyCount - 1]!)
      ? history[historyCount - 1]!
      : null
  const current = live ?? fromSeries

  if (current == null || !Number.isFinite(current) || current <= 0) {
    return {
      label: 'NO DATA',
      detail: '—',
      tone: 'muted',
      dvol: null,
      percentile: null,
      historyCount,
    }
  }

  if (historyCount < DVOL_PERCENTILE_MIN_OBS) {
    return {
      label: 'WARMING UP',
      detail: formatDetail(current, null),
      tone: 'muted',
      dvol: current,
      percentile: null,
      historyCount,
    }
  }

  const percentile = computeDvolPercentile(current, history)
  if (percentile == null) {
    return {
      label: 'WARMING UP',
      detail: formatDetail(current, null),
      tone: 'muted',
      dvol: current,
      percentile: null,
      historyCount,
    }
  }

  const label = classifyDvolRegime(percentile)
  return {
    label,
    detail: formatDetail(current, percentile),
    tone: dvolRegimeTone(label),
    dvol: current,
    percentile,
    historyCount,
  }
}
