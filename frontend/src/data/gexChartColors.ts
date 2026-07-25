/**
 * GEX chart color helpers.
 *
 * Bar / profile polarity colors come from theme CSS tokens
 * (`--chart-positive*`, `--chart-negative*`) so each terminal theme keeps
 * its own personality. Spot is a single universal champagne gold so the
 * live index always reads the same across themes.
 */

/** Universal spot / live-index marker — same on every theme. */
export const UNIVERSAL_SPOT = {
  /** Solid label text / tick */
  solid: '#c9a84c',
  /** Hairline dashed stroke over the plot */
  line: 'rgba(201, 168, 76, 0.52)',
  /** Soft bloom behind the line (kept very quiet) */
  glow: 'rgba(201, 168, 76, 0.08)',
  /** Label surface */
  labelBg: 'rgba(12, 14, 16, 0.88)',
  labelBorder: 'rgba(201, 168, 76, 0.28)',
} as const

export type GexSeriesColors = {
  positive: string
  positiveEdge: string
  negative: string
  negativeEdge: string
  positiveSoft: string
  positiveSofter: string
  negativeSoft: string
  negativeSofter: string
  zero: string
  text: string
  crosshair: string
  crosshairLabelBg: string
}

const FALLBACK: GexSeriesColors = {
  positive: '#3da889',
  positiveEdge: '#67e2c1',
  negative: '#c94f63',
  negativeEdge: '#ff7387',
  positiveSoft: 'rgba(61, 168, 137, 0.28)',
  positiveSofter: 'rgba(61, 168, 137, 0.06)',
  negativeSoft: 'rgba(201, 79, 99, 0.28)',
  negativeSofter: 'rgba(201, 79, 99, 0.06)',
  zero: 'rgba(240, 241, 235, 0.28)',
  text: '#b0b8b2',
  crosshair: 'rgba(140, 150, 160, 0.40)',
  crosshairLabelBg: 'rgba(18, 22, 28, 0.94)',
}

/** Read live theme tokens from an element (or document root). */
export function readGexSeriesColors(el?: Element | null): GexSeriesColors {
  if (typeof window === 'undefined') return FALLBACK
  const style = getComputedStyle(el ?? document.documentElement)
  const pos = css(style, '--chart-positive', FALLBACK.positive)
  const posEdge = css(style, '--chart-positive-edge', FALLBACK.positiveEdge)
  const neg = css(style, '--chart-negative', FALLBACK.negative)
  const negEdge = css(style, '--chart-negative-edge', FALLBACK.negativeEdge)
  const zero = css(style, '--chart-zero-line', FALLBACK.zero)
  const text = css(style, '--terminal-muted', FALLBACK.text)
  const surface = css(style, '--terminal-surface', 'rgb(18, 22, 28)')

  return {
    positive: pos,
    positiveEdge: posEdge,
    negative: neg,
    negativeEdge: negEdge,
    // Keep fills clearly visible (too-low alpha looked like “fill vanished”).
    positiveSoft: withAlpha(pos, 0.36),
    positiveSofter: withAlpha(pos, 0.10),
    negativeSoft: withAlpha(neg, 0.36),
    negativeSofter: withAlpha(neg, 0.10),
    zero: zero.includes('rgba') || zero.includes('rgb') ? zero : withAlpha(zero, 0.28),
    text,
    crosshair: FALLBACK.crosshair,
    crosshairLabelBg: surface.includes('rgb')
      ? surface.replace(/rgba?\(([^)]+)\)/, (_, body: string) => {
          const parts = body.split(',').map((p) => p.trim())
          if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, 0.94)`
          return FALLBACK.crosshairLabelBg
        })
      : FALLBACK.crosshairLabelBg,
  }
}

/**
 * Magnitude-aware bar color — sign sets hue, |gex|/max sets opacity.
 * Floor keeps near-zero bars readable; ceiling stays calm (not neon).
 */
export function magnitudeBarColor(
  value: number,
  maxAbs: number,
  colors: GexSeriesColors,
): string {
  const base = value >= 0 ? colors.positive : colors.negative
  const edge = value >= 0 ? colors.positiveEdge : colors.negativeEdge
  const peak = maxAbs > 0 ? maxAbs : 1
  const t = Math.min(1, Math.abs(value) / peak)
  // Gentle ease — walls bloom, mid levels stay soft.
  const eased = t * t * (3 - 2 * t) // smoothstep
  // Alpha 0.38 … 0.88 — never washed out, never screaming.
  const alpha = 0.38 + 0.50 * eased
  // Mix a touch of edge at high magnitude for a subtle “wall” highlight.
  const mixed = eased > 0.72 ? mixHex(base, edge, (eased - 0.72) / 0.28 * 0.35) : base
  return withAlpha(mixed, alpha)
}

/** Split signed legs into positive / negative GEX that sum to net. */
export function splitPositiveNegativeGex(
  callGexUsd: number,
  putGexUsd: number,
  netGexUsd: number,
): { positiveGexUsd: number; negativeGexUsd: number; netGexUsd: number } {
  let positiveGexUsd = 0
  let negativeGexUsd = 0
  for (const leg of [callGexUsd, putGexUsd]) {
    if (!(Number.isFinite(leg))) continue
    if (leg > 0) positiveGexUsd += leg
    else if (leg < 0) negativeGexUsd += leg
  }
  // Fallback when call/put are absent or zero but net is populated.
  if (positiveGexUsd === 0 && negativeGexUsd === 0 && Number.isFinite(netGexUsd) && netGexUsd !== 0) {
    if (netGexUsd > 0) positiveGexUsd = netGexUsd
    else negativeGexUsd = netGexUsd
  }
  const composed = positiveGexUsd + negativeGexUsd
  return {
    positiveGexUsd,
    negativeGexUsd,
    netGexUsd: composed !== 0 || netGexUsd === 0 ? composed : netGexUsd,
  }
}

function css(style: CSSStyleDeclaration, prop: string, fallback: string): string {
  const v = style.getPropertyValue(prop).trim()
  return v || fallback
}

/** Apply alpha to #rgb / #rrggbb / rgb() / rgba() / named-ish hex. */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha))
  const hex = parseHex(color)
  if (hex) return `rgba(${hex.r}, ${hex.g}, ${hex.b}, ${a})`
  const rgb = color.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i,
  )
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`
  }
  return color
}

function parseHex(color: string): { r: number; g: number; b: number } | null {
  const raw = color.trim()
  if (!raw.startsWith('#')) return null
  let h = raw.slice(1)
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('')
  }
  if (h.length !== 6) return null
  const n = Number.parseInt(h, 16)
  if (!Number.isFinite(n)) return null
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function mixHex(a: string, b: string, t: number): string {
  const A = parseHex(a)
  const B = parseHex(b)
  if (!A || !B) return a
  const u = Math.max(0, Math.min(1, t))
  const r = Math.round(A.r + (B.r - A.r) * u)
  const g = Math.round(A.g + (B.g - A.g) * u)
  const bl = Math.round(A.b + (B.b - A.b) * u)
  return `#${[r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
