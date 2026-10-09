export type MiniChartPriceFormat = {
  type: 'custom'
  minMove: number
  formatter: (price: number) => string
}

export type MiniChartAxisStepRef = { current: number }

/**
 * Lightweight Charts selects its formatter when the scale is attached;
 * reading the step from a ref keeps label density live while visible series
 * and ranges change on a mounted chart.
 */
export function createDynamicMiniChartPriceFormat(
  stepRef: MiniChartAxisStepRef,
  formatter: (price: number, step: number) => string,
  floorStep = 0.1,
): MiniChartPriceFormat {
  const minimum = positiveOr(floorStep, 0.1)
  return {
    type: 'custom',
    // LWC's tick base must be a decimal power (arbitrary 1.5/3 steps throw
    // "unexpected base"). Display spacing remains controlled by stepRef.
    minMove: 10 ** Math.floor(Math.log10(minimum)),
    formatter: (price) => {
      const step = Math.max(minimum, positiveOr(stepRef.current, minimum))
      return isStepAligned(price, step) ? formatter(price, step) : ''
    },
  }
}

export function resolveMiniChartAxisStep(
  values: readonly number[],
  floorStep = 0.1,
  targetIntervals = 3.5,
): number {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return positiveOr(floorStep, 0.1)
  }

  const minimum = positiveOr(floorStep, 0.1)
  const targetStep = (max - min) / positiveOr(targetIntervals, 3.5)
  if (targetStep <= minimum) return minimum
  const rawStep = targetStep
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  // Stay on the native decimal grid so filtered ticks cannot fall between the
  // values Lightweight Charts generates internally (for example .8 vs .5).
  const mantissas = [1, 1.5, 2, 2.5, 4, 5, 10]
  const mantissa = mantissas.find((candidate) => candidate >= normalized) ?? 10
  return Math.max(positiveOr(floorStep, 0.1), mantissa * magnitude)
}

/** Evenly spaced top-to-bottom values for the responsive SVG term chart. */
export function buildMiniChartAxisTicks(max: number, min: number, count = 4): number[] {
  const tickCount = Math.max(2, Math.round(count))
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return []
  return Array.from({ length: tickCount }, (_, index) => (
    max - ((max - min) * index) / (tickCount - 1)
  ))
}

function positiveOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? value! : fallback
}

function isStepAligned(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return false
  const scaled = value / step
  return Math.abs(scaled - Math.round(scaled)) < 1e-4
}
