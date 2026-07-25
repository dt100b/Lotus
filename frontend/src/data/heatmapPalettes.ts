/** Heatmap surface color templates (diverging: negative → mid → positive).
 *
 * Convention (desk readability):
 * - Positive GEX → cool / constructive hues (green, blue, cyan, purple)
 * - Negative GEX → warm / risk hues (red, pink, orange, amber)
 * - Mid (0) → near-void so walls read as luminous ridges
 */

/** Order matches recommended picker order (see heatmapPalettes). */
export const heatmapPaletteIds = [
  'violet',
  'theme',
  'pulse',
  'thermal',
  'aurora',
  'jade',
  'ember',
] as const
export type HeatmapPaletteId = (typeof heatmapPaletteIds)[number]

/** Default TRACE look — pink short-gamma / purple long-gamma. */
export const defaultHeatmapPaletteId: HeatmapPaletteId = 'violet'

export type HeatmapPaletteMeta = {
  id: HeatmapPaletteId
  /** Accessible name (not shown in the strip control). */
  label: string
  description: string
}

/** Recommended picker order: signature default first, then desk-coherent → character. */
export const heatmapPalettes: HeatmapPaletteMeta[] = [
  {
    id: 'violet',
    label: 'Violet',
    description: 'Pink short-gamma → void → luminous purple long-gamma (default)',
  },
  {
    id: 'theme',
    label: 'Theme',
    description: 'Follows the active terminal theme green/red chart tokens',
  },
  {
    id: 'pulse',
    label: 'Pulse',
    description: 'Hot pink short-gamma → void → toxic lime long-gamma',
  },
  {
    id: 'thermal',
    label: 'Thermal',
    description: 'Amber short-gamma → void → cool blue long-gamma',
  },
  {
    id: 'aurora',
    label: 'Aurora',
    description: 'Rose short-gamma → void → glacial teal / cyan long-gamma',
  },
  {
    id: 'jade',
    label: 'Jade',
    description: 'Copper / rust short-gamma → void → deep emerald jade long-gamma',
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Deep ember red short-gamma → void → steel cyan long-gamma',
  },
]

export type Rgba = { r: number; g: number; b: number; a: number }
export type GammaStop = { t: number; c: Rgba }

/** Fixed template ramps (signed unit domain −1…+1). Left = negative, right = positive. */
const fixedRamps: Record<Exclude<HeatmapPaletteId, 'theme'>, GammaStop[]> = {
  // Negative: pink / magenta · Positive: deep → bright violet
  violet: [
    { t: -1.0, c: { r: 255, g: 72, b: 160, a: 1 } },
    { t: -0.65, c: { r: 210, g: 48, b: 120, a: 1 } },
    { t: -0.3, c: { r: 90, g: 22, b: 58, a: 1 } },
    { t: 0.0, c: { r: 12, g: 10, b: 18, a: 1 } },
    { t: 0.28, c: { r: 48, g: 22, b: 88, a: 1 } },
    { t: 0.55, c: { r: 88, g: 42, b: 168, a: 1 } },
    { t: 0.8, c: { r: 140, g: 88, b: 230, a: 1 } },
    { t: 1.0, c: { r: 188, g: 150, b: 255, a: 1 } },
  ],
  // Negative: orange / amber · Positive: cool blue
  thermal: [
    { t: -1.0, c: { r: 255, g: 196, b: 72, a: 1 } },
    { t: -0.62, c: { r: 236, g: 132, b: 28, a: 1 } },
    { t: -0.28, c: { r: 120, g: 48, b: 18, a: 1 } },
    { t: 0.0, c: { r: 14, g: 12, b: 16, a: 1 } },
    { t: 0.28, c: { r: 22, g: 48, b: 96, a: 1 } },
    { t: 0.55, c: { r: 36, g: 98, b: 176, a: 1 } },
    { t: 0.82, c: { r: 64, g: 148, b: 230, a: 1 } },
    { t: 1.0, c: { r: 120, g: 200, b: 255, a: 1 } },
  ],
  // Negative: hot pink · Positive: toxic lime (unchanged, already matches convention)
  pulse: [
    { t: -1.0, c: { r: 255, g: 45, b: 120, a: 1 } },
    { t: -0.62, c: { r: 196, g: 28, b: 96, a: 1 } },
    { t: -0.3, c: { r: 88, g: 16, b: 48, a: 1 } },
    { t: 0.0, c: { r: 10, g: 11, b: 14, a: 1 } },
    { t: 0.3, c: { r: 24, g: 72, b: 28, a: 1 } },
    { t: 0.58, c: { r: 56, g: 196, b: 48, a: 1 } },
    { t: 0.82, c: { r: 120, g: 255, b: 64, a: 1 } },
    { t: 1.0, c: { r: 196, g: 255, b: 120, a: 1 } },
  ],
  // Negative: soft rose · Positive: glacial teal / cyan
  aurora: [
    { t: -1.0, c: { r: 255, g: 96, b: 140, a: 1 } },
    { t: -0.62, c: { r: 200, g: 48, b: 96, a: 1 } },
    { t: -0.28, c: { r: 72, g: 20, b: 42, a: 1 } },
    { t: 0.0, c: { r: 8, g: 12, b: 16, a: 1 } },
    { t: 0.28, c: { r: 12, g: 56, b: 62, a: 1 } },
    { t: 0.55, c: { r: 18, g: 140, b: 148, a: 1 } },
    { t: 0.8, c: { r: 48, g: 220, b: 200, a: 1 } },
    { t: 1.0, c: { r: 140, g: 255, b: 230, a: 1 } },
  ],
  // Negative: deep ember / blood · Positive: cold steel cyan
  ember: [
    { t: -1.0, c: { r: 255, g: 72, b: 48, a: 1 } },
    { t: -0.62, c: { r: 196, g: 36, b: 28, a: 1 } },
    { t: -0.28, c: { r: 72, g: 18, b: 16, a: 1 } },
    { t: 0.0, c: { r: 10, g: 10, b: 12, a: 1 } },
    { t: 0.28, c: { r: 14, g: 42, b: 58, a: 1 } },
    { t: 0.55, c: { r: 28, g: 120, b: 160, a: 1 } },
    { t: 0.8, c: { r: 64, g: 196, b: 220, a: 1 } },
    { t: 1.0, c: { r: 160, g: 240, b: 255, a: 1 } },
  ],
  // Negative: copper / rust · Positive: deep emerald → luminous jade
  jade: [
    { t: -1.0, c: { r: 220, g: 96, b: 48, a: 1 } },
    { t: -0.62, c: { r: 168, g: 64, b: 36, a: 1 } },
    { t: -0.28, c: { r: 72, g: 28, b: 20, a: 1 } },
    { t: 0.0, c: { r: 8, g: 12, b: 10, a: 1 } },
    { t: 0.28, c: { r: 12, g: 48, b: 32, a: 1 } },
    { t: 0.55, c: { r: 18, g: 128, b: 78, a: 1 } },
    { t: 0.8, c: { r: 36, g: 200, b: 120, a: 1 } },
    { t: 1.0, c: { r: 96, g: 255, b: 168, a: 1 } },
  ],
}

/**
 * Preview strips (left = negative, right = positive).
 * Hard end-stops keep corner anti-aliasing from blending opposite ramp colors.
 */
const fixedPreviewCss: Record<Exclude<HeatmapPaletteId, 'theme'>, string> = {
  violet:
    'linear-gradient(90deg, #ff48a0 0%, #ff48a0 2%, #d23078 18%, #5a163a 40%, #0c0a12 50%, #582aa8 72%, #bc96ff 98%, #bc96ff 100%)',
  thermal:
    'linear-gradient(90deg, #ffc448 0%, #ffc448 2%, #ec841c 20%, #783012 40%, #0e0c10 50%, #2462b0 72%, #78c8ff 98%, #78c8ff 100%)',
  pulse:
    'linear-gradient(90deg, #ff2d78 0%, #ff2d78 2%, #c41c60 20%, #581030 40%, #0a0b0e 50%, #38c430 72%, #78ff40 98%, #c4ff78 100%)',
  aurora:
    'linear-gradient(90deg, #ff608c 0%, #ff608c 2%, #c83060 20%, #48142a 40%, #080c10 50%, #128c94 72%, #30dcc8 98%, #8cffe6 100%)',
  ember:
    'linear-gradient(90deg, #ff4830 0%, #ff4830 2%, #c4241c 20%, #481210 40%, #0a0a0c 50%, #1c78a0 72%, #40c4dc 98%, #a0f0ff 100%)',
  jade:
    'linear-gradient(90deg, #dc6030 0%, #dc6030 2%, #a84024 20%, #481c14 40%, #080c0a 50%, #12804e 72%, #24c878 98%, #60ffa8 100%)',
}

export function isHeatmapPaletteId(value: string | null | undefined): value is HeatmapPaletteId {
  return value !== null && value !== undefined && (heatmapPaletteIds as readonly string[]).includes(value)
}

export function getFixedGammaRamp(id: Exclude<HeatmapPaletteId, 'theme'>): GammaStop[] {
  return fixedRamps[id]
}

export function getHeatmapPalettePreviewCss(
  id: HeatmapPaletteId,
  themePreviewCss?: string,
): string {
  if (id === 'theme') {
    return (
      themePreviewCss
      ?? 'linear-gradient(90deg, var(--chart-negative-edge) 0%, var(--chart-negative-edge) 2%, var(--chart-negative) 22%, var(--terminal-surface) 50%, var(--chart-positive) 78%, var(--chart-positive-edge) 98%, var(--chart-positive-edge) 100%)'
    )
  }
  return fixedPreviewCss[id]
}

export function buildThemeGammaRamp(tokens: {
  positive: Rgba
  positiveEdge: Rgba
  positiveStart: Rgba
  negative: Rgba
  negativeEdge: Rgba
  negativeEnd: Rgba
  surface: Rgba
  isLight: boolean
}): GammaStop[] {
  const { positive, positiveEdge, positiveStart, negative, negativeEdge, negativeEnd, surface, isLight } = tokens
  const mid = isLight
    ? mixRgb(surface, { r: 255, g: 252, b: 245, a: 1 }, 0.55)
    : mixRgb(surface, { r: 8, g: 8, b: 12, a: 1 }, 0.72)

  const deepNeg = mixRgb(negativeEnd, { r: 20, g: 10, b: 28, a: 1 }, isLight ? 0.15 : 0.35)
  const deepPos = mixRgb(positiveStart, mid, isLight ? 0.2 : 0.25)

  return [
    { t: -1.0, c: negativeEdge },
    { t: -0.62, c: negative },
    { t: -0.32, c: deepNeg },
    { t: 0.0, c: mid },
    { t: 0.28, c: deepPos },
    { t: 0.58, c: positive },
    { t: 1.0, c: positiveEdge },
  ]
}

export function resolveHeatmapGammaRamp(
  paletteId: HeatmapPaletteId,
  themeTokens: {
    positive: Rgba
    positiveEdge: Rgba
    positiveStart: Rgba
    negative: Rgba
    negativeEdge: Rgba
    negativeEnd: Rgba
    surface: Rgba
    isLight: boolean
  },
): GammaStop[] {
  if (paletteId === 'theme') {
    return buildThemeGammaRamp(themeTokens)
  }
  return getFixedGammaRamp(paletteId)
}

/** Sample a diverging gamma ramp at signed unit t ∈ [−1, +1]. */
export function sampleGammaRamp(t: number, ramp: GammaStop[]): Rgba {
  const v = Math.max(-1, Math.min(1, t))
  if (ramp.length === 0) return { r: 128, g: 128, b: 128, a: 1 }
  if (v <= ramp[0]!.t) return ramp[0]!.c
  if (v >= ramp[ramp.length - 1]!.t) return ramp[ramp.length - 1]!.c

  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i]!
    const b = ramp[i + 1]!
    if (v >= a.t && v <= b.t) {
      const u = (v - a.t) / (b.t - a.t || 1)
      return {
        r: Math.round(a.c.r + (b.c.r - a.c.r) * u),
        g: Math.round(a.c.g + (b.c.g - a.c.g) * u),
        b: Math.round(a.c.b + (b.c.b - a.c.b) * u),
        a: 1,
      }
    }
  }
  return ramp[ramp.length - 1]!.c
}

/** CSS color string for a sampled ramp stop. */
export function rgbaToCss(c: Rgba, alpha = 1): string {
  if (alpha >= 1) return `rgb(${c.r}, ${c.g}, ${c.b})`
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`
}

/** Contour stroke colors derived from ramp ends (TRACE ridge outlines). */
export function contourColorsFromRamp(ramp: GammaStop[], isLight: boolean): { pos: string; neg: string } {
  const neg = ramp[0]?.c ?? { r: 120, g: 80, b: 180, a: 1 }
  const pos = ramp[ramp.length - 1]?.c ?? { r: 255, g: 120, b: 180, a: 1 }
  // Slightly higher presence so isolines read over the soft bloom layer
  const alphaPos = isLight ? 0.42 : 0.34
  const alphaNeg = isLight ? 0.38 : 0.3
  return {
    pos: `rgba(${pos.r}, ${pos.g}, ${pos.b}, ${alphaPos})`,
    neg: `rgba(${neg.r}, ${neg.g}, ${neg.b}, ${alphaNeg})`,
  }
}

function mixRgb(a: Rgba, b: Rgba, t: number): Rgba {
  const u = Math.max(0, Math.min(1, t))
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
    a: 1,
  }
}

const heatmapPaletteStorageKey = 'lotus-heatmap-palette'
const heatmapIntensityStorageKey = 'lotus-heatmap-intensity'

/** Default TRACE opacity (~matches the softened base after OHLC readability pass). */
export const defaultHeatmapIntensity = 80
export const minHeatmapIntensity = 20
export const maxHeatmapIntensity = 100

export function clampHeatmapIntensity(value: number): number {
  if (!Number.isFinite(value)) return defaultHeatmapIntensity
  return Math.min(maxHeatmapIntensity, Math.max(minHeatmapIntensity, Math.round(value)))
}

export function getStoredHeatmapPaletteId(): HeatmapPaletteId {
  if (typeof window === 'undefined') {
    return defaultHeatmapPaletteId
  }

  try {
    const stored = window.localStorage.getItem(heatmapPaletteStorageKey)
    // Retired templates
    if (stored === 'ion') return 'pulse'
    if (stored === 'volt') return 'jade'
    return isHeatmapPaletteId(stored) ? stored : defaultHeatmapPaletteId
  } catch {
    return defaultHeatmapPaletteId
  }
}

export function persistHeatmapPaletteId(palette: HeatmapPaletteId) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(heatmapPaletteStorageKey, palette)
  } catch {
    // Ignore storage errors so the control still works in-memory.
  }
}

export function getStoredHeatmapIntensity(): number {
  if (typeof window === 'undefined') {
    return defaultHeatmapIntensity
  }

  try {
    const raw = window.localStorage.getItem(heatmapIntensityStorageKey)
    if (raw == null) return defaultHeatmapIntensity
    return clampHeatmapIntensity(Number(raw))
  } catch {
    return defaultHeatmapIntensity
  }
}

export function persistHeatmapIntensity(intensity: number) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(heatmapIntensityStorageKey, String(clampHeatmapIntensity(intensity)))
  } catch {
    // Ignore storage errors so the control still works in-memory.
  }
}
