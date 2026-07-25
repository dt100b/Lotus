import { useMemo, useState } from 'react'
import { scaleLinear, scaleLog } from 'd3-scale'
import { GexHoverCard, type GexHoverSide } from '@/components/terminal/GexHoverCard'
import type { RankingRow, TerminalSnapshot } from '@/data/mockTerminal'
import { formatMillions, formatStrike } from '@/lib/formatters'
import { cn } from '@/lib/utils'

type WallSignificanceChartProps = {
  snapshot: TerminalSnapshot
}

type WallDatum = {
  id: string
  /** OI-aware rank: 1 = highest significanceScore (not pure |GEX|). */
  rank: number
  strike: number
  openInterest: number
  gammaExposureUsd: number
  callGammaExposureUsd: number
  putGammaExposureUsd: number
  absGexUsd: number
  /** |net GEX| × [log10(OI + 10)]² */
  significanceScore: number
}

type HoveredWall = {
  datum: WallDatum
  xPct: number
  yPct: number
  side: GexHoverSide
}

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

/**
 * OI-aware wall score: |net GEX| × [log10(OI + 10)]²
 *
 * Squaring the log term is a close variant of |GEX|×log10(OI+10) that gives
 * open-interest mass real leverage — pure max-|GEX| thin books (e.g. 64.5k
 * with huge GEX but tiny OI) no longer dominate high-OI walls (e.g. 70k).
 */
export function wallSignificanceScore(absGexUsd: number, openInterest: number): number {
  const oiMass = Math.log10(openInterest + 10)
  return absGexUsd * oiMass * oiMass
}

export function WallSignificanceChart({ snapshot }: WallSignificanceChartProps) {
  const [hovered, setHovered] = useState<HoveredWall | null>(null)
  const data = useMemo(() => prepareWallData(snapshot.rankings.allExpiry), [snapshot.rankings.allExpiry])
  const layout = useMemo(() => getWallMapLayout(data, snapshot.spot), [data, snapshot.spot])
  // Highest OI-aware significance — not pure max |GEX|.
  const strongestWall = data[0]

  if (data.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center text-[10px] text-[var(--desk-label,var(--terminal-muted))]">
        No wall data available
      </div>
    )
  }

  return (
    <div className="walls-desk">
      <div className="walls-desk__head">
        <div className="min-w-0">
          <h3 className="walls-desk__title">OI Weighted GEX</h3>
          <div className="walls-desk__subtitle">Net GEX × open interest</div>
        </div>
        <div>
          <div
            className={cn(
              'walls-desk__top-strike',
              strongestWall.gammaExposureUsd >= 0
                ? 'walls-desk__top-strike--pos'
                : 'walls-desk__top-strike--neg',
            )}
          >
            ${formatStrike(strongestWall.strike)}
          </div>
          <div className="walls-desk__top-label">top wall</div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        className="block min-h-0 w-full flex-1"
        role="img"
        aria-label="OI-weighted GEX wall bubble map by strike and open interest"
        onMouseLeave={() => setHovered(null)}
      >
        <defs>
          <filter id="wall-bubble-glow" x="-60%" y="-60%" width="220%" height="220%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect
          x={dimensions.margin.left}
          y={dimensions.margin.top}
          width={layout.innerWidth}
          height={layout.innerHeight}
          fill="var(--chart-well-fill)"
        />
        <rect
          x={dimensions.margin.left + 0.5}
          y={dimensions.margin.top + 0.5}
          width={layout.innerWidth - 1}
          height={layout.innerHeight - 1}
          fill="none"
          stroke="var(--chart-well-edge)"
          strokeOpacity={0.42}
        />

        {layout.xTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={layout.xScale(tick)}
              x2={layout.xScale(tick)}
              y1={dimensions.margin.top}
              y2={dimensions.margin.top + layout.innerHeight}
              stroke="var(--terminal-grid)"
              strokeDasharray="1 6"
              strokeOpacity={0.55}
            />
            <text
              x={layout.xScale(tick)}
              y={dimensions.height - 25}
              textAnchor="middle"
              fill="var(--desk-label, var(--terminal-muted))"
              fontSize="8.5"
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
              strokeDasharray="1 6"
              strokeOpacity={0.55}
            />
            <text
              x={dimensions.margin.left - 8}
              y={layout.yScale(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--desk-label, var(--terminal-muted))"
              fontSize="8.5"
              fontFamily="var(--font-mono)"
              opacity={0.78}
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
          stroke="var(--chart-spot-line)"
          strokeWidth={3.5}
          strokeOpacity={0.06}
          pointerEvents="none"
        />
        <line
          x1={layout.spotX}
          x2={layout.spotX}
          y1={dimensions.margin.top}
          y2={dimensions.margin.top + layout.innerHeight}
          stroke="var(--chart-spot-line)"
          strokeWidth={1}
          strokeOpacity={0.78}
          pointerEvents="none"
        />
        <text
          x={layout.spotX}
          y={dimensions.margin.top - 8}
          textAnchor="middle"
          fill="var(--desk-value, var(--terminal-heading))"
          fontSize="8.5"
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
          const isHovered = hovered?.datum.id === datum.id
          const isTopWall = datum.rank === 1
          const fill = positive ? 'var(--desk-wall-pos, var(--chart-positive-edge))' : 'var(--desk-wall-neg, var(--chart-negative-edge))'
          const glow = positive
            ? 'color-mix(in srgb, var(--desk-wall-pos, var(--chart-positive-edge)) 36%, transparent)'
            : 'color-mix(in srgb, var(--desk-wall-neg, var(--chart-negative-edge)) 34%, transparent)'

          return (
            <g key={datum.id}>
              {datum.rank <= 6 || isHovered ? (
                <circle
                  cx={x}
                  cy={y}
                  r={radius + (isTopWall ? 4.5 : 3.5)}
                  fill={glow}
                  opacity={isHovered || isTopWall ? 0.34 : 0.16}
                  filter="url(#wall-bubble-glow)"
                  pointerEvents="none"
                />
              ) : null}
              <circle
                cx={x}
                cy={y}
                r={radius}
                fill={fill}
                fillOpacity={isHovered ? 0.58 : isTopWall ? 0.48 : 0.34}
                stroke={fill}
                strokeOpacity={isHovered || isTopWall ? 0.82 : 0.58}
                strokeWidth={isHovered || isTopWall ? 1.5 : 0.95}
                aria-label={`Strike ${formatStrike(datum.strike)}, OI ${formatOpenInterest(datum.openInterest)}, GEX ${formatMillions(datum.gammaExposureUsd)}`}
                onMouseEnter={() => setHovered(getHoverState(datum, layout))}
                onMouseMove={() => setHovered(getHoverState(datum, layout))}
                onMouseLeave={() => setHovered(null)}
              />
            </g>
          )
        })}

        <text
          x={dimensions.margin.left + layout.innerWidth / 2}
          y={dimensions.height - 6}
          textAnchor="middle"
          fill="var(--desk-label, var(--terminal-muted))"
          fontSize="8.5"
        >
          Strike (USD)
        </text>
        <text
          x={16}
          y={dimensions.margin.top + layout.innerHeight / 2}
          textAnchor="middle"
          fill="var(--desk-label, var(--terminal-muted))"
          fontSize="8.5"
          transform={`rotate(-90 16 ${dimensions.margin.top + layout.innerHeight / 2})`}
        >
          Open interest log
        </text>
      </svg>

      <div className="walls-desk__legend">
        <BubbleLegendItem color="var(--desk-wall-pos, var(--chart-positive-edge))" label="Positive GEX" />
        <BubbleLegendItem color="var(--desk-wall-neg, var(--chart-negative-edge))" label="Negative GEX" />
        <BubbleLegendItem color="var(--desk-value, var(--terminal-heading))" label="Size = |GEX|" />
        <BubbleLegendItem color="var(--desk-value, var(--terminal-heading))" label="Spot" dashed />
      </div>

      {hovered ? (
        <GexHoverCard
          side={hovered.side}
          xPct={hovered.xPct}
          yPct={hovered.yPct}
          model={{
            strike: hovered.datum.strike,
            netGexUsd: hovered.datum.gammaExposureUsd,
            callGexUsd: hovered.datum.callGammaExposureUsd,
            putGexUsd: hovered.datum.putGammaExposureUsd,
            extras: [
              {
                label: 'Open interest',
                value: formatOpenInterest(hovered.datum.openInterest),
                tone: 'muted',
              },
            ],
          }}
        />
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
        id: `gravity-${row.strike}`,
        // Placeholder; replaced after OI-aware sort so rank 1 = top wall.
        rank: 0,
        strike: row.strike,
        openInterest: row.openInterest,
        gammaExposureUsd: row.gammaExposureUsd,
        callGammaExposureUsd: row.callGammaExposureUsd,
        putGammaExposureUsd: row.putGammaExposureUsd,
        absGexUsd,
        significanceScore: wallSignificanceScore(absGexUsd, row.openInterest),
      }
    })
    .sort((a, b) => {
      if (b.significanceScore !== a.significanceScore) {
        return b.significanceScore - a.significanceScore
      }
      // Tie-break: higher |GEX|, then higher OI, then lower strike for stability.
      if (b.absGexUsd !== a.absGexUsd) {
        return b.absGexUsd - a.absGexUsd
      }
      if (b.openInterest !== a.openInterest) {
        return b.openInterest - a.openInterest
      }
      return a.strike - b.strike
    })
    .map((datum, index) => ({
      ...datum,
      rank: index + 1,
    }))
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
