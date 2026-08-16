import {
  memo,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { IvSignalScan } from '@/api/ivSignalScanner'
import { DIAGNOSTIC_DENSITY_LABEL } from '@/data/optionsSurfaceDisplay'
import {
  buildDensityYTicks,
  ivScannerAxisTitleX,
  ivScannerPlotBox,
  ivScannerYAxisAnchor,
  ivScannerYTickLabelX,
  type IvScannerYTick,
} from '@/data/ivScannerChartLayout'
import { useContainerSize } from '@/hooks/useContainerSize'
import { cn } from '@/lib/utils'

type IvSignalDensityChartProps = {
  scan: IvSignalScan
  className?: string
  layers?: IvSignalDensityLayers
  mode?: 'probability' | 'diagnostic'
}

export type IvSignalDensityLayers = {
  forward: boolean
  band: boolean
  wings: boolean
  sigma: boolean
}

type DensityGeometry = {
  linePath: string
  areaPath: string
  points: Array<{ x: number; y: number }>
  baselineY: number
  plotLeft: number
  plotRight: number
  plotTop: number
  plotBottom: number
  minStrike: number
  maxStrike: number
  dataMinStrike: number
  dataMaxStrike: number
  minDensity: number
  maxDensity: number
  ticks: Array<{ value: number; x: number; label: string }>
  yTicks: IvScannerYTick[]
  supportLeftOpen: boolean
  supportRightOpen: boolean
  cumulative: number[]
}

const FALLBACK_WIDTH = 400
const FALLBACK_HEIGHT = 221
const DEFAULT_LAYERS: IvSignalDensityLayers = {
  forward: true,
  band: true,
  wings: true,
  sigma: false,
}

export const IvSignalDensityChart = memo(function IvSignalDensityChart({
  scan,
  className,
  layers = DEFAULT_LAYERS,
  mode = 'probability',
}: IvSignalDensityChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const descriptionId = useId()
  const clipId = useId().replace(/:/g, '')
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const { width, height } = useContainerSize(hostRef, FALLBACK_WIDTH, FALLBACK_HEIGHT, {
    minWidth: 180,
    minHeight: 188,
  })
  const diagnostic = mode === 'diagnostic'
  const plotScan = useMemo(() => diagnosticPlotScan(scan, diagnostic), [diagnostic, scan])
  const geometry = useMemo(
    () => buildDensityGeometry(plotScan, width, height, diagnostic),
    [diagnostic, height, plotScan, width],
  )

  if (!geometry || plotScan.density.length === 0) {
    return (
      <div ref={hostRef} className={cn('iv-signal-density', className)}>
        <div className="iv-signal-density__empty">Density unavailable</div>
      </div>
    )
  }

  const activePoint = activeIndex == null ? null : plotScan.density[activeIndex] ?? null
  const activeCoord = activeIndex == null ? null : geometry.points[activeIndex] ?? null
  const activeMass = activeIndex == null ? 0 : geometry.cumulative[activeIndex] ?? 0
  const xForStrike = (strike: number) => scaleStrike(strike, geometry)
  const bandLeft = xForStrike(plotScan.rnd.percentile25)
  const bandRight = xForStrike(plotScan.rnd.percentile75)
  const forwardX = xForStrike(plotScan.rnd.forward)
  const wingLowerX = xForStrike(scan.rnd.forward * 0.95)
  const wingUpperX = xForStrike(scan.rnd.forward * 1.05)
  const sigmaLowerX = scan.rnd.sigmaLeftStrike == null ? null : xForStrike(scan.rnd.sigmaLeftStrike)
  const sigmaUpperX = scan.rnd.sigmaRightStrike == null ? null : xForStrike(scan.rnd.sigmaRightStrike)
  const dataLeftX = xForStrike(geometry.dataMinStrike)
  const dataRightX = xForStrike(geometry.dataMaxStrike)
  const modePoint = diagnostic ? null : geometry.points[nearestDensityIndex(plotScan, plotScan.markers.peakStrike)] ?? null
  const clearHover = () => setActiveIndex(null)

  const setNearestPoint = (pointerX: number) => {
    let index = 0
    let nearestDistance = Number.POSITIVE_INFINITY
    geometry.points.forEach((point, pointIndex) => {
      const distance = Math.abs(point.x - pointerX)
      if (distance < nearestDistance) {
        nearestDistance = distance
        index = pointIndex
      }
    })
    setActiveIndex((current) => current === index ? current : index)
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!(rect.width > 0)) return
    setNearestPoint(((event.clientX - rect.left) / rect.width) * width)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const fallback = nearestDensityIndex(plotScan, plotScan.rnd.forward)
    const direction = event.key === 'ArrowRight' ? 1 : -1
    setActiveIndex((current) => clampIndex((current ?? fallback) + direction, plotScan.density.length))
  }

  const tooltipWidth = 168
  const tooltipX = activeCoord == null
    ? 0
    : clamp(
        activeCoord.x + 10 + tooltipWidth <= width - 5
          ? activeCoord.x + 10
          : activeCoord.x - tooltipWidth - 10,
        5,
        Math.max(5, width - tooltipWidth - 5),
      )
  const tooltipY = activeCoord == null
    ? 0
    : clamp(activeCoord.y - 42, geometry.plotTop + 4, geometry.plotBottom - 41)
  const yTitle = ivScannerYAxisAnchor(geometry)

  return (
    <div
      ref={hostRef}
      className={cn('iv-signal-density', diagnostic && 'iv-signal-density--diagnostic', className)}
      onPointerLeave={clearHover}
      onMouseLeave={clearHover}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="iv-signal-density__svg"
        role="img"
        aria-label={diagnostic ? DIAGNOSTIC_DENSITY_LABEL : `BTC risk-neutral density for ${scan.expiry}`}
        aria-describedby={descriptionId}
        tabIndex={0}
        onFocus={() => setActiveIndex((current) => current ?? nearestDensityIndex(plotScan, plotScan.rnd.forward))}
        onBlur={clearHover}
        onKeyDown={handleKeyDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={clearHover}
        onPointerCancel={clearHover}
        onMouseLeave={clearHover}
      >
        <desc id={descriptionId}>
          {diagnostic
            ? `${DIAGNOSTIC_DENSITY_LABEL}. Forward ${formatStrike(plotScan.rnd.forward)}. This curve is not a validated probability distribution.`
            : `Implied probability density for ${scan.expiry}. Forward ${formatStrike(scan.rnd.forward)}, mode ${formatStrike(scan.markers.peakStrike)}, curve quality ${scan.curveQuality.level.toLowerCase()}.${geometry.supportLeftOpen || geometry.supportRightOpen ? ' The curve reaches a verified strike boundary above zero and is not extrapolated into the hatched range.' : ''}`}
        </desc>
        <defs>
          <linearGradient id={`${clipId}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--iv-signal-density-line)" stopOpacity="0.24" />
            <stop offset="100%" stopColor="var(--iv-signal-density-line)" stopOpacity="0.018" />
          </linearGradient>
          <pattern
            id={`${clipId}-support-hatch`}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line
              x1="0"
              x2="0"
              y1="0"
              y2="6"
              className="iv-signal-density__support-hatch-line"
            />
          </pattern>
          <clipPath id={clipId}>
            <rect
              x={geometry.plotLeft}
              y={geometry.plotTop}
              width={Math.max(1, geometry.plotRight - geometry.plotLeft)}
              height={Math.max(1, geometry.plotBottom - geometry.plotTop)}
            />
          </clipPath>
        </defs>

        <g clipPath={`url(#${clipId})`}>
          {!diagnostic && layers.wings ? (
            <>
              <rect
                x={geometry.plotLeft}
                y={geometry.plotTop}
                width={Math.max(0, wingLowerX - geometry.plotLeft)}
                height={geometry.baselineY - geometry.plotTop}
                className="iv-signal-density__wing iv-signal-density__wing--down"
              />
              <rect
                x={wingUpperX}
                y={geometry.plotTop}
                width={Math.max(0, geometry.plotRight - wingUpperX)}
                height={geometry.baselineY - geometry.plotTop}
                className="iv-signal-density__wing iv-signal-density__wing--up"
              />
            </>
          ) : null}
          {!diagnostic && layers.band ? (
            <rect
              x={Math.min(bandLeft, bandRight)}
              y={geometry.plotTop}
              width={Math.abs(bandRight - bandLeft)}
              height={geometry.baselineY - geometry.plotTop}
              className="iv-signal-density__band"
            />
          ) : null}

          {dataLeftX > geometry.plotLeft + 0.5 ? (
            <rect
              x={geometry.plotLeft}
              y={geometry.plotTop}
              width={dataLeftX - geometry.plotLeft}
              height={geometry.baselineY - geometry.plotTop}
              fill={`url(#${clipId}-support-hatch)`}
              className="iv-signal-density__unsupported"
            />
          ) : null}
          {dataRightX < geometry.plotRight - 0.5 ? (
            <rect
              x={dataRightX}
              y={geometry.plotTop}
              width={geometry.plotRight - dataRightX}
              height={geometry.baselineY - geometry.plotTop}
              fill={`url(#${clipId}-support-hatch)`}
              className="iv-signal-density__unsupported"
            />
          ) : null}

          <line
            x1={geometry.plotLeft}
            x2={geometry.plotRight}
            y1={geometry.baselineY}
            y2={geometry.baselineY}
            className="iv-signal-density__baseline"
            vectorEffect="non-scaling-stroke"
          />
          <path d={geometry.areaPath} fill={`url(#${clipId}-fill)`} />
          <path
            d={geometry.linePath}
            className="iv-signal-density__curve"
            vectorEffect="non-scaling-stroke"
          />

          {!diagnostic && layers.wings ? (
            <>
              <line x1={wingLowerX} x2={wingLowerX} y1={geometry.plotTop} y2={geometry.baselineY} className="iv-signal-density__wing-line" vectorEffect="non-scaling-stroke" />
              <line x1={wingUpperX} x2={wingUpperX} y1={geometry.plotTop} y2={geometry.baselineY} className="iv-signal-density__wing-line" vectorEffect="non-scaling-stroke" />
            </>
          ) : null}
          {layers.sigma && sigmaLowerX != null && sigmaUpperX != null ? (
            <>
              <line x1={sigmaLowerX} x2={sigmaLowerX} y1={geometry.plotTop} y2={geometry.baselineY} className="iv-signal-density__sigma" vectorEffect="non-scaling-stroke" />
              <line x1={sigmaUpperX} x2={sigmaUpperX} y1={geometry.plotTop} y2={geometry.baselineY} className="iv-signal-density__sigma" vectorEffect="non-scaling-stroke" />
            </>
          ) : null}
          {layers.forward ? (
            <g className="iv-signal-density__forward">
              <line
                x1={forwardX}
                x2={forwardX}
                y1={geometry.plotTop}
                y2={geometry.baselineY}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : null}
          {modePoint ? (
            <circle
              cx={modePoint.x}
              cy={modePoint.y}
              r="2.1"
              className="iv-signal-density__mode"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {geometry.supportLeftOpen ? (
            <g className="iv-signal-density__support-edge">
              <circle
                cx={geometry.points[0]!.x}
                cy={geometry.points[0]!.y}
                r="2.4"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : null}
          {geometry.supportRightOpen ? (
            <g className="iv-signal-density__support-edge">
              <circle
                cx={geometry.points[geometry.points.length - 1]!.x}
                cy={geometry.points[geometry.points.length - 1]!.y}
                r="2.4"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : null}

          {activeCoord && activePoint ? (
            <g className="iv-signal-density__inspection" pointerEvents="none">
              <line
                x1={activeCoord.x}
                x2={activeCoord.x}
                y1={geometry.plotTop}
                y2={geometry.plotBottom}
                className="iv-signal-density__crosshair"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={activeCoord.x}
                cy={activeCoord.y}
                r={3.2}
                className="iv-signal-density__point"
                vectorEffect="non-scaling-stroke"
              />
              <g transform={`translate(${tooltipX} ${tooltipY})`}>
                <rect
                  width={tooltipWidth}
                  height={38}
                  rx={2}
                  className="iv-signal-density__tooltip-bg"
                />
                <text x={8} y={14} className="iv-signal-density__tooltip-title">
                  {formatStrike(activePoint.strike)}
                </text>
                <text x={8} y={29} className="iv-signal-density__tooltip-value">
                  {diagnostic
                    ? 'Diagnostic residual — not a probability'
                    : `${formatProbability(activeMass)} below · ${formatProbability(1 - activeMass)} above`}
                </text>
              </g>
            </g>
          ) : null}
        </g>

        {geometry.yTicks.map((tick) => (
          <g key={`y-${tick.value}`}>
            {Math.abs(tick.value) > 1e-12 ? (
              <line
                x1={geometry.plotLeft - 3}
                x2={geometry.plotLeft}
                y1={tick.y}
                y2={tick.y}
                className="iv-signal-density__axis-tick"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <text
              x={ivScannerYTickLabelX(geometry)}
              y={tick.y + 2.5}
              textAnchor="end"
              className="iv-signal-density__axis-label"
            >
              {tick.label}
            </text>
          </g>
        ))}
        <text
          x={yTitle.x}
          y={yTitle.y}
          textAnchor="middle"
          className="iv-signal-density__axis-title"
          transform={`rotate(-90 ${yTitle.x} ${yTitle.y})`}
        >
          {diagnostic ? 'Diagnostic residual' : 'Implied density'}
        </text>
        {geometry.ticks.map((tick) => (
          <g key={`tick-${tick.value}`}>
            <line
              x1={tick.x}
              x2={tick.x}
              y1={geometry.plotBottom}
              y2={geometry.plotBottom + 3}
              className="iv-signal-density__axis-tick"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={tick.x}
              y={geometry.plotBottom + 12}
              textAnchor="middle"
              className="iv-signal-density__axis-label"
            >
              {tick.label}
            </text>
          </g>
        ))}
        <text
          x={ivScannerAxisTitleX(geometry)}
          y={height - 3}
          textAnchor="middle"
          className="iv-signal-density__axis-title"
        >
          BTC settlement price
        </text>
      </svg>
    </div>
  )
})

function diagnosticPlotScan(scan: IvSignalScan, diagnostic: boolean): IvSignalScan {
  if (!diagnostic || !scan.diagnosticDensity) return scan
  return {
    ...scan,
    density: scan.diagnosticDensity.strikesUsd.map((strike, index) => ({
      strike,
      raw: scan.diagnosticDensity!.rawDensity[index] ?? 0,
      smoothed: scan.diagnosticDensity!.rawDensity[index] ?? 0,
    })),
    markers: {
      ...scan.markers,
      bandLower: Number.NaN,
      bandUpper: Number.NaN,
      peakStrike: Number.NaN,
    },
    rnd: {
      ...scan.rnd,
      percentile05: Number.NaN,
      percentile25: Number.NaN,
      percentile50: Number.NaN,
      percentile75: Number.NaN,
      percentile95: Number.NaN,
    },
  }
}

function buildDensityGeometry(
  scan: IvSignalScan,
  width: number,
  height: number,
  diagnostic = false,
): DensityGeometry | null {
  const density = scan.density.filter(
    (point) => Number.isFinite(point.strike) && Number.isFinite(point.smoothed),
  )
  if (density.length < 2) return null

  const compact = height < 200
  const provisional = ivScannerPlotBox(width, height, ['0'])
  const densityMinStrike = density[0]!.strike
  const densityMaxStrike = density[density.length - 1]!.strike
  const values = density.map((point) => point.smoothed)
  const rawMin = Math.min(0, ...values)
  const rawMax = Math.max(0, ...values)
  const positiveMax = Math.max(rawMax, 1e-12)
  const supportThreshold = positiveMax * 0.02
  const supportLeftOpen = Math.max(density[0]!.smoothed, 0) > supportThreshold
  const supportRightOpen = Math.max(density[density.length - 1]!.smoothed, 0) > supportThreshold
  const viewportStrikes = [
    densityMinStrike,
    densityMaxStrike,
    scan.rnd.forward,
    ...(diagnostic ? [] : [
      scan.spotPrice,
      scan.rnd.percentile05,
      scan.rnd.percentile95,
      scan.rnd.sigmaLeftStrike,
      scan.rnd.sigmaRightStrike,
    ]),
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
  let minStrike = Math.min(...viewportStrikes)
  let maxStrike = Math.max(...viewportStrikes)
  if (!(maxStrike > minStrike)) return null
  const strikeSpan = maxStrike - minStrike
  const minimumSupportGutter = strikeSpan * 0.045
  if (supportLeftOpen && densityMinStrike - minStrike < minimumSupportGutter) {
    minStrike -= strikeSpan * 0.07
  }
  if (supportRightOpen && maxStrike - densityMaxStrike < minimumSupportGutter) {
    maxStrike += strikeSpan * 0.07
  }

  const headroomRatio = compact ? 0.12 : 0.08
  const maxDensity = positiveMax * (1 + headroomRatio)
  const minDensity = rawMin < 0
    ? Math.min(rawMin * 1.18, -maxDensity * 0.02)
    : -maxDensity * 0.02
  const yAxis = buildDensityYTicks(
    minDensity,
    maxDensity,
    provisional.plotTop,
    provisional.plotBottom,
  )
  const { plotTop, plotBottom, plotLeft, plotRight } = ivScannerPlotBox(
    width,
    height,
    yAxis.map((tick) => tick.label),
  )
  const toX = (strike: number) => plotLeft
    + ((strike - minStrike) / (maxStrike - minStrike)) * (plotRight - plotLeft)
  const toY = (value: number) => plotTop
    + ((maxDensity - value) / (maxDensity - minDensity)) * (plotBottom - plotTop)

  const points = density.map((point) => ({ x: toX(point.strike), y: toY(point.smoothed) }))
  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
  const baselineY = toY(0)
  const first = points[0]!
  const last = points[points.length - 1]!
  const areaPath = `M ${first.x.toFixed(2)} ${baselineY.toFixed(2)} ${points
    .map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')} L ${last.x.toFixed(2)} ${baselineY.toFixed(2)} Z`

  return {
    linePath,
    areaPath,
    points,
    baselineY,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    minStrike,
    maxStrike,
    dataMinStrike: densityMinStrike,
    dataMaxStrike: densityMaxStrike,
    minDensity,
    maxDensity,
    ticks: buildStrikeTicks(minStrike, maxStrike, plotLeft, plotRight),
    yTicks: yAxis,
    supportLeftOpen,
    supportRightOpen,
    cumulative: buildCumulative(density),
  }
}

function buildCumulative(
  density: Array<{ strike: number; smoothed: number }>,
): number[] {
  const cumulative = new Array<number>(density.length).fill(0)
  let area = 0
  for (let index = 1; index < density.length; index += 1) {
    const previous = density[index - 1]!
    const current = density[index]!
    const width = current.strike - previous.strike
    if (width > 0) {
      area += 0.5 * (Math.max(0, previous.smoothed) + Math.max(0, current.smoothed)) * width
    }
    cumulative[index] = area
  }
  const total = area > 0 ? area : 1
  return cumulative.map((value) => value / total)
}

function buildStrikeTicks(
  min: number,
  max: number,
  plotLeft: number,
  plotRight: number,
): Array<{ value: number; x: number; label: string }> {
  const span = max - min
  if (!(span > 0)) return []
  return [0, 1, 2, 3].map((index) => {
    const value = min + (span * index) / 3
    const x = plotLeft + ((plotRight - plotLeft) * index) / 3
    return { value, x, label: formatCompactStrike(value) }
  })
}

function scaleStrike(strike: number, geometry: DensityGeometry): number {
  const ratio = (strike - geometry.minStrike) / (geometry.maxStrike - geometry.minStrike)
  return geometry.plotLeft + clamp(ratio, 0, 1) * (geometry.plotRight - geometry.plotLeft)
}

function nearestDensityIndex(scan: IvSignalScan, strike: number): number {
  if (scan.density.length === 0) return 0
  const range = scan.density[scan.density.length - 1]!.strike - scan.density[0]!.strike
  if (!(range > 0)) return 0
  return clampIndex(
    Math.round(((strike - scan.density[0]!.strike) / range) * (scan.density.length - 1)),
    scan.density.length,
  )
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function formatStrike(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function formatCompactStrike(value: number): string {
  if (Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`
  }
  return `$${Math.round(value)}`
}

function formatProbability(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}
