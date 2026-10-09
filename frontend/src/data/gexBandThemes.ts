/**
 * GEX bands + strike-line color themes (bands chart underlay).
 *
 * Themes only change presentation chroma for long/short gamma fills,
 * matching hairlines, and Field HD mist voids — not GEX values/rankings.
 *
 * Design bar: Desk is the reference balance (calm under candles). Other
 * themes stay desk-quiet — no neon peaks that fight OHLC.
 */

export type Rgb = { r: number; g: number; b: number }

/** Keep the Price/GEX overlay aligned with the Gamma charts' shared themes. */
export const gexBandThemeIds = ['gamma-flow', 'gamma-thermal', 'gamma-ultraviolet'] as const
export type GexBandThemeId = (typeof gexBandThemeIds)[number]

export const defaultGexBandThemeId: GexBandThemeId = 'gamma-flow'

/**
 * Price/GEX exposes the terraced Bands treatment only. `field` remains an
 * internal paint-path id for backwards-compatible primitive data, but is not a
 * selectable product mode.
 */
export const gexBandRenderModeIds = ['classic'] as const
export type GexBandRenderModeId = 'classic' | 'field'

export const defaultGexBandRenderModeId: GexBandRenderModeId = 'classic'

export type GexBandRenderModeMeta = {
  id: GexBandRenderModeId
  label: string
  description: string
}

export const gexBandRenderModes: Record<(typeof gexBandRenderModeIds)[number], GexBandRenderModeMeta> = {
  classic: {
    id: 'classic',
    label: 'Bands',
    description: 'Soft strike ridges with terraced bands',
  },
}

export function isGexBandRenderModeId(
  value: unknown,
): value is (typeof gexBandRenderModeIds)[number] {
  return typeof value === 'string' && (gexBandRenderModeIds as readonly string[]).includes(value)
}

export function getGexBandRenderMode(
  id: GexBandRenderModeId | string | null | undefined,
): GexBandRenderModeMeta {
  if (id && isGexBandRenderModeId(id)) return gexBandRenderModes[id]
  return gexBandRenderModes.classic
}

/**
 * How Field mode paints low-|GEX| voids (Classic ignores this).
 * Product default is mist; empty remains for internal/legacy paint paths.
 */
export const gexBandVoidStyleIds = ['empty', 'mist'] as const
export type GexBandVoidStyleId = (typeof gexBandVoidStyleIds)[number]

/** Field mode always uses mist voids (no menu toggle). */
export const defaultGexBandVoidStyleId: GexBandVoidStyleId = 'mist'

export type GexBandVoidStyleMeta = {
  id: GexBandVoidStyleId
  label: string
  description: string
}

export const gexBandVoidStyles: Record<GexBandVoidStyleId, GexBandVoidStyleMeta> = {
  empty: {
    id: 'empty',
    label: 'Empty',
    description: 'Near-black voids — honest low-GEX (default)',
  },
  mist: {
    id: 'mist',
    label: 'Mist',
    description: 'Ice void veil with black seams — strength tracks GEX opacity',
  },
}

export function isGexBandVoidStyleId(value: unknown): value is GexBandVoidStyleId {
  return typeof value === 'string' && (gexBandVoidStyleIds as readonly string[]).includes(value)
}

export function getGexBandVoidStyle(
  id: GexBandVoidStyleId | string | null | undefined,
): GexBandVoidStyleMeta {
  // Retired: zero-ridge → empty
  if (id === 'ridge') return gexBandVoidStyles.empty
  if (id && isGexBandVoidStyleId(id)) return gexBandVoidStyles[id]
  return gexBandVoidStyles[defaultGexBandVoidStyleId]
}

/**
 * Mist fill strength tracks the main GEX opacity slider (0…100).
 * Desk-default GEX (~50) maps to full mist (former 100% mist slider);
 * lowering GEX quiets zones and voids together; raising GEX past 50
 * keeps mist at full while walls densify further.
 * No independent mist control.
 */
export function gexMistOpacityFromGex(gexOpacityPct: number): number {
  if (!Number.isFinite(gexOpacityPct)) return 1
  // 50% GEX → 1.0 mist; 25% → 0.5; 100% stays capped at 1.0
  return Math.min(1, Math.max(0, (gexOpacityPct / 100) * 2))
}

export type GexBandTheme = {
  id: string
  label: string
  /** Short blurb for overlay menu. */
  description: string
  /** Soft mid chroma → peak wall chroma for long (+GEX). */
  longMid: Rgb
  longPeak: Rgb
  /** Soft mid chroma → peak wall chroma for short (−GEX). */
  shortMid: Rgb
  shortPeak: Rgb
  /** Quiet contour ridge on strong levels. */
  contourLong: Rgb
  contourShort: Rgb
  /** Brighter hairline / axis accents for strike lines. */
  lineLong: Rgb
  lineShort: Rgb
  /** Field HD mist void core (light end). */
  mistCore: Rgb
  /** Field HD mist void edge (before diffusion into structure). */
  mistEdge: Rgb
  /** Swatch pair for the picker (CSS). */
  swatchLong: string
  swatchShort: string
}

/**
 * Desk-quiet themes only. Peaks stay muted enough that candles remain primary.
 * Each theme carries its own mist palette for Field HD voids.
 */
export const gexBandThemes: Record<GexBandThemeId, GexBandTheme> = {
  'gamma-flow': {
    id: 'gamma-flow',
    label: 'Flow',
    description: 'Coral short gamma · liquid-teal long gamma',
    longMid: { r: 10, g: 71, b: 74 },
    longPeak: { r: 25, g: 191, b: 178 },
    shortMid: { r: 83, g: 20, b: 52 },
    shortPeak: { r: 205, g: 39, b: 92 },
    contourLong: { r: 25, g: 191, b: 178 },
    contourShort: { r: 205, g: 39, b: 92 },
    lineLong: { r: 94, g: 255, b: 232 },
    lineShort: { r: 255, g: 74, b: 125 },
    mistCore: { r: 224, g: 247, b: 245 },
    mistEdge: { r: 124, g: 184, b: 182 },
    swatchLong: '#19bfb2',
    swatchShort: '#cd275c',
  },
  'gamma-thermal': {
    id: 'gamma-thermal',
    label: 'Thermal',
    description: 'Amber short gamma · glacial-blue long gamma',
    longMid: { r: 18, g: 55, b: 105 },
    longPeak: { r: 49, g: 139, b: 230 },
    shortMid: { r: 91, g: 41, b: 18 },
    shortPeak: { r: 223, g: 106, b: 25 },
    contourLong: { r: 49, g: 139, b: 230 },
    contourShort: { r: 223, g: 106, b: 25 },
    lineLong: { r: 140, g: 220, b: 255 },
    lineShort: { r: 255, g: 190, b: 66 },
    mistCore: { r: 232, g: 243, b: 252 },
    mistEdge: { r: 150, g: 183, b: 215 },
    swatchLong: '#318be6',
    swatchShort: '#df6a19',
  },
  'gamma-ultraviolet': {
    id: 'gamma-ultraviolet',
    label: 'UV',
    description: 'Magenta short gamma · ultraviolet long gamma',
    longMid: { r: 54, g: 30, b: 106 },
    longPeak: { r: 128, g: 76, b: 231 },
    shortMid: { r: 76, g: 18, b: 67 },
    shortPeak: { r: 195, g: 39, b: 137 },
    contourLong: { r: 128, g: 76, b: 231 },
    contourShort: { r: 195, g: 39, b: 137 },
    lineLong: { r: 209, g: 173, b: 255 },
    lineShort: { r: 255, g: 83, b: 181 },
    mistCore: { r: 240, g: 232, b: 250 },
    mistEdge: { r: 176, g: 150, b: 210 },
    swatchLong: '#804ce7',
    swatchShort: '#c32789',
  },
}

/**
 * Price/GEX band chroma is intentionally independent from selectable line
 * themes. This keeps band context stable while Flow / Thermal / UV recolor the
 * precision lines only.
 */
export const priceGexBandTheme: GexBandTheme = {
  id: 'price-gex-bands',
  label: 'Bands',
  description: 'Quiet ocean long gamma · muted plum short gamma',
  longMid: { r: 10, g: 34, b: 42 },
  longPeak: { r: 30, g: 116, b: 126 },
  shortMid: { r: 48, g: 22, b: 44 },
  shortPeak: { r: 126, g: 48, b: 92 },
  contourLong: { r: 54, g: 142, b: 150 },
  contourShort: { r: 150, g: 70, b: 112 },
  lineLong: { r: 86, g: 178, b: 184 },
  lineShort: { r: 190, g: 94, b: 140 },
  mistCore: { r: 226, g: 240, b: 242 },
  mistEdge: { r: 142, g: 178, b: 184 },
  swatchLong: '#1e747e',
  swatchShort: '#7e305c',
}

export function isGexBandThemeId(value: unknown): value is GexBandThemeId {
  return typeof value === 'string' && (gexBandThemeIds as readonly string[]).includes(value)
}

export function getGexBandTheme(id: GexBandThemeId | string | null | undefined): GexBandTheme {
  if (id && isGexBandThemeId(id)) return gexBandThemes[id]
  return gexBandThemes[defaultGexBandThemeId]
}

/** Mist palette derived from the active band theme (void style = Mist). */
export type GexBandMistPalette = {
  core: Rgb
  edge: Rgb
}

export function getThemeMistPalette(theme: GexBandTheme | GexBandThemeId): GexBandMistPalette {
  const t = typeof theme === 'string' ? getGexBandTheme(theme) : theme
  return { core: t.mistCore, edge: t.mistEdge }
}

export function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const u = Math.min(1, Math.max(0, t))
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
  }
}

export function rgbToCss(c: Rgb, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha))
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a.toFixed(3)})`
}
