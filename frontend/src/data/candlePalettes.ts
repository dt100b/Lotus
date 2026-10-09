export type CandlePaletteId = 'flow' | 'copper' | 'volt' | 'mono'

export type CandlePalette = {
  id: CandlePaletteId
  label: string
  description: string
  up: string
  down: string
  borderUp: string
  borderDown: string
  wickUp: string
  wickDown: string
}

/** Shared OHLC themes for Price/GEX and forward Greek surfaces. */
export const candlePalettes: CandlePalette[] = [
  {
    id: 'flow',
    label: 'Flow',
    description: 'Liquid teal · coral',
    up: '#20c7b7',
    down: '#f45d78',
    borderUp: '#67eadb',
    borderDown: '#ff8a9d',
    wickUp: '#42d8c9',
    wickDown: '#ff7188',
  },
  {
    id: 'copper',
    label: 'Copper',
    description: 'Pale sand · burnished rust',
    up: '#d6c39a',
    down: '#a6533f',
    borderUp: '#f0dfb8',
    borderDown: '#d17a60',
    wickUp: '#dfcda7',
    wickDown: '#bc634c',
  },
  {
    id: 'volt',
    label: 'Volt',
    description: 'Acid lime · deep cobalt',
    up: '#b7f36b',
    down: '#4263eb',
    borderUp: '#d6ff9d',
    borderDown: '#7890ff',
    wickUp: '#c5f982',
    wickDown: '#5f7bf5',
  },
  {
    id: 'mono',
    label: 'Mono',
    description: 'White · graphite',
    up: '#e9edf2',
    down: '#747c87',
    borderUp: '#ffffff',
    borderDown: '#a9b0ba',
    wickUp: '#d7dce3',
    wickDown: '#8d96a2',
  },
]

export const defaultCandlePaletteId: CandlePaletteId = 'flow'

export function getCandlePalette(id: CandlePaletteId | string | null | undefined): CandlePalette {
  return candlePalettes.find((palette) => palette.id === id) ?? candlePalettes[0]!
}
