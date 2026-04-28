import { ChevronDown, Settings } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTerminalStore } from '@/store/terminalStore'
import { opexExpiries, type GexExpiry, type OpexExpiry } from '@/api/mockGexData'

const modes = ['net', 'split', 'call', 'put', 'abs', 'profile'] as const
const expiryOptions: Array<{ value: GexExpiry; label: string }> = [
  { value: 'ALL', label: 'All Expiries' },
  ...opexExpiries.map((expiry) => ({ value: expiry, label: expiry })),
]
const modeLabels = {
  net: 'Net',
  split: 'Split',
  call: 'Call',
  put: 'Put',
  abs: 'Abs',
  profile: 'Profile',
} as const
const opexCutoffHourUtc = 8
const monthIndexes: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
}

export function TopBar() {
  const {
    expiry,
    exposureMode,
    dataWindowMode,
    dataWindowPct,
    setExpiry,
    setExposureMode,
    setDataWindowMode,
    setDataWindowPct,
  } = useTerminalStore()
  const [filterInput, setFilterInput] = useState(() => formatFilterInput(dataWindowMode, dataWindowPct))
  const [isFilterFocused, setIsFilterFocused] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const nextOpex = useMemo(() => getNextOpex(nowMs), [nowMs])
  const nyTime = useMemo(() => formatNewYorkTime(nowMs), [nowMs])
  const displayedFilterInput = isFilterFocused ? filterInput : formatFilterInput(dataWindowMode, dataWindowPct)

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(intervalId)
  }, [])

  return (
    <header className="flex min-h-[40px] flex-wrap items-center gap-2 border-b border-[var(--terminal-border)] bg-[var(--terminal-bg)] px-3 py-1 lg:flex-nowrap">
      <div className="flex h-[26px] min-w-[178px] items-center gap-2.5">
        <LotusMark />
        <div className="flex h-[26px] translate-y-[1px] items-center text-[14px] font-semibold leading-none tracking-[0.16em] text-[var(--terminal-heading)]">
          LOTUS DATA
        </div>
      </div>

      <Button className="min-w-[64px] text-[var(--terminal-heading)]">
        BTC
        <ChevronDown className="h-3 w-3" />
      </Button>

      <div className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.11em] text-[var(--terminal-text)]">GEX BTC</div>

      <div className="flex flex-1 flex-wrap items-center gap-1.5 lg:ml-5 lg:flex-nowrap">
        <Select value={expiry} onValueChange={(value) => setExpiry(value as GexExpiry)}>
          <SelectTrigger className="min-w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {expiryOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Tabs value={exposureMode} onValueChange={(value) => setExposureMode(value as typeof exposureMode)}>
          <TabsList>
            {modes.map((mode) => (
              <TabsTrigger key={mode} value={mode}>
                {modeLabels[mode]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex h-[26px] min-w-[118px] items-center justify-center gap-1 rounded-[var(--terminal-control-radius)] border border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] px-2 text-[9.5px] font-semibold text-[var(--terminal-text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] transition-colors hover:border-[var(--terminal-border-strong)]">
          <span className="text-[var(--terminal-muted)]">filters:</span>
          <span className="text-[var(--terminal-heading)]">±%</span>
          <input
            aria-label="Data window filter percent"
            className="h-[17px] w-[34px] rounded-[1px] border border-[var(--terminal-border)] bg-[var(--terminal-bg)] px-1 text-center text-[9.5px] leading-[17px] text-[var(--terminal-heading)] outline-none focus:border-[var(--terminal-border-strong)]"
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
                setDataWindowMode('full')
              } else if (typeof parsed === 'number') {
                setDataWindowMode('percent')
                setDataWindowPct(parsed)
              }
            }}
            onBlur={() => {
              setIsFilterFocused(false)
              const parsed = parseFilterInput(filterInput)
              if (parsed === 'full' || parsed === null) {
                setDataWindowMode('full')
                setFilterInput('any')
                return
              }

              setFilterInput(formatPercentInput(parsed))
            }}
          />
        </div>

        {nextOpex ? (
          <div
            className="flex h-[26px] w-fit min-w-0 items-center justify-center gap-1 rounded-[var(--terminal-control-radius)] border border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] px-2 text-[9.5px] font-semibold text-[var(--terminal-text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] lg:ml-auto"
            title={`Next listed expiry: ${nextOpex.label} at ${String(opexCutoffHourUtc).padStart(2, '0')}:00 UTC`}
          >
            <span className="text-[var(--terminal-muted)]">next OpEx:</span>
            <span className="terminal-value text-[var(--terminal-heading)]">
              {formatCountdown(nextOpex.msRemaining)}
            </span>
            <span className="terminal-value text-[var(--terminal-text)]">{nextOpex.label}</span>
            <span className="terminal-value text-[var(--terminal-subtle)]">
              {String(opexCutoffHourUtc).padStart(2, '0')}:00:00 UTC
            </span>
          </div>
        ) : null}

        <div className="hidden h-7 w-px bg-[var(--terminal-border)] lg:block" />

        <div className="flex items-center gap-2.5 whitespace-nowrap text-[10.5px] text-[var(--terminal-text)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--terminal-green-strong)]" />
          <span className="terminal-value">{nyTime}</span>
        </div>

        <div className="h-7 w-px bg-[var(--terminal-border)]" />

        <Button variant="ghost" size="icon" aria-label="Open settings">
          <Settings className="h-[18px] w-[18px]" />
        </Button>
      </div>
    </header>
  )
}

function LotusMark() {
  return (
    <div className="flex h-[26px] w-7 items-center justify-center text-[var(--terminal-heading)]">
      <svg viewBox="0 0 70 54" className="h-[21px] w-7" aria-hidden="true">
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

function formatFilterInput(dataWindowMode: 'percent' | 'full', dataWindowPct: number) {
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

function getNextOpex(nowMs: number) {
  const upcomingExpiries: Array<{ label: OpexExpiry; date: Date }> = []

  for (const label of opexExpiries) {
    const date = parseOpexExpiry(label)
    if (date && date.getTime() > nowMs) {
      upcomingExpiries.push({ label, date })
    }
  }

  const nextExpiry = upcomingExpiries.sort((a, b) => a.date.getTime() - b.date.getTime())[0]

  if (!nextExpiry) return null

  return {
    label: nextExpiry.label,
    msRemaining: Math.max(0, nextExpiry.date.getTime() - nowMs),
  }
}

function parseOpexExpiry(value: string) {
  const match = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(value)
  if (!match) return null

  const [, dayValue, monthValue, yearValue] = match
  const monthIndex = monthIndexes[monthValue]
  if (monthIndex === undefined) return null

  return new Date(Date.UTC(2000 + Number(yearValue), monthIndex, Number(dayValue), opexCutoffHourUtc, 0, 0))
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
