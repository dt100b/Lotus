/** Shared IV Scanner plot box so the PDF and smile charts align. */
export const IV_SCANNER_PLOT = {
  top: 12,
  tickLabel: 13,
  xTitle: 12,
  rightPad: 4,
  /** Half-width reserved for centered end tick labels. */
  endLabelHalf: 20,
} as const

const AXIS_TITLE_FONT = 7
/** Equal gap: panel edge → title → values. */
const AXIS_SIDE_GAP = 6
const AXIS_VALUE_INSET = 5
const Y_TICK_CHAR_WIDTH = 6

export type IvScannerPlotBox = {
  plotTop: number
  plotBottom: number
  plotLeft: number
  plotRight: number
}

export function ivScannerYAxisGutter(labels: readonly string[]): number {
  return AXIS_SIDE_GAP
    + AXIS_TITLE_FONT
    + AXIS_SIDE_GAP
    + estimateYTickWidth(labels)
    + AXIS_VALUE_INSET
}

export function ivScannerPlotBox(
  width: number,
  height: number,
  yTickLabels: readonly string[] = ['40%'],
): IvScannerPlotBox {
  const plotTop = IV_SCANNER_PLOT.top
  const plotBottom = Math.max(
    plotTop + 1,
    height - IV_SCANNER_PLOT.tickLabel - IV_SCANNER_PLOT.xTitle,
  )
  const plotLeft = ivScannerYAxisGutter(yTickLabels)
  const plotRight = Math.max(
    plotLeft + 1,
    width - IV_SCANNER_PLOT.endLabelHalf - IV_SCANNER_PLOT.rightPad,
  )
  return { plotTop, plotBottom, plotLeft, plotRight }
}

export type IvScannerYTick = {
  value: number
  y: number
  label: string
}

export function niceScaleTicks(min: number, max: number, targetCount = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return []
  const span = max - min
  const raw = span / Math.max(1, targetCount - 1)
  if (!(raw > 0)) return []
  const exponent = Math.floor(Math.log10(raw))
  const magnitude = 10 ** exponent
  const residual = raw / magnitude
  const niceResidual = residual >= 7.5 ? 10 : residual >= 3.5 ? 5 : residual >= 1.5 ? 2 : 1
  const step = niceResidual * magnitude
  if (!(step > 0)) return []
  const start = Math.ceil((min - step * 1e-9) / step) * step
  const ticks: number[] = []
  for (let value = start; value <= max + step * 1e-6 && ticks.length < 8; value += step) {
    const snapped = Number(value.toPrecision(8))
    if (snapped >= min - step * 1e-6 && snapped <= max + step * 1e-6) {
      ticks.push(snapped)
    }
  }
  return ticks
}

export function buildDensityYTicks(
  minDensity: number,
  maxDensity: number,
  plotTop: number,
  plotBottom: number,
): IvScannerYTick[] {
  const visibleMax = Math.max(0, maxDensity)
  const visibleMin = Math.min(0, Math.max(minDensity, 0))
  if (!(visibleMax > visibleMin)) return []

  const absMax = Math.max(Math.abs(visibleMin), Math.abs(visibleMax))
  const factor = absMax > 0 && absMax < 0.01
    ? 10 ** Math.floor(Math.log10(absMax))
    : 1

  return niceScaleTicks(visibleMin / factor, visibleMax / factor, 4).map((scaled) => {
    const value = scaled * factor
    return {
      value,
      y: plotTop + ((maxDensity - value) / (maxDensity - minDensity)) * (plotBottom - plotTop),
      label: formatScaledTick(scaled),
    }
  })
}

export function buildVolYTicks(
  minY: number,
  maxY: number,
  plotTop: number,
  plotBottom: number,
): IvScannerYTick[] {
  return niceScaleTicks(minY, maxY, 4).map((value) => ({
    value,
    y: plotTop + ((maxY - value) / (maxY - minY)) * (plotBottom - plotTop),
    label: formatVolTick(value),
  }))
}

function formatScaledTick(value: number): string {
  if (Math.abs(value) < 1e-9) return '0'
  const abs = Math.abs(value)
  const digits = abs >= 10 ? 0 : abs >= 1 ? 1 : 2
  const body = abs.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  return value < 0 ? `−${body}` : body
}

function formatVolTick(value: number): string {
  const abs = Math.abs(value)
  const digits = abs >= 10 || Number.isInteger(Number(value.toFixed(1))) ? 0 : 1
  return `${value.toFixed(digits)}%`
}

export function ivScannerAxisTitleX(box: IvScannerPlotBox): number {
  return (box.plotLeft + box.plotRight) / 2
}

export function ivScannerYTickLabelX(box: IvScannerPlotBox): number {
  return box.plotLeft - AXIS_VALUE_INSET
}

export function ivScannerYAxisAnchor(box: IvScannerPlotBox): { x: number; y: number } {
  return {
    x: AXIS_SIDE_GAP + AXIS_TITLE_FONT / 2,
    y: (box.plotTop + box.plotBottom) / 2,
  }
}

function estimateYTickWidth(labels: readonly string[]): number {
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 1)
  return Math.max(6, longest * Y_TICK_CHAR_WIDTH)
}
