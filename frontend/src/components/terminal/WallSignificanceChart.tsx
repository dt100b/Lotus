import { useMemo, useState } from 'react'
import { scaleLinear, scaleLog } from 'd3-scale'
import type { RankingRow, TerminalSnapshot } from '@/data/mockTerminal'
import { formatMillions, formatStrike } from '@/lib/formatters'

type WallSignificanceChartProps = {
  snapshot: TerminalSnapshot
}

type WallDatum = {
  id: string
  rank: number
  strike: number
  openInterest: number
  gammaExposureUsd: number
  callGammaExposureUsd: number
  putGammaExposureUsd: number
  absGexUsd: number
  significanceScore: number
}

type HoveredWall = {
  datum: WallDatum
  xPct: number
  yPct: number
  side: TooltipSide
}

type TooltipSide = 'left' | 'right'

const dimensions = {
  width: 360,
  height: 560,
  margin: {
    top: 28,
    right: 16,
    bottom: 50,
    left: 58,
  },
}
const minBubbleRadius = 4.4
const maxBubbleRadius = 22
const yTickCandidates = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000]

export function WallSignificanceChart({ snapshot }: WallSignificanceChartProps) {
  const [hovered, setHovered] = useState<HoveredWall | null>(null)
  const data = useMemo(() => prepareWallData(snapshot.rankings.allExpiry), [snapshot.rankings.allExpiry])
  const layout = useMemo(() => getWallMapLayout(data, snapshot.spot), [data, snapshot.spot])
  const strongestWall = data[0]

  if (data.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center text-[11px] text-[var(--terminal-muted)]">
        No wall data available
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="min-w-0">
          <h3 className="text-[10.5px] font-semibold uppercase leading-none text-[var(--terminal-heading)]">
            Wall Significance
          </h3>
          <div className="mt-1 text-[9px] text-[var(--terminal-muted)]">
            OI-weighted gamma levels
          </div>
        </div>
        <div className="text-right">
          <div className={strongestWall.gammaExposureUsd >= 0 ? 'terminal-value text-[12px] font-semibold text-[var(--terminal-green-strong)]' : 'terminal-value text-[12px] font-semibold text-[var(--terminal-red-strong)]'}>
            ${formatStrike(strongestWall.strike)}
          </div>
          <div className="mt-1 text-[8.5px] text-[var(--terminal-muted)]">
            top wall
          </div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        className="block min-h-0 w-full flex-1"
        role="img"
        aria-label="Wall significance bubble map by strike and open interest"
        onMouseLeave={() => setHovered(null)}
      >
        <rect
          x={dimensions.margin.left}
          y={dimensions.margin.top}
          width={layout.innerWidth}
          height={layout.innerHeight}
          fill="var(--terminal-surface)"
          opacity="0.2"
        />

        {layout.xTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={layout.xScale(tick)}
              x2={layout.xScale(tick)}
              y1={dimensions.margin.top}
              y2={dimensions.margin.top + layout.innerHeight}
              stroke="var(--terminal-grid)"
              strokeDasharray="2 6"
            />
            <text
              x={layout.xScale(tick)}
              y={dimensions.height - 25}
              textAnchor="middle"
              fill="var(--terminal-muted)"
              fontSize="9"
              fontFamily="var(--font-mono)"
            >
              {formatStrike(tick)}
            </text>
          </g>
        ))}

        {layout.yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={dimensions.margin.left}
              x2={dimensions.margin.left + layout.innerWidth}
              y1={layout.yScale(tick)}
              y2={layout.yScale(tick)}
              stroke="var(--terminal-grid)"
            />
            <text
              x={dimensions.margin.left - 8}
              y={layout.yScale(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--terminal-muted)"
              fontSize="9"
              fontFamily="var(--font-mono)"
            >
              {formatOpenInterestTick(tick)}
            </text>
          </g>
        ))}

        <line
          x1={layout.spotX}
          x2={layout.spotX}
          y1={dimensions.margin.top}
          y2={dimensions.margin.top + layout.innerHeight}
          stroke="var(--terminal-heading)"
          strokeDasharray="4 5"
          strokeOpacity="0.72"
          pointerEvents="none"
        />
        <text
          x={layout.spotX}
          y={dimensions.margin.top - 8}
          textAnchor="middle"
          fill="var(--terminal-heading)"
          fontSize="9"
          fontFamily="var(--font-mono)"
          fontWeight="600"
        >
          Spot
        </text>

        {layout.bubbles.map((datum) => {
          const x = layout.xScale(datum.strike)
          const y = layout.yScale(datum.openInterest)
          const radius = layout.getRadius(datum)
          const positive = datum.gammaExposureUsd >= 0

          return (
            <circle
              key={datum.id}
              cx={x}
              cy={y}
              r={radius}
              fill={positive ? 'var(--terminal-green-strong)' : 'var(--terminal-red-strong)'}
              fillOpacity={hovered?.datum.id === datum.id ? 0.62 : 0.4}
              stroke={positive ? 'var(--chart-positive-edge)' : 'var(--chart-negative-edge)'}
              strokeOpacity={hovered?.datum.id === datum.id ? 0.96 : 0.78}
              strokeWidth={hovered?.datum.id === datum.id ? 1.6 : 1}
              onMouseEnter={() => setHovered(getHoverState(datum, layout))}
              onMouseMove={() => setHovered(getHoverState(datum, layout))}
            >
              <title>
                {`Strike ${formatStrike(datum.strike)}, OI ${formatOpenInterest(datum.openInterest)}, GEX ${formatMillions(datum.gammaExposureUsd)}`}
              </title>
            </circle>
          )
        })}

        <text
          x={dimensions.margin.left + layout.innerWidth / 2}
          y={dimensions.height - 6}
          textAnchor="middle"
          fill="var(--terminal-muted)"
          fontSize="9.5"
        >
          Strike price
        </text>
        <text
          x={16}
          y={dimensions.margin.top + layout.innerHeight / 2}
          textAnchor="middle"
          fill="var(--terminal-muted)"
          fontSize="9.5"
          transform={`rotate(-90 16 ${dimensions.margin.top + layout.innerHeight / 2})`}
        >
          Open interest log
        </text>
      </svg>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[8.5px] text-[var(--terminal-muted)]">
        <BubbleLegendItem color="var(--terminal-green-strong)" label="Positive GEX" />
        <BubbleLegendItem color="var(--terminal-red-strong)" label="Negative GEX" />
        <BubbleLegendItem color="var(--terminal-heading)" label="Size = |GEX|" />
        <BubbleLegendItem color="var(--terminal-heading)" label="Spot" dashed />
      </div>

      {hovered ? (
        <div
          className="pointer-events-none absolute z-10 min-w-44 rounded-[var(--terminal-radius-sm)] border border-[var(--terminal-border-strong)] bg-[var(--terminal-surface)]/95 px-3 py-2 text-left text-[11px] text-[var(--terminal-text)] shadow-2xl backdrop-blur"
          style={{
            left: `${hovered.xPct}%`,
            top: `${hovered.yPct}%`,
            transform: hovered.side === 'left' ? 'translate(calc(-100% - 10px), -50%)' : 'translate(10px, -50%)',
          }}
        >
          <div className="mb-1 text-[var(--terminal-heading)]">Strike {formatStrike(hovered.datum.strike)}</div>
          <div className={hovered.datum.gammaExposureUsd >= 0 ? 'terminal-value text-[var(--terminal-green-strong)]' : 'terminal-value text-[var(--terminal-red-strong)]'}>
            Net GEX {formatMillions(hovered.datum.gammaExposureUsd)}
          </div>
          <div className="terminal-value mt-1 text-[var(--terminal-text)]">
            OI {formatOpenInterest(hovered.datum.openInterest)}
          </div>
          <div className="terminal-value text-[var(--terminal-green)]">
            Calls {formatMillions(hovered.datum.callGammaExposureUsd)}
          </div>
          <div className="terminal-value text-[var(--terminal-red)]">
            Puts {formatMillions(hovered.datum.putGammaExposureUsd)}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function BubbleLegendItem({ color, dashed = false, label }: { color: string; dashed?: boolean; label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden="true"
        className={dashed ? 'h-px w-4 border-t border-dashed' : 'h-2 w-2 rounded-full'}
        style={dashed ? { borderColor: color } : { background: color }}
      />
      <span className="truncate">{label}</span>
    </span>
  )
}

function prepareWallData(rows: RankingRow[]): WallDatum[] {
  return rows
    .filter((row) => row.openInterest > 0 && Math.abs(row.gammaExposureUsd) > 0)
    .map((row) => {
      const absGexUsd = Math.abs(row.gammaExposureUsd)

      return {
        id: `${row.strike}-${row.rank}`,
        rank: row.rank,
        strike: row.strike,
        openInterest: row.openInterest,
        gammaExposureUsd: row.gammaExposureUsd,
        callGammaExposureUsd: row.callGammaExposureUsd,
        putGammaExposureUsd: row.putGammaExposureUsd,
        absGexUsd,
        significanceScore: absGexUsd * Math.log10(row.openInterest + 10),
      }
    })
    .sort((a, b) => b.significanceScore - a.significanceScore)
}

function getWallMapLayout(data: WallDatum[], spot: number) {
  const innerWidth = dimensions.width - dimensions.margin.left - dimensions.margin.right
  const innerHeight = dimensions.height - dimensions.margin.top - dimensions.margin.bottom
  const strikes = data.map((datum) => datum.strike)
  const openInterestValues = data.map((datum) => datum.openInterest)
  const minStrike = Math.min(...strikes, spot)
  const maxStrike = Math.max(...strikes, spot)
  const strikePadding = Math.max((maxStrike - minStrike) * 0.08, 500)
  const minOpenInterest = Math.max(1, Math.min(...openInterestValues) * 0.74)
  const maxOpenInterest = Math.max(minOpenInterest * 1.5, Math.max(...openInterestValues) * 1.24)
  const xScale = scaleLinear()
    .domain([minStrike - strikePadding, maxStrike + strikePadding])
    .range([dimensions.margin.left, dimensions.margin.left + innerWidth])
  const yScale = scaleLog()
    .domain([minOpenInterest, maxOpenInterest])
    .range([dimensions.margin.top + innerHeight, dimensions.margin.top])
    .clamp(true)
  const maxAbsGexUsd = Math.max(...data.map((datum) => datum.absGexUsd), 1)
  const getRadius = (datum: WallDatum) => minBubbleRadius
    + Math.sqrt(datum.absGexUsd / maxAbsGexUsd) * (maxBubbleRadius - minBubbleRadius)

  return {
    innerWidth,
    innerHeight,
    xScale,
    yScale,
    spotX: xScale(spot),
    xTicks: xScale.ticks(4),
    yTicks: getOpenInterestTicks(minOpenInterest, maxOpenInterest),
    bubbles: [...data].sort((a, b) => a.significanceScore - b.significanceScore),
    getRadius,
  }
}

function getOpenInterestTicks(minOpenInterest: number, maxOpenInterest: number) {
  const ticks = yTickCandidates.filter((tick) => tick >= minOpenInterest && tick <= maxOpenInterest)

  if (ticks.length >= 2) {
    return ticks
  }

  return Array.from(new Set([
    Math.round(minOpenInterest),
    Math.round(Math.sqrt(minOpenInterest * maxOpenInterest)),
    Math.round(maxOpenInterest),
  ])).filter((tick) => tick > 0)
}

function getHoverState(datum: WallDatum, layout: ReturnType<typeof getWallMapLayout>): HoveredWall {
  const x = layout.xScale(datum.strike)
  const y = layout.yScale(datum.openInterest)
  const xPct = clamp((x / dimensions.width) * 100, 8, 82)

  return {
    datum,
    xPct,
    yPct: clamp((y / dimensions.height) * 100, 18, 86),
    side: xPct > 58 ? 'left' : 'right',
  }
}

function formatOpenInterest(value: number) {
  return Math.round(value).toLocaleString('en-US')
}

function formatOpenInterestTick(value: number) {
  if (value >= 1_000) {
    return `${Number((value / 1_000).toFixed(value >= 10_000 ? 0 : 1))}k`
  }

  return formatOpenInterest(value)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
