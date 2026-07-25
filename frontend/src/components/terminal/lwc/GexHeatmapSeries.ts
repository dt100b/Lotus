/**
 * GEX surface underlay for Lightweight Charts v5.
 *
 * Design (desk gamma surface, not a cell heatmap):
 *  1. On data/options change → bake a low-res KDE texture once (time × price).
 *  2. On every frame → O(1) viewport blit only (no per-frame blur / field rebuild).
 *  3. Candles own the chart; this series is a soft overlay that never drives scale.
 *
 * Visual model: each strike deposits a gaussian kernel in price; samples blend in
 * time. Result is soft atmospheric walls/clouds, not horizontal barcode bars.
 */

import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts'
import {
  makeFieldColorizer,
  type FieldRgba,
} from './gexHeatmapShader'
import type { GammaStop } from '@/data/heatmapPalettes'
import { defaultHeatmapIntensity } from '@/data/heatmapPalettes'

export type GexHeatmapCell = {
  low: number
  high: number
  /** Signed unit GEX in [-1, +1]. */
  amount: number
  strike?: number
  netGex?: number
}

export interface GexHeatmapData extends CustomData {
  cells: GexHeatmapCell[]
}

export type GexHeatmapCellShader = (amount: number) => string
export type GexHeatmapFieldColorizer = (amount: number) => FieldRgba

export interface GexHeatmapSeriesOptions extends CustomSeriesOptions {
  lastValueVisible: false
  priceLineVisible: false
  cellShader: GexHeatmapCellShader
  fieldColorizer?: GexHeatmapFieldColorizer | null
  gammaRamp?: GammaStop[] | null
  intensityPct: number
  isLightTheme: boolean
  cellBorderWidth: number
  cellBorderColor: string
  /**
   * Full surface history for texture bake. Kept off the LWC time scale so
   * dense GEX samples do not crush Hyperliquid candle bar width.
   * Chart setData should stay sparse (anchors only).
   */
  bakeSource?: GexHeatmapData[] | null
  /** Soft closed GEX lobes at the live edge (reference silhouette). */
  showProfile: boolean
  profileColor: string
  profileWidthPx: number
  /** Legacy no-ops kept so host applyOptions stays compatible. */
  showContours: boolean
  contourLevels: number[]
  contourColorPos: string
  contourColorNeg: string
  contourColorLight: string
  preferLightContours: boolean
}

export const gexHeatmapDefaultOptions: GexHeatmapSeriesOptions = {
  ...customSeriesDefaultOptions,
  lastValueVisible: false,
  priceLineVisible: false,
  cellShader: () => 'rgba(0,0,0,0)',
  fieldColorizer: null,
  gammaRamp: null,
  intensityPct: defaultHeatmapIntensity,
  isLightTheme: false,
  cellBorderWidth: 0,
  cellBorderColor: 'transparent',
  bakeSource: null,
  showProfile: true,
  profileColor: 'rgba(236, 242, 250, 0.9)',
  profileWidthPx: 56,
  showContours: false,
  contourLevels: [],
  contourColorPos: 'transparent',
  contourColorNeg: 'transparent',
  contourColorLight: 'transparent',
  preferLightContours: true,
} as GexHeatmapSeriesOptions

/** Baked surface resolution — keep modest for 60fps pan. */
const TEX_COLS = 192
const TEX_ROWS = 160
/** Peak |field| below this after KDE → treat as void. */
const FIELD_EPS = 1e-4

type SampleColumn = {
  /** UTC seconds (LWC time). */
  timeSec: number
  strikes: Float64Array
  amounts: Float64Array
}

type SurfaceTexture = {
  canvas: HTMLCanvasElement
  /** Data-domain time (sec) covered by texture columns. */
  t0: number
  t1: number
  /** Data-domain price covered by texture rows (row0 = p1 high). */
  p0: number
  p1: number
  /** Live-edge KDE samples for profile lobes (price, unit amount). */
  liveCurve: Float32Array
  livePrices: Float32Array
  bakeKey: string
}

class GexHeatmapRenderer implements ICustomSeriesPaneRenderer {
  private _data: PaneRendererCustomData<Time, GexHeatmapData> | null = null
  private _options: GexHeatmapSeriesOptions | null = null
  private _samples: SampleColumn[] = []
  private _samplesKey = ''
  private _texture: SurfaceTexture | null = null
  private _colorKey = ''

  draw(
    target: CanvasRenderingTarget2D,
    priceConverter: PriceToCoordinateConverter,
  ): void {
    target.useBitmapCoordinateSpace((scope) => {
      this._drawImpl(scope, priceConverter)
    })
  }

  update(
    data: PaneRendererCustomData<Time, GexHeatmapData>,
    options: GexHeatmapSeriesOptions,
  ): void {
    this._data = data
    this._options = options

    // Prefer full bakeSource (dense history) — sparse chart bars are only anchors.
    const nextKey = options.bakeSource?.length
      ? fingerprintBakeSource(options.bakeSource)
      : fingerprintBars(data)
    if (nextKey !== this._samplesKey) {
      this._samples = options.bakeSource?.length
        ? extractSamplesFromData(options.bakeSource)
        : extractSamples(data)
      this._samplesKey = nextKey
      this._texture = null
    }

    const colorKey = [
      options.intensityPct,
      options.isLightTheme ? 1 : 0,
      options.gammaRamp?.length ?? 0,
      options.fieldColorizer ? 1 : 0,
    ].join('|')
    if (colorKey !== this._colorKey) {
      this._colorKey = colorKey
      this._texture = null
    }
  }

  private _drawImpl(
    scope: {
      context: CanvasRenderingContext2D
      horizontalPixelRatio: number
      verticalPixelRatio: number
      bitmapSize: { width: number; height: number }
    },
    priceToCoordinate: PriceToCoordinateConverter,
  ): void {
    if (!this._data || !this._options || this._samples.length === 0) return

    const opts = this._options
    const hRatio = scope.horizontalPixelRatio
    const vRatio = scope.verticalPixelRatio
    const bitmapW = scope.bitmapSize.width
    const bitmapH = scope.bitmapSize.height
    if (bitmapW < 8 || bitmapH < 8) return

    // Ensure texture is baked for current samples + palette.
    if (!this._texture) {
      this._texture = bakeSurfaceTexture(this._samples, resolveColorizer(opts))
      if (!this._texture) return
    }
    const tex = this._texture

    // Use ALL anchor bars for time↔x (not just visibleRange) so zooming between
    // sparse anchors still maps the surface correctly.
    const bars = this._data.bars
    if (bars.length === 0) return
    const map = collectTimeXMap(bars, 0, bars.length)
    if (map.length < 1) return

    const mediaLeft = 0
    const mediaRight = bitmapW / Math.max(hRatio, 1e-6)
    const mediaTop = 0
    const mediaBottom = bitmapH / Math.max(vRatio, 1e-6)

    // Visible time span from bar map extremes, extended to pane edges by extrapolation.
    const tVis0 = map[0]!.t
    const tVis1 = map[map.length - 1]!.t
    const xVis0 = map[0]!.x
    const xVis1 = map[map.length - 1]!.x

    // Price at top/bottom of pane (linear invert from two anchors — fast, no binary search).
    const midP = (tex.p0 + tex.p1) / 2
    const spanP = Math.max(1, tex.p1 - tex.p0)
    const yMid = priceToCoordinate(midP)
    const yHi = priceToCoordinate(midP + spanP * 0.25)
    const yLo = priceToCoordinate(midP - spanP * 0.25)
    if (yMid == null || yHi == null || yLo == null) return
    // dy/dPrice
    const dYdP = ((yHi - yLo) / (spanP * 0.5)) || 0
    if (Math.abs(dYdP) < 1e-12) return
    const priceAtY = (y: number) => midP + (y - yMid) / dYdP
    const pTop = priceAtY(mediaTop)
    const pBot = priceAtY(mediaBottom)
    const pViewHigh = Math.max(pTop, pBot)
    const pViewLow = Math.min(pTop, pBot)
    if (!(pViewHigh > pViewLow)) return

    // Texture UV crop for visible window.
    const tSpan = Math.max(1e-6, tex.t1 - tex.t0)
    const pSpan = Math.max(1e-6, tex.p1 - tex.p0)

    // Pane-edge times via linear time↔x from map.
    const tAtX = (x: number) => {
      if (map.length === 1) return map[0]!.t
      if (x <= xVis0) {
        const dt = map.length > 1 ? (map[1]!.t - map[0]!.t) / Math.max(1e-6, map[1]!.x - map[0]!.x) : 0
        return tVis0 + (x - xVis0) * dt
      }
      if (x >= xVis1) {
        const a = map[map.length - 2] ?? map[0]!
        const b = map[map.length - 1]!
        const dt = (b.t - a.t) / Math.max(1e-6, b.x - a.x)
        return tVis1 + (x - xVis1) * dt
      }
      // binary search
      let lo = 0
      let hi = map.length - 1
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1
        if (map[m]!.x <= x) lo = m
        else hi = m
      }
      const a = map[lo]!
      const b = map[hi]!
      const u = (x - a.x) / Math.max(1e-6, b.x - a.x)
      return a.t + (b.t - a.t) * u
    }

    const tPane0 = tAtX(mediaLeft)
    const tPane1 = tAtX(mediaRight)

    // Texture UVs (may extend outside 0..1 when panned past data — clamp crop).
    let u0 = (tPane0 - tex.t0) / tSpan
    let u1 = (tPane1 - tex.t0) / tSpan
    // row0 = high price (p1)
    let v0 = (tex.p1 - pViewHigh) / pSpan
    let v1 = (tex.p1 - pViewLow) / pSpan

    if (u1 < u0) {
      const tmp = u0
      u0 = u1
      u1 = tmp
    }
    if (v1 < v0) {
      const tmp = v0
      v0 = v1
      v1 = tmp
    }

    // Full-pane destination; source is clamped to texture bounds.
    const texW = tex.canvas.width
    const texH = tex.canvas.height
    const cu0 = clamp01(u0)
    const cu1 = clamp01(u1)
    const cv0 = clamp01(v0)
    const cv1 = clamp01(v1)
    if (!(cu1 - cu0 > 1e-4 && cv1 - cv0 > 1e-4)) return

    const sx = cu0 * texW
    const sy = cv0 * texH
    const sw = (cu1 - cu0) * texW
    const sh = (cv1 - cv0) * texH

    // Map clamped UV back to media so edges outside data stay empty (void).
    const spanU = Math.max(1e-6, u1 - u0)
    const spanV = Math.max(1e-6, v1 - v0)
    const dx = mediaLeft + ((cu0 - u0) / spanU) * (mediaRight - mediaLeft)
    const dy = mediaTop + ((cv0 - v0) / spanV) * (mediaBottom - mediaTop)
    const dw = ((cu1 - cu0) / spanU) * (mediaRight - mediaLeft)
    const dh = ((cv1 - cv0) / spanV) * (mediaBottom - mediaTop)
    if (!(dw > 0.5 && dh > 0.5)) return

    const ctx = scope.context
    ctx.save()
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(
      tex.canvas,
      sx,
      sy,
      sw,
      sh,
      dx * hRatio,
      dy * vRatio,
      dw * hRatio,
      dh * vRatio,
    )
    ctx.restore()

    if (opts.showProfile) {
      drawProfileLobes(
        ctx,
        hRatio,
        vRatio,
        priceToCoordinate,
        tex,
        map,
        opts.profileColor,
        opts.profileWidthPx,
      )
    }
  }
}

export class GexHeatmapSeries
  implements ICustomSeriesPaneView<Time, GexHeatmapData, GexHeatmapSeriesOptions>
{
  private _renderer = new GexHeatmapRenderer()

  renderer(): ICustomSeriesPaneRenderer {
    return this._renderer
  }

  update(
    data: PaneRendererCustomData<Time, GexHeatmapData>,
    options: GexHeatmapSeriesOptions,
  ): void {
    this._renderer.update(data, options)
  }

  /** Never contribute to autoscale — candles own price. */
  priceValueBuilder(_plotRow: GexHeatmapData): CustomSeriesPricePlotValues {
    return [NaN]
  }

  isWhitespace(data: GexHeatmapData | WhitespaceData): data is WhitespaceData {
    return (data as Partial<GexHeatmapData>).cells === undefined
      || (data as Partial<GexHeatmapData>).cells!.length < 1
  }

  defaultOptions(): GexHeatmapSeriesOptions {
    return { ...gexHeatmapDefaultOptions }
  }
}

/* ── sample extraction ───────────────────────────────────────────────────── */

function fingerprintBars(data: PaneRendererCustomData<Time, GexHeatmapData>): string {
  const bars = data.bars
  if (!bars.length) return '0'
  const first = bars[0]?.originalData
  const last = bars[bars.length - 1]?.originalData
  const f0 = first?.cells?.[0]
  const l0 = last?.cells?.[0]
  return [
    bars.length,
    String(first?.time ?? ''),
    String(last?.time ?? ''),
    first?.cells?.length ?? 0,
    last?.cells?.length ?? 0,
    f0?.amount?.toFixed(4) ?? '',
    l0?.amount?.toFixed(4) ?? '',
    f0?.strike ?? f0?.low ?? '',
    l0?.strike ?? l0?.low ?? '',
  ].join('|')
}

function fingerprintBakeSource(rows: GexHeatmapData[]): string {
  if (!rows.length) return '0'
  const first = rows[0]!
  const last = rows[rows.length - 1]!
  const f0 = first.cells[0]
  const l0 = last.cells[0]
  return [
    rows.length,
    String(first.time),
    String(last.time),
    first.cells.length,
    last.cells.length,
    f0?.amount?.toFixed(4) ?? '',
    l0?.amount?.toFixed(4) ?? '',
  ].join('|')
}

function extractSamples(data: PaneRendererCustomData<Time, GexHeatmapData>): SampleColumn[] {
  const rows: GexHeatmapData[] = []
  for (const bar of data.bars) {
    if (bar.originalData?.cells?.length) rows.push(bar.originalData)
  }
  return extractSamplesFromData(rows)
}

function extractSamplesFromData(rows: GexHeatmapData[]): SampleColumn[] {
  const out: SampleColumn[] = []
  for (const row of rows) {
    const cells = row.cells
    if (!cells?.length) continue
    const timeSec = timeToSec(row.time)
    if (timeSec == null) continue

    const pairs: Array<{ s: number; a: number }> = []
    for (const c of cells) {
      const s = Number.isFinite(c.strike) ? c.strike! : (c.low + c.high) / 2
      if (!Number.isFinite(s) || !Number.isFinite(c.amount)) continue
      if (Math.abs(c.amount) < FIELD_EPS) continue
      pairs.push({ s, a: c.amount })
    }
    if (!pairs.length) continue
    pairs.sort((a, b) => a.s - b.s)

    const strikes = new Float64Array(pairs.length)
    const amounts = new Float64Array(pairs.length)
    for (let i = 0; i < pairs.length; i++) {
      strikes[i] = pairs[i]!.s
      amounts[i] = pairs[i]!.a
    }
    out.push({ timeSec, strikes, amounts })
  }
  out.sort((a, b) => a.timeSec - b.timeSec)
  return out
}

function timeToSec(t: Time | undefined): number | null {
  if (t == null) return null
  if (typeof t === 'number' && Number.isFinite(t)) return t
  if (typeof t === 'string') {
    const ms = Date.parse(t)
    return Number.isFinite(ms) ? ms / 1000 : null
  }
  // BusinessDay
  if (typeof t === 'object' && t !== null && 'year' in t) {
    const bd = t as { year: number; month: number; day: number }
    const ms = Date.UTC(bd.year, bd.month - 1, bd.day)
    return ms / 1000
  }
  return null
}

/* ── KDE bake ────────────────────────────────────────────────────────────── */

function bakeSurfaceTexture(
  samples: SampleColumn[],
  colorize: GexHeatmapFieldColorizer,
): SurfaceTexture | null {
  if (samples.length === 0) return null

  let t0 = samples[0]!.timeSec
  let t1 = samples[samples.length - 1]!.timeSec
  if (!(t1 > t0)) {
    // Single sample — give the texture a nominal 1h span so blit still works.
    t1 = t0 + 3600
    t0 = t0 - 3600 * 11
  }

  // Price domain from strike extents with pad for soft kernel tails.
  let pMin = Infinity
  let pMax = -Infinity
  let strikeStep = 0
  let stepN = 0
  for (const s of samples) {
    for (let i = 0; i < s.strikes.length; i++) {
      const k = s.strikes[i]!
      if (k < pMin) pMin = k
      if (k > pMax) pMax = k
      if (i > 0) {
        strikeStep += k - s.strikes[i - 1]!
        stepN++
      }
    }
  }
  if (!(pMax > pMin)) return null

  const medianStep = stepN > 0 ? strikeStep / stepN : (pMax - pMin) * 0.01
  // Wider kernels → soft atmospheric clouds (reference), not barcode slabs.
  const sigma = Math.max(medianStep * 1.15, (pMax - pMin) * 0.008, 25)
  const pad = sigma * 3.5
  const p0 = pMin - pad
  const p1 = pMax + pad

  const cols = TEX_COLS
  const rows = TEX_ROWS
  const field = new Float32Array(cols * rows)

  // Precompute price for each row (row 0 = high price).
  const prices = new Float32Array(rows)
  for (let r = 0; r < rows; r++) {
    const u = r / Math.max(rows - 1, 1)
    prices[r] = p1 + (p0 - p1) * u
  }

  // For each time column, blend neighboring samples then KDE in price.
  for (let c = 0; c < cols; c++) {
    const u = c / Math.max(cols - 1, 1)
    const t = t0 + (t1 - t0) * u
    const { a, b, w } = bracketSample(samples, t)

    for (let r = 0; r < rows; r++) {
      const price = prices[r]!
      const v0 = kdeAtPrice(a, price, sigma)
      const v1 = kdeAtPrice(b, price, sigma)
      field[r * cols + c] = v0 * (1 - w) + v1 * w
    }
  }

  // Normalize by robust peak so mid walls stay visible.
  let peak = 0
  for (let i = 0; i < field.length; i++) {
    const a = Math.abs(field[i]!)
    if (a > peak) peak = a
  }
  if (peak > 0) {
    const inv = 1 / peak
    for (let i = 0; i < field.length; i++) field[i]! *= inv
  }

  // Mild vertical box blur (3-tap) — cheap soft ridges, not a full gaussian pass.
  boxBlurVertical(field, cols, rows, 1)

  // Colorize into canvas once.
  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(cols, rows)
  const px = img.data
  for (let i = 0; i < cols * rows; i++) {
    const c = colorize(field[i]!)
    const o = i * 4
    px[o] = c.r
    px[o + 1] = c.g
    px[o + 2] = c.b
    px[o + 3] = Math.round(clamp01(c.a) * 255)
  }
  ctx.putImageData(img, 0, 0)

  // Live edge curve for profile lobes (last sample, dense KDE).
  const live = samples[samples.length - 1]!
  const liveN = rows
  const liveCurve = new Float32Array(liveN)
  const livePrices = new Float32Array(liveN)
  let livePeak = 0
  for (let r = 0; r < liveN; r++) {
    const price = prices[r]!
    const v = kdeAtPrice(live, price, sigma)
    liveCurve[r] = v
    livePrices[r] = price
    if (Math.abs(v) > livePeak) livePeak = Math.abs(v)
  }
  if (livePeak > 0) {
    const inv = 1 / livePeak
    for (let r = 0; r < liveN; r++) liveCurve[r]! *= inv
  }

  return {
    canvas,
    t0,
    t1,
    p0,
    p1,
    liveCurve,
    livePrices,
    bakeKey: `${samples.length}:${t0}:${t1}:${p0.toFixed(0)}:${p1.toFixed(0)}`,
  }
}

function kdeAtPrice(sample: SampleColumn, price: number, sigma: number): number {
  const { strikes, amounts } = sample
  const inv = 1 / Math.max(sigma, 1e-6)
  let sum = 0
  // Restrict to strikes within ~3.5σ for speed.
  const lo = price - sigma * 3.5
  const hi = price + sigma * 3.5
  for (let i = 0; i < strikes.length; i++) {
    const s = strikes[i]!
    if (s < lo || s > hi) continue
    const d = (price - s) * inv
    sum += amounts[i]! * Math.exp(-0.5 * d * d)
  }
  return sum
}

function bracketSample(
  samples: SampleColumn[],
  t: number,
): { a: SampleColumn; b: SampleColumn; w: number } {
  const n = samples.length
  if (n === 1) return { a: samples[0]!, b: samples[0]!, w: 0 }
  if (t <= samples[0]!.timeSec) return { a: samples[0]!, b: samples[0]!, w: 0 }
  if (t >= samples[n - 1]!.timeSec) {
    return { a: samples[n - 1]!, b: samples[n - 1]!, w: 0 }
  }
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (samples[m]!.timeSec <= t) lo = m
    else hi = m
  }
  const a = samples[lo]!
  const b = samples[hi]!
  const span = Math.max(1e-6, b.timeSec - a.timeSec)
  const w = clamp01((t - a.timeSec) / span)
  // Smoothstep for less temporal banding.
  const s = w * w * (3 - 2 * w)
  return { a, b, w: s }
}

function boxBlurVertical(field: Float32Array, cols: number, rows: number, radius: number) {
  if (radius < 1 || rows < 3) return
  const tmp = new Float32Array(field.length)
  const r = radius
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      let sum = 0
      let n = 0
      for (let k = -r; k <= r; k++) {
        const yy = y + k
        if (yy < 0 || yy >= rows) continue
        sum += field[yy * cols + x]!
        n++
      }
      tmp[y * cols + x] = n > 0 ? sum / n : 0
    }
  }
  field.set(tmp)
}

/* ── viewport helpers ────────────────────────────────────────────────────── */

function collectTimeXMap(
  bars: PaneRendererCustomData<Time, GexHeatmapData>['bars'],
  from: number,
  to: number,
): Array<{ t: number; x: number }> {
  const map: Array<{ t: number; x: number }> = []
  const start = Math.max(0, from - 1)
  const end = Math.min(bars.length, to + 1)
  for (let i = start; i < end; i++) {
    const bar = bars[i]
    if (!bar) continue
    const t = timeToSec(bar.originalData?.time ?? bar.time)
    if (t == null) continue
    map.push({ t, x: bar.x })
  }
  return map
}

/**
 * Closed white lobes at high-|GEX| ridges near the live edge —
 * matches the reference silhouette (not a full-height wiggly line).
 */
function drawProfileLobes(
  ctx: CanvasRenderingContext2D,
  hRatio: number,
  vRatio: number,
  priceToCoordinate: PriceToCoordinateConverter,
  tex: SurfaceTexture,
  map: Array<{ t: number; x: number }>,
  color: string,
  widthPx: number,
) {
  if (map.length === 0 || tex.liveCurve.length < 4) return

  // Live edge x ≈ last sample time mapped through the bar map.
  const lastT = tex.t1
  let baseX = map[map.length - 1]!.x
  // Refine: interpolate map for tex.t1
  for (let i = 0; i < map.length - 1; i++) {
    const a = map[i]!
    const b = map[i + 1]!
    if (lastT >= a.t && lastT <= b.t) {
      const u = (lastT - a.t) / Math.max(1e-6, b.t - a.t)
      baseX = a.x + (b.x - a.x) * u
      break
    }
  }
  if (lastT > map[map.length - 1]!.t) {
    baseX = map[map.length - 1]!.x
  }

  const width = Math.max(20, widthPx)
  const thr = 0.22

  // Build points (price → y, amount).
  type Pt = { y: number; a: number }
  const pts: Pt[] = []
  for (let i = 0; i < tex.liveCurve.length; i++) {
    const price = tex.livePrices[i]!
    const y = priceToCoordinate(price)
    if (y == null) continue
    pts.push({ y, a: tex.liveCurve[i]! })
  }
  if (pts.length < 4) return

  // Segment into contiguous lobes above threshold.
  const lobes: Pt[][] = []
  let cur: Pt[] = []
  for (const p of pts) {
    if (Math.abs(p.a) >= thr) {
      cur.push(p)
    } else if (cur.length) {
      if (cur.length >= 3) lobes.push(cur)
      cur = []
    }
  }
  if (cur.length >= 3) lobes.push(cur)
  if (!lobes.length) return

  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  for (const lobe of lobes) {
    // Closed bubble: right ridge + mirrored left echo.
    const right: Array<{ x: number; y: number }> = []
    const left: Array<{ x: number; y: number }> = []
    for (const p of lobe) {
      const mag = Math.abs(p.a)
      const w = mag * width
      right.push({ x: (baseX + w) * hRatio, y: p.y * vRatio })
      left.push({ x: (baseX - w * 0.28) * hRatio, y: p.y * vRatio })
    }

    // Soft fill
    ctx.beginPath()
    ctx.moveTo(right[0]!.x, right[0]!.y)
    for (let i = 1; i < right.length; i++) ctx.lineTo(right[i]!.x, right[i]!.y)
    for (let i = left.length - 1; i >= 0; i--) ctx.lineTo(left[i]!.x, left[i]!.y)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.globalAlpha = 0.06
    ctx.fill()

    // Outline
    ctx.globalAlpha = 0.85
    ctx.strokeStyle = color
    ctx.lineWidth = 1.1 * Math.min(hRatio, vRatio)
    ctx.beginPath()
    ctx.moveTo(right[0]!.x, right[0]!.y)
    for (let i = 1; i < right.length; i++) ctx.lineTo(right[i]!.x, right[i]!.y)
    for (let i = left.length - 1; i >= 0; i--) ctx.lineTo(left[i]!.x, left[i]!.y)
    ctx.closePath()
    ctx.stroke()
  }

  ctx.restore()
}

function resolveColorizer(options: GexHeatmapSeriesOptions): GexHeatmapFieldColorizer {
  if (options.fieldColorizer) return options.fieldColorizer
  if (options.gammaRamp && options.gammaRamp.length > 0) {
    return makeFieldColorizer({
      ramp: options.gammaRamp,
      intensityPct: options.intensityPct,
      isLight: options.isLightTheme,
    })
  }
  return (amount: number) => {
    const a = Math.min(1, Math.abs(amount))
    if (a < 1e-4) return { r: 0, g: 0, b: 0, a: 0 }
    if (amount >= 0) return { r: 48, g: 200, b: 190, a: 0.12 + a * 0.5 }
    return { r: 200, g: 60, b: 80, a: 0.12 + a * 0.5 }
  }
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}
