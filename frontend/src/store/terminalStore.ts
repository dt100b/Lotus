import { create } from 'zustand'
import type { GexExpiry } from '@/api/mockGexData'
import {
  clampHeatmapIntensity,
  getStoredHeatmapIntensity,
  getStoredHeatmapPaletteId,
  persistHeatmapIntensity,
  persistHeatmapPaletteId,
  type HeatmapPaletteId,
} from '@/data/heatmapPalettes'
import {
  getStoredTerminalThemeId,
  persistTerminalThemeId,
  type TerminalThemeId,
} from '@/data/terminalThemes'
import { defaultHeatmapDataWindowPct } from '@/components/terminal/gexModes'

/** Active chart/table exposure modes. Split/ABS/Profile archived — see gexModes.ts. */
export type ExposureMode = 'net' | 'heatmap'
export type DataWindowMode = 'percent' | 'full'
export type { HeatmapPaletteId }

type TerminalState = {
  symbol: 'BTC'
  theme: TerminalThemeId
  expiry: GexExpiry
  exposureMode: ExposureMode
  /** Independent second chart (top-right pane). */
  chartTwoExposureMode: ExposureMode
  dataWindowMode: DataWindowMode
  dataWindowPct: number
  chartTwoDataWindowMode: DataWindowMode
  chartTwoDataWindowPct: number
  /** Heatmap surface color template (shared across all heatmap panels). */
  heatmapPalette: HeatmapPaletteId
  /** TRACE surface opacity/brightness (20–100). Shared across heatmap panels. */
  heatmapIntensity: number
  strikeRange: string
  setTheme: (theme: TerminalThemeId) => void
  setExpiry: (expiry: GexExpiry) => void
  setExposureMode: (mode: ExposureMode) => void
  setChartTwoExposureMode: (mode: ExposureMode) => void
  setDataWindowMode: (mode: DataWindowMode) => void
  setDataWindowPct: (pct: number) => void
  setChartTwoDataWindowMode: (mode: DataWindowMode) => void
  setChartTwoDataWindowPct: (pct: number) => void
  setHeatmapPalette: (palette: HeatmapPaletteId) => void
  setHeatmapIntensity: (intensity: number) => void
  setStrikeRange: (range: string) => void
}

export const useTerminalStore = create<TerminalState>((set) => ({
  symbol: 'BTC',
  theme: getStoredTerminalThemeId(),
  expiry: 'ALL',
  exposureMode: 'net',
  /** Default top-right pane: heatmap. */
  chartTwoExposureMode: 'heatmap',
  dataWindowMode: 'percent',
  /** Home layout uses a mid-band ±15% window on the primary Net chart. */
  dataWindowPct: 15,
  chartTwoDataWindowMode: 'percent',
  chartTwoDataWindowPct: defaultHeatmapDataWindowPct,
  heatmapPalette: getStoredHeatmapPaletteId(),
  heatmapIntensity: getStoredHeatmapIntensity(),
  strikeRange: 'Auto',
  setTheme: (theme) => {
    persistTerminalThemeId(theme)
    set({ theme })
  },
  setExpiry: (expiry) => set({ expiry }),
  setExposureMode: (exposureMode) => set({ exposureMode }),
  setChartTwoExposureMode: (chartTwoExposureMode) => set({ chartTwoExposureMode }),
  setDataWindowMode: (dataWindowMode) => set({ dataWindowMode }),
  setDataWindowPct: (dataWindowPct) => set({ dataWindowPct: clampWindowPct(dataWindowPct) }),
  setChartTwoDataWindowMode: (chartTwoDataWindowMode) => set({ chartTwoDataWindowMode }),
  setChartTwoDataWindowPct: (chartTwoDataWindowPct) => set({ chartTwoDataWindowPct: clampWindowPct(chartTwoDataWindowPct) }),
  setHeatmapPalette: (heatmapPalette) => {
    persistHeatmapPaletteId(heatmapPalette)
    set({ heatmapPalette })
  },
  setHeatmapIntensity: (heatmapIntensity) => {
    const next = clampHeatmapIntensity(heatmapIntensity)
    persistHeatmapIntensity(next)
    set({ heatmapIntensity: next })
  },
  setStrikeRange: (strikeRange) => set({ strikeRange }),
}))

function clampWindowPct(value: number) {
  if (!Number.isFinite(value)) {
    return 18
  }

  return Math.min(100, Math.max(1, value))
}
