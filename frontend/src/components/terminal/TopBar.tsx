import { Check, ChevronDown, Settings } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { deribitOpexCutoffHourUtc, getNextDeribitExpiry } from '@/api/deribitExpiries'
import { terminalThemes, type TerminalThemeId } from '@/data/terminalThemes'
import { useTerminalStore } from '@/store/terminalStore'

export function TopBar() {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const theme = useTerminalStore((state) => state.theme)
  const setTheme = useTerminalStore((state) => state.setTheme)
  const nextOpex = useMemo(() => getNextDeribitExpiry(nowMs), [nowMs])
  const nyTime = useMemo(() => formatNewYorkTime(nowMs), [nowMs])

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
    <header className="flex min-h-[40px] flex-wrap items-center gap-2.5 border-b border-[var(--terminal-border)] bg-[var(--terminal-bg)] px-3 py-1 lg:flex-nowrap">
      <div className="flex h-[28px] min-w-[166px] items-center gap-2">
        <LotusMark />
        <div className="flex h-[24px] translate-y-[0.5px] items-center text-[13.5px] font-semibold leading-none tracking-[0.16em] text-[var(--terminal-heading)]">
          LOTUS DATA
        </div>
      </div>

      <Button className="h-[24px] min-w-[76px] gap-2 border-[var(--terminal-border-strong)] px-2.5 text-[11px] tracking-[0.14em] text-[var(--terminal-heading)]">
        BTC
        <ChevronDown className="h-3 w-3 text-[var(--terminal-muted)]" />
      </Button>

      <div className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--terminal-muted)]">FLOW-ADJUSTED GEX</div>

      <div className="flex flex-1 flex-wrap items-center gap-1.5 lg:ml-5 lg:flex-nowrap">
        {nextOpex ? (
          <div
            className="flex h-[26px] w-fit min-w-0 items-center justify-center gap-1 rounded-[var(--terminal-control-radius)] border border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] px-2 text-[9.5px] font-semibold text-[var(--terminal-text)] shadow-[var(--terminal-control-inset)] lg:ml-auto"
            title={`Next listed expiry: ${nextOpex.label} at ${String(deribitOpexCutoffHourUtc).padStart(2, '0')}:00 UTC`}
          >
            <span className="text-[var(--terminal-muted)]">NEXT OPEX:</span>
            <span className="terminal-value text-[var(--terminal-heading)]">
              {formatCountdown(nextOpex.msRemaining)}
            </span>
            <span className="terminal-value text-[var(--terminal-text)]">{nextOpex.label}</span>
            <span className="terminal-value text-[var(--terminal-subtle)]">
              {String(deribitOpexCutoffHourUtc).padStart(2, '0')}:00:00 UTC
            </span>
          </div>
        ) : null}

        <div className="hidden h-7 w-px bg-[var(--terminal-border)] lg:block" />

        <div className="flex items-center gap-2.5 whitespace-nowrap text-[10.5px] text-[var(--terminal-text)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--terminal-green-strong)]" />
          <span className="terminal-value">{nyTime}</span>
        </div>

        <div className="h-7 w-px bg-[var(--terminal-border)]" />

        <div ref={settingsRef} className="relative">
          <Button
            variant={settingsOpen ? 'active' : 'ghost'}
            size="icon"
            aria-expanded={settingsOpen}
            aria-label="Open settings"
            title="Settings"
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

function SettingsMenu({
  theme,
  onThemeChange,
}: {
  theme: TerminalThemeId
  onThemeChange: (theme: TerminalThemeId) => void
}) {
  return (
    <div
      className="absolute right-0 top-[calc(100%+6px)] z-[90] w-[252px] overflow-hidden rounded-[var(--terminal-radius)] border border-[var(--terminal-border-strong)] bg-[var(--terminal-surface)] text-[var(--terminal-text)] shadow-2xl"
      role="menu"
    >
      <div className="border-b border-[var(--terminal-rule)] px-3 py-2">
        <div className="terminal-title">Settings</div>
      </div>
      <div className="px-2 py-2">
        <div className="mb-1.5 px-1 text-[8.5px] font-semibold uppercase tracking-[0.12em] text-[var(--terminal-muted)]">
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
                  ? 'grid h-[34px] w-full cursor-pointer grid-cols-[42px_minmax(0,1fr)_16px] items-center gap-2 rounded-[var(--terminal-control-radius)] border border-[var(--terminal-active-border)] bg-[var(--terminal-active-bg)] px-2 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-heading)] shadow-[var(--terminal-active-shadow)]'
                  : 'grid h-[34px] w-full cursor-pointer grid-cols-[42px_minmax(0,1fr)_16px] items-center gap-2 rounded-[var(--terminal-control-radius)] border border-transparent bg-transparent px-2 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-text)] transition-colors hover:border-[var(--terminal-control-border)] hover:bg-[var(--terminal-surface-2)] hover:text-[var(--terminal-heading)] focus-visible:border-[var(--terminal-border-strong)] focus-visible:outline-none'}
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
                {selected ? <Check className="h-3.5 w-3.5 text-[var(--terminal-green-strong)]" /> : null}
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
    <div className="flex h-[28px] w-7 items-center justify-center text-[var(--terminal-heading)]">
      <svg viewBox="0 0 70 54" className="h-[23px] w-7" aria-hidden="true">
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
