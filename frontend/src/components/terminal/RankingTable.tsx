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
    <Panel title={title} className="flex h-full min-h-[310px] flex-col">
      <div className="grid flex-1 gap-0.5" style={{ gridTemplateRows: `repeat(${rows.length}, minmax(22px, 1fr))` }}>
        {rows.map((row) => {
          const positive = row.gammaExposureUsd >= 0
          const width = `${Math.max(12, (Math.abs(row.gammaExposureUsd) / maxAbs) * 100)}%`

          return (
            <div
              key={`${title}-${row.rank}`}
              className="group grid grid-cols-[42px_120px_106px_minmax(128px,1fr)_88px] items-center border-b border-[#1f2c2f] py-px text-[13px] leading-5 transition-colors last:border-b-0 hover:bg-[#0c1416]"
            >
              <div className="terminal-value text-[#d4d1c9]">{row.rank}</div>
              <div className="terminal-value font-semibold text-[#ff8a00]">${formatStrike(row.strike)}</div>
              <div className={row.changePercent < 0 ? 'terminal-value text-[#ff4b43]' : 'terminal-value text-[#51cf66]'}>
                {formatSignedPercent(row.changePercent)}
              </div>
              <div className="h-[6px] border border-[#1c292b] bg-[#0a0f10] shadow-[inset_0_0_10px_rgba(0,0,0,0.44)]">
                <div
                  className={positive ? 'h-full bg-[#3fc35d] shadow-[0_0_10px_rgba(63,195,93,0.34)]' : 'h-full bg-[#ff3f37] shadow-[0_0_10px_rgba(255,63,55,0.34)]'}
                  style={{ width }}
                />
              </div>
              <div className={positive ? 'terminal-value text-right text-[#51cf66]' : 'terminal-value text-right text-[#ff4b43]'}>
                {formatMillions(row.gammaExposureUsd)}
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
