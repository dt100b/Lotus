import { Panel } from '@/components/terminal/Panel'
import type { RankingRow } from '@/data/mockTerminal'
import { formatMillions, formatSignedPercent, formatStrike } from '@/lib/formatters'

type RankingTableProps = {
  title: string
  rows: RankingRow[]
}

export function RankingTable({ title, rows }: RankingTableProps) {
  const maxAbs = Math.max(...rows.map((row) => Math.abs(row.gammaExposureUsd)))

  return (
    <Panel title={title} className="flex h-full min-h-[292px] flex-col">
      <div className="grid grid-cols-[44px_124px_94px_minmax(132px,1fr)_86px] border-b border-[var(--terminal-border)] pb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-muted)]">
        <div>Rank</div>
        <div>Strike (USD)</div>
        <div>Δ% 24H</div>
        <div>Gamma Exposure (USD)</div>
        <div />
      </div>
      <div className="grid flex-1" style={{ gridTemplateRows: `repeat(${rows.length}, minmax(var(--terminal-table-row), 1fr))` }}>
        {rows.map((row) => {
          const positive = row.gammaExposureUsd >= 0
          const width = `${Math.max(12, (Math.abs(row.gammaExposureUsd) / maxAbs) * 100)}%`

          return (
            <div
              key={`${title}-${row.rank}`}
              className="group grid grid-cols-[44px_124px_94px_minmax(132px,1fr)_86px] items-center border-b border-[var(--terminal-border)] py-0 text-[12px] leading-[18px] transition-colors last:border-b-0 hover:bg-[var(--terminal-surface-2)]"
            >
              <div className="terminal-value text-[var(--terminal-text)]">{row.rank}</div>
              <div className="terminal-value font-semibold text-[var(--terminal-heading)]">${formatStrike(row.strike)}</div>
              <div className={row.changePercent < 0 ? 'terminal-value text-[var(--terminal-red-strong)]' : 'terminal-value text-[var(--terminal-green-strong)]'}>
                {formatSignedPercent(row.changePercent)}
              </div>
              <div className="h-1 border border-[var(--terminal-border)] bg-[var(--terminal-bg-soft)]">
                <div
                  className={positive ? 'h-full bg-[var(--chart-positive)]' : 'h-full bg-[var(--chart-negative)]'}
                  style={{ width }}
                />
              </div>
              <div className={positive ? 'terminal-value text-right text-[var(--terminal-green-strong)]' : 'terminal-value text-right text-[var(--terminal-red-strong)]'}>
                {formatMillions(row.gammaExposureUsd)}
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
