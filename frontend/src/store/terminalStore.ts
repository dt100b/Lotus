import { create } from 'zustand'
import type { GexExpiry } from '@/api/mockGexData'

export type ExposureMode = 'net' | 'split' | 'call' | 'put' | 'abs' | 'profile'
export type DataWindowMode = 'percent' | 'full'

type TerminalState = {
  symbol: 'BTC'
  expiry: GexExpiry
  exposureMode: ExposureMode
  dataWindowMode: DataWindowMode
  dataWindowPct: number
  strikeRange: string
  setExpiry: (expiry: GexExpiry) => void
  setExposureMode: (mode: ExposureMode) => void
  setDataWindowMode: (mode: DataWindowMode) => void
  setDataWindowPct: (pct: number) => void
  setStrikeRange: (range: string) => void
}

export const useTerminalStore = create<TerminalState>((set) => ({
  symbol: 'BTC',
  expiry: 'ALL',
  exposureMode: 'net',
  dataWindowMode: 'percent',
  dataWindowPct: 18,
  strikeRange: 'Auto',
  setExpiry: (expiry) => set({ expiry }),
  setExposureMode: (exposureMode) => set({ exposureMode }),
  setDataWindowMode: (dataWindowMode) => set({ dataWindowMode }),
  setDataWindowPct: (dataWindowPct) => set({ dataWindowPct: clampWindowPct(dataWindowPct) }),
  setStrikeRange: (strikeRange) => set({ strikeRange }),
}))

function clampWindowPct(value: number) {
  if (!Number.isFinite(value)) {
    return 18
  }

  return Math.min(100, Math.max(1, value))
}
