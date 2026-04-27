import { GexProfileChart } from '@/components/terminal/GexProfileChart'
import { RankingTable } from '@/components/terminal/RankingTable'
import { SidePanels } from '@/components/terminal/SidePanels'
import { TopBar } from '@/components/terminal/TopBar'
import { useTerminalSnapshot } from '@/hooks/useTerminalSnapshot'
import { useTerminalStore } from '@/store/terminalStore'

export function TerminalDashboard() {
  const expiry = useTerminalStore((state) => state.expiry)
  const exposureMode = useTerminalStore((state) => state.exposureMode)
  const dataWindowMode = useTerminalStore((state) => state.dataWindowMode)
  const dataWindowPct = useTerminalStore((state) => state.dataWindowPct)
  const { data: snapshot } = useTerminalSnapshot(expiry)
  const chartWindow = dataWindowMode === 'full' ? 'full' : dataWindowPct

  if (!snapshot) {
    return null
  }

  return (
    <div className="mx-auto flex min-h-screen w-full flex-col">
      <TopBar asOfUtc={snapshot.asOfUtc} />
      <div className="grid min-h-0 flex-1 gap-x-3 gap-y-2 px-3 pb-2 pt-2 lg:grid-cols-[minmax(0,1fr)_432px]">
        <div className="grid min-h-0 min-w-0 grid-rows-[516px_minmax(310px,1fr)] gap-2">
          <section className="terminal-frame h-[516px] min-h-[516px]">
            <GexProfileChart snapshot={snapshot} mode={exposureMode} dataWindowPct={chartWindow} />
          </section>
          <div className="grid min-h-0 gap-3 xl:grid-cols-2">
            <RankingTable title="All-Expiry GEX Top 10 By Gamma Exposure" rows={snapshot.rankings.allExpiry} />
            <RankingTable title="0DTE GEX Top 10 By Gamma Exposure" rows={snapshot.rankings.zeroDte} />
          </div>
        </div>
        <SidePanels snapshot={snapshot} />
      </div>
    </div>
  )
}
