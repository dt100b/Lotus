/**
 * Smooth GEX profile series for Lightweight Charts v5.
 *
 * Catmull-Rom → cubic bezier through strike points, filled baseline-style
 * above/below zero. Display-only smoothing lives in the path; data values
 * stay exact for auto-scale + crosshair.
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
  type WhitespaceData,
} from 'lightweight-charts'

export interface GexProfileBezierData extends CustomData<number> {
  value: number
}

export interface GexProfileBezierOptions extends CustomSeriesOptions {
  basePrice: number
  topLineColor: string
  bottomLineColor: string
  topFillColor1: string
  topFillColor2: string
  bottomFillColor1: string
  bottomFillColor2: string
  lineWidth: number
  /** 0 = polyline, 1 = full Catmull-Rom tension (default 0.85). */
  tension: number
}

export const gexProfileBezierDefaultOptions: GexProfileBezierOptions = {
  ...customSeriesDefaultOptions,
  basePrice: 0,
  topLineColor: '#3da889',
  bottomLineColor: '#c94f63',
  topFillColor1: 'rgba(61, 168, 137, 0.28)',
  topFillColor2: 'rgba(61, 168, 137, 0.05)',
  bottomFillColor1: 'rgba(201, 79, 99, 0.05)',
  bottomFillColor2: 'rgba(201, 79, 99, 0.28)',
  lineWidth: 1.5,
  tension: 0.85,
  lastValueVisible: false,
  priceLineVisible: false,
}

type Pt = { x: number; y: number; v: number }

class GexProfileBezierRenderer implements ICustomSeriesPaneRenderer {
  private _data: PaneRendererCustomData<number, GexProfileBezierData> | null = null
  private _options: GexProfileBezierOptions | null = null

  update(
    data: PaneRendererCustomData<number, GexProfileBezierData>,
    options: GexProfileBezierOptions,
  ): void {
    this._data = data
    this._options = options
  }

  draw(
    target: CanvasRenderingTarget2D,
    priceConverter: PriceToCoordinateConverter,
  ): void {
    target.useBitmapCoordinateSpace((scope) => {
      this._drawImpl(scope, priceConverter)
    })
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
    const data = this._data
    const options = this._options
    if (!data || !options || data.bars.length === 0) return

    const ctx = scope.context
    const hR = scope.horizontalPixelRatio
    const vR = scope.verticalPixelRatio
    const basePrice = options.basePrice
    const baseYMedia = priceToCoordinate(basePrice)
    if (baseYMedia == null || !Number.isFinite(baseYMedia)) return
    const baseY = baseYMedia * vR

    const pts: Pt[] = []
    for (const bar of data.bars) {
      const od = bar.originalData
      if (!od || !Number.isFinite(od.value)) continue
      const x = bar.x * hR
      const yMedia = priceToCoordinate(od.value)
      if (yMedia == null || !Number.isFinite(yMedia)) continue
      pts.push({ x, y: yMedia * vR, v: od.value })
    }
    if (pts.length < 2) {
      if (pts.length === 1) {
        const p = pts[0]!
        ctx.beginPath()
        ctx.fillStyle = p.v >= basePrice ? options.topLineColor : options.bottomLineColor
        ctx.arc(p.x, p.y, 2.5 * hR, 0, Math.PI * 2)
        ctx.fill()
      }
      return
    }

    const tension = Math.max(0, Math.min(1, options.tension))
    const lineW = Math.max(1, options.lineWidth) * hR
    const path = buildSmoothPath(pts, tension)

    drawBaselineFill(
      ctx,
      path,
      pts,
      baseY,
      true,
      options.topFillColor1,
      options.topFillColor2,
      scope.bitmapSize.height,
    )
    drawBaselineFill(
      ctx,
      path,
      pts,
      baseY,
      false,
      options.bottomFillColor1,
      options.bottomFillColor2,
      scope.bitmapSize.height,
    )

    strokeSplitByBase(ctx, pts, baseY, tension, options.topLineColor, options.bottomLineColor, lineW)
  }
}

function buildSmoothPath(pts: Pt[], tension: number): Path2D {
  const path = new Path2D()
  path.moveTo(pts[0]!.x, pts[0]!.y)
  if (tension <= 0.001 || pts.length === 2) {
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i]!.x, pts[i]!.y)
    return path
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!
    const t = tension * 0.5
    const cp1x = p1.x + (p2.x - p0.x) * t
    const cp1y = p1.y + (p2.y - p0.y) * t
    const cp2x = p2.x - (p3.x - p1.x) * t
    const cp2y = p2.y - (p3.y - p1.y) * t
    path.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
  }
  return path
}

function drawBaselineFill(
  ctx: CanvasRenderingContext2D,
  linePath: Path2D,
  pts: Pt[],
  baseY: number,
  above: boolean,
  color1: string,
  color2: string,
  bitmapHeight: number,
): void {
  if (pts.length < 2) return
  const first = pts[0]!
  const last = pts[pts.length - 1]!

  ctx.save()
  ctx.beginPath()
  if (above) {
    ctx.rect(0, 0, last.x + 4, Math.max(baseY, 0) + 1)
  } else {
    ctx.rect(0, Math.min(baseY, bitmapHeight), last.x + 4, bitmapHeight)
  }
  ctx.clip()

  const fill = new Path2D(linePath)
  fill.lineTo(last.x, baseY)
  fill.lineTo(first.x, baseY)
  fill.closePath()

  const yMin = Math.min(...pts.map((p) => p.y), baseY)
  const yMax = Math.max(...pts.map((p) => p.y), baseY)
  const grad = ctx.createLinearGradient(0, above ? yMin : baseY, 0, above ? baseY : yMax)
  if (above) {
    grad.addColorStop(0, color1)
    grad.addColorStop(1, color2)
  } else {
    grad.addColorStop(0, color1)
    grad.addColorStop(1, color2)
  }
  ctx.fillStyle = grad
  ctx.fill(fill)
  ctx.restore()
}

function strokeSplitByBase(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  baseY: number,
  tension: number,
  topColor: string,
  bottomColor: string,
  lineW: number,
): void {
  const samples = sampleSmooth(pts, tension, 6)
  if (samples.length < 2) return

  ctx.lineWidth = lineW
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  let run: Pt[] = [samples[0]!]
  let above = samples[0]!.y <= baseY

  const flush = (color: string, segment: Pt[]) => {
    if (segment.length < 2) return
    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.moveTo(segment[0]!.x, segment[0]!.y)
    for (let i = 1; i < segment.length; i++) ctx.lineTo(segment[i]!.x, segment[i]!.y)
    ctx.stroke()
  }

  for (let i = 1; i < samples.length; i++) {
    const p = samples[i]!
    const pAbove = p.y <= baseY
    if (pAbove === above) {
      run.push(p)
    } else {
      const prev = samples[i - 1]!
      const dy = p.y - prev.y
      const t = Math.abs(dy) > 1e-6 ? (baseY - prev.y) / dy : 0.5
      const cross: Pt = {
        x: prev.x + (p.x - prev.x) * t,
        y: baseY,
        v: 0,
      }
      run.push(cross)
      flush(above ? topColor : bottomColor, run)
      run = [cross, p]
      above = pAbove
    }
  }
  flush(above ? topColor : bottomColor, run)
}

function sampleSmooth(pts: Pt[], tension: number, stepsPerSeg: number): Pt[] {
  if (pts.length < 2) return pts.slice()
  if (tension <= 0.001) return pts.slice()
  const out: Pt[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!
    const t = tension * 0.5
    const cp1x = p1.x + (p2.x - p0.x) * t
    const cp1y = p1.y + (p2.y - p0.y) * t
    const cp2x = p2.x - (p3.x - p1.x) * t
    const cp2y = p2.y - (p3.y - p1.y) * t
    for (let s = 0; s < stepsPerSeg; s++) {
      const u = s / stepsPerSeg
      out.push(cubic(p1.x, p1.y, cp1x, cp1y, cp2x, cp2y, p2.x, p2.y, u))
    }
  }
  out.push(pts[pts.length - 1]!)
  return out
}

function cubic(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  t: number,
): Pt {
  const u = 1 - t
  const tt = t * t
  const uu = u * u
  const uuu = uu * u
  const ttt = tt * t
  const x = uuu * x0 + 3 * uu * t * x1 + 3 * u * tt * x2 + ttt * x3
  const y = uuu * y0 + 3 * uu * t * y1 + 3 * u * tt * y2 + ttt * y3
  return { x, y, v: 0 }
}

export class GexProfileBezierSeries
  implements ICustomSeriesPaneView<number, GexProfileBezierData, GexProfileBezierOptions>
{
  private _renderer = new GexProfileBezierRenderer()

  renderer(): ICustomSeriesPaneRenderer {
    return this._renderer
  }

  update(
    data: PaneRendererCustomData<number, GexProfileBezierData>,
    options: GexProfileBezierOptions,
  ): void {
    this._renderer.update(data, options)
  }

  priceValueBuilder(plotRow: GexProfileBezierData): CustomSeriesPricePlotValues {
    return [plotRow.value]
  }

  isWhitespace(
    data: GexProfileBezierData | WhitespaceData<number>,
  ): data is WhitespaceData<number> {
    return (data as GexProfileBezierData).value === undefined
  }

  defaultOptions(): GexProfileBezierOptions {
    return { ...gexProfileBezierDefaultOptions }
  }
}
