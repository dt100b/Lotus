/**
 * Price/GEX pane — Hyperliquid OHLC with current GEX zone underlay.
 *
 * Header chrome: timeframe dropdown, GEX opacity slider, expiry.
 * GEX overlay = full-width horizontal zones from the live surface snapshot
 * for the selected expiry (series primitive, zOrder bottom). Candles stay on top.
 *
 * Overlay menu:
 *  - GEX lines: Off / Peaks / Top 5 / Top 10 (default) — selects strike set
 *  - Values on/off (default on) — GEX net text next to levels
 *  - Key levels off by default: MP, HVL, EM±
 *  - Bands on, Gamma Flow theme default
 *  - Four candle color palettes
 *
 * Refs stay short tags.
 * HVL = cumulative flow-GEX zero-cross on the selected-expiry surface within
 * spot ±12% (mass filter 1.5%). Not classic OI gamma flip.
 * (taker-flow inventory; see `@/lib/zeroGamma`).
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
  candleIntervalMs,
  isCandleInterval,
  maxHistoryMsForInterval,
  type CandleInterval,
  type OhlcCandle,
} from '@/api/hyperliquidCandles'
import type { GexExpiry } from '@/api/mockGexData'
import {
  ChartExpirySelect,
  ChartPaneActions,
  ChartPaneHeader,
  ChartTimeframeSelect,
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
import { syncLinkedStrikeLines } from '@/components/terminal/lwc/linkedStrikeLine'
import {
  defaultGexBandRenderModeId,
  defaultGexBandThemeId,
  defaultGexBandVoidStyleId,
  gexBandThemeIds,
  gexMistOpacityFromGex,
  getGexBandTheme,
  gexBandThemes,
  lerpRgb,
  priceGexBandTheme,
  rgbToCss,
  type GexBandRenderModeId,
  type GexBandThemeId,
} from '@/data/gexBandThemes'
import {
  candlePalettes,
  getCandlePalette,
  type CandlePaletteId,
} from '@/data/candlePalettes'
import {
  clampHeatmapIntensity,
  defaultHeatmapIntensity,
  maxHeatmapIntensity,
  minHeatmapIntensity,
} from '@/data/heatmapPalettes'
import { useHyperliquidCandles } from '@/hooks/useHyperliquidCandles'
import { barsToZeroGammaInput, estimateZeroGamma } from '@/lib/zeroGamma'
import { useTerminalStore } from '@/store/terminalStore'
import { cn } from '@/lib/utils'

type VisibleTimeRange = { from: number; to: number }

/** Strike-line overlay mode for the bands chart. */
export type StrikeLinesMode = 'off' | 'peaks' | 'top5' | 'top10'

/** Independent key-level rails (MP / HVL / EM) — separate from GEX strikes. */
export type OverlayRefFlags = {
  mp: boolean
  zg: boolean
  em: boolean
}

export type HeatmapReferenceMetric = {
  label: string
  value: string
  color?: string
  scopeLabel?: string
  status?: string
  note?: string
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
  /** Levels desk reference (Max Pain, Expected Move, Flip, …) for overlay lines. */
  reference?: HeatmapReferenceMetric[]
  /** Direct Gamma Flip (fallback when reference row is missing / no_cross). */
  gammaFlip?: number | null
  gammaFlipStatus?: 'ok' | 'no_cross'
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
export const HEATMAP_CANDLE_INTERVAL: CandleInterval = '30m'
/**
 * @deprecated Prefer {@link maxHistoryMsForInterval} — HL caps history at ~5k bars.
 * Kept as a rough calendar ceiling for coarser TFs / pan limits.
 */
export const HL_CANDLE_HISTORY_DAYS = Math.ceil(
  maxHistoryMsForInterval('1d') / (24 * 60 * 60 * 1000),
)

/** Default visible lookback when Auto fit / first paint applies the time window. */
export const heatmapAutoTimeWindowHours: Record<CandleInterval, number> = {
  '1m': 6,
  '5m': 24,
  '15m': 48,
  '30m': 72,
  '1h': 7 * 24,
  '4h': 30 * 24,
  '1d': 180 * 24,
}

export const defaultHeatmapTimeWindowHours = heatmapAutoTimeWindowHours['30m']
export const minHeatmapTimeWindowHours = 1
/** Widest pan lookback = full HL depth on daily bars. */
export const maxHeatmapTimeWindowHours = Math.ceil(maxHistoryMsForInterval('1d') / (60 * 60 * 1000))
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
  /** Expected Move — solid axis-side ticks (not full-width rails). */
  expectedMove: 'rgba(148, 168, 180, 0.72)',
  expectedMoveAxis: 'rgba(160, 176, 188, 0.88)',
  /** Max Pain — muted magenta. */
  maxPain: 'rgba(211, 95, 233, 0.62)',
  maxPainAxis: 'rgba(211, 95, 233, 0.9)',
  /** HVL — amber cumulative-zero marker (matches Levels desk). */
  zeroGamma: 'rgba(208, 188, 98, 0.72)',
  zeroGammaAxis: 'rgba(208, 188, 98, 0.78)',
  /**
   * Default axis-pill text when no role accent is available.
   * Level axis labels use transparent bg + role-tinted text ({@link quietAxisText}).
   */
  axisLabelText: 'rgba(220, 226, 234, 0.94)',
} as const

const STRIKE_LINE_MODES: Array<{ id: StrikeLinesMode; label: string; shortLabel: string }> = [
  { id: 'off', label: 'Off', shortLabel: 'Off' },
  { id: 'peaks', label: 'Peaks', shortLabel: 'Pk' },
  { id: 'top5', label: 'Top 5', shortLabel: 'T5' },
  { id: 'top10', label: 'Top 10', shortLabel: 'T10' },
]

/** Defaults: Top-10 lines + values, no bands, no key levels, mono candles. */
const DEFAULT_OVERLAY_REFS: OverlayRefFlags = {
  mp: false,
  zg: false,
  em: false,
}

type ChartHandle = {
  chart: IChartApi
  candles: ISeriesApi<'Candlestick'>
  priceLine: IPriceLine | null
  linkedStrikeLines: Map<number, IPriceLine>
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
  /**
   * Canvas right-side chip text (GEX values + key-level tags).
   * Colliding chips merge as `+1.2m / EM` via priority packing.
   */
  title: string
  /**
   * Draw / merge priority (higher wins line + chip anchor).
   * HVL / MP beat GEX; EM is lowest (label-merge only, never steals the line).
   */
  priority: number
  role: 'gex' | 'mp' | 'em' | 'zg'
  /** When false, no hairline (label-only). Default true. */
  showLine?: boolean
  dash?: number[]
  lineWidth?: number
  /** Short axis-side tick (media px). Used by EM rails. */
  lineFromRightPx?: number
}

/** Key-level line/label priority (must exceed GEX ~100–110). */
const PRI_HVL = 220
const PRI_MP = 200
/** Expected Move: below GEX so EM never steals a GEX hairline; label merges instead. */
const PRI_EM = 10

export const GammaHeatmapChart = memo(function GammaHeatmapChart({
  snapshot,
  // Kept for API parity with profile charts; bands always use the full expiry surface.
  dataWindowPct: _dataWindowPct = defaultHeatmapDataWindowPct,
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
  void _dataWindowPct
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
  /** Skip full setData on live ticks when only the last bar OHLC changed. */
  const seriesStructureKeyRef = useRef('')
  const gexActiveStrike = useTerminalStore((state) => state.gexActiveStrike)
  const gexHoveredStrike = useTerminalStore((state) => state.gexHoveredStrike)
  const gexMarkedStrikes = useTerminalStore((state) => state.gexMarkedStrikes)
  const linkedStrikeRef = useRef({
    hovered: gexHoveredStrike,
    active: gexActiveStrike,
    marked: gexMarkedStrikes,
  })

  const [error, setError] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [autoFitOn, setAutoFitOn] = useState(true)
  const [plotSwitching, setPlotSwitching] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [strikeLinesMode, setStrikeLinesMode] = useState<StrikeLinesMode>('top10')
  /** GEX value text on strike lines (`+0.53m`). */
  const [showGexValues, setShowGexValues] = useState(true)
  /** Independent reference rails — MP / Flip / EM (not tied to strike mode). */
  const [overlayRefs, setOverlayRefs] = useState<OverlayRefFlags>(DEFAULT_OVERLAY_REFS)
  /** GEX zone overlay on/off (independent of strike lines). */
  const [bandsVisible, setBandsVisible] = useState(false)
  /** Selectable Gamma chroma applies to precision lines only. */
  const [gexLineTheme, setGexLineTheme] = useState<GexBandThemeId>(defaultGexBandThemeId)
  const [candlePaletteId, setCandlePaletteId] = useState<CandlePaletteId>(
    'mono',
  )
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

  useEffect(() => {
    linkedStrikeRef.current = {
      hovered: gexHoveredStrike,
      active: gexActiveStrike,
      marked: gexMarkedStrikes,
    }
    const handle = handleRef.current
    if (handle) syncLinkedStrikeLines(handle, linkedStrikeRef.current)
  }, [gexActiveStrike, gexHoveredStrike, gexMarkedStrikes])

  const defaultViewMs = heatmapAutoTimeWindowHours[interval] * 60 * 60 * 1000

  // Full HL-available depth for the active TF (~5k bars max per interval).
  const fetchWindow = useMemo(() => makeFetchWindow(interval), [interval])

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
  // Bands chart always paints the full selected-expiry surface (no ±spot crop).
  const zoneInputRef = useRef({
    gammaBars: snapshot.gammaBars,
    spot: snapshot.spot as number | null,
    chartPrice: null as number | null,
    dataWindowPct: 'full' as number | 'full',
    gexOpacity,
    renderMode: defaultGexBandRenderModeId as GexBandRenderModeId,
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
      // Full selected-expiry surface — never crop bands by spot window.
      dataWindowPct: 'full',
      gexOpacity,
      renderMode: defaultGexBandRenderModeId,
    }
  }, [
    snapshot.gammaBars,
    snapshot.spot,
    chartPrice,
    gexOpacity,
  ])

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
          lockVisibleTimeRangeOnResize: true,
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

      const initialCandlePalette = getCandlePalette('mono')
      const candlesSeries = chart.addSeries(CandlestickSeries, {
        upColor: initialCandlePalette.up,
        downColor: initialCandlePalette.down,
        borderVisible: true,
        borderUpColor: initialCandlePalette.borderUp,
        borderDownColor: initialCandlePalette.borderDown,
        wickUpColor: initialCandlePalette.wickUp,
        wickDownColor: initialCandlePalette.wickDown,
        priceLineVisible: false,
        lastValueVisible: false,
      })

      // GEX price/gamma bands under candles (zOrder: bottom via the primitive).
      const gexZones = new GexZonePrimitive()
      candlesSeries.attachPrimitive(gexZones)

      // Strike / Flip / EM / MP lines + right-side labels (above zones).
      const levelOverlay = new GexLevelOverlayPrimitive()
      candlesSeries.attachPrimitive(levelOverlay)

      handle = {
        chart,
        candles: candlesSeries,
        priceLine: null,
        linkedStrikeLines: new Map(),
        gexZones,
        levelOverlay,
        levelAxisLines: [],
      }
      handleRef.current = handle
      syncLinkedStrikeLines(handle, linkedStrikeRef.current)
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
    const handle = handleRef.current
    if (!handle) return
    const palette = getCandlePalette(candlePaletteId)
    handle.candles.applyOptions({
      upColor: palette.up,
      downColor: palette.down,
      borderUpColor: palette.borderUp,
      borderDownColor: palette.borderDown,
      wickUpColor: palette.wickUp,
      wickDownColor: palette.wickDown,
    })
  }, [candlePaletteId])

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
      const isTfLanding =
        tfSwitchPendingRef.current || lastPaintedIntervalRef.current !== dataInterval

      const nextKey =
        candles.length === 0
          ? 'empty'
          : `${dataInterval}|${candles.length}|${candles[0]!.t}|${candles[candles.length - 1]!.t}`
      const structureChanged = nextKey !== seriesStructureKeyRef.current

      // Live tick: only last bar OHLC / last price changed — never reset camera.
      if (
        !structureChanged
        && !isTfLanding
        && initialTimeAppliedRef.current
        && candles.length > 0
      ) {
        const last = candles[candles.length - 1]!
        try {
          handle.candles.update({
            time: Math.floor(last.t / 1000) as UTCTimestamp,
            open: last.o,
            high: last.h,
            low: last.l,
            close: last.c,
          })
        } catch {
          const data = toCandleData(candles)
          const preserved = handle.chart.timeScale().getVisibleLogicalRange()
          handle.candles.setData(data)
          if (preserved && preserved.to > preserved.from) {
            try {
              handle.chart.timeScale().setVisibleLogicalRange(preserved)
            } catch {
              // ignore
            }
          }
        }
        syncHeatmapPriceLine(handle, chartPrice)
        return
      }

      const data = toCandleData(candles)
      // Preserve pan/zoom across structural refreshes (new bar, reconnect).
      const preservedLogical =
        initialTimeAppliedRef.current && !isTfLanding
          ? handle.chart.timeScale().getVisibleLogicalRange()
          : null

      handle.candles.setData(data)
      lastPaintedIntervalRef.current = dataInterval
      seriesStructureKeyRef.current = nextKey
      syncHeatmapPriceLine(handle, chartPrice)

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
      } else if (preservedLogical && preservedLogical.to > preservedLogical.from) {
        // New bar / length change: keep the same logical window (no jump to "now").
        try {
          handle.chart.timeScale().setVisibleLogicalRange(preservedLogical)
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.error('[GammaHeatmapChart] candle update failed', err)
      const msg = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => setError(msg))
      tfSwitchPendingRef.current = false
      queueMicrotask(() => setPlotSwitching(false))
    }
  }, [candles, chartPrice, defaultViewMs, enablePriceAutoFit, interval, dataInterval])

  // ── GEX zones — full selected-expiry surface → full-width price bands ────
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
      // Always full surface for the active expiry book (no ±spot crop).
      dataWindowPct: 'full',
      gexOpacity,
      renderMode: defaultGexBandRenderModeId,
    })
  }, [
    snapshot.gammaBars,
    snapshot.spot,
    chartPrice,
    gexOpacity,
    bandsVisible,
  ])

  // ── Strike / Flip / EM / MP lines + labels ───────────────────────────────
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    applyLevelOverlay(handle, {
      mode: strikeLinesMode,
      showGexValues,
      gammaBars: snapshot.gammaBars,
      spot: snapshot.spot,
      chartPrice,
      dataWindowPct: 'full',
      gexOpacity,
      theme: gexLineTheme,
      reference: snapshot.reference,
      refs: overlayRefs,
      gammaFlip: snapshot.gammaFlip,
      gammaFlipStatus: snapshot.gammaFlipStatus,
    })
  }, [
    strikeLinesMode,
    showGexValues,
    overlayRefs,
    snapshot.gammaBars,
    snapshot.spot,
    snapshot.reference,
    snapshot.gammaFlip,
    snapshot.gammaFlipStatus,
    chartPrice,
    gexOpacity,
    gexLineTheme,
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
        title="Price/GEX"
        left={headerLeft}
        toolbar={(
          <div className="forward-surface-controls__primary price-gex-controls">
            <span className="forward-surface-controls__eyebrow">Greek</span>
            <div className="forward-surface-segments" role="group" aria-label="Price overlay Greek">
              <button
                type="button"
                className="forward-surface-segment forward-surface-segment--active"
                aria-pressed="true"
              >
                Gamma
              </button>
            </div>
            <button
              type="button"
              className={cn(
                'forward-surface-settings-btn',
                settingsOpen && 'forward-surface-settings-btn--active',
              )}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              Settings <span aria-hidden>{settingsOpen ? '−' : '+'}</span>
            </button>
          </div>
        )}
        right={(
          <>
            {headerRight}
            <ChartTimeframeSelect
              interval={interval}
              onIntervalChange={setInterval}
              pending={isStale || plotSwitching}
            />
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

      {settingsOpen ? (
        <div
          className="forward-surface-controls price-gex-settings"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="forward-surface-controls__settings">
            <label className="forward-surface-range-control price-gex-settings__opacity">
              <span>Opacity</span>
              <input
                type="range"
                min={minHeatmapIntensity}
                max={maxHeatmapIntensity}
                step={1}
                value={clampHeatmapIntensity(gexOpacity)}
                aria-label="GEX band opacity"
                aria-valuemin={minHeatmapIntensity}
                aria-valuemax={maxHeatmapIntensity}
                aria-valuenow={clampHeatmapIntensity(gexOpacity)}
                onInput={(event) => setGexOpacity(Number(event.currentTarget.value))}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={() => setGexOpacity(defaultHeatmapIntensity)}
              />
              <output>{clampHeatmapIntensity(gexOpacity)}%</output>
            </label>
            <OverlaySettingsMenu
              strikeLinesMode={strikeLinesMode}
              onStrikeLinesModeChange={setStrikeLinesMode}
              showGexValues={showGexValues}
              onShowGexValuesChange={setShowGexValues}
              overlayRefs={overlayRefs}
              onOverlayRefsChange={setOverlayRefs}
              bandsVisible={bandsVisible}
              onBandsVisibleChange={setBandsVisible}
              gexLineTheme={gexLineTheme}
              onGexLineThemeChange={setGexLineTheme}
              candlePaletteId={candlePaletteId}
              onCandlePaletteChange={setCandlePaletteId}
            />
            <IndicatorsMenu />
          </div>
        </div>
      ) : null}

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
  // Full available Hyperliquid history for this interval (~5k most recent bars).
  const historyMs = maxHistoryMsForInterval(interval)
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

/**
 * Map GEX slider (20…100) → unit 0…1 with smoothstep.
 * Defined before applyGexZones / buildLevelSpecs so HMR never leaves calls
 * without a binding (that was silencing all band paints).
 *   20% → floor ~0.055 / peak ~0.24 · 50% → ~0.12 / ~0.45 · 100% → ~0.24 / ~0.84
 */
const gexIntensityUnit = (raw: number): number => {
  const v = clampHeatmapIntensity(raw)
  const span = maxHeatmapIntensity - minHeatmapIntensity
  const u = span > 0 ? (v - minHeatmapIntensity) / span : 0
  const x = Math.min(1, Math.max(0, u))
  return x * x * (3 - 2 * x)
}

type ZoneInput = {
  gammaBars: HeatmapSnapshot['gammaBars']
  spot: number | null | undefined
  chartPrice: number | null
  dataWindowPct: number | 'full'
  gexOpacity: number
  renderMode: GexBandRenderModeId
}

function applyGexZones(primitive: GexZonePrimitive, input: ZoneInput) {
  try {
    const windowPct =
      input.dataWindowPct === 'full'
        ? ('full' as const)
        : Number.isFinite(input.dataWindowPct as number) && (input.dataWindowPct as number) > 0
          ? (input.dataWindowPct as number)
          : defaultHeatmapDataWindowPct

    // Intensity 20–100 → quiet terrace through a readable strike core.
    const t = gexIntensityUnit(input.gexOpacity)
    const minAlpha = 0.055 + t * 0.18
    const maxAlpha = 0.24 + t * 0.6
    const mistOpacity = gexMistOpacityFromGex(input.gexOpacity)
    const spot =
      input.chartPrice != null && input.chartPrice > 0
        ? input.chartPrice
        : input.spot != null && input.spot > 0
          ? input.spot
          : null

    primitive.setPaintStyle({
      renderMode: input.renderMode,
      // Classic bands carry their own stable palette; line themes are separate.
      theme: defaultGexBandThemeId,
      minAlpha,
      maxAlpha,
      voidStyle: defaultGexBandVoidStyleId,
      mistOpacity,
    })
    primitive.setZones(
      buildGexZonesFromBars(input.gammaBars, {
        spot,
        windowPct: windowPct === 'full' || windowPct == null ? 'full' : windowPct,
        minAlpha,
        maxAlpha,
        // A free price chart should stay transparent between meaningful walls.
        paintVoid: false,
        // Single peak-preserving pass: keeps flush same-sign gradients without
        // washing mid-tier rank (a second pass flattened weak hierarchy).
        smoothPasses: 1,
        contours: true,
        theme: priceGexBandTheme,
      }),
    )
  } catch (err) {
    console.error('[GammaHeatmapChart] gex zone update failed', err)
  }
}

type LevelOverlayInput = {
  mode: StrikeLinesMode
  /** GEX net value text (`+0.53m`) next to levels. */
  showGexValues: boolean
  gammaBars: HeatmapSnapshot['gammaBars']
  spot: number | null | undefined
  chartPrice: number | null
  dataWindowPct: number | 'full'
  gexOpacity: number
  theme: GexBandThemeId
  reference?: HeatmapReferenceMetric[] | null
  refs: OverlayRefFlags
  gammaFlip?: number | null
  gammaFlipStatus?: 'ok' | 'no_cross'
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

/**
 * Y-axis price pills for level prices (line itself is canvas-drawn).
 *
 * Role tags (HVL / MP / EM) and GEX value chips live on the canvas overlay so
 * collisions can merge as `+1.2m / EM`. Axis pills stay price-only to avoid a
 * second overlapping text layer on the scale.
 *
 * LWC price-line axis labels only support solid bg + text (no true transparent
 * pill). Match bg to the chart panel fill so boxes blend out; hierarchy lives
 * in role-tinted, strength-weighted value text.
 */
/** Max GEX axis pills — refs always kept; rest are hairlines only on canvas. */
const MAX_GEX_AXIS_LABELS = 14
/**
 * Vertical gap (media px) under which axis price pills are collapsed to one
 * row. Mirrors canvas label packing so EM + GEX do not stack two scale chips.
 */
const AXIS_LABEL_MIN_GAP_PX = 13

function applyLevelAxisLines(handle: ChartHandle, specs: LevelSpec[]) {
  clearLevelAxisLines(handle)
  if (specs.length === 0) return

  // One candidate per unique price; higher priority wins color / role.
  const byPrice = new Map<number, LevelSpec>()
  for (const s of specs) {
    const prev = byPrice.get(s.price)
    if (!prev || s.priority > prev.priority) byPrice.set(s.price, s)
  }

  // Density: keep all ref pills; only the strongest GEX walls get axis text
  // when a dense line set crowds the scale (canvas hairlines still draw each strike).
  const unique = [...byPrice.values()]
  const refs = unique.filter((s) => s.role !== 'gex')
  const gexAll = unique
    .filter((s) => s.role === 'gex')
    .sort((a, b) => b.priority - a.priority || a.price - b.price)
  const gexMaxPri = gexAll[0]?.priority ?? 100
  const gexMinPri = gexAll[gexAll.length - 1]?.priority ?? 100
  const gex = gexAll.slice(0, MAX_GEX_AXIS_LABELS)

  const candidates = [...gex, ...refs]
  // Pack by projected Y so near-coincident prices share one axis pill
  // (primary = highest priority — HVL/MP beat GEX; GEX beats EM).
  const axisSpecs = packAxisLabelSpecs(handle, candidates)

  const created: IPriceLine[] = []
  for (const spec of axisSpecs) {
    if (!Number.isFinite(spec.price) || spec.price <= 0) continue
    const accent = spec.axisColor || spec.color
    // Strength 0…1 for hierarchy: refs mid-high, GEX from priority ladder.
    let strength = 0.55
    if (spec.role === 'gex' && gexMaxPri > gexMinPri) {
      strength = (spec.priority - gexMinPri) / (gexMaxPri - gexMinPri)
      strength = 0.35 + strength * 0.65
    } else if (spec.role === 'zg') {
      strength = 0.85
    } else if (spec.role === 'mp') {
      strength = 0.7
    } else if (spec.role === 'em') {
      strength = 0.5
    }
    const axis = quietAxisText(accent, strength)
    try {
      // Axis pill only. Canvas owns visible level strokes + role/GEX text.
      // Transparent color + lineVisible:false so LWC never paints a full rail
      // (belt-and-suspenders — some builds still ghost a hairline otherwise).
      created.push(
        handle.candles.createPriceLine({
          price: spec.price,
          color: 'rgba(0,0,0,0)',
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          lineVisible: false,
          axisLabelVisible: true,
          // Price-only — role tags / `+1m / EM` live on the canvas overlay.
          title: '',
          axisLabelColor: axis.bg,
          axisLabelTextColor: axis.text,
        }),
      )
    } catch {
      // skip individual failures
    }
  }
  handle.levelAxisLines = created
}

/**
 * Collapse axis pills whose projected Y is within {@link AXIS_LABEL_MIN_GAP_PX}.
 * Higher priority keeps the price anchor (HVL/MP > GEX > EM).
 */
function packAxisLabelSpecs(handle: ChartHandle, specs: LevelSpec[]): LevelSpec[] {
  type Placed = LevelSpec & { y: number }
  const placed: Placed[] = []
  for (const s of specs) {
    if (!Number.isFinite(s.price) || s.price <= 0) continue
    let y: number | null = null
    try {
      y = handle.candles.priceToCoordinate(s.price)
    } catch {
      y = null
    }
    // No coordinate yet (scale not ready) — keep distinct prices, no Y packing.
    if (y == null || !Number.isFinite(y)) {
      placed.push({ ...s, y: Number.NaN })
      continue
    }
    placed.push({ ...s, y })
  }

  // Priority-first greedy pack (same hierarchy as canvas chips).
  placed.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.price - b.price
  })

  const kept: Placed[] = []
  for (const s of placed) {
    if (!Number.isFinite(s.y)) {
      // Unprojected: de-dupe exact price only.
      if (kept.some((k) => k.price === s.price)) continue
      kept.push(s)
      continue
    }
    const hit = kept.find(
      (k) => Number.isFinite(k.y) && Math.abs(k.y - s.y) < AXIS_LABEL_MIN_GAP_PX,
    )
    if (hit) continue // weaker (later) absorbed — primary already placed
    kept.push(s)
  }

  return kept
    .map(({ y: _y, ...spec }) => spec)
    .sort((a, b) => a.price - b.price)
}

function applyLevelOverlay(handle: ChartHandle, input: LevelOverlayInput) {
  try {
    const specs = buildLevelSpecs(input)
    if (specs.length === 0) {
      handle.levelOverlay.clear()
      clearLevelAxisLines(handle)
      return
    }

    // Canvas overlay draws lines + right-side labels (with merge).
    const overlayItems: GexLevelOverlayItem[] = specs.map((s) => ({
      price: s.price,
      color: s.color,
      title: s.title,
      priority: s.priority,
      role: s.role,
      axisColor: s.axisColor,
      showLine: s.showLine !== false,
      ...(s.dash ? { dash: s.dash } : {}),
      ...(s.lineWidth != null ? { lineWidth: s.lineWidth } : {}),
      ...(s.lineFromRightPx != null ? { lineFromRightPx: s.lineFromRightPx } : {}),
    }))
    handle.levelOverlay.setLevels(overlayItems)

    // Themed Y-axis strike values for every level price.
    applyLevelAxisLines(handle, specs)
  } catch (err) {
    console.error('[GammaHeatmapChart] level overlay update failed', err)
  }
}

function buildLevelSpecs(input: LevelOverlayInput): LevelSpec[] {
  // Bands chart uses the full selected-expiry surface unless a tighter window is forced.
  const windowPct =
    input.dataWindowPct === 'full'
      ? null
      : Number.isFinite(input.dataWindowPct as number) && (input.dataWindowPct as number) > 0
        ? (input.dataWindowPct as number)
        : null

  const anchor =
    input.chartPrice != null && input.chartPrice > 0
      ? input.chartPrice
      : input.spot != null && input.spot > 0
        ? input.spot
        : null

  // Same intensity envelope as the band underlay (GEX slider).
  const t = gexIntensityUnit(input.gexOpacity)
  const minAlpha = 0.055 + t * 0.18
  const maxAlpha = 0.24 + t * 0.6
  // Thin strokes need a small readability boost over filled bands.
  const lineMinAlpha = Math.min(0.88, minAlpha * 2.6)
  const lineMaxAlpha = Math.min(0.95, maxAlpha * 1.55 + 0.12)

  const rows = collectWindowedStrikeGex(input.gammaBars, anchor, windowPct)
  const specs: LevelSpec[] = []

  // One strike set from GEX lines mode.
  const picked =
    input.mode !== 'off' && rows.length > 0 ? pickStrikeRowsForMode(rows, input.mode) : []

  if (picked.length > 0) {
    let maxAbs = 0
    for (const r of rows) {
      const a = Math.abs(r.net)
      if (a > maxAbs) maxAbs = a
    }

    const theme = getGexBandTheme(input.theme)
    for (const row of picked) {
      const colors = strikeLineColors(row.net, maxAbs, lineMinAlpha, lineMaxAlpha, theme)
      const title = input.showGexValues ? formatNetGexLabel(row.net) : ''
      specs.push({
        price: row.strike,
        color: colors.line,
        axisColor: colors.axis,
        title,
        // Stronger walls win merge color / price anchor.
        priority: 100 + (Math.abs(row.net) / Math.max(maxAbs, 1)) * 10,
        role: 'gex',
        lineWidth: 1.1,
        showLine: true,
      })
    }
  }

  // Key levels — independent of strike-line mode.
  const ref = input.reference ?? []
  const flags = input.refs

  // Key levels — canvas owns role tags so they can merge with GEX (`+1.2m / EM`).
  // Priority: HVL / MP beat GEX hairlines; EM is lowest (label-only when overlapping).
  if (flags.mp) {
    const maxPain = parseReferencePrice(
      ref.find((m) => m.label.includes('Max Pain'))?.value,
    )
    if (maxPain != null) {
      specs.push({
        price: maxPain,
        color: C.maxPain,
        axisColor: C.maxPainAxis,
        title: 'MP',
        priority: PRI_MP,
        role: 'mp',
        lineWidth: 1.1,
      })
    }
  }

  if (flags.zg) {
    // HVL from the *selected expiry surface* (gammaBars on this pane).
    // HVL = cumulative flow-GEX zero-cross on this expiry within spot ±12%
    // (mass filter 1.5%). Not classic OI gamma flip. See `@/lib/zeroGamma`.
    const zgSpot =
      input.spot != null && input.spot > 0
        ? input.spot
        : anchor
    const zg = estimateZeroGamma(barsToZeroGammaInput(input.gammaBars), zgSpot)

    if (zg.status === 'ok') {
      specs.push({
        price: zg.level,
        color: C.zeroGamma,
        axisColor: C.zeroGammaAxis,
        title: 'HVL',
        priority: PRI_HVL,
        role: 'zg',
        lineWidth: 1.2,
        dash: [5, 3.5],
      })
    }
    // no_cross → no line (honest empty; do not invent from flattest bar).
  }

  if (flags.em) {
    const emMetric = ref.find((m) => m.label.includes('Expected Move'))
    const emRange = emMetric ? splitExpectedMoveRange(emMetric.value) : null
    if (emRange) {
      // Short solid tick at the axis only — never full-width, never dashed.
      // Canvas title "EM"; when co-located with GEX, pack merges to `+1.2m / EM`.
      const emTick: Pick<
        LevelSpec,
        'color' | 'axisColor' | 'title' | 'priority' | 'role' | 'lineWidth' | 'lineFromRightPx'
      > = {
        color: C.expectedMove,
        axisColor: C.expectedMoveAxis,
        title: 'EM',
        priority: PRI_EM,
        role: 'em',
        lineWidth: 1.25,
        lineFromRightPx: 44,
      }
      if (emRange.lower != null) {
        specs.push({
          price: emRange.lower,
          ...emTick,
        })
      }
      if (emRange.upper != null) {
        specs.push({
          price: emRange.upper,
          ...emTick,
        })
      }
    }
  }

  return specs
}

/** Compact net GEX label: `+3.4m`, `−1.75m`. */
function formatNetGexLabel(net: number): string {
  const millions = Math.abs(net) / 1_000_000
  if (!Number.isFinite(millions) || millions === 0) return '0'
  const body =
    millions >= 100
      ? millions.toFixed(0)
      : millions >= 10
        ? millions.toFixed(1)
        : millions >= 1
          ? millions.toFixed(1)
          : millions >= 0.1
            ? millions.toFixed(2)
            : millions.toFixed(2)
  const sign = net > 0 ? '+' : net < 0 ? '−' : ''
  return `${sign}${body}m`
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
 * Color-grade thin strike lines to match the active band theme.
 * Alpha uses the same shaped curve as GexZonePrimitive, scaled for hairlines.
 * Axis accent is the same hue at moderate opacity — text chrome via
 * {@link quietAxisText}.
 */
function strikeLineColors(
  net: number,
  maxAbs: number,
  minAlpha: number,
  maxAlpha: number,
  theme = getGexBandTheme(defaultGexBandThemeId),
): { line: string; axis: string } {
  const peak = maxAbs > 0 ? maxAbs : 1
  const unit = clampUnit(net / peak, -1, 1)
  const mag = Math.abs(unit)
  const deadZone = 0.02
  const gated = mag <= deadZone ? 0 : (mag - deadZone) / (1 - deadZone)
  // Match band mid-lift so hairlines track zone net-value hierarchy.
  const shaped = Math.pow(Math.min(1, Math.max(0, gated)), 0.58)
  const alpha = Math.min(0.9, minAlpha + shaped * (maxAlpha - minAlpha) + 0.08)
  const axisAlpha = Math.min(0.78, 0.42 + shaped * 0.28)

  // Soft mid → brighter line peak for hairline readability.
  const mid = unit >= 0 ? theme.longMid : theme.shortMid
  const linePeak = unit >= 0 ? theme.lineLong : theme.lineShort
  const rgb = lerpRgb(mid, linePeak, shaped)
  return {
    line: rgbToCss(rgb, alpha),
    axis: rgbToCss(rgb, axisAlpha),
  }
}

/**
 * Boxless axis label: LWC always paints a solid pill — match its fill to the
 * chart panel background so the box disappears. Hierarchy via text lift + alpha
 * (stronger walls read brighter on the scale).
 *
 * @param strength 0…1 wall weight (weak dim, strong near-white)
 */
function quietAxisText(accent: string, strength = 0.6): { bg: string; text: string } {
  const rgb = parseCssRgb(accent) ?? { r: 150, g: 158, b: 170 }
  const s = Math.min(1, Math.max(0, strength))
  // Weak: more accent, dimmer. Strong: lift toward white, higher alpha.
  const whiteMix = 0.42 + s * 0.38
  const tR = Math.min(255, Math.round(rgb.r * (1 - whiteMix) + 255 * whiteMix))
  const tG = Math.min(255, Math.round(rgb.g * (1 - whiteMix) + 255 * whiteMix))
  const tB = Math.min(255, Math.round(rgb.b * (1 - whiteMix) + 255 * whiteMix))
  const textA = 0.62 + s * 0.36
  // Subtle role wash on bg (stronger walls slightly more present)
  const bgBase = resolveChartAxisBgRgb()
  const wash = 0.04 + s * 0.08
  const bgR = Math.round(bgBase.r * (1 - wash) + rgb.r * wash)
  const bgG = Math.round(bgBase.g * (1 - wash) + rgb.g * wash)
  const bgB = Math.round(bgBase.b * (1 - wash) + rgb.b * wash)
  return {
    bg: `rgb(${bgR}, ${bgG}, ${bgB})`,
    text: `rgba(${tR}, ${tG}, ${tB}, ${textA.toFixed(3)})`,
  }
}

function resolveChartAxisBgRgb(): { r: number; g: number; b: number } {
  if (typeof window === 'undefined') return { r: 6, g: 8, b: 8 }
  const style = getComputedStyle(document.documentElement)
  const candidates = [
    style.getPropertyValue('--chart-panel-fill-mid').trim(),
    style.getPropertyValue('--chart-panel-fill-bottom').trim(),
    style.getPropertyValue('--terminal-surface').trim(),
  ]
  for (const raw of candidates) {
    if (!raw) continue
    const opaque = toOpaqueCssColor(raw)
    if (!opaque) continue
    const parsed = parseCssRgb(opaque)
    if (parsed) return parsed
  }
  return { r: 6, g: 8, b: 8 }
}

/** Normalize theme token to an opaque css color for canvas axis pills. */
function toOpaqueCssColor(raw: string): string | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim())
  if (hex) {
    let h = hex[1]!
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    return `#${h.toLowerCase()}`
  }
  const rgb = parseCssRgb(raw)
  if (rgb) return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
  return null
}

function parseCssRgb(color: string): { r: number; g: number; b: number } | null {
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color)
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
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
  return null
}

/* ── Overlay settings dropdown ──────────────────────────────────────────── */

function OverlaySettingsMenu({
  strikeLinesMode,
  onStrikeLinesModeChange,
  showGexValues,
  onShowGexValuesChange,
  overlayRefs,
  onOverlayRefsChange,
  bandsVisible,
  onBandsVisibleChange,
  gexLineTheme,
  onGexLineThemeChange,
  candlePaletteId,
  onCandlePaletteChange,
}: {
  strikeLinesMode: StrikeLinesMode
  onStrikeLinesModeChange: (mode: StrikeLinesMode) => void
  showGexValues: boolean
  onShowGexValuesChange: (show: boolean) => void
  overlayRefs: OverlayRefFlags
  onOverlayRefsChange: (next: OverlayRefFlags) => void
  bandsVisible: boolean
  onBandsVisibleChange: (visible: boolean) => void
  gexLineTheme: GexBandThemeId
  onGexLineThemeChange: (theme: GexBandThemeId) => void
  candlePaletteId: CandlePaletteId
  onCandlePaletteChange: (palette: CandlePaletteId) => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  const lineTheme = getGexBandTheme(gexLineTheme)
  const linesOff = strikeLinesMode === 'off'

  useLayoutEffect(() => {
    if (!open || !rootRef.current) {
      setMenuPos(null)
      return
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const menuW = 288
      const menuH = menuRef.current?.offsetHeight ?? 460
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
    requestAnimationFrame(place)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, gexLineTheme, candlePaletteId])

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

  const toggleRef = (key: keyof OverlayRefFlags) => {
    onOverlayRefsChange({ ...overlayRefs, [key]: !overlayRefs[key] })
  }

  return (
    <div ref={rootRef} className="chart-pane-header__overlay-wrap">
      <button
        type="button"
        className={cn(
          'chart-pane-header__overlay-btn',
          open && 'chart-pane-header__overlay-btn--open',
        )}
        aria-label="Overlay settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <span className="chart-pane-header__overlay-icon" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M1.5 3.25h9M1.5 6h9M1.5 8.75h9"
              stroke="currentColor"
              strokeWidth="1.15"
              strokeLinecap="round"
            />
            <circle cx="3.75" cy="3.25" r="1.05" fill="currentColor" />
            <circle cx="8.25" cy="6" r="1.05" fill="currentColor" />
            <circle cx="5.25" cy="8.75" r="1.05" fill="currentColor" />
          </svg>
        </span>
        <span className="chart-pane-header__overlay-label">Overlay</span>
        <span className="chart-pane-header__overlay-caret" aria-hidden>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path
              d="M1.75 2.85 4 5.15 6.25 2.85"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              id={panelId}
              role="dialog"
              aria-label="Overlay settings"
              className="chart-pane-header__overlay-menu chart-pane-header__overlay-menu--price-gex"
              style={{ top: menuPos.top, left: menuPos.left, width: 288 }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="chart-pane-header__menu-head">
                <div>
                  <span>Overlay</span>
                  <strong>Price/GEX</strong>
                </div>
                <span className="chart-pane-header__menu-status">{bandsVisible ? 'Bands live' : 'Lines only'}</span>
              </div>

              <div className="chart-pane-header__overlay-section">
                <div className="chart-pane-header__overlay-section-title-row">
                  <div>
                    <span className="chart-pane-header__overlay-section-title">Bands</span>
                    <small>Current gamma by strike</small>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={bandsVisible}
                    aria-label="Show GEX bands"
                    className={cn(
                      'chart-pane-header__compact-switch',
                      bandsVisible && 'chart-pane-header__compact-switch--on',
                    )}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onBandsVisibleChange(!bandsVisible)
                    }}
                  >
                    <span aria-hidden />
                    {bandsVisible ? 'On' : 'Off'}
                  </button>
                </div>
                <p className="chart-pane-header__overlay-hint">
                  Stable strike-anchored zones use a dedicated quiet palette.
                </p>
              </div>

              <div className="chart-pane-header__overlay-divider" />

              <div className="chart-pane-header__overlay-section">
                <div className="chart-pane-header__overlay-section-title-row">
                  <div>
                    <span className="chart-pane-header__overlay-section-title">GEX lines</span>
                    <small>Optional precision levels</small>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showGexValues}
                    aria-label="Show GEX value labels"
                    disabled={linesOff}
                    className={cn(
                      'chart-pane-header__compact-switch',
                      showGexValues && 'chart-pane-header__compact-switch--on',
                      linesOff && 'chart-pane-header__compact-switch--disabled',
                    )}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onShowGexValuesChange(!showGexValues)
                    }}
                  >
                    <span aria-hidden />
                    Values
                  </button>
                </div>
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
              </div>

              <div className="chart-pane-header__overlay-divider" />

              <div className="chart-pane-header__overlay-section">
                <div className="chart-pane-header__overlay-section-title">Key levels</div>
                <div className="chart-pane-header__level-grid">
                  <OverlayRefToggle
                    label="MP"
                    detail="Max Pain"
                    swatch={C.maxPain}
                    checked={overlayRefs.mp}
                    onToggle={() => toggleRef('mp')}
                  />
                  <OverlayRefToggle
                    label="HVL"
                    detail="Gamma flip"
                    swatch={C.zeroGamma}
                    checked={overlayRefs.zg}
                    onToggle={() => toggleRef('zg')}
                  />
                  <OverlayRefToggle
                    label="EM"
                    detail="Expected move"
                    swatch={C.expectedMove}
                    checked={overlayRefs.em}
                    onToggle={() => toggleRef('em')}
                  />
                </div>
              </div>

              <div className="chart-pane-header__overlay-divider" />

              <div className="chart-pane-header__overlay-section">
                <div className="chart-pane-header__overlay-section-title-row">
                  <div>
                    <span className="chart-pane-header__overlay-section-title">Candles</span>
                    <small>Price palette</small>
                  </div>
                </div>
                <div className="chart-pane-header__candle-grid" role="radiogroup" aria-label="Candle colors">
                  {candlePalettes.map((palette) => {
                    const selected = candlePaletteId === palette.id
                    return (
                      <button
                        key={palette.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={cn(
                          'chart-pane-header__candle-card',
                          selected && 'chart-pane-header__candle-card--active',
                        )}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onCandlePaletteChange(palette.id)
                        }}
                      >
                        <span className="chart-pane-header__candle-preview" aria-hidden>
                          <i style={{ color: palette.up, background: palette.up }} />
                          <i style={{ color: palette.down, background: palette.down }} />
                        </span>
                        <span>
                          <strong>{palette.label}</strong>
                          <small>{palette.description}</small>
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="chart-pane-header__overlay-theme-head">
                  <span className="chart-pane-header__overlay-theme-label">Line theme</span>
                  <span className="chart-pane-header__overlay-theme-value">{lineTheme.label}</span>
                </div>
                <div
                  className="chart-pane-header__palette-grid"
                  role="radiogroup"
                  aria-label="GEX line theme"
                >
                  {gexBandThemeIds.map((id) => {
                    const item = gexBandThemes[id]
                    const selected = gexLineTheme === id
                    const gradient = `linear-gradient(90deg, ${rgbToCss(item.shortPeak, 1)} 0%, ${rgbToCss(item.shortMid, 1)} 35%, #080b0f 50%, ${rgbToCss(item.longMid, 1)} 65%, ${rgbToCss(item.longPeak, 1)} 100%)`
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={cn(
                          'chart-pane-header__palette-card',
                          selected && 'chart-pane-header__palette-card--active',
                        )}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onGexLineThemeChange(id)
                        }}
                      >
                        <span className="chart-pane-header__palette-preview" style={{ background: gradient }} />
                        <small>{item.label}</small>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function OverlayRefToggle({
  label,
  detail,
  swatch,
  checked,
  onToggle,
}: {
  label: string
  detail: string
  swatch: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${detail} line`}
      className={cn(
        'chart-pane-header__overlay-toggle chart-pane-header__overlay-toggle--ref',
        checked && 'chart-pane-header__overlay-toggle--on',
      )}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
    >
      <span className="chart-pane-header__overlay-toggle-track" aria-hidden>
        <span className="chart-pane-header__overlay-toggle-thumb" />
      </span>
      <span
        className="chart-pane-header__overlay-swatch"
        style={{ background: swatch }}
        aria-hidden
      />
      <span className="chart-pane-header__overlay-toggle-text">
        <span className="chart-pane-header__overlay-ref-label">{label}</span>
        <span className="chart-pane-header__overlay-ref-detail">{detail}</span>
      </span>
    </button>
  )
}

/**
 * Indicators menu — empty shell for upcoming chart indicators (VWAP, EMAs, …).
 * Matches Overlay chrome so the header strip stays balanced.
 */
function IndicatorsMenu() {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useLayoutEffect(() => {
    if (!open || !rootRef.current) {
      setMenuPos(null)
      return
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const menuW = 240
      const menuH = menuRef.current?.offsetHeight ?? 120
      const left = Math.min(Math.max(6, rect.left), window.innerWidth - menuW - 6)
      const below = rect.bottom + 4
      const top =
        below + menuH > window.innerHeight - 6
          ? Math.max(6, rect.top - menuH - 4)
          : below
      setMenuPos({ top, left })
    }
    place()
    requestAnimationFrame(place)
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
        )}
        aria-label="Indicators"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <span className="chart-pane-header__overlay-icon" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M1.5 8.5 4 5.5 6 7l2.5-3.5 2 2"
              stroke="currentColor"
              strokeWidth="1.15"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M1.5 10h9"
              stroke="currentColor"
              strokeWidth="1.15"
              strokeLinecap="round"
              opacity="0.45"
            />
          </svg>
        </span>
        <span className="chart-pane-header__overlay-label">Indicators</span>
        <span className="chart-pane-header__overlay-caret" aria-hidden>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path
              d="M1.75 2.85 4 5.15 6.25 2.85"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              id={panelId}
              role="dialog"
              aria-label="Indicators"
              className="chart-pane-header__overlay-menu chart-pane-header__overlay-menu--indicators"
              style={{ top: menuPos.top, left: menuPos.left, width: 240 }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="chart-pane-header__menu-head">
                <div>
                  <span>Studies</span>
                  <strong>Indicators</strong>
                </div>
                <span className="chart-pane-header__menu-status">0 active</span>
              </div>
              <div className="chart-pane-header__overlay-section">
                <div className="chart-pane-header__indicator-empty">
                  <span aria-hidden>∿</span>
                  <strong>Price stays clean</strong>
                  <small>No indicators available yet</small>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

/**
 * Pick GEX strike rows for line overlays.
 * - peaks: largest +GEX and largest −GEX (up to 2)
 * - top5: five largest by |net| (true ranking, no synthetic levels)
 * - top10: ten largest by |net|
 */
function pickStrikeRowsForMode(rows: StrikeGexRow[], mode: StrikeLinesMode): StrikeGexRow[] {
  if (mode === 'off' || rows.length === 0) return []

  if (mode === 'peaks') {
    const positives = rows.filter((r) => r.net > 0).sort((a, b) => b.net - a.net)
    const negatives = rows.filter((r) => r.net < 0).sort((a, b) => a.net - b.net)
    const out: StrikeGexRow[] = []
    if (positives[0]) out.push(positives[0])
    if (negatives[0]) out.push(negatives[0])
    return out
  }

  if (mode === 'top5' || mode === 'top10') {
    return [...rows]
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.strike - b.strike)
      .slice(0, mode === 'top5' ? 5 : 10)
  }

  return []
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

/** Move last-price line without remove/recreate (avoids live-refresh thrash). */
function syncHeatmapPriceLine(
  handle: ChartHandle,
  price: number | null | undefined,
) {
  if (price == null || !(price > 0)) {
    if (handle.priceLine) {
      try {
        handle.candles.removePriceLine(handle.priceLine)
      } catch {
        // ignore
      }
      handle.priceLine = null
    }
    return
  }
  if (handle.priceLine) {
    try {
      handle.priceLine.applyOptions({ price })
      return
    } catch {
      // fall through to recreate
    }
  }
  try {
    handle.priceLine = handle.candles.createPriceLine({
      price,
      color: C.priceLine,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '',
    })
  } catch {
    handle.priceLine = null
  }
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
      lockVisibleTimeRangeOnResize: true,
    })
    ts.setVisibleLogicalRange({ from, to })
  } catch {
    // Never scrollToRealTime here — that yanks the camera to "now" on failures.
  }
}

function measure(el: HTMLElement): { w: number; h: number } {
  const rect = el.getBoundingClientRect()
  const w = Math.max(2, Math.floor(el.clientWidth || rect.width || 2))
  const h = Math.max(2, Math.floor(el.clientHeight || rect.height || 2))
  return { w, h }
}

export { defaultHeatmapDataWindowPct }
