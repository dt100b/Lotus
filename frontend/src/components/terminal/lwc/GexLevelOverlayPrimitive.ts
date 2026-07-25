/**
 * Level overlay for the GEX bands price chart.
 *
 * Draws thin horizontal strike / reference lines + right-side labels.
 * Lines render in the bottom layer (above GEX bands, under candles).
 * Labels render above the series so they stay readable over OHLC.
 *
 * Nearby levels (pixel-close) share one line and a combined label,
 * e.g. `NG2 (-3.09m) / MP`.
 *
 * Axis value pills are handled separately via LWC price lines
 * (lineVisible: false, axisLabelVisible: true).
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

export type GexLevelOverlayItem = {
  /** Absolute price of the level. */
  price: number
  /** CSS stroke color (include alpha). */
  color: string
  /** Label fragment, e.g. `PG1 (+5.06m)`, `MP`, `EM −`. */
  title: string
  /** Draw priority when merging (higher wins color / price anchor). */
  priority: number
  /** Optional role for styling (gex / mp / em). */
  role?: 'gex' | 'mp' | 'em'
  /** Optional stronger color for Y-axis strike pills. */
  axisColor?: string
}

/** Pixel gap under which labels/lines are merged. */
const MERGE_PX = 13
/** Right inset from the plot edge for labels (media px). */
const LABEL_RIGHT_PAD = 10
/** Soft label plate so text stays readable over candles. */
const LABEL_BG = 'rgba(10, 12, 16, 0.72)'
const LABEL_FG = 'rgba(210, 216, 224, 0.92)'

type DrawItem = {
  y: number
  color: string
  title: string
}

/** Hairlines only — drawn under the series (above zone fills). */
class GexLevelLineRenderer implements IPrimitivePaneRenderer {
  private _items: DrawItem[] = []

  constructor(items: DrawItem[]) {
    this._items = items
  }

  draw(): void {
    // Lines live in the background pass so candles paint over them.
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    const items = this._items
    if (items.length === 0) return

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context
      const w = scope.bitmapSize.width
      const h = scope.bitmapSize.height
      if (w <= 0 || h <= 0) return

      const hpr = scope.horizontalPixelRatio
      const vpr = scope.verticalPixelRatio
      const lineW = Math.max(1, Math.round(1 * hpr))

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        const y = item.y * vpr
        if (!Number.isFinite(y) || y < -2 || y > h + 2) continue

        ctx.strokeStyle = item.color
        ctx.lineWidth = lineW
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }
    })
  }
}

/** Labels only — drawn above the series so text stays legible over candles. */
class GexLevelLabelRenderer implements IPrimitivePaneRenderer {
  private _items: DrawItem[] = []

  constructor(items: DrawItem[]) {
    this._items = items
  }

  draw(target: CanvasRenderingTarget2D): void {
    const items = this._items
    if (items.length === 0) return

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context
      const w = scope.bitmapSize.width
      const h = scope.bitmapSize.height
      if (w <= 0 || h <= 0) return

      const hpr = scope.horizontalPixelRatio
      const vpr = scope.verticalPixelRatio
      const fontPx = Math.max(9, Math.round(9.5 * hpr))
      ctx.font = `600 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'right'

      const minY = 8 * vpr
      const maxY = h - 8 * vpr
      // Flush to the right plot edge (just left of the Y-axis pills).
      const rightX = w - LABEL_RIGHT_PAD * hpr

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        if (!item.title) continue
        const y = item.y * vpr
        if (!Number.isFinite(y) || y < -2 || y > h + 2) continue
        const cy = Math.min(maxY, Math.max(minY, y))

        const padX = 5 * hpr
        const padY = 2.5 * vpr
        const tw = ctx.measureText(item.title).width
        const boxW = tw + padX * 2
        const boxH = fontPx + padY * 2
        const boxX = rightX - boxW
        const boxY = cy - boxH / 2

        ctx.fillStyle = LABEL_BG
        roundRect(ctx, boxX, boxY, boxW, boxH, 2.5 * hpr)
        ctx.fill()
        ctx.strokeStyle = withAlphaCss(item.color, 0.45)
        ctx.lineWidth = Math.max(1, Math.round(0.75 * hpr))
        ctx.stroke()

        ctx.fillStyle = LABEL_FG
        ctx.fillText(item.title, rightX - padX, cy + 0.5 * vpr)
      }
    })
  }
}

class GexLevelOverlayPaneView implements IPrimitivePaneView {
  private _source: GexLevelOverlayPrimitive
  private _mode: 'lines' | 'labels'
  private _items: DrawItem[] = []

  constructor(source: GexLevelOverlayPrimitive, mode: 'lines' | 'labels') {
    this._source = source
    this._mode = mode
  }

  zOrder(): PrimitivePaneViewZOrder {
    // Lines: same bottom stack as GEX bands (attached after → above fills, under candles).
    // Labels: above series so they stay readable over OHLC.
    return this._mode === 'lines' ? 'bottom' : 'normal'
  }

  update(): void {
    this._items = this._source.mergedDrawItems()
  }

  renderer(): IPrimitivePaneRenderer | null {
    if (this._items.length === 0) return null
    return this._mode === 'lines'
      ? new GexLevelLineRenderer(this._items)
      : new GexLevelLabelRenderer(this._items)
  }
}

export class GexLevelOverlayPrimitive implements ISeriesPrimitive<Time> {
  private _levels: GexLevelOverlayItem[] = []
  private _paneViews: GexLevelOverlayPaneView[]
  private _requestUpdate: (() => void) | null = null
  private _series: ISeriesApi<SeriesTypeLoose, Time> | null = null
  private _mergedCache: DrawItem[] = []

  constructor(levels: GexLevelOverlayItem[] = []) {
    this._levels = sanitizeLevels(levels)
    // Lines first (bottom), labels second (normal).
    this._paneViews = [
      new GexLevelOverlayPaneView(this, 'lines'),
      new GexLevelOverlayPaneView(this, 'labels'),
    ]
  }

  get levels(): readonly GexLevelOverlayItem[] {
    return this._levels
  }

  get series(): ISeriesApi<SeriesTypeLoose, Time> | null {
    return this._series
  }

  setLevels(levels: GexLevelOverlayItem[]): void {
    this._levels = sanitizeLevels(levels)
    this._requestUpdate?.()
  }

  clear(): void {
    this.setLevels([])
  }

  /**
   * Compute merged draw items (shared by line + label views).
   * Cached for the current update cycle so both views stay in sync.
   */
  mergedDrawItems(): DrawItem[] {
    return this._mergedCache
  }

  /**
   * Snapshot of merged axis-anchor prices.
   * Falls back to raw levels when the series is not yet attached.
   */
  axisAnchors(): Array<{ price: number; color: string; title: string }> {
    const series = this._series
    if (!series || this._levels.length === 0) {
      return this._levels.map((l) => ({
        price: l.price,
        color: l.axisColor ?? l.color,
        title: l.title,
      }))
    }

    const clusters = this._clusterPlaced(series)
    return clusters.map((group) => {
      const primary = pickPrimary(group)
      return {
        price: primary.price,
        color: primary.axisColor ?? primary.color,
        title: group.map((g) => g.title).filter(Boolean).join(' / '),
      }
    })
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
    // Rebuild merge cache once, then push into both pane views.
    this._mergedCache = this._buildMergedItems()
    for (const view of this._paneViews) view.update()
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews
  }

  private _buildMergedItems(): DrawItem[] {
    const series = this._series
    if (!series || this._levels.length === 0) return []

    const clusters = this._clusterPlaced(series)
    return clusters.map((group) => {
      const primary = pickPrimary(group)
      return {
        y: primary.y,
        color: primary.color,
        title: group.map((g) => g.title).filter(Boolean).join(' / '),
      }
    })
  }

  private _clusterPlaced(series: ISeriesApi<SeriesTypeLoose, Time>): Array<Array<GexLevelOverlayItem & { y: number }>> {
    type Placed = GexLevelOverlayItem & { y: number }
    const placed: Placed[] = []
    for (const level of this._levels) {
      if (!Number.isFinite(level.price) || level.price <= 0) continue
      const y = series.priceToCoordinate(level.price)
      if (y == null || !Number.isFinite(y)) continue
      placed.push({ ...level, y })
    }
    if (placed.length === 0) return []

    placed.sort((a, b) => a.y - b.y)

    const clusters: Placed[][] = []
    let bucket: Placed[] = [placed[0]!]
    for (let i = 1; i < placed.length; i++) {
      const cur = placed[i]!
      const prev = bucket[bucket.length - 1]!
      if (Math.abs(cur.y - prev.y) <= MERGE_PX) {
        bucket.push(cur)
      } else {
        clusters.push(bucket)
        bucket = [cur]
      }
    }
    clusters.push(bucket)
    return clusters
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SeriesTypeLoose = any

function pickPrimary<T extends { priority: number }>(group: T[]): T {
  let primary = group[0]!
  for (let i = 1; i < group.length; i++) {
    if (group[i]!.priority > primary.priority) primary = group[i]!
  }
  return primary
}

function sanitizeLevels(levels: GexLevelOverlayItem[]): GexLevelOverlayItem[] {
  if (!Array.isArray(levels) || levels.length === 0) return []
  const out: GexLevelOverlayItem[] = []
  for (const level of levels) {
    if (!level) continue
    const price = Number(level.price)
    if (!Number.isFinite(price) || price <= 0) continue
    if (typeof level.color !== 'string' || level.color.length === 0) continue
    if (typeof level.title !== 'string' || level.title.length === 0) continue
    out.push({
      price,
      color: level.color,
      title: level.title,
      priority: Number.isFinite(level.priority) ? level.priority : 0,
      ...(level.role ? { role: level.role } : {}),
      ...(level.axisColor ? { axisColor: level.axisColor } : {}),
    })
  }
  return out
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function withAlphaCss(color: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha))
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(
    color,
  )
  if (rgba) {
    return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${a.toFixed(3)})`
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const n = hex[1]!
    const r = Number.parseInt(n.slice(0, 2), 16)
    const g = Number.parseInt(n.slice(2, 4), 16)
    const b = Number.parseInt(n.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
  }
  return color
}
