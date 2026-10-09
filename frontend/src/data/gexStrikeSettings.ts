import { defaultForwardPaletteIds } from '@/data/forwardGreekPalettes'

export type GexStrikeSideRows =
  | 'putCallGex'
  | 'positiveNegativeGex'
  | 'netExposureChange'

export type GexStrikeMetric = 'gamma' | 'delta'

export type GexStrikeSettings = {
  metric: GexStrikeMetric
  paletteId: string
  /** 0 = minimum thickness, 50 = 8px, 100 = almost full row. */
  barWidthPct: number
  gradientBars: boolean
  sideRowGradient: boolean
  showHorizontalGrid: boolean
  /** Mutually exclusive values displayed in the left/right ladder columns. */
  sideRows: GexStrikeSideRows | null
}

export const defaultGexStrikeSettings: GexStrikeSettings = {
  metric: 'gamma',
  paletteId: defaultForwardPaletteIds.gamma,
  barWidthPct: 75,
  gradientBars: false,
  sideRowGradient: true,
  showHorizontalGrid: false,
  sideRows: 'positiveNegativeGex',
}
