/**
 * Full-width horizontal GEX zone underlay for Lightweight Charts v5.
 *
 * Attaches to the candle series (ISeriesPrimitive). Draws filled price bands
 * from the current GEX surface snapshot — same visual language as desk
 * "Price / Gamma" overlays (solid horizontal rectangles, not a time-varying heatmap).
 *
 * Usage:
 *   const zones = new GexZonePrimitive()
 *   candleSeries.attachPrimitive(zones)
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

/** One full-width horizontal band between two prices. */
export type GexZone = {
  /** Lower price bound of the band. */
  low: number
  /** Upper price bound of the band. */
  high: number
  /** CSS fill (include alpha). */
  color: string
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
   * Desk underlay is muted (~0.10–0.28) so candles stay the primary read.
   */
  minAlpha?: number
  maxAlpha?: number
  /** Skip bands with |unit| below this (void / dead zone). Default 0.04. */
  deadZone?: number
  /**
   * When true, near-zero bands still paint a faint void so the grid of levels
   * reads continuously. Default false (transparent zero).
   */
  paintVoid?: boolean
}

type ZoneDrawItem = {
  y1: number
  y2: number
  color: string
}

class GexZoneRenderer implements IPrimitivePaneRenderer {
  private _items: ZoneDrawItem[] = []

  constructor(items: ZoneDrawItem[]) {
    this._items = items
  }

  draw(): void {
    // Main pass left empty — zones live in the background so series/crosshair win.
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    const items = this._items
    if (items.length === 0) return

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context
      const w = scope.bitmapSize.width
      if (w <= 0 || scope.bitmapSize.height <= 0) return

      const vpr = scope.verticalPixelRatio
      // Bitmap-space rects; clamp to pane so off-screen bands don't overdraw.
      const paneH = scope.bitmapSize.height

      for (let i = 0; i < items.length; i++) {
        const z = items[i]!
        // Map media y → bitmap y (inclusive edge rounding keeps bands flush).
        let top = Math.min(z.y1, z.y2) * vpr
        let bot = Math.max(z.y1, z.y2) * vpr
        if (!Number.isFinite(top) || !Number.isFinite(bot)) continue
        // Cull fully off-screen.
        if (bot < 0 || top > paneH) continue
        top = Math.max(0, top)
        bot = Math.min(paneH, bot)
        const h = bot - top
        if (h < 0.5) continue

        ctx.fillStyle = z.color
        ctx.fillRect(0, top, w, h)
      }
    })
  }
}

class GexZonePaneView implements IPrimitivePaneView {
  private _source: GexZonePrimitive
  private _items: ZoneDrawItem[] = []

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
      return
    }

    const out: ZoneDrawItem[] = []
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i]!
      if (!(z.high > z.low) || !Number.isFinite(z.low) || !Number.isFinite(z.high)) continue
      const yHigh = series.priceToCoordinate(z.high)
      const yLow = series.priceToCoordinate(z.low)
      if (yHigh == null || yLow == null) continue
      out.push({ y1: yHigh, y2: yLow, color: z.color })
    }
    this._items = out
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (this._items.length === 0) return null
    return new GexZoneRenderer(this._items)
  }
}

/**
 * Series primitive: full-width GEX price bands under candles.
 * Call {@link setZones} whenever the GEX surface snapshot changes.
 */
export class GexZonePrimitive implements ISeriesPrimitive<Time> {
  private _zones: GexZone[] = []
  private _paneViews: GexZonePaneView[]
  private _requestUpdate: (() => void) | null = null
  private _series: ISeriesApi<SeriesTypeLoose, Time> | null = null

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

  /** Replace zone list and request a redraw. */
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

/** Loose series type so the primitive can attach to Candlestick (or others). */
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
 * desk-style teal (long) / red (short) fills; alpha spans weak → wall for contrast.
 */
export function buildGexZonesFromBars(
  bars: GexZoneBar[] | null | undefined,
  options: BuildGexZonesOptions = {},
): GexZone[] {
  if (!bars || bars.length === 0) return []

  const minAlpha = clamp(options.minAlpha ?? 0.1, 0.02, 0.9)
  const maxAlpha = clamp(options.maxAlpha ?? 0.28, minAlpha, 0.95)
  const deadZone = clamp(options.deadZone ?? 0.04, 0, 0.5)
  const paintVoid = Boolean(options.paintVoid)

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

  // Collect finite strikes + net GEX (prefer explicit net, else gammaExposureUsd).
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

  // De-dupe identical strikes (keep last).
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

  // Half-gap zone bounds — standard strike-band construction.
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
      // Top of book — mirror last gap.
      const gap = cur.strike - prev.strike
      low = (prev.strike + cur.strike) / 2
      high = cur.strike + gap / 2
    } else if (next) {
      const gap = next.strike - cur.strike
      low = cur.strike - gap / 2
      high = (cur.strike + next.strike) / 2
    } else {
      // Single strike — synthetic ±0.25% band around it.
      const half = cur.strike * 0.0025
      low = cur.strike - half
      high = cur.strike + half
    }

    if (!(high > low)) continue

    const unit = clamp(cur.net / maxAbs, -1, 1)
    const mag = Math.abs(unit)
    if (mag < deadZone && !paintVoid) continue

    const color = zoneColor(unit, mag, deadZone, minAlpha, maxAlpha, paintVoid)
    if (!color) continue

    zones.push({
      low,
      high,
      color,
      amount: unit,
      strike: cur.strike,
    })
  }

  return zones
}

/**
 * Zone banding palette (desk Price/Gamma underlay):
 * short-gamma → muted red/brown, long-gamma → dark teal.
 * Low overall opacity; chroma stays deep so bands read without washing candles.
 */
function zoneColor(
  unit: number,
  mag: number,
  deadZone: number,
  minAlpha: number,
  maxAlpha: number,
  paintVoid: boolean,
): string | null {
  if (mag < deadZone) {
    if (!paintVoid) return null
    return 'rgba(14, 12, 16, 0.08)'
  }

  // Mild curve — mid walls still visible under low total alpha.
  const gated = (mag - deadZone) / (1 - deadZone)
  const shaped = Math.pow(Math.min(1, Math.max(0, gated)), 0.65)
  const alpha = minAlpha + shaped * (maxAlpha - minAlpha)

  if (unit >= 0) {
    // Long gamma — deep teal (reference desk cool bands)
    // Soft mid → peak: (14, 42, 48) → (22, 88, 82)
    const t = shaped
    const r = Math.round(14 + (22 - 14) * t)
    const g = Math.round(42 + (88 - 42) * t)
    const b = Math.round(48 + (82 - 48) * t)
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
  }

  // Short gamma — deep red-brown (muted, not neon)
  // Soft mid → peak: (72, 22, 24) → (120, 32, 36)
  const t = shaped
  const r = Math.round(72 + (120 - 72) * t)
  const g = Math.round(22 + (32 - 22) * t)
  const b = Math.round(24 + (36 - 24) * t)
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}
