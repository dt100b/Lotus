import { ChevronDown, RefreshCw } from 'lucide-react'
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
import { opexExpiries, type GexExpiry } from '@/api/mockGexData'

type TopBarProps = {
  asOfUtc: string
}

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

export function TopBar({ asOfUtc }: TopBarProps) {
  const {
    expiry,
    exposureMode,
    dataWindowPct,
    setExpiry,
    setExposureMode,
    setDataWindowMode,
    setDataWindowPct,
  } = useTerminalStore()
  const dataWindowInputWidth = `${Math.min(5, Math.max(2, String(dataWindowPct).length + 0.5))}ch`

  return (
    <header className="flex min-h-[70px] flex-wrap items-center gap-4 border-b border-[#2b3537] px-4 py-3 lg:flex-nowrap">
      <div className="flex min-w-[232px] items-center gap-3">
        <LotusMark />
        <div className="font-sans text-[21px] font-black italic tracking-[0.11em] text-[#f5d8a7]">
          LOTUS DATA
        </div>
      </div>

      <Button className="min-w-[86px] text-[#ff8a00]">
        BTC
        <ChevronDown className="h-4 w-4" />
      </Button>

      <div className="whitespace-nowrap text-[15px] uppercase tracking-[0.08em] text-[#ede0cb]">GEX BTC</div>

      <div className="flex flex-1 flex-wrap items-center gap-3 lg:ml-12 lg:flex-nowrap">
        <Select value={expiry} onValueChange={(value) => setExpiry(value as GexExpiry)}>
          <SelectTrigger className="min-w-[198px]">
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

        <div className="flex h-10 min-w-[118px] items-center justify-center rounded-[4px] border border-[#4b5556] bg-[#05090b] px-3 text-[15px] text-[#f0e4d2] shadow-[inset_0_0_18px_rgba(0,0,0,0.34)] transition-colors hover:border-[#7d8a86]">
          <span className="text-[#f1d3a1]">+</span>
          <input
            aria-label="Data window percent"
            className="h-full bg-transparent px-0 text-center text-[#f0e4d2] outline-none"
            min={1}
            max={100}
            step={0.5}
            style={{ width: dataWindowInputWidth }}
            type="number"
            value={dataWindowPct}
            onChange={(event) => {
              setDataWindowMode('percent')
              setDataWindowPct(event.currentTarget.valueAsNumber)
            }}
          />
          <span className="text-[#938b7b]">%</span>
        </div>

        <Button variant="ghost" size="icon" aria-label="Refresh mock snapshot" className="lg:ml-auto">
          <RefreshCw className="h-5 w-5" />
        </Button>

        <div className="hidden h-8 w-px bg-[#344144] lg:block" />

        <div className="flex items-center gap-3 whitespace-nowrap text-sm text-[#d8d4ca]">
          <span className="h-2.5 w-2.5 rounded-full bg-[#2fbf62] shadow-[0_0_14px_rgba(47,191,98,0.45)]" />
          <span>{asOfUtc}</span>
        </div>
      </div>
    </header>
  )
}

function LotusMark() {
  return (
    <div className="relative h-11 w-14 text-[#f2c579]">
      <svg viewBox="0 0 70 54" className="h-full w-full" aria-hidden="true">
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
