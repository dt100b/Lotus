/**
 * Signed diverging shader for GEX surface field.
 * amount is signed unit GEX in [-1, +1] after client-side maxAbs / KDE normalize.
 */

import {
  contourColorsFromRamp,
  defaultHeatmapIntensity,
  rgbaToCss,
  sampleGammaRamp,
  type GammaStop,
  type Rgba,
} from '@/data/heatmapPalettes'

/** Soft dead-zone so near-zero GEX reads as void. */
const DEAD_ZONE = 0.02

export type GexShaderOptions = {
  ramp: GammaStop[]
  /** 20–100 intensity slider. */
  intensityPct?: number
  isLight?: boolean
}

export type FieldRgba = { r: number; g: number; b: number; a: number }

/**
 * Map raw signed net GEX → unit concentration in [-1, +1].
 */
export function normalizeGexUnit(netGex: number, maxAbs: number): number {
  if (!(maxAbs > 0) || !Number.isFinite(netGex)) return 0
  const unit = netGex / maxAbs
  const mag = Math.min(1, Math.abs(unit))
  if (mag < DEAD_ZONE) return 0
  const gated = (mag - DEAD_ZONE) / (1 - DEAD_ZONE)
  // Mild power — walls bloom without crushing structure.
  return Math.sign(unit) * Math.pow(gated, 0.62)
}

/**
 * Atmospheric underlay colorizer.
 * Peaks stay soft so Hyperliquid OHLC remains the primary read.
 */
export function makeFieldColorizer(options: GexShaderOptions): (amount: number) => FieldRgba {
  const ramp = options.ramp
  const intensity = clamp(
    (Number.isFinite(options.intensityPct) ? options.intensityPct! : defaultHeatmapIntensity) / 100,
    0.2,
    1,
  )
  const isLight = Boolean(options.isLight)

  return (amount: number): FieldRgba => {
    const unit = Number.isFinite(amount) ? Math.max(-1, Math.min(1, amount)) : 0
    const mag = Math.abs(unit)
    if (mag < 1e-4) return { r: 0, g: 0, b: 0, a: 0 }

    const rgb = sampleGammaRamp(unit, ramp)
    // Soft haze: lower floor/peak than a solid heatmap so candles stay crisp.
    // Reference desk opacity sits ~50–65% at walls with near-void mid.
    const shaped = Math.pow(mag, 0.78)
    const floor = isLight ? 0.05 : 0.04
    const peak = isLight ? 0.55 : 0.58
    const alpha = Math.min(0.72, (floor + shaped * (peak - floor)) * (0.42 + intensity * 0.58))
    return { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha }
  }
}

/** CSS string shader (compat). */
export function makeCellShader(options: GexShaderOptions): (amount: number) => string {
  const colorize = makeFieldColorizer(options)
  return (amount: number) => {
    const c = colorize(amount)
    if (c.a < 1e-4) return 'rgba(0,0,0,0)'
    return rgbaToCss({ r: c.r, g: c.g, b: c.b, a: 1 }, c.a)
  }
}

export function makeContourColors(
  ramp: GammaStop[],
  isLight: boolean,
): { pos: string; neg: string; light: string } {
  const fromRamp = contourColorsFromRamp(ramp, isLight)
  const light = isLight
    ? 'rgba(40, 48, 56, 0.32)'
    : 'rgba(230, 236, 245, 0.36)'
  return { ...fromRamp, light }
}

export function sampleContourStroke(
  level: number,
  colors: { pos: string; neg: string; light: string },
  preferLight = true,
): string {
  if (preferLight) return colors.light
  return level >= 0 ? colors.pos : colors.neg
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

export type { Rgba, GammaStop }
