import { curveMonotoneX, line } from 'd3-shape'

type CurvePoint = { x: number; y: number; slotIndex: number }

/** Tight IV range with readable decimal ticks and a stable floor for flat curves. */
export function buildTermCurveScale(values: readonly number[], plotHeight: number, tickSpacing = 48) {
  const finiteValues = values.filter(Number.isFinite)
  if (!finiteValues.length) return { min: 0, max: 2, ticks: [2, 1, 0] }
  const low = Math.min(...finiteValues)
  const high = Math.max(...finiteValues)
  const span = high - low
  const padding = Math.max(.35, span * .12, (2 - span) / 2)
  // Quarter-point bounds keep modest live updates from moving the range constantly.
  const min = Math.max(0, Math.floor((low - padding) * 4) / 4)
  const max = Math.max(min + 2, Math.ceil((high + padding) * 4) / 4)
  const intervals = Math.max(2, Math.min(4, Math.floor(plotHeight / tickSpacing)))
  const rawStep = (max - min) / intervals
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  let step = ([1, 2, 2.5, 5, 10].find((n) => n >= rawStep / magnitude) ?? 10) * magnitude
  if (Math.floor(max / step) - Math.ceil(min / step) < 1) step /= 2
  const first = Math.ceil(min / step)
  const last = Math.floor(max / step)
  const ticks = Array.from({ length: last - first + 1 }, (_, index) =>
    Number(((last - index) * step).toFixed(8)),
  )
  return { min, max, ticks }
}

/** Front premium extends only across consecutive, supported tenors below 7D IV. */
export function frontElevationEndSlot(points: Array<{ slotIndex: number; value: number }>): number | null {
  const front = points.find((point) => point.slotIndex === 0)
  if (!front || !Number.isFinite(front.value)) return null
  let end = 0
  for (let slot = 1; slot <= 3; slot++) {
    const point = points.find((p) => p.slotIndex === slot)
    if (!point || !Number.isFinite(point.value) || front.value <= point.value) break
    end = slot
  }
  return end === 0 ? null : end
}

/** Visual interpolation through observations, without overshoot or bridging gaps. */
export function buildTermCurvePaths(points: CurvePoint[], baseline: number) {
  const segments: CurvePoint[][] = []
  for (const point of points) {
    const segment = segments.at(-1)
    if (!segment || point.slotIndex - segment.at(-1)!.slotIndex > 1) segments.push([point])
    else segment.push(point)
  }
  const draw = line<CurvePoint>().x((p) => p.x).y((p) => p.y).curve(curveMonotoneX)
  return {
    path: segments.map((segment) => draw(segment) ?? '').join(' '),
    areaPath: segments.filter((segment) => segment.length > 1).map((segment) => {
      const first = segment[0]!
      const last = segment.at(-1)!
      return `${draw(segment)} L ${last.x} ${baseline} L ${first.x} ${baseline} Z`
    }).join(' '),
  }
}
