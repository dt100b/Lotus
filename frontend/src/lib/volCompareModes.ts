/**
 * IV vs RV chart modes + VRP / Z-score series helpers.
 *
 * Definitions (matched ~30d tenors — DVOL vs RV30):
 *   VRP_t  = IV_t − RV_t   (vol points; same as spread_series)
 *   Z_t    = (VRP_t − μ) / σ  over a trailing window of VRP
 *
 * Signal framework (for chip flags — short 1–2 word labels only):
 *   Positive VRP  → options RICH vs realised (sellers earn premium)
 *   Negative VRP  → options CHEAP vs realised (buyers favored)
 *   Near zero     → FAIR
 *   Stronger |VRP| → stronger label (IV RICH / IV CHEAP vs SOFT RICH / SOFT CHEAP)
 */

import type { VolSeriesPoint } from '@/data/mockTerminal'

export type VolChartMode = 'dvol' | 'iv_rv' | 'vrp' | 'vrp_z'

export const VOL_CHART_MODES: readonly VolChartMode[] = ['dvol', 'iv_rv', 'vrp', 'vrp_z'] as const

export const VOL_CHART_MODE_LABEL: Record<VolChartMode, string> = {
  dvol: 'DVOL',
  iv_rv: 'IV vs RV',
  vrp: 'VRP',
  vrp_z: 'VRP Z-SCORE (60D)',
}

export const VOL_CHART_MODE_SHORT: Record<VolChartMode, string> = {
  dvol: 'DVOL',
  iv_rv: 'IV/RV',
  vrp: 'VRP',
  vrp_z: 'Z-SCORE',
}

/** Mild / strong VRP thresholds in vol points (IV − RV). */
export const VRP_MILD_POINTS = 4.0
export const VRP_STRONG_POINTS = 8.0

/**
 * Trailing samples for rolling VRP Z (daily bars).
 * Fixed 60d window for the z-score definition (header: VRP Z-SCORE (60D)).
 * Plot is also clipped to the last 60 calendar days (not the full 180d book).
 */
export const VRP_Z_LOOKBACK = 60
/** Display / series horizon for the Z chart (calendar days of Z points kept). */
export const VRP_Z_DISPLAY_DAYS = 60
/** Sample stdev needs ≥2; emit early once enough history exists. */
export const VRP_Z_MIN_SAMPLES = 2

export type IvRvSignalTone = 'blue' | 'amber' | 'muted'

export type IvRvSignal = {
  /** 1–2 word flag, e.g. "IV RICH" (rendered uppercase in chip CSS). */
  label: string
  tone: IvRvSignalTone
}

/**
 * Map VRP (IV − RV, vol points) → short desk flag.
 *
 *   > +8       IV EXTENDED
 *   +4 to +8   IV RICH
 *   −4 to +4   IV NEUTRAL
 *   −8 to −4   IV CHEAP
 *   < −8       IV DEPRESSED
 */
export function describeIvRvSignal(vrpPoints: number): IvRvSignal {
  if (!Number.isFinite(vrpPoints)) {
    return { label: '—', tone: 'muted' }
  }
  // > +8
  if (vrpPoints > VRP_STRONG_POINTS) {
    return { label: 'IV EXTENDED', tone: 'blue' }
  }
  // +4 … +8
  if (vrpPoints >= VRP_MILD_POINTS) {
    return { label: 'IV RICH', tone: 'blue' }
  }
  // −4 … +4
  if (vrpPoints >= -VRP_MILD_POINTS) {
    return { label: 'IV NEUTRAL', tone: 'muted' }
  }
  // −8 … −4
  if (vrpPoints >= -VRP_STRONG_POINTS) {
    return { label: 'IV CHEAP', tone: 'amber' }
  }
  // < −8
  return { label: 'IV DEPRESSED', tone: 'amber' }
}

export function nextVolChartMode(mode: VolChartMode): VolChartMode {
  const i = VOL_CHART_MODES.indexOf(mode)
  return VOL_CHART_MODES[(i + 1) % VOL_CHART_MODES.length]!
}

export function prevVolChartMode(mode: VolChartMode): VolChartMode {
  const i = VOL_CHART_MODES.indexOf(mode)
  return VOL_CHART_MODES[(i - 1 + VOL_CHART_MODES.length) % VOL_CHART_MODES.length]!
}

/**
 * VRP series = IV − RV on shared timestamps.
 * Prefer backend spread series when present.
 */
export function buildVrpSeries(
  spreadSeries: VolSeriesPoint[],
  dvolSeries: VolSeriesPoint[] = [],
  rvSeries: VolSeriesPoint[] = [],
): VolSeriesPoint[] {
  if (spreadSeries.length > 0) {
    return spreadSeries.filter((p) => Number.isFinite(p.tsMs) && Number.isFinite(p.value))
  }
  if (dvolSeries.length === 0 || rvSeries.length === 0) return []

  const rvByTs = new Map<number, number>()
  for (const p of rvSeries) {
    if (!Number.isFinite(p.tsMs) || !Number.isFinite(p.value)) continue
    rvByTs.set(p.tsMs, p.value)
  }
  const out: VolSeriesPoint[] = []
  for (const p of dvolSeries) {
    if (!Number.isFinite(p.tsMs) || !Number.isFinite(p.value)) continue
    const rv = rvByTs.get(p.tsMs)
    if (rv == null || !Number.isFinite(rv)) continue
    out.push({ tsMs: p.tsMs, value: p.value - rv })
  }
  return out
}

/**
 * Collapse hourly (or denser) points to one bar per UTC calendar day (last value).
 * Histogram modes need daily density — 720 hourly bars read as a solid wall.
 */
export function downsampleToDailyLast(series: VolSeriesPoint[]): VolSeriesPoint[] {
  const clean = series
    .filter((p) => Number.isFinite(p.tsMs) && Number.isFinite(p.value))
    .slice()
    .sort((a, b) => a.tsMs - b.tsMs)
  if (clean.length === 0) return []

  const byDay = new Map<number, VolSeriesPoint>()
  for (const p of clean) {
    const dayKey = Math.floor(p.tsMs / 86_400_000)
    // Keep last print of the day
    byDay.set(dayKey, p)
  }
  return Array.from(byDay.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, p]) => ({ tsMs: p.tsMs, value: p.value }))
}

/** Keep only the last ``days`` calendar days of a series (by last point). */
export function trimSeriesToLastDays(
  series: VolSeriesPoint[],
  days: number,
): VolSeriesPoint[] {
  const clean = series
    .filter((p) => Number.isFinite(p.tsMs) && Number.isFinite(p.value))
    .slice()
    .sort((a, b) => a.tsMs - b.tsMs)
  if (clean.length === 0 || !(days > 0)) return clean
  const lastMs = clean[clean.length - 1]!.tsMs
  const cutoff = lastMs - days * 86_400_000
  return clean.filter((p) => p.tsMs >= cutoff)
}

/**
 * Rolling Z-score of VRP: z_t = (vrp_t − mean) / sample_stdev over trailing window.
 * Expanding window until ``lookback`` is filled; caller typically trims the
 * output to VRP_Z_DISPLAY_DAYS so the chart only shows 60d of Z (not 180d).
 */
export function buildVrpZScoreSeries(
  vrpSeries: VolSeriesPoint[],
  lookback: number = VRP_Z_LOOKBACK,
): VolSeriesPoint[] {
  const clean = vrpSeries
    .filter((p) => Number.isFinite(p.tsMs) && Number.isFinite(p.value))
    .slice()
    .sort((a, b) => a.tsMs - b.tsMs)
  if (clean.length < VRP_Z_MIN_SAMPLES) return []

  const win = Math.max(VRP_Z_MIN_SAMPLES, Math.min(lookback, clean.length))
  const out: VolSeriesPoint[] = []

  for (let i = VRP_Z_MIN_SAMPLES - 1; i < clean.length; i++) {
    const start = Math.max(0, i - win + 1)
    const slice = clean.slice(start, i + 1)
    const n = slice.length
    if (n < VRP_Z_MIN_SAMPLES) continue
    let sum = 0
    for (const p of slice) sum += p.value
    const mean = sum / n
    let varSum = 0
    for (const p of slice) {
      const d = p.value - mean
      varSum += d * d
    }
    // Population-ish guard: sample stdev needs n ≥ 2 (already enforced).
    const stdev = Math.sqrt(varSum / Math.max(n - 1, 1))
    if (!(stdev > 1e-9)) continue
    const z = (clean[i]!.value - mean) / stdev
    if (!Number.isFinite(z)) continue
    out.push({ tsMs: clean[i]!.tsMs, value: round4(z) })
  }
  return out
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4
}
