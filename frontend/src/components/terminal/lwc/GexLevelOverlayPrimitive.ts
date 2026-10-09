/**
 * Level overlay for the GEX bands price chart.
 *
 * Draws thin horizontal strike / reference lines + right-side text labels.
 * Lines render in the bottom layer (above GEX bands, under candles).
 * Labels / meters render above the series so they stay readable over OHLC.
 *
 * Density policy (esp. All-mode when zoomed out):
 *  - Hairlines: one per distinct strike (only collapse true pixel-duplicates)
 *  - Labels: priority packing with merge — colliding chips join as
 *    `+1.2m / EM` or `+1.2m / MP` (GEX value first when present)
 *  - Line priority: HVL / MP beat GEX; EM is lowest (label merge only)
 *  - Coordinates recompute every pan/zoom (not a stale cache)
 *
 * Axis value labels are handled separately via LWC price lines
 * (lineVisible: false, axisLabelVisible: true) — price-only; role tags here.
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

export type GexLevelRole = 'gex' | 'mp' | 'em' | 'zg'

export type GexLevelOverlayItem = {
  /** Absolute price of the level. */
  price: number
  /** CSS stroke color (include alpha). */
  color: string
  /** Label fragment (`+3.4m`, `MP`, `HVL`, `EM −`). Empty = no text (meter may still draw). */
  title: string
  /** Draw priority when merging (higher wins color / price anchor). */
  priority: number
  /** Optional role for styling (gex / mp / em / zg). */
  role?: GexLevelRole
  /** Optional stronger color for Y-axis strike labels. */
  axisColor?: string
  /**
   * Relative wall strength in [0, 1] for the terminal meter (GEX only).
   * Omit / leave undefined for text-only labels (refs, weak All-mode levels).
   */
  strength?: number
  /**
   * When false, skip the horizontal hairline (meters / labels only).
   * Default true.
   */
  showLine?: boolean
  /**
   * Optional canvas dash pattern in media pixels (e.g. HVL `[5, 3.5]`).
   * Scaled by device pixel ratio at draw time.
   */
  dash?: number[]
  /** Optional line width in media pixels (default 1). */
  lineWidth?: number
  /**
   * When set, draw only a short solid tick from the right edge of the plot
   * (axis-side), instead of a full-width hairline. Media px.
   */
  lineFromRightPx?: number
}

/**
 * Only collapse hairlines when two strikes land on the same pixel row.
 * Wider merge made All-mode “eat” distinct levels when zoomed out.
 */
const LINE_DUP_PX = 1.25
/**
 * Minimum vertical gap between labeled chips (media px).
 * Weaker labels within this distance merge onto the host
 * (e.g. `+1.2m / EM`). Tuned to catch EM↔GEX scale collisions.
 */
const LABEL_MIN_GAP_PX = 14
/** Hard cap on simultaneous labeled chips. */
const MAX_LABELED_LEVELS = 16
/** Right inset from the plot edge for labels (media px). */
const LABEL_RIGHT_PAD = 8
/** Gap between line end and label chip (media px). */
const LINE_LABEL_GAP = 6
/** Terminal meter track width (media px). */
const METER_WIDTH = 20
/** Terminal meter track height (media px) — thinner than ranking bars. */
const METER_HEIGHT = 2.25
/** Gap between meter track and value text (media px). */
const METER_TEXT_GAP = 4
/** Soft bloom on meter fill when strength is a true wall. */
const WALL_GLOW_STRENGTH = 0.7

type DrawItem = {
  y: number
  color: string
  title: string
  /** Present only when a terminal meter should paint for this label. */
  strength?: number
  /** When false, no hairline (meter/label-only). */
  showLine: boolean
  dash?: number[]
  lineWidth: number
  /** Short axis-side tick length (media px). Omit = full-width hairline. */
  lineFromRightPx?: number
  /** Role for line style fallbacks (EM always axis-tick). */
  role?: GexLevelRole
  /** Draw priority — used for density packing (higher wins). */
  priority: number
}

/** Default EM axis-side tick length (media px) — short, not full-width. */
const EM_AXIS_TICK_PX = 44

type PlacedLevel = GexLevelOverlayItem & { y: number }

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
      const fontPx = Math.max(8, Math.round(8.5 * hpr))
      ctx.font = `600 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

      const rightEdge = w - LABEL_RIGHT_PAD * hpr
      const gap = LINE_LABEL_GAP * hpr
      const meterW = METER_WIDTH * hpr
      const meterGap = METER_TEXT_GAP * hpr

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        if (!item.showLine) continue
        const y = item.y * vpr
        if (!Number.isFinite(y) || y < -2 || y > h + 2) continue

        const lineW = Math.max(1, Math.round(item.lineWidth * hpr))
        ctx.strokeStyle = item.color
        ctx.lineWidth = lineW

        // EM (and any axis-tick): short solid segment from the right — never full-width, never dashed.
        const tickPx =
          item.role === 'em'
            ? item.lineFromRightPx ?? EM_AXIS_TICK_PX
            : item.lineFromRightPx
        if (tickPx != null && tickPx > 0) {
          ctx.setLineDash([])
          // Stop short of the canvas "EM" chip so the tick never runs under the text.
          let endX = w - Math.max(4, 6 * hpr)
          if (item.title || item.strength != null) {
            const chipLeft = labelChipLeft(item, rightEdge, ctx, meterW, meterGap)
            endX = Math.min(endX, Math.max(0, chipLeft - gap))
          }
          const tick = Math.max(12, tickPx) * hpr
          const startX = Math.max(0, endX - tick)
          if (endX - startX < 2) continue
          ctx.beginPath()
          ctx.moveTo(startX, y)
          ctx.lineTo(endX, y)
          ctx.stroke()
          continue
        }

        if (item.dash && item.dash.length > 0) {
          ctx.setLineDash(item.dash.map((d) => Math.max(1, Math.round(d * hpr))))
        } else {
          ctx.setLineDash([])
        }

        // Full hairline — stop short of the label / meter chip.
        let endX = w
        if (item.title || item.strength != null) {
          const chipLeft = labelChipLeft(item, rightEdge, ctx, meterW, meterGap)
          endX = Math.max(0, chipLeft - gap)
        }
        if (endX < 2) continue
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(endX, y)
        ctx.stroke()
      }
      ctx.setLineDash([])
    })
  }
}

/**
 * Right-side labels + optional terminal meters.
 * Text is right-aligned; each meter sits snug to the left of its own value
 * (no shared column gap when short chips share the pane with longer ones).
 */
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
      const fontPx = Math.max(8, Math.round(8.5 * hpr))
      ctx.font = `600 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'right'

      const minY = 8 * vpr
      const maxY = h - 8 * vpr
      const rightX = w - LABEL_RIGHT_PAD * hpr
      const meterW = METER_WIDTH * hpr
      const meterH = Math.max(1, METER_HEIGHT * vpr)
      const meterGap = METER_TEXT_GAP * hpr

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        const hasMeter = item.strength != null
        if (!item.title && !hasMeter) continue
        const y = item.y * vpr
        if (!Number.isFinite(y) || y < -2 || y > h + 2) continue
        const cy = Math.min(maxY, Math.max(minY, y))
        const textY = cy + 0.5 * vpr

        if (hasMeter) {
          const textW = item.title ? ctx.measureText(item.title).width : 0
          const meterLeft =
            textW > 0 ? rightX - textW - meterGap - meterW : rightX - meterW
          drawTerminalMeter(ctx, {
            meterLeft,
            cy,
            meterW,
            meterH,
            hpr,
            vpr,
            strength: item.strength!,
            color: item.color,
          })
        }

        if (item.title) {
          ctx.shadowColor = 'rgba(0, 0, 0, 0.85)'
          ctx.shadowBlur = 3.5 * hpr
          ctx.shadowOffsetX = 0
          ctx.shadowOffsetY = 0.5 * vpr
          ctx.fillStyle = labelFill(item.color)
          ctx.fillText(item.title, rightX, textY)
        }
      }

      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
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
    return this._mode === 'lines' ? 'bottom' : 'normal'
  }

  /**
   * Recompute placement every pan/zoom (same pattern as GexZonePrimitive).
   * Stale Y-caches were the main reason density logic looked broken after zoom.
   */
  update(): void {
    this._items = this._source.rebuildDrawItems()
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

  mergedDrawItems(): DrawItem[] {
    return this._mergedCache
  }

  /** Live rebuild used by pane views on every scale/time invalidation. */
  rebuildDrawItems(): DrawItem[] {
    this._mergedCache = this._buildMergedItems()
    return this._mergedCache
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
    this._mergedCache = this._buildMergedItems()
    for (const view of this._paneViews) view.update()
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews
  }

  /**
   * Build drawable levels from current price scale:
   *  1. Project every strike → Y (keep all hairlines)
   *  2. Collapse only true pixel-duplicate rows
   *  3. Pack labels by priority; fold collisions into aggregate chips
   */
  private _buildMergedItems(): DrawItem[] {
    const series = this._series
    if (!series || this._levels.length === 0) return []

    const placed = placeLevels(series, this._levels)
    if (placed.length === 0) return []

    // ── Hairlines: one row per near-identical Y, but never wide transitive merge ──
    const lineRows = collapsePixelDuplicates(placed)

    // ── Labels: pack strongest chips; weaker titled levels join nearest aggregate ──
    const labelSlots = packAggregateLabels(placed)

    // Index label slots by a stable key (primary price) for attach
    const labelByPrice = new Map<number, { title: string; strength?: number; color: string; y: number }>()
    const labelHostPrices = new Set<number>()
    for (const slot of labelSlots) {
      labelHostPrices.add(slot.price)
      labelByPrice.set(slot.price, {
        title: slot.title,
        strength: slot.strength,
        color: slot.color,
        y: slot.y,
      })
    }

    // Emit one DrawItem per line row; attach label only if this row hosts a chip.
    const out: DrawItem[] = []
    for (const row of lineRows) {
      const primary = pickPrimary(row)
      const label = labelByPrice.get(primary.price)
      // Also accept label if any member of the row is the host
      let chip = label
      if (!chip) {
        for (const m of row) {
          const hit = labelByPrice.get(m.price)
          if (hit) {
            chip = hit
            break
          }
        }
      }

      // EM tick style only when EM is the primary (no GEX/HVL/MP in the row).
      // Co-located EM folds into the host label (`+1.2m / EM`) and keeps the
      // host hairline — Expected Move never steals a stronger line.
      const useEmTick = primary.role === 'em'
      const lineRole = primary.role
      const lineFromRight = useEmTick
        ? primary.lineFromRightPx ?? EM_AXIS_TICK_PX
        : primary.lineFromRightPx
      const lineColor = primary.color
      const lineWidth = primary.lineWidth ?? 1
      const lineDash = useEmTick ? undefined : primary.dash

      // Drop orphan EM ticks whose label was absorbed into a nearby GEX/MP/HVL chip.
      const emAbsorbed =
        primary.role === 'em' && !labelHostPrices.has(primary.price) && !chip
      const showLine =
        !emAbsorbed && row.some((g) => g.showLine !== false)

      out.push({
        y: primary.y,
        color: lineColor,
        title: chip?.title ?? '',
        dash: lineDash,
        lineWidth,
        showLine,
        priority: primary.priority,
        ...(lineRole ? { role: lineRole } : {}),
        ...(lineFromRight != null ? { lineFromRightPx: lineFromRight } : {}),
        ...(chip?.strength != null ? { strength: chip.strength } : {}),
      })
    }

    // Labels that didn't land on a line row (shouldn't happen) — still emit as text-only
    for (const slot of labelSlots) {
      const already = out.some(
        (d) => d.title === slot.title && Math.abs(d.y - slot.y) < 0.5,
      )
      if (already) continue
      out.push({
        y: slot.y,
        color: slot.color,
        title: slot.title,
        showLine: false,
        lineWidth: 1,
        priority: slot.priority,
        ...(slot.strength != null ? { strength: slot.strength } : {}),
      })
    }

    return out
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SeriesTypeLoose = any

function placeLevels(
  series: ISeriesApi<SeriesTypeLoose, Time>,
  levels: readonly GexLevelOverlayItem[],
): PlacedLevel[] {
  const placed: PlacedLevel[] = []
  for (const level of levels) {
    if (!Number.isFinite(level.price) || level.price <= 0) continue
    const y = series.priceToCoordinate(level.price)
    if (y == null || !Number.isFinite(y)) continue
    placed.push({ ...level, y })
  }
  placed.sort((a, b) => a.y - b.y || b.priority - a.priority)
  return placed
}

/** Collapse only true same-pixel duplicates — preserves distinct strike hairlines. */
function collapsePixelDuplicates(placed: PlacedLevel[]): PlacedLevel[][] {
  if (placed.length === 0) return []
  const clusters: PlacedLevel[][] = []
  let bucket: PlacedLevel[] = [placed[0]!]
  for (let i = 1; i < placed.length; i++) {
    const cur = placed[i]!
    const prev = bucket[bucket.length - 1]!
    if (Math.abs(cur.y - prev.y) <= LINE_DUP_PX) {
      bucket.push(cur)
    } else {
      clusters.push(bucket)
      bucket = [cur]
    }
  }
  clusters.push(bucket)
  return clusters
}

type LabelSlot = {
  price: number
  y: number
  color: string
  title: string
  priority: number
  role?: GexLevelRole
  strength?: number
  /** How many titled levels rolled into this chip. */
  count: number
}

/**
 * Priority-greedy label packing.
 *
 * Stronger levels claim a chip first. Weaker titled levels within
 * {@link LABEL_MIN_GAP_PX} merge into the host:
 *   GEX host + EM  → `+1.2m / EM`
 *   MP host + GEX  → `+1.2m / MP`  (value first, key-level line still wins paint)
 * Pure GEX↔GEX collisions suppress the weaker chip (no ·N aggregate).
 */
function packAggregateLabels(placed: PlacedLevel[]): LabelSlot[] {
  const candidates = placed
    .filter((p) => p.title || p.strength != null)
    .slice()
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      const sa = a.strength ?? 0
      const sb = b.strength ?? 0
      if (sb !== sa) return sb - sa
      return a.y - b.y
    })

  const slots: LabelSlot[] = []

  for (const level of candidates) {
    let nearest: LabelSlot | null = null
    let nearestDist = Infinity
    for (const slot of slots) {
      const d = Math.abs(level.y - slot.y)
      if (d < LABEL_MIN_GAP_PX && d < nearestDist) {
        nearestDist = d
        nearest = slot
      }
    }

    if (nearest) {
      const bothGex = level.role === 'gex' && nearest.role === 'gex'
      if (!bothGex && level.title) {
        nearest.title = mergeLevelTitles(
          nearest.title,
          nearest.role,
          level.title,
          level.role,
        )
        nearest.count += 1
        // Keep GEX meter when a key-level host absorbs a wall value.
        if (level.strength != null && nearest.strength == null) {
          nearest.strength = clamp01(level.strength)
        }
      }
      // bothGex or empty title: suppress weaker chip (hairline may still draw).
      continue
    }

    if (slots.length >= MAX_LABELED_LEVELS) {
      // Cap: drop weakest extras (already sorted by priority for placement).
      continue
    }

    const baseTitle = level.title || ''
    slots.push({
      price: level.price,
      y: level.y,
      color: level.color,
      title: baseTitle,
      priority: level.priority,
      count: 1,
      ...(level.role ? { role: level.role } : {}),
      ...(level.strength != null ? { strength: clamp01(level.strength) } : {}),
    })
  }

  return slots
}

/**
 * Join two level chip titles. Prefer GEX value first when either side is GEX:
 *   `+1.2m` + `EM` → `+1.2m / EM`
 *   `MP` + `+1.2m` → `+1.2m / MP`
 */
function mergeLevelTitles(
  hostTitle: string,
  hostRole: GexLevelRole | undefined,
  guestTitle: string,
  guestRole: GexLevelRole | undefined,
): string {
  const host = hostTitle.trim()
  const guest = guestTitle.trim()
  if (!guest) return host
  if (!host) return guest
  if (host.includes(guest) || guest.includes(host)) return host

  const hostIsGex = hostRole === 'gex'
  const guestIsGex = guestRole === 'gex'

  let next: string
  if (guestIsGex && !hostIsGex) {
    next = `${guest} / ${host}`
  } else {
    next = `${host} / ${guest}`
  }
  // Keep chips compact on dense scales.
  if (next.length > 22) return host
  return next
}

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
    const title = typeof level.title === 'string' ? level.title : ''
    const dash =
      Array.isArray(level.dash) && level.dash.every((d) => Number.isFinite(d) && d >= 0)
        ? level.dash.map(Number)
        : undefined
    const lineWidth =
      level.lineWidth != null && Number.isFinite(level.lineWidth) && level.lineWidth > 0
        ? Math.min(3, level.lineWidth)
        : 1
    const strength =
      level.strength != null && Number.isFinite(level.strength)
        ? clamp01(level.strength)
        : undefined
    const showLine = level.showLine !== false
    // EM always gets an axis tick even if callers omit the length.
    const emDefaultTick = level.role === 'em' ? EM_AXIS_TICK_PX : undefined
    const rawTick = level.lineFromRightPx ?? emDefaultTick
    const lineFromRightPx =
      rawTick != null && Number.isFinite(rawTick) && rawTick > 0
        ? Math.min(80, rawTick)
        : undefined
    // Never dash EM rails.
    const effectiveDash = level.role === 'em' ? undefined : dash
    out.push({
      price,
      color: level.color,
      title,
      priority: Number.isFinite(level.priority) ? level.priority : 0,
      lineWidth,
      showLine,
      ...(level.role ? { role: level.role } : {}),
      ...(level.axisColor ? { axisColor: level.axisColor } : {}),
      ...(strength != null ? { strength } : {}),
      ...(effectiveDash && effectiveDash.length > 0 ? { dash: effectiveDash } : {}),
      ...(lineFromRightPx != null ? { lineFromRightPx } : {}),
    })
  }
  return out
}

/**
 * Left edge of this item's chip (meter + text, or text alone).
 * Per-item — meter always sits immediately left of its own value, so short
 * chips do not inherit empty gap from a wider sibling label.
 */
function labelChipLeft(
  item: DrawItem,
  rightX: number,
  ctx: CanvasRenderingContext2D,
  meterW: number,
  meterGap: number,
): number {
  const textW = item.title ? ctx.measureText(item.title).width : 0
  if (item.strength != null) {
    if (textW > 0) return rightX - textW - meterGap - meterW
    return rightX - meterW
  }
  if (textW > 0) return rightX - textW
  return rightX
}

function drawTerminalMeter(
  ctx: CanvasRenderingContext2D,
  opts: {
    meterLeft: number
    cy: number
    meterW: number
    meterH: number
    hpr: number
    vpr: number
    strength: number
    color: string
  },
): void {
  const { meterLeft, cy, meterW, meterH, hpr, vpr, strength, color } = opts
  const s = clamp01(strength)
  const top = cy - meterH / 2
  const radius = Math.max(0.5, 1 * hpr)

  // Clear any text-shadow so meter chrome stays crisp.
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0

  // Quiet inset track (desk slate, not a second band layer).
  ctx.fillStyle = 'rgba(255, 255, 255, 0.055)'
  roundRect(ctx, meterLeft, top, meterW, meterH, radius)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = Math.max(1, Math.round(0.75 * hpr))
  roundRect(ctx, meterLeft + 0.5, top + 0.5, meterW - 1, meterH - 1, radius)
  ctx.stroke()

  // Minimum visible fleck so near-zero still reads as "has a meter."
  const fillW = Math.max(s > 0 ? 1.5 * hpr : 0, meterW * s)
  if (fillW <= 0) return

  const fillRgb = meterRgb(color)
  const isWall = s >= WALL_GLOW_STRENGTH

  if (isWall) {
    ctx.shadowColor = `rgba(${fillRgb.r}, ${fillRgb.g}, ${fillRgb.b}, 0.35)`
    ctx.shadowBlur = 4 * hpr
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
  }

  // Soft left→right gradient: empty track → role edge (ranking-bar cousin).
  const grad = ctx.createLinearGradient(meterLeft, 0, meterLeft + fillW, 0)
  const a0 = 0.35 + s * 0.2
  const a1 = 0.72 + s * 0.22
  grad.addColorStop(0, `rgba(${fillRgb.r}, ${fillRgb.g}, ${fillRgb.b}, ${a0.toFixed(3)})`)
  grad.addColorStop(1, `rgba(${fillRgb.r}, ${fillRgb.g}, ${fillRgb.b}, ${a1.toFixed(3)})`)
  ctx.fillStyle = grad
  roundRect(ctx, meterLeft, top, fillW, meterH, radius)
  ctx.fill()

  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0

  // Hairline specular on walls only — keeps mids flat.
  if (isWall && fillW > 3 * hpr) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'
    ctx.fillRect(meterLeft + 0.5 * hpr, top + 0.35 * vpr, fillW - hpr, Math.max(1, 0.55 * vpr))
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rr)
    return
  }
  // Fallback for older canvas
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

function meterRgb(color: string): { r: number; g: number; b: number } {
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color)
  if (rgba) {
    return {
      r: Math.round(Number(rgba[1])),
      g: Math.round(Number(rgba[2])),
      b: Math.round(Number(rgba[3])),
    }
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const n = hex[1]!
    return {
      r: Number.parseInt(n.slice(0, 2), 16),
      g: Number.parseInt(n.slice(2, 4), 16),
      b: Number.parseInt(n.slice(4, 6), 16),
    }
  }
  return { r: 160, g: 170, b: 180 }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/** Lift low-alpha line colors so text stays readable without a plate. */
function labelFill(color: string): string {
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(
    color,
  )
  if (rgba) {
    const r = Math.min(255, Math.round(Number(rgba[1]) * 0.55 + 255 * 0.45))
    const g = Math.min(255, Math.round(Number(rgba[2]) * 0.55 + 255 * 0.45))
    const b = Math.min(255, Math.round(Number(rgba[3]) * 0.55 + 255 * 0.45))
    return `rgba(${r}, ${g}, ${b}, 0.94)`
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const n = hex[1]!
    const r0 = Number.parseInt(n.slice(0, 2), 16)
    const g0 = Number.parseInt(n.slice(2, 4), 16)
    const b0 = Number.parseInt(n.slice(4, 6), 16)
    const r = Math.min(255, Math.round(r0 * 0.55 + 255 * 0.45))
    const g = Math.min(255, Math.round(g0 * 0.55 + 255 * 0.45))
    const b = Math.min(255, Math.round(b0 * 0.55 + 255 * 0.45))
    return `rgba(${r}, ${g}, ${b}, 0.94)`
  }
  return 'rgba(220, 226, 234, 0.94)'
}
