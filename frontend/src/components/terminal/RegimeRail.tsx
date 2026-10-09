import { memo, useState } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { IvSignalScannerQuickView } from '@/components/terminal/IvSignalScannerQuickView'
import { RegimePanel } from '@/components/terminal/RegimePanel'
import {
  RegimeAnalyticsPanel,
  type RegimeAnalyticsFamily,
} from '@/components/terminal/RegimeAnalyticsPanel'
import type { TerminalSnapshot } from '@/data/mockTerminal'
import { cn } from '@/lib/utils'

type RegimeRailProps = {
  snapshot: TerminalSnapshot
  allExpirySnapshot?: TerminalSnapshot
}

/**
 * Focused fourth column. Legacy Price / Levels / Walls / OPEX surfaces remain
 * in SidePanels.tsx for later refactoring, but are intentionally not mounted.
 */
export const RegimeRail = memo(function RegimeRail({
  snapshot,
  allExpirySnapshot,
}: RegimeRailProps) {
  const bookSnapshot = allExpirySnapshot ?? snapshot
  const [analyticsFamily, setAnalyticsFamily] = useState<RegimeAnalyticsFamily>('term')
  const [activeView, setActiveView] = useState<'overview' | 'options-surface'>('overview')
  const scannerExpiries = (bookSnapshot.expiries ?? []).filter((expiry) => expiry !== 'ALL')

  return (
    <aside className="regime-rail" aria-label="Market regime and volatility">
      <TabsPrimitive.Root
        className={cn('regime-rail__tabs-root', `regime-rail__tabs-root--${activeView}`)}
        value={activeView}
        onValueChange={(value) => setActiveView(value as 'overview' | 'options-surface')}
      >
        <TabsPrimitive.List className="regime-rail__view-tabs" aria-label="Regime views">
          <div className="regime-rail__view-options" role="presentation">
            <TabsPrimitive.Trigger className="regime-rail__view-tab" value="overview">
              Overview
            </TabsPrimitive.Trigger>
            <TabsPrimitive.Trigger className="regime-rail__view-tab" value="options-surface">
              Options Surface
            </TabsPrimitive.Trigger>
          </div>
        </TabsPrimitive.List>

        <TabsPrimitive.Content className="regime-rail__overview" value="overview">
          <section className="regime-rail-card regime-rail-card--primary">
            <div className="regime-rail-card__body">
              <RegimePanel
                bookSnapshot={bookSnapshot}
                onInspectFamily={setAnalyticsFamily}
              />
            </div>
          </section>

          <section className="regime-rail-card regime-rail-card--vol">
            <div className="regime-rail-card__body regime-rail-card__body--vol">
              <RegimeAnalyticsPanel
                bookSnapshot={bookSnapshot}
                family={analyticsFamily}
                onFamilyChange={setAnalyticsFamily}
              />
            </div>
          </section>
        </TabsPrimitive.Content>

        <TabsPrimitive.Content className="regime-rail__scanner" value="options-surface">
          <section className="regime-rail-card regime-rail-card--scanner">
            <IvSignalScannerQuickView
              expiries={scannerExpiries}
              asOf={bookSnapshot.asOfUtc}
              enabled={activeView === 'options-surface'}
            />
          </section>
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </aside>
  )
})
