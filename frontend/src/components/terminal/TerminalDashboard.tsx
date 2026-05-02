import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, ChevronUp, Columns2, SlidersHorizontal } from 'lucide-react'
import { GexProfileChart, type GexLevelMarker, type GexSnapshot } from '@/components/terminal/GexProfileChart'
import { Panel } from '@/components/terminal/Panel'
import { RankingTable, type RankingScope } from '@/components/terminal/RankingTable'
import { SidePanels } from '@/components/terminal/SidePanels'
import { TopBar } from '@/components/terminal/TopBar'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getOpexExpiries, type GexExpiry } from '@/api/mockGexData'
import { useTerminalSnapshot } from '@/hooks/useTerminalSnapshot'
import { useTerminalStore, type DataWindowMode, type ExposureMode } from '@/store/terminalStore'
import { getGexChartTitle, gexModeLabels, gexModes } from '@/components/terminal/gexModes'
import { levelColors } from '@/data/levelColors'
import type { RankingRow } from '@/data/mockTerminal'

const defaultAutoDataWindowPct = 25
const lowerChartMinHeight = 292
type ChartPanelId = 'chart-1' | 'chart-2'
type LowerPanelView = 'table' | 'chart'

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
  const [rankingsCollapsed, setRankingsCollapsed] = useState(false)
  const [allExpiryLowerView, setAllExpiryLowerView] = useState<LowerPanelView>('table')
  const [zeroDteLowerView, setZeroDteLowerView] = useState<LowerPanelView>('table')
  const zeroDteExpiry: GexExpiry = getOpexExpiries()[0] ?? 'ALL'
  const [chartTwoExpiry, setChartTwoExpiry] = useState<GexExpiry>(zeroDteExpiry)
  const [allExpiryLowerExpiry, setAllExpiryLowerExpiry] = useState<GexExpiry>('ALL')
  const [zeroDteLowerExpiry, setZeroDteLowerExpiry] = useState<GexExpiry>(zeroDteExpiry)
  const [allExpiryLowerMode, setAllExpiryLowerMode] = useState<ExposureMode>('abs')
  const [zeroDteLowerMode, setZeroDteLowerMode] = useState<ExposureMode>('profile')
  const [allExpiryLowerDataWindowMode, setAllExpiryLowerDataWindowMode] = useState<DataWindowMode>('percent')
  const [allExpiryLowerDataWindowPct, setAllExpiryLowerDataWindowPct] = useState(defaultAutoDataWindowPct)
  const [zeroDteLowerDataWindowMode, setZeroDteLowerDataWindowMode] = useState<DataWindowMode>('percent')
  const [zeroDteLowerDataWindowPct, setZeroDteLowerDataWindowPct] = useState(defaultAutoDataWindowPct)
  const expiryOptions = useMemo<Array<{ value: GexExpiry; label: string }>>(() => [
    { value: 'ALL', label: 'All Expiries' },
    ...getOpexExpiries().map((listedExpiry) => ({ value: listedExpiry, label: listedExpiry })),
  ], [])
  const { data: snapshot } = useTerminalSnapshot(expiry)
  const { data: allExpirySnapshot } = useTerminalSnapshot('ALL')
  const { data: chartTwoSnapshot } = useTerminalSnapshot(chartTwoExpiry)
  const { data: allExpiryLowerSnapshot } = useTerminalSnapshot(allExpiryLowerExpiry)
  const { data: zeroDteLowerSnapshot } = useTerminalSnapshot(zeroDteLowerExpiry)
  const chartWindow = dataWindowMode === 'full' ? defaultAutoDataWindowPct : dataWindowPct
  const zeroDteChartWindow = zeroDteDataWindowMode === 'full' ? defaultAutoDataWindowPct : zeroDteDataWindowPct
  const allExpiryLowerChartWindow = allExpiryLowerDataWindowMode === 'full' ? defaultAutoDataWindowPct : allExpiryLowerDataWindowPct
  const zeroDteLowerChartWindow = zeroDteLowerDataWindowMode === 'full' ? defaultAutoDataWindowPct : zeroDteLowerDataWindowPct
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

      setMaximizedChart(null)
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [chartContextMenu])

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

  const showSplitChart = splitChartEnabled && Boolean(chartTwoSnapshot)
  const dashboardRowsClassName = rankingsCollapsed
    ? 'grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_44px] gap-2'
    : 'grid h-full min-h-0 min-w-0 grid-rows-[516px_minmax(292px,1fr)] gap-2'
  const chartDeckSizeClassName = rankingsCollapsed ? 'h-full min-h-0' : 'h-[516px] min-h-[516px]'
  const rankingsGridClassName = rankingsCollapsed
    ? 'grid h-[44px] min-h-0 gap-2 xl:grid-cols-2'
    : 'grid min-h-0 gap-2 xl:grid-cols-2'
  const handleChartContextMenu = (event: ReactMouseEvent<HTMLElement>, chartId: ChartPanelId) => {
    event.preventDefault()
    setChartContextMenu({
      chartId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 148)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 42)),
    })
  }
  const handleSplitChartEnabledChange = (enabled: boolean) => {
    if (enabled) {
      setChartTwoExpiry(zeroDteExpiry)
      setZeroDteExposureMode(exposureMode)
      setZeroDteDataWindowMode(dataWindowMode)
      setZeroDteDataWindowPct(dataWindowPct)
    }

    setSplitChartEnabled(enabled)
  }
  const renderChartOne = () => (
    <GexProfileChart
      snapshot={snapshot}
      mode={exposureMode}
      dataWindowPct={chartWindow}
      levelMarkers={chartLevelMarkers}
      titleOverride={getGammaChartTitle(exposureMode, expiry, zeroDteExpiry)}
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
          onSplitChartEnabledChange={handleSplitChartEnabledChange}
          onDataWindowModeChange={setDataWindowMode}
          onDataWindowPctChange={setDataWindowPct}
        />
      )}
    />
  )
  const renderChartTwo = () => chartTwoSnapshot ? (
    <GexProfileChart
      snapshot={chartTwoSnapshot}
      mode={zeroDteExposureMode}
      dataWindowPct={zeroDteChartWindow}
      levelMarkers={chartTwoExpiry === zeroDteExpiry ? zeroDteChartLevelMarkers : chartLevelMarkers}
      titleOverride={getGammaChartTitle(zeroDteExposureMode, chartTwoExpiry, zeroDteExpiry)}
      titleAccessory={(
        <ChartControls
          expiry={chartTwoExpiry}
          expiryOptions={expiryOptions}
          mode={zeroDteExposureMode}
          dataWindowMode={zeroDteDataWindowMode}
          dataWindowPct={zeroDteDataWindowPct}
          onExpiryChange={setChartTwoExpiry}
          onModeChange={setZeroDteExposureMode}
          onDataWindowModeChange={setZeroDteDataWindowMode}
          onDataWindowPctChange={setZeroDteDataWindowPct}
        />
      )}
    />
  ) : null
  const renderAllExpiryLowerPanel = () => (
    <LowerGammaPanel
      title="All-Expiry GEX Top 10 By Gamma Exposure"
      chartTitle={getGammaChartTitle(allExpiryLowerMode, allExpiryLowerExpiry, zeroDteExpiry)}
      scope="allExpiry"
      rows={snapshot.rankings.allExpiry}
      view={allExpiryLowerView}
      expiry={allExpiryLowerExpiry}
      expiryOptions={expiryOptions}
      mode={allExpiryLowerMode}
      snapshot={allExpiryLowerSnapshot ?? snapshot}
      dataWindowMode={allExpiryLowerDataWindowMode}
      dataWindowPct={allExpiryLowerDataWindowPct}
      chartWindowPct={allExpiryLowerChartWindow}
      levelMarkers={allExpiryLowerExpiry === zeroDteExpiry ? zeroDteChartLevelMarkers : chartLevelMarkers}
      collapsed={rankingsCollapsed}
      onViewChange={setAllExpiryLowerView}
      onExpiryChange={setAllExpiryLowerExpiry}
      onModeChange={setAllExpiryLowerMode}
      onDataWindowModeChange={setAllExpiryLowerDataWindowMode}
      onDataWindowPctChange={setAllExpiryLowerDataWindowPct}
      onCollapsedChange={setRankingsCollapsed}
    />
  )
  const renderZeroDteLowerPanel = () => (
    <LowerGammaPanel
      title="0DTE GEX Top 10 By Gamma Exposure"
      chartTitle={getGammaChartTitle(zeroDteLowerMode, zeroDteLowerExpiry, zeroDteExpiry)}
      scope="zeroDte"
      rows={snapshot.rankings.zeroDte}
      view={zeroDteLowerView}
      expiry={zeroDteLowerExpiry}
      expiryOptions={expiryOptions}
      mode={zeroDteLowerMode}
      snapshot={zeroDteLowerSnapshot ?? snapshot}
      dataWindowMode={zeroDteLowerDataWindowMode}
      dataWindowPct={zeroDteLowerDataWindowPct}
      chartWindowPct={zeroDteLowerChartWindow}
      levelMarkers={zeroDteLowerExpiry === zeroDteExpiry ? zeroDteChartLevelMarkers : chartLevelMarkers}
      collapsed={rankingsCollapsed}
      onViewChange={setZeroDteLowerView}
      onExpiryChange={setZeroDteLowerExpiry}
      onModeChange={setZeroDteLowerMode}
      onDataWindowModeChange={setZeroDteLowerDataWindowMode}
      onDataWindowPctChange={setZeroDteLowerDataWindowPct}
      onCollapsedChange={setRankingsCollapsed}
    />
  )

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
            {showSplitChart && chartTwoSnapshot ? (
              <section
                className={`terminal-frame ${chartDeckSizeClassName} min-w-0`}
                onContextMenu={(event) => handleChartContextMenu(event, 'chart-2')}
              >
                {renderChartTwo()}
              </section>
            ) : null}
          </div>
          <div className={rankingsGridClassName}>
            {renderAllExpiryLowerPanel()}
            {renderZeroDteLowerPanel()}
          </div>
        </div>
        <SidePanels
          snapshot={snapshot}
          allExpirySnapshot={allExpirySnapshot ?? snapshot}
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

function LowerGammaPanel({
  title,
  chartTitle,
  scope,
  rows,
  view,
  expiry,
  expiryOptions,
  mode,
  snapshot,
  dataWindowMode,
  dataWindowPct,
  chartWindowPct,
  levelMarkers,
  collapsed,
  onViewChange,
  onExpiryChange,
  onModeChange,
  onDataWindowModeChange,
  onDataWindowPctChange,
  onCollapsedChange,
}: {
  title: string
  chartTitle: string
  scope: RankingScope
  rows: RankingRow[]
  view: LowerPanelView
  expiry: GexExpiry
  expiryOptions: Array<{ value: GexExpiry; label: string }>
  mode: ExposureMode
  snapshot: GexSnapshot
  dataWindowMode: DataWindowMode
  dataWindowPct: number
  chartWindowPct: number | 'full'
  levelMarkers: GexLevelMarker[]
  collapsed: boolean
  onViewChange: (view: LowerPanelView) => void
  onExpiryChange: (expiry: GexExpiry) => void
  onModeChange: (mode: ExposureMode) => void
  onDataWindowModeChange: (mode: DataWindowMode) => void
  onDataWindowPctChange: (pct: number) => void
  onCollapsedChange: (collapsed: boolean) => void
}) {
  const accessory = (
    <LowerPanelControls
      view={view}
      expiry={expiry}
      expiryOptions={expiryOptions}
      mode={mode}
      dataWindowMode={dataWindowMode}
      dataWindowPct={dataWindowPct}
      collapsed={collapsed}
      onViewChange={onViewChange}
      onExpiryChange={onExpiryChange}
      onModeChange={onModeChange}
      onDataWindowModeChange={onDataWindowModeChange}
      onDataWindowPctChange={onDataWindowPctChange}
      onCollapsedChange={onCollapsedChange}
    />
  )

  if (collapsed) {
    return (
      <Panel
        title={view === 'chart' ? chartTitle : title}
        titleAccessory={accessory}
        className="flex h-full min-h-0 flex-col justify-center py-2"
      >
        {null}
      </Panel>
    )
  }

  if (view === 'table') {
    return (
      <RankingTable
        title={title}
        scope={scope}
        rows={rows}
        collapsed={collapsed}
        titleAccessory={accessory}
      />
    )
  }

  return (
    <section className="terminal-frame h-full min-h-[292px] min-w-0">
      <GexProfileChart
        snapshot={snapshot}
        mode={mode}
        dataWindowPct={chartWindowPct}
        levelMarkers={levelMarkers}
        titleOverride={chartTitle}
        titleAccessory={accessory}
        minHeight={lowerChartMinHeight}
      />
    </section>
  )
}

function LowerPanelControls({
  view,
  expiry,
  expiryOptions,
  mode,
  dataWindowMode,
  dataWindowPct,
  collapsed,
  onViewChange,
  onExpiryChange,
  onModeChange,
  onDataWindowModeChange,
  onDataWindowPctChange,
  onCollapsedChange,
}: {
  view: LowerPanelView
  expiry: GexExpiry
  expiryOptions: Array<{ value: GexExpiry; label: string }>
  mode: ExposureMode
  dataWindowMode: DataWindowMode
  dataWindowPct: number
  collapsed: boolean
  onViewChange: (view: LowerPanelView) => void
  onExpiryChange: (expiry: GexExpiry) => void
  onModeChange: (mode: ExposureMode) => void
  onDataWindowModeChange: (mode: DataWindowMode) => void
  onDataWindowPctChange: (pct: number) => void
  onCollapsedChange: (collapsed: boolean) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <LowerPanelViewSelect view={view} onViewChange={onViewChange} />
      {view === 'chart' ? (
        <>
          <ExpirySelect
            expiry={expiry}
            expiryOptions={expiryOptions}
            onExpiryChange={onExpiryChange}
          />
          <DataWindowControl
            dataWindowMode={dataWindowMode}
            dataWindowPct={dataWindowPct}
            onDataWindowModeChange={onDataWindowModeChange}
            onDataWindowPctChange={onDataWindowPctChange}
          />
          <ChartModeSelect mode={mode} onModeChange={onModeChange} />
        </>
      ) : null}
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
    </div>
  )
}

function LowerPanelViewSelect({
  view,
  onViewChange,
}: {
  view: LowerPanelView
  onViewChange: (view: LowerPanelView) => void
}) {
  return (
    <Select value={view} onValueChange={(value) => onViewChange(value as LowerPanelView)}>
      <SelectTrigger
        aria-label="Lower panel display"
        className="h-[20px] min-w-[76px] gap-1 px-2 text-[8.5px] leading-none tracking-[0.07em] [&>span]:text-[8.5px] [&>span]:leading-none [&_svg]:h-2.5 [&_svg]:w-2.5"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-[92px]">
        <SelectItem
          value="table"
          className="py-1.5 pl-5 pr-2 text-[8.5px] leading-none tracking-[0.07em] [&_svg]:h-3 [&_svg]:w-3"
        >
          Table
        </SelectItem>
        <SelectItem
          value="chart"
          className="py-1.5 pl-5 pr-2 text-[8.5px] leading-none tracking-[0.07em] [&_svg]:h-3 [&_svg]:w-3"
        >
          Chart
        </SelectItem>
      </SelectContent>
    </Select>
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

function getGammaChartTitle(mode: ExposureMode, expiry: GexExpiry, zeroDteExpiry: GexExpiry) {
  const title = getGexChartTitle(mode)

  return expiry === zeroDteExpiry ? `0DTE ${title}` : title
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
        aria-label="Chart expiry"
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
  const [isOpen, setIsOpen] = useState(false)
  const controlRef = useRef<HTMLDivElement>(null)
  const sliderPct = dataWindowMode === 'full' ? defaultAutoDataWindowPct : dataWindowPct
  const buttonLabel = `${formatPercentInput(sliderPct)}%`

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (controlRef.current?.contains(event.target as Node)) {
        return
      }

      setIsOpen(false)
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)

    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isOpen])

  const handleSliderChange = (value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      return
    }

    onDataWindowModeChange('percent')
    onDataWindowPctChange(parsed)
  }

  return (
    <div ref={controlRef} className="relative flex h-[20px] items-center">
      <Button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label="Adjust chart data window"
        title="Adjust chart data window"
        variant="default"
        size="compact"
        className="h-[20px] w-[58px] gap-0.5 px-1 text-[7.5px] leading-none tracking-[0.035em]"
        onClick={() => setIsOpen((open) => !open)}
      >
        <SlidersHorizontal className="h-2 w-2 shrink-0" />
        <span className="translate-y-px text-[7.5px] text-[var(--terminal-heading)]">±</span>
        <span className="terminal-value translate-y-px text-center text-[7.5px] text-[var(--terminal-heading)]">{buttonLabel}</span>
      </Button>
      {isOpen ? (
        <div
          className="absolute left-1/2 top-[calc(100%+5px)] z-40 w-[132px] -translate-x-1/2 rounded-[var(--terminal-radius-sm)] border border-[var(--terminal-border)] bg-[var(--terminal-surface)] px-2 py-1.5 shadow-xl"
          role="dialog"
          aria-label="Chart data window"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-1 flex items-center justify-center">
            <span className="terminal-value text-[9px] font-semibold leading-none text-[var(--terminal-heading)]">±{formatPercentInput(sliderPct)}%</span>
          </div>
          <input
            aria-label="Chart data window percentage"
            className="terminal-window-slider"
            type="range"
            min={1}
            max={100}
            step={1}
            value={sliderPct}
            onChange={(event) => handleSliderChange(event.currentTarget.value)}
          />
        </div>
      ) : null}
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

function formatPercentInput(value: number) {
  return Number.isInteger(value) ? String(value) : String(value)
}
