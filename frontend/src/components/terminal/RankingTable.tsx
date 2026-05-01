import { ChevronDown, ChevronUp } from 'lucide-react'
import { Panel } from '@/components/terminal/Panel'
import { Button } from '@/components/ui/button'
import { getSpotDistanceColor } from '@/data/levelColors'
import type { RankingRow } from '@/data/mockTerminal'
import { formatMillions, formatSignedPercent, formatStrike } from '@/lib/formatters'
import { cn } from '@/lib/utils'

export type RankingScope = 'allExpiry' | 'zeroDte'

export type GexLevelSelection = {
  key: string
  scope: RankingScope
  title: string
  row: RankingRow
}

type RankingTableProps = {
  title: string
  scope: RankingScope
  rows: RankingRow[]
  collapsed?: boolean
  selectedKey?: string
  onCollapsedChange?: (collapsed: boolean) => void
  onRowSelect?: (selection: GexLevelSelection) => void
}

export function RankingTable({ title, scope, rows, collapsed = false, selectedKey, onCollapsedChange, onRowSelect }: RankingTableProps) {
  const maxAbs = Math.max(1, ...rows.map((row) => Math.abs(row.gammaExposureUsd)))

  return (
    <Panel
      title={title}
      titleAccessory={onCollapsedChange ? (
        <Button
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand Top 10 panels' : 'Collapse Top 10 panels'}
          title={collapsed ? 'Expand Top 10 panels' : 'Collapse Top 10 panels'}
          variant={collapsed ? 'active' : 'default'}
          size="icon"
          className="h-[20px] w-[20px] px-0"
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronDown className="h-[12px] w-[12px]" /> : <ChevronUp className="h-[12px] w-[12px]" />}
        </Button>
      ) : null}
      className={cn(
        'flex h-full min-h-0 flex-col',
        collapsed ? 'justify-center py-2' : 'min-h-[292px]',
      )}
    >
      {collapsed ? null : (
        <>
          <div className={cn(rankingGridColumns, 'grid border-b border-[var(--terminal-border)] px-1 pb-1 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-muted)]')}>
            <div>Rank</div>
            <div>Strike</div>
            <div>Vs Spot</div>
            <div>Gamma Exposure</div>
            <div />
          </div>
          <div className="grid flex-1" style={{ gridTemplateRows: `repeat(${rows.length}, minmax(var(--terminal-table-row), 1fr))` }}>
            {rows.map((row) => {
              const positive = row.gammaExposureUsd >= 0
              const width = `${Math.max(12, (Math.abs(row.gammaExposureUsd) / maxAbs) * 100)}%`
              const key = getRankingRowKey(scope, row)
              const selected = selectedKey === key

              return (
                <button
                  key={key}
                  aria-pressed={selected}
                  className={getRowClassName(selected)}
                  type="button"
                  onClick={() => onRowSelect?.({ key, scope, title, row })}
                >
                  <div className="terminal-value text-[10.75px] text-[var(--terminal-text)]">{row.rank}</div>
                  <div className="terminal-value text-[11px] font-semibold text-[var(--terminal-heading)]">${formatStrike(row.strike)}</div>
                  <div className="terminal-value text-[10.75px]" style={{ color: getSpotDistanceColor(row.distanceFromSpotPercent) }}>
                    {formatSignedPercent(row.distanceFromSpotPercent)}
                  </div>
                  <div className="h-1 border border-[var(--terminal-border)] bg-[var(--terminal-bg-soft)]">
                    <div
                      className={positive ? 'h-full bg-[var(--chart-positive)]' : 'h-full bg-[var(--chart-negative)]'}
                      style={{ width }}
                    />
                  </div>
                  <div className={positive ? 'terminal-value text-right text-[10.75px] text-[var(--terminal-green-strong)]' : 'terminal-value text-right text-[10.75px] text-[var(--terminal-red-strong)]'}>
                    {formatMillions(row.gammaExposureUsd)}
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}
    </Panel>
  )
}

const rankingGridColumns = 'grid-cols-[44px_106px_78px_minmax(152px,1fr)_78px]'

function getRankingRowKey(scope: RankingScope, row: Pick<RankingRow, 'strike'>) {
  return `${scope}:${row.strike}`
}

function getRowClassName(selected: boolean) {
  const baseClassName = cn(
    'group relative grid w-full cursor-pointer items-center overflow-hidden border-b border-[var(--terminal-border)] bg-transparent px-1 py-0 text-left text-[10.75px] font-normal leading-[16px] transition-[background-color,box-shadow,color] last:border-b-0 hover:bg-[var(--terminal-surface-2)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-border-strong)]',
    rankingGridColumns,
  )

  return selected
    ? `${baseClassName} [background:var(--terminal-selected-row-bg)] shadow-[var(--terminal-selected-row-shadow)]`
    : baseClassName
}
