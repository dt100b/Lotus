import { create } from 'zustand'
import type { GexExpiry } from '@/api/mockGexData'
import {
  getStoredTerminalThemeId,
  persistTerminalThemeId,
  type TerminalThemeId,
} from '@/data/terminalThemes'

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
  theme: TerminalThemeId
  expiry: GexExpiry
  exposureMode: ExposureMode
  splitChartEnabled: boolean
  zeroDteExposureMode: ExposureMode
  dataWindowMode: DataWindowMode
  dataWindowPct: number
  zeroDteDataWindowMode: DataWindowMode
  zeroDteDataWindowPct: number
  levelVisibility: LevelVisibility
  strikeRange: string
  setTheme: (theme: TerminalThemeId) => void
  setExpiry: (expiry: GexExpiry) => void
  setExposureMode: (mode: ExposureMode) => void
  setSplitChartEnabled: (enabled: boolean) => void
  setZeroDteExposureMode: (mode: ExposureMode) => void
  setDataWindowMode: (mode: DataWindowMode) => void
  setDataWindowPct: (pct: number) => void
  setZeroDteDataWindowMode: (mode: DataWindowMode) => void
  setZeroDteDataWindowPct: (pct: number) => void
  setLevelVisibility: (level: LevelVisibilityKey, visible: boolean) => void
  setStrikeRange: (range: string) => void
}

export const useTerminalStore = create<TerminalState>((set) => ({
  symbol: 'BTC',
  theme: getStoredTerminalThemeId(),
  expiry: 'ALL',
  exposureMode: 'net',
  splitChartEnabled: false,
  zeroDteExposureMode: 'net',
  dataWindowMode: 'full',
  dataWindowPct: 18,
  zeroDteDataWindowMode: 'full',
  zeroDteDataWindowPct: 18,
  levelVisibility: {
    allExpiryHvl: true,
    allExpiryCallResistance: true,
    allExpiryPutSupport: true,
    zeroDteHvl: false,
    zeroDteCall: false,
    zeroDtePut: false,
    advancedZeroGamma: false,
    advancedMaxPain: false,
    advancedExpectedMove: false,
    advancedGammaFlipZones: false,
  },
  strikeRange: 'Auto',
  setTheme: (theme) => {
    persistTerminalThemeId(theme)
    set({ theme })
  },
  setExpiry: (expiry) => set({ expiry }),
  setExposureMode: (exposureMode) => set({ exposureMode }),
  setSplitChartEnabled: (splitChartEnabled) => set({ splitChartEnabled }),
  setZeroDteExposureMode: (zeroDteExposureMode) => set({ zeroDteExposureMode }),
  setDataWindowMode: (dataWindowMode) => set({ dataWindowMode }),
  setDataWindowPct: (dataWindowPct) => set({ dataWindowPct: clampWindowPct(dataWindowPct) }),
  setZeroDteDataWindowMode: (zeroDteDataWindowMode) => set({ zeroDteDataWindowMode }),
  setZeroDteDataWindowPct: (zeroDteDataWindowPct) => set({ zeroDteDataWindowPct: clampWindowPct(zeroDteDataWindowPct) }),
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
