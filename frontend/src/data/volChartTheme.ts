/**
 * Theme-aware colors for Regime IV vs RV / VRP / Z-score charts.
 *
 * Reads live CSS tokens from the active `data-theme` so Graphite / Ember /
 * Original / Paper / Command each keep their own personality — same pattern
 * as GEX chart colors.
 */

import { withAlpha } from '@/data/gexChartColors'

export type VolChartColors = {
  iv: string
  rv: string
  /** Optional BTC price overlay on the visible left scale. */
  spot: string
  /** Family-specific history colors (kept distinct from IV/RV). */
  rvFast: string
  rvSlow: string
  skew1w: string
  skew1m: string
  skew3m: string
  skew6m: string
  term: string
  /** Δ / VRP soft ribbon */
  spreadPosLine: string
  spreadNegLine: string
  spreadPosFill1: string
  spreadPosFill2: string
  spreadNegFill1: string
  spreadNegFill2: string
  /** VRP full-pane ribbon (slightly richer than Δ) */
  ribbonPosLine: string
  ribbonNegLine: string
  ribbonPosFill1: string
  ribbonPosFill2: string
  ribbonNegFill1: string
  ribbonNegFill2: string
  /** Z ribbon fill (soft fade to zero) */
  zPosLine: string
  zNegLine: string
  zPosFill1: string
  zPosFill2: string
  zNegFill1: string
  zNegFill2: string
  /** Guides */
  zero: string
  zZero: string
  bandInner: string
  bandOuter: string
  text: string
  rule: string
  separator: string
  crosshairLabelBg: string
  hoverPos: string
  hoverNeg: string
}

const FALLBACK: VolChartColors = {
  iv: '#4ec4d4',
  rv: '#e0a040',
  spot: '#f2f4f5',
  rvFast: '#3dd6b7',
  rvSlow: '#a78bfa',
  skew1w: '#4f8cff',
  skew1m: '#d477e8',
  skew3m: '#39c4b6',
  skew6m: '#f0a35b',
  term: '#c7a6ff',
  spreadPosLine: '#6b8cae',
  spreadNegLine: '#a67c52',
  spreadPosFill1: 'rgba(107, 140, 174, 0.22)',
  spreadPosFill2: 'rgba(107, 140, 174, 0.02)',
  spreadNegFill1: 'rgba(166, 124, 82, 0.02)',
  spreadNegFill2: 'rgba(166, 124, 82, 0.22)',
  ribbonPosLine: '#6b8cae',
  ribbonNegLine: '#a67c52',
  ribbonPosFill1: 'rgba(107, 140, 174, 0.30)',
  ribbonPosFill2: 'rgba(107, 140, 174, 0.03)',
  ribbonNegFill1: 'rgba(166, 124, 82, 0.03)',
  ribbonNegFill2: 'rgba(166, 124, 82, 0.28)',
  zPosLine: '#6ec8d8',
  zNegLine: '#c4a07a',
  // Stronger at path, nearly clear at zero — clean single gradient
  zPosFill1: 'rgba(90, 190, 210, 0.38)',
  zPosFill2: 'rgba(90, 190, 210, 0.015)',
  zNegFill1: 'rgba(196, 160, 122, 0.015)',
  zNegFill2: 'rgba(196, 160, 122, 0.36)',
  zero: 'rgba(150, 158, 170, 0.22)',
  zZero: 'rgba(140, 148, 160, 0.18)',
  bandInner: 'rgba(150, 165, 180, 0.28)',
  bandOuter: 'rgba(130, 140, 155, 0.18)',
  text: '#8a93a0',
  rule: 'rgba(100, 110, 125, 0.40)',
  separator: 'rgba(160, 168, 180, 0.22)',
  crosshairLabelBg: 'rgba(28, 32, 40, 0.92)',
  hoverPos: '#6ec8d8',
  hoverNeg: '#c4a07a',
}

function css(style: CSSStyleDeclaration, prop: string, fallback: string): string {
  const v = style.getPropertyValue(prop).trim()
  return v || fallback
}

/**
 * Build vol-chart palette from the active theme's CSS tokens.
 * Cool path (IV / pos premium / +z) ↔ warm path (RV / neg premium / −z).
 */
export function readVolChartColors(el?: Element | null): VolChartColors {
  if (typeof window === 'undefined') return FALLBACK
  const style = getComputedStyle(el ?? document.documentElement)

  const blue = css(style, '--terminal-blue', FALLBACK.iv)
  const yellow = css(style, '--terminal-yellow', FALLBACK.rv)
  const green = css(style, '--terminal-green', '#45b99a')
  const red = css(style, '--terminal-red', '#dc5f75')
  const muted = css(style, '--terminal-muted', FALLBACK.text)
  const heading = css(style, '--terminal-heading', '#f5f8f9')
  const surface = css(style, '--terminal-surface', 'rgb(16, 21, 26)')
  const rule = css(style, '--desk-rule', FALLBACK.rule)
  const chartPos = css(style, '--chart-positive', green)
  const chartNeg = css(style, '--chart-negative', red)

  // IV cool, RV warm — always legible against the desk.
  const iv = withAlpha(blue, 0.92) === blue ? blue : blue
  const rv = yellow
  const rvFast = css(style, '--regime-rv-fast', FALLBACK.rvFast)
  const rvSlow = css(style, '--regime-rv-slow', FALLBACK.rvSlow)
  const skew1w = css(style, '--regime-skew-1w', FALLBACK.skew1w)
  const skew1m = css(style, '--regime-skew-1m', FALLBACK.skew1m)
  const skew3m = css(style, '--regime-skew-3m', FALLBACK.skew3m)
  const skew6m = css(style, '--regime-skew-6m', FALLBACK.skew6m)
  const term = css(style, '--regime-term-line', FALLBACK.term)

  // Spread / VRP: cool premium / warm discount
  const pos = blue
  const neg = mixWarm(yellow, red)

  // Z body: cooler cyan-teal / warm sand from theme
  const zPos = mixCool(blue, chartPos)
  const zNeg = mixWarm(yellow, chartNeg)

  return {
    iv,
    rv,
    spot: withAlpha(heading, 0.94),
    rvFast,
    rvSlow,
    skew1w,
    skew1m,
    skew3m,
    skew6m,
    term,
    spreadPosLine: withAlpha(pos, 0.88),
    spreadNegLine: withAlpha(neg, 0.88),
    spreadPosFill1: withAlpha(pos, 0.24),
    spreadPosFill2: withAlpha(pos, 0.02),
    spreadNegFill1: withAlpha(neg, 0.02),
    spreadNegFill2: withAlpha(neg, 0.24),

    ribbonPosLine: withAlpha(pos, 0.95),
    ribbonNegLine: withAlpha(neg, 0.95),
    ribbonPosFill1: withAlpha(pos, 0.32),
    ribbonPosFill2: withAlpha(pos, 0.03),
    ribbonNegFill1: withAlpha(neg, 0.03),
    ribbonNegFill2: withAlpha(neg, 0.30),

    zPosLine: withAlpha(zPos, 0.95),
    zNegLine: withAlpha(zNeg, 0.92),
    // Clean single gradient: richer at path, nearly clear at zero
    zPosFill1: withAlpha(zPos, 0.38),
    zPosFill2: withAlpha(zPos, 0.015),
    zNegFill1: withAlpha(zNeg, 0.015),
    zNegFill2: withAlpha(zNeg, 0.36),

    // Dim zero shared across VRP / Z (and available for other guides)
    zero: withAlpha(heading, 0.20),
    zZero: withAlpha(heading, 0.16),
    bandInner: withAlpha(muted, 0.28),
    bandOuter: withAlpha(muted, 0.18),
    text: muted,
    rule: rule.includes('rgb') ? rule : FALLBACK.rule,
    separator: withAlpha(muted, 0.25),
    crosshairLabelBg: surface.includes('rgb')
      ? withAlpha(surface, 0.92)
      : FALLBACK.crosshairLabelBg,
    hoverPos: zPos,
    hoverNeg: zNeg,
  }
}

function mixCool(a: string, b: string): string {
  // Prefer blue for "cool path"; fall back to chart positive if blue missing.
  return a || b
}

function mixWarm(a: string, b: string): string {
  // Warm path leans yellow then red for discount / cheap.
  return a || b
}
