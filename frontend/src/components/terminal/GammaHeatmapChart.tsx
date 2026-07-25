/**
 * Heatmap pane — Hyperliquid OHLC with current GEX zone underlay (Price / Gamma).
 *
 * Header chrome (like desk GEX+Price): timeframe pills, GEX opacity slider, expiry.
 * GEX overlay = full-width horizontal bands from the live surface snapshot
 * (series primitive, zOrder bottom). Candles + crosshair stay on top.
 *
 * Optional strike lines (header toggle): precise strike markers for each band,
 * Top-2 PG/NG filter, plus Expected Move (EM±) and Max Pain (MP) references.
 *
 * Auto-fit = native LWC price autoScale with fixed edge margins (Y only).
 * X pan/zoom is always free. No per-frame price setVisibleRange (that was glitchy).
 */

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import {
  candleIntervalLabels,
  candleIntervalMs,
  candleIntervals,
  isCandleInterval,
  type CandleInterval,
  type OhlcCandle,
} from '@/api/hyperliquidCandles'
import type { GexExpiry } from '@/api/mockGexData'
import {
  ChartExpirySelect,
  ChartPaneActions,
  ChartPaneHeader,
  ChartSegmentButton,
  ChartSegmentGroup,
} from '@/components/terminal/ChartPaneHeader'
import { defaultHeatmapDataWindowPct } from '@/components/terminal/gexModes'
import type { PaneDragHandleProps } from '@/components/terminal/PaneWorkspace'
import {
  GexLevelOverlayPrimitive,
  type GexLevelOverlayItem,
} from '@/components/terminal/lwc/GexLevelOverlayPrimitive'
import {
  buildGexZonesFromBars,
  GexZonePrimitive,
} from '@/components/terminal/lwc/GexZonePrimitive'
import {
  clampHeatmapIntensity,
  defaultHeatmapIntensity,
  maxHeatmapIntensity,
  minHeatmapIntensity,
} from '@/data/heatmapPalettes'
import { useHyperliquidCandles } from '@/hooks/useHyperliquidCandles'
import { useTerminalStore } from '@/store/terminalStore'
import { cn } from '@/lib/utils'

type VisibleTimeRange = { from: number; to: number }

/** Strike-line overlay mode for the bands chart. */
export type StrikeLinesMode = 'off' | 'all' | 'top2'

export type HeatmapReferenceMetric = {
  label: string
  value: string
  color?: string
  scopeLabel?: string
}

export type HeatmapSnapshot = {
  spot: number
  asOfUtc?: string
  gammaBars: Array<{
    strike: number
    gammaExposureUsd: number
    callGammaExposureUsd?: number
    putGammaExposureUsd?: number
    netGammaExposureUsd?: number
  }>
  /** Levels desk reference (Max Pain, Expected Move, …) for overlay lines. */
  reference?: HeatmapReferenceMetric[]
}

export type GammaHeatmapChartProps = {
  snapshot: HeatmapSnapshot
  dataWindowPct: number | 'full'
  onDataWindowPctChange?: (pct: number) => void
  timeWindowHours?: number
  onTimeWindowHoursChange?: (hours: number) => void
  paletteId?: string
  candleInterval?: CandleInterval
  onCandleIntervalChange?: (interval: CandleInterval) => void
  /** Active GEX book expiry for this pane. */
  expiry?: GexExpiry
  expiryOptions?: Array<{ value: GexExpiry; label: string; shortLabel?: string }>
  onExpiryChange?: (expiry: GexExpiry) => void
  showCandles?: boolean
  titleAccessory?: ReactNode
  /** Extra left-header controls (e.g. chart mode segments). */
  headerLeft?: ReactNode
  /** Extra right-header controls before expiry/actions. */
  headerRight?: ReactNode
  dragHandleProps?: PaneDragHandleProps
  onClose?: () => void
  expiryLabel?: string
  minHeight?: number
}

/* Shared presentation constants imported by dashboard chrome / pane model. */
/* eslint-disable react-refresh/only-export-components -- chart config constants */
export const HEATMAP_CANDLE_INTERVAL: CandleInterval = '15m'
export const HL_CANDLE_HISTORY_DAYS = 90

/** Default visible lookback when Auto fit / first paint applies the time window. */
export const heatmapAutoTimeWindowHours: Record<CandleInterval, number> = {
  '5m': 24,
  '15m': 48,
  '30m': 72,
  '1h': 7 * 24,
}

export const defaultHeatmapTimeWindowHours = heatmapAutoTimeWindowHours['15m']
export const minHeatmapTimeWindowHours = 1
export const maxHeatmapTimeWindowHours = HL_CANDLE_HISTORY_DAYS * 24
export const heatmapLookbackMs = defaultHeatmapTimeWindowHours * 60 * 60 * 1000
export const heatmapLookaheadMs = 1 * 60 * 60 * 1000
export const heatmapMaxLookbackMs = maxHeatmapTimeWindowHours * 60 * 60 * 1000
/* eslint-enable react-refresh/only-export-components */

const defaultChartHeight = 516
/**
 * Empty logical bars past the last candle (gap before the price axis).
 * Must use setVisibleLogicalRange (not time setVisibleRange) — LWC collapses
 * empty future time when there are no series points there.
 */
const RIGHT_OFFSET_BARS = 28
const DEFAULT_BAR_SPACING = 3.5
const MIN_BAR_SPACING = 0.35
/** Fixed plot margin while Auto fit (Y) is on — native LWC autoScale. */
const PRICE_EDGE_MARGIN = 0.12

const C = {
  text: '#8a93a0',
  crosshair: 'rgba(100, 110, 125, 0.45)',
  crosshairLabelBg: 'rgba(28, 32, 40, 0.92)',
  up: '#26a69a',
  down: '#ef5350',
  wickUp: '#26a69a',
  wickDown: '#ef5350',
  borderUp: '#4ecdc4',
  borderDown: '#ff6b6b',
  priceLine: 'rgba(200, 210, 220, 0.45)',
  /** Expected Move — quiet solid gray rails. */
  expectedMove: 'rgba(148, 156, 168, 0.28)',
  expectedMoveAxis: 'rgba(120, 128, 140, 0.72)',
  /** Max Pain — muted magenta. */
  maxPain: 'rgba(211, 95, 233, 0.55)',
  maxPainAxis: 'rgba(211, 95, 233, 0.88)',
  axisLabelText: 'rgba(232, 236, 242, 0.95)',
} as const

const STRIKE_LINE_MODES: Array<{ id: StrikeLinesMode; label: string; shortLabel: string }> = [
  { id: 'off', label: 'Off', shortLabel: 'Off' },
  { id: 'all', label: 'All', shortLabel: 'All' },
  { id: 'top2', label: 'Top 2', shortLabel: 'T2' },
]

type ChartHandle = {
  chart: IChartApi
  candles: ISeriesApi<'Candlestick'>
  priceLine: IPriceLine | null
  gexZones: GexZonePrimitive
  /** Custom canvas overlay: strike lines + right-side labels. */
  levelOverlay: GexLevelOverlayPrimitive
  /** Axis-only price lines (line hidden) for Y-scale strike pills. */
  levelAxisLines: IPriceLine[]
}

type ContextMenuState = { x: number; y: number }

type LevelSpec = {
  price: number
  color: string
  /** More opaque pill color for the Y-axis label. */
  axisColor: string
  title: string
  priority: number
  role: 'gex' | 'mp' | 'em'
}

export const GammaHeatmapChart = memo(function GammaHeatmapChart({
  snapshot,
  dataWindowPct = defaultHeatmapDataWindowPct,
  candleInterval: candleIntervalProp,
  onCandleIntervalChange,
  expiry,
  expiryOptions = [],
  onExpiryChange,
  headerLeft,
  headerRight,
  dragHandleProps,
  onClose,
  minHeight = defaultChartHeight,
}: GammaHeatmapChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<ChartHandle | null>(null)
  const candlesRef = useRef<OhlcCandle[]>([])
  const autoFitRef = useRef(true)
  const initialTimeAppliedRef = useRef(false)
  const intervalRef = useRef<CandleInterval>(HEATMAP_CANDLE_INTERVAL)
  /** Wall-clock range to restore after a TF switch (keeps the same "window of time"). */
  const pendingTimeRangeRef = useRef<VisibleTimeRange | null>(null)
  /** True until the first paint that matches the requested TF lands. */
  const tfSwitchPendingRef = useRef(false)
  const lastPaintedIntervalRef = useRef<CandleInterval | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [autoFitOn, setAutoFitOn] = useState(true)
  const [plotSwitching, setPlotSwitching] = useState(false)
  const [strikeLinesMode, setStrikeLinesMode] = useState<StrikeLinesMode>('off')
  /** GEX zone underlay on/off (independent of strike lines). */
  const [bandsVisible, setBandsVisible] = useState(true)
  const [localInterval, setLocalInterval] = useState<CandleInterval>(
    () =>
      (candleIntervalProp && isCandleInterval(candleIntervalProp)
        ? candleIntervalProp
        : HEATMAP_CANDLE_INTERVAL),
  )

  const gexOpacity = useTerminalStore((s) => s.heatmapIntensity)
  const setGexOpacity = useTerminalStore((s) => s.setHeatmapIntensity)

  const interval =
    candleIntervalProp && isCandleInterval(candleIntervalProp)
      ? candleIntervalProp
      : localInterval

  useEffect(() => {
    intervalRef.current = interval
  }, [interval])

  const defaultViewMs = heatmapAutoTimeWindowHours[interval] * 60 * 60 * 1000

  // Wide history window (90d) covers every TF; interval switch only changes bar size.
  const [fetchWindow] = useState(() => makeFetchWindow(HEATMAP_CANDLE_INTERVAL))

  const captureVisibleTimeRange = useCallback((): VisibleTimeRange | null => {
    const handle = handleRef.current
    if (!handle) return null
    try {
      const range = handle.chart.timeScale().getVisibleRange()
      if (!range) return null
      const from = timeToUnix(range.from)
      const to = timeToUnix(range.to)
      if (from == null || to == null || !(to > from)) return null
      return { from, to }
    } catch {
      return null
    }
  }, [])

  const setInterval = useCallback(
    (next: CandleInterval) => {
      if (!isCandleInterval(next) || next === interval) return
      // Preserve the wall-clock view so denser/sparser bars morph in place.
      pendingTimeRangeRef.current = captureVisibleTimeRange()
      tfSwitchPendingRef.current = true
      setPlotSwitching(true)
      if (onCandleIntervalChange) {
        onCandleIntervalChange(next)
      } else {
        setLocalInterval(next)
      }
    },
    [interval, onCandleIntervalChange, captureVisibleTimeRange],
  )

  // Keep zone inputs in refs so chart-create can paint zones without a ready-flag render.
  const zoneInputRef = useRef({
    gammaBars: snapshot.gammaBars,
    spot: snapshot.spot as number | null,
    chartPrice: null as number | null,
    dataWindowPct,
    gexOpacity,
  })

  const {
    candles,
    dataInterval,
    isLoading,
    isStale,
    error: feedError,
  } = useHyperliquidCandles({
    enabled: true,
    interval,
    windowStartMs: fetchWindow.start,
    windowEndMs: fetchWindow.end,
  })

  useEffect(() => {
    candlesRef.current = candles
  }, [candles])

  // Fade the plot back in if a TF switch aborts or finishes.
  useEffect(() => {
    if (!isStale && !tfSwitchPendingRef.current) {
      setPlotSwitching(false)
    }
  }, [isStale])

  const livePrice = useMemo(() => {
    if (candles.length === 0) return null
    const last = candles[candles.length - 1]!
    return Number.isFinite(last.c) && last.c > 0 ? last.c : null
  }, [candles])

  const chartPrice = livePrice ?? (snapshot.spot > 0 ? snapshot.spot : null)

  useEffect(() => {
    zoneInputRef.current = {
      gammaBars: snapshot.gammaBars,
      spot: snapshot.spot,
      chartPrice,
      dataWindowPct,
      gexOpacity,
    }
  }, [snapshot.gammaBars, snapshot.spot, chartPrice, dataWindowPct, gexOpacity])

  /** Enable native Y autoScale with fixed edge margins. */
  const enablePriceAutoFit = useCallback(() => {
    const handle = handleRef.current
    if (!handle) return
    autoFitRef.current = true
    setAutoFitOn(true)
    try {
      const scale = handle.chart.priceScale('right')
      scale.applyOptions({
        autoScale: true,
        scaleMargins: { top: PRICE_EDGE_MARGIN, bottom: PRICE_EDGE_MARGIN },
        borderVisible: false,
      })
      scale.setAutoScale(true)
      // Free X; vertical plot-pan off so it doesn't fight autoScale.
      handle.chart.applyOptions({
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
        handleScale: {
          axisPressedMouseMove: { time: true, price: true },
          mouseWheel: true,
          pinch: true,
        },
      })
    } catch {
      // ignore
    }
  }, [])

  /** Manual Y — leave price where the user set it. */
  const disablePriceAutoFit = useCallback(() => {
    if (!autoFitRef.current) return
    autoFitRef.current = false
    setAutoFitOn(false)
    const handle = handleRef.current
    if (!handle) return
    try {
      const scale = handle.chart.priceScale('right')
      scale.applyOptions({ autoScale: false })
      scale.setAutoScale(false)
      handle.chart.applyOptions({
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true,
        },
        handleScale: {
          axisPressedMouseMove: { time: true, price: true },
          mouseWheel: true,
          pinch: true,
        },
      })
    } catch {
      // ignore
    }
  }, [])

  /** Auto fit action: default time window + right buffer + Y autoScale. */
  const fitView = useCallback(() => {
    const handle = handleRef.current
    if (!handle) return
    const iv = intervalRef.current
    const viewMs = heatmapAutoTimeWindowHours[iv] * 60 * 60 * 1000
    applyDefaultTimeWindow(handle, candlesRef.current, viewMs, iv)
    // Re-assert right margin after layout (LWC sometimes collapses on setData).
    requestAnimationFrame(() => {
      const h = handleRef.current
      if (!h) return
      applyRightPad(h, candlesRef.current.length, viewMs, iv)
    })
    enablePriceAutoFit()
  }, [enablePriceAutoFit])

  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])

  const onAutoFitFromMenu = useCallback(() => {
    setCtxMenu(null)
    fitView()
  }, [fitView])

  // ── Chart create (once) ──────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let raf = 0
    let ro: ResizeObserver | null = null
    let handle: ChartHandle | null = null

    try {
      host.replaceChildren()
      const { w, h } = measure(host)

      const chart = createChart(host, {
        width: w,
        height: h,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: C.text,
          fontSize: 10,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          attributionLogo: false,
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { visible: false },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: C.crosshair,
            width: 1,
            style: LineStyle.Dashed,
            labelVisible: true,
            labelBackgroundColor: C.crosshairLabelBg,
          },
          horzLine: {
            color: C.crosshair,
            width: 1,
            style: LineStyle.Dashed,
            labelVisible: true,
            labelBackgroundColor: C.crosshairLabelBg,
          },
        },
        rightPriceScale: {
          borderVisible: false,
          scaleMargins: { top: PRICE_EDGE_MARGIN, bottom: PRICE_EDGE_MARGIN },
          entireTextOnly: true,
          autoScale: true,
        },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: RIGHT_OFFSET_BARS,
          minBarSpacing: MIN_BAR_SPACING,
          barSpacing: DEFAULT_BAR_SPACING,
          // Don't yank the user back to "now" on every bar — only after Auto fit.
          shiftVisibleRangeOnNewBar: false,
          fixLeftEdge: false,
          fixRightEdge: false,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
        handleScale: {
          axisPressedMouseMove: { time: true, price: true },
          mouseWheel: true,
          pinch: true,
        },
      })

      const candlesSeries = chart.addSeries(CandlestickSeries, {
        upColor: C.up,
        downColor: C.down,
        borderVisible: true,
        borderUpColor: C.borderUp,
        borderDownColor: C.borderDown,
        wickUpColor: C.wickUp,
        wickDownColor: C.wickDown,
        priceLineVisible: false,
        lastValueVisible: false,
      })

      // GEX price/gamma bands under candles (zOrder: bottom via the primitive).
      const gexZones = new GexZonePrimitive()
      candlesSeries.attachPrimitive(gexZones)

      // Strike / EM / MP lines + right-side labels (above zones).
      const levelOverlay = new GexLevelOverlayPrimitive()
      candlesSeries.attachPrimitive(levelOverlay)

      handle = {
        chart,
        candles: candlesSeries,
        priceLine: null,
        gexZones,
        levelOverlay,
        levelAxisLines: [],
      }
      handleRef.current = handle
      autoFitRef.current = true
      initialTimeAppliedRef.current = false
      // Paint zones immediately from latest snapshot (no chartEpoch re-render).
      applyGexZones(gexZones, zoneInputRef.current)

      // Price-axis drag → leave Auto fit (manual Y). X stays free either way.
      const onPointerDown = (ev: PointerEvent) => {
        if (ev.button === 2) return
        setCtxMenu(null)
        if (!autoFitRef.current) return

        const rect = host.getBoundingClientRect()
        const onPriceAxis = ev.clientX - rect.left > rect.width - 56
        if (!onPriceAxis) return

        let moved = false
        const onMove = () => {
          moved = true
        }
        const onUp = () => {
          host.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          if (moved) disablePriceAutoFit()
        }
        host.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }
      host.addEventListener('pointerdown', onPointerDown)

      const onWheel = (ev: WheelEvent) => {
        if (!autoFitRef.current) return
        const rect = host.getBoundingClientRect()
        // Wheel on price gutter = manual scale.
        if (ev.clientX - rect.left > rect.width - 56) {
          disablePriceAutoFit()
        }
      }
      host.addEventListener('wheel', onWheel, { passive: true })

      const onContextMenu = (ev: MouseEvent) => {
        if (disposed) return
        ev.preventDefault()
        ev.stopPropagation()
        const plot = plotRef.current
        if (!plot) return
        const rect = plot.getBoundingClientRect()
        const menuW = 148
        const menuH = 40
        let x = ev.clientX - rect.left
        let y = ev.clientY - rect.top
        x = Math.min(Math.max(4, x), Math.max(4, rect.width - menuW - 4))
        y = Math.min(Math.max(4, y), Math.max(4, rect.height - menuH - 4))
        setCtxMenu({ x, y })
      }
      host.addEventListener('contextmenu', onContextMenu)

      const onDblClick = (ev: MouseEvent) => {
        if (disposed || !handleRef.current) return
        ev.preventDefault()
        setCtxMenu(null)
        fitView()
      }
      host.addEventListener('dblclick', onDblClick)

      const syncSize = () => {
        if (disposed || !handleRef.current) return
        const next = measure(host)
        handleRef.current.chart.resize(next.w, next.h, true)
      }
      ro = new ResizeObserver(() => {
        if (raf) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(syncSize)
      })
      ro.observe(host)
      raf = requestAnimationFrame(syncSize)

      queueMicrotask(() => {
        if (!disposed) setError(null)
      })

      return () => {
        disposed = true
        if (raf) cancelAnimationFrame(raf)
        ro?.disconnect()
        host.removeEventListener('dblclick', onDblClick)
        host.removeEventListener('pointerdown', onPointerDown)
        host.removeEventListener('contextmenu', onContextMenu)
        host.removeEventListener('wheel', onWheel)
        handleRef.current = null
        try {
          handle?.chart.remove()
        } catch {
          // ignore
        }
        host.replaceChildren()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => setError(msg))
      console.error('[GammaHeatmapChart] create failed', err)
      return () => {
        disposed = true
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ctxMenu) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeCtxMenu()
    }
    const onDown = (ev: MouseEvent) => {
      if (ev.button === 2) return
      closeCtxMenu()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [ctxMenu, closeCtxMenu])

  // ── Candle data — hold last TF paint while the next interval loads ──────
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return

    // Stale buffer still belongs to the previous TF — leave series + scale alone.
    if (dataInterval !== interval) return

    try {
      const data = toCandleData(candles)
      const isTfLanding =
        tfSwitchPendingRef.current || lastPaintedIntervalRef.current !== dataInterval

      handle.candles.setData(data)
      lastPaintedIntervalRef.current = dataInterval

      if (handle.priceLine) {
        try {
          handle.candles.removePriceLine(handle.priceLine)
        } catch {
          // ignore
        }
        handle.priceLine = null
      }
      if (chartPrice != null && chartPrice > 0) {
        handle.priceLine = handle.candles.createPriceLine({
          price: chartPrice,
          color: C.priceLine,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '',
        })
      }

      if (data.length === 0) return

      // First paint, or TF switch landing: restore wall-clock range or default window.
      if (!initialTimeAppliedRef.current || isTfLanding) {
        initialTimeAppliedRef.current = true
        tfSwitchPendingRef.current = false
        const preserved = pendingTimeRangeRef.current
        pendingTimeRangeRef.current = null

        if (preserved && preserved.to > preserved.from) {
          applyPreservedTimeRange(handle, preserved, data, defaultViewMs, dataInterval)
        } else {
          applyDefaultTimeWindow(handle, candles, defaultViewMs, dataInterval)
          requestAnimationFrame(() => {
            const h = handleRef.current
            if (!h) return
            applyRightPad(h, data.length, defaultViewMs, dataInterval)
          })
        }
        enablePriceAutoFit()
        // Fade plot back in after the scale settles.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setPlotSwitching(false))
        })
      }
    } catch (err) {
      console.error('[GammaHeatmapChart] candle update failed', err)
      const msg = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => setError(msg))
      tfSwitchPendingRef.current = false
      queueMicrotask(() => setPlotSwitching(false))
    }
  }, [candles, chartPrice, defaultViewMs, enablePriceAutoFit, interval, dataInterval])

  // ── GEX zones — current surface snapshot → full-width price bands ────────
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    if (!bandsVisible) {
      handle.gexZones.clear()
      return
    }
    applyGexZones(handle.gexZones, {
      gammaBars: snapshot.gammaBars,
      spot: snapshot.spot,
      chartPrice,
      dataWindowPct,
      gexOpacity,
    })
  }, [snapshot.gammaBars, snapshot.spot, chartPrice, dataWindowPct, gexOpacity, bandsVisible])

  // ── Strike / EM / MP lines + labels ──────────────────────────────────────
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    applyLevelOverlay(handle, {
      mode: strikeLinesMode,
      gammaBars: snapshot.gammaBars,
      spot: snapshot.spot,
      chartPrice,
      dataWindowPct,
      gexOpacity,
      reference: snapshot.reference,
    })
  }, [
    strikeLinesMode,
    snapshot.gammaBars,
    snapshot.spot,
    snapshot.reference,
    chartPrice,
    dataWindowPct,
    gexOpacity,
  ])

  const empty = !isLoading && !isStale && candles.length === 0
  const showExpiry = Boolean(expiry && onExpiryChange && expiryOptions.length > 0)
  const showLoadingOverlay = isLoading && isStale && candles.length > 0

  return (
    <div
      ref={wrapRef}
      className={cn('relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden')}
      style={{ minHeight }}
    >
      <ChartPaneHeader
        title="BTC GEX BANDS"
        left={headerLeft}
        toolbar={(
          <>
            <ChartSegmentGroup
              label="Candle timeframe"
              pending={isStale || plotSwitching}
            >
              {candleIntervals.map((tf) => (
                <ChartSegmentButton
                  key={tf}
                  active={tf === interval}
                  aria-busy={Boolean((isStale || plotSwitching) && tf === interval)}
                  onClick={() => setInterval(tf)}
                >
                  {candleIntervalLabels[tf]}
                </ChartSegmentButton>
              ))}
            </ChartSegmentGroup>
            <label className="chart-pane-header__gex">
              <span className="chart-pane-header__meta-label">GEX</span>
              <input
                type="range"
                className="chart-pane-header__gex-slider"
                min={minHeatmapIntensity}
                max={maxHeatmapIntensity}
                step={1}
                value={clampHeatmapIntensity(gexOpacity)}
                aria-label="GEX zone opacity"
                aria-valuemin={minHeatmapIntensity}
                aria-valuemax={maxHeatmapIntensity}
                aria-valuenow={clampHeatmapIntensity(gexOpacity)}
                onChange={(e) => setGexOpacity(Number(e.target.value))}
                onDoubleClick={() => setGexOpacity(defaultHeatmapIntensity)}
                disabled={!bandsVisible}
              />
            </label>
            <OverlaySettingsMenu
              strikeLinesMode={strikeLinesMode}
              onStrikeLinesModeChange={setStrikeLinesMode}
              bandsVisible={bandsVisible}
              onBandsVisibleChange={setBandsVisible}
            />
          </>
        )}
        right={(
          <>
            {headerRight}
            {showExpiry && expiry && onExpiryChange ? (
              <ChartExpirySelect
                expiry={expiry}
                expiryOptions={expiryOptions}
                onExpiryChange={onExpiryChange}
              />
            ) : null}
            <ChartPaneActions dragHandleProps={dragHandleProps} onClose={onClose} />
          </>
        )}
      />

      <div
        ref={plotRef}
        className={cn(
          'heatmap-lwc-wrap price-gamma-plot relative min-h-0 w-full flex-1',
          plotSwitching && 'price-gamma-plot--switching',
        )}
      >
        <div ref={hostRef} className="heatmap-lwc-canvas absolute inset-0" />

        {ctxMenu ? (
          <div
            className="heatmap-chart-ctx"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className={cn(
                'heatmap-chart-ctx__item',
                autoFitOn && 'heatmap-chart-ctx__item--active',
              )}
              onClick={onAutoFitFromMenu}
              aria-checked={autoFitOn}
            >
              <span className="heatmap-chart-ctx__glyph" aria-hidden>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path
                    d="M1.5 3.25V1.5H3.25M6.75 1.5H8.5V3.25M8.5 6.75V8.5H6.75M3.25 8.5H1.5V6.75"
                    stroke="currentColor"
                    strokeWidth="1.15"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="heatmap-chart-ctx__label">Auto fit</span>
            </button>
          </div>
        ) : null}

        {isLoading && candles.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 z-[4] flex items-center justify-center">
            <div className="rounded border border-[var(--terminal-border)] bg-[var(--terminal-surface)]/90 px-3 py-2 text-[10px] text-[var(--terminal-muted)]">
              Loading Hyperliquid {interval} OHLC…
            </div>
          </div>
        ) : null}

        {showLoadingOverlay ? (
          <div className="price-gamma-plot__tf-hint pointer-events-none absolute right-3 top-2 z-[5]">
            {interval}
          </div>
        ) : null}

        {empty ? (
          <div className="pointer-events-none absolute inset-0 z-[4] flex items-center justify-center">
            <div className="rounded border border-[var(--terminal-border)] bg-[var(--terminal-surface)]/90 px-3 py-2 text-center text-[10px] text-[var(--terminal-muted)]">
              No HL candles
              {feedError ? <span className="mt-0.5 block opacity-70">{feedError}</span> : null}
            </div>
          </div>
        ) : null}

        {error || feedError ? (
          <div className="pointer-events-none absolute bottom-6 left-1/2 z-[6] max-w-[90%] -translate-x-1/2 rounded border border-amber-500/40 bg-black/75 px-3 py-1.5 text-center text-[10px] text-amber-200/90">
            {error ?? feedError}
          </div>
        ) : null}
      </div>
    </div>
  )
})

/* ── helpers ──────────────────────────────────────────────────────────────── */

function makeFetchWindow(interval: CandleInterval) {
  const now = Date.now()
  const step = candleIntervalMs[interval]
  const historyMs = HL_CANDLE_HISTORY_DAYS * 24 * 60 * 60 * 1000
  return {
    start: now - historyMs - step,
    end: now + heatmapLookaheadMs + step,
  }
}

function timeToUnix(t: Time): number | null {
  if (typeof t === 'number' && Number.isFinite(t)) return t
  if (t && typeof t === 'object' && 'timestamp' in t) {
    const ts = (t as { timestamp?: number }).timestamp
    return typeof ts === 'number' && Number.isFinite(ts) ? ts : null
  }
  return null
}

/**
 * After a TF switch, keep the same wall-clock window so denser/sparser bars
 * morph in place instead of hard-snapping to a new default lookback.
 */
function applyPreservedTimeRange(
  handle: ChartHandle,
  range: VisibleTimeRange,
  data: Array<{ time: UTCTimestamp }>,
  fallbackViewMs: number,
  interval: CandleInterval,
) {
  if (data.length < 1) return
  const first = data[0]!.time as number
  const last = data[data.length - 1]!.time as number
  // Clamp preserved window into the new series domain.
  let from = Math.max(range.from, first)
  let to = Math.min(range.to, last + RIGHT_OFFSET_BARS * (candleIntervalMs[interval] / 1000))
  if (!(to > from)) {
    applyRightPad(handle, data.length, fallbackViewMs, interval)
    return
  }
  // Ensure a minimum span so ultra-zoomed windows don't collapse on coarse TF.
  const minSpanSec = Math.max(8, Math.round(fallbackViewMs / 1000 / 6))
  if (to - from < minSpanSec) {
    to = Math.min(last + RIGHT_OFFSET_BARS * (candleIntervalMs[interval] / 1000), from + minSpanSec)
    from = Math.max(first, to - minSpanSec)
  }
  try {
    handle.chart.timeScale().setVisibleRange({
      from: from as UTCTimestamp,
      to: to as UTCTimestamp,
    })
  } catch {
    applyRightPad(handle, data.length, fallbackViewMs, interval)
  }
}

type ZoneInput = {
  gammaBars: HeatmapSnapshot['gammaBars']
  spot: number | null | undefined
  chartPrice: number | null
  dataWindowPct: number | 'full'
  gexOpacity: number
}

function applyGexZones(primitive: GexZonePrimitive, input: ZoneInput) {
  try {
    const windowPct =
      input.dataWindowPct === 'full'
        ? ('full' as const)
        : Number.isFinite(input.dataWindowPct as number) && (input.dataWindowPct as number) > 0
          ? (input.dataWindowPct as number)
          : defaultHeatmapDataWindowPct

    // Intensity 20–100 scales the soft desk underlay (candles stay primary).
    const t = clampHeatmapIntensity(input.gexOpacity) / 100
    const minAlpha = 0.04 + t * 0.08
    const maxAlpha = 0.1 + t * 0.22
    const spot =
      input.chartPrice != null && input.chartPrice > 0
        ? input.chartPrice
        : input.spot != null && input.spot > 0
          ? input.spot
          : null

    primitive.setZones(
      buildGexZonesFromBars(input.gammaBars, {
        spot,
        windowPct,
        minAlpha,
        maxAlpha,
      }),
    )
  } catch (err) {
    console.error('[GammaHeatmapChart] gex zone update failed', err)
  }
}

type LevelOverlayInput = {
  mode: StrikeLinesMode
  gammaBars: HeatmapSnapshot['gammaBars']
  spot: number | null | undefined
  chartPrice: number | null
  dataWindowPct: number | 'full'
  gexOpacity: number
  reference?: HeatmapReferenceMetric[] | null
}

function clearLevelAxisLines(handle: ChartHandle) {
  if (handle.levelAxisLines.length === 0) return
  for (const line of handle.levelAxisLines) {
    try {
      handle.candles.removePriceLine(line)
    } catch {
      // ignore — series may already be disposed
    }
  }
  handle.levelAxisLines = []
}

/** Y-axis strike pills for every unique level price (line itself is canvas-drawn). */
function applyLevelAxisLines(handle: ChartHandle, specs: LevelSpec[]) {
  clearLevelAxisLines(handle)
  if (specs.length === 0) return

  // One pill per unique price; prefer higher-priority (GEX wall) color.
  const byPrice = new Map<number, LevelSpec>()
  for (const s of specs) {
    const prev = byPrice.get(s.price)
    if (!prev || s.priority > prev.priority) byPrice.set(s.price, s)
  }

  const created: IPriceLine[] = []
  for (const spec of byPrice.values()) {
    if (!Number.isFinite(spec.price) || spec.price <= 0) continue
    const axisColor = spec.axisColor || opaqueAxisColor(spec.color)
    try {
      created.push(
        handle.candles.createPriceLine({
          price: spec.price,
          color: axisColor,
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          lineVisible: false,
          axisLabelVisible: true,
          title: '',
          axisLabelColor: axisColor,
          axisLabelTextColor: C.axisLabelText,
        }),
      )
    } catch {
      // skip individual failures
    }
  }
  handle.levelAxisLines = created
}

function applyLevelOverlay(handle: ChartHandle, input: LevelOverlayInput) {
  try {
    if (input.mode === 'off') {
      handle.levelOverlay.clear()
      clearLevelAxisLines(handle)
      return
    }

    const specs = buildLevelSpecs(input)
    if (specs.length === 0) {
      handle.levelOverlay.clear()
      clearLevelAxisLines(handle)
      return
    }

    // Canvas overlay draws the actual lines + right-side labels (with merge).
    const overlayItems: GexLevelOverlayItem[] = specs.map((s) => ({
      price: s.price,
      color: s.color,
      title: s.title,
      priority: s.priority,
      role: s.role,
      axisColor: s.axisColor,
    }))
    handle.levelOverlay.setLevels(overlayItems)

    // Themed Y-axis strike values for every level price.
    applyLevelAxisLines(handle, specs)
  } catch (err) {
    console.error('[GammaHeatmapChart] level overlay update failed', err)
  }
}

function buildLevelSpecs(input: LevelOverlayInput): LevelSpec[] {
  const windowPct =
    input.dataWindowPct === 'full'
      ? null
      : Number.isFinite(input.dataWindowPct as number) && (input.dataWindowPct as number) > 0
        ? (input.dataWindowPct as number)
        : defaultHeatmapDataWindowPct

  const anchor =
    input.chartPrice != null && input.chartPrice > 0
      ? input.chartPrice
      : input.spot != null && input.spot > 0
        ? input.spot
        : null

  // Same intensity envelope as the band underlay (GEX slider).
  const t = clampHeatmapIntensity(input.gexOpacity) / 100
  const minAlpha = 0.04 + t * 0.08
  const maxAlpha = 0.1 + t * 0.22
  // Thin strokes need a small readability boost over filled bands.
  const lineMinAlpha = Math.min(0.85, minAlpha * 2.4)
  const lineMaxAlpha = Math.min(0.92, maxAlpha * 2.6)

  const rows = collectWindowedStrikeGex(input.gammaBars, anchor, windowPct)
  const specs: LevelSpec[] = []

  if (rows.length > 0) {
    let maxAbs = 0
    for (const r of rows) {
      const a = Math.abs(r.net)
      if (a > maxAbs) maxAbs = a
    }

    const positives = rows
      .filter((r) => r.net > 0)
      .sort((a, b) => b.net - a.net)
    const negatives = rows
      .filter((r) => r.net < 0)
      .sort((a, b) => a.net - b.net) // most negative first

    const pickPos = input.mode === 'top2' ? positives.slice(0, 2) : positives
    const pickNeg = input.mode === 'top2' ? negatives.slice(0, 2) : negatives

    pickPos.forEach((row, index) => {
      const colors = strikeLineColors(row.net, maxAbs, lineMinAlpha, lineMaxAlpha)
      specs.push({
        price: row.strike,
        color: colors.line,
        axisColor: colors.axis,
        title: formatStrikeGexLabel('PG', index + 1, row.net),
        // Stronger walls win merge color / price anchor.
        priority: 100 + (Math.abs(row.net) / Math.max(maxAbs, 1)) * 10,
        role: 'gex',
      })
    })
    pickNeg.forEach((row, index) => {
      const colors = strikeLineColors(row.net, maxAbs, lineMinAlpha, lineMaxAlpha)
      specs.push({
        price: row.strike,
        color: colors.line,
        axisColor: colors.axis,
        title: formatStrikeGexLabel('NG', index + 1, row.net),
        priority: 100 + (Math.abs(row.net) / Math.max(maxAbs, 1)) * 10,
        role: 'gex',
      })
    })
  }

  // Reference markers — always when lines mode is active.
  const ref = input.reference ?? []
  const maxPain = parseReferencePrice(
    ref.find((m) => m.label.includes('Max Pain'))?.value,
  )
  if (maxPain != null) {
    specs.push({
      price: maxPain,
      color: C.maxPain,
      axisColor: C.maxPainAxis,
      title: 'MP',
      priority: 40,
      role: 'mp',
    })
  }

  const emMetric = ref.find((m) => m.label.includes('Expected Move'))
  const emRange = emMetric ? splitExpectedMoveRange(emMetric.value) : null
  if (emRange) {
    if (emRange.lower != null) {
      specs.push({
        price: emRange.lower,
        color: C.expectedMove,
        axisColor: C.expectedMoveAxis,
        title: 'EM −',
        priority: 10,
        role: 'em',
      })
    }
    if (emRange.upper != null) {
      specs.push({
        price: emRange.upper,
        color: C.expectedMove,
        axisColor: C.expectedMoveAxis,
        title: 'EM +',
        priority: 10,
        role: 'em',
      })
    }
  }

  return specs
}

type StrikeGexRow = { strike: number; net: number }

function collectWindowedStrikeGex(
  bars: HeatmapSnapshot['gammaBars'] | null | undefined,
  spot: number | null,
  windowPct: number | null,
): StrikeGexRow[] {
  if (!bars || bars.length === 0) return []

  const byStrike = new Map<number, number>()
  for (const b of bars) {
    const strike = Number(b.strike)
    if (!Number.isFinite(strike) || strike <= 0) continue
    const netRaw =
      b.netGammaExposureUsd != null && Number.isFinite(b.netGammaExposureUsd)
        ? b.netGammaExposureUsd
        : b.gammaExposureUsd
    const net = Number(netRaw)
    if (!Number.isFinite(net) || net === 0) continue
    if (spot != null && windowPct != null) {
      const distPct = (Math.abs(strike - spot) / spot) * 100
      if (distPct > windowPct) continue
    }
    byStrike.set(strike, net)
  }

  return [...byStrike.entries()]
    .map(([strike, net]) => ({ strike, net }))
    .sort((a, b) => a.strike - b.strike)
}

/**
 * Color-grade thin strike lines to match zone banding (teal / red by strength).
 * Alpha uses the same shaped curve as GexZonePrimitive, scaled for hairlines.
 */
function strikeLineColors(
  net: number,
  maxAbs: number,
  minAlpha: number,
  maxAlpha: number,
): { line: string; axis: string } {
  const peak = maxAbs > 0 ? maxAbs : 1
  const unit = clampUnit(net / peak, -1, 1)
  const mag = Math.abs(unit)
  const deadZone = 0.04
  const gated = mag <= deadZone ? 0 : (mag - deadZone) / (1 - deadZone)
  const shaped = Math.pow(Math.min(1, Math.max(0, gated)), 0.65)
  const alpha = minAlpha + shaped * (maxAlpha - minAlpha)
  // Axis pill needs higher opacity so strike values stay legible.
  const axisAlpha = Math.min(0.95, 0.55 + shaped * 0.4)

  if (unit >= 0) {
    // Long gamma — same teal family as zone underlay, slightly brighter for strokes.
    const r = Math.round(14 + (34 - 14) * shaped)
    const g = Math.round(88 + (170 - 88) * shaped)
    const b = Math.round(82 + (150 - 82) * shaped)
    return {
      line: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`,
      axis: `rgba(${r}, ${g}, ${b}, ${axisAlpha.toFixed(3)})`,
    }
  }

  // Short gamma — red-brown family
  const r = Math.round(120 + (200 - 120) * shaped)
  const g = Math.round(32 + (70 - 32) * shaped)
  const b = Math.round(36 + (80 - 36) * shaped)
  return {
    line: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`,
    axis: `rgba(${r}, ${g}, ${b}, ${axisAlpha.toFixed(3)})`,
  }
}

function opaqueAxisColor(color: string): string {
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color)
  if (rgba) {
    return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, 0.82)`
  }
  return color
}

/** Compact label: `PG1 (+3.43m)` — merge joins fragments with ` / `. */
function formatStrikeGexLabel(kind: 'PG' | 'NG', rank: number, net: number): string {
  const millions = Math.abs(net) / 1_000_000
  const body =
    millions >= 100
      ? millions.toFixed(0)
      : millions >= 10
        ? millions.toFixed(1)
        : millions.toFixed(2)
  const sign = net > 0 ? '+' : net < 0 ? '-' : ''
  return `${kind}${rank} (${sign}${body}m)`
}

/* ── Overlay settings dropdown ──────────────────────────────────────────── */

function OverlaySettingsMenu({
  strikeLinesMode,
  onStrikeLinesModeChange,
  bandsVisible,
  onBandsVisibleChange,
}: {
  strikeLinesMode: StrikeLinesMode
  onStrikeLinesModeChange: (mode: StrikeLinesMode) => void
  bandsVisible: boolean
  onBandsVisibleChange: (visible: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  const active = strikeLinesMode !== 'off' || !bandsVisible
  const summary =
    strikeLinesMode === 'off'
      ? bandsVisible
        ? 'Bands'
        : 'Clear'
      : strikeLinesMode === 'top2'
        ? 'Top 2'
        : 'All'

  useLayoutEffect(() => {
    if (!open || !rootRef.current) {
      setMenuPos(null)
      return
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const menuW = 196
      const menuH = menuRef.current?.offsetHeight ?? 200
      const left = Math.min(
        Math.max(6, rect.left),
        window.innerWidth - menuW - 6,
      )
      const below = rect.bottom + 4
      const top =
        below + menuH > window.innerHeight - 6
          ? Math.max(6, rect.top - menuH - 4)
          : below
      setMenuPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="chart-pane-header__overlay-wrap">
      <button
        type="button"
        className={cn(
          'chart-pane-header__overlay-btn',
          open && 'chart-pane-header__overlay-btn--open',
          active && 'chart-pane-header__overlay-btn--active',
        )}
        aria-label="Overlay settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        title="Overlay settings"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <span className="chart-pane-header__overlay-icon" aria-hidden>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path
              d="M1.5 3.5h9M1.5 6h9M1.5 8.5h9"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
            <circle cx="4" cy="3.5" r="1.15" fill="currentColor" />
            <circle cx="8" cy="6" r="1.15" fill="currentColor" />
            <circle cx="5.5" cy="8.5" r="1.15" fill="currentColor" />
          </svg>
        </span>
        <span className="chart-pane-header__overlay-label">Overlay</span>
        <span className="chart-pane-header__overlay-summary">{summary}</span>
        <span className="chart-pane-header__overlay-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              id={panelId}
              role="dialog"
              aria-label="Overlay settings"
              className="chart-pane-header__overlay-menu"
              style={{ top: menuPos.top, left: menuPos.left }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="chart-pane-header__overlay-section">
                <div className="chart-pane-header__overlay-section-title">Strike lines</div>
                <div className="chart-pane-header__overlay-seg" role="radiogroup" aria-label="Strike line mode">
                  {STRIKE_LINE_MODES.map((opt) => {
                    const selected = strikeLinesMode === opt.id
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={cn(
                          'chart-pane-header__overlay-seg-btn',
                          selected && 'chart-pane-header__overlay-seg-btn--active',
                        )}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onStrikeLinesModeChange(opt.id)
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
                <p className="chart-pane-header__overlay-hint">
                  Horizontal PG / NG / EM / MP levels for the selected expiry.
                </p>
              </div>

              <div className="chart-pane-header__overlay-divider" />

              <div className="chart-pane-header__overlay-section">
                <div className="chart-pane-header__overlay-section-title">Bands</div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={bandsVisible}
                  className={cn(
                    'chart-pane-header__overlay-toggle',
                    bandsVisible && 'chart-pane-header__overlay-toggle--on',
                  )}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onBandsVisibleChange(!bandsVisible)
                  }}
                >
                  <span className="chart-pane-header__overlay-toggle-track" aria-hidden>
                    <span className="chart-pane-header__overlay-toggle-thumb" />
                  </span>
                  <span className="chart-pane-header__overlay-toggle-text">
                    {bandsVisible ? 'GEX bands on' : 'GEX bands off'}
                  </span>
                </button>
                <p className="chart-pane-header__overlay-hint">
                  Turn off to read strike lines alone.
                </p>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function parseReferencePrice(value: string | undefined | null): number | null {
  if (!value || value === '—') return null
  const n = Number(String(value).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Parse `$73,500-$82,000` style Expected Move bands. */
function splitExpectedMoveRange(
  value: string,
): { lower: number | null; upper: number | null } | null {
  const rangeSeparator = value.indexOf('-$')
  if (rangeSeparator === -1) {
    // Fallback: any two dollar amounts
    const matches = value.match(/-?\$?[\d,]+(?:\.\d+)?/g)
    if (!matches || matches.length < 2) return null
    const lower = parseReferencePrice(matches[0])
    const upper = parseReferencePrice(matches[1])
    if (lower == null && upper == null) return null
    return { lower, upper }
  }
  return {
    lower: parseReferencePrice(value.slice(0, rangeSeparator)),
    upper: parseReferencePrice(value.slice(rangeSeparator + 1)),
  }
}

function clampUnit(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

function toCandleData(candles: OhlcCandle[]) {
  const out: Array<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }> =
    []
  let last = -Infinity
  for (const c of candles) {
    if (!Number.isFinite(c.t)) continue
    const t = Math.floor(c.t / 1000) as UTCTimestamp
    if (t <= last) continue
    if (![c.o, c.h, c.l, c.c].every((v) => Number.isFinite(v))) continue
    const high = Math.max(c.h, c.o, c.c, c.l)
    const low = Math.min(c.l, c.o, c.c, c.h)
    last = t
    out.push({ time: t, open: c.o, high, low, close: c.c })
  }
  return out
}

/**
 * Default X window (load + Auto fit).
 * Uses logical range so empty bars past the last index actually paint —
 * time-based setVisibleRange collapses when there is no series data in the future.
 */
function applyDefaultTimeWindow(
  handle: ChartHandle,
  candles: OhlcCandle[],
  viewMs: number,
  interval: CandleInterval,
) {
  applyRightPad(handle, candles.length, viewMs, interval)
}

/**
 * Pin visible logical range: [last - visibleBars, last + rightPad].
 * `to` past the last bar index is what creates the gap before the Y axis.
 */
function applyRightPad(
  handle: ChartHandle,
  barCount: number,
  viewMs: number,
  interval: CandleInterval,
) {
  if (barCount < 1) return
  const step = candleIntervalMs[interval]
  const visibleBars = Math.max(8, Math.round(viewMs / step))
  // Last series bar is logical index barCount - 1.
  const lastIdx = barCount - 1
  const from = lastIdx - visibleBars + 1
  const to = lastIdx + RIGHT_OFFSET_BARS

  try {
    const ts = handle.chart.timeScale()
    ts.applyOptions({
      rightOffset: RIGHT_OFFSET_BARS,
      barSpacing: DEFAULT_BAR_SPACING,
      minBarSpacing: MIN_BAR_SPACING,
      shiftVisibleRangeOnNewBar: false,
    })
    ts.setVisibleLogicalRange({ from, to })
  } catch {
    try {
      handle.chart.timeScale().scrollToRealTime()
    } catch {
      // ignore
    }
  }
}

function measure(el: HTMLElement): { w: number; h: number } {
  const rect = el.getBoundingClientRect()
  const w = Math.max(2, Math.floor(el.clientWidth || rect.width || 2))
  const h = Math.max(2, Math.floor(el.clientHeight || rect.height || 2))
  return { w, h }
}

export { defaultHeatmapDataWindowPct }
