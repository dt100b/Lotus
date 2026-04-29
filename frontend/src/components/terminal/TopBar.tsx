import { ChevronDown, Settings } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { deribitOpexCutoffHourUtc, getNextDeribitExpiry } from '@/api/deribitExpiries'

export function TopBar() {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const nextOpex = useMemo(() => getNextDeribitExpiry(nowMs), [nowMs])
  const nyTime = useMemo(() => formatNewYorkTime(nowMs), [nowMs])

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(intervalId)
  }, [])

  return (
    <header className="flex min-h-[40px] flex-wrap items-center gap-2 border-b border-[var(--terminal-border)] bg-[var(--terminal-bg)] px-3 py-1 lg:flex-nowrap">
      <div className="flex h-[26px] min-w-[158px] items-center gap-2">
        <LotusMark />
        <div className="flex h-[24px] translate-y-[0.5px] items-center text-[12.5px] font-semibold leading-none tracking-[0.145em] text-[var(--terminal-heading)]">
          LOTUS DATA
        </div>
      </div>

      <Button className="min-w-[64px] text-[var(--terminal-heading)]">
        BTC
        <ChevronDown className="h-3 w-3" />
      </Button>

      <div className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.11em] text-[var(--terminal-text)]">GEX BTC</div>

      <div className="flex flex-1 flex-wrap items-center gap-1.5 lg:ml-5 lg:flex-nowrap">
        {nextOpex ? (
          <div
            className="flex h-[26px] w-fit min-w-0 items-center justify-center gap-1 rounded-[var(--terminal-control-radius)] border border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] px-2 text-[9.5px] font-semibold text-[var(--terminal-text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] lg:ml-auto"
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
