import { useEffect, useMemo, useRef, useState } from 'react'
import { scaleBand, scaleLinear } from 'd3-scale'
import type { ScaleLinear } from 'd3-scale'
import { formatAxisMillions, formatMillions, formatStrike } from '@/lib/formatters'

export type GexMode = 'net' | 'split' | 'call' | 'put' | 'abs' | 'profile'

export type GexSnapshot = {
  spot: number
  gammaBars: GexSourceRow[]
}

type GexSourceRow = {
  strike: number
  gammaExposureUsd: number
  callGammaExposureUsd?: number
  putGammaExposureUsd?: number
  netGammaExposureUsd?: number
}

export type GexProfileChartProps = {
  snapshot: GexSnapshot
  mode: GexMode
  dataWindowPct: number | 'full'
}

type ChartDatum = {
  strike: number
  netGexUsd: number
  callGexUsd: number
  putGexUsd: number
  displayGexUsd: number
}

type HoverState = {
  datum: ChartDatum
  xPct: number
  yPct: number
}

type ChartDimensions = {
  width: number
  height: number
  margin: {
    top: number
    right: number
    bottom: number
    left: number
  }
}

const defaultWidth = 1120
const minChartWidth = 720
const rowHeight = 12.5
const margin = { top: 66, right: 108, bottom: 56, left: 86 }

export function GexProfileChart({ snapshot, mode, dataWindowPct }: GexProfileChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const measuredWidth = useContainerWidth(containerRef, defaultWidth)
  const data = useMemo(
    () => prepareChartData(snapshot, mode, dataWindowPct),
    [snapshot, mode, dataWindowPct],
  )
  const dimensions = getChartDimensions(measuredWidth, data.length)
  const layout = useMemo(() => getChartLayout(data, snapshot.spot, dimensions), [data, dimensions, snapshot.spot])
  const [hovered, setHovered] = useState<HoverState | null>(null)
  const chartRight = dimensions.margin.left + layout.innerWidth

  return (
    <div ref={containerRef} className="relative h-full min-h-[516px] w-full overflow-hidden">
      <svg
        width="100%"
        height={dimensions.height}
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        role="img"
        aria-label="BTC gamma exposure profile by strike"
        className="block"
        onMouseLeave={() => setHovered(null)}
      >
        <defs>
          <linearGradient id="chart-panel-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0a1115" />
            <stop offset="52%" stopColor="#061012" />
            <stop offset="100%" stopColor="#04090a" />
          </linearGradient>
          <linearGradient id="positive-gex-fill" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#1b562f" />
            <stop offset="58%" stopColor="#20b947" />
            <stop offset="100%" stopColor="#55ee6d" />
          </linearGradient>
          <linearGradient id="negative-gex-fill" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#ff483f" />
            <stop offset="58%" stopColor="#c8201e" />
            <stop offset="100%" stopColor="#57211f" />
          </linearGradient>
          <linearGradient id="profile-gex-fill" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#87928d" />
            <stop offset="50%" stopColor="#d6dfd9" />
            <stop offset="100%" stopColor="#87928d" />
          </linearGradient>
          <filter id="positive-gex-glow" x="-20%" y="-100%" width="140%" height="300%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="negative-gex-glow" x="-20%" y="-100%" width="140%" height="300%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width={dimensions.width} height={dimensions.height} fill="url(#chart-panel-fill)" />
        <rect
          x={dimensions.margin.left}
          y={dimensions.margin.top}
          width={layout.innerWidth}
          height={layout.innerHeight}
          fill="#071013"
          opacity="0.78"
        />

        <text x={24} y={29} fill="#f4eee4" fontSize={20} fontFamily="var(--font-sans)">
          {modeLabel(mode)} Gamma Exposure Profile
        </text>
        <text x={24} y={58} fill="#6fb6ba" fontSize={12} letterSpacing={1}>
          STRIKE (USD)
        </text>

        {layout.xTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={layout.xScale(tick)}
              x2={layout.xScale(tick)}
              y1={dimensions.margin.top}
              y2={dimensions.margin.top + layout.innerHeight}
              stroke={tick === 0 ? '#ece7dc' : '#596566'}
              strokeDasharray={tick === 0 ? undefined : '2 7'}
              strokeOpacity={tick === 0 ? 0.9 : 0.5}
              strokeWidth={tick === 0 ? 2 : 1}
            />
            <text
              x={layout.xScale(tick)}
              y={dimensions.height - 34}
              textAnchor="middle"
              fill="#d2cbc0"
              fontSize={14}
              fontFamily="var(--font-mono)"
            >
              {formatAxisMillions(tick)}
            </text>
          </g>
        ))}

        {data.map((datum) => {
          const rowTop = layout.yScale(datum.strike) ?? dimensions.margin.top
          const rowCenter = rowTop + layout.yScale.bandwidth() / 2
          const isClosestSpot = datum.strike === layout.closestSpotStrike
          const isHovered = hovered?.datum.strike === datum.strike
          const bar = getBarGeometry(datum.displayGexUsd, layout.xScale, rowCenter)
          const barHeight = getBarHeight(layout.yScale.bandwidth())
          const positive = datum.displayGexUsd >= 0
          const stroke = positive ? '#68c957' : '#ff3f37'
          const tooltipX = getTooltipX(bar, dimensions)

          return (
            <g
              key={datum.strike}
              onMouseEnter={() =>
                setHovered({
                  datum,
                  xPct: tooltipX,
                  yPct: (rowCenter / dimensions.height) * 100,
                })
              }
              onMouseMove={() =>
                setHovered({
                  datum,
                  xPct: tooltipX,
                  yPct: (rowCenter / dimensions.height) * 100,
                })
              }
            >
              {isClosestSpot ? (
                <rect
                  x={dimensions.margin.left}
                  y={rowTop}
                  width={layout.innerWidth}
                  height={layout.yScale.bandwidth()}
                  fill="#1c3326"
                  opacity="0.34"
                />
              ) : null}
              {isHovered ? (
                <rect
                  x={dimensions.margin.left}
                  y={rowTop}
                  width={layout.innerWidth}
                  height={layout.yScale.bandwidth()}
                  fill="#122023"
                  opacity="0.9"
                />
              ) : null}
              <text
                x={54}
                y={rowCenter + 4}
                textAnchor="middle"
                fill={isClosestSpot ? '#f2d7a8' : '#d1cbc0'}
                fontSize={13}
                fontWeight={isClosestSpot ? 700 : 400}
                fontFamily="var(--font-mono)"
              >
                {formatStrike(datum.strike)}
              </text>
              {mode === 'split' ? (
                <SplitBars datum={datum} xScale={layout.xScale} y={rowCenter} rowHeight={barHeight} />
              ) : mode === 'profile' ? (
                <ProfileBar datum={datum} xScale={layout.xScale} y={rowCenter} rowHeight={barHeight} />
              ) : (
                <SingleBar bar={bar} positive={positive} stroke={stroke} height={barHeight} />
              )}
              <rect
                x={dimensions.margin.left}
                y={rowTop}
                width={layout.innerWidth}
                height={layout.yScale.bandwidth()}
                fill="transparent"
              />
            </g>
          )
        })}

        <line
          x1={dimensions.margin.left}
          x2={chartRight}
          y1={layout.spotY}
          y2={layout.spotY}
          stroke="#e8e4d9"
          strokeWidth={1.5}
          strokeDasharray="5 7"
        />
        <g transform={`translate(${chartRight - 6} ${layout.spotY})`}>
          <rect x="0" y="-16" width="98" height="32" rx="4" fill="#101413" stroke="#bca682" />
          <text
            x="49"
            y="1"
            fill="#f7ecda"
            fontSize={13}
            textAnchor="middle"
            dominantBaseline="middle"
            fontFamily="var(--font-mono)"
            fontWeight={600}
          >
            Spot {formatStrike(snapshot.spot)}
          </text>
        </g>

        <text
          x={dimensions.margin.left + layout.innerWidth / 2}
          y={dimensions.height - 12}
          textAnchor="middle"
          fill="#5db5b2"
          fontSize={14}
        >
          Gamma Exposure (USD)
        </text>
      </svg>

      {hovered ? (
        <div
          className="pointer-events-none absolute z-10 min-w-44 rounded-[4px] border border-[#596568] bg-[#060b0d]/95 px-3 py-2 text-left text-xs text-[#d8d4ca] shadow-2xl backdrop-blur"
          style={{
            left: `${hovered.xPct}%`,
            top: `${hovered.yPct}%`,
            transform: 'translate(12px, -50%)',
          }}
        >
          <div className="mb-1 text-[#f3dfb8]">Strike {formatStrike(hovered.datum.strike)}</div>
          <div className={hovered.datum.netGexUsd >= 0 ? 'terminal-value text-[#51cf66]' : 'terminal-value text-[#ff4b43]'}>
            Net GEX {formatMillions(hovered.datum.netGexUsd)}
          </div>
          <div className="terminal-value mt-1 text-[#6fcf64]">Calls {formatMillions(hovered.datum.callGexUsd)}</div>
          <div className="terminal-value text-[#ff5a4f]">Puts {formatMillions(hovered.datum.putGexUsd)}</div>
          <div className="text-[#9f978b]">Mode {modeLabel(mode)}</div>
        </div>
      ) : null}
    </div>
  )
}

function useContainerWidth(ref: React.RefObject<HTMLDivElement | null>, fallbackWidth: number) {
  const [width, setWidth] = useState(fallbackWidth)

  useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }

    const updateWidth = () => {
      setWidth(Math.max(minChartWidth, Math.floor(element.getBoundingClientRect().width)))
    }
    updateWidth()

    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)

    return () => observer.disconnect()
  }, [ref])

  return width
}

function prepareChartData(snapshot: GexSnapshot, mode: GexMode, dataWindowPct: number | 'full'): ChartDatum[] {
  const rowsInWindow = snapshot.gammaBars.filter((row) => isStrikeInDataWindow(row.strike, snapshot.spot, dataWindowPct))
  const sourceRows = rowsInWindow.length > 0 ? rowsInWindow : snapshot.gammaBars
  const visibleRows = getReadableStrikeRows(sourceRows)
  const rows = visibleRows
    .map((row) => toChartDatum(row, mode))
    .sort((a, b) => b.strike - a.strike)

  return rows
}

function getReadableStrikeRows(rows: GexSourceRow[]) {
  if (rows.length <= 34) {
    return rows
  }

  const majorRows = rows.filter((row) => row.strike % 1_000 === 0)

  return majorRows.length > 0 ? majorRows : rows
}

function isStrikeInDataWindow(strike: number, spot: number, dataWindowPct: number | 'full') {
  if (dataWindowPct === 'full') {
    return true
  }

  const windowPct = normalizeWindowPct(dataWindowPct)
  const lowerStrike = spot * (1 - windowPct / 100)
  const upperStrike = spot * (1 + windowPct / 100)

  return strike >= lowerStrike && strike <= upperStrike
}

function normalizeWindowPct(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 18
}

function toChartDatum(row: GexSourceRow, mode: GexMode): ChartDatum {
  const net = row.netGammaExposureUsd ?? row.gammaExposureUsd
  const call = row.callGammaExposureUsd ?? Math.max(net, 0)
  const put = row.putGammaExposureUsd ?? Math.min(net, 0)

  return {
    strike: row.strike,
    netGexUsd: net,
    callGexUsd: call,
    putGexUsd: put,
    displayGexUsd: getDisplayExposureValue(net, call, put, mode),
  }
}

function getDisplayExposureValue(net: number, call: number, put: number, mode: GexMode) {
  if (mode === 'call') return call
  if (mode === 'put') return put
  if (mode === 'abs') return Math.abs(net)
  return net
}

function getChartDimensions(width: number, rowCount: number): ChartDimensions {
  return {
    width,
    height: Math.max(516, margin.top + margin.bottom + rowCount * rowHeight),
    margin,
  }
}

function getChartLayout(data: ChartDatum[], spot: number, dimensions: ChartDimensions) {
  const innerWidth = dimensions.width - dimensions.margin.left - dimensions.margin.right
  const innerHeight = dimensions.height - dimensions.margin.top - dimensions.margin.bottom
  const maxAbsGex = Math.max(...data.flatMap((datum) => [
    Math.abs(datum.displayGexUsd),
    Math.abs(datum.callGexUsd),
    Math.abs(datum.putGexUsd),
  ]), 10_000_000)
  const domainMax = Math.ceil(maxAbsGex / 10_000_000) * 10_000_000
  const strikes = data.map((datum) => datum.strike)
  const minStrike = Math.min(...strikes, spot)
  const maxStrike = Math.max(...strikes, spot)
  const xScale = scaleLinear<number, number>()
    .domain([-domainMax, domainMax])
    .range([dimensions.margin.left, dimensions.margin.left + innerWidth])
  const yScale = scaleBand<number>()
    .domain(strikes)
    .range([dimensions.margin.top, dimensions.margin.top + innerHeight])
    .padding(0.18)
  const strikeScale = scaleLinear<number, number>()
    .domain([minStrike, maxStrike])
    .range([dimensions.margin.top + innerHeight, dimensions.margin.top])

  return {
    innerWidth,
    innerHeight,
    xScale,
    yScale,
    spotY: strikeScale(spot),
    xTicks: buildMillionTicks(domainMax),
    closestSpotStrike: getClosestStrike(strikes, spot),
  }
}

function buildMillionTicks(domainMax: number) {
  const ticks: number[] = []
  const step = getTickStep(domainMax)
  const maxTick = Math.max(step, Math.floor(domainMax / step) * step)

  for (let tick = -maxTick; tick <= maxTick; tick += step) {
    ticks.push(tick)
  }

  return ticks
}

function getTickStep(domainMax: number) {
  if (domainMax <= 60_000_000) {
    return 10_000_000
  }

  if (domainMax <= 120_000_000) {
    return 20_000_000
  }

  if (domainMax <= 250_000_000) {
    return 50_000_000
  }

  return 100_000_000
}

function getClosestStrike(strikes: number[], spot: number) {
  return strikes.reduce((closest, strike) => {
    return Math.abs(strike - spot) < Math.abs(closest - spot) ? strike : closest
  }, strikes[0] ?? spot)
}

function getBarGeometry(value: number, xScale: ScaleLinear<number, number>, y: number) {
  const zeroX = xScale(0)
  const valueX = xScale(value)

  return {
    x1: zeroX,
    x2: valueX,
    x: Math.min(zeroX, valueX),
    width: Math.abs(valueX - zeroX),
    y,
  }
}

type BarGeometry = ReturnType<typeof getBarGeometry>

function getBarHeight(bandwidth: number) {
  return Math.max(5, Math.min(9.5, bandwidth * 0.72))
}

function getTooltipX(bar: BarGeometry, dimensions: ChartDimensions) {
  const anchor = bar.x2 >= bar.x1 ? bar.x2 : bar.x

  return (Math.max(dimensions.margin.left, Math.min(anchor, dimensions.width - dimensions.margin.right)) / dimensions.width) * 100
}

function SingleBar({
  bar,
  positive,
  stroke,
  height,
}: {
  bar: BarGeometry
  positive: boolean
  stroke: string
  height: number
}) {
  if (bar.width < 0.5) {
    return null
  }

  return (
    <>
      <rect
        x={bar.x}
        y={bar.y - height / 2}
        width={bar.width}
        height={height}
        rx={0.5}
        fill={positive ? 'url(#positive-gex-fill)' : 'url(#negative-gex-fill)'}
        fillOpacity={0.9}
        stroke={stroke}
        strokeOpacity={0.82}
        strokeWidth={1}
        filter={positive ? 'url(#positive-gex-glow)' : 'url(#negative-gex-glow)'}
      />
      <line
        x1={bar.x}
        x2={bar.x + bar.width}
        y1={bar.y - height / 2 + 1}
        y2={bar.y - height / 2 + 1}
        stroke={positive ? '#b7f191' : '#ff9c83'}
        strokeWidth={1}
        strokeOpacity={0.45}
      />
    </>
  )
}

function SplitBars({
  datum,
  xScale,
  y,
  rowHeight,
}: {
  datum: ChartDatum
  xScale: ScaleLinear<number, number>
  y: number
  rowHeight: number
}) {
  const splitHeight = Math.max(3, rowHeight * 0.45)
  const callBar = getBarGeometry(datum.callGexUsd, xScale, y - splitHeight * 0.56)
  const putBar = getBarGeometry(datum.putGexUsd, xScale, y + splitHeight * 0.56)

  return (
    <>
      <SingleBar bar={callBar} positive stroke="#62d05d" height={splitHeight} />
      <SingleBar bar={putBar} positive={false} stroke="#ff4138" height={splitHeight} />
    </>
  )
}

function ProfileBar({
  datum,
  xScale,
  y,
  rowHeight,
}: {
  datum: ChartDatum
  xScale: ScaleLinear<number, number>
  y: number
  rowHeight: number
}) {
  const absBar = getBarGeometry(Math.abs(datum.netGexUsd), xScale, y)
  const netBar = getBarGeometry(datum.netGexUsd, xScale, y)
  const positive = datum.netGexUsd >= 0
  const backgroundHeight = Math.max(4, rowHeight * 0.78)
  const foregroundHeight = Math.max(3, rowHeight * 0.42)

  return (
    <>
      <rect
        x={absBar.x}
        y={absBar.y - backgroundHeight / 2}
        width={absBar.width}
        height={backgroundHeight}
        rx={0.5}
        fill="url(#profile-gex-fill)"
        fillOpacity={0.36}
        stroke="#c2cbc4"
        strokeOpacity={0.24}
      />
      <SingleBar bar={netBar} positive={positive} stroke={positive ? '#68c957' : '#ff3f37'} height={foregroundHeight} />
    </>
  )
}

function modeLabel(mode: GexMode) {
  if (mode === 'net') {
    return 'Net'
  }

  if (mode === 'split') {
    return 'Split'
  }

  if (mode === 'call') {
    return 'Call'
  }

  if (mode === 'put') {
    return 'Put'
  }

  if (mode === 'abs') {
    return 'Abs'
  }

  if (mode === 'profile') {
    return 'Profile'
  }

  return 'Net'
}
