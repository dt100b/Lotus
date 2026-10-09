/**
 * Full-width horizontal GEX zone underlay for Lightweight Charts v5.
 *
 * Attaches to the candle series (ISeriesPrimitive). Draws filled price bands
 * from the current GEX surface snapshot — desk "Price / Gamma" language
 * (soft horizontal concentration zones, not a time-varying heatmap).
 *
 * Render modes ({@link GexBandRenderModeId}):
 *  - classic — terraced strike ridges (original desk look)
 *  - field   — continuous 1D density field with wall cores + dual contours
 *
 * Shared design:
 *  - Peak-preserving spatial smooth on the unit surface
 *  - Themeable long/short chroma via {@link GexBandTheme}
 *  - Tight voids (seams, not slabs) + atmospheric grain + wall lighting
 *
 * Usage:
 *   const zones = new GexZonePrimitive()
 *   candleSeries.attachPrimitive(zones)
 *   zones.setPaintStyle({ renderMode: 'field', theme: 'desk', minAlpha, maxAlpha })
 *   zones.setZones(buildGexZonesFromBars(gammaBars, { spot, windowPct: 6 }))
 */

import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts'
import {
  defaultGexBandRenderModeId,
  defaultGexBandThemeId,
  defaultGexBandVoidStyleId,
  getGexBandTheme,
  getThemeMistPalette,
  isGexBandRenderModeId,
  isGexBandVoidStyleId,
  lerpRgb,
  rgbToCss,
  type GexBandMistPalette,
  type GexBandRenderModeId,
  type GexBandTheme,
  type GexBandThemeId,
  type GexBandVoidStyleId,
  type Rgb,
} from '@/data/gexBandThemes'

export type { GexBandRenderModeId, GexBandVoidStyleId }

/** One full-width horizontal band between two prices. */
export type GexZone = {
  /** Lower price bound of the band. */
  low: number
  /** Upper price bound of the band. */
  high: number
  /** CSS fill at band center (include alpha). Solid fallback when edges omit. */
  color: string
  /**
   * Optional CSS fill at the high-price edge (top of pane when price↑).
   * With colorBot, renderer draws a vertical linear gradient for soft blend.
   */
  colorTop?: string
  /**
   * Optional CSS fill at the low-price edge (bottom of pane when price↑).
   */
  colorBot?: string
  /**
   * Optional hairline contour color (strong concentrations only).
   * Drawn at band center as a soft ridge separator — not a full grid.
   */
  contourColor?: string
  /** Optional signed unit GEX in [-1, +1] for tooling / hit tests. */
  amount?: number
  /** Optional source strike for the band center. */
  strike?: number
}

export type GexZoneBar = {
  strike: number
  gammaExposureUsd: number
  callGammaExposureUsd?: number
  putGammaExposureUsd?: number
  netGammaExposureUsd?: number
}

export type BuildGexZonesOptions = {
  /** Spot / index — used with windowPct to crop far OTM noise. */
  spot?: number | null
  /**
   * Keep strikes within ±pct of spot. Pass 'full' or omit to keep all.
   * Default matches heatmap desk window (~6%).
   */
  windowPct?: number | 'full'
  /**
   * Floor / ceiling alpha for |unit GEX| = 0…1 after normalize.
   * Desk underlay is muted so candles stay the primary read.
   */
  minAlpha?: number
  maxAlpha?: number
  /** Skip bands with |unit| below this (void / dead zone). Default 0.02. */
  deadZone?: number
  /**
   * When true, near-zero bands still paint a faint void so the grid of levels
   * reads continuously. Default true (continuous surface).
   */
  paintVoid?: boolean
  /**
   * Spatial smooth passes on unit GEX before colorize (0 = hard steps).
   * Peak-preserving 3-tap — walls keep magnitude. Default 1.
   */
  smoothPasses?: number
  /**
   * Draw soft center hairlines on strong concentrations.
   * Default true. Threshold is relative to |unit| after smooth.
   */
  contours?: boolean
  /** Band / contour chroma theme. Default desk teal/red. */
  theme?: GexBandThemeId | GexBandTheme
}

type ZoneDrawItem = {
  y1: number
  y2: number
  color: string
  colorTop?: string
  colorBot?: string
  contourColor?: string
  /** Signed unit for field sampling (classic ignores). */
  unit?: number
  /** Strike center media-Y for cores/contours. */
  strikeY?: number
}

/** Field sample knot (price + signed unit). */
type FieldKnot = {
  price: number
  unit: number
  y: number
}

export type GexZonePaintStyle = {
  renderMode: GexBandRenderModeId
  theme: GexBandThemeId
  minAlpha: number
  maxAlpha: number
  /** Field HD only — how low-|GEX| voids are emphasized. */
  voidStyle: GexBandVoidStyleId
  /**
   * Field HD Mist fill strength 0…1 (from the mist opacity slider).
   * Does not affect structure colors or zero-ridge seams.
   */
  mistOpacity: number
}

/** |unit| above this gets a soft center contour (Bands / classic mode only). */
const CONTOUR_UNIT = 0.42
/**
 * Surface mode intensity tiers (strike-centered bloom):
 *  - presence: mid structure gets thin secondary ridges (nested anatomy)
 *  - wall: meaningful concentrations get full lit volume bloom
 *
 * Wall floor is intentionally below ~0.5 so a clear #2 level (e.g. −2.1m
 * next to a +3.6m peak → unit ≈ 0.58) still reads as a wall, not quiet mid.
 * Soft density isolines (not strike hairlines) add field contour structure.
 */
const FIELD_PRESENCE_UNIT = 0.14
const FIELD_WALL_UNIT = 0.34

/**
 * Soft field isolines — |unit| levels where a faint density contour is drawn.
 * Continuous field anatomy, not per-strike lines (those stay on the overlay).
 * Sparse set so contours don't grid the pane.
 */
const FIELD_ISO_LEVELS: ReadonlyArray<number> = [0.22, 0.4, 0.58, 0.78]

/**
 * Bands treatment: a quiet full-height terrace, a readable body, and a narrow
 * strike core. The outer layer preserves zone context while the compact inner
 * layers keep the chart feeling like a price chart instead of a heat surface.
 */
const RIDGE_LAYERS: ReadonlyArray<{ heightFrac: number; alphaScale: number }> = [
  { heightFrac: 1.0, alphaScale: 0.3 },
  { heightFrac: 0.62, alphaScale: 0.46 },
  { heightFrac: 0.28, alphaScale: 0.62 },
  { heightFrac: 0.08, alphaScale: 0.72 },
]

/**
 * Surface wall intensity — soft horizontal bloom, source-over only.
 * Outer shell = presence · mid = body · inner = wall weight + rim.
 * Alphas are base values; drawn strength scales with |unit| above FIELD_WALL_UNIT.
 * Slightly denser than pure airbrush so walls read as lit volumes, not flat slabs.
 */
const FIELD_INTENSITY_LAYERS: ReadonlyArray<{ heightPx: number; alpha: number }> = [
  { heightPx: 34, alpha: 0.06 },
  { heightPx: 16, alpha: 0.13 },
  { heightPx: 7, alpha: 0.22 },
  { heightPx: 2.5, alpha: 0.16 },
]

/**
 * Mid-structure presence — thinner/quieter than wall bloom so secondary
 * ridges nest inside big same-sign slabs without competing with true walls.
 */
const FIELD_PRESENCE_LAYERS: ReadonlyArray<{ heightPx: number; alpha: number }> = [
  { heightPx: 11, alpha: 0.055 },
  { heightPx: 3.5, alpha: 0.1 },
]

/** Strata: horizontal micro-bands inside structure only (CSS px period). */
const FIELD_STRATA_PERIOD_CSS = 5
const FIELD_STRATA_MIN_MAG = 0.1

class GexZoneRenderer implements IPrimitivePaneRenderer {
  private _items: ZoneDrawItem[] = []
  private _knots: FieldKnot[] = []
  private _style: GexZonePaintStyle
  private _series: ISeriesApi<SeriesTypeLoose, Time> | null

  constructor(
    items: ZoneDrawItem[],
    knots: FieldKnot[],
    style: GexZonePaintStyle,
    series: ISeriesApi<SeriesTypeLoose, Time> | null,
  ) {
    this._items = items
    this._knots = knots
    this._style = style
    this._series = series
  }

  draw(): void {
    // Main pass left empty — zones live in the background so series/crosshair win.
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    if (this._style.renderMode === 'field') {
      this.drawField(target)
      return
    }
    this.drawClassic(target)
  }

  private drawClassic(target: CanvasRenderingTarget2D): void {
    const items = this._items
    if (items.length === 0) return

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context
      const w = scope.bitmapSize.width
      if (w <= 0 || scope.bitmapSize.height <= 0) return

      const vpr = scope.verticalPixelRatio
      const hpr = scope.horizontalPixelRatio
      const paneH = scope.bitmapSize.height

      for (let i = 0; i < items.length; i++) {
        const z = items[i]!
        const sourceTop = Math.min(z.y1, z.y2) * vpr
        const sourceBot = Math.max(z.y1, z.y2) * vpr
        const cy = (z.strikeY != null ? z.strikeY * vpr : (sourceTop + sourceBot) / 2)
        if (!Number.isFinite(cy)) continue

        // Fixed media-pixel footprint keeps every zone visually locked to its
        // strike while the user pans or zooms. Magnitude changes presence, not
        // the price interval owned by a neighboring strike.
        const magnitude = clamp(Math.abs(z.unit ?? 0), 0, 1)
        const heightCss = 10 + Math.pow(magnitude, 0.68) * 24
        let top = cy - (heightCss * vpr) / 2
        let bot = cy + (heightCss * vpr) / 2
        if (bot < 0 || top > paneH) continue
        top = Math.max(0, top)
        bot = Math.min(paneH, bot)
        const h = bot - top
        if (h < 0.5) continue

        if (h < 4 * vpr) {
          const g = ctx.createLinearGradient(0, top, 0, bot)
          const edge = scaleRgbaAlpha(z.color, 0.4)
          g.addColorStop(0, edge)
          g.addColorStop(0.5, z.color)
          g.addColorStop(1, edge)
          ctx.fillStyle = g
          ctx.fillRect(0, top, w, h)
          continue
        }

        paintRidgeLayers(ctx, w, top, bot, cy, h, z.color, z.colorTop, z.colorBot)
      }

      ctx.lineWidth = Math.max(1, Math.round(1 * hpr))
      ctx.setLineDash([])
      for (let i = 0; i < items.length; i++) {
        const z = items[i]!
        if (!z.contourColor) continue
        const cy = z.strikeY != null
          ? z.strikeY * vpr
          : ((Math.min(z.y1, z.y2) + Math.max(z.y1, z.y2)) / 2) * vpr
        if (!Number.isFinite(cy) || cy < 0 || cy > paneH) continue
        ctx.strokeStyle = z.contourColor
        ctx.beginPath()
        ctx.moveTo(0, cy)
        ctx.lineTo(w, cy)
        ctx.stroke()
      }
    })
  }

  /**
   * Continuous vertical density field (desk-quiet):
   *  1. Sample unit GEX (polarity gaps dip through a narrow void)
   *  2. Soft contrast colorize + mist + scanline grain
   *  3. Structure-only strata micro-bands
   *  4. Mid-structure presence + asymmetric wall bloom
   *  5. Soft field isolines + polarity front glow (no black rails)
   *  6. Film grain
   */
  private drawField(target: CanvasRenderingTarget2D): void {
    const series = this._series
    const knots = this._knots
    if (!series || knots.length === 0) return

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context
      const w = scope.bitmapSize.width
      const paneH = scope.bitmapSize.height
      if (w <= 0 || paneH <= 0) return

      const vpr = scope.verticalPixelRatio
      const hpr = scope.horizontalPixelRatio
      const theme = getGexBandTheme(this._style.theme)
      const minA = this._style.minAlpha
      const maxA = this._style.maxAlpha
      const voidStyle = this._style.voidStyle
      const mistOp = clamp(this._style.mistOpacity, 0, 1)
      const mistPal = getThemeMistPalette(theme)

      // Strike book span + core range where |GEX| is real structure.
      const surfaceLo = knots[0]!.price
      const surfaceHi = knots[knots.length - 1]!.price
      const core = computeGexCoreRange(knots)

      const isoHits: FieldIsoHit[] = []
      const polarityFronts: PolarityFront[] = []
      // Per-row unit samples for strata (bitmap Y → unit)
      const rowUnits = new Float32Array(paneH)
      const rowInSurface = new Uint8Array(paneH)
      rowUnits.fill(0)

      let prevMediaY: number | null = null
      let prevMag: number | null = null
      let prevUnit = 0

      const step = 1
      for (let by = 0; by < paneH; by += step) {
        const mediaY = by / vpr
        let price: number | null = null
        try {
          const p = series.coordinateToPrice(mediaY)
          price = p != null && Number.isFinite(p) ? Number(p) : null
        } catch {
          price = null
        }
        if (price == null) continue

        const unit = sampleFieldUnit(price, knots)
        const inSurface = price >= surfaceLo && price <= surfaceHi
        // Outside the strike book, treat as void for mist wings.
        const mag = inSurface ? Math.abs(unit) : 0
        // Edge fade: full mist only between core GEX high/low; beyond that
        // aggressively fade toward pane top/bottom (cleaner wings).
        const edgeFade =
          voidStyle === 'mist' ? mistEdgeFade(price, core.lo, core.hi, surfaceLo, surfaceHi) : 1

        // Soft valley shade: mid-weak structure between walls sits slightly
        // darker so the field has depth instead of one flat wash.
        const valleyShade = inSurface ? fieldValleyShade(mag) : 0

        const color = fieldColorize(unit, theme, minA, maxA, voidStyle, mistPal, {
          price,
          knots,
          inSurface,
          edgeFade,
          forceVoid: !inSurface && voidStyle === 'mist',
          mistOpacity: mistOp,
          valleyShade,
        })
        if (color) {
          const grain = fieldScanlineGrain(by)
          ctx.fillStyle = grain !== 1 ? scaleRgbaAlpha(color, grain) : color
          ctx.fillRect(0, by, w, step + 0.5)
        }

        rowUnits[by] = unit
        rowInSurface[by] = inSurface ? 1 : 0

        // Density isoline hits — where |unit| crosses an iso level.
        if (inSurface && prevMag != null) {
          collectIsoCrossings(isoHits, prevMag, mag, prevUnit, unit, ((prevMediaY! + mediaY) / 2) * vpr)
        }

        // Polarity front — long/short sign flip (zero corridor center)
        if (inSurface && prevMag != null && prevUnit * unit < 0) {
          polarityFronts.push({
            y: ((prevMediaY! + mediaY) / 2) * vpr,
            unitAbove: prevUnit,
            unitBelow: unit,
          })
        }

        prevMediaY = mediaY
        prevMag = mag
        prevUnit = unit
      }

      // ── 2. Structure-only strata (sedimentary micro-bands) ───────────
      paintFieldStrata(ctx, w, paneH, vpr, rowUnits, rowInSurface, theme)

      // ── 3. Presence + asymmetric wall bloom ──────────────────────────
      for (let i = 0; i < knots.length; i++) {
        const k = knots[i]!
        const mag = Math.abs(k.unit)
        if (mag < FIELD_PRESENCE_UNIT || !Number.isFinite(k.y)) continue
        const cy = k.y * vpr
        if (cy < -40 || cy > paneH + 40) continue

        if (mag >= FIELD_WALL_UNIT) {
          // Linear-ish ramp so unit ~0.55–0.65 already has solid wall weight
          // (was wallT² which left #2 walls nearly invisible).
          const wallT = Math.min(1, (mag - FIELD_WALL_UNIT) / (1 - FIELD_WALL_UNIT))
          const strength = wallT * (0.45 + 0.55 * wallT)
          paintWallIntensity(ctx, w, cy, vpr, k.unit, theme, strength)
        } else {
          const span = Math.max(FIELD_WALL_UNIT - FIELD_PRESENCE_UNIT, 1e-6)
          const pT = Math.min(1, (mag - FIELD_PRESENCE_UNIT) / span)
          const strength = pT * pT * (0.4 + 0.6 * pT)
          paintPresenceRidge(ctx, w, cy, vpr, k.unit, theme, strength)
        }
      }

      // ── 4. Soft field isolines (polarity-tinted, no black rails) ─────
      paintFieldIsolines(ctx, w, paneH, hpr, isoHits, theme)

      // ── 5. Polarity front glow — soft dual wash only, no black stroke ─
      paintPolarityFronts(ctx, w, paneH, hpr, vpr, polarityFronts, theme)

      // ── 6. Film grain ───────────────────────────────────────────────
      paintFieldGrain(ctx, w, paneH)
    })
  }
}

type PolarityFront = {
  y: number
  unitAbove: number
  unitBelow: number
}

type FieldIsoHit = {
  y: number
  unit: number
  level: number
}

/** Record |unit| crossings of FIELD_ISO_LEVELS between two consecutive samples. */
function collectIsoCrossings(
  out: FieldIsoHit[],
  prevMag: number,
  mag: number,
  prevUnit: number,
  unit: number,
  y: number,
): void {
  if (!Number.isFinite(y)) return
  for (let i = 0; i < FIELD_ISO_LEVELS.length; i++) {
    const level = FIELD_ISO_LEVELS[i]!
    const crossed =
      (prevMag < level && mag >= level) || (prevMag >= level && mag < level)
    if (!crossed) continue
    // Prefer the side that is still structure (higher |unit|)
    const useUnit = mag >= prevMag ? unit : prevUnit
    out.push({ y, unit: useUnit, level })
  }
}

function paintRidgeLayers(
  ctx: CanvasRenderingContext2D,
  w: number,
  bandTop: number,
  bandBot: number,
  cy: number,
  bandH: number,
  centerColor: string,
  colorTop: string | undefined,
  colorBot: string | undefined,
): void {
  for (let li = 0; li < RIDGE_LAYERS.length; li++) {
    const layer = RIDGE_LAYERS[li]!
    const half = (bandH * layer.heightFrac) / 2
    let lt = Math.max(bandTop, cy - half)
    let lb = Math.min(bandBot, cy + half)
    const lh = lb - lt
    if (lh < 0.5) continue

    const peak = scaleRgbaAlpha(centerColor, layer.alphaScale)
    const isOuter = li === 0
    const edgeMul = isOuter ? 0.5 : 0.28
    const edgeTop = isOuter
      ? scaleRgbaAlpha(colorTop ?? centerColor, layer.alphaScale * edgeMul)
      : scaleRgbaAlpha(centerColor, layer.alphaScale * edgeMul)
    const edgeBot = isOuter
      ? scaleRgbaAlpha(colorBot ?? centerColor, layer.alphaScale * edgeMul)
      : scaleRgbaAlpha(centerColor, layer.alphaScale * edgeMul)

    const g = ctx.createLinearGradient(0, lt, 0, lb)
    g.addColorStop(0, edgeTop)
    g.addColorStop(0.22, scaleRgbaAlpha(centerColor, layer.alphaScale * 0.7))
    g.addColorStop(0.5, peak)
    g.addColorStop(0.78, scaleRgbaAlpha(centerColor, layer.alphaScale * 0.7))
    g.addColorStop(1, edgeBot)
    ctx.fillStyle = g
    ctx.fillRect(0, lt, w, lh)
  }
}

class GexZonePaneView implements IPrimitivePaneView {
  private _source: GexZonePrimitive
  private _items: ZoneDrawItem[] = []
  private _knots: FieldKnot[] = []

  constructor(source: GexZonePrimitive) {
    this._source = source
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom'
  }

  update(): void {
    const series = this._source.series
    const zones = this._source.zones
    if (!series || zones.length === 0) {
      this._items = []
      this._knots = []
      return
    }

    const out: ZoneDrawItem[] = []
    const knots: FieldKnot[] = []
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i]!
      if (!(z.high > z.low) || !Number.isFinite(z.low) || !Number.isFinite(z.high)) continue
      const yHigh = series.priceToCoordinate(z.high)
      const yLow = series.priceToCoordinate(z.low)
      if (yHigh == null || yLow == null) continue

      const strikePrice =
        z.strike != null && Number.isFinite(z.strike)
          ? z.strike
          : (z.low + z.high) / 2
      const strikeY = series.priceToCoordinate(strikePrice)
      const unit =
        z.amount != null && Number.isFinite(z.amount) ? clamp(z.amount, -1, 1) : 0

      out.push({
        y1: yHigh,
        y2: yLow,
        color: z.color,
        ...(z.colorTop ? { colorTop: z.colorTop } : {}),
        ...(z.colorBot ? { colorBot: z.colorBot } : {}),
        ...(z.contourColor ? { contourColor: z.contourColor } : {}),
        unit,
        ...(strikeY != null && Number.isFinite(strikeY) ? { strikeY } : {}),
      })

      if (strikeY != null && Number.isFinite(strikeY) && Number.isFinite(strikePrice)) {
        knots.push({ price: strikePrice, unit, y: strikeY })
      }
    }
    // Field sampling expects knots sorted by price.
    knots.sort((a, b) => a.price - b.price)
    this._items = out
    this._knots = knots
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (this._items.length === 0) return null
    return new GexZoneRenderer(
      this._items,
      this._knots,
      this._source.paintStyle,
      this._source.series,
    )
  }
}

/**
 * Series primitive: full-width GEX price bands under candles.
 * Call {@link setZones} whenever the GEX surface snapshot changes.
 * Call {@link setPaintStyle} to switch classic / field HD + theme alphas.
 */
export class GexZonePrimitive implements ISeriesPrimitive<Time> {
  private _zones: GexZone[] = []
  private _paneViews: GexZonePaneView[]
  private _requestUpdate: (() => void) | null = null
  private _series: ISeriesApi<SeriesTypeLoose, Time> | null = null
  private _paintStyle: GexZonePaintStyle = {
    renderMode: defaultGexBandRenderModeId,
    theme: defaultGexBandThemeId,
    minAlpha: 0.12,
    maxAlpha: 0.52,
    voidStyle: defaultGexBandVoidStyleId,
    /** Tracks GEX opacity 0…1 (1 = full mist veil). */
    mistOpacity: 1,
  }

  constructor(zones: GexZone[] = []) {
    this._zones = sanitizeZones(zones)
    this._paneViews = [new GexZonePaneView(this)]
  }

  get zones(): readonly GexZone[] {
    return this._zones
  }

  get series(): ISeriesApi<SeriesTypeLoose, Time> | null {
    return this._series
  }

  get paintStyle(): GexZonePaintStyle {
    return this._paintStyle
  }

  setPaintStyle(style: Partial<GexZonePaintStyle>): void {
    const next: GexZonePaintStyle = {
      renderMode: isGexBandRenderModeId(style.renderMode)
        ? style.renderMode
        : this._paintStyle.renderMode,
      theme: style.theme ?? this._paintStyle.theme,
      minAlpha:
        style.minAlpha != null && Number.isFinite(style.minAlpha)
          ? clamp(style.minAlpha, 0.02, 0.95)
          : this._paintStyle.minAlpha,
      maxAlpha:
        style.maxAlpha != null && Number.isFinite(style.maxAlpha)
          ? clamp(style.maxAlpha, 0.02, 0.95)
          : this._paintStyle.maxAlpha,
      voidStyle: isGexBandVoidStyleId(style.voidStyle)
        ? style.voidStyle
        : this._paintStyle.voidStyle,
      mistOpacity:
        style.mistOpacity != null && Number.isFinite(style.mistOpacity)
          ? clamp(style.mistOpacity, 0, 1)
          : this._paintStyle.mistOpacity,
    }
    if (next.maxAlpha < next.minAlpha) next.maxAlpha = next.minAlpha
    this._paintStyle = next
    this._requestUpdate?.()
  }

  setZones(zones: GexZone[]): void {
    this._zones = sanitizeZones(zones)
    this._requestUpdate?.()
  }

  clear(): void {
    this.setZones([])
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._series = param.series as ISeriesApi<SeriesTypeLoose, Time>
    this._requestUpdate = param.requestUpdate
  }

  detached(): void {
    this._series = null
    this._requestUpdate = null
  }

  updateAllViews(): void {
    for (const view of this._paneViews) view.update()
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SeriesTypeLoose = any

function sanitizeZones(zones: GexZone[]): GexZone[] {
  if (!Array.isArray(zones) || zones.length === 0) return []
  const out: GexZone[] = []
  for (const z of zones) {
    if (!z) continue
    const low = Number(z.low)
    const high = Number(z.high)
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) continue
    if (typeof z.color !== 'string' || z.color.length === 0) continue
    out.push({
      low,
      high,
      color: z.color,
      ...(typeof z.colorTop === 'string' && z.colorTop.length > 0 ? { colorTop: z.colorTop } : {}),
      ...(typeof z.colorBot === 'string' && z.colorBot.length > 0 ? { colorBot: z.colorBot } : {}),
      ...(typeof z.contourColor === 'string' && z.contourColor.length > 0
        ? { contourColor: z.contourColor }
        : {}),
      ...(z.amount != null && Number.isFinite(z.amount) ? { amount: z.amount } : {}),
      ...(z.strike != null && Number.isFinite(z.strike) ? { strike: z.strike } : {}),
    })
  }
  return out
}

/**
 * Build full-width price bands from a live GEX strike profile (current surface snapshot).
 *
 * Each strike owns the half-gap to its neighbors; color is signed-unit GEX with
 * themed long/short fills. Unit field is peak-preserving smoothed; edges blend
 * into neighbors. Weak voids get a light nearest-structure tint (color only).
 */
export function buildGexZonesFromBars(
  bars: GexZoneBar[] | null | undefined,
  options: BuildGexZonesOptions = {},
): GexZone[] {
  if (!bars || bars.length === 0) return []

  const minAlpha = clamp(options.minAlpha ?? 0.14, 0.02, 0.9)
  const maxAlpha = clamp(options.maxAlpha ?? 0.48, minAlpha, 0.95)
  const deadZone = clamp(options.deadZone ?? 0.02, 0, 0.5)
  const paintVoid = options.paintVoid !== false
  const smoothPasses = Math.max(0, Math.min(3, Math.round(options.smoothPasses ?? 1)))
  const drawContours = options.contours !== false
  const theme =
    typeof options.theme === 'object' && options.theme != null
      ? options.theme
      : getGexBandTheme(options.theme ?? defaultGexBandThemeId)

  // Fixed soft void bridge (presentation only — amount stays true).
  // Slightly less aggressive void damp so mid-tier net values stay legible
  // while true voids remain quiet.
  const structureMin = 0.1
  const bridgeBelow = 0.12
  const bridgeScale = 0.28
  const distFalloff = 0.35
  const voidDampFloor = 0.38
  const voidDampSpan = 0.36
  const edgeMix = 0.48
  const edgeAlphaRetain = 0.58

  const spot =
    options.spot != null && Number.isFinite(options.spot) && options.spot! > 0
      ? options.spot!
      : null
  const windowPct =
    options.windowPct === 'full' || options.windowPct == null
      ? null
      : Number.isFinite(options.windowPct) && options.windowPct! > 0
        ? options.windowPct!
        : null

  type Row = { strike: number; net: number }
  const rows: Row[] = []
  for (const b of bars) {
    const strike = Number(b.strike)
    if (!Number.isFinite(strike) || strike <= 0) continue
    const netRaw =
      b.netGammaExposureUsd != null && Number.isFinite(b.netGammaExposureUsd)
        ? b.netGammaExposureUsd
        : b.gammaExposureUsd
    const net = Number(netRaw)
    if (!Number.isFinite(net)) continue
    if (spot != null && windowPct != null) {
      const distPct = (Math.abs(strike - spot) / spot) * 100
      if (distPct > windowPct) continue
    }
    rows.push({ strike, net })
  }

  if (rows.length === 0) return []
  rows.sort((a, b) => a.strike - b.strike)

  const deduped: Row[] = []
  for (const r of rows) {
    const prev = deduped[deduped.length - 1]
    if (prev && prev.strike === r.strike) {
      prev.net = r.net
    } else {
      deduped.push({ ...r })
    }
  }

  let maxAbs = 0
  for (const r of deduped) {
    const a = Math.abs(r.net)
    if (a > maxAbs) maxAbs = a
  }
  if (!(maxAbs > 0)) return []

  // Robust soft-peak units: a single far-OTM wall (e.g. 80k on All) must not
  // crush mid-book structure into identical near-void reds/teals.
  let units = robustGexUnits(deduped.map((r) => r.net))
  for (let p = 0; p < smoothPasses; p++) {
    units = smoothUnitsPeakPreserve(units)
  }
  const colorUnits = bridgeWeakColorUnits(units, structureMin, bridgeBelow, bridgeScale, distFalloff)

  const centerColors: string[] = new Array(deduped.length)
  for (let i = 0; i < deduped.length; i++) {
    const trueUnit = units[i]!
    const trueMag = Math.abs(trueUnit)
    const colorUnit = colorUnits[i]!
    const colorMag = Math.abs(colorUnit)
    let c = zoneColor(theme, colorUnit, colorMag, deadZone, minAlpha, maxAlpha, paintVoid)
    if (!c) c = paintVoid ? VOID_COLOR : 'rgba(0,0,0,0)'
    if (trueMag < bridgeBelow) {
      const damp = voidDampFloor + voidDampSpan * (trueMag / Math.max(bridgeBelow, 1e-6))
      c = scaleRgbaAlpha(c, clamp(damp, 0, 1))
    }
    centerColors[i] = c
  }

  const zones: GexZone[] = []
  for (let i = 0; i < deduped.length; i++) {
    const cur = deduped[i]!
    const prev = deduped[i - 1]
    const next = deduped[i + 1]

    let low: number
    let high: number
    if (prev && next) {
      low = (prev.strike + cur.strike) / 2
      high = (cur.strike + next.strike) / 2
    } else if (prev) {
      const gap = cur.strike - prev.strike
      low = (prev.strike + cur.strike) / 2
      high = cur.strike + gap / 2
    } else if (next) {
      const gap = next.strike - cur.strike
      low = cur.strike - gap / 2
      high = (cur.strike + next.strike) / 2
    } else {
      const half = cur.strike * 0.0025
      low = cur.strike - half
      high = cur.strike + half
    }

    if (!(high > low)) continue

    const unit = units[i]!
    const mag = Math.abs(unit)
    if (mag < deadZone && !paintVoid) continue

    const color = centerColors[i]!
    // Same-sign neighbors blend more (flush gradient); polarity edges stay sharper.
    const nextUnit = next ? units[i + 1]! : 0
    const prevUnit = prev ? units[i - 1]! : 0
    const sameTop = next != null && unit * nextUnit > 0
    const sameBot = prev != null && unit * prevUnit > 0
    const emTop = sameTop
      ? Math.min(0.72, edgeMix + (mag < 0.4 ? 0.16 : 0.08))
      : mag > 0.55
        ? Math.min(0.62, edgeMix + 0.06)
        : edgeMix
    const emBot = sameBot
      ? Math.min(0.72, edgeMix + (mag < 0.4 ? 0.16 : 0.08))
      : mag > 0.55
        ? Math.min(0.62, edgeMix + 0.06)
        : edgeMix
    const rawTop = next
      ? mixRgbaCss(color, centerColors[i + 1]!, emTop)
      : mixRgbaCss(color, VOID_COLOR, 0.45)
    const rawBot = prev
      ? mixRgbaCss(color, centerColors[i - 1]!, emBot)
      : mixRgbaCss(color, VOID_COLOR, 0.45)
    const colorTop = scaleRgbaAlpha(rawTop, edgeAlphaRetain)
    const colorBot = scaleRgbaAlpha(rawBot, edgeAlphaRetain)

    const contourColor =
      drawContours && mag >= CONTOUR_UNIT ? contourStroke(theme, unit, mag) : undefined

    zones.push({
      low,
      high,
      color,
      colorTop,
      colorBot,
      ...(contourColor ? { contourColor } : {}),
      amount: unit,
      strike: cur.strike,
    })
  }

  return zones
}

const VOID_COLOR = 'rgba(10, 9, 12, 0.07)'
/**
 * Mist voids: small pure-mist core + longer handoff into structure so
 * void shoulders blend into neighboring zone chroma (not flat charcoal slabs).
 * Below MIST_VOID_CEIL → pure mist (with directional rim bleed).
 * Through MIST_HANDOFF_END → mix into structure ink.
 */
const MIST_VOID_CEIL = 0.045
/** Longer mist→structure blend so edges pick up wall color before full ink. */
const MIST_HANDOFF_END = 0.14

/**
 * Interp signed unit between strike knots.
 * Opposite-sign segments dip through a *narrow* zero corridor so polarity
 * edges stay soft without carving large empty voids. Same-sign gaps keep
 * mild peak bias so walls don't melt into one flat wash.
 */
function sampleFieldUnit(price: number, knots: FieldKnot[]): number {
  const n = knots.length
  if (n === 0) return 0
  if (n === 1) return knots[0]!.unit
  if (price <= knots[0]!.price) return knots[0]!.unit
  if (price >= knots[n - 1]!.price) return knots[n - 1]!.unit

  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (knots[mid]!.price <= price) lo = mid
    else hi = mid
  }
  const a = knots[lo]!
  const b = knots[hi]!
  const span = b.price - a.price
  if (!(span > 0)) return a.unit
  const t = (price - a.price) / span
  const s = t * t * (3 - 2 * t) // smoothstep

  // Opposite polarity → narrow void corridor at the midpoint (not half the gap).
  // ~28% of the span is pure void handoff; structure holds further on each side.
  if (a.unit * b.unit < 0) {
    const voidHalf = 0.14 // half-width of zero corridor in t-space
    const voidLo = 0.5 - voidHalf
    const voidHi = 0.5 + voidHalf
    if (t <= voidLo) {
      // Approach void from a
      const u = t / Math.max(voidLo, 1e-6)
      const e = u * u * (3 - 2 * u)
      return a.unit * (1 - e)
    }
    if (t >= voidHi) {
      // Leave void toward b
      const u = (t - voidHi) / Math.max(1 - voidHi, 1e-6)
      const e = u * u * (3 - 2 * u)
      return b.unit * e
    }
    // Inside corridor — soft zero (void)
    return 0
  }

  // Same sign: flush blend with peak hold so nested ridges survive inside
  // big same-polarity slabs (the "one brick of red" problem).
  const blended = a.unit * (1 - s) + b.unit * s
  const peak = Math.abs(a.unit) >= Math.abs(b.unit) ? a.unit : b.unit
  const peakMag = Math.abs(peak)
  const centerBias = 1 - Math.abs(s - 0.5) * 2 // 1 at knot, 0 at mid-gap
  const peakW =
    peakMag >= 0.45
      ? 0.22 * centerBias
      : peakMag >= 0.2
        ? 0.12 * centerBias
        : peakMag >= FIELD_PRESENCE_UNIT
          ? 0.06 * centerBias
          : 0.02 * centerBias
  return clamp(blended * (1 - peakW) + peak * peakW, -1, 1)
}

type FieldColorCtx = {
  price: number
  knots: FieldKnot[]
  inSurface: boolean
  /** 0…1 envelope — fades mist beyond core GEX high/low toward pane edges. */
  edgeFade: number
  /** Outside strike book: treat as void for mist wings. */
  forceVoid?: boolean
  /** Mist fill strength 0…1 from the mist opacity slider. */
  mistOpacity?: number
  /**
   * Soft valley darken 0…1 for mid-weak structure between walls.
   * Gives the surface depth / lighting instead of a flat wash.
   */
  valleyShade?: number
}

/**
 * Price span where |GEX| is real structure (not void).
 * Mist is full-strength between lo/hi; outside that, edge-fade applies.
 */
function computeGexCoreRange(knots: FieldKnot[]): { lo: number; hi: number } {
  let lo = Infinity
  let hi = -Infinity
  let any = false
  for (let i = 0; i < knots.length; i++) {
    const k = knots[i]!
    if (Math.abs(k.unit) < MIST_VOID_CEIL) continue
    any = true
    if (k.price < lo) lo = k.price
    if (k.price > hi) hi = k.price
  }
  if (!any) {
    return { lo: knots[0]!.price, hi: knots[knots.length - 1]!.price }
  }
  return { lo, hi }
}

/**
 * Aggressive mist opacity fade outside core GEX high/low.
 * Full strength between core.lo…core.hi; beyond that falls off toward
 * (and past) the strike-book ends so top/bottom wings dissolve cleanly.
 */
function mistEdgeFade(
  price: number,
  coreLo: number,
  coreHi: number,
  surfaceLo: number,
  surfaceHi: number,
): number {
  if (price >= coreLo && price <= coreHi) return 1

  const coreSpan = Math.max(coreHi - coreLo, surfaceHi - surfaceLo, 1)
  // Short fade distance → aggressive dissolve (fraction of core/book span).
  const fadeLen = Math.max(coreSpan * 0.22, (coreLo + coreHi) * 0.004)

  if (price > coreHi) {
    const t = (price - coreHi) / fadeLen
    // Power > 2 for aggressive falloff
    return Math.pow(1 - clamp(t, 0, 1), 2.8)
  }
  // price < coreLo
  const t = (coreLo - price) / fadeLen
  return Math.pow(1 - clamp(t, 0, 1), 2.8)
}

/**
 * Field color — desk ink with heatmap hierarchy.
 * Void styles:
 *  - empty: near-black voids
 *  - mist: ice veil in deep voids + light wall bleed; short handoff into structure
 *
 * Void refinements stay local (quiet seams + narrow handoff + mild bleed) so
 * mid/peak wall hierarchy is unchanged.
 */
function fieldColorize(
  unit: number,
  theme: GexBandTheme,
  minAlpha: number,
  maxAlpha: number,
  voidStyle: GexBandVoidStyleId = 'empty',
  mistPal: GexBandMistPalette = getThemeMistPalette(defaultGexBandThemeId),
  ctx?: FieldColorCtx,
): string | null {
  const forceVoid = Boolean(ctx?.forceVoid)
  const mag = forceVoid ? 0 : Math.abs(unit)
  const dead = 0.025
  const edgeFade = ctx?.edgeFade ?? 1
  const mistOp = clamp(ctx?.mistOpacity ?? 1, 0, 1)

  // Outside book without mist — plain void.
  if (ctx && !ctx.inSurface && voidStyle !== 'mist') {
    return VOID_COLOR
  }

  // Outside book with mist — wing veil only.
  if (forceVoid && voidStyle === 'mist' && ctx && edgeFade > 0.015 && mistOp >= 0.01) {
    return mistVoidColor(unit, 0, theme, mistPal, ctx.price, ctx.knots, edgeFade, mistOp)
  }

  const valleyShade = ctx?.valleyShade ?? 0

  // ── Mist core + short handoff (does not wash mag ≥ HANDOFF_END walls) ──
  if (voidStyle === 'mist' && mag < MIST_HANDOFF_END && ctx && edgeFade > 0.015 && mistOp >= 0.01) {
    const mist = mistVoidColor(unit, mag, theme, mistPal, ctx.price, ctx.knots, edgeFade, mistOp)
    // Deep void — pure mist.
    if (mag <= dead || mag < MIST_VOID_CEIL * 0.9) return mist
    // Narrow handoff into full-strength structure (hierarchy intact).
    const struct = structureInkColor(unit, mag, dead, theme, minAlpha, maxAlpha, valleyShade)
    const u = smoothstepUnit(MIST_VOID_CEIL * 0.9, MIST_HANDOFF_END, mag)
    return mixRgbaCss(mist, struct, u)
  }

  if (mag <= dead || forceVoid) {
    return VOID_COLOR
  }

  return structureInkColor(unit, mag, dead, theme, minAlpha, maxAlpha, valleyShade)
}

/** Structure paint only — hierarchy intact, no void feather on mid/peak walls. */
function structureInkColor(
  unit: number,
  mag: number,
  dead: number,
  theme: GexBandTheme,
  minAlpha: number,
  maxAlpha: number,
  valleyShade = 0,
): string {
  const gated = (mag - dead) / (1 - dead)
  const { knee, chromaT } = wallHierarchyShape(Math.min(1, Math.max(0, gated)))
  const alphaHi = Math.min(0.86, maxAlpha * 1.16)
  const alphaLo = Math.max(0.04, minAlpha * 0.9)
  // Valley shade: slightly denser / darker between walls for depth.
  const shade = clamp(valleyShade, 0, 1)
  const a = Math.min(
    0.86,
    Math.max(0.03, (alphaLo + knee * (alphaHi - alphaLo)) * (1 + shade * 0.12)),
  )

  if (unit >= 0) {
    let c = lerpRgb(theme.longMid, theme.longPeak, chromaT)
    if (knee > 0.72) {
      c = lerpRgb(c, theme.contourLong, ((knee - 0.72) / 0.28) * 0.22)
    }
    // Pull mid-weak toward a deeper mid so valleys read lit from walls, not flat.
    if (shade > 0.02 && knee < 0.55) {
      c = lerpRgb(c, { r: 6, g: 10, b: 12 }, shade * 0.28)
    }
    return rgbToCss(c, a)
  }
  let c = lerpRgb(theme.shortMid, theme.shortPeak, chromaT)
  if (knee > 0.72) {
    c = lerpRgb(c, theme.contourShort, ((knee - 0.72) / 0.28) * 0.22)
  }
  if (shade > 0.02 && knee < 0.55) {
    c = lerpRgb(c, { r: 12, g: 6, b: 8 }, shade * 0.3)
  }
  return rgbToCss(c, a)
}

function smoothstepUnit(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-9), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Two-stage density so weak structure stays quiet but clear #2 walls rank.
 *
 * Example after soft-peak normalize (≈ maxAbs book):
 *  - +0.65m / +3.6m ≈ 0.18 unit → knee ~0.20 (quiet)
 *  - −2.1m / +3.6m ≈ 0.58 unit → knee ~0.62, chroma ~0.55 (real wall)
 *  - +3.6m peak → knee 1.0 (full wall ink + core)
 *
 * Weak band (0…pivot) still has mild lift so All-expiry low-negs don't flatten.
 * Chroma is not crushed: secondary walls must outrank mid mush.
 */
function wallHierarchyShape(gated: number): { knee: number; chromaT: number } {
  const g = Math.min(1, Math.max(0, gated))
  /** Below this: soft structure. Above: wall separation steepens. */
  const WALL_PIVOT = 0.28
  let knee: number
  if (g <= WALL_PIVOT) {
    // 0…pivot → 0…0.28 with mild lift (weak hierarchy without peak weight)
    knee = Math.pow(g / WALL_PIVOT, 0.72) * 0.28
  } else {
    // pivot…1 → 0.28…1 — gentler than 1.4 so #2 walls keep rank
    const t = (g - WALL_PIVOT) / (1 - WALL_PIVOT)
    knee = 0.28 + Math.pow(t, 1.12) * 0.72
  }
  // Secondary walls get real peak chroma; only true mush stays near mid.
  const chromaT = Math.min(1, Math.pow(knee, 1.05) * (0.4 + 0.6 * knee))
  return { knee, chromaT }
}

/**
 * Mist fill — voids blend directionally into neighboring zones:
 *  - Core: quiet dim ice (void still recedes)
 *  - Top rim → chroma of structure above (price higher)
 *  - Bottom rim → chroma of structure below (price lower)
 *  - Not a single averaged mud of both neighbors
 *
 * Strength tracks GEX opacity (op=1 = full mist veil).
 */
function mistVoidColor(
  _unit: number,
  mag: number,
  theme: GexBandTheme,
  pal: GexBandMistPalette,
  price: number,
  knots: FieldKnot[],
  edgeFade = 1,
  mistOpacity = 1,
): string {
  // 0 at void center, 1 at mist edge (approaching structure by |unit|)
  const edgeT = clamp(mag / Math.max(MIST_VOID_CEIL, 1e-6), 0, 1)
  const coreT = 1 - edgeT * edgeT
  const op = clamp(mistOpacity, 0, 1)
  if (op < 0.01) return VOID_COLOR

  // Dimmer ice — atmospheric haze, not bright slab
  const iceCore = liftMistRgb(pal.core, 0.38)
  const iceEdge = liftMistRgb(pal.edge, 0.24)
  const base = lerpRgb(iceCore, iceEdge, edgeT * 0.5)

  // Directional neighbor bleed — top/bottom of void pick up adjacent zone color
  const neigh = nearestStructureNeighbors(price, knots)
  let diffused = base
  let rim = 0 // 0 at mid-gap, 1 at either structure edge

  if (neigh.above || neigh.below) {
    // tAbove: 0 at below knot, 1 at above knot (spatial position in the gap)
    let tAbove = 0.5
    if (neigh.above && neigh.below) {
      const span = Math.max(neigh.above.price - neigh.below.price, 1e-9)
      tAbove = clamp((price - neigh.below.price) / span, 0, 1)
    } else if (neigh.above) {
      // Only structure above — fade in as we approach it
      const dist = Math.max(neigh.above.price - price, 0)
      const ref = Math.max(neigh.above.price * 0.004, 1)
      tAbove = 1 - clamp(dist / (ref * 3), 0, 1) * 0.5
    } else if (neigh.below) {
      const dist = Math.max(price - neigh.below.price, 0)
      const ref = Math.max(neigh.below.price * 0.004, 1)
      tAbove = clamp(dist / (ref * 3), 0, 1) * 0.5
    }

    // Strong tint near either wall, quiet in the middle of the void
    rim = Math.abs(tAbove - 0.5) * 2 // 0 center → 1 at edge
    const rimEase = rim * rim // keep core more void-like

    const cA = neigh.above ? structureMidRgb(neigh.above.unit, theme) : null
    const cB = neigh.below ? structureMidRgb(neigh.below.unit, theme) : null

    // Directional mix: bottom of gap → below chroma, top → above chroma
    let nRgb: Rgb
    if (cA && cB) {
      nRgb = lerpRgb(cB, cA, tAbove)
    } else {
      nRgb = (cA ?? cB)!
    }

    // Rim bleed is the main shoulder; |unit| edgeT adds a little near structure
    const diffW = 0.12 + rimEase * 0.58 + edgeT * 0.18
    diffused = lerpRgb(base, nRgb, Math.min(0.78, diffW))
  }

  // Core quieter; rims densify so neighbor chroma has something to ride on
  const a =
    (0.024 + coreT * 0.04 + rim * rim * 0.055 + edgeT * 0.035) *
    clamp(edgeFade, 0, 1) *
    op
  if (a < 0.005) return VOID_COLOR
  return rgbToCss(diffused, Math.min(0.16, a))
}

/** Blend mist RGB toward white so the veil reads ice-light, not gray. */
function liftMistRgb(c: Rgb, amount: number): Rgb {
  const t = clamp(amount, 0, 1)
  return {
    r: Math.round(c.r + (255 - c.r) * t),
    g: Math.round(c.g + (255 - c.g) * t),
    b: Math.round(c.b + (255 - c.b) * t),
  }
}

function structureMidRgb(unit: number, theme: GexBandTheme): Rgb {
  const mag = Math.abs(unit)
  const t = clamp(mag, 0, 1) * 0.55
  return unit >= 0
    ? lerpRgb(theme.longMid, theme.longPeak, t)
    : lerpRgb(theme.shortMid, theme.shortPeak, t)
}

/** Nearest knots with meaningful |GEX| above/below a price (for mist diffusion). */
function nearestStructureNeighbors(
  price: number,
  knots: FieldKnot[],
): { above: FieldKnot | null; below: FieldKnot | null } {
  let below: FieldKnot | null = null
  let above: FieldKnot | null = null
  for (let i = 0; i < knots.length; i++) {
    const k = knots[i]!
    if (Math.abs(k.unit) < MIST_VOID_CEIL * 0.9) continue
    if (k.price <= price) below = k
    if (k.price >= price && !above) {
      above = k
      break
    }
  }
  return { above, below }
}

/**
 * Soft intensity bloom at a meaningful strike — denser fill, not a hairline.
 * Asymmetric lighting: slightly brighter toward the top of the pane (higher
 * price on inverted axis → top of chart), soft AO on the lower skirt.
 */
function paintWallIntensity(
  ctx: CanvasRenderingContext2D,
  w: number,
  cy: number,
  vpr: number,
  unit: number,
  theme: GexBandTheme,
  strength: number,
): void {
  if (strength < 0.04) return
  const s = clamp(strength, 0, 1)
  // Peak walls ride further toward peak chroma; mid walls stay mid-ink
  const chromaT = 0.5 + s * 0.5
  const rgb =
    unit >= 0
      ? lerpRgb(theme.longMid, theme.longPeak, chromaT)
      : lerpRgb(theme.shortMid, theme.shortPeak, chromaT)
  // Slight contour lift only on true peaks (still a fill, not a stroke)
  const peakRgb =
    s > 0.6
      ? lerpRgb(rgb, unit >= 0 ? theme.contourLong : theme.contourShort, (s - 0.6) * 0.4)
      : rgb
  const base = rgbToCss(peakRgb, 0.5)
  // Soft highlight toward contour chroma for the innermost rim
  const rimRgb = lerpRgb(
    peakRgb,
    unit >= 0 ? theme.contourLong : theme.contourShort,
    0.35 + s * 0.25,
  )
  const rim = rgbToCss(rimRgb, 0.55)
  // Cooler/darker AO skirt (asymmetric shadow under the lit rim)
  const aoRgb = lerpRgb(peakRgb, { r: 4, g: 4, b: 6 }, 0.45)
  const ao = rgbToCss(aoRgb, 0.4)

  for (let li = 0; li < FIELD_INTENSITY_LAYERS.length; li++) {
    const layer = FIELD_INTENSITY_LAYERS[li]!
    const isInner = li >= FIELD_INTENSITY_LAYERS.length - 2
    // Outer shells grow a bit with rank; inner stays tight
    const grow =
      li === 0
        ? 0.72 + s * 0.55
        : li === 1
          ? 0.85 + s * 0.38
          : li === 2
            ? 0.95 + s * 0.22
            : 1.0 + s * 0.12
    // Asymmetry: extend slightly further below (AO) than above (lit face)
    const halfUp = ((layer.heightPx * grow) * vpr) / 2
    const halfDn = halfUp * (1.12 + s * 0.08)
    const top = cy - halfUp
    const bot = cy + halfDn
    const a = layer.alpha * (0.38 + s * 0.95)
    const ink = isInner ? rim : base
    const g = ctx.createLinearGradient(0, top, 0, bot)
    // Lit top face → core → soft AO skirt
    g.addColorStop(0, scaleRgbaAlpha(ink, 0.02))
    g.addColorStop(0.18, scaleRgbaAlpha(ink, a * 0.42))
    g.addColorStop(0.42, scaleRgbaAlpha(ink, a * 1.08))
    g.addColorStop(0.55, scaleRgbaAlpha(ink, a))
    g.addColorStop(0.78, scaleRgbaAlpha(ao, a * 0.38))
    g.addColorStop(1, scaleRgbaAlpha(ao, 0.02))
    ctx.fillStyle = g
    ctx.fillRect(0, top, w, bot - top)
  }
}

/**
 * Sedimentary strata — soft horizontal micro-bands inside structure only.
 * Crest lift only (no black trough rails).
 */
function paintFieldStrata(
  ctx: CanvasRenderingContext2D,
  w: number,
  paneH: number,
  vpr: number,
  rowUnits: Float32Array,
  rowInSurface: Uint8Array,
  theme: GexBandTheme,
): void {
  const period = Math.max(3, Math.round(FIELD_STRATA_PERIOD_CSS * vpr))
  ctx.save()
  for (let y = 0; y < paneH; y++) {
    if (!rowInSurface[y]) continue
    const unit = rowUnits[y]!
    const mag = Math.abs(unit)
    if (mag < FIELD_STRATA_MIN_MAG) continue

    const phase = (y % period) / period
    const wave = Math.sin(phase * Math.PI * 2)
    // Crest only — trough darken was reading as black hairlines
    if (wave < 0.2) continue

    const strength = Math.min(1, (mag - FIELD_STRATA_MIN_MAG) / 0.45)
    const a = 0.01 + strength * 0.022 * wave
    const c = unit >= 0 ? theme.contourLong : theme.contourShort
    ctx.fillStyle = rgbToCss(c, a * 0.65)
    ctx.fillRect(0, y, w, 1)
  }
  ctx.restore()
}

/**
 * Polarity front glow — soft dual chroma wash only (no black stroke/seam).
 * Directional void bleed owns the transition; this is a whisper of polarity.
 */
function paintPolarityFronts(
  ctx: CanvasRenderingContext2D,
  w: number,
  paneH: number,
  _hpr: number,
  vpr: number,
  fronts: PolarityFront[],
  theme: GexBandTheme,
): void {
  if (fronts.length === 0) return
  const sorted = fronts.slice().sort((a, b) => a.y - b.y)
  const merged: PolarityFront[] = []
  const minGap = 5 * vpr
  for (const f of sorted) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(f.y - last.y) < minGap) continue
    merged.push(f)
  }

  ctx.save()
  for (const f of merged) {
    if (f.y < -10 || f.y > paneH + 10) continue
    const magA = Math.abs(f.unitAbove)
    const magB = Math.abs(f.unitBelow)
    const strength = clamp((magA + magB) * 0.55, 0.15, 1)
    const half = (4 + strength * 6) * vpr
    const top = f.y - half
    const bot = f.y + half

    const cAbove =
      f.unitAbove >= 0
        ? lerpRgb(theme.longMid, theme.contourLong, 0.55)
        : lerpRgb(theme.shortMid, theme.contourShort, 0.55)
    const cBelow =
      f.unitBelow >= 0
        ? lerpRgb(theme.longMid, theme.contourLong, 0.55)
        : lerpRgb(theme.shortMid, theme.contourShort, 0.55)

    const g = ctx.createLinearGradient(0, top, 0, bot)
    const a = 0.022 + strength * 0.04
    // Continuous dual fade — transparent mid, no black core
    g.addColorStop(0, rgbToCss(cAbove, 0.006))
    g.addColorStop(0.35, rgbToCss(cAbove, a * 0.45))
    g.addColorStop(0.5, rgbToCss(lerpRgb(cAbove, cBelow, 0.5), a * 0.12))
    g.addColorStop(0.65, rgbToCss(cBelow, a * 0.45))
    g.addColorStop(1, rgbToCss(cBelow, 0.006))
    ctx.fillStyle = g
    ctx.fillRect(0, top, w, bot - top)
  }
  ctx.restore()
}

/**
 * Thin secondary ridge for mid-structure strikes (below wall threshold).
 * Nested anatomy inside big same-sign slabs — quiet, no rim flash.
 */
function paintPresenceRidge(
  ctx: CanvasRenderingContext2D,
  w: number,
  cy: number,
  vpr: number,
  unit: number,
  theme: GexBandTheme,
  strength: number,
): void {
  if (strength < 0.05) return
  const s = clamp(strength, 0, 1)
  // Stay near mid chroma — presence must not look like a peak wall
  const chromaT = 0.18 + s * 0.38
  const rgb =
    unit >= 0
      ? lerpRgb(theme.longMid, theme.longPeak, chromaT)
      : lerpRgb(theme.shortMid, theme.shortPeak, chromaT)
  const base = rgbToCss(rgb, 0.45)

  for (let li = 0; li < FIELD_PRESENCE_LAYERS.length; li++) {
    const layer = FIELD_PRESENCE_LAYERS[li]!
    const grow = li === 0 ? 0.8 + s * 0.35 : 0.9 + s * 0.2
    const half = ((layer.heightPx * grow) * vpr) / 2
    const top = cy - half
    const bot = cy + half
    const a = layer.alpha * (0.3 + s * 0.85)
    const g = ctx.createLinearGradient(0, top, 0, bot)
    g.addColorStop(0, scaleRgbaAlpha(base, 0.02))
    g.addColorStop(0.3, scaleRgbaAlpha(base, a * 0.4))
    g.addColorStop(0.5, scaleRgbaAlpha(base, a))
    g.addColorStop(0.7, scaleRgbaAlpha(base, a * 0.4))
    g.addColorStop(1, scaleRgbaAlpha(base, 0.02))
    ctx.fillStyle = g
    ctx.fillRect(0, top, w, bot - top)
  }
}

/**
 * Soft density isolines — faint horizontal contours where |unit| crosses
 * FIELD_ISO_LEVELS. Gives the field internal anatomy without strike gridlines.
 */
function paintFieldIsolines(
  ctx: CanvasRenderingContext2D,
  w: number,
  paneH: number,
  hpr: number,
  hits: FieldIsoHit[],
  theme: GexBandTheme,
): void {
  if (hits.length === 0 || w <= 0) return

  // Merge hits that land on nearly the same Y (same iso, adjacent samples)
  const sorted = hits.slice().sort((a, b) => a.y - b.y || a.level - b.level)
  const merged: FieldIsoHit[] = []
  const minGap = 3.5 * Math.max(1, hpr)
  for (const h of sorted) {
    const last = merged[merged.length - 1]
    if (
      last &&
      Math.abs(h.y - last.y) < minGap &&
      Math.abs(h.level - last.level) < 0.02
    ) {
      // Keep the stronger |unit| sample
      if (Math.abs(h.unit) > Math.abs(last.unit)) {
        merged[merged.length - 1] = h
      }
      continue
    }
    merged.push(h)
  }

  ctx.save()
  ctx.setLineDash([])
  for (const h of merged) {
    if (h.y < 0 || h.y > paneH) continue
    const mag = Math.abs(h.unit)
    // Single soft stroke — no double rail that reads as a hard black line
    const levelT = clamp((h.level - 0.16) / 0.72, 0, 1)
    const a = 0.012 + levelT * 0.022 + Math.min(0.016, mag * 0.014)
    const c = h.unit >= 0 ? theme.contourLong : theme.contourShort
    ctx.strokeStyle = rgbToCss(c, a)
    ctx.lineWidth = Math.max(1, Math.round(1.25 * hpr))
    ctx.beginPath()
    ctx.moveTo(0, h.y)
    ctx.lineTo(w, h.y)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Valley shade 0…1: peaks stay bright, mid-weak structure darkens slightly.
 * Gives soft "lit from walls" depth without inventing new GEX.
 */
function fieldValleyShade(mag: number): number {
  // Peak / secondary walls: no valley shade (don't mute #2 walls).
  // Weak mid structure only: max shade. Pure void: none.
  if (mag < 0.04 || mag > 0.42) return 0
  if (mag < 0.16) {
    return smoothstepUnit(0.04, 0.16, mag) * 0.5
  }
  // 0.16…0.42 → 0.5…0
  return (1 - smoothstepUnit(0.16, 0.42, mag)) * 0.75
}

/** Deterministic scanline alpha jitter (~±6%) — breaks perfect print lines. */
function fieldScanlineGrain(by: number): number {
  // xorshift-ish on integer y
  let h = (by * 374761393 + 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  const u = ((h >>> 0) % 1000) / 1000 // 0…1
  return 0.94 + u * 0.12 // 0.94…1.06
}

/**
 * Sparse film-grain overlay: soft dark/light flecks so the surface feels
 * atmospheric instead of airbrushed. Very low alpha — candles stay primary.
 *
 * Uses a cached tile pattern so we don't scatter fillRect across the full
 * pane every paint (bitmap space can be 2–3× CSS pixels).
 */
let _grainPattern: CanvasPattern | null | undefined
let _grainPatternKey = ''

function paintFieldGrain(ctx: CanvasRenderingContext2D, w: number, paneH: number): void {
  if (w < 8 || paneH < 8) return
  const tile = 64
  const key = 'g64'
  if (_grainPattern === undefined || _grainPatternKey !== key) {
    _grainPatternKey = key
    _grainPattern = null
    try {
      const off = typeof document !== 'undefined' ? document.createElement('canvas') : null
      if (off) {
        off.width = tile
        off.height = tile
        const octx = off.getContext('2d')
        if (octx) {
          for (let y = 0; y < tile; y += 2) {
            const x0 = (y * 3) % 4
            for (let x = x0; x < tile; x += 4) {
              let h = (x * 73856093) ^ (y * 19349663)
              h = Math.imul(h ^ (h >>> 15), 2246822519)
              const u = (h >>> 0) / 4294967295
              if (u > 0.4) continue
              const bright = u > 0.22
              const a = bright ? 0.03 + (u - 0.22) * 0.05 : 0.035 + u * 0.06
              octx.fillStyle = bright
                ? `rgba(220, 228, 232, ${a.toFixed(3)})`
                : `rgba(0, 0, 0, ${a.toFixed(3)})`
              octx.fillRect(x, y, 1, 1)
            }
          }
          _grainPattern = ctx.createPattern(off, 'repeat')
        }
      }
    } catch {
      _grainPattern = null
    }
  }
  if (!_grainPattern) return
  ctx.save()
  // Soften the tile so grain sits under the eye, not on it
  ctx.globalAlpha = 0.55
  ctx.fillStyle = _grainPattern
  ctx.fillRect(0, 0, w, paneH)
  ctx.restore()
}

function zoneColor(
  theme: GexBandTheme,
  unit: number,
  mag: number,
  deadZone: number,
  minAlpha: number,
  maxAlpha: number,
  paintVoid: boolean,
): string | null {
  if (mag < deadZone) {
    if (!paintVoid) return null
    return VOID_COLOR
  }

  const gated = (mag - deadZone) / (1 - deadZone)
  // Match Field HD wall hierarchy so Classic ridges keep net-value rank.
  const { knee, chromaT } = wallHierarchyShape(gated)
  const alpha = minAlpha + knee * (maxAlpha - minAlpha)

  if (unit >= 0) {
    const c = lerpRgb(theme.longMid, theme.longPeak, chromaT)
    return rgbToCss(c, alpha)
  }
  const c = lerpRgb(theme.shortMid, theme.shortPeak, chromaT)
  return rgbToCss(c, alpha)
}

function contourStroke(theme: GexBandTheme, unit: number, mag: number): string {
  const t = Math.min(1, Math.max(0, (mag - CONTOUR_UNIT) / (1 - CONTOUR_UNIT)))
  const a = 0.07 + t * 0.1
  const c = unit >= 0 ? theme.contourLong : theme.contourShort
  return rgbToCss(c, a)
}

/**
 * Soft-peak unit normalize for GEX strike books.
 *
 * Pure maxAbs maps a dominant far strike (common on All-expiry) to 1 and
 * collapses the rest of the book into near-identical low units — the flat
 * red slab problem. Soft-peak uses ~p92 so mid structure keeps rank.
 *
 * Soft and hard (maxAbs) units are blended with peak bias so a +3m wall
 * still clearly outranks a +0.65m sibling after colorize.
 */
function robustGexUnits(nets: number[]): number[] {
  const n = nets.length
  if (n === 0) return []

  const absSorted: number[] = []
  let maxAbs = 0
  for (let i = 0; i < n; i++) {
    const a = Math.abs(nets[i]!)
    if (!(a > 0) || !Number.isFinite(a)) continue
    absSorted.push(a)
    if (a > maxAbs) maxAbs = a
  }
  if (!(maxAbs > 0) || absSorted.length === 0) {
    return nets.map(() => 0)
  }

  absSorted.sort((a, b) => a - b)
  const pIdx = Math.min(
    absSorted.length - 1,
    Math.max(0, Math.floor((absSorted.length - 1) * 0.92)),
  )
  const p92 = absSorted[pIdx]!
  const softPeak = Math.max(p92, maxAbs * 0.28)

  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const net = nets[i]!
    if (!Number.isFinite(net) || net === 0) {
      out[i] = 0
      continue
    }
    const a = Math.abs(net)
    const hard = a / maxAbs
    const r = a / softPeak
    let soft: number
    if (r <= 1) {
      soft = r
    } else {
      soft = 1 - 1 / (1 + (r - 1) * 2.0)
      if (a >= maxAbs * 0.995) soft = 1
      soft = Math.min(1, soft)
    }
    // Lerp soft→hard by |hard|: weak structure keeps soft lift; peaks stay honest.
    // 0.65/3 ≈ 0.22 → mag ≈ 0.24; 3/3 = 1 → mag = 1 (clear wall separation).
    const mag = soft * (1 - hard * 0.55) + hard * (hard * 0.55)
    out[i] = Math.sign(net) * clamp(mag, 0, 1)
  }
  return out
}

function smoothUnitsPeakPreserve(units: number[]): number[] {
  const n = units.length
  if (n < 3) return units.slice()
  const out = new Array<number>(n)
  out[0] = units[0]!
  out[n - 1] = units[n - 1]!
  for (let i = 1; i < n - 1; i++) {
    const raw = units[i]!
    const blended = units[i - 1]! * 0.18 + raw * 0.64 + units[i + 1]! * 0.18
    if (Math.abs(raw) >= Math.abs(blended)) {
      out[i] = Math.sign(raw || blended) * Math.abs(raw)
    } else {
      out[i] = blended
    }
  }
  return out
}

/**
 * Color-only bridge for weak voids from nearest real structure.
 * Does not change stored amount — presentation continuity only.
 */
function bridgeWeakColorUnits(
  units: number[],
  structureMin: number,
  bridgeBelow: number,
  bridgeScale: number,
  distFalloff: number,
): number[] {
  const n = units.length
  if (n === 0 || !(bridgeBelow > 0)) return units.slice()
  const scale = clamp(bridgeScale, 0, 1)
  const sMin = Math.max(structureMin, bridgeBelow)
  const fall = Math.max(0.05, distFalloff)

  const leftStrong = new Array<number>(n)
  const rightStrong = new Array<number>(n)
  let last = -1
  for (let i = 0; i < n; i++) {
    if (Math.abs(units[i]!) >= sMin) last = i
    leftStrong[i] = last
  }
  last = -1
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(units[i]!) >= sMin) last = i
    rightStrong[i] = last
  }

  const out = units.slice()
  for (let i = 0; i < n; i++) {
    const u = units[i]!
    const mag = Math.abs(u)
    if (mag >= bridgeBelow) continue

    const li = leftStrong[i]!
    const ri = rightStrong[i]!
    let bridged = 0
    if (li >= 0 && ri >= 0) {
      const dL = i - li
      const dR = ri - i
      const span = dL + dR
      const wL = span > 0 ? dR / span : 0.5
      const wR = 1 - wL
      const minDist = Math.min(dL, dR)
      const distMul = 1 / (1 + minDist * fall)
      bridged = (units[li]! * wL + units[ri]! * wR) * scale * distMul
    } else if (li >= 0) {
      const distMul = 1 / (1 + (i - li) * fall)
      bridged = units[li]! * scale * 0.85 * distMul
    } else if (ri >= 0) {
      const distMul = 1 / (1 + (ri - i) * fall)
      bridged = units[ri]! * scale * 0.85 * distMul
    } else {
      continue
    }

    const cap = 0.38
    if (Math.abs(bridged) > cap) bridged = Math.sign(bridged) * cap

    const t = mag / bridgeBelow
    out[i] = u * t + bridged * (1 - t)
  }
  return out
}

function mixRgbaCss(a: string, b: string, t: number): string {
  const ca = parseRgba(a)
  const cb = parseRgba(b)
  if (!ca || !cb) return a
  const u = clamp(t, 0, 1)
  const r = Math.round(ca.r + (cb.r - ca.r) * u)
  const g = Math.round(ca.g + (cb.g - ca.g) * u)
  const bl = Math.round(ca.b + (cb.b - ca.b) * u)
  const al = ca.a + (cb.a - ca.a) * u
  return `rgba(${r}, ${g}, ${bl}, ${al.toFixed(3)})`
}

function scaleRgbaAlpha(color: string, factor: number): string {
  const c = parseRgba(color)
  if (!c) return color
  const a = Math.max(0, Math.min(1, c.a * factor))
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a.toFixed(3)})`
}

function parseRgba(color: string): { r: number; g: number; b: number; a: number } | null {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(
    color,
  )
  if (!m) return null
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] != null ? Number(m[4]) : 1,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}
