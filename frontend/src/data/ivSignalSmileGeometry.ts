export type SmileAxis = 'delta' | 'logMoneyness'

export function isSyntheticSmileMark(point: {
  synthetic?: boolean
  classification?: string
  optionSide?: string
}): boolean {
  return point.synthetic === true
    || point.classification === 'synthetic'
    || point.optionSide === 'merged'
}

export type SmileScale = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  plotLeft: number
  plotRight: number
  plotTop: number
  plotBottom: number
}

export function smileAxisValue(
  point: { delta: number | null; logMoneyness: number },
  axis: SmileAxis,
): number {
  return axis === 'delta' ? Number(point.delta) : point.logMoneyness
}

export function projectSmileX(value: number, scale: SmileScale): number {
  return scale.plotLeft
    + ((value - scale.minX) / (scale.maxX - scale.minX)) * (scale.plotRight - scale.plotLeft)
}

export function projectSmileY(value: number, scale: SmileScale): number {
  return scale.plotTop
    + ((scale.maxY - value) / (scale.maxY - scale.minY)) * (scale.plotBottom - scale.plotTop)
}

export function logMoneynessTicks(minX: number, maxX: number): number[] {
  const minPct = minX * 100
  const maxPct = maxX * 100
  const span = maxPct - minPct
  const step = span > 36 ? 10 : 5
  const start = Math.ceil(minPct / step) * step
  const ticks: number[] = []
  for (let pct = start; pct <= maxPct + 1e-9; pct += step) {
    ticks.push(pct / 100)
  }
  if (!ticks.some((tick) => Math.abs(tick) < 1e-9) && minX <= 0 && maxX >= 0) {
    ticks.push(0)
    ticks.sort((left, right) => left - right)
  }
  return ticks
}

export function deltaTicks(minX: number, maxX: number): number[] {
  return [-0.5, -0.25, 0, 0.25, 0.5].filter((value) => value >= minX - 1e-9 && value <= maxX + 1e-9)
}
