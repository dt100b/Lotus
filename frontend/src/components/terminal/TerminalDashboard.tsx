import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Columns2 } from 'lucide-react'
import { GexProfileChart, type GexLevelMarker } from '@/components/terminal/GexProfileChart'
import { RankingTable, type GexLevelSelection } from '@/components/terminal/RankingTable'
import { SidePanels } from '@/components/terminal/SidePanels'
import { TopBar } from '@/components/terminal/TopBar'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getOpexExpiries, type GexExpiry } from '@/api/mockGexData'
import { useTerminalSnapshot } from '@/hooks/useTerminalSnapshot'
import { useTerminalStore, type DataWindowMode, type ExposureMode } from '@/store/terminalStore'
import { getGexChartTitle, gexModeLabels, gexModes } from '@/components/terminal/gexModes'
import { levelColors } from '@/data/levelColors'

const defaultAutoDataWindowPct = 25
type ChartPanelId = 'chart-1' | 'chart-2'

type ChartContextMenuState = {
  chartId: ChartPanelId
  x: number
  y: number
}

export function TerminalDashboard() {
  const expiry = useTerminalStore((state) => state.expiry)
  const exposureMode = useTerminalStore((state) => state.exposureMode)
  const splitChartEnabled = useTerminalStore((state) => state.splitChartEnabled)
  const zeroDteExposureMode = useTerminalStore((state) => state.zeroDteExposureMode)
  const dataWindowMode = useTerminalStore((state) => state.dataWindowMode)
  const dataWindowPct = useTerminalStore((state) => state.dataWindowPct)
  const zeroDteDataWindowMode = useTerminalStore((state) => state.zeroDteDataWindowMode)
  const zeroDteDataWindowPct = useTerminalStore((state) => state.zeroDteDataWindowPct)
  const levelVisibility = useTerminalStore((state) => state.levelVisibility)
  const setExpiry = useTerminalStore((state) => state.setExpiry)
  const setExposureMode = useTerminalStore((state) => state.setExposureMode)
  const setSplitChartEnabled = useTerminalStore((state) => state.setSplitChartEnabled)
  const setZeroDteExposureMode = useTerminalStore((state) => state.setZeroDteExposureMode)
  const setDataWindowMode = useTerminalStore((state) => state.setDataWindowMode)
  const setDataWindowPct = useTerminalStore((state) => state.setDataWindowPct)
  const setZeroDteDataWindowMode = useTerminalStore((state) => state.setZeroDteDataWindowMode)
  const setZeroDteDataWindowPct = useTerminalStore((state) => state.setZeroDteDataWindowPct)
  const [chartContextMenu, setChartContextMenu] = useState<ChartContextMenuState | null>(null)
  const [maximizedChart, setMaximizedChart] = useState<ChartPanelId | null>(null)
  const [selectedLevel, setSelectedLevel] = useState<GexLevelSelection | null>(null)
  const [rankingsCollapsed, setRankingsCollapsed] = useState(false)
  const zeroDteExpiry: GexExpiry = getOpexExpiries()[0] ?? 'ALL'
  const expiryOptions = useMemo<Array<{ value: GexExpiry; label: string }>>(() => [
    { value: 'ALL', label: 'All Expiries' },
    ...getOpexExpiries().map((listedExpiry) => ({ value: listedExpiry, label: listedExpiry })),
  ], [])
  const { data: snapshot } = useTerminalSnapshot(expiry)
  const { data: allExpirySnapshot } = useTerminalSnapshot('ALL')
  const { data: zeroDteSnapshot } = useTerminalSnapshot(zeroDteExpiry)
  const chartWindow = dataWindowMode === 'full' ? defaultAutoDataWindowPct : dataWindowPct
  const zeroDteChartWindow = zeroDteDataWindowMode === 'full' ? defaultAutoDataWindowPct : zeroDteDataWindowPct
  const chartLevelMarkers = useMemo<GexLevelMarker[]>(() => {
    if (!snapshot) {
      return []
    }

    const markers: GexLevelMarker[] = []
    const addMarker = (
      visible: boolean,
      id: string,
      label: string,
      strike: number,
      color: string,
      glyph?: GexLevelMarker['glyph'],
      axisOnly = false,
    ) => {
      if (!visible || !Number.isFinite(strike)) {
        return
      }

      markers.push({ id, label, strike, color, glyph, axisOnly })
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
    if (allExpiryCall) addMarker(levelVisibility.allExpiryCallResistance, 'all-expiry-call-resistance', 'Call Res', allExpiryCall.strike, 'var(--terminal-green-strong)', 'chevronUp')
    if (allExpiryPut) addMarker(levelVisibility.allExpiryPutSupport, 'all-expiry-put-support', 'Put Sup', allExpiryPut.strike, 'var(--terminal-red-strong)', 'chevronDown')
    if (!splitChartEnabled) {
      if (zeroDteHvl) addMarker(levelVisibility.zeroDteHvl, 'zero-dte-hvl', '0DTE HVL', zeroDteHvl.strike, 'var(--terminal-blue)')
      if (zeroDteCall) addMarker(levelVisibility.zeroDteCall, 'zero-dte-call', '0DTE Call', zeroDteCall.strike, levelColors.zeroDteCall, 'chevronUp')
      if (zeroDtePut) addMarker(levelVisibility.zeroDtePut, 'zero-dte-put', '0DTE Put', zeroDtePut.strike, levelColors.zeroDtePut, 'chevronDown')
    }
    if (zeroGamma) addMarker(levelVisibility.advancedZeroGamma, 'advanced-zero-gamma', 'Zero Γ', parseLevelValue(zeroGamma.value), levelColors.zeroGamma, 'crosshair')
    if (maxPain) addMarker(levelVisibility.advancedMaxPain, 'advanced-max-pain', 'MP', parseLevelValue(maxPain.value), maxPain.color, 'slash')
    if (gammaFlip) addMarker(levelVisibility.advancedGammaFlipZones, 'advanced-gamma-flip', 'Flip', parseLevelValue(gammaFlip.value), levelColors.gammaFlip, 'flipZone')
    if (expectedMove && expectedMoveRange) {
      addMarker(levelVisibility.advancedExpectedMove, 'advanced-expected-move-low', 'EM', expectedMoveRange.lower, levelColors.expectedMove, 'bracket', true)
      addMarker(levelVisibility.advancedExpectedMove, 'advanced-expected-move-high', 'EM', expectedMoveRange.upper, levelColors.expectedMove, 'bracket', true)
    }

    return markers
  }, [levelVisibility, snapshot, splitChartEnabled])
  const zeroDteChartLevelMarkers = useMemo<GexLevelMarker[]>(() => {
    if (!snapshot) {
      return []
    }

    const markers: GexLevelMarker[] = []
    const addMarker = (
      visible: boolean,
      id: string,
      label: string,
      strike: number,
      color: string,
      glyph?: GexLevelMarker['glyph'],
      axisOnly = false,
    ) => {
      if (!visible || !Number.isFinite(strike)) {
        return
      }

      markers.push({ id, label, strike, color, glyph, axisOnly })
    }
    const findZeroDte = (label: string) => snapshot.levels.zeroDte.find((level) => level.label === label)
    const findAdvanced = (label: string) => snapshot.levels.advanced.find((level) => level.label === label)
    const zeroDteHvl = findZeroDte('0DTE HVL')
    const zeroDteCall = findZeroDte('0DTE Call')
    const zeroDtePut = findZeroDte('0DTE Put')
    const zeroGamma = findAdvanced('Zero Gamma')
    const maxPain = findAdvanced('Max Pain')
    const gammaFlip = findAdvanced('Gamma Flip Zones')
    const expectedMove = findAdvanced('Expected Move')
    const expectedMoveRange = expectedMove ? parseExpectedMoveRange(expectedMove.value) : null

    if (zeroDteHvl) addMarker(levelVisibility.zeroDteHvl, 'zero-dte-hvl', '0DTE HVL', zeroDteHvl.strike, 'var(--terminal-blue)')
    if (zeroDteCall) addMarker(levelVisibility.zeroDteCall, 'zero-dte-call', '0DTE Call', zeroDteCall.strike, levelColors.zeroDteCall, 'chevronUp')
    if (zeroDtePut) addMarker(levelVisibility.zeroDtePut, 'zero-dte-put', '0DTE Put', zeroDtePut.strike, levelColors.zeroDtePut, 'chevronDown')
    if (zeroGamma) addMarker(levelVisibility.advancedZeroGamma, 'advanced-zero-gamma', 'Zero Γ', parseLevelValue(zeroGamma.value), levelColors.zeroGamma, 'crosshair')
    if (maxPain) addMarker(levelVisibility.advancedMaxPain, 'advanced-max-pain', 'MP', parseLevelValue(maxPain.value), maxPain.color, 'slash')
    if (gammaFlip) addMarker(levelVisibility.advancedGammaFlipZones, 'advanced-gamma-flip', 'Flip', parseLevelValue(gammaFlip.value), levelColors.gammaFlip, 'flipZone')
    if (expectedMove && expectedMoveRange) {
      addMarker(levelVisibility.advancedExpectedMove, 'advanced-expected-move-low', 'EM', expectedMoveRange.lower, levelColors.expectedMove, 'bracket', true)
      addMarker(levelVisibility.advancedExpectedMove, 'advanced-expected-move-high', 'EM', expectedMoveRange.upper, levelColors.expectedMove, 'bracket', true)
    }

    return markers
  }, [levelVisibility, snapshot])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      if (chartContextMenu) {
        setChartContextMenu(null)
        return
      }

      if (selectedLevel) {
        setSelectedLevel(null)
        return
      }

      setMaximizedChart(null)
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [chartContextMenu, selectedLevel])

  useEffect(() => {
    if (!chartContextMenu) {
      return
    }

    const closeMenu = () => setChartContextMenu(null)
    window.addEventListener('click', closeMenu)

    return () => window.removeEventListener('click', closeMenu)
  }, [chartContextMenu])

  if (!snapshot) {
    return null
  }

  const showSplitChart = splitChartEnabled && Boolean(zeroDteSnapshot)
  const dashboardRowsClassName = rankingsCollapsed
    ? 'grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_44px] gap-2'
    : 'grid h-full min-h-0 min-w-0 grid-rows-[516px_minmax(292px,1fr)] gap-2'
  const chartDeckSizeClassName = rankingsCollapsed ? 'h-full min-h-0' : 'h-[516px] min-h-[516px]'
  const rankingsGridClassName = rankingsCollapsed
    ? 'grid h-[44px] min-h-0 gap-2 xl:grid-cols-2'
    : 'grid min-h-0 gap-2 xl:grid-cols-2'
  const handleRankingRowSelect = (selection: GexLevelSelection) => {
    setSelectedLevel((currentSelection) => (
      currentSelection?.key === selection.key ? null : selection
    ))
  }
  const handleChartContextMenu = (event: ReactMouseEvent<HTMLElement>, chartId: ChartPanelId) => {
    event.preventDefault()
    setChartContextMenu({
      chartId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 148)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 42)),
    })
  }
  const renderChartOne = () => (
    <GexProfileChart
      snapshot={snapshot}
      mode={exposureMode}
      dataWindowPct={chartWindow}
      levelMarkers={chartLevelMarkers}
      titleAccessory={(
        <ChartControls
          expiry={expiry}
          expiryOptions={expiryOptions}
          mode={exposureMode}
          dataWindowMode={dataWindowMode}
          dataWindowPct={dataWindowPct}
          splitChartEnabled={splitChartEnabled}
          onExpiryChange={setExpiry}
          onModeChange={setExposureMode}
          onSplitChartEnabledChange={setSplitChartEnabled}
          onDataWindowModeChange={setDataWindowMode}
          onDataWindowPctChange={setDataWindowPct}
        />
      )}
    />
  )
  const renderChartTwo = () => zeroDteSnapshot ? (
    <GexProfileChart
      snapshot={zeroDteSnapshot}
      mode={zeroDteExposureMode}
      dataWindowPct={zeroDteChartWindow}
      levelMarkers={zeroDteChartLevelMarkers}
      titleOverride={`0DTE ${getGexChartTitle(zeroDteExposureMode)}`}
      titleAccessory={(
        <ChartControls
          mode={zeroDteExposureMode}
          dataWindowMode={zeroDteDataWindowMode}
          dataWindowPct={zeroDteDataWindowPct}
          onModeChange={setZeroDteExposureMode}
          onDataWindowModeChange={setZeroDteDataWindowMode}
          onDataWindowPctChange={setZeroDteDataWindowPct}
        />
      )}
    />
  ) : null

  return (
    <div className="mx-auto flex h-screen w-full flex-col overflow-hidden bg-[var(--terminal-bg)]">
      <TopBar />
      <div className="grid min-h-0 flex-1 overflow-hidden gap-x-3 gap-y-2 px-3 pb-3 pt-2 lg:grid-cols-[minmax(0,1fr)_406px]">
        <div className={dashboardRowsClassName}>
          <div className={showSplitChart ? `grid ${chartDeckSizeClassName} min-w-0 grid-cols-2 gap-2` : chartDeckSizeClassName}>
            <section
              className={`terminal-frame ${chartDeckSizeClassName} min-w-0`}
              onContextMenu={(event) => handleChartContextMenu(event, 'chart-1')}
            >
              {renderChartOne()}
            </section>
            {showSplitChart && zeroDteSnapshot ? (
              <section
                className={`terminal-frame ${chartDeckSizeClassName} min-w-0`}
                onContextMenu={(event) => handleChartContextMenu(event, 'chart-2')}
              >
                {renderChartTwo()}
              </section>
            ) : null}
          </div>
          <div className={rankingsGridClassName}>
            <RankingTable
              title="All-Expiry GEX Top 10 By Gamma Exposure"
              scope="allExpiry"
              rows={snapshot.rankings.allExpiry}
              collapsed={rankingsCollapsed}
              selectedKey={selectedLevel?.key}
              onCollapsedChange={setRankingsCollapsed}
              onRowSelect={handleRankingRowSelect}
            />
            <RankingTable
              title="0DTE GEX Top 10 By Gamma Exposure"
              scope="zeroDte"
              rows={snapshot.rankings.zeroDte}
              collapsed={rankingsCollapsed}
              selectedKey={selectedLevel?.key}
              onCollapsedChange={setRankingsCollapsed}
              onRowSelect={handleRankingRowSelect}
            />
          </div>
        </div>
        <SidePanels
          snapshot={snapshot}
          allExpirySnapshot={allExpirySnapshot ?? snapshot}
          zeroDteSnapshot={zeroDteSnapshot ?? undefined}
          selectedLevel={selectedLevel}
          onCloseLevelInspector={() => setSelectedLevel(null)}
        />
      </div>
      {maximizedChart ? (
        <div className="fixed inset-0 z-[70] bg-[var(--terminal-bg)] p-3">
          <section
            className="terminal-frame h-full min-h-0 min-w-0"
            aria-label={`${maximizedChart === 'chart-1' ? 'Chart 1' : 'Chart 2'} maximized`}
            onContextMenu={(event) => handleChartContextMenu(event, maximizedChart)}
          >
            {maximizedChart === 'chart-1' ? renderChartOne() : renderChartTwo()}
          </section>
        </div>
      ) : null}
      {chartContextMenu ? (
        <ChartContextMenu
          menu={chartContextMenu}
          isMaximized={maximizedChart === chartContextMenu.chartId}
          onMaximize={(chartId) => {
            setMaximizedChart(chartId)
            setChartContextMenu(null)
          }}
          onRestore={() => {
            setMaximizedChart(null)
            setChartContextMenu(null)
          }}
        />
      ) : null}
    </div>
  )
}

function ChartContextMenu({
  menu,
  isMaximized,
  onMaximize,
  onRestore,
}: {
  menu: ChartContextMenuState
  isMaximized: boolean
  onMaximize: (chartId: ChartPanelId) => void
  onRestore: () => void
}) {
  return (
    <div
      className="fixed z-[80] min-w-[132px] overflow-hidden rounded-[var(--terminal-radius-sm)] border border-[var(--terminal-border-strong)] bg-[var(--terminal-surface)] py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-text)] shadow-2xl"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        className="flex h-7 w-full items-center px-3 text-left transition-colors hover:bg-[var(--terminal-surface-2)] hover:text-[var(--terminal-heading)] focus-visible:bg-[var(--terminal-surface-2)] focus-visible:text-[var(--terminal-heading)] focus-visible:outline-none"
        onClick={() => (isMaximized ? onRestore() : onMaximize(menu.chartId))}
      >
        {isMaximized ? 'Restore' : 'Maximize'}
      </button>
    </div>
  )
}

function ChartControls({
  expiry,
  expiryOptions = [],
  mode,
  dataWindowMode,
  dataWindowPct,
  splitChartEnabled,
  onExpiryChange,
  onModeChange,
  onSplitChartEnabledChange,
  onDataWindowModeChange,
  onDataWindowPctChange,
}: {
  expiry?: GexExpiry
  expiryOptions?: Array<{ value: GexExpiry; label: string }>
  mode: ExposureMode
  dataWindowMode: DataWindowMode
  dataWindowPct: number
  splitChartEnabled?: boolean
  onExpiryChange?: (expiry: GexExpiry) => void
  onModeChange: (mode: ExposureMode) => void
  onSplitChartEnabledChange?: (enabled: boolean) => void
  onDataWindowModeChange: (mode: DataWindowMode) => void
  onDataWindowPctChange: (pct: number) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {expiry && onExpiryChange ? (
        <ExpirySelect
          expiry={expiry}
          expiryOptions={expiryOptions}
          onExpiryChange={onExpiryChange}
        />
      ) : null}
      <DataWindowControl
        dataWindowMode={dataWindowMode}
        dataWindowPct={dataWindowPct}
        onDataWindowModeChange={onDataWindowModeChange}
        onDataWindowPctChange={onDataWindowPctChange}
      />
      <ChartModeSelect mode={mode} onModeChange={onModeChange} />
      {typeof splitChartEnabled === 'boolean' && onSplitChartEnabledChange ? (
        <SplitChartToggle
          enabled={splitChartEnabled}
          onEnabledChange={onSplitChartEnabledChange}
        />
      ) : null}
    </div>
  )
}

function SplitChartToggle({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
}) {
  return (
    <Button
      aria-label={enabled ? 'Disable split chart view' : 'Enable split chart view'}
      aria-pressed={enabled}
      title={enabled ? 'Disable split chart view' : 'Enable split chart view'}
      variant={enabled ? 'active' : 'default'}
      size="icon"
      className="h-[20px] w-[20px] px-0"
      onClick={() => onEnabledChange(!enabled)}
    >
      <Columns2 className="h-[12px] w-[12px]" />
    </Button>
  )
}

function ExpirySelect({
  expiry,
  expiryOptions,
  onExpiryChange,
}: {
  expiry: GexExpiry
  expiryOptions: Array<{ value: GexExpiry; label: string }>
  onExpiryChange: (expiry: GexExpiry) => void
}) {
  return (
    <Select value={expiry} onValueChange={(value) => onExpiryChange(value as GexExpiry)}>
      <SelectTrigger
        aria-label="Chart 1 expiry"
        className="h-[20px] min-w-[116px] max-w-[124px] gap-1 px-2 text-[8.5px] leading-none tracking-[0.07em] [&>span]:truncate [&>span]:text-[8.5px] [&>span]:leading-none [&_svg]:h-2.5 [&_svg]:w-2.5"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-[132px]">
        {expiryOptions.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className="py-1.5 pl-5 pr-2 text-[8.5px] leading-none tracking-[0.07em] [&_svg]:h-3 [&_svg]:w-3"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ChartModeSelect({
  mode,
  onModeChange,
}: {
  mode: ExposureMode
  onModeChange: (mode: ExposureMode) => void
}) {
  return (
    <Select value={mode} onValueChange={(value) => onModeChange(value as ExposureMode)}>
      <SelectTrigger
        aria-label="Chart type"
        className="h-[20px] min-w-[78px] gap-1 px-2 text-[8.5px] leading-none tracking-[0.07em] [&>span]:text-[8.5px] [&>span]:leading-none [&_svg]:h-2.5 [&_svg]:w-2.5"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-[96px]">
        {gexModes.map((gexMode) => (
          <SelectItem
            key={gexMode}
            value={gexMode}
            className="py-1.5 pl-5 pr-2 text-[8.5px] leading-none tracking-[0.07em] [&_svg]:h-3 [&_svg]:w-3"
          >
            {gexModeLabels[gexMode]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function DataWindowControl({
  dataWindowMode,
  dataWindowPct,
  onDataWindowModeChange,
  onDataWindowPctChange,
}: {
  dataWindowMode: DataWindowMode
  dataWindowPct: number
  onDataWindowModeChange: (mode: DataWindowMode) => void
  onDataWindowPctChange: (pct: number) => void
}) {
  const [filterInput, setFilterInput] = useState(() => formatFilterInput(dataWindowMode, dataWindowPct))
  const [isFilterFocused, setIsFilterFocused] = useState(false)
  const displayedFilterInput = isFilterFocused ? filterInput : formatFilterInput(dataWindowMode, dataWindowPct)

  return (
    <div className="flex h-[20px] min-w-[72px] items-center justify-center gap-1 rounded-[var(--terminal-control-radius)] border border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] px-1.5 text-[8.5px] font-semibold text-[var(--terminal-text)] shadow-[var(--terminal-control-inset)] transition-colors hover:border-[var(--terminal-border-strong)]">
      <span className="text-[var(--terminal-heading)]">± %</span>
      <input
        aria-label="Chart data window filter percent"
        className="h-[15px] w-[30px] rounded-[1px] border border-[var(--terminal-border)] bg-[var(--terminal-bg)] px-1 text-center text-[8.5px] leading-[15px] text-[var(--terminal-heading)] outline-none focus:border-[var(--terminal-border-strong)]"
        type="text"
        value={displayedFilterInput}
        onFocus={() => {
          setIsFilterFocused(true)
          setFilterInput(displayedFilterInput)
        }}
        onChange={(event) => {
          const nextValue = event.currentTarget.value
          setFilterInput(nextValue)

          const parsed = parseFilterInput(nextValue)
          if (parsed === 'full') {
            onDataWindowModeChange('full')
          } else if (typeof parsed === 'number') {
            onDataWindowModeChange('percent')
            onDataWindowPctChange(parsed)
          }
        }}
        onBlur={() => {
          setIsFilterFocused(false)
          const parsed = parseFilterInput(filterInput)
          if (parsed === 'full' || parsed === null) {
            onDataWindowModeChange('full')
            setFilterInput('any')
            return
          }

          setFilterInput(formatPercentInput(parsed))
        }}
      />
    </div>
  )
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

function formatFilterInput(dataWindowMode: DataWindowMode, dataWindowPct: number) {
  return dataWindowMode === 'full' ? 'any' : formatPercentInput(dataWindowPct)
}

function formatPercentInput(value: number) {
  return Number.isInteger(value) ? String(value) : String(value)
}

function parseFilterInput(value: string): number | 'full' | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === 'any') return 'full'

  const numericValue = Number(normalized.replace(/[+±%\s]/g, ''))
  if (!Number.isFinite(numericValue)) return null

  return Math.min(100, Math.max(1, Math.abs(numericValue)))
}
