import { ChevronDown, ChevronUp } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Panel } from '@/components/terminal/Panel'
import { Button } from '@/components/ui/button'
import { getSpotDistanceColor } from '@/data/levelColors'
import type { RankingRow } from '@/data/mockTerminal'
import { formatMillions, formatSignedPercent, formatStrike } from '@/lib/formatters'
import { cn } from '@/lib/utils'

export type RankingScope = 'allExpiry' | 'zeroDte'

type RankingTableProps = {
  title: string
  scope: RankingScope
  rows: RankingRow[]
  collapsed?: boolean
  titleAccessory?: ReactNode
  onCollapsedChange?: (collapsed: boolean) => void
}

const spotProximityThresholdPercent = 0.5
const tradingPatternThresholdPercent = 0.25
const tradingSignatureThresholdPercent = 0.1

export function RankingTable({ title, scope, rows, collapsed = false, titleAccessory, onCollapsedChange }: RankingTableProps) {
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
              title={collapsed ? 'Expand lower panels' : 'Collapse lower panels'}
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
        'flex h-full min-h-0 flex-col',
        collapsed ? 'justify-center py-2' : 'min-h-[292px]',
      )}
    >
      {collapsed ? null : (
        <>
          <div className={cn(rankingGridColumns, 'grid border-b border-[var(--terminal-rule)] px-1 pb-1 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-muted)]')}>
            <div>Rank</div>
            <div>Strike</div>
            <div>Dist</div>
            <div>Gamma Exposure</div>
            <div />
          </div>
          <div className="grid flex-1" style={{ gridTemplateRows: `repeat(${rows.length}, minmax(var(--terminal-table-row), 1fr))` }}>
            {rows.map((row) => {
              const positive = row.gammaExposureUsd >= 0
              const width = `${Math.max(12, (Math.abs(row.gammaExposureUsd) / maxAbs) * 100)}%`
              const key = getRankingRowKey(scope, row)
              const highlightColor = positive ? 'var(--terminal-green-strong)' : 'var(--terminal-red-strong)'
              const proximityTier = getTradingProximityTier(row.distanceFromSpotPercent)
              const highlightStyle = getTradingHighlightStyle(row.distanceFromSpotPercent, highlightColor, proximityTier)

              return (
                <div
                  key={key}
                  className={getRowClassName(Boolean(highlightStyle))}
                  style={highlightStyle}
                >
                  <TradingLevelFlow color={highlightColor} tier={proximityTier} />
                  <div className="terminal-value relative z-10 text-[10.5px] text-[var(--terminal-muted)]">{row.rank}</div>
                  <div className="terminal-value relative z-10 min-w-0 whitespace-nowrap text-[11px] font-semibold text-[var(--terminal-heading)]">
                    ${formatStrike(row.strike)}
                  </div>
                  <div
                    className="terminal-value relative z-10 whitespace-nowrap text-[9.75px]"
                    style={{ color: getSpotDistanceColor(row.distanceFromSpotPercent) }}
                  >
                    {formatSignedPercent(row.distanceFromSpotPercent)}
                  </div>
                  <div className="relative z-10 h-px bg-[color-mix(in_srgb,var(--terminal-border)_62%,transparent)]">
                    <div
                      className={positive ? 'h-full bg-[var(--chart-positive-edge)]' : 'h-full bg-[var(--chart-negative-edge)]'}
                      style={{ width }}
                    />
                  </div>
                  <div className={positive ? 'terminal-value relative z-10 text-right text-[10.75px] text-[var(--terminal-green-strong)]' : 'terminal-value relative z-10 text-right text-[10.75px] text-[var(--terminal-red-strong)]'}>
                    {formatMillions(row.gammaExposureUsd)}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </Panel>
  )
}

const rankingGridColumns = 'grid-cols-[44px_112px_64px_minmax(224px,1fr)_78px]'

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
  const edgeMix = 12 + intensity * 20

  return {
    boxShadow: `inset 2px 0 0 color-mix(in srgb, ${color} ${edgeMix}%, transparent)`,
  }
}

function getRowClassName(highlighted: boolean) {
  const baseClassName = cn(
    'group relative grid w-full items-center overflow-hidden border-b border-[var(--terminal-rule)] bg-transparent px-1 py-0 text-left text-[10.75px] font-normal leading-[16px] transition-[background-color,box-shadow,color] last:border-b-0 hover:bg-[var(--terminal-surface-2)]',
    rankingGridColumns,
  )

  return highlighted ? `${baseClassName} hover:bg-[color-mix(in_srgb,var(--terminal-surface-2)_78%,transparent)]` : baseClassName
}
