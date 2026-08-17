import { memo, useId, useMemo, useRef, useState } from 'react'
import type { IvSignalScan, IvSignalSmilePoint } from '@/api/ivSignalScanner'
import {
  buildVolYTicks,
  ivScannerAxisTitleX,
  ivScannerPlotBox,
  ivScannerYAxisAnchor,
  ivScannerYTickLabelX,
  type IvScannerYTick,
} from '@/data/ivScannerChartLayout'
import {
  deltaTicks,
  isSyntheticSmileMark,
  logMoneynessTicks,
  projectSmileX,
  projectSmileY,
  smileAxisValue,
  type SmileAxis,
} from '@/data/ivSignalSmileGeometry'
import { smileUnavailableCopy } from '@/data/ivSignalSmileCopy'
import { SYNTHETIC_ATM_TOOLTIP } from '@/data/optionsSurfaceDisplay'
import { useContainerSize } from '@/hooks/useContainerSize'
import { cn } from '@/lib/utils'

export type { SmileAxis }

type IvSignalSmileChartProps = {
  scan: IvSignalScan
  axis: SmileAxis
  className?: string
}

const FALLBACK_WIDTH = 400
const FALLBACK_HEIGHT = 221

export const IvSignalSmileChart = memo(function IvSignalSmileChart({
  scan,
  axis,
  className,
}: IvSignalSmileChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const clipId = useId().replace(/:/g, '')
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const { width, height } = useContainerSize(hostRef, FALLBACK_WIDTH, FALLBACK_HEIGHT, {
    minWidth: 180,
    minHeight: 188,
  })
  const geometry = useMemo(
    () => buildSmileGeometry(scan, width, height, axis),
    [axis, height, scan, width],
  )

  if (!geometry) {
    return (
      <div ref={hostRef} className={cn('iv-signal-smile', className)}>
        <div className="iv-signal-smile__empty">{smileUnavailableCopy(scan)}</div>
      </div>
    )
  }

  const activePoint = activeIndex == null ? null : geometry.points[activeIndex] ?? null
  const xTitle = axis === 'delta' ? 'Option delta' : 'Log-moneyness vs forward'
  const tooltip = activePoint ? tooltipLines(activePoint, axis) : []
  const tooltipWidth = 158
  const tooltipHeight = 12 + tooltip.length * 13
  const tooltipX = activePoint == null
    ? 0
    : clamp(
        activePoint.x + 10 + tooltipWidth <= width - 5
          ? activePoint.x + 10
          : activePoint.x - tooltipWidth - 10,
        5,
        Math.max(5, width - tooltipWidth - 5),
      )
  const tooltipY = activePoint == null
    ? 0
    : clamp(activePoint.y - tooltipHeight - 8, geometry.plotTop + 3, geometry.plotBottom - tooltipHeight - 2)
  const yTitle = ivScannerYAxisAnchor(geometry)

  return (
    <div
      ref={hostRef}
      className={cn(
        'iv-signal-smile',
        scan.display?.smileStatus !== 'accepted' && 'iv-signal-smile--diagnostic',
        className,
      )}
      onPointerLeave={() => setActiveIndex(null)}
      onMouseLeave={() => setActiveIndex(null)}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="iv-signal-smile__svg"
        role="img"
        aria-label={`Implied volatility smile for ${scan.expiry}. Observed option IVs and fitted market smile.`}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (!(rect.width > 0) || geometry.points.length === 0) return
          const pointerX = ((event.clientX - rect.left) / rect.width) * width
          let index = 0
          let nearest = Number.POSITIVE_INFINITY
          geometry.points.forEach((point, pointIndex) => {
            const distance = Math.abs(point.x - pointerX)
            if (distance < nearest) {
              nearest = distance
              index = pointIndex
            }
          })
          setActiveIndex((current) => current === index ? current : index)
        }}
        onPointerLeave={() => setActiveIndex(null)}
        onPointerCancel={() => setActiveIndex(null)}
      >
        <defs>
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
          <line
            x1={geometry.atmX}
            x2={geometry.atmX}
            y1={geometry.plotTop}
            y2={geometry.plotBottom}
            className="iv-signal-smile__atm"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={geometry.plotLeft}
            x2={geometry.plotRight}
            y1={geometry.plotBottom}
            y2={geometry.plotBottom}
            className="iv-signal-smile__baseline"
            vectorEffect="non-scaling-stroke"
          />
          <path d={geometry.linePath} className="iv-signal-smile__fit" vectorEffect="non-scaling-stroke" />
          {geometry.points.map((point, index) => (
            isSyntheticSmileMark(point) ? (
              <rect
                key={`${point.strike}-${point.classification}`}
                x={point.x - 2.4}
                y={point.y - 2.4}
                width={4.8}
                height={4.8}
                transform={`rotate(45 ${point.x} ${point.y})`}
                className={cn(
                  'iv-signal-smile__dot iv-signal-smile__dot--synthetic',
                  activeIndex === index && 'iv-signal-smile__dot--active',
                )}
              />
            ) : (
              <circle
                key={`${point.strike}-${point.classification}`}
                cx={point.x}
                cy={point.y}
                r="2.3"
                className={cn(
                  'iv-signal-smile__dot',
                  `iv-signal-smile__dot--${point.optionSide}`,
                  point.classification === 'fallback' && 'iv-signal-smile__dot--fallback',
                  activeIndex === index && 'iv-signal-smile__dot--active',
                )}
              />
            )
          ))}
          {activePoint ? (
            <g className="iv-signal-smile__tooltip" pointerEvents="none">
              <rect
                x={tooltipX}
                y={tooltipY}
                width={tooltipWidth}
                height={tooltipHeight}
                rx={2}
                className="iv-signal-density__tooltip-bg"
              />
              {tooltip.map((line, index) => (
                <text
                  key={line}
                  x={tooltipX + 8}
                  y={tooltipY + 14 + index * 13}
                  className={index === 0 ? 'iv-signal-density__tooltip-title' : 'iv-signal-density__tooltip-value'}
                >
                  {line}
                </text>
              ))}
            </g>
          ) : null}
        </g>
        {geometry.yTicks.map((tick) => (
          <g key={`y-${tick.value}`}>
            <line
              x1={geometry.plotLeft - 3}
              x2={geometry.plotLeft}
              y1={tick.y}
              y2={tick.y}
              className="iv-signal-density__axis-tick"
              vectorEffect="non-scaling-stroke"
            />
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
          Implied volatility
        </text>
        {geometry.ticks.map((tick) => (
          <g key={`${tick.label}-${tick.x}`}>
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
          {xTitle}
        </text>
      </svg>
    </div>
  )
})

type PlottedSmilePoint = IvSignalSmilePoint & { x: number; y: number }

type SmileGeometry = {
  plotLeft: number
  plotRight: number
  plotTop: number
  plotBottom: number
  atmX: number
  linePath: string
  points: PlottedSmilePoint[]
  ticks: Array<{ x: number; label: string }>
  yTicks: IvScannerYTick[]
}

function buildSmileGeometry(
  scan: IvSignalScan,
  width: number,
  height: number,
  axis: SmileAxis,
): SmileGeometry | null {
  const fit = scan.smile.fit.filter((point) => Number.isFinite(smileAxisValue(point, axis)) && point.ivPercent > 0)
  const accepted = scan.smile.points.filter((point) => Number.isFinite(smileAxisValue(point, axis)) && point.ivPercent > 0)
  if (fit.length < 2 || accepted.length < 2) return null

  const provisional = ivScannerPlotBox(width, height, ['40%'])
  const xs = [
    ...fit.map((point) => smileAxisValue(point, axis)),
    ...accepted.map((point) => smileAxisValue(point, axis)),
  ].filter((value): value is number => Number.isFinite(value))
  const ys = [
    ...fit.map((point) => point.ivPercent),
    ...accepted.map((point) => normalizeIvPercent(point.ivPercent, point.iv)),
  ].filter((value) => value >= 3)
  let minX = Math.min(...xs)
  let maxX = Math.max(...xs)
  if (!(maxX > minX)) {
    minX -= 0.05
    maxX += 0.05
  }
  if (ys.length === 0) return null
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const yPad = Math.max(0.4, (maxY - minY) * 0.12)
  const yTicks = buildVolYTicks(minY - yPad, maxY + yPad, provisional.plotTop, provisional.plotBottom)
  const { plotTop, plotBottom, plotLeft, plotRight } = ivScannerPlotBox(
    width,
    height,
    yTicks.map((tick) => tick.label),
  )
  const scale = {
    minX,
    maxX,
    minY: minY - yPad,
    maxY: maxY + yPad,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
  }
  const toX = (value: number) => projectSmileX(value, scale)
  const toY = (value: number) => projectSmileY(value, scale)

  const fitPoints = [...fit]
    .map((point) => ({
      x: toX(smileAxisValue(point, axis)),
      y: toY(point.ivPercent),
      order: smileAxisValue(point, axis),
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((left, right) => left.order - right.order)
  if (fitPoints.length < 2) return null

  const candidates = axis === 'delta' ? deltaTicks(minX, maxX) : logMoneynessTicks(minX, maxX)
  const ticks = candidates.map((value) => ({
    x: toX(value),
    label: formatAxisTick(value, axis),
  }))

  return {
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    atmX: toX(0),
    linePath: fitPoints
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(' '),
    points: accepted.map((point) => {
      const xValue = smileAxisValue(point, axis)
      const ownIv = normalizeIvPercent(point.ivPercent, point.iv)
      return {
        ...point,
        x: toX(xValue),
        y: toY(ownIv),
      }
    }),
    ticks,
    yTicks,
  }
}

function normalizeIvPercent(ivPercent: number, iv: number): number {
  if (ivPercent >= 3) return ivPercent
  if (iv > 0 && iv < 3) return iv * 100
  return ivPercent
}

function formatAxisTick(value: number, axis: SmileAxis): string {
  if (Math.abs(value) < 1e-9) return 'ATM'
  if (axis === 'delta') {
    const body = Math.abs(value).toFixed(2)
    return value < 0 ? `−${body}` : `+${body}`
  }
  const percent = value * 100
  return `${percent < 0 ? '−' : '+'}${Math.abs(percent).toFixed(0)}%`
}

function tooltipLines(point: IvSignalSmilePoint, axis: SmileAxis): string[] {
  if (isSyntheticSmileMark(point)) {
    return [
      `${formatStrike(point.strike)} · ${formatIv(point.ivPercent)}`,
      SYNTHETIC_ATM_TOOLTIP,
    ]
  }
  const lines = [
    `${formatSide(point.optionSide)} · ${formatStrike(point.strike)}`,
    `${axis === 'delta' ? formatDelta(point.delta) : formatMoneyness(point.logMoneyness)} · ${formatIv(point.ivPercent)}`,
  ]
  if (point.bidIv != null && point.askIv != null) {
    lines.push(`Bid ${formatIv(point.bidIv * 100)} / Ask ${formatIv(point.askIv * 100)}`)
  }
  lines.push(formatClassification(point))
  return lines
}

export function isSyntheticMark(point: Pick<IvSignalSmilePoint, 'synthetic' | 'classification' | 'optionSide'>): boolean {
  return isSyntheticSmileMark(point)
}

function formatStrike(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function formatIv(value: number): string {
  return `${value.toFixed(1)}%`
}

function formatDelta(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Δ —'
  const body = Math.abs(value).toFixed(2)
  if (value < 0) return `Δ −${body}`
  if (value > 0) return `Δ +${body}`
  return 'Δ 0.00'
}

function formatMoneyness(value: number): string {
  const percent = value * 100
  const sign = percent > 0 ? '+' : percent < 0 ? '−' : ''
  return `${sign}${Math.abs(percent).toFixed(1)}%`
}

function formatSide(side: IvSignalSmilePoint['optionSide']): string {
  if (side === 'put') return 'Put'
  if (side === 'call') return 'Call'
  if (side === 'merged') return 'ATM'
  return 'Quoted'
}

function formatClassification(value: IvSignalSmilePoint): string {
  if (value.classification === 'fallback') return 'fallback'
  if (value.classification === 'synthetic' || value.optionSide === 'merged') return 'ATM merge'
  return 'preferred'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
