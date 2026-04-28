import { useEffect, useMemo, useRef, useState } from 'react'
import { scaleBand, scaleLinear } from 'd3-scale'
import type { ScaleLinear } from 'd3-scale'
import { area, curveMonotoneX, line } from 'd3-shape'
import { formatAxisMillions, formatMillions, formatStrike } from '@/lib/formatters'

export type GexMode = 'net' | 'split' | 'call' | 'put' | 'abs' | 'profile'

export type GexSnapshot = {
  spot: number
  gammaBars: GexSourceRow[]
}

export type GexLevelMarker = {
  id: string
  label: string
  strike: number
  color: string
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
  levelMarkers?: GexLevelMarker[]
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

type AreaChartLayout = {
  data: ChartDatum[]
  profileData: ChartDatum[]
  innerWidth: number
  innerHeight: number
  xScale: ScaleLinear<number, number>
  yScale: ScaleLinear<number, number>
  xTicks: number[]
  yTicks: number[]
  zeroY: number
  spotX: number
  levelMarkers: PositionedAreaLevelMarker[]
}

type PositionedBarLevelMarker = GexLevelMarker & {
  y: number
}

type PositionedAreaLevelMarker = GexLevelMarker & {
  x: number
}

const defaultWidth = 1120
const minChartWidth = 720
const chartHeight = 516
const margin = { top: 60, right: 102, bottom: 54, left: 78 }
const areaMargin = { top: 54, right: 30, bottom: 50, left: 104 }
const areaYAxisLabelX = 22

export function GexProfileChart({ snapshot, mode, dataWindowPct, levelMarkers = [] }: GexProfileChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const measuredWidth = useContainerWidth(containerRef, defaultWidth)
  const areaMode = mode === 'abs' || mode === 'profile'
  const data = useMemo(
    () => prepareChartData(snapshot, mode, dataWindowPct),
    [snapshot, mode, dataWindowPct],
  )
  const dimensions = areaMode ? getAreaChartDimensions(measuredWidth) : getChartDimensions(measuredWidth)
  const validLevelMarkers = useMemo(() => levelMarkers.filter((marker) => Number.isFinite(marker.strike)), [levelMarkers])
  const barLayout = useMemo(() => getChartLayout(data, snapshot.spot, dimensions, validLevelMarkers), [data, dimensions, snapshot.spot, validLevelMarkers])
  const areaLayout = useMemo(() => getAreaChartLayout(data, snapshot.spot, dimensions, mode, validLevelMarkers), [data, dimensions, mode, snapshot.spot, validLevelMarkers])
  const [hovered, setHovered] = useState<HoverState | null>(null)
  if (areaMode) {
    return (
      <div ref={containerRef} className="relative h-full min-h-[516px] w-full overflow-hidden">
        <AreaGexChart
          data={data}
          dimensions={dimensions}
          hovered={hovered}
          layout={areaLayout}
          mode={mode}
          setHovered={setHovered}
          spot={snapshot.spot}
        />
      </div>
    )
  }

  const layout = barLayout
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
            <stop offset="0%" stopColor="#0f1212" />
            <stop offset="55%" stopColor="#0a0d0d" />
            <stop offset="100%" stopColor="#070909" />
          </linearGradient>
          <linearGradient id="positive-gex-fill" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#6f8f55" />
            <stop offset="100%" stopColor="var(--chart-positive-edge)" />
          </linearGradient>
          <linearGradient id="negative-gex-fill" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--chart-negative-edge)" />
            <stop offset="100%" stopColor="#9a3e43" />
          </linearGradient>
          <linearGradient id="profile-gex-fill" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#6f7772" />
            <stop offset="50%" stopColor="#aeb6af" />
            <stop offset="100%" stopColor="#6f7772" />
          </linearGradient>
        </defs>

        <rect width={dimensions.width} height={dimensions.height} fill="url(#chart-panel-fill)" />
        <rect
          x={dimensions.margin.left}
          y={dimensions.margin.top}
          width={layout.innerWidth}
          height={layout.innerHeight}
          fill="var(--terminal-surface)"
          opacity="0.14"
        />

        <text x={22} y={29} fill="var(--terminal-heading)" fontSize={14} fontWeight={700} letterSpacing={1.4}>
          {chartTitle(mode)}
        </text>
        <text x={22} y={53} fill="var(--terminal-muted)" fontSize={10.5} letterSpacing={1.1}>
          STRIKE (USD)
        </text>

        {layout.xTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={layout.xScale(tick)}
              x2={layout.xScale(tick)}
              y1={dimensions.margin.top}
              y2={dimensions.margin.top + layout.innerHeight}
              stroke={tick === 0 ? 'var(--terminal-heading)' : 'var(--terminal-grid)'}
              strokeDasharray={tick === 0 ? undefined : '2 6'}
              strokeOpacity={tick === 0 ? 0.78 : 1}
              strokeWidth={tick === 0 ? 1.25 : 1}
            />
            <text
              x={layout.xScale(tick)}
              y={dimensions.height - 34}
              textAnchor="middle"
              fill="var(--terminal-muted)"
              fontSize={11}
              fontFamily="var(--font-mono)"
            >
              {formatAxisMillions(tick)}
            </text>
          </g>
        ))}

        {data.map((datum) => {
          const rowTop = layout.yScale(datum.strike) ?? dimensions.margin.top
          const rowCenter = rowTop + layout.yScale.bandwidth() / 2
          const isNearestSpotRow = datum.strike === layout.closestSpotStrike
          const isHovered = hovered?.datum.strike === datum.strike
          const levelMarker = getLevelMarkerAtStrike(layout.levelMarkers, datum.strike)
          const showStrikeLabel = isHovered || (!isNearestSpotRow && shouldShowYAxisStrike(datum.strike, dataWindowPct, Boolean(levelMarker)))
          const bar = getBarGeometry(datum.displayGexUsd, layout.xScale, rowCenter)
          const barHeight = getBarHeight(layout.yScale.bandwidth())
          const positive = datum.displayGexUsd >= 0
          const stroke = positive ? 'var(--chart-positive-edge)' : 'var(--chart-negative-edge)'
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
              {isHovered ? (
                <rect
                  x={dimensions.margin.left}
                  y={rowTop}
                  width={layout.innerWidth}
                  height={layout.yScale.bandwidth()}
                  fill="var(--terminal-surface-2)"
                  opacity="0.72"
                />
              ) : null}
              {showStrikeLabel ? (
                <text
                  x={50}
                  y={rowCenter + 4}
                  textAnchor="middle"
                  fill={levelMarker?.color ?? 'var(--terminal-muted)'}
                  fontSize={11.5}
                  fontWeight={levelMarker ? 700 : 400}
                  fontFamily="var(--font-mono)"
                >
                  {formatStrike(datum.strike)}
                </text>
              ) : null}
              {mode === 'split' ? (
                <SplitBars datum={datum} xScale={layout.xScale} y={rowCenter} rowHeight={barHeight} />
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

        <text
          x={50}
          y={layout.spotY + 4}
          textAnchor="middle"
          fill="var(--terminal-heading)"
          fontSize={11.5}
          fontWeight={700}
          fontFamily="var(--font-mono)"
        >
          {formatStrike(snapshot.spot)}
        </text>

        {layout.levelMarkers.map((marker, index) => (
          <BarLevelMarker
            key={marker.id}
            marker={marker}
            chartLeft={dimensions.margin.left}
            chartRight={chartRight}
            data={data}
            index={index}
          />
        ))}

        <line
          x1={dimensions.margin.left}
          x2={chartRight}
          y1={layout.spotY}
          y2={layout.spotY}
          stroke="var(--terminal-heading)"
          strokeWidth={1}
          strokeDasharray="4 6"
          strokeOpacity="0.6"
        />
        <g transform={`translate(${chartRight - 6} ${layout.spotY})`}>
          <rect x="0" y="-11" width="94" height="22" rx="2" fill="var(--terminal-surface)" stroke="var(--terminal-border-strong)" />
          <text
            x="47"
            y="1"
            fill="var(--terminal-heading)"
            fontSize={10.5}
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
          fill="var(--terminal-muted)"
          fontSize={10.5}
          letterSpacing={1.2}
        >
          GAMMA EXPOSURE (USD)
        </text>
      </svg>

      {hovered ? (
        <div
          className="pointer-events-none absolute z-10 min-w-44 rounded-[var(--terminal-radius-sm)] border border-[var(--terminal-border-strong)] bg-[var(--terminal-surface)]/95 px-3 py-2 text-left text-[11px] text-[var(--terminal-text)] shadow-2xl backdrop-blur"
          style={{
            left: `${hovered.xPct}%`,
            top: `${hovered.yPct}%`,
            transform: 'translate(12px, -50%)',
          }}
        >
          <div className="mb-1 text-[var(--terminal-heading)]">Strike {formatStrike(hovered.datum.strike)}</div>
          <div className={hovered.datum.netGexUsd >= 0 ? 'terminal-value text-[var(--terminal-green-strong)]' : 'terminal-value text-[var(--terminal-red-strong)]'}>
            Net GEX {formatMillions(hovered.datum.netGexUsd)}
          </div>
          <div className="terminal-value mt-1 text-[var(--terminal-green)]">Calls {formatMillions(hovered.datum.callGexUsd)}</div>
          <div className="terminal-value text-[var(--terminal-red)]">Puts {formatMillions(hovered.datum.putGexUsd)}</div>
          <div className="text-[var(--terminal-muted)]">Mode {modeLabel(mode)}</div>
        </div>
      ) : null}
    </div>
  )
}

function AreaGexChart({
  data,
  dimensions,
  hovered,
  layout,
  mode,
  setHovered,
  spot,
}: {
  data: ChartDatum[]
  dimensions: ChartDimensions
  hovered: HoverState | null
  layout: AreaChartLayout
  mode: 'abs' | 'profile'
  setHovered: (hovered: HoverState | null) => void
  spot: number
}) {
  const isAbsMode = mode === 'abs'
  const chartRight = dimensions.margin.left + layout.innerWidth
  const chartBottom = dimensions.margin.top + layout.innerHeight
  const callAreaPath = isAbsMode
    ? getAreaPath(layout.data, layout.xScale, layout.yScale, (datum) => Math.abs(datum.callGexUsd))
    : null
  const putAreaPath = isAbsMode
    ? getAreaPath(layout.data, layout.xScale, layout.yScale, (datum) => Math.abs(datum.putGexUsd))
    : null
  const callLinePath = isAbsMode
    ? getLinePath(layout.data, layout.xScale, layout.yScale, (datum) => Math.abs(datum.callGexUsd))
    : null
  const putLinePath = isAbsMode
    ? getLinePath(layout.data, layout.xScale, layout.yScale, (datum) => Math.abs(datum.putGexUsd))
    : null
  const positiveAreaPath = isAbsMode
    ? null
    : getSignedAreaPath(layout.profileData, layout.xScale, layout.yScale, (datum) => datum.netGexUsd >= 0)
  const negativeAreaPath = isAbsMode
    ? null
    : getSignedAreaPath(layout.profileData, layout.xScale, layout.yScale, (datum) => datum.netGexUsd <= 0)
  const positiveLinePath = isAbsMode
    ? null
    : getSignedLinePath(layout.profileData, layout.xScale, layout.yScale, (datum) => datum.netGexUsd >= 0)
  const negativeLinePath = isAbsMode
    ? null
    : getSignedLinePath(layout.profileData, layout.xScale, layout.yScale, (datum) => datum.netGexUsd <= 0)
  const hoveredDatum = hovered && layout.data.length > 0 ? getClosestDatumByStrike(layout.data, hovered.datum.strike) : null
  const hoverX = hoveredDatum ? layout.xScale(hoveredDatum.strike) : null
  const spotLabelX = getClampedLabelX(layout.spotX, dimensions.margin.left + 47, chartRight - 47)

  return (
    <>
      <svg
        width="100%"
        height={dimensions.height}
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        role="img"
        aria-label={isAbsMode ? 'BTC absolute call and put gamma exposure by strike' : 'BTC net gamma exposure profile by strike'}
        className="block"
        onMouseLeave={() => setHovered(null)}
      >
        <defs>
          <linearGradient id="chart-panel-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0f1212" />
            <stop offset="55%" stopColor="#0a0d0d" />
            <stop offset="100%" stopColor="#070909" />
          </linearGradient>
          <linearGradient id="abs-call-area-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-positive-edge)" stopOpacity="0.68" />
            <stop offset="100%" stopColor="var(--chart-positive)" stopOpacity="0.08" />
          </linearGradient>
          <linearGradient id="abs-put-area-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-negative-edge)" stopOpacity="0.64" />
            <stop offset="100%" stopColor="var(--chart-negative)" stopOpacity="0.07" />
          </linearGradient>
          <linearGradient id="profile-positive-area-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-positive-edge)" stopOpacity="0.7" />
            <stop offset="100%" stopColor="var(--chart-positive)" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id="profile-negative-area-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-negative)" stopOpacity="0.12" />
            <stop offset="100%" stopColor="var(--chart-negative-edge)" stopOpacity="0.68" />
          </linearGradient>
        </defs>

        <rect width={dimensions.width} height={dimensions.height} fill="url(#chart-panel-fill)" />
        <rect
          x={dimensions.margin.left}
          y={dimensions.margin.top}
          width={layout.innerWidth}
          height={layout.innerHeight}
          fill="var(--terminal-surface)"
          opacity="0.14"
        />

        <text x={22} y={29} fill="var(--terminal-heading)" fontSize={14} fontWeight={700} letterSpacing={1.4}>
          {isAbsMode ? 'ABS CALL/PUT GAMMA EXPOSURE' : 'NET GAMMA EXPOSURE PROFILE'}
        </text>

        {layout.yTicks.map((tick) => {
          const y = layout.yScale(tick)
          const isZero = Math.abs(tick) < 1e-9

          return (
            <g key={`y-${tick}`}>
              <line
                x1={dimensions.margin.left}
                x2={chartRight}
                y1={y}
                y2={y}
                stroke={isZero ? 'var(--terminal-heading)' : 'var(--terminal-grid)'}
                strokeDasharray={isZero ? undefined : '2 6'}
                strokeOpacity={isZero ? 0.78 : 1}
                strokeWidth={isZero ? 1.25 : 1}
              />
              <text
                x={dimensions.margin.left - 10}
                y={y + 4}
                textAnchor="end"
                fill="var(--terminal-muted)"
                fontSize={11}
                fontFamily="var(--font-mono)"
              >
                {formatAxisMillions(tick)}
              </text>
            </g>
          )
        })}

        {layout.xTicks.map((tick) => {
          const x = layout.xScale(tick)
          const levelMarker = getLevelMarkerAtStrike(layout.levelMarkers, tick)

          return (
            <g key={`x-${tick}`}>
              <line
                x1={x}
                x2={x}
                y1={dimensions.margin.top}
                y2={chartBottom}
                stroke="var(--terminal-grid)"
                strokeDasharray="2 8"
              />
              <text
                x={x}
                y={dimensions.height - 34}
                textAnchor="middle"
                fill={levelMarker?.color ?? 'var(--terminal-muted)'}
                fontSize={11}
                fontFamily="var(--font-mono)"
                fontWeight={levelMarker ? 700 : 400}
              >
                {formatStrike(tick)}
              </text>
            </g>
          )
        })}

        {data.length > 0 && isAbsMode ? (
          <g pointerEvents="none">
            {callAreaPath ? <path d={callAreaPath} fill="url(#abs-call-area-fill)" /> : null}
            {putAreaPath ? <path d={putAreaPath} fill="url(#abs-put-area-fill)" /> : null}
            {callLinePath ? (
              <path d={callLinePath} fill="none" stroke="var(--chart-positive-edge)" strokeLinecap="round" strokeWidth={1.6} />
            ) : null}
            {putLinePath ? (
              <path d={putLinePath} fill="none" stroke="var(--chart-negative-edge)" strokeLinecap="round" strokeWidth={1.6} />
            ) : null}
          </g>
        ) : null}

        {data.length > 0 && !isAbsMode ? (
          <g pointerEvents="none">
            {positiveAreaPath ? <path d={positiveAreaPath} fill="url(#profile-positive-area-fill)" /> : null}
            {negativeAreaPath ? <path d={negativeAreaPath} fill="url(#profile-negative-area-fill)" /> : null}
            {positiveLinePath ? (
              <path d={positiveLinePath} fill="none" stroke="var(--chart-positive-edge)" strokeLinecap="round" strokeWidth={1.6} />
            ) : null}
            {negativeLinePath ? (
              <path d={negativeLinePath} fill="none" stroke="var(--chart-negative-edge)" strokeLinecap="round" strokeWidth={1.6} />
            ) : null}
          </g>
        ) : null}

        {layout.levelMarkers.map((marker, index) => (
          <AreaLevelMarker
            key={marker.id}
            marker={marker}
            chartBottom={chartBottom}
            chartTop={dimensions.margin.top}
            dimensions={dimensions}
            index={index}
          />
        ))}

        <line
          x1={layout.spotX}
          x2={layout.spotX}
          y1={dimensions.margin.top}
          y2={chartBottom}
          stroke="var(--terminal-heading)"
          strokeWidth={1}
          strokeDasharray="4 6"
          strokeOpacity="0.58"
        />
        <g transform={`translate(${spotLabelX} ${dimensions.margin.top + 13})`}>
          <rect x="-47" y="-11" width="94" height="22" rx="2" fill="var(--terminal-surface)" stroke="var(--terminal-border-strong)" />
          <text
            x="0"
            y="1"
            fill="var(--terminal-heading)"
            fontSize={10.5}
            textAnchor="middle"
            dominantBaseline="middle"
            fontFamily="var(--font-mono)"
            fontWeight={600}
          >
            Spot {formatStrike(spot)}
          </text>
        </g>

        {hoveredDatum && hoverX !== null ? (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={dimensions.margin.top}
              y2={chartBottom}
              stroke="var(--terminal-heading)"
              strokeOpacity="0.34"
              strokeWidth={1}
            />
            {isAbsMode ? (
              <>
                <circle cx={hoverX} cy={layout.yScale(Math.abs(hoveredDatum.callGexUsd))} r={3.5} fill="var(--chart-positive-edge)" />
                <circle cx={hoverX} cy={layout.yScale(Math.abs(hoveredDatum.putGexUsd))} r={3.5} fill="var(--chart-negative-edge)" />
              </>
            ) : (
              <circle
                cx={hoverX}
                cy={layout.yScale(hoveredDatum.netGexUsd)}
                r={3.5}
                fill={hoveredDatum.netGexUsd >= 0 ? 'var(--chart-positive-edge)' : 'var(--chart-negative-edge)'}
              />
            )}
          </g>
        ) : null}

        {data.length === 0 ? (
          <text
            x={dimensions.margin.left + layout.innerWidth / 2}
            y={dimensions.margin.top + layout.innerHeight / 2}
            textAnchor="middle"
            fill="var(--terminal-muted)"
            fontSize={12}
          >
            No chart data available
          </text>
        ) : null}

        <rect
          x={dimensions.margin.left}
          y={dimensions.margin.top}
          width={layout.innerWidth}
          height={layout.innerHeight}
          fill="transparent"
          onMouseMove={(event) => handleAreaMouseMove(event, layout, dimensions, mode, setHovered)}
          onMouseLeave={() => setHovered(null)}
        />

        <text
          x={dimensions.margin.left + layout.innerWidth / 2}
          y={dimensions.height - 12}
          textAnchor="middle"
          fill="var(--terminal-muted)"
          fontSize={10.5}
          letterSpacing={1.2}
        >
          STRIKE (USD)
        </text>
        <text
          x={areaYAxisLabelX}
          y={dimensions.margin.top + layout.innerHeight / 2}
          textAnchor="middle"
          fill="var(--terminal-muted)"
          fontSize={10.5}
          letterSpacing={1.2}
          transform={`rotate(-90 ${areaYAxisLabelX} ${dimensions.margin.top + layout.innerHeight / 2})`}
        >
          GAMMA EXPOSURE (USD)
        </text>

        {isAbsMode ? (
          <g transform={`translate(${chartRight - 142} 25)`}>
            <line x1="0" x2="18" y1="0" y2="0" stroke="var(--chart-positive-edge)" strokeWidth={2} />
            <text x="24" y="4" fill="var(--terminal-muted)" fontSize={10.5} fontFamily="var(--font-mono)">
              Call ABS
            </text>
            <line x1="82" x2="100" y1="0" y2="0" stroke="var(--chart-negative-edge)" strokeWidth={2} />
            <text x="106" y="4" fill="var(--terminal-muted)" fontSize={10.5} fontFamily="var(--font-mono)">
              Put ABS
            </text>
          </g>
        ) : null}
      </svg>

      {hoveredDatum && hovered ? (
        <div
          className="pointer-events-none absolute z-10 min-w-44 rounded-[var(--terminal-radius-sm)] border border-[var(--terminal-border-strong)] bg-[var(--terminal-surface)]/95 px-3 py-2 text-left text-[11px] text-[var(--terminal-text)] shadow-2xl backdrop-blur"
          style={{
            left: `${hovered.xPct}%`,
            top: `${hovered.yPct}%`,
            transform: 'translate(12px, -50%)',
          }}
        >
          <div className="mb-1 text-[var(--terminal-heading)]">Strike {formatStrike(hoveredDatum.strike)}</div>
          {isAbsMode ? (
            <>
              <div className="terminal-value text-[var(--terminal-green-strong)]">
                Call ABS {formatMillions(Math.abs(hoveredDatum.callGexUsd))}
              </div>
              <div className="terminal-value text-[var(--terminal-red-strong)]">
                Put ABS {formatMillions(Math.abs(hoveredDatum.putGexUsd))}
              </div>
              <div className={hoveredDatum.netGexUsd >= 0 ? 'terminal-value mt-1 text-[var(--terminal-green)]' : 'terminal-value mt-1 text-[var(--terminal-red)]'}>
                Net {formatMillions(hoveredDatum.netGexUsd)}
              </div>
            </>
          ) : (
            <>
              <div className={hoveredDatum.netGexUsd >= 0 ? 'terminal-value text-[var(--terminal-green-strong)]' : 'terminal-value text-[var(--terminal-red-strong)]'}>
                Net GEX {formatMillions(hoveredDatum.netGexUsd)}
              </div>
              <div className="terminal-value mt-1 text-[var(--terminal-green)]">Calls {formatMillions(hoveredDatum.callGexUsd)}</div>
              <div className="terminal-value text-[var(--terminal-red)]">Puts {formatMillions(hoveredDatum.putGexUsd)}</div>
            </>
          )}
          <div className="text-[var(--terminal-muted)]">Mode {modeLabel(mode)}</div>
        </div>
      ) : null}
    </>
  )
}

function BarLevelMarker({
  marker,
  chartLeft,
  chartRight,
  data,
  index,
}: {
  marker: PositionedBarLevelMarker
  chartLeft: number
  chartRight: number
  data: ChartDatum[]
  index: number
}) {
  const hasAxisRow = data.some((datum) => datum.strike === marker.strike)
  const labelY = marker.y + index * 24

  return (
    <g pointerEvents="none">
      <line
        x1={chartLeft}
        x2={chartRight}
        y1={marker.y}
        y2={marker.y}
        stroke={marker.color}
        strokeWidth={1}
        strokeDasharray="4 6"
        strokeOpacity="0.58"
      />
      {!hasAxisRow ? (
        <text
          x={50}
          y={marker.y + 4}
          textAnchor="middle"
          fill={marker.color}
          fontSize={11.5}
          fontWeight={700}
          fontFamily="var(--font-mono)"
        >
          {formatStrike(marker.strike)}
        </text>
      ) : null}
      <g transform={`translate(${chartRight - 6} ${labelY})`}>
        <rect
          x="0"
          y="-11"
          width="102"
          height="22"
          rx="2"
          fill="var(--terminal-surface)"
          stroke={marker.color}
          strokeOpacity="0.76"
        />
        <text
          x="58"
          y="1"
          fill={marker.color}
          fontSize={10.5}
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily="var(--font-mono)"
          fontWeight={700}
        >
          {marker.label} {formatStrike(marker.strike)}
        </text>
        <LevelMarkerGlyph x={13} y={0} color={marker.color} />
      </g>
    </g>
  )
}

function AreaLevelMarker({
  marker,
  chartBottom,
  chartTop,
  dimensions,
  index,
}: {
  marker: PositionedAreaLevelMarker
  chartBottom: number
  chartTop: number
  dimensions: ChartDimensions
  index: number
}) {
  const chartRight = dimensions.width - dimensions.margin.right
  const labelX = getClampedLabelX(marker.x, dimensions.margin.left + 54, chartRight - 54)

  return (
    <g pointerEvents="none">
      <line
        x1={marker.x}
        x2={marker.x}
        y1={chartTop}
        y2={chartBottom}
        stroke={marker.color}
        strokeWidth={1}
        strokeDasharray="4 6"
        strokeOpacity="0.56"
      />
      <text
        x={marker.x}
        y={dimensions.height - 34}
        textAnchor="middle"
        fill={marker.color}
        fontSize={11}
        fontWeight={700}
        fontFamily="var(--font-mono)"
      >
        {formatStrike(marker.strike)}
      </text>
      <g transform={`translate(${labelX} ${chartTop + 39 + index * 24})`}>
        <rect
          x="-54"
          y="-11"
          width="108"
          height="22"
          rx="2"
          fill="var(--terminal-surface)"
          stroke={marker.color}
          strokeOpacity="0.76"
        />
        <text
          x="8"
          y="1"
          fill={marker.color}
          fontSize={10.5}
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily="var(--font-mono)"
          fontWeight={700}
        >
          {marker.label} {formatStrike(marker.strike)}
        </text>
        <LevelMarkerGlyph x={-42} y={0} color={marker.color} />
      </g>
    </g>
  )
}

function LevelMarkerGlyph({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <rect
      x={x - 3.6}
      y={y - 3.6}
      width={7.2}
      height={7.2}
      fill={color}
      fillOpacity={0.16}
      stroke={color}
      strokeWidth={1}
      transform={`rotate(45 ${x} ${y})`}
    />
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
      const elementWidth = element.getBoundingClientRect().width
      const parentWidth = element.parentElement?.getBoundingClientRect().width ?? 0
      setWidth(Math.max(minChartWidth, Math.floor(Math.max(elementWidth, parentWidth))))
    }
    updateWidth()

    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    if (element.parentElement) {
      observer.observe(element.parentElement)
    }

    return () => observer.disconnect()
  }, [ref])

  return width
}

function prepareChartData(snapshot: GexSnapshot, mode: GexMode, dataWindowPct: number | 'full'): ChartDatum[] {
  const rowsInWindow = snapshot.gammaBars.filter((row) => isStrikeInDataWindow(row.strike, snapshot.spot, dataWindowPct))
  const sourceRows = rowsInWindow.length > 0 ? rowsInWindow : snapshot.gammaBars
  const visibleRows = mode === 'abs' || mode === 'profile' ? sourceRows : getReadableStrikeRows(sourceRows)
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

  return isStrikeInPercentWindow(strike, spot, windowPct)
}

function isStrikeInPercentWindow(strike: number, spot: number, windowPct: number) {
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

function getChartDimensions(width: number): ChartDimensions {
  return {
    width,
    height: chartHeight,
    margin,
  }
}

function getAreaChartDimensions(width: number): ChartDimensions {
  return {
    width,
    height: chartHeight,
    margin: areaMargin,
  }
}

function getChartLayout(data: ChartDatum[], spot: number, dimensions: ChartDimensions, levelMarkers: GexLevelMarker[]) {
  const innerWidth = dimensions.width - dimensions.margin.left - dimensions.margin.right
  const innerHeight = dimensions.height - dimensions.margin.top - dimensions.margin.bottom
  const maxAbsGex = Math.max(...data.flatMap((datum) => [
    Math.abs(datum.displayGexUsd),
    Math.abs(datum.callGexUsd),
    Math.abs(datum.putGexUsd),
  ]), 10_000_000)
  const domainMax = getRoundedDomainMax(maxAbsGex * 1.18)
  const strikes = data.map((datum) => datum.strike)
  const levelStrikes = levelMarkers.map((marker) => marker.strike)
  const minStrike = Math.min(...strikes, spot, ...levelStrikes)
  const maxStrike = Math.max(...strikes, spot, ...levelStrikes)
  const xScale = scaleLinear<number, number>()
    .domain([-domainMax, domainMax])
    .range([dimensions.margin.left, dimensions.margin.left + innerWidth])
  const yScale = scaleBand<number>()
    .domain(strikes)
    .range([dimensions.margin.top, dimensions.margin.top + innerHeight])
    .padding(0.22)
  const strikeScale = scaleLinear<number, number>()
    .domain([minStrike, maxStrike])
    .range([dimensions.margin.top + innerHeight, dimensions.margin.top])

  return {
    innerWidth,
    innerHeight,
    xScale,
    yScale,
    spotY: strikeScale(spot),
    levelMarkers: levelMarkers.map((marker) => {
      const rowTop = yScale(marker.strike)

      return {
        ...marker,
        y: rowTop === undefined ? strikeScale(marker.strike) : rowTop + yScale.bandwidth() / 2,
      }
    }),
    xTicks: buildMillionTicks(domainMax),
    closestSpotStrike: getClosestStrike(strikes, spot),
  }
}

function getAreaChartLayout(data: ChartDatum[], spot: number, dimensions: ChartDimensions, mode: GexMode, levelMarkers: GexLevelMarker[]): AreaChartLayout {
  const innerWidth = dimensions.width - dimensions.margin.left - dimensions.margin.right
  const innerHeight = dimensions.height - dimensions.margin.top - dimensions.margin.bottom
  const sortedData = [...data].sort((a, b) => a.strike - b.strike)
  const strikes = sortedData.map((datum) => datum.strike)
  const levelStrikes = levelMarkers.map((marker) => marker.strike)
  const fallbackWindow = Math.max(Math.abs(spot) * 0.02, 1)
  const minStrike = strikes.length > 0 ? Math.min(...strikes, spot, ...levelStrikes) : Math.min(spot - fallbackWindow, ...levelStrikes)
  const maxStrike = strikes.length > 0 ? Math.max(...strikes, spot, ...levelStrikes) : Math.max(spot + fallbackWindow, ...levelStrikes)
  const domainMin = minStrike === maxStrike ? minStrike - fallbackWindow : minStrike
  const domainMaxStrike = minStrike === maxStrike ? maxStrike + fallbackWindow : maxStrike
  const xScale = scaleLinear<number, number>()
    .domain([domainMin, domainMaxStrike])
    .range([dimensions.margin.left, dimensions.margin.left + innerWidth])
  const maxGex = mode === 'abs'
    ? Math.max(...sortedData.flatMap((datum) => [Math.abs(datum.callGexUsd), Math.abs(datum.putGexUsd)]), 10_000_000)
    : Math.max(...sortedData.map((datum) => Math.abs(datum.netGexUsd)), 10_000_000)
  const domainMax = getRoundedDomainMax(maxGex)
  const yScale = scaleLinear<number, number>()
    .domain(mode === 'abs' ? [0, domainMax] : [-domainMax, domainMax])
    .range([dimensions.margin.top + innerHeight, dimensions.margin.top])
    .nice(5)

  return {
    data: sortedData,
    profileData: addZeroCrossings(sortedData),
    innerWidth,
    innerHeight,
    xScale,
    yScale,
    xTicks: xScale.ticks(getAreaXAxisTickCount(dimensions.width)),
    yTicks: yScale.ticks(5),
    zeroY: yScale(0),
    spotX: xScale(spot),
    levelMarkers: levelMarkers.map((marker) => ({ ...marker, x: xScale(marker.strike) })),
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

function getRoundedDomainMax(value: number) {
  const safeValue = Math.max(Math.abs(value), 10_000_000)
  const step = getTickStep(safeValue)

  return Math.ceil(safeValue / step) * step
}

function getAreaXAxisTickCount(width: number) {
  return width < 860 ? 5 : 7
}

function getClosestStrike(strikes: number[], spot: number) {
  return strikes.reduce((closest, strike) => {
    return Math.abs(strike - spot) < Math.abs(closest - spot) ? strike : closest
  }, strikes[0] ?? spot)
}

function getLevelMarkerAtStrike<T extends { strike: number }>(markers: T[], strike: number) {
  return markers.find((marker) => marker.strike === strike)
}

function shouldShowYAxisStrike(
  strike: number,
  dataWindowPct: number | 'full',
  hasLevelMarker: boolean,
) {
  if (hasLevelMarker) {
    return true
  }

  const step = getYAxisStrikeStep(dataWindowPct)
  if (step === 0) {
    return true
  }

  return strike % step === 0
}

function getYAxisStrikeStep(dataWindowPct: number | 'full') {
  if (dataWindowPct === 'full') return 10_000
  if (dataWindowPct <= 10) return 0
  if (dataWindowPct <= 18) return 2_500
  if (dataWindowPct <= 35) return 5_000
  if (dataWindowPct <= 65) return 10_000

  return 20_000
}

function addZeroCrossings(data: ChartDatum[]) {
  if (data.length < 2) {
    return data
  }

  const rowsWithCrossings: ChartDatum[] = [data[0]]

  for (let index = 1; index < data.length; index += 1) {
    const previous = data[index - 1]
    const current = data[index]
    const crossesZero = (previous.netGexUsd < 0 && current.netGexUsd > 0) || (previous.netGexUsd > 0 && current.netGexUsd < 0)

    if (crossesZero) {
      const interpolation = Math.abs(previous.netGexUsd) / (Math.abs(previous.netGexUsd) + Math.abs(current.netGexUsd))
      rowsWithCrossings.push({
        strike: interpolate(previous.strike, current.strike, interpolation),
        netGexUsd: 0,
        callGexUsd: interpolate(previous.callGexUsd, current.callGexUsd, interpolation),
        putGexUsd: interpolate(previous.putGexUsd, current.putGexUsd, interpolation),
        displayGexUsd: 0,
      })
    }

    rowsWithCrossings.push(current)
  }

  return rowsWithCrossings
}

function interpolate(start: number, end: number, interpolation: number) {
  return start + (end - start) * interpolation
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
  return Math.max(3.5, Math.min(6.5, bandwidth * 0.54))
}

function getTooltipX(bar: BarGeometry, dimensions: ChartDimensions) {
  const anchor = bar.x2 >= bar.x1 ? bar.x2 : bar.x

  return (Math.max(dimensions.margin.left, Math.min(anchor, dimensions.width - dimensions.margin.right)) / dimensions.width) * 100
}

function getAreaPath(
  data: ChartDatum[],
  xScale: ScaleLinear<number, number>,
  yScale: ScaleLinear<number, number>,
  getValue: (datum: ChartDatum) => number,
) {
  return area<ChartDatum>()
    .x((datum) => xScale(datum.strike))
    .y0(yScale(0))
    .y1((datum) => yScale(getValue(datum)))
    .curve(curveMonotoneX)(data)
}

function getSignedAreaPath(
  data: ChartDatum[],
  xScale: ScaleLinear<number, number>,
  yScale: ScaleLinear<number, number>,
  isDefined: (datum: ChartDatum) => boolean,
) {
  return area<ChartDatum>()
    .defined(isDefined)
    .x((datum) => xScale(datum.strike))
    .y0(yScale(0))
    .y1((datum) => yScale(datum.netGexUsd))
    .curve(curveMonotoneX)(data)
}

function getLinePath(
  data: ChartDatum[],
  xScale: ScaleLinear<number, number>,
  yScale: ScaleLinear<number, number>,
  getValue: (datum: ChartDatum) => number,
) {
  return line<ChartDatum>()
    .x((datum) => xScale(datum.strike))
    .y((datum) => yScale(getValue(datum)))
    .curve(curveMonotoneX)(data)
}

function getSignedLinePath(
  data: ChartDatum[],
  xScale: ScaleLinear<number, number>,
  yScale: ScaleLinear<number, number>,
  isDefined: (datum: ChartDatum) => boolean,
) {
  return line<ChartDatum>()
    .defined(isDefined)
    .x((datum) => xScale(datum.strike))
    .y((datum) => yScale(datum.netGexUsd))
    .curve(curveMonotoneX)(data)
}

function handleAreaMouseMove(
  event: React.MouseEvent<SVGRectElement>,
  layout: AreaChartLayout,
  dimensions: ChartDimensions,
  mode: 'abs' | 'profile',
  setHovered: (hovered: HoverState | null) => void,
) {
  if (layout.data.length === 0) {
    setHovered(null)
    return
  }

  const svg = event.currentTarget.ownerSVGElement
  if (!svg) {
    return
  }

  const bounds = svg.getBoundingClientRect()
  const pointerX = ((event.clientX - bounds.left) / bounds.width) * dimensions.width
  const pointerStrike = layout.xScale.invert(pointerX)
  const datum = getClosestDatumByStrike(layout.data, pointerStrike)
  const datumX = layout.xScale(datum.strike)
  const datumValue = mode === 'abs'
    ? Math.max(Math.abs(datum.callGexUsd), Math.abs(datum.putGexUsd))
    : datum.netGexUsd
  const datumY = layout.yScale(datumValue)

  setHovered({
    datum,
    xPct: clamp((datumX / dimensions.width) * 100, 6, 82),
    yPct: clamp((datumY / dimensions.height) * 100, 14, 86),
  })
}

function getClosestDatumByStrike(data: ChartDatum[], strike: number) {
  return data.reduce((closest, datum) => {
    return Math.abs(datum.strike - strike) < Math.abs(closest.strike - strike) ? datum : closest
  }, data[0])
}

function getClampedLabelX(value: number, min: number, max: number) {
  return clamp(value, min, Math.max(min, max))
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
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
        fillOpacity={0.82}
        stroke={stroke}
        strokeOpacity={0.48}
        strokeWidth={0.75}
      />
      <line
        x1={bar.x}
        x2={bar.x + bar.width}
        y1={bar.y - height / 2 + 1}
        y2={bar.y - height / 2 + 1}
        stroke={positive ? 'var(--chart-positive-edge)' : 'var(--chart-negative-edge)'}
        strokeWidth={1}
        strokeOpacity={0.22}
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
  const splitHeight = Math.max(3, rowHeight * 0.42)
  const callBar = getBarGeometry(datum.callGexUsd, xScale, y - splitHeight * 0.56)
  const putBar = getBarGeometry(datum.putGexUsd, xScale, y + splitHeight * 0.56)

  return (
    <>
      <SingleBar bar={callBar} positive stroke="var(--chart-positive-edge)" height={splitHeight} />
      <SingleBar bar={putBar} positive={false} stroke="var(--chart-negative-edge)" height={splitHeight} />
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

function chartTitle(mode: GexMode) {
  if (mode === 'net') {
    return 'NET GAMMA EXPOSURE'
  }

  return `${modeLabel(mode).toUpperCase()} GAMMA EXPOSURE PROFILE`
}
