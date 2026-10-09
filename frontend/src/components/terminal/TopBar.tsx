import { Check, ChevronDown, LayoutTemplate, Plus, Settings } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  deribitOpexCutoffHourUtc,
  formatDeribitCountdown,
  getNextDeribitExpiry,
} from '@/api/deribitExpiries'
import { terminalThemes, type TerminalThemeId } from '@/data/terminalThemes'
import { getDisplaySpot, type TerminalSnapshot, type VolSeriesPoint, type VolSurface } from '@/data/mockTerminal'
import { formatUsd } from '@/lib/formatters'
import { useTerminalStore } from '@/store/terminalStore'

const headerTabs = ['Home', 'GEX', 'Vol', 'Perps', 'Macro'] as const

export type ConnectionStatus = 'live' | 'refreshing' | 'stale' | 'offline' | 'mock'

type TopBarProps = {
  connectionStatus?: ConnectionStatus
  asOfUtc?: string
  snapshot: TerminalSnapshot
  workspaceRows: number
  workspaceCols: number
  panelCount: number
  maxPanelCount: number
  pageCount: number
  activePage: number
  onLayoutSelect: (rows: number, cols: number) => void
  onAddRow: (cols: number) => void
  onAddPage: () => void
  onSelectPage: (page: number) => void
}

const layoutPresets = [
  { rows: 1, cols: 1 },
  { rows: 1, cols: 2 },
  { rows: 1, cols: 3 },
  { rows: 2, cols: 1 },
  { rows: 2, cols: 2 },
  { rows: 2, cols: 3 },
  { rows: 2, cols: 4 },
  { rows: 3, cols: 3 },
] as const

export function TopBar({
  connectionStatus = 'live',
  asOfUtc,
  snapshot,
  workspaceRows,
  workspaceCols,
  panelCount,
  maxPanelCount,
  pageCount,
  activePage,
  onLayoutSelect,
  onAddRow,
  onAddPage,
  onSelectPage,
}: TopBarProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [viewOpen, setViewOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const theme = useTerminalStore((state) => state.theme)
  const setTheme = useTerminalStore((state) => state.setTheme)
  const nextOpex = useMemo(() => getNextDeribitExpiry(nowMs), [nowMs])
  const nyTime = useMemo(() => formatNewYorkTime(nowMs), [nowMs])
  const statusMeta = connectionStatusMeta(connectionStatus)
  const metrics = useMemo(() => buildHeaderMetrics(snapshot), [snapshot])
  const snapshotDate = useMemo(() => formatSnapshotDate(asOfUtc), [asOfUtc])

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (!settingsOpen && !viewOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (settingsRef.current?.contains(target) || viewRef.current?.contains(target)) return
      setSettingsOpen(false)
      setViewOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false)
        setViewOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [settingsOpen, viewOpen])

  return (
    <header className="terminal-topbar">
      <div className="terminal-topbar__left">
        <div className="terminal-brand terminal-brand--mark-only" aria-label="Lotus Data">
          <LotusMark />
        </div>
        <HeaderTabs />
        <div ref={viewRef} className="terminal-view-control">
          <button
            type="button"
            className={viewOpen ? 'terminal-view-trigger terminal-view-trigger--open' : 'terminal-view-trigger'}
            aria-expanded={viewOpen}
            aria-haspopup="menu"
            onClick={() => {
              setViewOpen((open) => !open)
              setSettingsOpen(false)
            }}
          >
            <LayoutTemplate aria-hidden />
            <span>View</span>
            <ChevronDown aria-hidden />
          </button>
          {viewOpen ? (
            <ViewMenu
              rows={workspaceRows}
              cols={workspaceCols}
              panelCount={panelCount}
              maxPanelCount={maxPanelCount}
              pageCount={pageCount}
              activePage={activePage}
              onLayoutSelect={(rows, cols) => {
                onLayoutSelect(rows, cols)
                setViewOpen(false)
              }}
              onAddRow={(cols) => {
                onAddRow(cols)
                setViewOpen(false)
              }}
              onAddPage={onAddPage}
              onSelectPage={onSelectPage}
            />
          ) : null}
        </div>
      </div>

      <div className="terminal-market-tape" aria-label="BTC market overview">
        <span className="terminal-market-tape__date">{snapshotDate}</span>
        <HeaderMetric label="BTC" value={formatUsd(metrics.spot)} tone="spot" meta="Deribit" />
        <HeaderMetric
          label="IV(30D)"
          value={formatVol(metrics.atm30)}
          tone="iv"
          title="30-day constant-maturity forward ATM implied vol · Deribit marks"
        />
        <HeaderMetric
          label="IV(1D)"
          value={formatVol(metrics.atm1)}
          tone="front"
          title="1-day constant-maturity forward ATM implied vol · Deribit marks"
        />
        <HeaderMetric
          label="RV(30D)"
          value={formatVol(metrics.rv30)}
          tone="rv"
          title="30-day Parkinson realized vol, hourly high-low"
        />
      </div>

      <div className="terminal-topbar__right">
        {nextOpex ? (
          <div className="terminal-opex">
            <span>Next OPEX</span>
            <strong>{formatDeribitCountdown(nextOpex.msRemaining)}</strong>
            <b>{nextOpex.label}</b>
            <small>{String(deribitOpexCutoffHourUtc).padStart(2, '0')}:00 UTC</small>
          </div>
        ) : null}
        <span className="terminal-topbar__divider" aria-hidden />
        <div className="terminal-live-status">
          <i style={{ background: statusMeta.dot }} aria-hidden />
          <span>{statusMeta.label}</span>
          <strong>{nyTime}</strong>
        </div>
        <span className="terminal-topbar__divider" aria-hidden />
        <div ref={settingsRef} className="relative">
          <Button
            variant={settingsOpen ? 'active' : 'ghost'}
            size="icon"
            aria-expanded={settingsOpen}
            aria-label="Open settings"
            onClick={() => {
              setSettingsOpen((open) => !open)
              setViewOpen(false)
            }}
          >
            <Settings className="h-[17px] w-[17px]" />
          </Button>
          {settingsOpen ? (
            <SettingsMenu
              theme={theme}
              onThemeChange={(nextTheme) => {
                setTheme(nextTheme)
                setSettingsOpen(false)
              }}
            />
          ) : null}
        </div>
      </div>
    </header>
  )
}

function HeaderTabs() {
  return (
    <nav aria-label="Primary" className="terminal-clean-tabs">
      {headerTabs.map((tab) => {
        const active = tab === 'GEX'
        return (
          <button
            key={tab}
            aria-current={active ? 'page' : undefined}
            aria-disabled={active ? undefined : true}
            className={active ? 'terminal-clean-tab terminal-clean-tab--active' : 'terminal-clean-tab'}
            type="button"
          >
            <span>{tab}</span>
          </button>
        )
      })}
    </nav>
  )
}

function HeaderMetric({
  label,
  value,
  tone,
  meta,
  title,
}: {
  label: string
  value: string
  tone: 'spot' | 'iv' | 'front' | 'rv'
  meta?: string
  title?: string
}) {
  return (
    <div className={`terminal-market-metric terminal-market-metric--${tone}`} title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
      {meta ? <small>{meta}</small> : null}
    </div>
  )
}

function ViewMenu({
  rows,
  cols,
  panelCount,
  maxPanelCount,
  pageCount,
  activePage,
  onLayoutSelect,
  onAddRow,
  onAddPage,
  onSelectPage,
}: {
  rows: number
  cols: number
  panelCount: number
  maxPanelCount: number
  pageCount: number
  activePage: number
  onLayoutSelect: (rows: number, cols: number) => void
  onAddRow: (cols: number) => void
  onAddPage: () => void
  onSelectPage: (page: number) => void
}) {
  return (
    <div className="terminal-view-menu" role="menu" aria-label="Workspace views">
      <div className="terminal-view-menu__section">
        <div className="terminal-view-menu__label">Layout</div>
        <div className="terminal-view-menu__layouts">
          {layoutPresets.map((preset) => {
            const active = rows === preset.rows && cols === preset.cols
            return (
              <button
                key={`${preset.rows}x${preset.cols}`}
                type="button"
                className={active ? 'terminal-layout-option terminal-layout-option--active' : 'terminal-layout-option'}
                aria-label={`${preset.rows} by ${preset.cols} layout`}
                onClick={() => onLayoutSelect(preset.rows, preset.cols)}
              >
                <LayoutGlyph rows={preset.rows} cols={preset.cols} />
              </button>
            )
          })}
        </div>
      </div>
      <div className="terminal-view-menu__rule" />
      <div className="terminal-view-menu__section">
        <div className="terminal-view-menu__label">Add row</div>
        <div className="terminal-view-menu__layouts terminal-view-menu__layouts--rows">
          {[1, 2, 3, 4].map((rowCols) => (
            <button
              key={rowCols}
              type="button"
              className="terminal-layout-option"
              aria-label={`Add row with ${rowCols} ${rowCols === 1 ? 'panel' : 'panels'}`}
              disabled={panelCount >= maxPanelCount}
              onClick={() => onAddRow(rowCols)}
            >
              <LayoutGlyph rows={1} cols={rowCols} />
            </button>
          ))}
        </div>
      </div>
      <div className="terminal-view-menu__rule" />
      {pageCount > 1 ? (
        <div className="terminal-view-menu__pages" aria-label="Workspace pages">
          {Array.from({ length: pageCount }, (_, page) => (
            <button
              key={page}
              type="button"
              className={page === activePage ? 'terminal-page-chip terminal-page-chip--active' : 'terminal-page-chip'}
              onClick={() => onSelectPage(page)}
            >
              {page + 1}
            </button>
          ))}
        </div>
      ) : null}
      <button type="button" className="terminal-add-page" onClick={onAddPage}>
        <Plus aria-hidden />
        <span>Add page</span>
      </button>
    </div>
  )
}

function LayoutGlyph({ rows, cols }: { rows: number; cols: number }) {
  return (
    <span
      className="terminal-layout-glyph"
      aria-hidden
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      {Array.from({ length: rows * cols }, (_, index) => <i key={index} />)}
    </span>
  )
}

function SettingsMenu({ theme, onThemeChange }: { theme: TerminalThemeId; onThemeChange: (theme: TerminalThemeId) => void }) {
  return (
    <div className="terminal-settings-menu" role="menu">
      <div className="terminal-settings-menu__header">Settings</div>
      <div className="terminal-settings-menu__body">
        <div className="terminal-settings-menu__label">Theme</div>
        {terminalThemes.map((themeOption) => {
          const selected = themeOption.id === theme
          return (
            <button
              key={themeOption.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className={selected ? 'terminal-theme-option terminal-theme-option--active' : 'terminal-theme-option'}
              onClick={() => onThemeChange(themeOption.id)}
            >
              <span className="terminal-theme-option__swatches">
                {themeOption.swatches.map((swatch) => <i key={swatch} style={{ background: swatch }} />)}
              </span>
              <span>{themeOption.label}</span>
              {selected ? <Check aria-hidden /> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function LotusMark() {
  return (
    <div className="terminal-brand-mark">
      <svg viewBox="0 0 70 54" className="h-[24px] w-[30px]" aria-hidden="true">
        <path d="M35 49C22 37 19 24 35 5c16 19 13 32 0 44Z" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M35 49C19 43 10 31 18 12c16 9 22 21 17 37ZM35 49c16-6 25-18 17-37-16 9-22 21-17 37Z" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M35 49C21 51 9 46 5 31c14 0 25 6 30 18ZM35 49c14 2 26-3 30-18-14 0-25 6-30 18Z" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    </div>
  )
}

function buildHeaderMetrics(snapshot: TerminalSnapshot) {
  const volCompare = snapshot.flowRegime?.volCompare ?? snapshot.volCompare
  const surface = snapshot.flowRegime?.volSurface
  const atmCurve = snapshot.flowRegime?.atmTermCurve
  return {
    spot: getDisplaySpot(snapshot),
    atm30: tenorAtm(atmCurve, '30d'),
    atm1: tenorAtm(atmCurve, '1d'),
    rv30: finiteValue(surface?.atmVsRv?.rvPercent) ?? lastFiniteValue(volCompare?.rvSeries),
  }
}

function tenorAtm(surface: VolSurface | undefined, tenor: string): number | null {
  const row = surface?.tenors.find((item) => item.tenor === tenor)
  if (!row || row.status !== 'ok' || row.calendarOk === false) return null
  const value = finiteValue(row.atmIvPercent)
  return value != null && value > 0 ? value : null
}

function lastFiniteValue(series: VolSeriesPoint[] | undefined): number | null {
  if (!series) return null
  for (let index = series.length - 1; index >= 0; index--) {
    const value = series[index]?.value
    if (value != null && Number.isFinite(value)) return value
  }
  return null
}

function finiteValue(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null
}

function formatVol(value: number | null) {
  return value == null ? '—' : value.toFixed(1)
}

function formatSnapshotDate(asOfUtc: string | undefined) {
  if (!asOfUtc) return 'BTC OPTIONS'
  const date = new Date(asOfUtc)
  if (!Number.isFinite(date.getTime())) return 'BTC OPTIONS'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date).toUpperCase()
}

function formatNewYorkTime(nowMs: number) {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  }).format(nowMs)
}

function connectionStatusMeta(status: ConnectionStatus): { label: string; dot: string } {
  switch (status) {
    case 'refreshing': return { label: 'Refreshing', dot: 'var(--terminal-heading)' }
    case 'stale': return { label: 'Stale', dot: 'var(--terminal-red-strong)' }
    case 'offline': return { label: 'Offline', dot: 'var(--terminal-red-strong)' }
    case 'mock': return { label: 'Mock', dot: 'var(--terminal-muted)' }
    case 'live':
    default: return { label: 'Live', dot: 'var(--terminal-green-strong)' }
  }
}
