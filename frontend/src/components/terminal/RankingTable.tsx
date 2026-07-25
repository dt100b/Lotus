import { ChevronDown, ChevronUp } from 'lucide-react'
import { memo, type CSSProperties, type ReactNode } from 'react'
import { Panel } from '@/components/terminal/Panel'
import { Button } from '@/components/ui/button'
import { getSpotDistanceColor } from '@/data/levelColors'
import type { RankingRow } from '@/data/mockTerminal'
import { formatMillions, formatSignedPercent, formatStrike } from '@/lib/formatters'
import { cn } from '@/lib/utils'

/** Opaque key prefix for ranking row React keys (panel identity). */
export type RankingScope = string

type RankingTableProps = {
  title: string
  scope: RankingScope
  rows: RankingRow[]
  collapsed?: boolean
  titleAccessory?: ReactNode
  onCollapsedChange?: (collapsed: boolean) => void
  className?: string
}

const spotProximityThresholdPercent = 0.5
const tradingPatternThresholdPercent = 0.25
const tradingSignatureThresholdPercent = 0.1

export const RankingTable = memo(function RankingTable({
  title,
  scope,
  rows,
  collapsed = false,
  titleAccessory,
  onCollapsedChange,
  className,
}: RankingTableProps) {
  const maxAbs = Math.max(1, ...rows.map((row) => Math.abs(row.gammaExposureUsd)))

  return (
    <Panel
      title={title}
      titleAccessory={(titleAccessory || onCollapsedChange) ? (
        <div className="flex items-center gap-1">
          {titleAccessory}
          {onCollapsedChange ? (
            <Button
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand lower panels' : 'Collapse lower panels'}
              variant={collapsed ? 'active' : 'default'}
              size="icon"
              className="h-[20px] w-[20px] px-0"
              onClick={() => onCollapsedChange(!collapsed)}
            >
              {collapsed ? <ChevronDown className="h-[12px] w-[12px]" /> : <ChevronUp className="h-[12px] w-[12px]" />}
            </Button>
          ) : null}
        </div>
      ) : null}
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden',
        collapsed ? 'justify-center py-2' : '',
        className,
      )}
    >
      {collapsed ? null : (
        <div className="gex-ranking-well flex min-h-0 flex-1 flex-col">
          <div className={cn(rankingGridColumns, 'gex-ranking-header grid px-1.5 pb-1.5 pt-0.5 text-[8.5px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-muted)]')}>
            <div>Rank</div>
            <div>Strike</div>
            <div>Dist</div>
            <div>Net GEX</div>
            <div className="text-right">GEX</div>
          </div>
          <div className="grid flex-1" style={{ gridTemplateRows: `repeat(${rows.length}, minmax(var(--terminal-table-row), 1fr))` }}>
            {rows.map((row) => {
              const positive = row.gammaExposureUsd >= 0
              const width = `${Math.max(10, (Math.abs(row.gammaExposureUsd) / maxAbs) * 100)}%`
              const key = getRankingRowKey(scope, row)
              const highlightColor = positive ? 'var(--terminal-green-strong)' : 'var(--terminal-red-strong)'
              const proximityTier = getTradingProximityTier(row.distanceFromSpotPercent)
              const highlightStyle = getTradingHighlightStyle(row.distanceFromSpotPercent, highlightColor, proximityTier)
              const topRank = row.rank <= 3

              return (
                <div
                  key={key}
                  className={getRowClassName(Boolean(highlightStyle))}
                  style={highlightStyle}
                >
                  <TradingLevelFlow color={highlightColor} tier={proximityTier} />
                  <div className={cn(
                    'relative z-10 text-[10px] tabular-nums',
                    topRank
                      ? 'font-semibold text-[var(--terminal-heading)]'
                      : 'font-medium text-[var(--terminal-muted)]',
                  )}>
                    {row.rank}
                  </div>
                  <div className="relative z-10 min-w-0 whitespace-nowrap text-[11px] font-semibold tabular-nums text-[var(--terminal-heading)]">
                    ${formatStrike(row.strike)}
                  </div>
                  <div
                    className="relative z-10 whitespace-nowrap text-[10px] tabular-nums font-medium"
                    style={{ color: getSpotDistanceColor(row.distanceFromSpotPercent) }}
                  >
                    {formatSignedPercent(row.distanceFromSpotPercent)}
                  </div>
                  <div className="gex-ranking-bar relative z-10">
                    <div
                      className={positive ? 'gex-ranking-bar__fill gex-ranking-bar__fill--pos' : 'gex-ranking-bar__fill gex-ranking-bar__fill--neg'}
                      style={{ width }}
                    />
                  </div>
                  <div className={cn(
                    'relative z-10 text-right text-[10.5px] font-semibold tabular-nums',
                    positive ? 'text-[var(--terminal-green-strong)]' : 'text-[var(--terminal-red-strong)]',
                  )}>
                    {formatMillions(row.gammaExposureUsd)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Panel>
  )
})

const rankingGridColumns = 'grid-cols-[40px_108px_60px_minmax(200px,1fr)_82px]'

function getRankingRowKey(scope: RankingScope, row: Pick<RankingRow, 'strike'>) {
  return `${scope}:${row.strike}`
}

type TradingProximityTier = 'none' | 'near' | 'pattern' | 'signature'

function TradingLevelFlow({ color, tier }: { color: string, tier: TradingProximityTier }) {
  if (tier === 'none') {
    return null
  }

  const flowStyle = {
    '--level-flow-color': color,
  } as CSSProperties

  return <div aria-hidden="true" className={`level-proximity-flow level-proximity-flow--${tier}`} style={flowStyle} />
}

function getTradingProximityTier(distanceFromSpotPercent: number | undefined): TradingProximityTier {
  if (distanceFromSpotPercent === undefined || !Number.isFinite(distanceFromSpotPercent)) {
    return 'none'
  }

  const distance = Math.abs(distanceFromSpotPercent)
  if (distance <= tradingSignatureThresholdPercent) {
    return 'signature'
  }

  if (distance <= tradingPatternThresholdPercent) {
    return 'pattern'
  }

  return distance <= spotProximityThresholdPercent ? 'near' : 'none'
}

function getTradingHighlightStyle(
  distanceFromSpotPercent: number | undefined,
  color: string,
  tier: TradingProximityTier,
): CSSProperties | undefined {
  if (tier === 'none' || distanceFromSpotPercent === undefined || !Number.isFinite(distanceFromSpotPercent)) {
    return undefined
  }

  const distance = Math.abs(distanceFromSpotPercent)
  const intensity = 1 - Math.min(distance / spotProximityThresholdPercent, 1)
  const edgeMix = 14 + intensity * 22

  return {
    boxShadow: `inset 2px 0 0 color-mix(in srgb, ${color} ${edgeMix}%, transparent)`,
  }
}

function getRowClassName(highlighted: boolean) {
  const baseClassName = cn(
    rankingGridColumns,
    'gex-ranking-row group relative grid w-full items-center overflow-hidden px-1.5 py-0 text-left text-[10.75px] font-normal leading-[16px] transition-[background-color,box-shadow,color]',
  )

  return highlighted ? `${baseClassName} gex-ranking-row--prox` : baseClassName
}
