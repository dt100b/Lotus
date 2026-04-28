import { useMemo } from 'react'
import { GexProfileChart, type GexLevelMarker } from '@/components/terminal/GexProfileChart'
import { RankingTable } from '@/components/terminal/RankingTable'
import { SidePanels } from '@/components/terminal/SidePanels'
import { TopBar } from '@/components/terminal/TopBar'
import { useTerminalSnapshot } from '@/hooks/useTerminalSnapshot'
import { useTerminalStore } from '@/store/terminalStore'

const defaultAutoDataWindowPct = 25

export function TerminalDashboard() {
  const expiry = useTerminalStore((state) => state.expiry)
  const exposureMode = useTerminalStore((state) => state.exposureMode)
  const dataWindowMode = useTerminalStore((state) => state.dataWindowMode)
  const dataWindowPct = useTerminalStore((state) => state.dataWindowPct)
  const levelVisibility = useTerminalStore((state) => state.levelVisibility)
  const { data: snapshot } = useTerminalSnapshot(expiry)
  const chartWindow = dataWindowMode === 'full' ? defaultAutoDataWindowPct : dataWindowPct
  const chartLevelMarkers = useMemo<GexLevelMarker[]>(() => {
    if (!snapshot) {
      return []
    }

    const markers: GexLevelMarker[] = []
    const addMarker = (visible: boolean, id: string, label: string, strike: number, color: string) => {
      if (!visible || !Number.isFinite(strike)) {
        return
      }

      markers.push({ id, label, strike, color })
    }
    const findAllExpiry = (label: string) => snapshot.levels.allExpiry.find((level) => level.label === label)
    const findZeroDte = (label: string) => snapshot.levels.zeroDte.find((level) => level.label === label)
    const findAdvanced = (label: string) => snapshot.levels.advanced.find((level) => level.label === label)

    const allExpiryHvl = findAllExpiry('HVL')
    const allExpiryCall = findAllExpiry('Call Resistance')
    const allExpiryPut = findAllExpiry('Put Support')
    const zeroDteHvl = findZeroDte('0DTE HVL')
    const zeroDteCall = findZeroDte('0DTE Call')
    const zeroDtePut = findZeroDte('0DTE Put')
    const zeroGamma = findAdvanced('Zero Gamma')
    const maxPain = findAdvanced('Max Pain')
    const gammaFlip = findAdvanced('Gamma Flip Zones')
    const expectedMove = findAdvanced('Expected Move')
    const expectedMoveRange = expectedMove ? parseExpectedMoveRange(expectedMove.value) : null

    if (allExpiryHvl) addMarker(levelVisibility.allExpiryHvl, 'all-expiry-hvl', 'HVL', allExpiryHvl.strike, 'var(--terminal-yellow)')
    if (allExpiryCall) addMarker(levelVisibility.allExpiryCallResistance, 'all-expiry-call-resistance', 'Call', allExpiryCall.strike, 'var(--terminal-green-strong)')
    if (allExpiryPut) addMarker(levelVisibility.allExpiryPutSupport, 'all-expiry-put-support', 'Put', allExpiryPut.strike, 'var(--terminal-red-strong)')
    if (zeroDteHvl) addMarker(levelVisibility.zeroDteHvl, 'zero-dte-hvl', '0DTE HVL', zeroDteHvl.strike, 'var(--terminal-blue)')
    if (zeroDteCall) addMarker(levelVisibility.zeroDteCall, 'zero-dte-call', '0DTE Call', zeroDteCall.strike, 'var(--terminal-green-strong)')
    if (zeroDtePut) addMarker(levelVisibility.zeroDtePut, 'zero-dte-put', '0DTE Put', zeroDtePut.strike, 'var(--terminal-red-strong)')
    if (zeroGamma) addMarker(levelVisibility.advancedZeroGamma, 'advanced-zero-gamma', 'Zero Gamma', parseLevelValue(zeroGamma.value), zeroGamma.color)
    if (maxPain) addMarker(levelVisibility.advancedMaxPain, 'advanced-max-pain', 'Max Pain', parseLevelValue(maxPain.value), maxPain.color)
    if (gammaFlip) addMarker(levelVisibility.advancedGammaFlipZones, 'advanced-gamma-flip', 'Flip', parseLevelValue(gammaFlip.value), gammaFlip.color)
    if (expectedMove && expectedMoveRange) {
      addMarker(levelVisibility.advancedExpectedMove, 'advanced-expected-move-low', 'EM Low', expectedMoveRange.lower, expectedMove.color)
      addMarker(levelVisibility.advancedExpectedMove, 'advanced-expected-move-high', 'EM High', expectedMoveRange.upper, expectedMove.color)
    }

    return markers
  }, [levelVisibility, snapshot])

  if (!snapshot) {
    return null
  }

  return (
    <div className="mx-auto flex min-h-screen w-full flex-col bg-[var(--terminal-bg)]">
      <TopBar />
      <div className="grid min-h-0 flex-1 gap-x-3 gap-y-2 px-3 pb-3 pt-2 lg:grid-cols-[minmax(0,1fr)_406px]">
        <div className="grid min-h-0 min-w-0 grid-rows-[516px_minmax(292px,1fr)] gap-2">
          <section className="terminal-frame h-[516px] min-h-[516px]">
            <GexProfileChart
              snapshot={snapshot}
              mode={exposureMode}
              dataWindowPct={chartWindow}
              levelMarkers={chartLevelMarkers}
            />
          </section>
          <div className="grid min-h-0 gap-2 xl:grid-cols-2">
            <RankingTable title={`${formatExpiryLabel(snapshot.expiry)} GEX Top 10 By Gamma Exposure`} rows={snapshot.rankings.selectedExpiry} />
            <RankingTable title="0DTE GEX Top 10 By Gamma Exposure" rows={snapshot.rankings.zeroDte} />
          </div>
        </div>
        <SidePanels snapshot={snapshot} />
      </div>
    </div>
  )
}

function formatExpiryLabel(expiry: string) {
  return expiry === 'ALL' ? 'All-Expiry' : expiry
}

function parseLevelValue(value: string) {
  return Number(value.replace(/[^\d.-]/g, ''))
}

function parseExpectedMoveRange(value: string) {
  const match = /^\$?([\d,]+)-\$?([\d,]+)$/.exec(value.trim())
  if (!match) return null

  return {
    lower: parseLevelValue(match[1]),
    upper: parseLevelValue(match[2]),
  }
}
