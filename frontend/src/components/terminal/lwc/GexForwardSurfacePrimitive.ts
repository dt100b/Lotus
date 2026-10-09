/**
 * 0DTE forward gamma surface underlay (ISeriesPrimitive).
 *
 * Attaches to the Hyperliquid candle series (zOrder: bottom). Bake once when
 * the dense (time × price) grid arrives; every pan/zoom frame is O(1) blit +
 * dual contour stroke (magnitude lobe outlines + zero-gamma Flip).
 *
 * Visual model (desk pin-surface, not washed TRACE cloud):
 *   - Soft void mid-field; luminous |GEX| walls / strike lobes
 *   - Magnitude isolines are primary (closed islands + open ends at settle)
 *   - Flip (net GEX = 0) is secondary polarity structure
 *   - No separate gray right-edge profile blobs — open Y-axis ends come from
 *     magnitude contours kept at the right domain edge
 *
 * Uses chart.timeScale() + series.priceToCoordinate — does not own or distort
 * the candle time/price scale. Distinct from historical GexHeatmapSeries and
 * from GexZonePrimitive snapshot bands.
 */

import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'
import type { GexForwardSurface } from '@/api/gexForwardSurface'
import {
  extractContourSegments,
  extractZeroGammaContour,
  magnitudeContourLevels,
  type ContourSegment,
} from '@/components/terminal/lwc/gexContours'
import {
  type FieldRgba,
} from '@/components/terminal/lwc/gexHeatmapShader'
import { sampleGammaRamp, type GammaStop } from '@/data/heatmapPalettes'

type SeriesTypeLoose = 'Candlestick' | 'Line' | 'Area' | 'Baseline' | 'Histogram' | 'Bar' | 'Custom'

export type ForwardSurfacePaintStyle = {
  /** Field alpha. 100% is fully opaque at the strongest cells. */
  opacityPct: number
  /** Colour-domain multiplier. Lower saturates; higher widens the scale. */
  rangePct: number
  isLightTheme: boolean
  gammaRamp: GammaStop[] | null
  /** Independent magnitude-isoline switch. */
  showContours: boolean
  /** Independent switch for the zero-gamma Flip contour (default true). */
  showFlipContour: boolean
  /**
   * Legacy right-edge density fill. Kept off — open ends at the Y-axis come
   * from magnitude isolines meeting the settle edge, not a separate silhouette.
   */
  showProfile: boolean
  /** Magnitude isoline stroke — primary lobe outlines. */
  contourColor: string
  profileColor: string
  profileWidthPx: number
  contourWidthPx: number
  /** Magnitude isoline levels only (zero is excluded; Flip is separate). */
  contourLevels: number[]
  /** Zero-gamma Flip stroke — secondary polarity boundary. */
  flipContourColor: string
  flipContourWidthPx: number
  flipContourGlowPx: number
  /** Dashed divider between frozen session backplate and forward projection. */
  showProjectionBoundary: boolean
  projectionBoundaryColor: string
  /**
   * Display coordinate for the live/projection divider. The forward model
   * remains anchored to `surface.asOfMs`; this optional presentation anchor
   * lets the divider sit on the active OHLC bar for the selected timeframe.
   */
  projectionBoundaryMs: number | null
  /**
   * 0DTE session open (epoch ms). When set, the bake left-extends τ=now
   * across [sessionStart → asOf] so the field fills the full session window
   * instead of hard-cutting at the live candle. Data model stays pure forward
   * projection for residual; the left pad is the frozen current profile.
   */
  sessionStartMs: number | null
}

/**
 * Single magnitude shell per polarity — multi-level isolines on a continuous
 * ridge draw nested "pipe" tubes.
 */
const FORWARD_MAGNITUDE_LEVELS = [-0.68, -0.42, 0.42, 0.68] as const

const defaultPaint: ForwardSurfacePaintStyle = {
  opacityPct: 50,
  rangePct: 100,
  isLightTheme: false,
  gammaRamp: null,
  showContours: true,
  showFlipContour: true,
  // Off: open Y-axis ends come from magnitude contours at the settle edge.
  showProfile: false,
  // Quiet lobe outline — structure without advertising grid kinks.
  contourColor: 'rgba(228, 238, 250, 0.34)',
  profileColor: 'rgba(170, 190, 215, 0.28)',
  profileWidthPx: 18,
  contourWidthPx: 0.95,
  contourLevels: [...FORWARD_MAGNITUDE_LEVELS],
  // Flip — barely-there polarity hint under lobe shells.
  flipContourColor: 'rgba(196, 210, 228, 0.12)',
  flipContourWidthPx: 0.6,
  flipContourGlowPx: 0,
  showProjectionBoundary: true,
  projectionBoundaryColor: 'rgba(210, 221, 235, 0.28)',
  projectionBoundaryMs: null,
  sessionStartMs: null,
}

/** Dense bake — independent of candle bar spacing. Extra Y rows keep strike pins sharp. */
const TEX_COLS = 256
const TEX_ROWS = 256

type ContourPath = Array<{ x: number; y: number }>

type BakedTexture = {
  canvas: HTMLCanvasElement
  /** Domain time UTC seconds (session open → settle). */
  t0: number
  t1: number
  /** Snapshot as-of (UTC sec); elapsed-session fill freezes this column. */
  asOfSec: number
  /** Price domain (p0 low → p1 high). Texture row0 = p1. */
  p0: number
  p1: number
  cols: number
  rows: number
  /** Magnitude isolines ("Lines") — equal-|GEX| ridges. */
  magnitudePaths: ContourPath[]
  /** Zero-gamma Flip contour — polarity boundary (net GEX = 0). */
  flipPaths: ContourPath[]
  liveCurve: Float32Array
  livePrices: Float32Array
  bakeKey: string
}

/* ── renderer ────────────────────────────────────────────────────────────── */

class ForwardSurfaceRenderer implements IPrimitivePaneRenderer {
  private _tex: BakedTexture
  private _style: ForwardSurfacePaintStyle
  private _series: ISeriesApi<SeriesTypeLoose, Time> | null
  private _chart: IChartApi | null

  constructor(
    tex: BakedTexture,
    style: ForwardSurfacePaintStyle,
    series: ISeriesApi<SeriesTypeLoose, Time> | null,
    chart: IChartApi | null,
  ) {
    this._tex = tex
    this._style = style
    this._series = series
    this._chart = chart
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useBitmapCoordinateSpace((scope) => {
      this._drawImpl(scope)
    })
  }

  private _drawImpl(scope: {
    context: CanvasRenderingContext2D
    horizontalPixelRatio: number
    verticalPixelRatio: number
    bitmapSize: { width: number; height: number }
  }): void {
    const series = this._series
    const chart = this._chart
    if (!series || !chart) return

    const tex = this._tex
    const hRatio = scope.horizontalPixelRatio
    const vRatio = scope.verticalPixelRatio
    const bitmapW = scope.bitmapSize.width
    const bitmapH = scope.bitmapSize.height
    if (bitmapW < 8 || bitmapH < 8) return

    const mediaLeft = 0
    const mediaRight = bitmapW / Math.max(hRatio, 1e-6)
    const mediaTop = 0
    const mediaBottom = bitmapH / Math.max(vRatio, 1e-6)

    // Map surface time domain → media x (session open → settle, edge-anchored).
    const xMap = resolveSurfaceXRange(chart, tex.t0, tex.t1, mediaLeft, mediaRight)
    if (!xMap) return
    const { x0, x1 } = xMap
    if (Math.abs(x1 - x0) < 0.5) return

    // Map surface price domain → media y via the candle price scale (true
    // alignment — never invent y positions that would desync walls from OHLC).
    const yHi = series.priceToCoordinate(tex.p1)
    const yLo = series.priceToCoordinate(tex.p0)
    if (yHi == null || yLo == null) return
    if (Math.abs(yLo - yHi) < 0.5) return

    // Texture UV: col0 = t0, row0 = p1 (high).
    const surfLeft = Math.min(x0, x1)
    const surfRight = Math.max(x0, x1)
    const surfTop = Math.min(yHi, yLo)
    const surfBot = Math.max(yHi, yLo)

    // Field paints through the full surface rect (flush to Y-axis when x1 pins).
    const clipL = Math.max(mediaLeft, surfLeft)
    const clipR = Math.min(mediaRight, surfRight)
    const clipT = Math.max(mediaTop, surfTop)
    const clipB = Math.min(mediaBottom, surfBot)
    if (!(clipR - clipL > 0.5 && clipB - clipT > 0.5)) return

    // UV crop for the clipped rect in media space.
    // x maps linearly: x0→u=0, x1→u=1
    const spanX = x1 - x0
    const spanY = yLo - yHi // positive when high price is above low
    if (Math.abs(spanX) < 1e-6 || Math.abs(spanY) < 1e-6) return

    let u0 = (clipL - x0) / spanX
    let u1 = (clipR - x0) / spanX
    // row0 = high price at yHi → v=0; low price at yLo → v=1
    let v0 = (clipT - yHi) / spanY
    let v1 = (clipB - yHi) / spanY
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
    u0 = clamp01(u0)
    u1 = clamp01(u1)
    v0 = clamp01(v0)
    v1 = clamp01(v1)
    if (!(u1 - u0 > 1e-4 && v1 - v0 > 1e-4)) return

    const texW = tex.canvas.width
    const texH = tex.canvas.height
    const sx = u0 * texW
    const sy = v0 * texH
    const sw = (u1 - u0) * texW
    const sh = (v1 - v0) * texH

    const ctx = scope.context
    ctx.save()
    // High-quality blit is fine once the field is soft kernels + smooth paths.
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(
      tex.canvas,
      sx,
      sy,
      sw,
      sh,
      clipL * hRatio,
      clipT * vRatio,
      (clipR - clipL) * hRatio,
      (clipB - clipT) * vRatio,
    )

    const projectionBoundarySec = resolveProjectionBoundarySec(tex, this._style)
    if (this._style.showProjectionBoundary && projectionBoundarySec > tex.t0 + 1) {
      drawProjectionBoundary(
        ctx,
        hRatio,
        vRatio,
        tex,
        x0,
        x1,
        mediaLeft,
        mediaRight,
        mediaTop,
        mediaBottom,
        this._style.projectionBoundaryColor,
        projectionBoundarySec,
        timeToX(chart, projectionBoundarySec),
      )
    }

    // Flip and magnitude lines are intentionally independent overlays.
    if (this._style.showFlipContour && tex.flipPaths.length > 0) {
      drawContourLayer(
        ctx, hRatio, vRatio, tex, tex.flipPaths, x0, x1, series,
        this._style.flipContourColor, this._style.flipContourWidthPx,
        mediaLeft, mediaRight, mediaTop, mediaBottom, 0.95,
        this._style.flipContourGlowPx,
      )
    }
    if (this._style.showContours && tex.magnitudePaths.length > 0) {
      drawContourLayer(
        ctx, hRatio, vRatio, tex, tex.magnitudePaths, x0, x1, series,
        this._style.contourColor, this._style.contourWidthPx,
        mediaLeft, mediaRight, mediaTop, mediaBottom, 1, 0,
      )
    }

    // Legacy optional fill — off by default. Open Y-axis ends come from
    // magnitude contours kept at the right domain edge, not this silhouette.
    if (this._style.showProfile) {
      drawRightProfileLobes(
        ctx,
        hRatio,
        vRatio,
        series,
        tex,
        mediaRight,
        mediaTop,
        mediaBottom,
        this._style.profileColor,
        this._style.profileWidthPx,
      )
    }

    ctx.restore()
  }
}

class ForwardSurfacePaneView implements IPrimitivePaneView {
  private _source: GexForwardSurfacePrimitive

  constructor(source: GexForwardSurfacePrimitive) {
    this._source = source
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom'
  }

  update(): void {
    // Bake is owned by the primitive; pan/zoom only re-blits in renderer.
  }

  renderer(): IPrimitivePaneRenderer | null {
    const tex = this._source.texture
    if (!tex) return null
    return new ForwardSurfaceRenderer(
      tex,
      this._source.paintStyle,
      this._source.series,
      this._source.chart,
    )
  }
}

/* ── primitive ───────────────────────────────────────────────────────────── */

export class GexForwardSurfacePrimitive implements ISeriesPrimitive<Time> {
  private _surface: GexForwardSurface | null = null
  private _texture: BakedTexture | null = null
  private _bakeKey = ''
  private _paint: ForwardSurfacePaintStyle = { ...defaultPaint }
  private _paneViews: ForwardSurfacePaneView[]
  private _timeAxisView: ISeriesPrimitiveAxisView
  private _timeAxisViews: readonly ISeriesPrimitiveAxisView[]
  private _requestUpdate: (() => void) | null = null
  private _series: ISeriesApi<SeriesTypeLoose, Time> | null = null
  private _chart: IChartApi | null = null

  constructor() {
    this._paneViews = [new ForwardSurfacePaneView(this)]
    this._timeAxisView = {
      coordinate: () => this._nowCoordinate() ?? -10_000,
      text: () => this._projectionTimeLabel(),
      textColor: () => '#d8e1ec',
      backColor: () => 'rgba(28, 32, 40, 0.96)',
      visible: () => this._nowCoordinate() != null,
      tickVisible: () => false,
    }
    this._timeAxisViews = [this._timeAxisView]
  }

  get texture(): BakedTexture | null {
    return this._texture
  }

  get paintStyle(): ForwardSurfacePaintStyle {
    return this._paint
  }

  get series(): ISeriesApi<SeriesTypeLoose, Time> | null {
    return this._series
  }

  get chart(): IChartApi | null {
    return this._chart
  }

  setPaintStyle(style: Partial<ForwardSurfacePaintStyle>): void {
    const prev = this._paint
    this._paint = {
      ...this._paint,
      ...style,
      contourLevels: style.contourLevels
        ? magnitudeContourLevels(style.contourLevels)
        : this._paint.contourLevels,
    }
    // Skip rebake when visual inputs are unchanged (avoids flicker on poll).
    if (
      this._texture
      && this._surface
      && fingerprintSurface(this._surface, this._paint)
        === fingerprintSurface(this._surface, prev)
    ) {
      this._requestUpdate?.()
      return
    }
    this._texture = null
    this._bakeKey = ''
    this._ensureBake()
    this._requestUpdate?.()
  }

  setSurface(surface: GexForwardSurface | null): void {
    if (surface === this._surface) {
      this._requestUpdate?.()
      return
    }
    // Same grid identity (poll with identical times/prices/mid) → keep bake.
    if (
      surface
      && this._surface
      && this._texture
      && fingerprintSurface(surface, this._paint)
        === fingerprintSurface(this._surface, this._paint)
    ) {
      this._surface = surface
      this._requestUpdate?.()
      return
    }
    this._surface = surface
    this._texture = null
    this._bakeKey = ''
    this._ensureBake()
    this._requestUpdate?.()
  }

  clear(): void {
    this.setSurface(null)
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._series = param.series as ISeriesApi<SeriesTypeLoose, Time>
    this._chart = param.chart
    this._requestUpdate = param.requestUpdate
    this._ensureBake()
    this._requestUpdate?.()
  }

  detached(): void {
    this._series = null
    this._chart = null
    this._requestUpdate = null
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews
  }

  timeAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this._timeAxisViews
  }

  updateAllViews(): void {
    for (const v of this._paneViews) v.update()
  }

  private _ensureBake(): void {
    const surface = this._surface
    if (!surface || surface.times.length < 2 || surface.prices.length < 2) {
      this._texture = null
      return
    }
    const key = fingerprintSurface(surface, this._paint)
    if (this._texture && key === this._bakeKey) return
    const colorize = resolveColorizer(this._paint)
    const baked = bakeForwardTexture(surface, colorize, this._paint)
    this._texture = baked
    this._bakeKey = baked ? key : ''
  }

  private _nowCoordinate(): number | null {
    if (!this._chart || !this._texture) return null
    return timeToX(
      this._chart,
      resolveProjectionBoundarySec(this._texture, this._paint),
    )
  }

  private _projectionTimeLabel(): string {
    if (!this._texture) return ''
    return formatProjectionAxisTime(resolveProjectionBoundarySec(this._texture, this._paint))
  }
}

/* ── bake ────────────────────────────────────────────────────────────────── */

/**
 * Pin-surface field bake.
 *
 * Net BS GEX on a dense (S,τ) grid is often a smooth horizontal ridge. Raw
 * isolines of that ridge draw nested "pipe" tubes. We:
 *   1) isolate local price peaks (strike-like modes) per time column
 *   2) hybrid-normalize so settle 1/√τ spikes cannot crush residual
 *   3) contour only compact / residual lobe shells (not full-session pipes)
 */
function bakeForwardTexture(
  surface: GexForwardSurface,
  colorize: (amount: number) => FieldRgba,
  style: ForwardSurfacePaintStyle,
): BakedTexture | null {
  const nT = surface.times.length
  const nP = surface.prices.length
  if (nT < 2 || nP < 2 || surface.values.length < nT) return null

  const timesSec = surface.times.map((t) => (t > 1e12 ? t / 1000 : t))
  const asOfSec = timesSec[0]!
  const settleSec = timesSec[nT - 1]!
  if (!(settleSec > asOfSec)) return null

  // The API owns only a frozen-as-of forward projection. Extend its first
  // column across the elapsed session as a visual backplate; do not imply that
  // this is reconstructed historical positioning.
  const sessionStartSec = style.sessionStartMs != null ? style.sessionStartMs / 1000 : asOfSec
  const t0 = Math.min(asOfSec, sessionStartSec)
  const t1 = settleSec
  if (!(t1 > t0)) return null

  const prices = surface.prices
  const p0 = prices[0]!
  const p1 = prices[nP - 1]!
  if (!(p1 > p0)) return null

  const cols = TEX_COLS
  const rows = TEX_ROWS
  const raw = new Float32Array(cols * rows)
  // Near-settle column for optional legacy profile / open-end reference.
  const colSettle = surface.values[nT - 1]!

  for (let c = 0; c < cols; c++) {
    const u = c / Math.max(cols - 1, 1)
    const t = t0 + (t1 - t0) * u
    const br = t <= asOfSec
      ? { i0: 0, i1: 0, w: 0 }
      : bracketIndex(timesSec, t)
    const i0 = br.i0
    const i1 = br.i1
    const w = br.w
    for (let r = 0; r < rows; r++) {
      const v = r / Math.max(rows - 1, 1)
      const price = p1 + (p0 - p1) * v
      const a = samplePriceColumn(surface.values[i0]!, prices, price)
      const b = samplePriceColumn(surface.values[i1]!, prices, price)
      raw[r * cols + c] = a * (1 - w) + b * w
    }
  }

  // Dual layer:
  //   haze  = continuous net GEX (atmospheric residual fill)
  //   cores = peak-isolated pin lobes (structure + open mouths)
  // Light time continuity before both paths.
  boxBlurAxis(raw, cols, rows, 1, 'x')
  const hazeRaw = new Float32Array(raw)
  // Mild Y soften on haze so residual atmosphere is smooth (not barcode).
  boxBlurAxis(hazeRaw, cols, rows, 1, 'y')
  boxBlurAxis(hazeRaw, cols, rows, 1, 'x')

  isolatePricePeaks(raw, cols, rows)

  // Geometry is normalized once and never depends on the visual Range control.
  // Range only remaps the raster field, so isolines and Flip cannot move.
  const baseCore = hybridUnitNormalize(raw, cols, rows)
  const baseHaze = hybridUnitNormalize(hazeRaw, cols, rows)
  const visualCore = applyVisualRange(baseCore, style.rangePct)
  const visualHaze = applyVisualRange(baseHaze, style.rangePct)
  const field = blendCoreAndHaze(visualCore, visualHaze)

  // Extra time continuity so residual lobes track smoothly (anti-jag).
  boxBlurAxis(field, cols, rows, 2, 'x')
  boxBlurAxis(field, cols, rows, 1, 'x')
  applyElapsedSessionFade(field, cols, rows, t0, t1, asOfSec)
  applyPriceDomainFeather(field, cols, rows)

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

  // Contours on core-weighted field (smoothed) so outlines follow pins, not haze.
  const magnitudePaths: ContourPath[] = []
  let flipPaths: ContourPath[] = []
  if (style.showContours || style.showFlipContour) {
    const contourField = new Float32Array(baseCore)
    // Blend a little haze so residual shells don't look hollow, then smooth.
    for (let i = 0; i < contourField.length; i++) {
      const h = baseHaze[i]!
      const c = contourField[i]!
      const mag = Math.max(Math.abs(c), Math.abs(h) * 0.45)
      const sgn = Math.abs(c) >= Math.abs(h) * 0.45 ? Math.sign(c) || Math.sign(h) : Math.sign(h)
      contourField[i] = sgn * mag
    }
    boxBlurAxis(contourField, cols, rows, 2, 'x')
    boxBlurAxis(contourField, cols, rows, 1, 'y')
    applyPriceDomainFeather(contourField, cols, rows)

    if (style.showContours) {
      const magLevels = magnitudeContourLevels(
        style.contourLevels?.length > 0
          ? style.contourLevels
          : [...FORWARD_MAGNITUDE_LEVELS],
      )
      for (const level of magLevels) {
        const segs = extractContourSegments(contourField, cols, rows, [level])
        magnitudePaths.push(...finalizeContourPaths(segs, cols, rows, 'magnitude'))
      }
    }

    if (style.showFlipContour) {
      // Flip/zero geometry comes from the linearly scaled signed raw field.
      // Contrast normalization is a display concern and must never move zero.
      const flipField = normalizeLinearSignedField(hazeRaw)
      applyPriceDomainFeather(flipField, cols, rows)
      const flipSegs = extractZeroGammaContour(flipField, cols, rows)
        .filter((segment) => zeroCrossingStrength(flipField, cols, rows, segment) >= 0.035)
      flipPaths = finalizeContourPaths(flipSegs, cols, rows, 'flip')
    }
  }

  // Settle-side density (right edge). Used only if showProfile is forced on.
  const liveCurve = new Float32Array(rows)
  const livePrices = new Float32Array(rows)
  for (let r = 0; r < rows; r++) {
    const v = r / Math.max(rows - 1, 1)
    const price = p1 + (p0 - p1) * v
    liveCurve[r] = samplePriceColumn(colSettle, prices, price)
    livePrices[r] = price
  }
  softPeakNormalize1d(liveCurve)
  smooth1d(liveCurve, 1)

  return {
    canvas,
    t0,
    t1,
    asOfSec,
    p0,
    p1,
    cols,
    rows,
    magnitudePaths,
    flipPaths,
    liveCurve,
    livePrices,
    bakeKey: `${nT}:${nP}:${t0}:${t1}:${asOfSec}:${p0.toFixed(0)}:${p1.toFixed(0)}`,
  }
}

type PinPeak = { r: number; v: number; a: number }

/**
 * Rebuild each time column from local |G| maxima as soft pin lobes.
 *
 * Wider gaussians + temporal peak tracking so residual islands are smooth
 * (not jagged when a max jumps a few rows between columns).
 */
function isolatePricePeaks(field: Float32Array, cols: number, rows: number): void {
  // Preserve the continuous price field. The prior peak reconstruction made
  // the surface sparse and lumpy; a light time pass keeps the broad gradient.
  boxBlurAxis(field, cols, rows, 1, 'x')
  return

  /* istanbul ignore next -- retained below for future experiments. */
  if (rows < 8) return
  // Compact luminous cores sit over the continuous haze. This creates the
  // hierarchy visible in high-quality surface charts without deleting context.
  const sigma = Math.max(2.8, rows * 0.028)
  const invTwoSig2 = 1 / (2 * sigma * sigma)
  const minRel = 0.12
  const nms = Math.max(3, Math.round(sigma * 0.9))
  const trackRad = Math.max(4, Math.round(sigma * 1.6))

  // Pass 1: detect NMS peaks per column.
  const perCol: PinPeak[][] = new Array(cols)
  for (let c = 0; c < cols; c++) {
    let colMax = 0
    for (let r = 0; r < rows; r++) {
      const a = Math.abs(field[r * cols + c]!)
      if (a > colMax) colMax = a
    }
    const kept: PinPeak[] = []
    if (!(colMax > 0)) {
      perCol[c] = kept
      continue
    }
    const thr = colMax * minRel
    const peaks: PinPeak[] = []
    for (let r = 1; r < rows - 1; r++) {
      const v = field[r * cols + c]!
      if (!Number.isFinite(v)) continue
      const a = Math.abs(v)
      if (a < thr) continue
      const aL = Math.abs(field[(r - 1) * cols + c]!)
      const aR = Math.abs(field[(r + 1) * cols + c]!)
      if (a < aL || a < aR) continue
      if (a === aL && a === aR) continue
      peaks.push({ r, v, a })
    }
    peaks.sort((p, q) => q.a - p.a)
    for (const p of peaks) {
      let ok = true
      for (const k of kept) {
        if (Math.abs(k.r - p.r) <= nms) {
          ok = false
          break
        }
      }
      if (ok) kept.push(p)
    }
    if (kept.length === 0) {
      let bestR = 0
      let bestA = 0
      let bestV = 0
      for (let r = 0; r < rows; r++) {
        const v = field[r * cols + c]!
        const a = Math.abs(v)
        if (a > bestA) {
          bestA = a
          bestR = r
          bestV = v
        }
      }
      if (bestA > 0) kept.push({ r: bestR, v: bestV, a: bestA })
    }
    perCol[c] = kept
  }

  // Pass 2: temporal track — smooth peak rows L->R then R->L.
  const tracked: PinPeak[][] = perCol.map((list) => list.map((p) => ({ ...p })))
  for (let c = 1; c < cols; c++) {
    const prev = tracked[c - 1]!
    const cur = tracked[c]!
    for (const p of cur) {
      let best: PinPeak | null = null
      let bestD = trackRad + 1
      for (const q of prev) {
        if (Math.sign(q.v) !== Math.sign(p.v) && q.v !== 0 && p.v !== 0) continue
        const d = Math.abs(q.r - p.r)
        if (d < bestD) {
          bestD = d
          best = q
        }
      }
      if (best && bestD <= trackRad) {
        p.r = best!.r * 0.62 + p.r * 0.38
      }
    }
  }
  for (let c = cols - 2; c >= 0; c--) {
    const next = tracked[c + 1]!
    const cur = tracked[c]!
    for (const p of cur) {
      let best: PinPeak | null = null
      let bestD = trackRad + 1
      for (const q of next) {
        if (Math.sign(q.v) !== Math.sign(p.v) && q.v !== 0 && p.v !== 0) continue
        const d = Math.abs(q.r - p.r)
        if (d < bestD) {
          bestD = d
          best = q
        }
      }
      if (best && bestD <= trackRad) {
        p.r = best!.r * 0.45 + p.r * 0.55
      }
    }
  }

  // Pass 3: deposit wide soft gaussians at tracked peaks.
  const out = new Float32Array(field.length)
  for (let c = 0; c < cols; c++) {
    for (const p of tracked[c]!) {
      const rPeak = p.r
      const r0 = Math.max(0, Math.floor(rPeak - sigma * 3.4))
      const r1 = Math.min(rows - 1, Math.ceil(rPeak + sigma * 3.4))
      const amp = Math.sign(p.v) * p.a
      for (let r = r0; r <= r1; r++) {
        const d = r - rPeak
        const g = Math.exp(-d * d * invTwoSig2)
        const idx = r * cols + c
        out[idx] = (out[idx] ?? 0) + amp * g
      }
    }
  }

  boxBlurAxis(out, cols, rows, 2, 'x')
  boxBlurAxis(out, cols, rows, 1, 'x')
  field.set(out)
}

/**
 * Composite pin cores over a soft continuous haze.
 * Cores own structure; haze fills residual so the pane doesn't read as sparse.
 */
function blendCoreAndHaze(core: Float32Array, haze: Float32Array): Float32Array {
  const n = Math.min(core.length, haze.length)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const c = core[i]!
    const h = haze[i]!
    let v = h * 0.22 + c * 0.78
    v = Math.max(-1, Math.min(1, v))
    if (Math.abs(v) < 0.02) v = 0
    out[i] = v
  }
  return out
}

/**
 * Hybrid unit field for forward γ pin-surface.
 *
 * Per-column weight keeps residual τ readable (settle 1/√τ spikes cannot
 * crush the book). After peak isolation, falloff keeps only lobe cores lit.
 */
function hybridUnitNormalize(
  raw: Float32Array,
  cols: number,
  rows: number,
): Float32Array {
  const n = cols * rows
  const out = new Float32Array(n)
  if (n === 0) return out

  let maxAbs = 0
  const absSamples: number[] = []
  for (let i = 0; i < n; i++) {
    const a = Math.abs(raw[i]!)
    if (a > 0 && Number.isFinite(a)) {
      absSamples.push(a)
      if (a > maxAbs) maxAbs = a
    }
  }
  if (!(maxAbs > 0) || absSamples.length === 0) return out

  absSamples.sort((a, b) => a - b)
  const p98 = absSamples[Math.floor((absSamples.length - 1) * 0.98)]!
  // One robust global scale preserves time/price rank. The percentile cap only
  // prevents the final five-minute gamma cliff from blacking out the session.
  const scale = Math.max(p98, maxAbs * 0.06, 1e-12)
  for (let i = 0; i < n; i++) {
    const v = raw[i]!
    if (!Number.isFinite(v) || v === 0) continue
    const ratio = Math.min(1, Math.abs(v) / scale)
    // Fixed SQRT mapping boosts low-magnitude cells so subtle structure reads.
    const mag = Math.sqrt(ratio)
    if (mag < 0.025) continue
    out[i] = Math.sign(v) * ((mag - 0.025) / 0.975)
  }
  return out
}

/**
 * Visual-only Range mapping.
 *
 * 100% uses the robust normalized domain. Lower values tighten that domain
 * (more saturation); higher values widen it (less saturation). Geometry stays
 * fixed, matching a conventional heatmap colour-range control.
 */
function applyVisualRange(base: Float32Array, rangePct: number): Float32Array {
  const range = clamp(
    (Number.isFinite(rangePct) ? rangePct : 100) / 100,
    0.5,
    2,
  )
  const out = new Float32Array(base.length)

  for (let i = 0; i < base.length; i++) {
    const value = base[i]!
    const magnitude = clamp(Math.abs(value) / range, 0, 1)
    if (magnitude < 0.018) continue
    // Gentle fixed gamma keeps weak structure readable without changing the
    // meaning or direction of the domain slider.
    out[i] = Math.sign(value) * Math.pow((magnitude - 0.018) / 0.982, 0.92)
  }
  return out
}

/** Fade only the frozen elapsed-session backplate; forward cells stay full. */
function applyElapsedSessionFade(
  field: Float32Array,
  cols: number,
  rows: number,
  t0: number,
  t1: number,
  asOfSec: number,
): void {
  if (!(t1 > t0) || cols < 2 || rows < 1) return
  const nowU = clamp((asOfSec - t0) / (t1 - t0), 0, 1)
  if (!(nowU > 0.001)) return

  const leftFloor = 0.58

  for (let c = 0; c < cols; c++) {
    const u = c / (cols - 1)
    if (u >= nowU) continue
    const progress = clamp(u / nowU, 0, 1)
    const smooth = progress * progress * (3 - 2 * progress)
    const fade = leftFloor + (1 - leftFloor) * smooth
    for (let r = 0; r < rows; r++) {
      field[r * cols + c] *= fade
    }
  }
}

/**
 * Let a finite price grid disappear into the chart background instead of
 * exposing its first/last row as a hard horizontal slab. The narrow smoothstep
 * collar preserves the interior field and the settle-side lobe geometry.
 */
function applyPriceDomainFeather(
  field: Float32Array,
  cols: number,
  rows: number,
): void {
  if (cols < 1 || rows < 3) return
  const featherRows = Math.max(5, Math.round(rows * 0.075))
  for (let r = 0; r < rows; r++) {
    const distance = Math.min(r, rows - 1 - r)
    if (distance >= featherRows) continue
    const u = clamp(distance / featherRows, 0, 1)
    const fade = u * u * (3 - 2 * u)
    for (let c = 0; c < cols; c++) {
      field[r * cols + c] *= fade
    }
  }
}

/**
 * Filter + chain marching-squares segments into drawable polylines.
 *
 * Magnitude: drop full-session pipe tubes; keep compact lobes and residual
 * open mouths at the settle edge. Chaikin-smooth so shells are not jagged.
 * Flip: interior polarity only (no domain-edge truncation).
 */
function finalizeContourPaths(
  segs: ContourSegment[],
  cols: number,
  rows: number,
  kind: 'magnitude' | 'flip',
): ContourPath[] {
  const filtered =
    kind === 'magnitude'
      ? segs.filter((s) => !isTruncationBoundarySegment(s, cols, rows))
      : segs.filter((s) => !isDomainBoundarySegment(s, cols, rows))
  const paths = chainContourSegments(filtered)
  const kept = paths.filter(
    (path) =>
      !isMicroNoiseIsland(path)
      && (kind !== 'flip' || !isShortOpenFlipStub(path, cols, rows))
      && (kind === 'flip' || !isSessionPipeContour(path, cols, rows)),
  )
  // Flip gets lighter smooth (keep structural walls); magnitude gets full polish.
  const iters = kind === 'magnitude' ? 3 : 2
  return kept.map((path) => chaikinSmooth(path, iters))
}

/**
 * Chaikin corner-cutting — turns marching-squares polylines into smooth curves.
 * Closed paths stay closed; open residual mouths stay open.
 */
function chaikinSmooth(
  path: ContourPath,
  iterations: number,
): ContourPath {
  if (path.length < 3 || iterations < 1) return path
  const a0 = path[0]!
  const aN = path[path.length - 1]!
  const closed = Math.hypot(a0.x - aN.x, a0.y - aN.y) <= 0.85

  let pts = path
  for (let iter = 0; iter < iterations; iter++) {
    if (pts.length < 3) break
    const next: ContourPath = []
    const n = pts.length
    const count = closed ? n : n - 1
    for (let i = 0; i < count; i++) {
      const p0 = pts[i]!
      const p1 = pts[(i + 1) % n]!
      next.push({
        x: 0.75 * p0.x + 0.25 * p1.x,
        y: 0.75 * p0.y + 0.25 * p1.y,
      })
      next.push({
        x: 0.25 * p0.x + 0.75 * p1.x,
        y: 0.25 * p0.y + 0.75 * p1.y,
      })
    }
    if (!closed) {
      // Keep true endpoints so open settle mouths still meet the Y-axis.
      next.unshift({ x: pts[0]!.x, y: pts[0]!.y })
      next.push({ x: pts[n - 1]!.x, y: pts[n - 1]!.y })
    }
    pts = next
  }
  return pts
}

/**
 * Tiny closed islands from marching-squares noise.
 * Open paths (including settle-edge mouths) are never treated as noise.
 */
function isMicroNoiseIsland(path: Array<{ x: number; y: number }>): boolean {
  if (path.length < 3) return true
  if (path.length < 5) return false
  const a = path[0]!
  const b = path[path.length - 1]!
  const closed = Math.hypot(a.x - b.x, a.y - b.y) <= 0.75
  if (!closed) return false
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of path) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const xSpan = maxX - minX
  const ySpan = maxY - minY
  return xSpan < 2.2 && ySpan < 2.2
}

/**
 * Full-session elongated isosurfaces of a continuous GEX ridge — the nested
 * white "pipe" mess. Keep compact / residual-side lobe shells only.
 */
function isSessionPipeContour(
  path: Array<{ x: number; y: number }>,
  cols: number,
  rows: number,
): boolean {
  if (path.length < 6) return false
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of path) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const xSpan = maxX - minX
  const ySpan = maxY - minY
  if (!(xSpan >= 0) || !(ySpan >= 0)) return true

  // Long thin horizontal tubes spanning most of the session.
  const longPipe =
    xSpan > cols * 0.38
    && ySpan < Math.max(10, rows * 0.14)
    && xSpan > ySpan * 2.8

  // Contours that start early (session pad) and run forever — always pipes.
  const earlyTube = minX < cols * 0.22 && xSpan > cols * 0.32

  // Hairline rings with almost no price height.
  const flatRibbon = xSpan > cols * 0.18 && ySpan < 4

  return longPipe || earlyTube || flatRibbon
}

/** Soft-peak 1d normalize for profile lobes (p90 + hard blend). */
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

/* ── draw helpers ────────────────────────────────────────────────────────── */

function drawProjectionBoundary(
  ctx: CanvasRenderingContext2D,
  hRatio: number,
  vRatio: number,
  tex: BakedTexture,
  x0: number,
  x1: number,
  mediaLeft: number,
  mediaRight: number,
  mediaTop: number,
  mediaBottom: number,
  lineColor: string,
  boundarySec: number,
  timeCoordinate: number | null,
) {
  const u = clamp((boundarySec - tex.t0) / Math.max(1e-6, tex.t1 - tex.t0), 0, 1)
  const x = timeCoordinate != null && Number.isFinite(timeCoordinate)
    ? timeCoordinate
    : x0 + (x1 - x0) * u
  if (x <= mediaLeft + 1 || x >= mediaRight - 1) return

  ctx.save()
  ctx.strokeStyle = lineColor
  ctx.lineWidth = Math.max(1, Math.min(hRatio, vRatio))
  ctx.setLineDash([3 * hRatio, 4 * hRatio])
  ctx.beginPath()
  ctx.moveTo(x * hRatio, mediaTop * vRatio)
  ctx.lineTo(x * hRatio, mediaBottom * vRatio)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.restore()
}

function resolveProjectionBoundarySec(
  tex: BakedTexture,
  style: ForwardSurfacePaintStyle,
): number {
  const requested = style.projectionBoundaryMs
  if (requested == null || !Number.isFinite(requested) || requested <= 0) {
    return tex.asOfSec
  }
  return clamp(requested / 1000, tex.t0, tex.t1)
}

function formatProjectionAxisTime(epochSeconds: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(epochSeconds * 1000))
}

/** A meaningful interior zero boundary closes or travels; tiny open dashes are dust. */
function isShortOpenFlipStub(
  path: Array<{ x: number; y: number }>,
  cols: number,
  rows: number,
): boolean {
  if (path.length < 2) return true
  const first = path[0]!
  const last = path[path.length - 1]!
  const closed = Math.hypot(first.x - last.x, first.y - last.y) <= 0.75
  if (closed) return false

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of path) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  return path.length < 8
    || ((maxX - minX) < cols * 0.025 && (maxY - minY) < rows * 0.025)
}

/** Linear signed scale for zero geometry; unlike contrast mapping, zero is invariant. */
function normalizeLinearSignedField(raw: Float32Array): Float32Array {
  const absValues: number[] = []
  let maxAbs = 0
  for (let i = 0; i < raw.length; i++) {
    const value = Math.abs(raw[i]!)
    if (value > 0 && Number.isFinite(value)) {
      absValues.push(value)
      if (value > maxAbs) maxAbs = value
    }
  }
  const out = new Float32Array(raw.length)
  if (!(maxAbs > 0) || absValues.length === 0) return out
  absValues.sort((a, b) => a - b)
  const p96 = absValues[Math.floor((absValues.length - 1) * 0.96)]!
  const scale = Math.max(p96, maxAbs * 0.08, 1e-12)
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i]!
    out[i] = Number.isFinite(value) ? clamp(value / scale, -1, 1) : 0
  }
  return out
}

/** Reject zero contours supported only by numerical dust around the neutral field. */
function zeroCrossingStrength(
  field: Float32Array,
  cols: number,
  rows: number,
  segment: ContourSegment,
): number {
  const col = Math.min(cols - 2, Math.max(0, Math.floor((segment.x0 + segment.x1) * 0.5)))
  const row = Math.min(rows - 2, Math.max(0, Math.floor((segment.y0 + segment.y1) * 0.5)))
  const values = [
    field[row * cols + col]!,
    field[row * cols + col + 1]!,
    field[(row + 1) * cols + col]!,
    field[(row + 1) * cols + col + 1]!,
  ]
  return Math.max(...values) - Math.min(...values)
}

/**
 * Draw one contour layer (magnitude Lines or Flip).
 * Layers are styled independently via color / width / alpha.
 */
function drawContourLayer(
  ctx: CanvasRenderingContext2D,
  hRatio: number,
  vRatio: number,
  tex: BakedTexture,
  paths: ContourPath[],
  x0: number,
  x1: number,
  series: ISeriesApi<SeriesTypeLoose, Time>,
  color: string,
  widthPx: number,
  mediaLeft: number,
  mediaRight: number,
  mediaTop: number,
  mediaBottom: number,
  strokeAlpha: number,
  glowPx: number,
) {
  const pSpan = Math.max(1e-6, tex.p1 - tex.p0)
  // Contours share the surface rect. Right edge is flush so settle-open mouths
  // meet the Y-axis; left/top get a tiny inset to avoid mid-pixel rim clips.
  const surfLeft = Math.min(x0, x1)
  const surfRight = Math.max(x0, x1)
  const fieldLeft = Math.max(mediaLeft, surfLeft) + 0.5
  const fieldRight = Math.min(mediaRight, surfRight)

  const cellToMedia = (cx: number, cy: number): { x: number; y: number } | null => {
    const u = cx / Math.max(tex.cols - 1, 1)
    const v = cy / Math.max(tex.rows - 1, 1)
    const price = tex.p1 - v * pSpan
    const x = x0 + u * (x1 - x0)
    const y = series.priceToCoordinate(price)
    if (y == null) return null
    return { x, y }
  }

  if (!(fieldRight > fieldLeft + 4) || paths.length === 0) return

  ctx.save()
  ctx.beginPath()
  ctx.rect(
    fieldLeft * hRatio,
    mediaTop * vRatio,
    Math.max(1, (fieldRight - fieldLeft) * hRatio),
    (mediaBottom - mediaTop) * vRatio,
  )
  ctx.clip()

  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  // Soft ridge stroke — paths are Chaikin-smoothed in bake; avoid thick harsh rails.
  const lw = Math.max(0.5, widthPx * 0.95) * Math.min(hRatio, vRatio)
  const alpha = clamp01(strokeAlpha)

  const strokePoly = (pts: Array<{ x: number; y: number }>) => {
    if (pts.length < 2) return
    ctx.strokeStyle = color
    ctx.globalAlpha = alpha
    ctx.lineWidth = lw
    ctx.shadowColor = glowPx > 0 ? color : 'transparent'
    ctx.shadowBlur = Math.max(0, glowPx) * Math.min(hRatio, vRatio)
    ctx.beginPath()
    ctx.moveTo(pts[0]!.x * hRatio, pts[0]!.y * vRatio)
    // Quadratic mid-point chains — extra anti-jag on top of Chaikin.
    if (pts.length === 2) {
      ctx.lineTo(pts[1]!.x * hRatio, pts[1]!.y * vRatio)
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const p = pts[i]!
        const n = pts[i + 1]!
        const mx = (p.x + n.x) * 0.5
        const my = (p.y + n.y) * 0.5
        ctx.quadraticCurveTo(p.x * hRatio, p.y * vRatio, mx * hRatio, my * vRatio)
      }
      const last = pts[pts.length - 1]!
      ctx.lineTo(last.x * hRatio, last.y * vRatio)
    }
    ctx.stroke()
  }

  for (const path of paths) {
    if (path.length < 2) continue
    // Break the stroke on out-of-bounds points — never skip-and-reconnect
    // (that invents diagonal white ghosts near the plot edges).
    let run: Array<{ x: number; y: number }> = []
    for (const p of path) {
      const m = cellToMedia(p.x, p.y)
      if (
        !m
        || m.x < fieldLeft - 1
        || m.x > fieldRight + 1
        || m.y < mediaTop - 2
        || m.y > mediaBottom + 2
      ) {
        strokePoly(run)
        run = []
        continue
      }
      run.push(m)
    }
    strokePoly(run)
  }
  ctx.restore()
}

/**
 * True when a marching-squares segment lies on any outer domain boundary.
 * Used for Flip — edge zero-crossings are truncation, not polarity structure.
 */
function isDomainBoundarySegment(
  s: ContourSegment,
  cols: number,
  rows: number,
): boolean {
  const eps = 0.02
  const onLeft = s.x0 <= eps && s.x1 <= eps
  const onRight = s.x0 >= cols - 1 - eps && s.x1 >= cols - 1 - eps
  const onTop = s.y0 <= eps && s.y1 <= eps
  const onBot = s.y0 >= rows - 1 - eps && s.y1 >= rows - 1 - eps
  return onLeft || onRight || onTop || onBot
}

/**
 * Truncation edges for magnitude isolines: drop top / bottom / left domain
 * rims, but KEEP the right (settle) edge so lobe mouths open on the Y-axis.
 */
function isTruncationBoundarySegment(
  s: ContourSegment,
  cols: number,
  rows: number,
): boolean {
  const eps = 0.02
  const onLeft = s.x0 <= eps && s.x1 <= eps
  const onTop = s.y0 <= eps && s.y1 <= eps
  const onBot = s.y0 >= rows - 1 - eps && s.y1 >= rows - 1 - eps
  // Right edge intentionally retained for open-end lobe mouths.
  void cols
  return onLeft || onTop || onBot
}

/**
 * Chain marching-squares edge segments into continuous polylines.
 * Quantize endpoints so linking is O(n) via adjacency buckets.
 */
function chainContourSegments(
  segs: ContourSegment[],
): Array<Array<{ x: number; y: number }>> {
  if (segs.length === 0) return []
  const q = 4 // ~0.25 cell quantize
  const keyOf = (x: number, y: number) =>
    `${Math.round(x * q)},${Math.round(y * q)}`

  // endpoint key → list of (segIdx, end: 0|1)
  const buckets = new Map<string, Array<{ si: number; end: 0 | 1 }>>()
  const add = (k: string, si: number, end: 0 | 1) => {
    let list = buckets.get(k)
    if (!list) {
      list = []
      buckets.set(k, list)
    }
    list.push({ si, end })
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    add(keyOf(s.x0, s.y0), i, 0)
    add(keyOf(s.x1, s.y1), i, 1)
  }

  const used = new Uint8Array(segs.length)
  const paths: Array<Array<{ x: number; y: number }>> = []

  const otherEnd = (si: number, end: 0 | 1): { x: number; y: number } => {
    const s = segs[si]!
    return end === 0 ? { x: s.x1, y: s.y1 } : { x: s.x0, y: s.y0 }
  }

  const takeNext = (
    x: number,
    y: number,
  ): { si: number; end: 0 | 1 } | null => {
    const list = buckets.get(keyOf(x, y))
    if (!list) return null
    for (const item of list) {
      if (!used[item.si]) return item
    }
    return null
  }

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = 1
    const s0 = segs[i]!
    const path: Array<{ x: number; y: number }> = [
      { x: s0.x0, y: s0.y0 },
      { x: s0.x1, y: s0.y1 },
    ]

    // Grow forward from tail.
    for (;;) {
      const tail = path[path.length - 1]!
      const next = takeNext(tail.x, tail.y)
      if (!next) break
      used[next.si] = 1
      const p = otherEnd(next.si, next.end)
      path.push(p)
    }
    // Grow backward from head.
    for (;;) {
      const head = path[0]!
      const next = takeNext(head.x, head.y)
      if (!next) break
      used[next.si] = 1
      const p = otherEnd(next.si, next.end)
      path.unshift(p)
    }
    if (path.length >= 2) paths.push(path)
  }
  return paths
}

/**
 * Legacy right-edge density fill (showProfile). Prefer off.
 *
 * Open Y-axis mouths in the default paint path come from magnitude isolines
 * kept on the settle domain edge — not this silhouette. When forced on, this
 * only paints a very soft settle-column fade (no stroke, no gray bubbles).
 */
function drawRightProfileLobes(
  ctx: CanvasRenderingContext2D,
  hRatio: number,
  vRatio: number,
  series: ISeriesApi<SeriesTypeLoose, Time>,
  tex: BakedTexture,
  mediaRight: number,
  mediaTop: number,
  mediaBottom: number,
  color: string,
  widthPx: number,
) {
  if (tex.liveCurve.length < 4) return

  const gutter = Math.min(36, Math.max(18, widthPx + 6))
  const baseX = mediaRight - 0.5
  const maxW = Math.min(gutter - 6, Math.max(10, widthPx * 0.85))
  // Principal pins only — high threshold so mid-field haze is not re-outlined.
  const thr = 0.45

  type Pt = { y: number; a: number }
  const pts: Pt[] = []
  for (let i = 0; i < tex.liveCurve.length; i++) {
    const y = series.priceToCoordinate(tex.livePrices[i]!)
    if (y == null) continue
    if (y < mediaTop - 2 || y > mediaBottom + 2) continue
    pts.push({ y, a: tex.liveCurve[i]! })
  }
  if (pts.length < 4) return

  const lobes: Pt[][] = []
  let cur: Pt[] = []
  for (const p of pts) {
    if (Math.abs(p.a) >= thr) cur.push(p)
    else if (cur.length) {
      if (cur.length >= 4) lobes.push(cur)
      cur = []
    }
  }
  if (cur.length >= 4) lobes.push(cur)
  if (!lobes.length) return

  const scored = lobes
    .map((lobe) => {
      let peak = 0
      for (const p of lobe) peak = Math.max(peak, Math.abs(p.a))
      return { lobe, peak }
    })
    .sort((a, b) => b.peak - a.peak)
    .slice(0, 5)

  const rgba = parseCssRgba(color) ?? { r: 170, g: 190, b: 215, a: 0.28 }

  ctx.save()
  ctx.beginPath()
  ctx.rect(
    (mediaRight - gutter) * hRatio,
    mediaTop * vRatio,
    gutter * hRatio,
    (mediaBottom - mediaTop) * vRatio,
  )
  ctx.clip()

  for (const { lobe } of scored) {
    const ridge: Array<{ x: number; y: number }> = []
    for (const p of lobe) {
      const mag = Math.abs(p.a)
      const w = Math.pow(mag, 1.15) * maxW
      ridge.push({ x: (baseX - w) * hRatio, y: p.y * vRatio })
    }
    if (ridge.length < 2) continue

    // Soft fill only — never stroke (stroke was the gray/white bubble artifact).
    ctx.beginPath()
    ctx.moveTo(baseX * hRatio, ridge[0]!.y)
    for (let i = 0; i < ridge.length; i++) ctx.lineTo(ridge[i]!.x, ridge[i]!.y)
    ctx.lineTo(baseX * hRatio, ridge[ridge.length - 1]!.y)
    ctx.closePath()

    const xOuter = Math.min(...ridge.map((p) => p.x))
    const xInner = baseX * hRatio
    const grad = ctx.createLinearGradient(xInner, 0, xOuter, 0)
    const peakA = Math.min(0.16, Math.max(0.06, rgba.a * 0.4))
    grad.addColorStop(0, `rgba(${rgba.r},${rgba.g},${rgba.b},${peakA})`)
    grad.addColorStop(0.5, `rgba(${rgba.r},${rgba.g},${rgba.b},${peakA * 0.4})`)
    grad.addColorStop(1, `rgba(${rgba.r},${rgba.g},${rgba.b},0)`)
    ctx.fillStyle = grad
    ctx.globalAlpha = 1
    ctx.fill()
  }
  ctx.restore()
}

/** Parse `rgba(r,g,b,a)` / `rgb(r,g,b)` for profile gradient stops. */
function parseCssRgba(
  css: string,
): { r: number; g: number; b: number; a: number } | null {
  const m =
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i
      .exec(css)
  if (!m) return null
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] != null ? Number(m[4]) : 1,
  }
}

/* ── time scale helpers ──────────────────────────────────────────────────── */

/**
 * Map surface [t0, t1] → media [x0, x1] on the **same** LWC time scale as
 * candles. Must track pan/zoom 1:1 — never stretch the field to the pane
 * edges independently of wall-clock time (that desyncs heatmap from OHLC).
 *
 * When the visible logical range includes the last series bar (settle pin),
 * snap the right edge to the plot's mediaRight so the field sits flush to
 * the Y-axis (no dark gutter between heatmap and price labels).
 */
function resolveSurfaceXRange(
  chart: IChartApi,
  t0: number,
  t1: number,
  mediaLeft: number,
  mediaRight: number,
): { x0: number; x1: number } | null {
  if (!(t1 > t0)) return null
  if (!(mediaRight - mediaLeft > 8)) return null

  let x0 = timeToX(chart, t0)
  let x1 = timeToX(chart, t1)
  // Both ends off-scale / unmapped → nothing to paint this frame.
  if (x0 == null && x1 == null) return null

  // One end still off-screen: extrapolate from the other using the visible
  // time scale slope so residual / pre-open still tracks candles correctly.
  if (x0 == null || x1 == null) {
    const slope = estimatePxPerSec(chart, mediaLeft, mediaRight)
    if (slope == null || !(Math.abs(slope) > 1e-12)) return null
    if (x0 == null && x1 != null) {
      x0 = x1 + (t0 - t1) * slope
    } else if (x1 == null && x0 != null) {
      x1 = x0 + (t1 - t0) * slope
    } else {
      return null
    }
  }

  if (x0 == null || x1 == null) return null
  if (Math.abs(x1 - x0) < 0.5) return null

  // Flush-to-Y: only when settle *actually maps near the pane right edge*.
  // Never pin while zoomed into mid-session (settle off-screen to the right)
  // — that compressed the field and desynced OHLC (zoom glitch).
  try {
    const ts = chart.timeScale()
    const logical = ts.getVisibleLogicalRange()
    // Sub-pixel / half-bar snap only — settle must already be at the edge.
    if (Math.abs(x1 - mediaRight) < 8) {
      x1 = mediaRight
    }
    if (logical && Number.isFinite(logical.from) && logical.from <= 0.05) {
      const xLeftEdge = ts.logicalToCoordinate(logical.from as never)
      if (
        xLeftEdge != null
        && Number.isFinite(xLeftEdge)
        && Math.abs(x0 - xLeftEdge) < 4
        && Math.abs(xLeftEdge - mediaLeft) < 8
      ) {
        x0 = mediaLeft
      }
    }
  } catch {
    // keep raw mapping
  }

  return x1 >= x0 ? { x0, x1 } : { x0: x1, x1: x0 }
}

/**
 * Convert UTC seconds → media x via LWC time scale only.
 * Prefer direct timeToCoordinate so the field pans/zooms with candles.
 */
function timeToX(chart: IChartApi, tSec: number): number | null {
  const ts = chart.timeScale()
  // Integer seconds first (series timestamps are floor(ms/1000)).
  const tInt = Math.floor(tSec)
  try {
    const direct = ts.timeToCoordinate(tInt as UTCTimestamp)
    if (direct != null && Number.isFinite(direct)) return direct
  } catch {
    // fall through
  }
  try {
    const direct = ts.timeToCoordinate(tSec as UTCTimestamp)
    if (direct != null && Number.isFinite(direct)) return direct
  } catch {
    // fall through
  }

  // Extrapolate from logical range when the exact stamp is between bars /
  // slightly outside the indexed set (common for settle pin vs bar step).
  try {
    const logical = ts.getVisibleLogicalRange()
    const visible = ts.getVisibleRange()
    if (logical && visible) {
      const from = timeToSec(visible.from)
      const to = timeToSec(visible.to)
      const xFrom = ts.timeToCoordinate(visible.from)
      const xTo = ts.timeToCoordinate(visible.to)
      if (
        from != null
        && to != null
        && to > from
        && xFrom != null
        && xTo != null
        && Number.isFinite(xFrom)
        && Number.isFinite(xTo)
      ) {
        return xFrom + ((tSec - from) * (xTo - xFrom)) / (to - from)
      }
    }
  } catch {
    // fall through
  }

  try {
    const range = ts.getVisibleRange()
    if (!range) return null
    const from = timeToSec(range.from)
    const to = timeToSec(range.to)
    const xFrom = ts.timeToCoordinate(range.from)
    const xTo = ts.timeToCoordinate(range.to)
    if (
      from == null
      || to == null
      || !(to > from)
      || xFrom == null
      || xTo == null
      || !Number.isFinite(xFrom)
      || !Number.isFinite(xTo)
    ) {
      return null
    }
    return xFrom + ((tSec - from) * (xTo - xFrom)) / (to - from)
  } catch {
    return null
  }
}

/** px per second from the visible time scale (for off-screen domain ends). */
function estimatePxPerSec(
  chart: IChartApi,
  mediaLeft: number,
  mediaRight: number,
): number | null {
  const ts = chart.timeScale()
  try {
    const range = ts.getVisibleRange()
    if (range) {
      const from = timeToSec(range.from)
      const to = timeToSec(range.to)
      const xFrom = ts.timeToCoordinate(range.from)
      const xTo = ts.timeToCoordinate(range.to)
      if (
        from != null
        && to != null
        && to > from
        && xFrom != null
        && xTo != null
        && Number.isFinite(xFrom)
        && Number.isFinite(xTo)
      ) {
        return (xTo - xFrom) / (to - from)
      }
    }
  } catch {
    // fall through
  }
  try {
    const tL = coordinateToSec(ts, mediaLeft + 1)
    const tR = coordinateToSec(ts, mediaRight - 1)
    if (tL != null && tR != null && tR !== tL) {
      return (mediaRight - mediaLeft) / (tR - tL)
    }
  } catch {
    // ignore
  }
  return null
}

function coordinateToSec(
  ts: ReturnType<IChartApi['timeScale']>,
  x: number,
): number | null {
  try {
    const t = ts.coordinateToTime(x as never)
    return t == null ? null : timeToSec(t)
  } catch {
    return null
  }
}

function timeToSec(t: Time): number | null {
  if (typeof t === 'number' && Number.isFinite(t)) return t
  if (typeof t === 'string') {
    const ms = Date.parse(t)
    return Number.isFinite(ms) ? ms / 1000 : null
  }
  return null
}

/* ── field helpers ───────────────────────────────────────────────────────── */

function samplePriceColumn(col: number[], prices: number[], price: number): number {
  if (!col?.length || !prices.length) return 0
  const n = Math.min(col.length, prices.length)
  if (price <= prices[0]!) return col[0] ?? 0
  if (price >= prices[n - 1]!) return col[n - 1] ?? 0
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
  if (n === 1 || t <= sorted[0]!) return { i0: 0, i1: 0, w: 0 }
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
  const s = w * w * (3 - 2 * w)
  return { i0: lo, i1: hi, w: s }
}

/** Separable box blur along one axis (in-place). */
function boxBlurAxis(
  field: Float32Array,
  cols: number,
  rows: number,
  radius: number,
  axis: 'x' | 'y',
) {
  if (radius < 1) return
  const tmp = new Float32Array(field.length)
  if (axis === 'x') {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let sum = 0
        let n = 0
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k
          if (xx < 0 || xx >= cols) continue
          sum += field[y * cols + xx]!
          n++
        }
        tmp[y * cols + x] = n > 0 ? sum / n : 0
      }
    }
  } else {
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        let sum = 0
        let n = 0
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k
          if (yy < 0 || yy >= rows) continue
          sum += field[yy * cols + x]!
          n++
        }
        tmp[y * cols + x] = n > 0 ? sum / n : 0
      }
    }
  }
  field.set(tmp)
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

/**
 * Soft dual-layer colorizer: atmospheric haze fringes + luminous pin cores.
 */
function resolveColorizer(style: ForwardSurfacePaintStyle): (amount: number) => FieldRgba {
  const opacity = clamp(
    (Number.isFinite(style.opacityPct) ? style.opacityPct : 50) / 100,
    0.2,
    1,
  )
  const isLight = Boolean(style.isLightTheme)
  const ramp = style.gammaRamp

  return (amount: number): FieldRgba => {
    const unit = Number.isFinite(amount) ? Math.max(-1, Math.min(1, amount)) : 0
    const mag = Math.abs(unit)
    if (mag < 0.028) return { r: 0, g: 0, b: 0, a: 0 }

    // Smooth atmospheric color with softly luminous higher-magnitude cells.
    const contrastMag = Math.pow(mag, 0.88)
    const sampleT = Math.sign(unit) * contrastMag

    let r: number
    let g: number
    let b: number
    if (ramp && ramp.length > 0) {
      const rgb = sampleGammaRamp(sampleT, ramp)
      r = rgb.r
      g = rgb.g
      b = rgb.b
    } else if (unit >= 0) {
      r = 36
      g = 196
      b = 186
    } else {
      r = 210
      g = 56
      b = 88
    }

    const shaped = Math.pow((mag - 0.028) / 0.972, 0.88)
    const floor = isLight ? 0.04 : 0.05
    const peak = isLight ? 0.84 : 1
    const alpha = Math.min(
      1,
      (floor + shaped * (peak - floor)) * opacity,
    )
    return { r, g, b, a: alpha }
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function fingerprintSurface(
  surface: GexForwardSurface,
  paint: ForwardSurfacePaintStyle,
): string {
  const t0 = surface.times[0]
  const t1 = surface.times[surface.times.length - 1]
  // Sample the full field, not just its midpoint. Two snapshots can share one
  // center value while their strike lobes differ materially; treating those as
  // identical left stale textures in otherwise matching panes.
  let fieldSignature = 2166136261
  const rowStep = Math.max(1, Math.floor(surface.values.length / 11))
  for (let r = 0; r < surface.values.length; r += rowStep) {
    const row = surface.values[r] ?? []
    const colStep = Math.max(1, Math.floor(row.length / 13))
    for (let c = 0; c < row.length; c += colStep) {
      const sample = Number(row[c]) || 0
      const quantized = Math.round(Math.sign(sample) * Math.log1p(Math.abs(sample)) * 1e6)
      fieldSignature ^= quantized
      fieldSignature = Math.imul(fieldSignature, 16777619)
    }
  }
  return [
    surface.times.length,
    surface.prices.length,
    t0,
    t1,
    fieldSignature >>> 0,
    surface.expiry,
    surface.meta.expiryScope,
    surface.meta.metric,
    surface.meta.ivShift,
    paint.opacityPct,
    paint.rangePct,
    paint.isLightTheme ? 1 : 0,
    paint.gammaRamp ? JSON.stringify(paint.gammaRamp) : '',
    paint.showContours ? 1 : 0,
    paint.showFlipContour ? 1 : 0,
    paint.contourLevels?.length ?? 0,
    paint.flipContourGlowPx,
    paint.showProjectionBoundary ? 1 : 0,
    paint.projectionBoundaryColor,
    paint.sessionStartMs ?? '',
  ].join('|')
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}
