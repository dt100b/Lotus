import { create } from 'zustand'
import type { GexExpiry } from '@/api/mockGexData'

export type ExposureMode = 'net' | 'split' | 'call' | 'put' | 'abs' | 'profile'
export type DataWindowMode = 'percent' | 'full'
export type LevelVisibility = {
  allExpiryHvl: boolean
  allExpiryCallResistance: boolean
  allExpiryPutSupport: boolean
  zeroDteHvl: boolean
  zeroDteCall: boolean
  zeroDtePut: boolean
  advancedZeroGamma: boolean
  advancedMaxPain: boolean
  advancedExpectedMove: boolean
  advancedGammaFlipZones: boolean
}
export type LevelVisibilityKey = keyof LevelVisibility

type TerminalState = {
  symbol: 'BTC'
  expiry: GexExpiry
  exposureMode: ExposureMode
  dataWindowMode: DataWindowMode
  dataWindowPct: number
  levelVisibility: LevelVisibility
  strikeRange: string
  setExpiry: (expiry: GexExpiry) => void
  setExposureMode: (mode: ExposureMode) => void
  setDataWindowMode: (mode: DataWindowMode) => void
  setDataWindowPct: (pct: number) => void
  setLevelVisibility: (level: LevelVisibilityKey, visible: boolean) => void
  setStrikeRange: (range: string) => void
}

export const useTerminalStore = create<TerminalState>((set) => ({
  symbol: 'BTC',
  expiry: 'ALL',
  exposureMode: 'net',
  dataWindowMode: 'full',
  dataWindowPct: 18,
  levelVisibility: {
    allExpiryHvl: true,
    allExpiryCallResistance: false,
    allExpiryPutSupport: false,
    zeroDteHvl: false,
    zeroDteCall: false,
    zeroDtePut: false,
    advancedZeroGamma: false,
    advancedMaxPain: false,
    advancedExpectedMove: false,
    advancedGammaFlipZones: false,
  },
  strikeRange: 'Auto',
  setExpiry: (expiry) => set({ expiry }),
  setExposureMode: (exposureMode) => set({ exposureMode }),
  setDataWindowMode: (dataWindowMode) => set({ dataWindowMode }),
  setDataWindowPct: (dataWindowPct) => set({ dataWindowPct: clampWindowPct(dataWindowPct) }),
  setLevelVisibility: (level, visible) =>
    set((state) => ({
      levelVisibility: {
        ...state.levelVisibility,
        [level]: visible,
      },
    })),
  setStrikeRange: (strikeRange) => set({ strikeRange }),
}))

function clampWindowPct(value: number) {
  if (!Number.isFinite(value)) {
    return 18
  }

  return Math.min(100, Math.max(1, value))
}
