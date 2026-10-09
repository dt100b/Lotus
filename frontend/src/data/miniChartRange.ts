export type MiniChartRange =
  | '1d'
  | '1w'
  | '2w'
  | '1m'
  | '3m'
  | '6m'
  | '1y'
  | 'all'

export type MiniChartRangeOption = {
  value: MiniChartRange
  label: string
}

export const MINI_CHART_RANGE_OPTIONS = [
  { value: '1d', label: '1D' },
  { value: '1w', label: '1W' },
  { value: '2w', label: '2W' },
  { value: '1m', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'ALL' },
] as const satisfies readonly MiniChartRangeOption[]

const DAY_SECONDS = 86_400
const HOUR_MS = 3_600_000
const DAY_MS = DAY_SECONDS * 1000

/** Fixed elapsed-time windows. ALL derives its lower bound from the data. */
export const MINI_CHART_RANGE_LOOKBACK_SECONDS: Readonly<
  Record<MiniChartRange, number | null>
> = {
  '1d': DAY_SECONDS,
  '1w': 7 * DAY_SECONDS,
  '2w': 14 * DAY_SECONDS,
  '1m': 30 * DAY_SECONDS,
  '3m': 90 * DAY_SECONDS,
  '6m': 180 * DAY_SECONDS,
  '1y': 365 * DAY_SECONDS,
  all: null,
}

export type MiniChartSample = {
  tsMs: number
  value: number | null | undefined
}

export type MiniChartSeriesGroup =
  | readonly MiniChartSample[]
  | { data: readonly MiniChartSample[] }
  | null
  | undefined

export type MiniChartRangeBounds = {
  fromMs: number
  toMs: number
}

/** Fixed UTC calendar-day viewport containing `referenceMs`. */
export function resolveUtcDayRangeBounds(referenceMs: number): MiniChartRangeBounds | null {
  if (!Number.isFinite(referenceMs) || referenceMs <= 0) return null
  const fromMs = Math.floor(referenceMs / DAY_MS) * DAY_MS
  return { fromMs, toMs: fromMs + DAY_MS }
}

/**
 * Collapse fine observations to the last finite value in each UTC hour.
 *
 * Bucket timestamps identify the start of the UTC interval, matching the
 * convention used by historical market-data APIs. Raw samples remain intact;
 * this is a display projection only.
 */
export function downsampleToUtcHourlyLast(
  samples: readonly MiniChartSample[],
): Array<{ tsMs: number; value: number }> {
  const byHour = new Map<number, { sourceMs: number; value: number }>()
  for (const sample of samples) {
    if (!Number.isFinite(sample.tsMs) || !Number.isFinite(sample.value)) continue
    const sourceMs = sample.tsMs > 1e12 ? sample.tsMs : sample.tsMs * 1000
    if (!(sourceMs > 0)) continue
    const hourMs = Math.floor(sourceMs / HOUR_MS) * HOUR_MS
    const previous = byHour.get(hourMs)
    if (!previous || sourceMs >= previous.sourceMs) {
      byHour.set(hourMs, { sourceMs, value: Number(sample.value) })
    }
  }
  return Array.from(byHour.entries())
    .sort(([left], [right]) => left - right)
    .map(([tsMs, sample]) => ({ tsMs, value: sample.value }))
}

export const MINI_CHART_LEFT_AIR_FRACTION = 0.025
/** Compact right air: about five empty slots on a 100-bar viewport. */
export const MINI_CHART_RIGHT_AIR_FRACTION = 0.05

export function padMiniChartRangeBounds(
  bounds: MiniChartRangeBounds,
  rightAirFraction = MINI_CHART_RIGHT_AIR_FRACTION,
): MiniChartRangeBounds {
  const spanMs = Math.max(1_000, bounds.toMs - bounds.fromMs)
  return {
    fromMs: bounds.fromMs - spanMs * MINI_CHART_LEFT_AIR_FRACTION,
    toMs: bounds.toMs + spanMs * rightAirFraction,
  }
}

/** Resolve a fixed viewport from all supplied series, anchored to the latest sample. */
export function resolveMiniChartRangeBounds(
  range: MiniChartRange,
  seriesGroups: readonly MiniChartSeriesGroup[],
): MiniChartRangeBounds | null {
  let earliestMs = Number.POSITIVE_INFINITY
  let latestMs = Number.NEGATIVE_INFINITY

  for (const group of seriesGroups) {
    const points = group == null ? [] : 'data' in group ? group.data : group
    for (const point of points) {
      if (!Number.isFinite(point.tsMs) || !Number.isFinite(point.value)) continue
      earliestMs = Math.min(earliestMs, point.tsMs)
      latestMs = Math.max(latestMs, point.tsMs)
    }
  }

  if (!Number.isFinite(earliestMs) || !Number.isFinite(latestMs)) return null

  const lookbackSeconds = MINI_CHART_RANGE_LOOKBACK_SECONDS[range]
  return {
    fromMs: lookbackSeconds == null ? earliestMs : latestMs - lookbackSeconds * 1000,
    toMs: latestMs,
  }
}

export type MiniChartTimeTick = {
  tsMs: number
  label: string
  positionPct: number
}

export const MINI_CHART_TIME_ZONE = 'America/New_York'

/** Build labels at equal pixel-domain fractions of the selected time window. */
export function buildMiniChartTimeTicks(
  bounds: MiniChartRangeBounds,
  tickCount: number,
  timeZone = MINI_CHART_TIME_ZONE,
): MiniChartTimeTick[] {
  const { fromMs, toMs } = bounds
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return []
  if (toMs === fromMs) {
    return [{
      tsMs: fromMs,
      label: tickFormatter(0, timeZone).format(new Date(fromMs)),
      positionPct: 50,
    }]
  }

  const count = Math.max(2, Math.round(tickCount))
  const spanMs = toMs - fromMs
  const formatter = tickFormatter(spanMs, timeZone)
  const intradayEndpointFormatter = spanMs <= 2 * DAY_SECONDS * 1000
    ? new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
      })
    : null
  return Array.from({ length: count }, (_, index) => {
    const fraction = index / (count - 1)
    const tsMs = Math.round(fromMs + spanMs * fraction)
    const endpoint = index === 0 || index === count - 1
    const label = intradayEndpointFormatter && endpoint
      ? intradayEndpointFormatter.format(new Date(tsMs))
      : formatter.format(new Date(tsMs))
    return { tsMs, label, positionPct: fraction * 100 }
  })
}

function tickFormatter(spanMs: number, timeZone: string): Intl.DateTimeFormat {
  const spanDays = spanMs / (DAY_SECONDS * 1000)
  let options: Intl.DateTimeFormatOptions
  if (spanDays <= 2) {
    options = {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }
  } else if (spanDays <= 180) {
    options = { month: 'short', day: 'numeric' }
  } else if (spanDays <= 730) {
    options = { month: 'short', year: '2-digit' }
  } else {
    options = { year: 'numeric' }
  }
  return new Intl.DateTimeFormat('en-US', { timeZone, ...options })
}
