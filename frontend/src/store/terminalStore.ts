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
export type ExposureMode = 'net' | 'heatmap' | 'forward'
export type DataWindowMode = 'percent' | 'full'
export type { HeatmapPaletteId }

export type GexStrikeFocus = {
  strike: number
  netGexUsd: number
  /** Ladder instance that owns live refreshes for this selection. */
  ownerId?: string
  /** Palette colors travel with linked guides so Surface/Price lines match Strike. */
  positiveColor?: string
  negativeColor?: string
}

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
  /** Shared ladder focus: hover is transient, active is a single click selection. */
  gexActiveStrike: GexStrikeFocus | null
  gexHoveredStrike: GexStrikeFocus | null
  /** Shift-marked strikes remain until individually toggled off. */
  gexMarkedStrikes: GexStrikeFocus[]
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
  setGexActiveStrike: (focus: GexStrikeFocus | null) => void
  setGexHoveredStrike: (focus: GexStrikeFocus | null) => void
  setGexMarkedStrikes: (strikes: GexStrikeFocus[]) => void
  toggleGexMarkedStrike: (focus: GexStrikeFocus) => void
}

export const useTerminalStore = create<TerminalState>((set) => ({
  symbol: 'BTC',
  theme: getStoredTerminalThemeId(),
  expiry: 'ALL',
  exposureMode: 'net',
  /** Default top-right pane: heatmap. */
  chartTwoExposureMode: 'heatmap',
  dataWindowMode: 'full',
  /** Retained for Price/Surface camera state; Strike always shows the full surface. */
  dataWindowPct: 15,
  chartTwoDataWindowMode: 'percent',
  chartTwoDataWindowPct: defaultHeatmapDataWindowPct,
  heatmapPalette: getStoredHeatmapPaletteId(),
  heatmapIntensity: getStoredHeatmapIntensity(),
  strikeRange: 'Auto',
  gexActiveStrike: null,
  gexHoveredStrike: null,
  gexMarkedStrikes: [],
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
  setGexActiveStrike: (gexActiveStrike) => set((state) => (
    sameGexFocus(state.gexActiveStrike, gexActiveStrike)
      ? state
      : { gexActiveStrike }
  )),
  setGexHoveredStrike: (gexHoveredStrike) => set((state) => (
    sameGexFocus(state.gexHoveredStrike, gexHoveredStrike)
      ? state
      : { gexHoveredStrike }
  )),
  setGexMarkedStrikes: (gexMarkedStrikes) => set((state) => (
    sameGexFocusList(state.gexMarkedStrikes, gexMarkedStrikes)
      ? state
      : { gexMarkedStrikes }
  )),
  toggleGexMarkedStrike: (focus) => set((state) => {
    const exists = state.gexMarkedStrikes.some((item) => item.strike === focus.strike)
    return {
      gexMarkedStrikes: exists
        ? state.gexMarkedStrikes.filter((item) => item.strike !== focus.strike)
        : [...state.gexMarkedStrikes, focus],
    }
  }),
}))

function sameGexFocus(left: GexStrikeFocus | null, right: GexStrikeFocus | null) {
  return left?.strike === right?.strike
    && left?.netGexUsd === right?.netGexUsd
    && left?.ownerId === right?.ownerId
    && left?.positiveColor === right?.positiveColor
    && left?.negativeColor === right?.negativeColor
}

function sameGexFocusList(left: GexStrikeFocus[], right: GexStrikeFocus[]) {
  return left.length === right.length
    && left.every((item, index) => sameGexFocus(item, right[index] ?? null))
}

function clampWindowPct(value: number) {
  if (!Number.isFinite(value)) {
    return 18
  }

  return Math.min(100, Math.max(1, value))
}
