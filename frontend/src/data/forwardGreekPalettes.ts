import type { ForwardGreekMetric } from '@/api/gexForwardSurface'
import type { GammaStop } from '@/data/heatmapPalettes'

export type ForwardGreekPalette = {
  id: string
  label: string
  description: string
  ramp: GammaStop[]
}

const stop = (t: number, r: number, g: number, b: number): GammaStop => ({
  t,
  c: { r, g, b, a: 1 },
})

const diverging = (
  negative: [[number, number, number], [number, number, number], [number, number, number]],
  positive: [[number, number, number], [number, number, number], [number, number, number]],
): GammaStop[] => [
  stop(-1, ...negative[0]),
  stop(-0.55, ...negative[1]),
  stop(-0.2, ...negative[2]),
  stop(0, 8, 11, 15),
  stop(0.2, ...positive[2]),
  stop(0.55, ...positive[1]),
  stop(1, ...positive[0]),
]

export const forwardGreekPalettes: Record<ForwardGreekMetric, ForwardGreekPalette[]> = {
  gamma: [
    {
      id: 'gamma-flow', label: 'Flow', description: 'Coral short gamma / liquid-teal long gamma',
      ramp: diverging([[255, 74, 125], [205, 39, 92], [83, 20, 52]], [[94, 255, 232], [25, 191, 178], [10, 71, 74]]),
    },
    {
      id: 'gamma-thermal', label: 'Thermal', description: 'Amber short gamma / glacial-blue long gamma',
      ramp: diverging([[255, 190, 66], [223, 106, 25], [91, 41, 18]], [[140, 220, 255], [49, 139, 230], [18, 55, 105]]),
    },
    {
      id: 'gamma-ultraviolet', label: 'UV', description: 'Magenta short gamma / ultraviolet long gamma',
      ramp: diverging([[255, 83, 181], [195, 39, 137], [76, 18, 67]], [[209, 173, 255], [128, 76, 231], [54, 30, 106]]),
    },
  ],
  delta: [
    {
      id: 'delta-directional', label: 'Directional', description: 'Red negative delta / electric-blue positive delta',
      ramp: diverging([[255, 93, 85], [210, 52, 52], [91, 27, 31]], [[103, 213, 255], [38, 126, 236], [20, 53, 116]]),
    },
    {
      id: 'delta-ocean', label: 'Ocean', description: 'Bronze negative delta / ocean-cyan positive delta',
      ramp: diverging([[255, 177, 92], [184, 91, 34], [78, 42, 23]], [[94, 255, 242], [24, 170, 193], [10, 66, 91]]),
    },
    {
      id: 'delta-spectrum', label: 'Spectrum', description: 'Fuchsia negative delta / emerald positive delta',
      ramp: diverging([[255, 96, 213], [190, 45, 150], [75, 21, 68]], [[167, 255, 113], [49, 196, 105], [16, 75, 59]]),
    },
  ],
  delta_change: [
    {
      id: 'delta-change-pressure', label: 'Pressure', description: 'Rose sell pressure / cyan buy pressure',
      ramp: diverging([[255, 92, 133], [212, 48, 91], [88, 22, 49]], [[93, 242, 255], [25, 166, 204], [10, 61, 92]]),
    },
    {
      id: 'delta-change-resistance', label: 'Resistance', description: 'Crimson resistance / jade support',
      ramp: diverging([[255, 86, 79], [190, 41, 48], [77, 20, 29]], [[112, 255, 181], [31, 183, 116], [12, 70, 56]]),
    },
    {
      id: 'delta-change-icefire', label: 'Ice / Fire', description: 'Hot-orange negative hedge / cobalt positive hedge',
      ramp: diverging([[255, 149, 61], [226, 72, 26], [91, 31, 20]], [[134, 181, 255], [57, 92, 235], [28, 39, 111]]),
    },
  ],
  charm: [
    {
      id: 'charm-decay', label: 'Decay', description: 'Gold negative decay / violet positive decay',
      ramp: diverging([[255, 214, 89], [212, 133, 30], [82, 49, 19]], [[220, 168, 255], [147, 72, 225], [62, 28, 106]]),
    },
    {
      id: 'charm-dusk', label: 'Dusk', description: 'Rose negative charm / indigo positive charm',
      ramp: diverging([[255, 119, 150], [192, 55, 103], [75, 24, 58]], [[164, 193, 255], [80, 96, 218], [35, 40, 105]]),
    },
    {
      id: 'charm-moss', label: 'Moss', description: 'Copper negative charm / jade positive charm',
      ramp: diverging([[247, 168, 91], [176, 88, 43], [70, 39, 24]], [[132, 255, 189], [40, 174, 115], [14, 66, 52]]),
    },
  ],
  vanna: [
    {
      id: 'vanna-vol-shock', label: 'Vol Shock', description: 'Violet vol-down / cyan vol-up response',
      ramp: diverging([[240, 107, 255], [166, 50, 202], [68, 23, 91]], [[91, 247, 255], [26, 169, 207], [10, 63, 92]]),
    },
    {
      id: 'vanna-macro', label: 'Macro', description: 'Orange downside / blue upside vol response',
      ramp: diverging([[255, 162, 69], [217, 79, 27], [87, 33, 20]], [[111, 205, 255], [44, 118, 229], [23, 48, 111]]),
    },
    {
      id: 'vanna-electric', label: 'Electric', description: 'Hot-pink downside / acid-lime upside response',
      ramp: diverging([[255, 76, 178], [197, 38, 128], [79, 18, 63]], [[202, 255, 105], [104, 212, 53], [37, 81, 24]]),
    },
  ],
}

export const defaultForwardPaletteIds: Record<ForwardGreekMetric, string> = {
  gamma: 'gamma-flow',
  delta: 'delta-directional',
  delta_change: 'delta-change-pressure',
  charm: 'charm-decay',
  vanna: 'vanna-vol-shock',
}

export function resolveForwardGreekPalette(metric: ForwardGreekMetric, id: string): ForwardGreekPalette {
  const palettes = forwardGreekPalettes[metric]
  return palettes.find((palette) => palette.id === id) ?? palettes[0]!
}
