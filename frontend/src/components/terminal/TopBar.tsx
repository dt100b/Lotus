import { Check, ChevronDown, Plus, Settings } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { deribitOpexCutoffHourUtc, getNextDeribitExpiry } from '@/api/deribitExpiries'
import { terminalThemes, type TerminalThemeId } from '@/data/terminalThemes'
import { useTerminalStore } from '@/store/terminalStore'

const headerTabs = ['Home', 'GEX', 'Vol', 'Perps', 'Macro'] as const

export type ConnectionStatus = 'live' | 'refreshing' | 'stale' | 'offline' | 'mock'

type TopBarProps = {
  connectionStatus?: ConnectionStatus
  asOfUtc?: string
  /** Add a blank panel to the workspace (auto-reflows grid). */
  onAddPanel?: () => void
  /** When true, the add-panel control is disabled (at max panels). */
  addPanelDisabled?: boolean
}

export function TopBar({
  connectionStatus = 'live',
  asOfUtc: _asOfUtc,
  onAddPanel,
  addPanelDisabled = false,
}: TopBarProps) {
  void _asOfUtc
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const theme = useTerminalStore((state) => state.theme)
  const setTheme = useTerminalStore((state) => state.setTheme)
  const nextOpex = useMemo(() => getNextDeribitExpiry(nowMs), [nowMs])
  const nyTime = useMemo(() => formatNewYorkTime(nowMs), [nowMs])
  const statusMeta = connectionStatusMeta(connectionStatus)

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (!settingsOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (settingsRef.current?.contains(event.target as Node)) {
        return
      }

      setSettingsOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [settingsOpen])

  return (
    <header className="flex min-h-[48px] flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--desk-rule,var(--terminal-border))] bg-[var(--terminal-bg)] px-4 py-2 lg:flex-nowrap">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 lg:flex-nowrap">
        <div className="terminal-brand terminal-brand--mark-only" aria-label="Lotus Data">
          <LotusMark />
        </div>

        <HeaderTabs />

        <div className="flex min-w-0 items-center gap-3">
          <Button className="terminal-market-select">
            <span>BTC</span>
            <ChevronDown className="h-[11px] w-[11px]" />
          </Button>

          <div className="terminal-label min-w-0 whitespace-nowrap tracking-[0.1em]">
            Flow-Adjusted GEX
          </div>

          {onAddPanel ? (
            <button
              type="button"
              className="terminal-add-panel"
              aria-label="Add panel to workspace"
              disabled={addPanelDisabled}
              onClick={onAddPanel}
            >
              <Plus className="terminal-add-panel__icon" strokeWidth={2.25} aria-hidden />
              <span className="terminal-add-panel__label">Panel</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:ml-auto lg:flex-nowrap">
        {nextOpex ? (
          <div
            className="flex min-h-[28px] w-fit min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--terminal-control-radius)] border border-transparent bg-transparent px-1 text-[9px] font-semibold"
          >
            <span className="terminal-label tracking-[0.08em]">Next OPEX</span>
            <span className="terminal-value text-[10px]">
              {formatCountdown(nextOpex.msRemaining)}
            </span>
            <span className="terminal-value text-[10px] text-[var(--desk-value-soft)]">{nextOpex.label}</span>
            <span className="terminal-meta hidden sm:inline">
              {String(deribitOpexCutoffHourUtc).padStart(2, '0')}:00:00 UTC
            </span>
          </div>
        ) : null}

        <div className="hidden h-6 w-px bg-[var(--desk-rule,var(--terminal-rule))] lg:block" />

        <div
          className="flex min-h-[28px] items-center gap-2.5 whitespace-nowrap text-[10px]"
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full opacity-80"
            style={{ background: statusMeta.dot }}
            aria-hidden
          />
          <span className="terminal-label tracking-[0.08em]">{statusMeta.label}</span>
          <span className="terminal-value text-[10px]">{nyTime}</span>
        </div>

        <div className="h-6 w-px bg-[var(--desk-rule,var(--terminal-rule))]" />

        <div ref={settingsRef} className="relative">
          <Button
            variant={settingsOpen ? 'active' : 'ghost'}
            size="icon"
            aria-expanded={settingsOpen}
            aria-label="Open settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <Settings className="h-[18px] w-[18px]" />
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
    <nav
      aria-label="Primary"
      className="terminal-clean-tabs min-w-0 flex-shrink-0 overflow-x-auto"
    >
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

function SettingsMenu({
  theme,
  onThemeChange,
}: {
  theme: TerminalThemeId
  onThemeChange: (theme: TerminalThemeId) => void
}) {
  return (
    <div
      className="absolute right-0 top-[calc(100%+6px)] z-[90] w-[252px] overflow-hidden rounded-[var(--terminal-radius)] border border-[var(--desk-rule,var(--terminal-border-strong))] bg-[var(--terminal-surface)] text-[var(--desk-value)] shadow-2xl"
      role="menu"
    >
      <div className="border-b border-[var(--desk-rule,var(--terminal-rule))] px-3 py-2">
        <div className="terminal-title">Settings</div>
      </div>
      <div className="px-2 py-2">
        <div className="terminal-label mb-1.5 px-1 tracking-[0.12em]">
          Theme
        </div>
        <div className="grid gap-1">
          {terminalThemes.map((themeOption) => {
            const selected = themeOption.id === theme

            return (
              <button
                key={themeOption.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={selected
                  ? 'grid h-[34px] w-full cursor-pointer grid-cols-[42px_minmax(0,1fr)_16px] items-center gap-2 rounded-[var(--terminal-control-radius)] border border-[var(--terminal-active-border)] bg-[var(--terminal-active-bg)] px-2 text-left text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--desk-value)] shadow-[var(--terminal-active-shadow)]'
                  : 'grid h-[34px] w-full cursor-pointer grid-cols-[42px_minmax(0,1fr)_16px] items-center gap-2 rounded-[var(--terminal-control-radius)] border border-transparent bg-transparent px-2 text-left text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--desk-label)] transition-colors hover:border-[var(--terminal-control-border)] hover:bg-[var(--terminal-surface-2)] hover:text-[var(--desk-value)] focus-visible:border-[var(--terminal-border-strong)] focus-visible:outline-none'}
                onClick={() => onThemeChange(themeOption.id)}
              >
                <span className="flex items-center">
                  {themeOption.swatches.map((swatch) => (
                    <span
                      key={swatch}
                      className="-ml-1 first:ml-0 h-4 w-4 rounded-full border border-[var(--terminal-border-strong)]"
                      style={{ background: swatch }}
                    />
                  ))}
                </span>
                <span className="truncate">{themeOption.label}</span>
                {selected ? <Check className="h-3.5 w-3.5 text-[var(--desk-long-text)]" /> : null}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function LotusMark() {
  return (
    <div className="terminal-brand-mark">
      <svg viewBox="0 0 70 54" className="h-[24px] w-[30px]" aria-hidden="true">
        <path
          d="M35 49C22 37 19 24 35 5c16 19 13 32 0 44Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M35 49C19 43 10 31 18 12c16 9 22 21 17 37ZM35 49c16-6 25-18 17-37-16 9-22 21-17 37Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M35 49C21 51 9 46 5 31c14 0 25 6 30 18ZM35 49c14 2 26-3 30-18-14 0-25 6-30 18Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
    </div>
  )
}

function formatCountdown(msRemaining: number) {
  const totalSeconds = Math.floor(msRemaining / 1_000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const time = [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')

  return days > 0 ? `${days}d ${time}` : time
}

function formatNewYorkTime(nowMs: number) {
  const time = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  }).format(nowMs)

  return time
}

function connectionStatusMeta(status: ConnectionStatus): {
  label: string
  dot: string
} {
  switch (status) {
    case 'refreshing':
      return {
        label: 'Refreshing',
        dot: 'var(--terminal-heading)',
      }
    case 'stale':
      return {
        label: 'Stale',
        dot: 'var(--terminal-red-strong)',
      }
    case 'offline':
      return {
        label: 'Offline',
        dot: 'var(--terminal-red-strong)',
      }
    case 'mock':
      return {
        label: 'Mock',
        dot: 'var(--terminal-muted)',
      }
    case 'live':
    default:
      return {
        label: 'Live',
        dot: 'var(--terminal-green-strong)',
      }
  }
}
