import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { scaleLinear } from 'd3-scale'
import type { ScaleLinear } from 'd3-scale'
import { area, curveMonotoneX, line } from 'd3-shape'
import { getGexChartTitle } from '@/components/terminal/gexModes'
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
  glyph?: LevelMarkerGlyphVariant
  axisOnly?: boolean
  components?: GexLevelMarker[]
}

export type LevelMarkerGlyphVariant =
  | 'diamond'
  | 'chevronUp'
  | 'chevronDown'
  | 'crosshair'
  | 'slash'
  | 'bracket'
  | 'flipZone'

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
  titleAccessory?: ReactNode
  titleOverride?: string
}

type ChartDatum = {
  strike: number
  netGexUsd: number
  callGexUsd: number
  putGexUsd: number
  positiveGexUsd: number
  negativeGexUsd: number
  displayGexUsd: number
}

type HoverState = {
  datum: ChartDatum
  xPct: number
  yPct: number
  side: TooltipSide
}

type TooltipSide = 'left' | 'right'

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
  axisMarkers: PositionedAreaLevelMarker[]
}

type PositionedBarLevelMarker = GexLevelMarker & {
  y: number
  components?: GexLevelMarker[]
}

type StrikeAxisTick = {
  strike: number
  y: number
}

type PositionedAreaLevelMarker = GexLevelMarker & {
  x: number
  components?: GexLevelMarker[]
}

const defaultWidth = 1120
const minChartWidth = 720
const defaultChartHeight = 516
const minChartHeight = 516
const margin = { top: 60, right: 102, bottom: 54, left: 78 }
const areaMargin = { top: 54, right: 30, bottom: 50, left: 104 }
const areaYAxisLabelX = 22
const barChartDomainPadding = 1.35
const areaChartDomainPadding = 1.35
const profileNegativeDomainBuffer = 10_000_000
const levelHighlightBandSize = 8
const barSpotLabelNormalOffsetX = -6
const barSpotLabelWidth = 74
const barSpotLabelHeight = 18
const barLevelLabelSpotThreshold = 24
const barLevelLabelSpotGap = 8
const areaSpotLabelWidth = 78
const areaSpotLabelHeight = 18

export function GexProfileChart({
  snapshot,
  mode,
  dataWindowPct,
  levelMarkers = [],
  titleAccessory,
  titleOverride,
}: GexProfileChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const gradientIdPrefix = useId().replace(/:/g, '')
  const { width: measuredWidth, height: measuredHeight } = useContainerSize(containerRef, defaultWidth, defaultChartHeight)
  const areaMode = mode === 'abs' || mode === 'profile'
  const validLevelMarkers = useMemo(() => levelMarkers.filter((marker) => Number.isFinite(marker.strike)), [levelMarkers])
  const data = useMemo(
    () => prepareChartData(snapshot, mode, dataWindowPct),
    [snapshot, mode, dataWindowPct],
  )
  const visibleLevelMarkers = useMemo(
    () => getVisibleLevelMarkers(validLevelMarkers, data),
    [data, validLevelMarkers],
  )
  const visibleLineLevelMarkers = useMemo(
    () => groupLevelMarkers(visibleLevelMarkers.filter((marker) => !marker.axisOnly)),
    [visibleLevelMarkers],
  )
  const visibleAxisLevelMarkers = useMemo(
    () => groupLevelMarkers(visibleLevelMarkers),
    [visibleLevelMarkers],
  )
  const dimensions = areaMode ? getAreaChartDimensions(measuredWidth, measuredHeight) : getChartDimensions(measuredWidth, measuredHeight)
  const barLayout = useMemo(
    () => getChartLayout(data, snapshot.spot, dimensions, mode, dataWindowPct, visibleLineLevelMarkers, visibleAxisLevelMarkers),
    [data, dataWindowPct, dimensions, mode, snapshot.spot, visibleAxisLevelMarkers, visibleLineLevelMarkers],
  )
  const areaLayout = useMemo(
    () => getAreaChartLayout(data, snapshot.spot, dimensions, mode, visibleLineLevelMarkers, visibleAxisLevelMarkers),
    [data, dimensions, mode, snapshot.spot, visibleAxisLevelMarkers, visibleLineLevelMarkers],
  )
  const [hovered, setHovered] = useState<HoverState | null>(null)
  if (areaMode) {
    return (
      <div ref={containerRef} className="relative h-full min-h-[516px] w-full overflow-hidden">
        {titleAccessory ? (
          <div className="absolute right-[18px] top-[12px] z-20">
            {titleAccessory}
          </div>
        ) : null}
        <AreaGexChart
          data={data}
          dimensions={dimensions}
          gradientIdPrefix={gradientIdPrefix}
          hovered={hovered}
          layout={areaLayout}
          mode={mode}
          setHovered={setHovered}
          spot={snapshot.spot}
          titleOverride={titleOverride}
        />
      </div>
    )
  }

  const layout = barLayout
  const yAxisTickStrikes = new Set(layout.yAxisTicks.map((tick) => tick.strike))
  const levelAxisStrikes = new Set(layout.levelMarkers.map((marker) => marker.strike))
  const barLevelAxisLabels = getBarLevelAxisLabels(layout.levelMarkers, layout.yAxisTicks)
  const chartRight = dimensions.margin.left + layout.innerWidth
  const barLevelMarkerScale = getLevelMarkerScale(layout.levelMarkers.map((marker) => marker.y), dataWindowPct)
  const barLevelLabelYById = getBarLevelLabelYById(
    layout.levelMarkers,
    dimensions.margin.top,
    dimensions.margin.top + layout.innerHeight,
    barLevelMarkerScale,
  )
  const barSpotLabelX = chartRight + barSpotLabelNormalOffsetX

  return (
    <div ref={containerRef} className="relative h-full min-h-[516px] w-full overflow-hidden">
      {titleAccessory ? (
        <div className="absolute right-[18px] top-[12px] z-20">
          {titleAccessory}
        </div>
      ) : null}
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
          <linearGradient id={`${gradientIdPrefix}-chart-panel-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-panel-fill-top)" />
            <stop offset="55%" stopColor="var(--chart-panel-fill-mid)" />
            <stop offset="100%" stopColor="var(--chart-panel-fill-bottom)" />
          </linearGradient>
          <linearGradient id={`${gradientIdPrefix}-positive-gex-fill`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--chart-positive-start)" />
            <stop offset="100%" stopColor="var(--chart-positive-edge)" />
          </linearGradient>
          <linearGradient id={`${gradientIdPrefix}-negative-gex-fill`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--chart-negative-edge)" />
            <stop offset="100%" stopColor="var(--chart-negative-end)" />
          </linearGradient>
          <linearGradient id={`${gradientIdPrefix}-profile-gex-fill`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--chart-profile-fill-start)" />
            <stop offset="50%" stopColor="var(--chart-profile-fill-mid)" />
            <stop offset="100%" stopColor="var(--chart-profile-fill-end)" />
          </linearGradient>
        </defs>

        <rect width={dimensions.width} height={dimensions.height} fill={`url(#${gradientIdPrefix}-chart-panel-fill)`} />
        <rect
          x={dimensions.margin.left}
          y={dimensions.margin.top}
          width={layout.innerWidth}
          height={layout.innerHeight}
          fill="var(--terminal-surface)"
          opacity="0.14"
        />

        <text x={22} y={29} fill="var(--terminal-heading)" fontSize={14} fontWeight={700} letterSpacing={1.4}>
          {titleOverride ?? getGexChartTitle(mode)}
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

        {layout.yAxisTicks.map((tick) => (
          <YAxisStrikeLabel
            key={tick.strike}
            marker={getLevelMarkerAtStrike(layout.levelMarkers, tick.strike)}
            strike={tick.strike}
            x={50}
            y={tick.y}
            highlighted={false}
          />
        ))}

        {barLevelAxisLabels.map((marker) => (
          <YAxisStrikeLabel
            key={`level-axis-${marker.id}`}
            marker={marker}
            strike={marker.strike}
            x={50}
            y={marker.y}
            highlighted={false}
          />
        ))}

        {data.map((datum) => {
          const rowCenter = layout.yScale(datum.strike)
          const rowHeight = layout.rowHeight
          const rowTop = rowCenter - rowHeight / 2
          const isHovered = hovered?.datum.strike === datum.strike
          const showHoverStrikeLabel = isHovered && !yAxisTickStrikes.has(datum.strike) && !levelAxisStrikes.has(datum.strike)
          const bar = getBarGeometry(datum.displayGexUsd, layout.xScale, rowCenter)
          const barHeight = getBarHeight(rowHeight)
          const positive = datum.displayGexUsd >= 0
          const stroke = positive ? 'var(--chart-positive-edge)' : 'var(--chart-negative-edge)'
          const positiveBar = getBarGeometry(datum.positiveGexUsd, layout.xScale, rowCenter)
          const negativeBar = getBarGeometry(datum.negativeGexUsd, layout.xScale, rowCenter)

          return (
            <g key={datum.strike}>
              {isHovered ? (
                <rect
                  x={dimensions.margin.left}
                  y={rowTop}
                  width={layout.innerWidth}
                  height={rowHeight}
                  fill="var(--terminal-surface-2)"
                  opacity="0.72"
                />
              ) : null}
              {showHoverStrikeLabel ? (
                <YAxisStrikeLabel
                  strike={datum.strike}
                  x={50}
                  y={rowCenter}
                  highlighted
                />
              ) : null}
              {mode === 'split' ? (
                <SplitBars
                  datum={datum}
                  negativeFillId={`${gradientIdPrefix}-negative-gex-fill`}
                  positiveFillId={`${gradientIdPrefix}-positive-gex-fill`}
                  xScale={layout.xScale}
                  y={rowCenter}
                  rowHeight={barHeight}
                />
              ) : (
                <SingleBar
                  bar={bar}
                  fillId={positive ? `${gradientIdPrefix}-positive-gex-fill` : `${gradientIdPrefix}-negative-gex-fill`}
                  positive={positive}
                  stroke={stroke}
                  height={barHeight}
                />
              )}
              {mode === 'split' ? (
                <>
                  <BarHoverTarget
                    bar={negativeBar}
                    datum={datum}
                    dimensions={dimensions}
                    height={barHeight}
                    setHovered={setHovered}
                    side="left"
                  />
                  <BarHoverTarget
                    bar={positiveBar}
                    datum={datum}
                    dimensions={dimensions}
                    height={barHeight}
                    setHovered={setHovered}
                    side="right"
                  />
                </>
              ) : (
                <BarHoverTarget
                  bar={bar}
                  datum={datum}
                  dimensions={dimensions}
                  height={barHeight}
                  setHovered={setHovered}
                  side={positive ? 'right' : 'left'}
                />
              )}
            </g>
          )
        })}

        <line
          x1={dimensions.margin.left}
          x2={chartRight}
          y1={layout.spotY}
          y2={layout.spotY}
          stroke="var(--terminal-heading)"
          strokeWidth={1}
          strokeDasharray="4 6"
          strokeOpacity="0.6"
          pointerEvents="none"
        />

        {layout.levelMarkers.map((marker) => (
          <BarLevelMarker
            key={marker.id}
            marker={marker}
            chartLeft={dimensions.margin.left}
            spotLabelX={barSpotLabelX}
            labelY={barLevelLabelYById.get(marker.id) ?? marker.y}
            markerScale={barLevelMarkerScale}
            spotY={layout.spotY}
          />
        ))}
        <g transform={`translate(${barSpotLabelX} ${layout.spotY})`}>
          <rect
            x="0"
            y={-barSpotLabelHeight / 2}
            width={barSpotLabelWidth}
            height={barSpotLabelHeight}
            rx="2"
            fill="var(--terminal-surface)"
            stroke="var(--terminal-border-strong)"
          />
          <text
            x={barSpotLabelWidth / 2}
            y="1"
            fill="var(--terminal-heading)"
            fontSize={9.5}
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
            transform: getTooltipTransform(hovered.side),
          }}
        >
          <div className="mb-1 text-[var(--terminal-heading)]">Strike {formatStrike(hovered.datum.strike)}</div>
          <div className={hovered.datum.netGexUsd >= 0 ? 'terminal-value text-[var(--terminal-green-strong)]' : 'terminal-value text-[var(--terminal-red-strong)]'}>
            Net GEX {formatMillions(hovered.datum.netGexUsd)}
          </div>
          {mode === 'split' ? (
            <>
              <div className="terminal-value mt-1 text-[var(--terminal-green)]">Long Gamma {formatMillions(hovered.datum.positiveGexUsd)}</div>
              <div className="terminal-value text-[var(--terminal-red)]">Short Gamma {formatMillions(hovered.datum.negativeGexUsd)}</div>
            </>
          ) : (
            <>
              <div className="terminal-value mt-1 text-[var(--terminal-green)]">Calls {formatMillions(hovered.datum.callGexUsd)}</div>
              <div className="terminal-value text-[var(--terminal-red)]">Puts {formatMillions(hovered.datum.putGexUsd)}</div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function AreaGexChart({
  data,
  dimensions,
  gradientIdPrefix,
  hovered,
  layout,
  mode,
  setHovered,
  spot,
  titleOverride,
}: {
  data: ChartDatum[]
  dimensions: ChartDimensions
  gradientIdPrefix: string
  hovered: HoverState | null
  layout: AreaChartLayout
  mode: 'abs' | 'profile'
  setHovered: (hovered: HoverState | null) => void
  spot: number
  titleOverride?: string
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
  const spotLabelX = getClampedLabelX(layout.spotX, dimensions.margin.left + areaSpotLabelWidth / 2, chartRight - areaSpotLabelWidth / 2)
  const spotLabelY = dimensions.margin.top + 13
  const spotGuideTop = spotLabelY - areaSpotLabelHeight / 2
  const areaLevelLabelYById = getAreaGlyphLabelYById(layout.levelMarkers, dimensions, spotLabelX)

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
          <linearGradient id={`${gradientIdPrefix}-chart-panel-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-panel-fill-top)" />
            <stop offset="55%" stopColor="var(--chart-panel-fill-mid)" />
            <stop offset="100%" stopColor="var(--chart-panel-fill-bottom)" />
          </linearGradient>
          <linearGradient id={`${gradientIdPrefix}-abs-call-area-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-positive-edge)" stopOpacity="0.68" />
            <stop offset="100%" stopColor="var(--chart-positive)" stopOpacity="0.08" />
          </linearGradient>
          <linearGradient id={`${gradientIdPrefix}-abs-put-area-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-negative-edge)" stopOpacity="0.64" />
            <stop offset="100%" stopColor="var(--chart-negative)" stopOpacity="0.07" />
          </linearGradient>
          <linearGradient id={`${gradientIdPrefix}-profile-positive-area-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-positive-edge)" stopOpacity="0.7" />
            <stop offset="100%" stopColor="var(--chart-positive)" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id={`${gradientIdPrefix}-profile-negative-area-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-negative)" stopOpacity="0.12" />
            <stop offset="100%" stopColor="var(--chart-negative-edge)" stopOpacity="0.68" />
          </linearGradient>
        </defs>

        <rect width={dimensions.width} height={dimensions.height} fill={`url(#${gradientIdPrefix}-chart-panel-fill)`} />
        <rect
          x={dimensions.margin.left}
          y={dimensions.margin.top}
          width={layout.innerWidth}
          height={layout.innerHeight}
          fill="var(--terminal-surface)"
          opacity="0.14"
        />

        <text x={22} y={29} fill="var(--terminal-heading)" fontSize={14} fontWeight={700} letterSpacing={1.4}>
          {titleOverride ?? getGexChartTitle(mode)}
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
          const levelMarker = getLevelMarkerAtStrike(layout.axisMarkers, tick)

          return (
            <g key={`x-${tick}`}>
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
            {callAreaPath ? <path d={callAreaPath} fill={`url(#${gradientIdPrefix}-abs-call-area-fill)`} /> : null}
            {putAreaPath ? <path d={putAreaPath} fill={`url(#${gradientIdPrefix}-abs-put-area-fill)`} /> : null}
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
            {positiveAreaPath ? <path d={positiveAreaPath} fill={`url(#${gradientIdPrefix}-profile-positive-area-fill)`} /> : null}
            {negativeAreaPath ? <path d={negativeAreaPath} fill={`url(#${gradientIdPrefix}-profile-negative-area-fill)`} /> : null}
            {positiveLinePath ? (
              <path d={positiveLinePath} fill="none" stroke="var(--chart-positive-edge)" strokeLinecap="round" strokeWidth={1.6} />
            ) : null}
            {negativeLinePath ? (
              <path d={negativeLinePath} fill="none" stroke="var(--chart-negative-edge)" strokeLinecap="round" strokeWidth={1.6} />
            ) : null}
          </g>
        ) : null}

        <line
          x1={layout.spotX}
          x2={layout.spotX}
          y1={spotGuideTop}
          y2={chartBottom}
          stroke="var(--terminal-heading)"
          strokeWidth={1}
          strokeDasharray="4 6"
          strokeOpacity="0.58"
        />

        {layout.levelMarkers.map((marker) => (
          <AreaLevelMarker
            key={marker.id}
            marker={marker}
            chartBottom={chartBottom}
            chartTop={dimensions.margin.top}
            dimensions={dimensions}
            labelY={areaLevelLabelYById.get(marker.id) ?? dimensions.margin.top + 13}
          />
        ))}

        <g transform={`translate(${spotLabelX} ${spotLabelY})`}>
          <rect
            x={-areaSpotLabelWidth / 2}
            y={-areaSpotLabelHeight / 2}
            width={areaSpotLabelWidth}
            height={areaSpotLabelHeight}
            rx="2"
            fill="var(--terminal-surface)"
            stroke="var(--terminal-border-strong)"
          />
          <text
            x="0"
            y="1"
            fill="var(--terminal-heading)"
            fontSize={9.5}
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

      </svg>

      {hoveredDatum && hovered ? (
        <div
          className="pointer-events-none absolute z-10 min-w-44 rounded-[var(--terminal-radius-sm)] border border-[var(--terminal-border-strong)] bg-[var(--terminal-surface)]/95 px-3 py-2 text-left text-[11px] text-[var(--terminal-text)] shadow-2xl backdrop-blur"
          style={{
            left: `${hovered.xPct}%`,
            top: `${hovered.yPct}%`,
            transform: getTooltipTransform(hovered.side),
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
        </div>
      ) : null}
    </>
  )
}

function BarLevelMarker({
  marker,
  chartLeft,
  spotLabelX,
  labelY,
  markerScale,
  spotY,
}: {
  marker: PositionedBarLevelMarker
  chartLeft: number
  spotLabelX: number
  labelY: number
  markerScale: number
  spotY: number
}) {
  const glyphs = getLevelMarkerComponents(marker)
  const labelWidth = getGlyphGroupWidth(glyphs.length, markerScale)
  const labelHeight = getGlyphGroupHeight(markerScale)
  const glowFilter = getLevelMarkerGlowFilter(marker.color)
  const labelRightX = spotLabelX + barSpotLabelWidth
  const overlapsSpotLabel = Math.abs(labelY - spotY) <= barLevelLabelSpotThreshold * markerScale
  const labelX = overlapsSpotLabel
    ? spotLabelX - labelWidth - barLevelLabelSpotGap
    : labelRightX - labelWidth

  return (
    <g pointerEvents="none">
      <rect
        x={chartLeft}
        y={marker.y - levelHighlightBandSize / 2}
        width={labelRightX - chartLeft}
        height={levelHighlightBandSize}
        fill={marker.color}
        opacity="0.075"
        style={{ filter: glowFilter }}
      />
      <g transform={`translate(${labelX} ${labelY})`}>
        <rect
          x="0"
          y={-labelHeight / 2}
          width={labelWidth}
          height={labelHeight}
          rx="2"
          fill="var(--terminal-surface)"
          stroke={marker.color}
          strokeOpacity="0.76"
        />
        <LevelMarkerGlyphGroup glow scale={markerScale} glyphs={glyphs} x={labelWidth / 2} y={0} />
      </g>
    </g>
  )
}

function YAxisStrikeLabel({
  highlighted,
  marker,
  strike,
  x,
  y,
}: {
  highlighted: boolean
  marker?: PositionedBarLevelMarker
  strike: number
  x: number
  y: number
}) {
  const fill = marker?.color ?? (highlighted ? 'var(--terminal-heading)' : 'var(--terminal-muted)')
  const fontWeight = marker || highlighted ? 700 : 400

  return (
    <g pointerEvents="none">
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        fill={fill}
        fontSize={11.5}
        fontWeight={fontWeight}
        fontFamily="var(--font-mono)"
      >
        {formatStrike(strike)}
      </text>
    </g>
  )
}

function getBarLevelAxisLabels(markers: PositionedBarLevelMarker[], axisTicks: StrikeAxisTick[]) {
  const tickClearance = 13
  const labelClearance = 14
  const sortedMarkers = [...markers]
    .filter((marker) => !axisTicks.some((tick) => tick.strike === marker.strike))
    .sort((a, b) => a.y - b.y)
  const labels: PositionedBarLevelMarker[] = []

  for (const marker of sortedMarkers) {
    const overlapsAxisTick = axisTicks.some((tick) => Math.abs(tick.y - marker.y) < tickClearance)
    const overlapsLevelLabel = labels.some((label) => Math.abs(label.y - marker.y) < labelClearance)

    if (!overlapsAxisTick && !overlapsLevelLabel) {
      labels.push(marker)
    }
  }

  return labels
}

function AreaLevelMarker({
  marker,
  chartBottom,
  chartTop,
  dimensions,
  labelY,
}: {
  marker: PositionedAreaLevelMarker
  chartBottom: number
  chartTop: number
  dimensions: ChartDimensions
  labelY: number
}) {
  const chartRight = dimensions.width - dimensions.margin.right
  const glyphs = getLevelMarkerComponents(marker)
  const labelWidth = getGlyphGroupWidth(glyphs.length)
  const labelHeight = 22
  const glowFilter = getLevelMarkerGlowFilter(marker.color)
  const labelX = getClampedLabelX(marker.x, dimensions.margin.left + labelWidth / 2, chartRight - labelWidth / 2)

  return (
    <g pointerEvents="none">
      <rect
        x={marker.x - levelHighlightBandSize / 2}
        y={chartTop}
        width={levelHighlightBandSize}
        height={chartBottom - chartTop}
        fill={marker.color}
        opacity="0.075"
        style={{ filter: glowFilter }}
      />
      <g transform={`translate(${labelX} ${labelY})`}>
        <rect
          x={-labelWidth / 2}
          y="-11"
          width={labelWidth}
          height={labelHeight}
          rx="2"
          fill="var(--terminal-surface)"
          stroke={marker.color}
          strokeOpacity="0.76"
        />
        <LevelMarkerGlyphGroup glow glyphs={glyphs} x={0} y={0} />
      </g>
    </g>
  )
}

function getLevelMarkerComponents(marker: GexLevelMarker) {
  return marker.components ?? [marker]
}

function getGlyphGroupWidth(glyphCount: number, scale = 1) {
  return (22 + Math.max(0, glyphCount - 1) * 20) * scale
}

function getGlyphGroupHeight(scale = 1) {
  return 22 * scale
}

function LevelMarkerGlyphGroup({
  glow = false,
  glyphs,
  scale = 1,
  x,
  y,
}: {
  glow?: boolean
  glyphs: GexLevelMarker[]
  scale?: number
  x: number
  y: number
}) {
  const gap = 20 * scale
  const startX = x - ((glyphs.length - 1) * gap) / 2

  return (
    <>
      {glyphs.map((glyph, index) => {
        const glyphX = startX + index * gap

        return (
          <g key={glyph.id}>
            {index > 0 ? (
              <text
                x={glyphX - gap / 2}
                y={y + 1}
                fill="var(--terminal-muted)"
                fontSize={9 * scale}
                textAnchor="middle"
                dominantBaseline="middle"
                fontFamily="var(--font-mono)"
                fontWeight={700}
              >
                /
              </text>
            ) : null}
            <g
              transform={`translate(${glyphX} ${y}) scale(${scale})`}
              style={glow ? { filter: getLevelMarkerGlowFilter(glyph.color) } : undefined}
            >
              <LevelMarkerGlyph x={0} y={0} color={glyph.color} variant={glyph.glyph} />
            </g>
          </g>
        )
      })}
    </>
  )
}

function getLevelMarkerGlowFilter(color: string) {
  return `drop-shadow(0 0 3px color-mix(in srgb, ${color} 50%, transparent)) drop-shadow(0 0 8px color-mix(in srgb, ${color} 18%, transparent))`
}

function LevelMarkerGlyph({
  x,
  y,
  color,
  variant = 'diamond',
}: {
  x: number
  y: number
  color: string
  variant?: LevelMarkerGlyphVariant
}) {
  if (variant === 'chevronUp' || variant === 'chevronDown') {
    const direction = variant === 'chevronUp' ? 1 : -1

    return (
      <path
        d={`M ${x - 4} ${y + direction * 2.5} L ${x} ${y - direction * 2.5} L ${x + 4} ${y + direction * 2.5}`}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.7}
      />
    )
  }

  if (variant === 'crosshair') {
    return (
      <g>
        <line x1={x} x2={x} y1={y - 6} y2={y + 6} stroke={color} strokeOpacity={0.8} strokeWidth={1} />
        <line x1={x - 6} x2={x + 6} y1={y} y2={y} stroke={color} strokeOpacity={0.8} strokeWidth={1} />
        <rect
          x={x - 3}
          y={y - 3}
          width={6}
          height={6}
          rx={1.5}
          fill="var(--terminal-surface)"
          stroke={color}
          strokeWidth={1}
        />
      </g>
    )
  }

  if (variant === 'slash') {
    return (
      <line
        x1={x - 4.8}
        x2={x + 4.8}
        y1={y + 4.4}
        y2={y - 4.4}
        stroke={color}
        strokeLinecap="round"
        strokeWidth={1.7}
      />
    )
  }

  if (variant === 'bracket') {
    return (
      <g>
        <rect x={x - 4.8} y={y - 5} width={2.4} height={10} rx={0.5} fill={color} />
        <rect x={x + 2.4} y={y - 5} width={2.4} height={10} rx={0.5} fill={color} fillOpacity={0.62} />
        <line x1={x - 2.4} x2={x + 2.4} y1={y - 3.6} y2={y - 3.6} stroke={color} strokeOpacity={0.68} strokeWidth={1} />
      </g>
    )
  }

  if (variant === 'flipZone') {
    return (
      <g>
        <path
          d={`M ${x - 5.2} ${y} L ${x - 1.3} ${y - 3.9} M ${x - 5.2} ${y} L ${x - 1.3} ${y + 3.9}`}
          fill="none"
          stroke={color}
          strokeLinecap="round"
          strokeWidth={1.5}
        />
        <path
          d={`M ${x + 5.2} ${y} L ${x + 1.3} ${y - 3.9} M ${x + 5.2} ${y} L ${x + 1.3} ${y + 3.9}`}
          fill="none"
          stroke={color}
          strokeLinecap="round"
          strokeOpacity={0.78}
          strokeWidth={1.5}
        />
      </g>
    )
  }

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

function getLevelMarkerScale(positions: number[], dataWindowPct: number | 'full') {
  const viewScale = getLevelMarkerViewScale(dataWindowPct)
  if (positions.length < 2) {
    return viewScale
  }

  const sortedPositions = [...positions].sort((a, b) => a - b)
  const closestGap = sortedPositions.reduce((closest, position, index) => {
    if (index === 0) {
      return closest
    }

    return Math.min(closest, position - sortedPositions[index - 1])
  }, Number.POSITIVE_INFINITY)
  const collisionScale = closestGap < 24 ? clamp(closestGap / 24, 0.72, 1) : 1

  return Math.min(viewScale, collisionScale)
}

function getLevelMarkerViewScale(dataWindowPct: number | 'full') {
  if (dataWindowPct === 'full') return 0.78
  if (dataWindowPct >= 80) return 0.78
  if (dataWindowPct >= 55) return 0.84
  if (dataWindowPct >= 35) return 0.9
  if (dataWindowPct >= 22) return 0.96

  return 1
}

function getBarLevelLabelYById(
  markers: PositionedBarLevelMarker[],
  chartTop: number,
  chartBottom: number,
  markerScale: number,
) {
  const labelGap = 24 * markerScale
  const labelPadding = 12 * markerScale
  const sortedMarkers = [...markers].sort((a, b) => a.y - b.y)
  const labelRows = sortedMarkers.map((marker) => ({
    id: marker.id,
    y: clamp(marker.y, chartTop + labelPadding, chartBottom - labelPadding),
  }))

  for (let index = 1; index < labelRows.length; index += 1) {
    labelRows[index].y = Math.max(labelRows[index].y, labelRows[index - 1].y + labelGap)
  }

  const overflow = labelRows.at(-1) ? labelRows[labelRows.length - 1].y - (chartBottom - labelPadding) : 0
  if (overflow > 0) {
    for (const row of labelRows) {
      row.y -= overflow
    }
  }

  for (let index = labelRows.length - 2; index >= 0; index -= 1) {
    labelRows[index].y = Math.min(labelRows[index].y, labelRows[index + 1].y - labelGap)
  }

  const underflow = labelRows[0] ? (chartTop + labelPadding) - labelRows[0].y : 0
  if (underflow > 0) {
    for (const row of labelRows) {
      row.y += underflow
    }
  }

  return new Map(labelRows.map((row) => [row.id, row.y]))
}

function getAreaGlyphLabelYById(markers: PositionedAreaLevelMarker[], dimensions: ChartDimensions, spotLabelX: number) {
  const gap = 8
  const defaultY = dimensions.margin.top + 13
  const collisionY = dimensions.margin.top + 39
  const chartRight = dimensions.width - dimensions.margin.right
  const spotLeft = spotLabelX - areaSpotLabelWidth / 2 - gap
  const spotRight = spotLabelX + areaSpotLabelWidth / 2 + gap

  return new Map(markers.map((marker) => {
    const labelWidth = getGlyphGroupWidth(getLevelMarkerComponents(marker).length)
    const labelX = getClampedLabelX(marker.x, dimensions.margin.left + labelWidth / 2, chartRight - labelWidth / 2)
    const labelLeft = labelX - labelWidth / 2
    const labelRight = labelX + labelWidth / 2
    const overlapsSpot = labelLeft <= spotRight && labelRight >= spotLeft

    return [marker.id, overlapsSpot ? collisionY : defaultY]
  }))
}

function useContainerSize(ref: React.RefObject<HTMLDivElement | null>, fallbackWidth: number, fallbackHeight: number) {
  const [size, setSize] = useState({ width: fallbackWidth, height: fallbackHeight })

  useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }

    const updateSize = () => {
      const elementBounds = element.getBoundingClientRect()
      const elementWidth = elementBounds.width
      const elementHeight = elementBounds.height
      const parentWidth = element.parentElement?.getBoundingClientRect().width ?? 0
      const parentHeight = element.parentElement?.getBoundingClientRect().height ?? 0

      setSize({
        width: Math.max(minChartWidth, Math.floor(Math.max(elementWidth, parentWidth))),
        height: Math.max(minChartHeight, Math.floor(Math.max(elementHeight, parentHeight))),
      })
    }
    updateSize()

    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    if (element.parentElement) {
      observer.observe(element.parentElement)
    }

    return () => observer.disconnect()
  }, [ref])

  return size
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

  const halfStrikeRows = rows.filter((row) => row.strike % 500 === 0)

  return halfStrikeRows.length > 0 ? halfStrikeRows : rows
}

function getVisibleLevelMarkers(levelMarkers: GexLevelMarker[], data: ChartDatum[]) {
  if (data.length === 0) {
    return []
  }

  const strikes = data.map((datum) => datum.strike)
  const minStrike = Math.min(...strikes)
  const maxStrike = Math.max(...strikes)

  return levelMarkers.filter((marker) => marker.strike >= minStrike && marker.strike <= maxStrike)
}

function groupLevelMarkers(levelMarkers: GexLevelMarker[]) {
  const groups = new Map<number, GexLevelMarker[]>()

  for (const marker of levelMarkers) {
    const group = groups.get(marker.strike)

    if (group) {
      group.push(marker)
    } else {
      groups.set(marker.strike, [marker])
    }
  }

  return Array.from(groups.values()).map((group) => {
    const [primary] = group
    const styleMarker =
      group.find((marker) => marker.id === 'advanced-zero-gamma')
      ?? group.find((marker) => marker.id === 'advanced-gamma-flip')
      ?? primary

    return {
      ...styleMarker,
      strike: primary.strike,
      axisOnly: group.every((marker) => marker.axisOnly),
      id: group.map((marker) => marker.id).join('__'),
      label: group.map((marker) => marker.label).join(' / '),
      components: group,
    }
  })
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
  const positive = getPositiveGammaExposure(call, put)
  const negative = getNegativeGammaExposure(call, put)

  return {
    strike: row.strike,
    netGexUsd: net,
    callGexUsd: call,
    putGexUsd: put,
    positiveGexUsd: positive,
    negativeGexUsd: negative,
    displayGexUsd: getDisplayExposureValue(net, call, put, mode),
  }
}

function getPositiveGammaExposure(call: number, put: number) {
  return Math.max(call, 0) + Math.max(put, 0)
}

function getNegativeGammaExposure(call: number, put: number) {
  return Math.min(call, 0) + Math.min(put, 0)
}

function getDisplayExposureValue(net: number, call: number, put: number, mode: GexMode) {
  if (mode === 'call') return call
  if (mode === 'put') return put
  if (mode === 'abs') return Math.abs(net)
  return net
}

function getChartDimensions(width: number, height: number): ChartDimensions {
  return {
    width,
    height,
    margin,
  }
}

function getAreaChartDimensions(width: number, height: number): ChartDimensions {
  return {
    width,
    height,
    margin: areaMargin,
  }
}

function getChartLayout(
  data: ChartDatum[],
  spot: number,
  dimensions: ChartDimensions,
  mode: GexMode,
  dataWindowPct: number | 'full',
  levelMarkers: GexLevelMarker[],
  axisMarkers: GexLevelMarker[],
) {
  const innerWidth = dimensions.width - dimensions.margin.left - dimensions.margin.right
  const innerHeight = dimensions.height - dimensions.margin.top - dimensions.margin.bottom
  const maxAbsGex = Math.max(...data.flatMap((datum) => {
    const values = [
      Math.abs(datum.displayGexUsd),
      Math.abs(datum.callGexUsd),
      Math.abs(datum.putGexUsd),
    ]

    if (mode === 'split') {
      values.push(Math.abs(datum.positiveGexUsd), Math.abs(datum.negativeGexUsd))
    }

    return values
  }), 10_000_000)
  const domainMax = getRoundedDomainMax(maxAbsGex * barChartDomainPadding)
  const strikes = data.map((datum) => datum.strike)
  const minStrike = Math.min(...strikes, spot)
  const maxStrike = Math.max(...strikes, spot)
  const xScale = scaleLinear<number, number>()
    .domain([-domainMax, domainMax])
    .range([dimensions.margin.left, dimensions.margin.left + innerWidth])
  const yScale = scaleLinear<number, number>()
    .domain([minStrike, maxStrike])
    .range([dimensions.margin.top + innerHeight, dimensions.margin.top])
  const rowHeight = getContinuousBarRowHeight(strikes, yScale, dataWindowPct)

  return {
    innerWidth,
    innerHeight,
    xScale,
    yScale,
    rowHeight,
    spotY: yScale(spot),
    levelMarkers: positionBarLevelMarkers(levelMarkers, yScale),
    axisMarkers: positionBarLevelMarkers(axisMarkers, yScale),
    xTicks: buildMillionTicks(domainMax),
    yAxisTicks: buildStrikeAxisTicks(minStrike, maxStrike, yScale, dimensions, dataWindowPct),
    closestSpotStrike: getClosestStrike(strikes, spot),
  }
}

function positionBarLevelMarkers(
  markers: GexLevelMarker[],
  yScale: ScaleLinear<number, number>,
) {
  return markers.map((marker) => ({
    ...marker,
    y: yScale(marker.strike),
  }))
}

function getContinuousBarRowHeight(
  strikes: number[],
  yScale: ScaleLinear<number, number>,
  dataWindowPct: number | 'full',
) {
  const sortedStrikes = Array.from(new Set(strikes)).sort((a, b) => a - b)
  const pixelGaps = sortedStrikes.slice(1).map((strike, index) => (
    Math.abs(yScale(strike) - yScale(sortedStrikes[index]))
  ))
  const closestGap = pixelGaps.length > 0 ? Math.min(...pixelGaps) : getFallbackContinuousRowHeight(dataWindowPct)

  return clamp(closestGap * 0.82, 4.5, 22)
}

function getFallbackContinuousRowHeight(dataWindowPct: number | 'full') {
  if (dataWindowPct === 'full') return 5
  if (dataWindowPct <= 5) return 22
  if (dataWindowPct <= 18) return 14

  return 8
}

function getAreaChartLayout(
  data: ChartDatum[],
  spot: number,
  dimensions: ChartDimensions,
  mode: GexMode,
  levelMarkers: GexLevelMarker[],
  axisMarkers: GexLevelMarker[],
): AreaChartLayout {
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
  const yDomain = getAreaChartYDomain(sortedData, mode)
  const yScale = scaleLinear<number, number>()
    .domain(yDomain)
    .range([dimensions.margin.top + innerHeight, dimensions.margin.top])

  return {
    data: sortedData,
    profileData: addZeroCrossings(sortedData),
    innerWidth,
    innerHeight,
    xScale,
    yScale,
    xTicks: xScale.ticks(getAreaXAxisTickCount(dimensions.width)),
    yTicks: getAreaYAxisTicks(yScale, yDomain),
    zeroY: yScale(0),
    spotX: xScale(spot),
    levelMarkers: levelMarkers.map((marker) => ({ ...marker, x: xScale(marker.strike) })),
    axisMarkers: axisMarkers.map((marker) => ({ ...marker, x: xScale(marker.strike) })),
  }
}

function getAreaYAxisTicks(yScale: ScaleLinear<number, number>, domain: [number, number]) {
  const [min, max] = domain
  const minTickPixelGap = 16
  const candidates = [
    { tick: min, priority: 3 },
    { tick: max, priority: 3 },
    { tick: 0, priority: 4 },
    ...yScale.ticks(5).map((tick) => ({ tick, priority: 2 })),
  ]
    .filter(({ tick }) => tick >= min && tick <= max)
    .map(({ tick, priority }) => ({ tick: Math.round(tick), priority }))
    .sort((a, b) => b.priority - a.priority)

  const ticks: number[] = []

  for (const { tick } of candidates) {
    const overlapsExistingTick = ticks.some((selectedTick) => (
      Math.abs(yScale(selectedTick) - yScale(tick)) < minTickPixelGap
    ))

    if (!overlapsExistingTick) {
      ticks.push(tick)
    }
  }

  return Array.from(new Set(ticks)).sort((a, b) => a - b)
}

function getAreaChartYDomain(data: ChartDatum[], mode: GexMode): [number, number] {
  if (mode === 'abs') {
    const maxGex = Math.max(...data.flatMap((datum) => [Math.abs(datum.callGexUsd), Math.abs(datum.putGexUsd)]), 10_000_000)
    const domainMax = getRoundedDomainMax(maxGex * areaChartDomainPadding)

    return [0, domainMax]
  }

  const maxPositiveGex = Math.max(...data.map((datum) => datum.netGexUsd), 0)
  const minNegativeGex = Math.min(...data.map((datum) => datum.netGexUsd), 0)
  const upperDomain = getRoundedDomainMax(maxPositiveGex * areaChartDomainPadding)
  const lowerMagnitude = minNegativeGex < 0
    ? Math.abs(minNegativeGex) + profileNegativeDomainBuffer
    : profileNegativeDomainBuffer
  const lowerDomain = -getRoundedProfileDomainMagnitude(lowerMagnitude)

  return [lowerDomain, upperDomain]
}

function getRoundedProfileDomainMagnitude(value: number) {
  const safeValue = Math.max(Math.abs(value), 1_000_000)
  const step = getProfileDomainStep(safeValue)

  return Math.ceil(safeValue / step) * step
}

function getProfileDomainStep(value: number) {
  if (value <= 25_000_000) {
    return 1_000_000
  }

  if (value <= 60_000_000) {
    return 5_000_000
  }

  if (value <= 120_000_000) {
    return 10_000_000
  }

  if (value <= 250_000_000) {
    return 25_000_000
  }

  return 50_000_000
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

function getYAxisStrikeStep(dataWindowPct: number | 'full') {
  if (dataWindowPct === 'full') return 20_000
  if (dataWindowPct <= 2.5) return 250
  if (dataWindowPct <= 5) return 500
  if (dataWindowPct <= 10) return 1_000
  if (dataWindowPct <= 18) return 2_500
  if (dataWindowPct <= 35) return 5_000
  if (dataWindowPct <= 65) return 10_000

  return 20_000
}

function buildStrikeAxisTicks(
  minStrike: number,
  maxStrike: number,
  strikeScale: ScaleLinear<number, number>,
  dimensions: ChartDimensions,
  dataWindowPct: number | 'full',
): StrikeAxisTick[] {
  const step = getYAxisStrikeStep(dataWindowPct)
  const firstTick = Math.ceil(minStrike / step) * step
  const lastTick = Math.floor(maxStrike / step) * step
  const ticks: StrikeAxisTick[] = []
  const minY = dimensions.margin.top + 8
  const maxY = dimensions.height - dimensions.margin.bottom - 8

  for (let strike = firstTick; strike <= lastTick; strike += step) {
    const y = strikeScale(strike)

    if (y >= minY && y <= maxY) {
      ticks.push({ strike, y })
    }
  }

  return ticks
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
        positiveGexUsd: interpolate(previous.positiveGexUsd, current.positiveGexUsd, interpolation),
        negativeGexUsd: interpolate(previous.negativeGexUsd, current.negativeGexUsd, interpolation),
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

function getTooltipX(bar: BarGeometry, dimensions: ChartDimensions, side: TooltipSide) {
  const anchor = side === 'right' ? bar.x + bar.width : bar.x

  return (Math.max(dimensions.margin.left, Math.min(anchor, dimensions.width - dimensions.margin.right)) / dimensions.width) * 100
}

function getTooltipTransform(side: TooltipSide) {
  return side === 'left' ? 'translate(calc(-100% - 12px), -50%)' : 'translate(12px, -50%)'
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
    side: datumValue < 0 ? 'left' : 'right',
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
  fillId,
  positive,
  stroke,
  height,
}: {
  bar: BarGeometry
  fillId: string
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
        fill={`url(#${fillId})`}
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
  negativeFillId,
  positiveFillId,
  xScale,
  y,
  rowHeight,
}: {
  datum: ChartDatum
  negativeFillId: string
  positiveFillId: string
  xScale: ScaleLinear<number, number>
  y: number
  rowHeight: number
}) {
  const positiveBar = getBarGeometry(datum.positiveGexUsd, xScale, y)
  const negativeBar = getBarGeometry(datum.negativeGexUsd, xScale, y)

  return (
    <>
      <SingleBar bar={negativeBar} fillId={negativeFillId} positive={false} stroke="var(--chart-negative-edge)" height={rowHeight} />
      <SingleBar bar={positiveBar} fillId={positiveFillId} positive stroke="var(--chart-positive-edge)" height={rowHeight} />
    </>
  )
}

function BarHoverTarget({
  bar,
  datum,
  dimensions,
  height,
  setHovered,
  side,
}: {
  bar: BarGeometry
  datum: ChartDatum
  dimensions: ChartDimensions
  height: number
  setHovered: (hovered: HoverState | null) => void
  side: TooltipSide
}) {
  if (bar.width < 0.5) {
    return null
  }

  const targetHeight = Math.max(height, 7)
  const showTooltip = () => {
    setHovered({
      datum,
      xPct: getTooltipX(bar, dimensions, side),
      yPct: (bar.y / dimensions.height) * 100,
      side,
    })
  }

  return (
    <rect
      x={bar.x}
      y={bar.y - targetHeight / 2}
      width={bar.width}
      height={targetHeight}
      fill="transparent"
      pointerEvents="all"
      onMouseEnter={showTooltip}
      onMouseMove={showTooltip}
      onMouseLeave={() => setHovered(null)}
    />
  )
}
