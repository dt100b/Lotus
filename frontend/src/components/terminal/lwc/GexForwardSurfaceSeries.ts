/**
 * 0DTE forward gamma surface underlay for Lightweight Charts v5.
 *
 * Distinct from GexHeatmapSeries (historical KDE-from-strikes):
 *  - Consumes a dense forward (time × price) GEX grid
 *  - Bakes a soft color texture + white isocontours once on grid/options change
 *  - Every frame: O(1) blit + cheap contour stroke + right-side profile lobes
 *  - Never drives price or candle time scale (priceValueBuilder → NaN;
 *    chart setData stays sparse anchors only)
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
  type FieldRgba,
} from './gexHeatmapShader'
import {
  extractContourSegments,
  type ContourSegment,
} from './gexContours'
import type { GammaStop } from '@/data/heatmapPalettes'
import { defaultHeatmapIntensity, sampleGammaRamp } from '@/data/heatmapPalettes'
import type { GexForwardSurface } from '@/api/gexForwardSurface'

/** Sparse chart anchors — never the full grid (keeps LWC bar spacing free). */
export interface GexForwardSurfaceData extends CustomData {
  /** Marker only; real field lives in options.surface. */
  _fwd?: 1
}

export type GexForwardFieldColorizer = (amount: number) => FieldRgba

export interface GexForwardSurfaceSeriesOptions extends CustomSeriesOptions {
  lastValueVisible: false
  priceLineVisible: false
  /**
   * Dense forward grid (times epoch sec preferred; ms accepted & normalized).
   * Bake source — not on the LWC time scale.
   */
  surface: GexForwardSurface | null
  fieldColorizer?: GexForwardFieldColorizer | null
  gammaRamp?: GammaStop[] | null
  intensityPct: number
  isLightTheme: boolean
  showProfile: boolean
  profileColor: string
  profileWidthPx: number
  showContours: boolean
  /** Signed unit isoline levels. Empty → defaults. */
  contourLevels: number[]
  contourColor: string
  contourWidthPx: number
}

const FORWARD_CONTOUR_LEVELS = [-0.55, -0.32, 0.32, 0.55] as const

export const gexForwardSurfaceDefaultOptions: GexForwardSurfaceSeriesOptions = {
  ...customSeriesDefaultOptions,
  lastValueVisible: false,
  priceLineVisible: false,
  surface: null,
  fieldColorizer: null,
  gammaRamp: null,
  intensityPct: defaultHeatmapIntensity,
  isLightTheme: false,
  showProfile: true,
  profileColor: 'rgba(236, 242, 250, 0.92)',
  profileWidthPx: 64,
  showContours: true,
  contourLevels: [...FORWARD_CONTOUR_LEVELS],
  contourColor: 'rgba(240, 246, 255, 0.55)',
  contourWidthPx: 1.15,
} as GexForwardSurfaceSeriesOptions

const TEX_COLS = 256
const TEX_ROWS = 192
const FIELD_EPS = 1e-4

type BakedTexture = {
  canvas: HTMLCanvasElement
  /** Domain time in UTC seconds. */
  t0: number
  t1: number
  /** Price domain (p0 low → p1 high). Texture row0 = p1. */
  p0: number
  p1: number
  /** Unit field [row-major TEX_ROWS × TEX_COLS] for contour mapping. */
  unitField: Float32Array
  cols: number
  rows: number
  /** Contour segments in texture cell space. */
  contours: ContourSegment[]
  /** Live (τ=now) profile: unit amount per price. */
  liveCurve: Float32Array
  livePrices: Float32Array
  bakeKey: string
}

class GexForwardSurfaceRenderer implements ICustomSeriesPaneRenderer {
  private _data: PaneRendererCustomData<Time, GexForwardSurfaceData> | null = null
  private _options: GexForwardSurfaceSeriesOptions | null = null
  private _texture: BakedTexture | null = null
  private _bakeKey = ''

  draw(
    target: CanvasRenderingTarget2D,
    priceConverter: PriceToCoordinateConverter,
  ): void {
    target.useBitmapCoordinateSpace((scope) => {
      this._drawImpl(scope, priceConverter)
    })
  }

  update(
    data: PaneRendererCustomData<Time, GexForwardSurfaceData>,
    options: GexForwardSurfaceSeriesOptions,
  ): void {
    this._data = data
    this._options = options

    const nextKey = fingerprintSurface(options)
    if (nextKey !== this._bakeKey) {
      this._bakeKey = nextKey
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
    if (!this._data || !this._options) return
    const opts = this._options
    const surface = opts.surface
    if (!surface || surface.times.length < 2 || surface.prices.length < 2) return

    const hRatio = scope.horizontalPixelRatio
    const vRatio = scope.verticalPixelRatio
    const bitmapW = scope.bitmapSize.width
    const bitmapH = scope.bitmapSize.height
    if (bitmapW < 8 || bitmapH < 8) return

    if (!this._texture) {
      this._texture = bakeForwardTexture(surface, resolveColorizer(opts), opts)
      if (!this._texture) return
    }
    const tex = this._texture

    // Time↔x from ALL anchor bars (candles via sparse setData) — never own scale.
    const bars = this._data.bars
    if (bars.length === 0) return
    const map = collectTimeXMap(bars)
    if (map.length < 1) return

    const mediaLeft = 0
    const mediaRight = bitmapW / Math.max(hRatio, 1e-6)
    const mediaTop = 0
    const mediaBottom = bitmapH / Math.max(vRatio, 1e-6)

    const tVis0 = map[0]!.t
    const tVis1 = map[map.length - 1]!.t
    const xVis0 = map[0]!.x
    const xVis1 = map[map.length - 1]!.x

    // Price linear invert from two anchors.
    const midP = (tex.p0 + tex.p1) / 2
    const spanP = Math.max(1, tex.p1 - tex.p0)
    const yMid = priceToCoordinate(midP)
    const yHi = priceToCoordinate(midP + spanP * 0.25)
    const yLo = priceToCoordinate(midP - spanP * 0.25)
    if (yMid == null || yHi == null || yLo == null) return
    const dYdP = ((yHi - yLo) / (spanP * 0.5)) || 0
    if (Math.abs(dYdP) < 1e-12) return
    const priceAtY = (y: number) => midP + (y - yMid) / dYdP
    const pTop = priceAtY(mediaTop)
    const pBot = priceAtY(mediaBottom)
    const pViewHigh = Math.max(pTop, pBot)
    const pViewLow = Math.min(pTop, pBot)
    if (!(pViewHigh > pViewLow)) return

    const tAtX = makeTAtX(map, tVis0, tVis1, xVis0, xVis1)
    const xAtT = makeXAtT(map, tVis0, tVis1, xVis0, xVis1)

    const tPane0 = tAtX(mediaLeft)
    const tPane1 = tAtX(mediaRight)

    const tSpan = Math.max(1e-6, tex.t1 - tex.t0)
    const pSpan = Math.max(1e-6, tex.p1 - tex.p0)

    let u0 = (tPane0 - tex.t0) / tSpan
    let u1 = (tPane1 - tex.t0) / tSpan
    // row0 = high price
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

    const texW = tex.canvas.width
    const texH = tex.canvas.height
    const cu0 = clamp01(u0)
    const cu1 = clamp01(u1)
    const cv0 = clamp01(v0)
    const cv1 = clamp01(v1)

    const ctx = scope.context
    ctx.save()
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    if (cu1 - cu0 > 1e-4 && cv1 - cv0 > 1e-4) {
      const sx = cu0 * texW
      const sy = cv0 * texH
      const sw = (cu1 - cu0) * texW
      const sh = (cv1 - cv0) * texH
      const spanU = Math.max(1e-6, u1 - u0)
      const spanV = Math.max(1e-6, v1 - v0)
      const dx = mediaLeft + ((cu0 - u0) / spanU) * (mediaRight - mediaLeft)
      const dy = mediaTop + ((cv0 - v0) / spanV) * (mediaBottom - mediaTop)
      const dw = ((cu1 - cu0) / spanU) * (mediaRight - mediaLeft)
      const dh = ((cv1 - cv0) / spanV) * (mediaBottom - mediaTop)
      if (dw > 0.5 && dh > 0.5) {
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
      }
    }

    if (opts.showContours && tex.contours.length > 0) {
      drawContours(
        ctx,
        hRatio,
        vRatio,
        tex,
        xAtT,
        priceToCoordinate,
        opts.contourColor,
        opts.contourWidthPx,
        mediaLeft,
        mediaRight,
        mediaTop,
        mediaBottom,
      )
    }

    if (opts.showProfile) {
      drawRightProfileLobes(
        ctx,
        hRatio,
        vRatio,
        priceToCoordinate,
        tex,
        mediaRight,
        opts.profileColor,
        opts.profileWidthPx,
      )
    }

    ctx.restore()
  }
}

export class GexForwardSurfaceSeries
  implements ICustomSeriesPaneView<Time, GexForwardSurfaceData, GexForwardSurfaceSeriesOptions>
{
  private _renderer = new GexForwardSurfaceRenderer()

  renderer(): ICustomSeriesPaneRenderer {
    return this._renderer
  }

  update(
    data: PaneRendererCustomData<Time, GexForwardSurfaceData>,
    options: GexForwardSurfaceSeriesOptions,
  ): void {
    this._renderer.update(data, options)
  }

  /** Candles own price autoscale. */
  priceValueBuilder(_plotRow: GexForwardSurfaceData): CustomSeriesPricePlotValues {
    void _plotRow
    return [NaN]
  }

  isWhitespace(data: GexForwardSurfaceData | WhitespaceData): data is WhitespaceData {
    // Anchors carry `_fwd: 1` so they stay in the bar map for time↔x.
    return (data as Partial<GexForwardSurfaceData>)._fwd !== 1
  }

  defaultOptions(): GexForwardSurfaceSeriesOptions {
    return { ...gexForwardSurfaceDefaultOptions }
  }
}

/* ── bake ────────────────────────────────────────────────────────────────── */

function bakeForwardTexture(
  surface: GexForwardSurface,
  colorize: GexForwardFieldColorizer,
  opts: GexForwardSurfaceSeriesOptions,
): BakedTexture | null {
  const nT = surface.times.length
  const nP = surface.prices.length
  if (nT < 2 || nP < 2 || surface.values.length < nT) return null

  // Normalize times to UTC seconds (API sends ms).
  const timesSec = surface.times.map((t) => (t > 1e12 ? t / 1000 : t))
  const t0 = timesSec[0]!
  const t1 = timesSec[nT - 1]!
  if (!(t1 > t0)) return null

  const prices = surface.prices
  const p0 = prices[0]!
  const p1 = prices[nP - 1]!
  if (!(p1 > p0)) return null

  const cols = TEX_COLS
  const rows = TEX_ROWS
  const field = new Float32Array(cols * rows)

  // Resample dense grid → texture with bilinear interpolation.
  for (let c = 0; c < cols; c++) {
    const u = c / Math.max(cols - 1, 1)
    const t = t0 + (t1 - t0) * u
    const { i0, i1, w } = bracketIndex(timesSec, t)
    for (let r = 0; r < rows; r++) {
      // row0 = high price
      const v = r / Math.max(rows - 1, 1)
      const price = p1 + (p0 - p1) * v
      const a = samplePriceColumn(surface.values[i0]!, prices, price)
      const b = samplePriceColumn(surface.values[i1]!, prices, price)
      field[r * cols + c] = a * (1 - w) + b * w
    }
  }

  // Soft continuous ridges before unit mapping.
  boxBlur2d(field, cols, rows, 2)

  // Hybrid unit normalize — pure maxAbs crushes residual field as τ→settle.
  hybridUnitNormalizeInPlace(field, cols, rows)
  boxBlur2d(field, cols, rows, 1)

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

  // White topographic isocontours on unit field.
  const levels =
    opts.contourLevels?.length > 0 ? opts.contourLevels : [...FORWARD_CONTOUR_LEVELS]
  const contours = opts.showContours
    ? extractContourSegments(field, cols, rows, levels)
    : []

  // Profile = τ=now column (first time), dense over texture prices.
  const liveCurve = new Float32Array(rows)
  const livePrices = new Float32Array(rows)
  const col0 = surface.values[0]!
  for (let r = 0; r < rows; r++) {
    const v = r / Math.max(rows - 1, 1)
    const price = p1 + (p0 - p1) * v
    liveCurve[r] = samplePriceColumn(col0, prices, price)
    livePrices[r] = price
  }
  softPeakNormalize1d(liveCurve)
  smooth1d(liveCurve, 2)

  return {
    canvas,
    t0,
    t1,
    p0,
    p1,
    unitField: field,
    cols,
    rows,
    contours,
    liveCurve,
    livePrices,
    bakeKey: `${nT}:${nP}:${t0}:${t1}:${p0.toFixed(0)}:${p1.toFixed(0)}`,
  }
}

function samplePriceColumn(col: number[], prices: number[], price: number): number {
  if (!col?.length || !prices.length) return 0
  const n = Math.min(col.length, prices.length)
  if (price <= prices[0]!) return col[0] ?? 0
  if (price >= prices[n - 1]!) return col[n - 1] ?? 0
  // Binary search bracket.
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (prices[m]! <= price) lo = m
    else hi = m
  }
  const a = prices[lo]!
  const b = prices[hi]!
  const w = (price - a) / Math.max(1e-9, b - a)
  return (col[lo] ?? 0) * (1 - w) + (col[hi] ?? 0) * w
}

function bracketIndex(sorted: number[], t: number): { i0: number; i1: number; w: number } {
  const n = sorted.length
  if (n === 1) return { i0: 0, i1: 0, w: 0 }
  if (t <= sorted[0]!) return { i0: 0, i1: 0, w: 0 }
  if (t >= sorted[n - 1]!) return { i0: n - 1, i1: n - 1, w: 0 }
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (sorted[m]! <= t) lo = m
    else hi = m
  }
  const a = sorted[lo]!
  const b = sorted[hi]!
  const w = clamp01((t - a) / Math.max(1e-9, b - a))
  // Smoothstep
  const s = w * w * (3 - 2 * w)
  return { i0: lo, i1: hi, w: s }
}

/**
 * Hybrid unit field: per-column structure + soft global envelope.
 * Prevents settle-time BS gamma explosion from crushing the residual field.
 */
function hybridUnitNormalizeInPlace(
  field: Float32Array,
  cols: number,
  rows: number,
): void {
  const n = cols * rows
  if (n === 0) return

  const colPeak = new Float32Array(cols)
  let maxAbs = 0
  const absSamples: number[] = []
  for (let c = 0; c < cols; c++) {
    let pk = 0
    for (let r = 0; r < rows; r++) {
      const a = Math.abs(field[r * cols + c]!)
      if (a > pk) pk = a
      if (a > 0 && Number.isFinite(a)) {
        absSamples.push(a)
        if (a > maxAbs) maxAbs = a
      }
    }
    colPeak[c] = pk
  }
  if (!(maxAbs > 0) || absSamples.length === 0) {
    field.fill(0)
    return
  }

  absSamples.sort((a, b) => a - b)
  const pIdx = Math.min(
    absSamples.length - 1,
    Math.max(0, Math.floor((absSamples.length - 1) * 0.92)),
  )
  const p92 = absSamples[pIdx]!
  const globalSoft = Math.max(p92, maxAbs * 0.18)
  const out = new Float32Array(n)

  for (let c = 0; c < cols; c++) {
    const pk = colPeak[c]!
    if (!(pk > 0)) continue
    const env = Math.min(1, Math.pow(pk / globalSoft, 0.42))
    const invPk = 1 / pk
    for (let r = 0; r < rows; r++) {
      const v = field[r * cols + c]!
      if (!Number.isFinite(v) || v === 0) continue
      const local = v * invPk
      const magLocal = Math.abs(local)
      let mag = magLocal <= 1 ? magLocal : 1 - 1 / (1 + (magLocal - 1) * 2)
      mag = Math.pow(mag, 0.68)
      mag = Math.min(1, mag * (0.58 + 0.42 * env))
      if (mag < 0.025) continue
      const gated = (mag - 0.025) / 0.975
      out[r * cols + c] = Math.sign(local) * gated
    }
  }
  field.set(out)
}

function softPeakNormalize1d(arr: Float32Array): void {
  const absSorted: number[] = []
  let maxAbs = 0
  for (let i = 0; i < arr.length; i++) {
    const a = Math.abs(arr[i]!)
    if (a > 0 && Number.isFinite(a)) {
      absSorted.push(a)
      if (a > maxAbs) maxAbs = a
    }
  }
  if (!(maxAbs > 0) || absSorted.length === 0) {
    arr.fill(0)
    return
  }
  absSorted.sort((a, b) => a - b)
  const pIdx = Math.min(
    absSorted.length - 1,
    Math.max(0, Math.floor((absSorted.length - 1) * 0.9)),
  )
  const softPeak = Math.max(absSorted[pIdx]!, maxAbs * 0.28)
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]!
    if (!Number.isFinite(v) || v === 0) {
      arr[i] = 0
      continue
    }
    const a = Math.abs(v)
    const hard = a / maxAbs
    const r = a / softPeak
    let soft: number
    if (r <= 1) soft = r
    else {
      soft = 1 - 1 / (1 + (r - 1) * 2)
      if (a >= maxAbs * 0.995) soft = 1
      soft = Math.min(1, soft)
    }
    const mag = soft * (1 - hard * 0.45) + hard * (hard * 0.45)
    arr[i] = Math.sign(v) * Math.min(1, Math.pow(mag, 0.72))
  }
}

function boxBlur2d(field: Float32Array, cols: number, rows: number, radius: number) {
  if (radius < 1) return
  const tmp = new Float32Array(field.length)
  const r = radius
  // Horizontal
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let sum = 0
      let n = 0
      for (let k = -r; k <= r; k++) {
        const xx = x + k
        if (xx < 0 || xx >= cols) continue
        sum += field[y * cols + xx]!
        n++
      }
      tmp[y * cols + x] = n > 0 ? sum / n : 0
    }
  }
  // Vertical
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      let sum = 0
      let n = 0
      for (let k = -r; k <= r; k++) {
        const yy = y + k
        if (yy < 0 || yy >= rows) continue
        sum += tmp[yy * cols + x]!
        n++
      }
      field[y * cols + x] = n > 0 ? sum / n : 0
    }
  }
}

function smooth1d(arr: Float32Array, radius: number) {
  if (radius < 1 || arr.length < 3) return
  const tmp = new Float32Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    let sum = 0
    let n = 0
    for (let k = -radius; k <= radius; k++) {
      const j = i + k
      if (j < 0 || j >= arr.length) continue
      sum += arr[j]!
      n++
    }
    tmp[i] = n > 0 ? sum / n : 0
  }
  arr.set(tmp)
}

/* ── draw helpers ────────────────────────────────────────────────────────── */

function drawContours(
  ctx: CanvasRenderingContext2D,
  hRatio: number,
  vRatio: number,
  tex: BakedTexture,
  xAtT: (t: number) => number,
  priceToCoordinate: PriceToCoordinateConverter,
  color: string,
  widthPx: number,
  mediaLeft: number,
  mediaRight: number,
  mediaTop: number,
  mediaBottom: number,
) {
  const tSpan = Math.max(1e-6, tex.t1 - tex.t0)
  const pSpan = Math.max(1e-6, tex.p1 - tex.p0)
  // Contour coords are in cell space [0..cols] × [0..rows], row0 = high price.
  const cellToMedia = (cx: number, cy: number): { x: number; y: number } | null => {
    const u = cx / Math.max(tex.cols - 1, 1)
    const v = cy / Math.max(tex.rows - 1, 1)
    const t = tex.t0 + u * tSpan
    const price = tex.p1 - v * pSpan
    const x = xAtT(t)
    const y = priceToCoordinate(price)
    if (y == null) return null
    return { x, y }
  }

  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(0.6, widthPx) * Math.min(hRatio, vRatio)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.globalAlpha = 1

  for (const seg of tex.contours) {
    const a = cellToMedia(seg.x0, seg.y0)
    const b = cellToMedia(seg.x1, seg.y1)
    if (!a || !b) continue
    // Cull fully off-pane segments.
    if (
      (a.x < mediaLeft && b.x < mediaLeft)
      || (a.x > mediaRight && b.x > mediaRight)
      || (a.y < mediaTop && b.y < mediaTop)
      || (a.y > mediaBottom && b.y > mediaBottom)
    ) {
      continue
    }
    ctx.beginPath()
    ctx.moveTo(a.x * hRatio, a.y * vRatio)
    ctx.lineTo(b.x * hRatio, b.y * vRatio)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Closed white lobes fixed at the right edge of the plot —
 * current (τ=now) gamma distribution by price.
 */
function drawRightProfileLobes(
  ctx: CanvasRenderingContext2D,
  hRatio: number,
  vRatio: number,
  priceToCoordinate: PriceToCoordinateConverter,
  tex: BakedTexture,
  mediaRight: number,
  color: string,
  widthPx: number,
) {
  if (tex.liveCurve.length < 4) return

  // Anchor at right residual edge — closed bubble lobes like TRACE reference.
  const baseX = mediaRight - 8
  const width = Math.max(28, widthPx)
  const thr = 0.1

  type Pt = { y: number; a: number }
  const pts: Pt[] = []
  for (let i = 0; i < tex.liveCurve.length; i++) {
    const price = tex.livePrices[i]!
    const y = priceToCoordinate(price)
    if (y == null) continue
    pts.push({ y, a: tex.liveCurve[i]! })
  }
  if (pts.length < 4) return

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
    const right: Array<{ x: number; y: number }> = []
    const left: Array<{ x: number; y: number }> = []
    for (const p of lobe) {
      const mag = Math.abs(p.a)
      const w = Math.pow(mag, 0.78) * width
      right.push({ x: (baseX + w * 0.12) * hRatio, y: p.y * vRatio })
      left.push({ x: (baseX - w) * hRatio, y: p.y * vRatio })
    }

    ctx.beginPath()
    ctx.moveTo(right[0]!.x, right[0]!.y)
    for (let i = 1; i < right.length; i++) ctx.lineTo(right[i]!.x, right[i]!.y)
    for (let i = left.length - 1; i >= 0; i--) ctx.lineTo(left[i]!.x, left[i]!.y)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.globalAlpha = 0.14
    ctx.fill()

    ctx.globalAlpha = 0.92
    ctx.strokeStyle = color
    ctx.lineWidth = 1.35 * Math.min(hRatio, vRatio)
    ctx.beginPath()
    ctx.moveTo(right[0]!.x, right[0]!.y)
    for (let i = 1; i < right.length; i++) ctx.lineTo(right[i]!.x, right[i]!.y)
    for (let i = left.length - 1; i >= 0; i--) ctx.lineTo(left[i]!.x, left[i]!.y)
    ctx.closePath()
    ctx.stroke()
  }

  ctx.restore()
}

/* ── time map ────────────────────────────────────────────────────────────── */

function collectTimeXMap(
  bars: PaneRendererCustomData<Time, GexForwardSurfaceData>['bars'],
): Array<{ t: number; x: number }> {
  const map: Array<{ t: number; x: number }> = []
  for (const bar of bars) {
    if (!bar) continue
    const t = timeToSec(bar.originalData?.time ?? bar.time)
    if (t == null) continue
    map.push({ t, x: bar.x })
  }
  return map
}

function makeTAtX(
  map: Array<{ t: number; x: number }>,
  tVis0: number,
  tVis1: number,
  xVis0: number,
  xVis1: number,
) {
  return (x: number) => {
    if (map.length === 1) return map[0]!.t
    if (x <= xVis0) {
      const dt =
        map.length > 1
          ? (map[1]!.t - map[0]!.t) / Math.max(1e-6, map[1]!.x - map[0]!.x)
          : 0
      return tVis0 + (x - xVis0) * dt
    }
    if (x >= xVis1) {
      const a = map[map.length - 2] ?? map[0]!
      const b = map[map.length - 1]!
      const dt = (b.t - a.t) / Math.max(1e-6, b.x - a.x)
      return tVis1 + (x - xVis1) * dt
    }
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
}

function makeXAtT(
  map: Array<{ t: number; x: number }>,
  tVis0: number,
  tVis1: number,
  xVis0: number,
  xVis1: number,
) {
  return (t: number) => {
    if (map.length === 1) return map[0]!.x
    if (t <= tVis0) {
      const dx =
        map.length > 1
          ? (map[1]!.x - map[0]!.x) / Math.max(1e-6, map[1]!.t - map[0]!.t)
          : 0
      return xVis0 + (t - tVis0) * dx
    }
    if (t >= tVis1) {
      const a = map[map.length - 2] ?? map[0]!
      const b = map[map.length - 1]!
      const dx = (b.x - a.x) / Math.max(1e-6, b.t - a.t)
      return xVis1 + (t - tVis1) * dx
    }
    let lo = 0
    let hi = map.length - 1
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1
      if (map[m]!.t <= t) lo = m
      else hi = m
    }
    const a = map[lo]!
    const b = map[hi]!
    const u = (t - a.t) / Math.max(1e-6, b.t - a.t)
    return a.x + (b.x - a.x) * u
  }
}

function timeToSec(t: Time | undefined): number | null {
  if (t == null) return null
  if (typeof t === 'number' && Number.isFinite(t)) return t
  if (typeof t === 'string') {
    const ms = Date.parse(t)
    return Number.isFinite(ms) ? ms / 1000 : null
  }
  if (typeof t === 'object' && t !== null && 'year' in t) {
    const bd = t as { year: number; month: number; day: number }
    return Date.UTC(bd.year, bd.month - 1, bd.day) / 1000
  }
  return null
}

function fingerprintSurface(options: GexForwardSurfaceSeriesOptions): string {
  const s = options.surface
  if (!s || !s.times.length) return '0'
  const t0 = s.times[0]
  const t1 = s.times[s.times.length - 1]
  const p0 = s.prices[0]
  const p1 = s.prices[s.prices.length - 1]
  const midT = s.values[Math.floor(s.values.length / 2)]
  const midV = midT?.[Math.floor((midT.length || 1) / 2)] ?? 0
  const firstV = s.values[0]?.[0] ?? 0
  const lastV = s.values[s.values.length - 1]?.[s.prices.length - 1] ?? 0
  return [
    s.times.length,
    s.prices.length,
    t0,
    t1,
    p0?.toFixed?.(0) ?? p0,
    p1?.toFixed?.(0) ?? p1,
    firstV.toFixed?.(2) ?? firstV,
    midV.toFixed?.(2) ?? midV,
    lastV.toFixed?.(2) ?? lastV,
    options.intensityPct,
    options.isLightTheme ? 1 : 0,
    options.gammaRamp?.length ?? 0,
    options.showContours ? 1 : 0,
    options.contourLevels?.length ?? 0,
  ].join('|')
}

/** TRACE-vivid colorizer for residual forward γ (primary read of this pane). */
function resolveColorizer(options: GexForwardSurfaceSeriesOptions): GexForwardFieldColorizer {
  if (options.fieldColorizer) return options.fieldColorizer

  const intensity = Math.min(
    1,
    Math.max(
      0.2,
      (Number.isFinite(options.intensityPct) ? options.intensityPct : defaultHeatmapIntensity) / 100,
    ),
  )
  const isLight = Boolean(options.isLightTheme)
  const ramp = options.gammaRamp

  return (amount: number): FieldRgba => {
    const unit = Number.isFinite(amount) ? Math.max(-1, Math.min(1, amount)) : 0
    const mag = Math.abs(unit)
    if (mag < FIELD_EPS) return { r: 0, g: 0, b: 0, a: 0 }

    let r: number
    let g: number
    let b: number
    if (ramp && ramp.length > 0) {
      const rgb = sampleGammaRamp(unit, ramp)
      r = rgb.r
      g = rgb.g
      b = rgb.b
    } else if (unit >= 0) {
      r = 140
      g = 90
      b = 220
    } else {
      r = 230
      g = 70
      b = 150
    }

    const shaped = Math.pow(mag, 0.72)
    const floor = isLight ? 0.07 : 0.09
    const peak = isLight ? 0.62 : 0.74
    const alpha = Math.min(
      0.86,
      (floor + shaped * (peak - floor)) * (0.55 + intensity * 0.55),
    )
    return { r, g, b, a: alpha }
  }
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}
