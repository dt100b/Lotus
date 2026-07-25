import { useEffect, useRef, useState } from 'react'
import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type ITimeScaleApi,
  type LogicalRange,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { VolSeriesPoint } from '@/data/mockTerminal'

/**
 * Dual-pane IV vs RV + spread chart (Lightweight Charts v5).
 *
 * Host must be position:absolute; inset:0 inside a sized parent.
 *
 * Visual contract:
 * - No internal grid; subtle pane separator when spread is on
 * - Thin IV (cool cyan) + RV (warm amber) lines
 * - No persistent last-value / Y labels
 * - Per-series crosshair value labels at each series Y, shared X
 * - Time-axis date label on crosshair hover
 * - Double-click pane to fitContent; zoom/pan preserved across data refresh
 */

type VolCompareChartProps = {
  dvolSeries: VolSeriesPoint[]
  rvSeries: VolSeriesPoint[]
  spreadSeries: VolSeriesPoint[]
  showRv: boolean
  showSpread: boolean
  className?: string
}

/** Non-GEX palette: IV cool cyan, RV warm amber, quiet rule marks. */
const C = {
  iv: '#4ec4d4',
  rv: '#e0a040',
  spreadPos: '#6b8cae',
  spreadNeg: '#a67c52',
  text: '#8a93a0',
  rule: 'rgba(100, 110, 125, 0.40)',
  separator: 'rgba(160, 168, 180, 0.22)',
  muted: '#7a8490',
  crosshairLabelBg: 'rgba(28, 32, 40, 0.92)',
} as const

/** Slightly shorter top vol pane; keep spread pane usable. */
const VOL_STRETCH = 0.66
const SPREAD_STRETCH = 0.34

/** Right-edge buffer so series are not flush with the Y-axis. */
const RIGHT_OFFSET = 8

type ChartHandle = {
  chart: IChartApi
  dvol: ISeriesApi<'Line'>
  rv: ISeriesApi<'Line'>
  spread: ISeriesApi<'Baseline'> | null
}

type CrosshairLabel = {
  kind: 'iv' | 'rv' | 'spread'
  text: string
  top: number
  left: number
}

/**
 * Crosshair marker size — keep radius + zero border so IV/RV match spread.
 * Default borderWidth (2) on Line series inflated IV/RV dots vs Baseline.
 */
const CROSSHAIR_MARKER_RADIUS = 2
const CROSSHAIR_MARKER_BORDER_WIDTH = 0

export function VolCompareChart({
  dvolSeries,
  rvSeries,
  spreadSeries,
  showRv,
  showSpread,
  className,
}: VolCompareChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<ChartHandle | null>(null)
  const propsRef = useRef({ dvolSeries, rvSeries, spreadSeries, showRv, showSpread })
  propsRef.current = { dvolSeries, rvSeries, spreadSeries, showRv, showSpread }
  const [error, setError] = useState<string | null>(null)
  const [crosshairLabels, setCrosshairLabels] = useState<CrosshairLabel[]>([])
  /** Y of vol→spread separator; null when spread pane is off. */
  const [separatorTop, setSeparatorTop] = useState<number | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let handle: ChartHandle | null = null
    let raf = 0
    let sepRaf = 0
    let ro: ResizeObserver | null = null

    const refreshSeparator = () => {
      if (disposed || !handle) return
      setSeparatorTop(computeSeparatorTop(handle, propsRef.current.showSpread))
    }

    const scheduleSeparator = () => {
      if (sepRaf) cancelAnimationFrame(sepRaf)
      sepRaf = requestAnimationFrame(refreshSeparator)
    }

    const clearCrosshair = () => {
      setCrosshairLabels((prev) => (prev.length === 0 ? prev : []))
    }

    const onCrosshair = (param: MouseEventParams) => {
      if (disposed || !handle) return
      const p = propsRef.current

      if (
        !param.point ||
        param.time === undefined ||
        param.point.x < 0 ||
        param.point.y < 0
      ) {
        clearCrosshair()
        return
      }

      const hostW = host.clientWidth || 1
      // Shared vertical alignment: all labels sit just right of the crosshair
      const left = Math.min(Math.max(8, param.point.x + 10), hostW - 48)

      const labels: CrosshairLabel[] = []

      const ivVal = readSeriesValue(handle.dvol, param)
      if (ivVal != null) {
        const y = handle.dvol.priceToCoordinate(ivVal)
        if (y != null && Number.isFinite(y)) {
          labels.push({
            kind: 'iv',
            text: formatVol(ivVal),
            top: Math.max(6, y),
            left,
          })
        }
      }

      if (p.showRv) {
        const rvVal = readSeriesValue(handle.rv, param)
        if (rvVal != null) {
          const y = handle.rv.priceToCoordinate(rvVal)
          if (y != null && Number.isFinite(y)) {
            labels.push({
              kind: 'rv',
              text: formatVol(rvVal),
              top: Math.max(6, y),
              left,
            })
          }
        }
      }

      if (p.showSpread && handle.spread) {
        const spVal = readSeriesValue(handle.spread, param)
        if (spVal != null) {
          let paneOffset = 0
          try {
            paneOffset = handle.chart.panes()[0]?.getHeight() ?? 0
          } catch {
            paneOffset = 0
          }
          const y = handle.spread.priceToCoordinate(spVal)
          if (y != null && Number.isFinite(y)) {
            labels.push({
              kind: 'spread',
              text: formatSpread(spVal),
              top: Math.max(6, y + paneOffset),
              left,
            })
          }
        }
      }

      setCrosshairLabels(labels)
    }

    try {
      host.replaceChildren()

      const { w, h } = measure(host)
      const chart = createChart(host, {
        width: w,
        height: h,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: C.text,
          fontSize: 9,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          attributionLogo: false,
          panes: {
            separatorColor: C.separator,
            separatorHoverColor: 'rgba(160, 168, 180, 0.32)',
            enableResize: false,
          },
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { visible: false },
        },
        crosshair: {
          mode: CrosshairMode.Magnet,
          vertLine: {
            color: C.rule,
            width: 1,
            style: LineStyle.Dotted,
            // Restore date/time label on the time axis under the cursor
            labelVisible: true,
            labelBackgroundColor: C.crosshairLabelBg,
          },
          horzLine: {
            visible: false,
            labelVisible: false,
          },
        },
        rightPriceScale: {
          borderVisible: false,
          scaleMargins: { top: 0.1, bottom: 0.08 },
          entireTextOnly: true,
        },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
          fixLeftEdge: false,
          fixRightEdge: false,
          rightOffset: RIGHT_OFFSET,
          minBarSpacing: 0.4,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
        handleScale: {
          axisPressedMouseMove: { time: true, price: false },
          mouseWheel: true,
          pinch: true,
        },
      })

      const dvol = chart.addSeries(
        LineSeries,
        {
          color: C.iv,
          lineWidth: 1,
          lineType: LineType.Simple,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: CROSSHAIR_MARKER_RADIUS,
          crosshairMarkerBorderWidth: CROSSHAIR_MARKER_BORDER_WIDTH,
          crosshairMarkerBorderColor: C.iv,
          crosshairMarkerBackgroundColor: C.iv,
          priceFormat: volPriceFormat,
        },
        0,
      )

      const rv = chart.addSeries(
        LineSeries,
        {
          color: C.rv,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          lineType: LineType.Simple,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: CROSSHAIR_MARKER_RADIUS,
          crosshairMarkerBorderWidth: CROSSHAIR_MARKER_BORDER_WIDTH,
          crosshairMarkerBorderColor: C.rv,
          crosshairMarkerBackgroundColor: C.rv,
          priceFormat: volPriceFormat,
          visible: false,
        },
        0,
      )

      handle = { chart, dvol, rv, spread: null }
      handleRef.current = handle
      // First paint: fit full series. Later refreshes restore the saved view.
      applySeries(handle, propsRef.current, { fit: true })
      scheduleSeparator()

      chart.subscribeCrosshairMove(onCrosshair)

      const onDblClick = (ev: MouseEvent) => {
        if (disposed || !handle) return
        ev.preventDefault()
        // Reset zoom/pan to full series window
        handle.chart.timeScale().fitContent()
      }
      host.addEventListener('dblclick', onDblClick)

      const syncSize = () => {
        if (disposed || !handle) return
        const next = measure(host)
        handle.chart.resize(next.w, next.h, true)
        scheduleSeparator()
      }

      ro = new ResizeObserver(() => {
        if (raf) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(syncSize)
      })
      ro.observe(host)

      raf = requestAnimationFrame(() => {
        syncSize()
        // Initial fit only — do not re-fit on later resizes (preserves zoom)
        handle?.chart.timeScale().fitContent()
        scheduleSeparator()
      })

      setError(null)

      return () => {
        disposed = true
        if (raf) cancelAnimationFrame(raf)
        if (sepRaf) cancelAnimationFrame(sepRaf)
        ro?.disconnect()
        host.removeEventListener('dblclick', onDblClick)
        try {
          handle?.chart.unsubscribeCrosshairMove(onCrosshair)
        } catch {
          // ignore
        }
        handleRef.current = null
        try {
          handle?.chart.remove()
        } catch {
          // ignore double-dispose
        }
        host.replaceChildren()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      console.error('[VolCompareChart] create failed', err)
      return () => {
        disposed = true
      }
    }
  }, [])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    try {
      // Preserve zoom/pan across dashboard snapshot refresh
      applySeries(handle, { dvolSeries, rvSeries, spreadSeries, showRv, showSpread })
      requestAnimationFrame(() => {
        setSeparatorTop(computeSeparatorTop(handle, showSpread))
      })
      // Clear stale hover labels when toggles/data change
      setCrosshairLabels([])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      console.error('[VolCompareChart] update failed', err)
    }
  }, [dvolSeries, rvSeries, spreadSeries, showRv, showSpread])

  if (error) {
    return (
      <div className={className}>
        <div className="regime-vol__empty">Chart error</div>
      </div>
    )
  }

  return (
    <div className={className ? `${className} regime-vol__lwc-wrap` : 'regime-vol__lwc-wrap'}>
      <div ref={hostRef} className="regime-vol__lwc-canvas" />

      {/* Explicit vol ↔ spread pane hairline (LWC separator alone is easy to miss) */}
      {separatorTop != null ? (
        <div
          className="regime-vol__pane-sep"
          aria-hidden
          style={{ top: separatorTop }}
        />
      ) : null}

      {/* Per-series hover labels at series Y, shared X — no combined box */}
      <div className="regime-vol__hover-labels" aria-hidden>
        {crosshairLabels.map((label) => (
          <span
            key={label.kind}
            className={`regime-vol__hover-label regime-vol__hover-label--${label.kind}`}
            style={{ top: label.top, left: label.left }}
          >
            {label.text}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ── series apply ─────────────────────────────────────────────────────────── */

function applySeries(
  handle: ChartHandle,
  props: {
    dvolSeries: VolSeriesPoint[]
    rvSeries: VolSeriesPoint[]
    spreadSeries: VolSeriesPoint[]
    showRv: boolean
    showSpread: boolean
  },
  options?: { fit?: boolean },
) {
  const { chart, dvol, rv } = handle
  const timeScale = chart.timeScale()

  // Snapshot zoom/pan before setData so dashboard refresh does not jump the view.
  const savedLogical =
    options?.fit ? null : captureLogicalRange(timeScale)

  const dvolData = toLineData(props.dvolSeries)
  dvol.setData(dvolData)

  const rvData = props.showRv ? toLineData(props.rvSeries) : []
  rv.setData(rvData)
  rv.applyOptions({ visible: props.showRv && rvData.length > 0 })

  if (props.showSpread) {
    if (!handle.spread) {
      const spread = chart.addSeries(
        BaselineSeries,
        {
          baseValue: { type: 'price', price: 0 },
          topLineColor: C.spreadPos,
          topFillColor1: 'rgba(107, 140, 174, 0.22)',
          topFillColor2: 'rgba(107, 140, 174, 0.02)',
          bottomLineColor: C.spreadNeg,
          bottomFillColor1: 'rgba(166, 124, 82, 0.02)',
          bottomFillColor2: 'rgba(166, 124, 82, 0.22)',
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: CROSSHAIR_MARKER_RADIUS,
          crosshairMarkerBorderWidth: CROSSHAIR_MARKER_BORDER_WIDTH,
          priceFormat: spreadPriceFormat,
        },
        1,
      )
      handle.spread = spread

      const panes = chart.panes()
      if (panes[0]) panes[0].setStretchFactor(VOL_STRETCH)
      if (panes[1]) {
        panes[1].setStretchFactor(SPREAD_STRETCH)
        try {
          panes[1].priceScale('right').applyOptions({
            borderVisible: false,
            scaleMargins: { top: 0.14, bottom: 0.14 },
            entireTextOnly: true,
          })
        } catch {
          // price scale may not exist yet
        }
      }
    } else {
      // Keep stretch if pane already exists (toggle off/on re-creates)
      const panes = chart.panes()
      if (panes[0]) panes[0].setStretchFactor(VOL_STRETCH)
      if (panes[1]) panes[1].setStretchFactor(SPREAD_STRETCH)
    }
    handle.spread.setData(toLineData(props.spreadSeries))
  } else if (handle.spread) {
    chart.removeSeries(handle.spread)
    handle.spread = null
    const panes = chart.panes()
    if (panes[0]) panes[0].setStretchFactor(1)
  }

  if (dvolData.length === 0) return

  if (options?.fit || !savedLogical) {
    timeScale.fitContent()
    return
  }

  try {
    timeScale.setVisibleLogicalRange(savedLogical)
  } catch {
    timeScale.fitContent()
  }
}

function captureLogicalRange(timeScale: ITimeScaleApi<Time>): LogicalRange | null {
  try {
    const range = timeScale.getVisibleLogicalRange()
    if (
      range == null ||
      !Number.isFinite(range.from) ||
      !Number.isFinite(range.to) ||
      range.to <= range.from
    ) {
      return null
    }
    return { from: range.from, to: range.to }
  } catch {
    return null
  }
}

/** Y of the vol→spread hairline; null when spread pane is off. */
function computeSeparatorTop(handle: ChartHandle, showSpread: boolean): number | null {
  if (!showSpread || !handle.spread) return null
  try {
    const h = handle.chart.panes()[0]?.getHeight()
    return typeof h === 'number' && Number.isFinite(h) ? h : null
  } catch {
    return null
  }
}

function readSeriesValue(
  series: ISeriesApi<'Line'> | ISeriesApi<'Baseline'>,
  param: MouseEventParams,
): number | null {
  const raw = param.seriesData.get(series)
  if (!raw || typeof raw !== 'object') return null
  const value = (raw as { value?: number; close?: number }).value
    ?? (raw as { close?: number }).close
  return value != null && Number.isFinite(value) ? value : null
}

function measure(el: HTMLElement): { w: number; h: number } {
  const rect = el.getBoundingClientRect()
  const w = Math.max(2, Math.floor(el.clientWidth || rect.width || 2))
  const h = Math.max(2, Math.floor(el.clientHeight || rect.height || 2))
  return { w, h }
}

/* ── data mapping ─────────────────────────────────────────────────────────── */

const volPriceFormat = {
  type: 'custom' as const,
  minMove: 0.1,
  formatter: (price: number) =>
    Number.isFinite(price) ? `${price.toFixed(1)}%` : '',
}

const spreadPriceFormat = {
  type: 'custom' as const,
  minMove: 0.1,
  formatter: (price: number) => {
    if (!Number.isFinite(price)) return ''
    const sign = price > 0 ? '+' : price < 0 ? '−' : ''
    return `${sign}${Math.abs(price).toFixed(1)}`
  },
}

function formatVol(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '—'
}

function formatSpread(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${Math.abs(value).toFixed(1)}`
}

function toLineData(series: VolSeriesPoint[]): { time: Time; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = []
  let lastTime = -Infinity
  for (const p of series) {
    if (!Number.isFinite(p.tsMs) || !Number.isFinite(p.value)) continue
    const ms = p.tsMs > 1e12 ? p.tsMs : p.tsMs * 1000
    const t = Math.floor(ms / 1000) as UTCTimestamp
    if (t <= lastTime) continue
    lastTime = t
    out.push({ time: t, value: p.value })
  }
  return out
}
