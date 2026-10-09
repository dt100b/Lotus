/**
 * 0DTE Forward Gamma Surface pane.
 *
 * Forward projection of dealer gamma: hold today's chain fixed, decay τ as
 * time advances, colour each (time, price) cell by net exposure if spot were
 * there at that time. Painted as a pin-surface (discrete |GEX| lobes +
 * magnitude outlines) rather than a washed atmospheric cloud.
 *
 * X domain (locked, labeled in America/New_York):
 *   left  = 08:00 America/New_York cash open
 *   right = Deribit settle (08:00 UTC epoch; axis shows the NY wall-clock
 *           equivalent — 03:00/04:00 depending on EST/EDT)
 *
 * Y default autofit frames session candle H/L (+ pad). The forward surface is
 * underlay context — not the viewport driver (wall-based fit pinned price off-center).
 *
 * Completely separate from historical GexHeatmapSeries / GexZonePrimitive /
 * strike profile chart. Surface bake is infrequent; pan/zoom is blit-only.
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
  TickMarkType,
  createChart,
  type IChartApi,
  type AutoscaleInfo,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import {
  candleIntervalMs,
  isCandleInterval,
  type CandleInterval,
  type OhlcCandle,
} from '@/api/hyperliquidCandles'
import { formatDeribitCountdown } from '@/api/deribitExpiries'
import type {
  ForwardExpiryScope,
  ForwardGreekMetric,
  GexForwardSurface,
} from '@/api/gexForwardSurface'
import {
  forwardExpiryScopeOptions,
  isForwardExpiryScope,
} from '@/api/gexForwardSurface'
import {
  ChartExpirySelect,
  ChartPaneActions,
  ChartPaneHeader,
  ChartTimeframeSelect,
} from '@/components/terminal/ChartPaneHeader'
import { defaultHeatmapDataWindowPct } from '@/components/terminal/gexModes'
import type { PaneDragHandleProps } from '@/components/terminal/PaneWorkspace'
import { GexForwardSurfacePrimitive } from '@/components/terminal/lwc/GexForwardSurfacePrimitive'
import { syncLinkedStrikeLines } from '@/components/terminal/lwc/linkedStrikeLine'
import {
  defaultForwardPaletteIds,
  forwardGreekPalettes,
  resolveForwardGreekPalette,
} from '@/data/forwardGreekPalettes'
import {
  candlePalettes,
  defaultCandlePaletteId,
  getCandlePalette,
  type CandlePaletteId,
} from '@/data/candlePalettes'
import type { GammaStop } from '@/data/heatmapPalettes'
import { useGexForwardSurface } from '@/hooks/useGexForwardSurface'
import { useHyperliquidCandles } from '@/hooks/useHyperliquidCandles'
import { useTerminalStore } from '@/store/terminalStore'
import { cn } from '@/lib/utils'

export type ForwardSurfaceSnapshot = {
  spot: number
  asOfUtc?: string
  gammaBars: Array<{
    strike: number
    gammaExposureUsd: number
    callGammaExposureUsd?: number
    putGammaExposureUsd?: number
    netGammaExposureUsd?: number
  }>
  reference?: Array<{
    label: string
    value: string
    color?: string
  }>
  gammaFlip?: number | null
  gammaFlipStatus?: 'ok' | 'no_cross'
}

export type ForwardGammaSurfaceChartProps = {
  snapshot: ForwardSurfaceSnapshot
  dataWindowPct?: number | 'full'
  candleInterval?: CandleInterval
  onCandleIntervalChange?: (interval: CandleInterval) => void
  metric?: ForwardGreekMetric
  onMetricChange?: (metric: ForwardGreekMetric) => void
  expiryScope?: ForwardExpiryScope
  onExpiryScopeChange?: (scope: ForwardExpiryScope) => void
  headerLeft?: ReactNode
  headerRight?: ReactNode
  dragHandleProps?: PaneDragHandleProps
  onClose?: () => void
  minHeight?: number
}

const defaultChartHeight = 516
/**
 * No rightOffset padding — settle (last series point) sits flush to the price
 * axis so the forward surface can anchor to the Y-edge. Residual times are
 * real whitespace series points through settle, not empty rightOffset air.
 */
const PROFILE_GUTTER_BARS = 0
const DEFAULT_BAR_SPACING = 4
/** Floor spacing when zoomed deep — allow dense full-session fit. */
const MIN_BAR_SPACING = 0.2
/**
 * Must be high enough that a full TRACE day always fills the pane width.
 * With fixRightEdge (or a low cap), LWC packs bars to the right and leaves a
 * huge empty left gutter — the main visual bug in this pane.
 */
const MAX_BAR_SPACING = 500
/**
 * Pane inset for the price scale — breathing room above/below candle frame.
 */
const PRICE_EDGE_MARGIN = 0.05
/**
 * Extra pad beyond candle H/L when the session range already fills the min window
 * (fraction of candle span). Keeps wicks off the rim.
 */
const CANDLE_FIT_PAD = 0.08
/**
 * Minimum half-window around the candle mid as a fraction of spot (or mid).
 * Desk default ≈ ±4.6% → e.g. spot ~63.1k frames roughly 60.2k–66.0k so the
 * TRACE field has useful context above/below the print path (not a tight OHLC box).
 */
const CANDLE_MIN_HALF_WINDOW_PCT = 0.046
/**
 * EOW/EOM use a wider structural frame. With the chart's 5% scale margins,
 * ±10.3% resolves to roughly 56k–70.5k around a 63.3k BTC print.
 */
const TENOR_MIN_HALF_WINDOW_PCT = 0.103
/** Fallback pad when framing by active γ walls (no candles yet). */
const SURFACE_FIT_PAD = 0.09
/**
 * Chart clock: America/New_York. Left wall = 08:00 NY cash open.
 * Right wall = Deribit settle (08:00 UTC → 03:00/04:00 NY depending on DST).
 */
const CHART_TZ = 'America/New_York'
const HOVER_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: CHART_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const NY_SESSION_OPEN_HOUR = 8
/** Deribit options settle 08:00 UTC — right wall (epoch), labeled in CHART_TZ. */
const DERIBIT_SETTLE_HOUR_UTC = 8
/** Fallback residual when settle unknown. */
const FALLBACK_RESIDUAL_HOURS = 8
/** Hard cap on synthetic whitespace bars (1m residual can be long). */
const MAX_SESSION_BARS = 1200

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
} as const

const DEFAULT_INTERVAL: CandleInterval = '15m'

/** Keep long-expiry ordinal time scales proportional and below the bar cap. */
const FORWARD_INTERVALS_BY_SCOPE: Record<ForwardExpiryScope, CandleInterval[]> = {
  '0dte': ['1m', '5m', '15m', '1h'],
  eow: ['15m', '30m', '1h'],
  eom: ['1h', '4h', '1d'],
}

const DEFAULT_INTERVAL_BY_SCOPE: Record<ForwardExpiryScope, CandleInterval> = {
  '0dte': '15m',
  eow: '1h',
  eom: '1h',
}

const IV_SHIFT_OPTIONS_BY_SCOPE: Record<ForwardExpiryScope, number[]> = {
  '0dte': [-2, -1, 0, 1, 2],
  eow: [-5, -2.5, 0, 2.5, 5],
  eom: [-10, -5, 0, 5, 10],
}

const FORWARD_METRICS: Array<{ value: ForwardGreekMetric; label: string; short: string }> = [
  { value: 'gamma', label: 'Gamma', short: 'Γ' },
  { value: 'delta', label: 'Delta', short: 'Δ' },
  { value: 'delta_change', label: 'Delta Change', short: 'Δ Chg' },
  { value: 'charm', label: 'Charm', short: 'Charm' },
  { value: 'vanna', label: 'Vanna', short: 'Vanna' },
]

type ChartHandle = {
  chart: IChartApi
  candles: ISeriesApi<'Candlestick'>
  /** Soft forward field underlay (bake once, blit on pan/zoom). */
  forward: GexForwardSurfacePrimitive
  priceLine: IPriceLine | null
  linkedStrikeLines: Map<number, IPriceLine>
}

type SessionBounds = {
  /** Epoch ms — left lock: 08:00 America/New_York session open. */
  startMs: number
  /** Epoch ms — right lock: Deribit 08:00 UTC settle. */
  endMs: number
}

type ContextMenuState = { x: number; y: number }
type ForwardHoverState = {
  x: number
  y: number
  timeMs: number
  price: number
  value: number
}

function ForwardToggle({
  label,
  enabled,
  onToggle,
}: {
  label: string
  enabled: boolean
  onToggle: (enabled: boolean) => void
}) {
  return (
    <button
      type="button"
      className={cn('forward-surface-toggle', enabled && 'forward-surface-toggle--active')}
      aria-pressed={enabled}
      onClick={() => onToggle(!enabled)}
    >
      {label}
    </button>
  )
}

function SurfaceAppearanceMenu({
  metric,
  activePaletteId,
  onPaletteChange,
  candlePaletteId,
  onCandlePaletteChange,
}: {
  metric: ForwardGreekMetric
  activePaletteId: string
  onPaletteChange: (paletteId: string) => void
  candlePaletteId: CandlePaletteId
  onCandlePaletteChange: (paletteId: CandlePaletteId) => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const palettes = forwardGreekPalettes[metric]
  const activePalette = resolveForwardGreekPalette(metric, activePaletteId)

  useLayoutEffect(() => {
    if (!open || !rootRef.current) {
      setMenuPos(null)
      return
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const menuW = 288
      const menuH = menuRef.current?.offsetHeight ?? 330
      const left = Math.min(Math.max(6, rect.left), window.innerWidth - menuW - 6)
      const below = rect.bottom + 4
      const top = below + menuH > window.innerHeight - 6
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
  }, [open, metric, activePaletteId, candlePaletteId])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
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
    <div ref={rootRef} className="chart-pane-header__overlay-wrap surface-appearance-wrap">
      <button
        type="button"
        className={cn(
          'chart-pane-header__overlay-btn surface-appearance-trigger',
          open && 'chart-pane-header__overlay-btn--open',
        )}
        aria-label="Surface gradient and candle colors"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <span
          className="surface-appearance-trigger__gradient"
          style={{ background: paletteCssGradient(activePalette.ramp) }}
          aria-hidden
        />
        <span className="chart-pane-header__overlay-label">Gradient</span>
        <span className="chart-pane-header__overlay-caret" aria-hidden>▾</span>
      </button>

      {open && menuPos ? createPortal(
        <div
          ref={menuRef}
          id={panelId}
          role="dialog"
          aria-label="Surface appearance"
          className="chart-pane-header__overlay-menu chart-pane-header__overlay-menu--price-gex surface-appearance-menu"
          style={{ top: menuPos.top, left: menuPos.left, width: 288 }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="chart-pane-header__menu-head">
            <div>
              <span>Surface</span>
              <strong>Appearance</strong>
            </div>
            <span className="chart-pane-header__menu-status">{activePalette.label}</span>
          </div>
          <div className="chart-pane-header__overlay-section">
            <div className="chart-pane-header__overlay-section-title-row">
              <div>
                <span className="chart-pane-header__overlay-section-title">Gradient</span>
                <small>{activePalette.description}</small>
              </div>
            </div>
            <div className="chart-pane-header__palette-grid" role="radiogroup" aria-label="Surface gradient">
              {palettes.map((palette) => (
                <button
                  key={palette.id}
                  type="button"
                  role="radio"
                  aria-checked={palette.id === activePaletteId}
                  className={cn(
                    'chart-pane-header__palette-card',
                    palette.id === activePaletteId && 'chart-pane-header__palette-card--active',
                  )}
                  onClick={() => onPaletteChange(palette.id)}
                >
                  <span
                    className="chart-pane-header__palette-preview"
                    style={{ background: paletteCssGradient(palette.ramp) }}
                  />
                  <small>{palette.label}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="chart-pane-header__overlay-divider" />
          <div className="chart-pane-header__overlay-section">
            <div className="chart-pane-header__overlay-section-title-row">
              <div>
                <span className="chart-pane-header__overlay-section-title">Candles</span>
                <small>Shared Price/GEX palettes</small>
              </div>
            </div>
            <div className="chart-pane-header__candle-grid" role="radiogroup" aria-label="Surface candle colors">
              {candlePalettes.map((palette) => (
                <button
                  key={palette.id}
                  type="button"
                  role="radio"
                  aria-checked={palette.id === candlePaletteId}
                  className={cn(
                    'chart-pane-header__candle-card',
                    palette.id === candlePaletteId && 'chart-pane-header__candle-card--active',
                  )}
                  onClick={() => onCandlePaletteChange(palette.id)}
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
              ))}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

export const ForwardGammaSurfaceChart = memo(function ForwardGammaSurfaceChart({
  snapshot,
  dataWindowPct = defaultHeatmapDataWindowPct,
  candleInterval: candleIntervalProp,
  onCandleIntervalChange,
  metric: metricProp,
  onMetricChange,
  expiryScope = '0dte',
  onExpiryScopeChange,
  headerLeft,
  headerRight,
  dragHandleProps,
  onClose,
  minHeight = defaultChartHeight,
}: ForwardGammaSurfaceChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<ChartHandle | null>(null)
  const autoFitRef = useRef(true)
  const initialTimeAppliedRef = useRef(false)
  const intervalRef = useRef<CandleInterval>(DEFAULT_INTERVAL)
  const tfSwitchPendingRef = useRef(false)
  const lastPaintedIntervalRef = useRef<CandleInterval | null>(null)
  const surfaceRef = useRef<GexForwardSurface | null>(null)
  const surfaceDomainAppliedRef = useRef('')
  /** Latest session candle count + residual pad for pan clamp. */
  const sessionMetaRef = useRef({ nBars: 0, rightPad: PROFILE_GUTTER_BARS })
  const rangeClampLockRef = useRef(false)
  /** Last legal logical range — restore on overshoot (no fight with LWC drag). */
  const lastGoodRangeRef = useRef<{ from: number; to: number } | null>(null)
  /** Avoid full setData on every live tick (major flicker source). */
  const seriesStructureKeyRef = useRef('')
  const candlesRef = useRef<OhlcCandle[]>([])
  const sessionRef = useRef<SessionBounds>({ startMs: 0, endMs: 0 })
  const dataIntervalRef = useRef<CandleInterval>(DEFAULT_INTERVAL)
  const spotRef = useRef(snapshot.spot)
  const fitViewRef = useRef<() => void>(() => {})
  const disablePriceAutoFitRef = useRef<() => void>(() => {})
  const enablePriceAutoFitRef = useRef<() => void>(() => {})
  const gexActiveStrike = useTerminalStore((state) => state.gexActiveStrike)
  const gexHoveredStrike = useTerminalStore((state) => state.gexHoveredStrike)
  const gexMarkedStrikes = useTerminalStore((state) => state.gexMarkedStrikes)
  const linkedStrikeRef = useRef({
    hovered: gexHoveredStrike,
    active: gexActiveStrike,
    marked: gexMarkedStrikes,
  })

  const [error, setError] = useState<string | null>(null)
  const [sessionClockMs] = useState(Date.now)
  const [countdownNowMs, setCountdownNowMs] = useState(Date.now)
  const [autoFitOn, setAutoFitOn] = useState(true)
  const [plotSwitching, setPlotSwitching] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [hovered, setHovered] = useState<ForwardHoverState | null>(null)
  const [localInterval, setLocalInterval] = useState<CandleInterval>(
    () => {
      const raw =
        candleIntervalProp && isCandleInterval(candleIntervalProp)
          ? candleIntervalProp
          : DEFAULT_INTERVAL
      return FORWARD_INTERVALS_BY_SCOPE[expiryScope].includes(raw)
        ? raw
        : DEFAULT_INTERVAL_BY_SCOPE[expiryScope]
    },
  )
  const [localMetric, setLocalMetric] = useState<ForwardGreekMetric>('gamma')
  const [ivShift, setIvShift] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [opacityPct, setOpacityPct] = useState(42)
  const [rangePct, setRangePct] = useState(125)
  const [paletteByMetric, setPaletteByMetric] = useState<Record<ForwardGreekMetric, string>>(
    () => ({ ...defaultForwardPaletteIds }),
  )
  const [candlePaletteId, setCandlePaletteId] = useState<CandlePaletteId>(
    defaultCandlePaletteId,
  )
  const [showCandles, setShowCandles] = useState(true)
  const [showContours, setShowContours] = useState(true)
  const [showFlip, setShowFlip] = useState(true)
  const [showGrid, setShowGrid] = useState(false)
  const [showLegend, setShowLegend] = useState(true)

  const metric = metricProp ?? localMetric
  const setMetric = useCallback(
    (next: ForwardGreekMetric) => {
      if (onMetricChange) onMetricChange(next)
      else setLocalMetric(next)
    },
    [onMetricChange],
  )

  const activePalette = useMemo(
    () => resolveForwardGreekPalette(metric, paletteByMetric[metric]),
    [metric, paletteByMetric],
  )
  const scopeIntervals = FORWARD_INTERVALS_BY_SCOPE[expiryScope]

  useEffect(() => {
    const intervalId = window.setInterval(() => setCountdownNowMs(Date.now()), 1_000)
    return () => window.clearInterval(intervalId)
  }, [])

  const intervalRaw =
    candleIntervalProp && isCandleInterval(candleIntervalProp)
      ? candleIntervalProp
      : localInterval
  const interval = scopeIntervals.includes(intervalRaw)
    ? intervalRaw
    : DEFAULT_INTERVAL_BY_SCOPE[expiryScope]

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

  const forwardQuery = useGexForwardSurface({
    snapshot: {
      spot: snapshot.spot,
      gammaBars: snapshot.gammaBars,
    },
    enabled: true,
    nTimes: 72,
    nPrices: 144,
    // Longer tenors need enough source domain to cover their wider default
    // viewport; otherwise the raster boundary becomes visible in-chart.
    priceWindowPct: expiryScope === '0dte'
      ? (typeof dataWindowPct === 'number' ? dataWindowPct : 8)
      : Math.max(typeof dataWindowPct === 'number' ? dataWindowPct : 8, 13),
    metric,
    ivShift,
    expiryScope,
  })
  const queriedSurface = forwardQuery.data
  const surface: GexForwardSurface | undefined =
    queriedSurface?.meta.metric === metric
    && Math.abs(queriedSurface.meta.ivShift - ivShift) < 1e-9
    && queriedSurface.meta.expiryScope === expiryScope
      ? queriedSurface
      : undefined
  const surfaceLoading = forwardQuery.isLoading || (forwardQuery.isFetching && !surface)
  const surfaceError = forwardQuery.error

  useEffect(() => {
    surfaceRef.current = surface ?? null
  }, [surface])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    handle.candles.applyOptions({ visible: showCandles })
    handle.chart.applyOptions({
      grid: {
        vertLines: {
          visible: showGrid,
          color: 'rgba(115, 128, 146, 0.10)',
          style: LineStyle.Dotted,
        },
        horzLines: {
          visible: showGrid,
          color: 'rgba(115, 128, 146, 0.10)',
          style: LineStyle.Dotted,
        },
      },
    })
  }, [showCandles, showGrid])

  // Recompute when settle changes. asOf is only used to keep the left wall
  // ≤ now (pre-open walk-back) — quantized to the hour so polls don't thrash.
  const asOfHourKey = surface?.asOfMs
    ? Math.floor(surface.asOfMs / 3_600_000)
    : Math.floor(sessionClockMs / 3_600_000)
  const session = useMemo(
    () => resolveSessionBounds(surface, surface?.asOfMs ?? sessionClockMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [surface?.settleMs, asOfHourKey, sessionClockMs],
  )

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  // Fetch exactly the selected projection window (+ small pad).
  const fetchWindow = useMemo(() => {
    const step = candleIntervalMs[interval]
    return {
      start: session.startMs - step * 2,
      end: session.endMs + step * 4,
    }
  }, [interval, session.startMs, session.endMs])

  const {
    candles: rawCandles,
    dataInterval,
    error: candleError,
  } = useHyperliquidCandles({
    enabled: true,
    interval,
    windowStartMs: fetchWindow.start,
    windowEndMs: fetchWindow.end,
  })

  /**
   * Candles clipped to the selected projection session open.
   * No pre-session bar — left edge must be flush with session start, not ~1 TF early.
   */
  const candles = useMemo(
    () => rawCandles.filter((c) => c.t >= session.startMs),
    [rawCandles, session.startMs],
  )

  // The divider is a chart-reading aid, so align it with the selected
  // Hyperliquid timeframe's active bar instead of the independently-timed
  // surface snapshot. This removes apparent lead/lag when switching TFs.
  const projectionBoundaryMs =
    dataInterval === interval && candles.length > 0
      ? candles[candles.length - 1]!.t
      : surface?.asOfMs ?? null

  const chartPrice = candles.length > 0 ? candles[candles.length - 1]!.c : snapshot.spot

  useEffect(() => {
    spotRef.current =
      chartPrice > 0 ? chartPrice : snapshot.spot > 0 ? snapshot.spot : spotRef.current
  }, [chartPrice, snapshot.spot])

  const setInterval = useCallback(
    (next: CandleInterval) => {
      if (!isCandleInterval(next) || next === interval) return
      if (!scopeIntervals.includes(next)) return
      // Always re-anchor to session on TF switch — never free historical pan.
      tfSwitchPendingRef.current = true
      setPlotSwitching(true)
      if (onCandleIntervalChange) onCandleIntervalChange(next)
      else setLocalInterval(next)
    },
    [interval, onCandleIntervalChange, scopeIntervals],
  )

  const enablePriceAutoFit = useCallback(() => {
    autoFitRef.current = true
    setAutoFitOn(true)
    const handle = handleRef.current
    if (!handle) return
    try {
      // Default Y = session candle H/L (+ pad). GEX field is underlay context,
      // not the viewport driver — wall-based fit pinned price into a corner when
      // the soft field spanned far from the print path.
      handle.candles.applyOptions({
        priceFormat: { type: 'price', precision: 1, minMove: 0.5 },
        autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
          const candleFit = resolveCandlePriceRange(
            candlesRef.current,
            spotRef.current,
            minPriceHalfWindowPct(expiryScope),
          )
          if (candleFit) return { priceRange: candleFit }

          // No OHLC yet: let LWC use series extremes (whitespace + anchor bar).
          const base = typeof original === 'function' ? original() : null
          if (
            base?.priceRange
            && Number.isFinite(base.priceRange.minValue)
            && Number.isFinite(base.priceRange.maxValue)
            && base.priceRange.maxValue > base.priceRange.minValue
          ) {
            return base
          }

          // Last resort: active γ walls, then spot pad.
          const surfaceFit = resolveActiveSurfacePriceRange(surfaceRef.current)
          if (surfaceFit) return { priceRange: surfaceFit }

          const spot = spotRef.current
          if (spot > 0 && Number.isFinite(spot)) {
            const pad = Math.max(spot * 0.025, 50)
            return {
              priceRange: { minValue: spot - pad, maxValue: spot + pad },
            }
          }
          return null
        },
      })
      handle.chart.priceScale('right').applyOptions({
        autoScale: true,
        scaleMargins: { top: PRICE_EDGE_MARGIN, bottom: PRICE_EDGE_MARGIN },
        borderVisible: false,
      })
      try {
        handle.chart.priceScale('right').setAutoScale(true)
      } catch {
        // ignore
      }
      // Keep vertical body gestures live; the first vertical drag exits auto-fit.
      handle.chart.applyOptions({
        handleScroll: {
          mouseWheel: false,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true,
        },
        handleScale: {
          axisPressedMouseMove: { time: false, price: true },
          mouseWheel: false,
          pinch: true,
          axisDoubleClickReset: false,
        },
      })
    } catch {
      // ignore
    }
  }, [expiryScope])

  const disablePriceAutoFit = useCallback(() => {
    if (!autoFitRef.current) return
    autoFitRef.current = false
    setAutoFitOn(false)
    const handle = handleRef.current
    if (!handle) return
    try {
      const scale = handle.chart.priceScale('right')
      scale.applyOptions({ autoScale: false })
      try {
        scale.setAutoScale(false)
      } catch {
        // ignore
      }
      // Manual Y — allow vertical drag on plot body + price axis.
      handle.chart.applyOptions({
        handleScroll: {
          mouseWheel: false,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true,
        },
        handleScale: {
          axisPressedMouseMove: { time: false, price: true },
          mouseWheel: false,
          pinch: true,
          axisDoubleClickReset: false,
        },
      })
    } catch {
      // ignore
    }
  }, [])

  const fitView = useCallback(() => {
    const handle = handleRef.current
    if (!handle) return
    const liveCandles = candlesRef.current
    const iv = dataIntervalRef.current
    const data = toCandleDataWithFuture(
      liveCandles,
      iv,
      surfaceRef.current,
      sessionRef.current,
    )
    if (data.length === 0) return
    try {
      handle.candles.setData(data)
    } catch {
      // ignore
    }
    seriesStructureKeyRef.current = structureKeyFor(
      liveCandles,
      iv,
      surfaceRef.current,
      sessionRef.current,
    )
    applySessionTimeWindow(handle, data.length, lastGoodRangeRef)
    sessionMetaRef.current = { nBars: data.length, rightPad: PROFILE_GUTTER_BARS }
    enablePriceAutoFit()
  }, [enablePriceAutoFit])

  // Keep handler refs current for the chart-create effect (empty deps).
  useEffect(() => {
    fitViewRef.current = fitView
    enablePriceAutoFitRef.current = enablePriceAutoFit
    disablePriceAutoFitRef.current = disablePriceAutoFit
  }, [fitView, enablePriceAutoFit, disablePriceAutoFit])

  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])

  const onAutoFitFromMenu = useCallback(() => {
    setCtxMenu(null)
    fitView()
  }, [fitView])

  // ── Chart create ────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let handle: ChartHandle | null = null
    let ro: ResizeObserver | null = null
    let raf = 0

    try {
      const chart = createChart(host, {
        autoSize: false,
        width: host.clientWidth || 400,
        height: host.clientHeight || minHeight,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: C.text,
          fontSize: 10,
          attributionLogo: false,
        },
        // Axis + crosshair labels in America/New_York (not browser local / UTC).
        // Domain is still UTC epoch under the hood; only presentation is NY.
        localization: {
          locale: 'en-US',
          timeFormatter: formatNyCrosshairTime,
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { visible: false },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: C.crosshair,
            labelBackgroundColor: C.crosshairLabelBg,
          },
          horzLine: {
            color: C.crosshair,
            labelBackgroundColor: C.crosshairLabelBg,
          },
        },
        rightPriceScale: {
          borderVisible: false,
          scaleMargins: { top: PRICE_EDGE_MARGIN, bottom: PRICE_EDGE_MARGIN },
          autoScale: true,
        },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 0,
          minBarSpacing: MIN_BAR_SPACING,
          maxBarSpacing: MAX_BAR_SPACING,
          barSpacing: DEFAULT_BAR_SPACING,
          // Live ticks must never yank the camera.
          shiftVisibleRangeOnNewBar: false,
          // fixLeftEdge only — fixRightEdge packs a short series to the right
          // and leaves a permanent empty left gutter (the half-blank TRACE).
          fixLeftEdge: true,
          fixRightEdge: false,
          lockVisibleTimeRangeOnResize: true,
          tickMarkFormatter: (time: Time, tickMarkType: TickMarkType, locale: string) => formatNyTickMark(
            time,
            tickMarkType,
            locale,
            surfaceRef.current?.meta.expiryScope ?? '0dte',
          ),
        },
        handleScroll: {
          // Body drag pans X only. Wheel zoom is custom (time-only) below.
          mouseWheel: false,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true,
        },
        handleScale: {
          // Price-axis drag OK; time-axis drag off (session is wall-locked).
          // Wheel scale OFF — custom handler zooms time only (not price).
          axisPressedMouseMove: { time: false, price: true },
          mouseWheel: false,
          pinch: true,
          axisDoubleClickReset: false,
        },
      })

      const initialCandlePalette = getCandlePalette(defaultCandlePaletteId)
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

      // Forward surface under candles (zOrder bottom) — same attach path as GEX zones.
      const forward = new GexForwardSurfacePrimitive()
      candlesSeries.attachPrimitive(forward)

      handle = {
        chart,
        candles: candlesSeries,
        forward,
        priceLine: null,
        linkedStrikeLines: new Map(),
      }
      handleRef.current = handle
      syncLinkedStrikeLines(handle, linkedStrikeRef.current)
      autoFitRef.current = true
      initialTimeAppliedRef.current = false
      surfaceDomainAppliedRef.current = ''

      // Price-axis drag / vertical plot-drag → leave Auto fit (manual Y).
      // Use move threshold so a plain click does not unlock Y.
      //
      // Full-session pan lock: when the viewport already shows open→settle,
      // disable body drag for this gesture so LWC cannot rubber-band past
      // either wall (soft clamp alone still flashes one illegal frame).
      const restoreBodyScroll = () => {
        const h = handleRef.current
        if (!h) return
        try {
          h.chart.applyOptions({
            handleScroll: {
              mouseWheel: false,
              pressedMouseMove: true,
              horzTouchDrag: true,
              vertTouchDrag: true,
            },
          })
        } catch {
          // ignore
        }
      }

      const onPointerDown = (ev: PointerEvent) => {
        if (ev.button === 2) return
        setCtxMenu(null)

        const rect = host.getBoundingClientRect()
        const localX = ev.clientX - rect.left
        const onPriceAxis = localX > rect.width - 56
        const startY = ev.clientY
        const startX = ev.clientX
        let unlocked = false
        let verticalBodyPan = false
        let fullSessionPanLocked = false
        let startPriceRange: { from: number; to: number } | null = null
        try {
          startPriceRange = handleRef.current?.chart.priceScale('right').getVisibleRange() ?? null
        } catch {
          // ignore
        }

        // Pin full TRACE view: no horizontal drag while showing the whole book.
        if (!onPriceAxis) {
          const { nBars, rightPad } = sessionMetaRef.current
          if (nBars >= 2) {
            const maxTo = Math.max(0, nBars - 1) + rightPad
            try {
              const vr = handleRef.current?.chart.timeScale().getVisibleLogicalRange()
              if (
                vr
                && vr.to > vr.from
                && vr.to - vr.from >= maxTo - 0.5
                && vr.from <= 0.35
                && vr.to >= maxTo - 0.35
              ) {
                fullSessionPanLocked = true
                handleRef.current?.chart.applyOptions({
                  handleScroll: {
                    mouseWheel: false,
                    pressedMouseMove: false,
                    horzTouchDrag: false,
                    vertTouchDrag: true,
                  },
                })
              }
            } catch {
              // ignore
            }
          }
        }

        const applyVerticalBodyPan = (dy: number) => {
          if (!startPriceRange || !(startPriceRange.to > startPriceRange.from)) return
          const plotHeight = Math.max(120, rect.height - 28)
          const span = startPriceRange.to - startPriceRange.from
          const shift = (dy / plotHeight) * span
          try {
            handleRef.current?.chart.priceScale('right').setVisibleRange({
              from: startPriceRange.from + shift,
              to: startPriceRange.to + shift,
            })
          } catch {
            // ignore
          }
        }

        const maybeUnlock = (dx: number, dy: number) => {
          if (unlocked) return
          // Price gutter: any drag unlocks. Plot body: vertical-dominant drag.
          if (onPriceAxis && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            unlocked = true
            if (autoFitRef.current) disablePriceAutoFitRef.current()
            return
          }
          if (!onPriceAxis && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx) * 1.15) {
            unlocked = true
            verticalBodyPan = true
            if (autoFitRef.current) disablePriceAutoFitRef.current()
            try {
              handleRef.current?.chart.applyOptions({
                handleScroll: {
                  mouseWheel: false,
                  pressedMouseMove: false,
                  horzTouchDrag: false,
                  vertTouchDrag: true,
                },
              })
            } catch {
              // ignore
            }
            applyVerticalBodyPan(dy)
          }
        }

        const onMove = (moveEv: PointerEvent) => {
          const dx = moveEv.clientX - startX
          const dy = moveEv.clientY - startY
          if (verticalBodyPan) {
            moveEv.preventDefault()
            moveEv.stopPropagation()
            applyVerticalBodyPan(dy)
            return
          }
          maybeUnlock(dx, dy)
          if (verticalBodyPan) {
            moveEv.preventDefault()
            moveEv.stopPropagation()
          }
        }
        const onUp = () => {
          host.removeEventListener('pointermove', onMove, { capture: true })
          window.removeEventListener('pointerup', onUp)
          if (fullSessionPanLocked || verticalBodyPan) restoreBodyScroll()
        }
        host.addEventListener('pointermove', onMove, { capture: true })
        window.addEventListener('pointerup', onUp)
      }
      // Capture: lock full-session pan *before* LWC starts its drag gesture.
      host.addEventListener('pointerdown', onPointerDown, { capture: true })

      // Custom wheel: plot → time-only zoom; price axis → price-only zoom.
      // Native LWC wheel scales X+Y together and fights the session clamp.
      const onWheel = (ev: WheelEvent) => {
        if (disposed) return
        const h = handleRef.current
        if (!h) return
        const rect = host.getBoundingClientRect()
        const localX = ev.clientX - rect.left
        const onPriceAxis = localX > rect.width - 56

        if (onPriceAxis) {
          ev.preventDefault()
          if (autoFitRef.current) disablePriceAutoFitRef.current()
          try {
            const scale = h.chart.priceScale('right')
            const vr = scale.getVisibleRange()
            if (!vr || !(vr.to > vr.from)) return
            const factor = ev.deltaY > 0 ? 1.1 : 1 / 1.1
            const mid = (vr.from + vr.to) / 2
            const half = ((vr.to - vr.from) / 2) * factor
            scale.setVisibleRange({ from: mid - half, to: mid + half })
          } catch {
            // ignore
          }
          return
        }

        ev.preventDefault()
        const { nBars, rightPad } = sessionMetaRef.current
        if (nBars < 2) return

        const ts = h.chart.timeScale()
        const range = ts.getVisibleLogicalRange()
        if (!range || !(range.to > range.from)) return

        // Session domain [0, nBars-1]. Propose a legal range so wheel never
        // asks LWC to overshoot past open/settle.
        const maxTo = Math.max(0, nBars - 1) + rightPad
        const minSpan = Math.max(6, Math.min(nBars * 0.03, 40))
        if (!(maxTo > minSpan * 0.5)) return

        const plotW = Math.max(1, rect.width - 56)
        const frac = Math.min(1, Math.max(0, localX / plotW))
        const anchor = range.from + frac * (range.to - range.from)
        const factor = ev.deltaY > 0 ? 1.12 : 1 / 1.12
        let span = (range.to - range.from) * factor
        span = Math.min(maxTo, Math.max(minSpan, span))
        let from = anchor - frac * span
        let to = from + span
        const clamped = clampSessionLogicalRange({ from, to }, maxTo)
        if (!clamped) return
        from = clamped.from
        to = clamped.to
        if (to - from < minSpan * 0.99) {
          // Degenerate after clamp — fall back to full session.
          from = 0
          to = maxTo
        }

        // Skip no-op sets (prevents layout thrash at wall).
        if (
          Math.abs(from - range.from) < 1e-4
          && Math.abs(to - range.to) < 1e-4
        ) {
          return
        }

        rangeClampLockRef.current = true
        try {
          ts.setVisibleLogicalRange({ from, to })
          lastGoodRangeRef.current = { from, to }
        } catch {
          // ignore
        } finally {
          queueMicrotask(() => {
            rangeClampLockRef.current = false
          })
        }
      }
      host.addEventListener('wheel', onWheel, { passive: false })

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

      // Always call through ref — create effect has [] deps; fitView closes
      // over live candles via candlesRef inside fitView.
      const onDblClick = (ev: MouseEvent) => {
        if (disposed) return
        ev.preventDefault()
        setCtxMenu(null)
        fitViewRef.current()
      }
      host.addEventListener('dblclick', onDblClick)

      const onCrosshair = (param: MouseEventParams<Time>) => {
        if (disposed || !param.point || param.time == null) {
          setHovered(null)
          return
        }
        const activeSurface = surfaceRef.current
        if (!activeSurface?.times.length) {
          setHovered(null)
          return
        }
        const timeSec = typeof param.time === 'number' ? param.time : Number(param.time)
        const price = candlesSeries.coordinateToPrice(param.point.y)
        if (!Number.isFinite(timeSec) || price == null || !Number.isFinite(price)) {
          setHovered(null)
          return
        }
        const timeMs = timeSec * 1000
        const value = sampleForwardSurface(activeSurface, timeMs, price)
        if (value == null) {
          setHovered(null)
          return
        }
        const cardWidth = 178
        const cardHeight = 72
        const x = param.point.x > host.clientWidth * 0.72
          ? Math.max(8, param.point.x - cardWidth - 12)
          : Math.min(host.clientWidth - cardWidth - 8, param.point.x + 12)
        const y = Math.max(8, Math.min(host.clientHeight - cardHeight - 8, param.point.y - 28))
        setHovered({ x, y, timeMs, price, value })
      }
      chart.subscribeCrosshairMove(onCrosshair)

      // Hard session walls during pan/zoom. fixLeftEdge alone still allows a
      // one-frame (or multi-frame) rubber-band past bar 0, and with fixRightEdge
      // off a full-session drag can slide past settle — empty right void, then
      // snap. Clamp every illegal range immediately; at full capacity the clamp
      // is a pure no-op restore of [0, maxTo] so the chart stays stationary.
      const onLogicalRange = (range: LogicalRange | null) => {
        if (disposed || rangeClampLockRef.current) return
        if (range == null || !Number.isFinite(range.from) || !Number.isFinite(range.to)) {
          return
        }
        const { nBars, rightPad } = sessionMetaRef.current
        if (nBars < 2) return

        const maxTo = Math.max(0, nBars - 1) + rightPad
        const next = clampSessionLogicalRange(range, maxTo)
        if (!next) return

        // Already legal — remember and leave LWC alone.
        if (
          Math.abs(next.from - range.from) < 1e-4
          && Math.abs(next.to - range.to) < 1e-4
        ) {
          lastGoodRangeRef.current = next
          return
        }

        rangeClampLockRef.current = true
        try {
          handleRef.current?.chart.timeScale().setVisibleLogicalRange(next)
          lastGoodRangeRef.current = next
        } catch {
          // ignore
        } finally {
          // Microtask: unlock before the next pointermove so we don't leave a
          // stuck lock, but after LWC finishes applying this correction.
          queueMicrotask(() => {
            rangeClampLockRef.current = false
          })
        }
      }
      chart.timeScale().subscribeVisibleLogicalRangeChange(onLogicalRange)

      const syncSize = () => {
        if (disposed || !handleRef.current) return
        const w = host.clientWidth
        const h = host.clientHeight
        if (w > 0 && h > 0) handleRef.current.chart.resize(w, h, true)
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
        try {
          chart.timeScale().unsubscribeVisibleLogicalRangeChange(onLogicalRange)
        } catch {
          // ignore
        }
        try {
          chart.unsubscribeCrosshairMove(onCrosshair)
        } catch {
          // ignore
        }
        setHovered(null)
        host.removeEventListener('dblclick', onDblClick)
        host.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions)
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
      console.error('[ForwardGammaSurfaceChart] create failed', err)
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

  // Keep candle buffer refs current for fitView / structure keys.
  useEffect(() => {
    candlesRef.current = candles
  }, [candles])

  useEffect(() => {
    dataIntervalRef.current = dataInterval
  }, [dataInterval])

  // ── Candles + future whitespace (session-clipped only) ──────────────────
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    if (dataInterval !== interval) return

    try {
      const isTfLanding =
        tfSwitchPendingRef.current || lastPaintedIntervalRef.current !== dataInterval

      const nextKey = structureKeyFor(
        candles,
        dataInterval,
        surfaceRef.current,
        session,
      )
      const structureChanged = nextKey !== seriesStructureKeyRef.current

      // Fast path: same series skeleton (only live bar OHLC / price line).
      // Full setData every WS tick was the main flicker source.
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
          // Fallback to full replace if update rejects (gap / type mismatch).
          const data = toCandleDataWithFuture(
            candles,
            dataInterval,
            surfaceRef.current,
            session,
          )
          const preserved = handle.chart.timeScale().getVisibleLogicalRange()
          handle.candles.setData(data)
          sessionMetaRef.current = { nBars: data.length, rightPad: PROFILE_GUTTER_BARS }
          restoreLogicalRange(handle, preserved, data.length, lastGoodRangeRef)
        }
        syncPriceLine(handle, chartPrice)
        return
      }

      // OHLC for the session + whitespace bars through settle so the x-axis
      // labels residual timestamps and LWC can map forward surface times.
      const data = toCandleDataWithFuture(
        candles,
        dataInterval,
        surfaceRef.current,
        session,
      )

      // Preserve user zoom across structural refreshes (new bar / settle).
      const preserved =
        initialTimeAppliedRef.current && !isTfLanding
          ? handle.chart.timeScale().getVisibleLogicalRange()
          : null

      if (data.length < 2) {
        console.warn('[ForwardGammaSurfaceChart] series too short', data.length, session)
        return
      }

      try {
        handle.candles.setData(data)
      } catch (err) {
        console.error('[ForwardGammaSurfaceChart] setData rejected', err, {
          n: data.length,
          first: data[0],
          last: data[data.length - 1],
        })
        throw err
      }
      lastPaintedIntervalRef.current = dataInterval
      seriesStructureKeyRef.current = nextKey
      syncPriceLine(handle, chartPrice)

      // nBars includes whitespace → pan clamp covers full session → settle.
      sessionMetaRef.current = { nBars: data.length, rightPad: PROFILE_GUTTER_BARS }

      // Re-fit full TRACE when: first paint, TF switch, or autofit + series
      // domain jumped (session open/settle rewrite). Never keep a half-pane
      // range that leaves the classic empty-left packing.
      const prevN = sessionMetaRef.current.nBars
      const domainJumped =
        prevN > 0
        && data.length > 0
        && Math.abs(data.length - prevN) > Math.max(8, prevN * 0.15)

      if (!initialTimeAppliedRef.current || isTfLanding || (autoFitRef.current && domainJumped)) {
        initialTimeAppliedRef.current = true
        tfSwitchPendingRef.current = false
        applySessionTimeWindow(handle, data.length, lastGoodRangeRef)
        sessionMetaRef.current = { nBars: data.length, rightPad: PROFILE_GUTTER_BARS }
        requestAnimationFrame(() => {
          enablePriceAutoFit()
          seedPriceScale(handle, chartPrice, surfaceRef.current, candles, expiryScope)
          requestAnimationFrame(() => setPlotSwitching(false))
        })
      } else {
        sessionMetaRef.current = { nBars: data.length, rightPad: PROFILE_GUTTER_BARS }
        restoreLogicalRange(handle, preserved, data.length, lastGoodRangeRef)
        if (autoFitRef.current) {
          requestAnimationFrame(() => {
            enablePriceAutoFit()
            seedPriceScale(handle, chartPrice, surfaceRef.current, candles, expiryScope)
          })
        }
      }
    } catch (err) {
      console.error('[ForwardGammaSurfaceChart] candle update failed', err)
      const msg = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => setError(msg))
      tfSwitchPendingRef.current = false
      queueMicrotask(() => setPlotSwitching(false))
    }
  }, [candles, chartPrice, enablePriceAutoFit, expiryScope, interval, dataInterval, session])

  // ── Surface bake (infrequent — chain update / materialize) ──────────────
  // Settle + grid size only — do NOT key on asOf (times[0]); that updates every
  // poll and used to re-applySessionTimeWindow, yanking the user zoom away.
  const surfaceSettleKey = surface
    ? `${surface.settleMs}:${surface.prices.length}:${surface.times.length}`
    : ''

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return

    const isLightTheme = readIsLightTheme()

    try {
      handle.forward.setPaintStyle({
        gammaRamp: activePalette.ramp,
        opacityPct,
        rangePct,
        isLightTheme,
        showProfile: false,
        showContours,
        showFlipContour: showFlip,
        // Single soft lobe shell (not multi-level pipe tubes).
        contourColor: isLightTheme
          ? 'rgba(28, 36, 48, 0.24)'
          : 'rgba(224, 233, 246, 0.22)',
        contourWidthPx: 0.8,
        flipContourColor: isLightTheme
          ? 'rgba(18, 24, 34, 0.88)'
          : 'rgba(250, 252, 255, 0.92)',
        flipContourWidthPx: 1.45,
        flipContourGlowPx: 1.8,
        showProjectionBoundary: true,
        projectionBoundaryColor: isLightTheme
          ? 'rgba(28, 36, 48, 0.30)'
          : 'rgba(214, 225, 239, 0.26)',
        projectionBoundaryMs,
        profileColor: isLightTheme
          ? 'rgba(50, 62, 78, 0.28)'
          : 'rgba(170, 190, 215, 0.28)',
        profileWidthPx: 18,
        sessionStartMs: session.startMs,
      })
      handle.forward.setSurface(surface && surface.times.length >= 2 ? surface : null)
    } catch (err) {
      console.error('[ForwardGammaSurfaceChart] surface apply failed', err)
    }

    // Refresh residual whitespace when settle/grid changes — never reset the
    // user's visible time range (that was the zoom “teleport” bug).
    if (
      surfaceSettleKey
      && surfaceSettleKey !== surfaceDomainAppliedRef.current
      && surface
    ) {
      const first = surfaceDomainAppliedRef.current === ''
      surfaceDomainAppliedRef.current = surfaceSettleKey
      const liveCandles = candlesRef.current
      const iv = dataIntervalRef.current
      const data = toCandleDataWithFuture(liveCandles, iv, surface, session)
      if (data.length < 2) return
      const preserved =
        initialTimeAppliedRef.current && !first
          ? handle.chart.timeScale().getVisibleLogicalRange()
          : null
      try {
        handle.candles.setData(data)
      } catch (err) {
        console.error('[ForwardGammaSurfaceChart] surface setData failed', err)
      }
      seriesStructureKeyRef.current = structureKeyFor(
        liveCandles,
        iv,
        surface,
        session,
      )
      sessionMetaRef.current = { nBars: data.length, rightPad: PROFILE_GUTTER_BARS }
      // First surface / settle change: lock full open→settle. Later polls keep zoom.
      if (first || !initialTimeAppliedRef.current || autoFitRef.current) {
        applySessionTimeWindow(handle, data.length, lastGoodRangeRef)
        initialTimeAppliedRef.current = true
        if (autoFitRef.current) {
          enablePriceAutoFit()
          seedPriceScale(handle, chartPrice, surface, liveCandles, expiryScope)
        }
      } else {
        restoreLogicalRange(handle, preserved, data.length, lastGoodRangeRef)
      }
    }
  }, [
    surface,
    activePalette,
    opacityPct,
    rangePct,
    surfaceSettleKey,
    session,
    enablePriceAutoFit,
    chartPrice,
    showContours,
    showFlip,
    expiryScope,
    projectionBoundaryMs,
  ])

  // Context menu dismiss (match price/GEX chart).
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

  const statusNote = surface?.meta?.note
  const tauLabel = surface?.settleMs && surface.settleMs > countdownNowMs
    ? `τ ${formatDeribitCountdown(surface.settleMs - countdownNowMs)}`
    : null
  const metricInfo = FORWARD_METRICS.find((item) => item.value === metric) ?? FORWARD_METRICS[0]!

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      style={{ minHeight }}
    >
      <ChartPaneHeader
        className="forward-surface-header"
        title={forwardMetricTitle(metric)}
        left={headerLeft}
        right={(
          <>
            {headerRight}
            {tauLabel ? (
              <span className="forward-surface-tau hidden text-[9px] tracking-wide text-[var(--terminal-muted)] sm:inline">
                {tauLabel}
              </span>
            ) : null}
            <ChartTimeframeSelect
              interval={interval}
              onIntervalChange={setInterval}
              intervals={scopeIntervals}
            />
            <ChartExpirySelect
              expiry={expiryScope}
              expiryOptions={forwardExpiryScopeOptions}
              prefetchSnapshots={false}
              onExpiryChange={(next) => {
                if (!isForwardExpiryScope(next)) return
                // Shocks are tenor-calibrated; reset when changing the horizon
                // so an EOM ±10 vol-point scenario cannot leak into 0DTE.
                setIvShift(0)
                const nextInterval = DEFAULT_INTERVAL_BY_SCOPE[next]
                if (nextInterval !== interval) {
                  tfSwitchPendingRef.current = true
                  setPlotSwitching(true)
                  if (onCandleIntervalChange) onCandleIntervalChange(nextInterval)
                  else setLocalInterval(nextInterval)
                }
                onExpiryScopeChange?.(next)
              }}
            />
            <ChartPaneActions dragHandleProps={dragHandleProps} onClose={onClose} />
          </>
        )}
        toolbar={(
          <div className="forward-surface-controls__primary">
            <span className="forward-surface-controls__eyebrow">Greek</span>
            <div className="forward-surface-segments" role="group" aria-label="Forward Greek">
              {FORWARD_METRICS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={cn(
                    'forward-surface-segment',
                    metric === item.value && 'forward-surface-segment--active',
                  )}
                  aria-pressed={metric === item.value}
                  onClick={() => setMetric(item.value)}
                >
                  <span className="forward-surface-segment__full">{item.label}</span>
                  <span className="forward-surface-segment__short">{item.short}</span>
                </button>
              ))}
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
      />
      {settingsOpen ? (
        <div className="forward-surface-controls">
          <div className="forward-surface-controls__settings">
            <span className="forward-surface-controls__eyebrow">IV shift</span>
            <div className="forward-surface-segments" role="group" aria-label="IV shift">
              {IV_SHIFT_OPTIONS_BY_SCOPE[expiryScope].map((shift) => (
                <button
                  key={shift}
                  type="button"
                  className={cn(
                    'forward-surface-segment forward-surface-segment--compact',
                    ivShift === shift && 'forward-surface-segment--active',
                  )}
                  aria-pressed={ivShift === shift}
                  onClick={() => setIvShift(shift)}
                >
                  {formatIvShift(shift)}
                </button>
              ))}
            </div>
            <span className="forward-surface-controls__eyebrow">Appearance</span>
            <SurfaceAppearanceMenu
              metric={metric}
              activePaletteId={activePalette.id}
              onPaletteChange={(paletteId) => setPaletteByMetric((current) => ({
                ...current,
                [metric]: paletteId,
              }))}
              candlePaletteId={candlePaletteId}
              onCandlePaletteChange={setCandlePaletteId}
            />
            <div className="forward-surface-range-cluster">
              <label className="forward-surface-range-control">
                <span>Opacity</span>
                <input
                  type="range" min={20} max={100} step={1} value={opacityPct}
                  onChange={(event) => setOpacityPct(Number(event.target.value))}
                  aria-label="Field opacity"
                />
                <output>{opacityPct}%</output>
              </label>
              <label className="forward-surface-range-control">
                <span>Range</span>
                <input
                  type="range" min={50} max={200} step={5} value={rangePct}
                  onChange={(event) => setRangePct(Number(event.target.value))}
                  aria-label="Colour range"
                  aria-valuetext={`±${rangePct}%`}
                />
                <output>±{rangePct}%</output>
              </label>
            </div>
            <div className="forward-surface-toggles" role="group" aria-label="Forward overlays">
              <ForwardToggle label="Candles" enabled={showCandles} onToggle={setShowCandles} />
              <ForwardToggle label="Lines" enabled={showContours} onToggle={setShowContours} />
              <ForwardToggle
                label={metric === 'gamma' ? 'Flip' : 'Zero'}
                enabled={showFlip}
                onToggle={setShowFlip}
              />
              <ForwardToggle label="Grid" enabled={showGrid} onToggle={setShowGrid} />
              <ForwardToggle label="Card" enabled={showLegend} onToggle={setShowLegend} />
            </div>
          </div>
        </div>
      ) : null}
      <div
        ref={plotRef}
        className={cn(
          'forward-gamma-plot heatmap-lwc-wrap relative min-h-0 w-full flex-1',
          plotSwitching && 'opacity-60',
        )}
      >
        <div ref={hostRef} className="heatmap-lwc-canvas absolute inset-0" />

        {surface?.times.length && showLegend ? (
          <div className="forward-surface-legend">
            <div className="forward-surface-legend__title">
              <strong>{metricInfo.label}</strong>
              <span>{formatSurfaceUnit(surface.meta.unit)}</span>
              <button
                type="button"
                aria-label="Hide chart information"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setShowLegend(false)}
              >
                −
              </button>
            </div>
            <div className="forward-surface-legend__facts">
              <span>Expiry</span>
              <strong>{expiryScope.toUpperCase()} · {formatExpiryCardDate(surface.expiry)}</strong>
              <span>Time</span>
              <strong>{tauLabel ?? 'τ —'} · {formatSettleTime(surface.settleMs)}</strong>
              <span>Model</span>
              <strong>{surface.meta.legCount} legs · {formatPositionRecovery(surface.meta.positionRecovery)}</strong>
              <span>IV / scale</span>
              <strong>
                {surface.meta.referenceIv != null
                  ? `${(surface.meta.referenceIv * 100).toFixed(1)}%`
                  : '—'}
                {' · '}{formatIvShift(ivShift)} pt · ±{rangePct}%
              </strong>
            </div>
          </div>
        ) : surface?.times.length ? (
          <button
            type="button"
            className="forward-surface-legend-reveal"
            aria-label="Show chart information"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setShowLegend(true)}
          >
            Info +
          </button>
        ) : null}

        {hovered && surface ? (
          <div
            className="forward-surface-hover"
            style={{ left: hovered.x, top: hovered.y }}
          >
            <div className="forward-surface-hover__head">
              <span>{metricInfo.label}</span>
              <span>{formatNyHoverTime(hovered.timeMs)}</span>
            </div>
            <div className="forward-surface-hover__value">
              {formatSurfaceValue(hovered.value)}
            </div>
            <div className="forward-surface-hover__foot">
              <span>{formatPrice(hovered.price)}</span>
              <span>{formatSurfaceUnit(surface.meta.unit)}</span>
              <span>{hovered.timeMs >= surface.asOfMs ? 'projected' : 'snapshot pad'}</span>
            </div>
          </div>
        ) : null}

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

        {error || candleError || surfaceError ? (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 z-[6] rounded border border-[var(--terminal-border)] bg-[var(--terminal-surface)]/90 px-2 py-1 text-[10px] text-[var(--terminal-muted)]">
            {error || (candleError ? String(candleError) : null) || (surfaceError ? String(surfaceError) : null)}
          </div>
        ) : null}
        {surfaceLoading && !surface?.times.length ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-[var(--terminal-muted)]">
            Projecting {expiryScope.toUpperCase()} forward {metricInfo.short}…
          </div>
        ) : null}
        {!surfaceLoading && surface && surface.times.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-[var(--terminal-muted)]">
            {statusNote || `No ${expiryScope.toUpperCase()} forward surface`}
          </div>
        ) : null}
      </div>
    </div>
  )
})

/* ── helpers ─────────────────────────────────────────────────────────────── */

type CandlePlotPoint =
  | {
      time: UTCTimestamp
      open: number
      high: number
      low: number
      close: number
    }
  | { time: UTCTimestamp }

/**
 * Full 0DTE TRACE series:
 *   [NY 08:00 open ── pad ── live OHLC ── pad ── 08:00 UTC settle]
 *
 * Edge whitespace is required when HL candles start mid-session — without it
 * the left wall is "first trade" not session open, and fixRightEdge packs a
 * short series to the right (empty left gutter in the pane).
 *
 * Always strictly ascending unique UTC timestamps (LWC rejects otherwise → blank).
 */
function toCandleDataWithFuture(
  candles: OhlcCandle[],
  interval: CandleInterval,
  surface: GexForwardSurface | null | undefined,
  session: SessionBounds,
): CandlePlotPoint[] {
  const stepMs = candleIntervalMs[interval]
  const stepSec = Math.max(1, Math.floor(stepMs / 1000))
  const startMs = session.startMs > 0 ? session.startMs : Date.now() - 12 * 3600_000
  const settleMsRaw =
    surface?.settleMs && surface.settleMs > startMs
      ? surface.settleMs
      : session.endMs > startMs
        ? session.endMs
        : startMs + FALLBACK_RESIDUAL_HOURS * 3600_000
  const settleMs = settleMsRaw > startMs ? settleMsRaw : startMs + stepMs
  const startSec = Math.floor(startMs / 1000)
  const settleSec = Math.floor(settleMs / 1000)
  if (!(settleSec > startSec)) {
    return [
      { time: startSec as UTCTimestamp },
      { time: (startSec + stepSec) as UTCTimestamp },
    ]
  }

  // Live bars inside the TRACE window — sort + dedupe (HL can replay).
  // Also keep a small pre-start pad of OHLC so a slightly late session open
  // never drops the entire book.
  const liveRaw = candles
    .filter(
      (c) =>
        c.t >= startMs - stepMs * 4
        && c.t <= settleMs + stepMs
        && [c.o, c.h, c.l, c.c].every((v) => Number.isFinite(v)),
    )
    .slice()
    .sort((a, b) => a.t - b.t)

  const live: CandlePlotPoint[] = []
  let lastLiveT = -Infinity
  for (const c of liveRaw) {
    const t = Math.floor(c.t / 1000)
    if (t <= lastLiveT) continue
    // Clamp into [startSec, settleSec] for the series domain.
    if (t > settleSec) continue
    const tClamped = Math.max(t, startSec)
    if (tClamped <= lastLiveT) continue
    lastLiveT = tClamped
    live.push({
      time: tClamped as UTCTimestamp,
      open: c.o,
      high: Math.max(c.h, c.o, c.c, c.l),
      low: Math.min(c.l, c.o, c.c, c.h),
      close: c.c,
    })
  }

  // Price-scale anchor: if the window has no OHLC (pre-open / feed gap), plant
  // a flat bar at as-of so LWC has a Y domain and the surface can map prices.
  if (live.length === 0) {
    const spot =
      surface?.spot && surface.spot > 0
        ? surface.spot
        : candles.length > 0
          ? candles[candles.length - 1]!.c
          : 0
    if (spot > 0) {
      const asOfSec = Math.min(
        settleSec - stepSec,
        Math.max(
          startSec,
          Math.floor(
            (surface?.asOfMs && surface.asOfMs > 0
              ? surface.asOfMs
              : Date.now()) / 1000,
          ),
        ),
      )
      live.push({
        time: asOfSec as UTCTimestamp,
        open: spot,
        high: spot,
        low: spot,
        close: spot,
      })
    }
  }

  const out: CandlePlotPoint[] = []
  const prevTime = () =>
    out.length > 0 ? (out[out.length - 1] as { time: number }).time : -Infinity

  const pushWhite = (fromSec: number, toSecExclusive: number) => {
    let t = Math.max(fromSec, startSec)
    let n = 0
    if (t <= prevTime()) t = prevTime() + stepSec
    while (t < toSecExclusive && n < MAX_SESSION_BARS) {
      if (t > prevTime()) out.push({ time: t as UTCTimestamp })
      t += stepSec
      n++
    }
  }

  if (live.length === 0) {
    // Absolute last resort — two white points so setData is legal.
    pushWhite(startSec, settleSec)
  } else {
    const firstLive = (live[0] as { time: number }).time
    const lastLive = (live[live.length - 1] as { time: number }).time
    if (firstLive > startSec) pushWhite(startSec, firstLive)
    for (const bar of live) {
      const t = (bar as { time: number }).time
      if (t > prevTime()) out.push(bar)
    }
    if (lastLive + stepSec < settleSec) pushWhite(lastLive + stepSec, settleSec)
  }

  // Pin settle as last point (right wall).
  if (settleSec > prevTime()) {
    out.push({ time: settleSec as UTCTimestamp })
  }
  if (out.length < 2) {
    return [
      { time: startSec as UTCTimestamp },
      { time: settleSec as UTCTimestamp },
    ]
  }
  return out
}

/**
 * 0DTE TRACE window (wall-clock):
 *   left  = 08:00 America/New_York  (cash open)
 *   right = Deribit settle 08:00 UTC (labeled in NY on the axis)
 *
 * Both ends are exact civil times — never "now − 20h" drift. If the ideal NY
 * open for this settle is still in the future (pre-open), step back one NY
 * session so live candles are not filtered out.
 */
function resolveSessionBounds(
  surface: GexForwardSurface | null | undefined,
  nowMs: number,
): SessionBounds {
  const now = nowMs > 0 ? nowMs : Date.now()
  const asOf =
    surface?.asOfMs && surface.asOfMs > 0 ? surface.asOfMs : now

  // Right wall: surface settle (Deribit 08:00 UTC) when live; else next 08:00 UTC.
  let settle =
    surface?.settleMs && surface.settleMs > Math.max(now, asOf)
      ? surface.settleMs
      : nextDeribitSettleMs(Math.max(now, asOf))
  if (!(settle > Math.max(now, asOf))) {
    settle = Math.max(now, asOf) + FALLBACK_RESIDUAL_HOURS * 3600_000
  }
  // Snap settle to the official 08:00 UTC grid when it's already near one
  // (avoids residual pin at settle−1ms from the surface grid).
  settle = snapToDeribitSettle(settle)

  // Left wall: most recent 08:00 America/New_York strictly before settle.
  let start = nySessionOpenBefore(settle)

  // Pre-open: ideal open is still ahead of asOf → use the previous NY open so
  // the series domain includes the overnight session and live prints.
  if (start > asOf) {
    const prev = nySessionOpenBefore(start)
    if (prev < start) start = prev
  }
  if (start > now) {
    const prev = nySessionOpenBefore(now + 1)
    if (prev < start) start = prev
  }

  // Absolute guardrails — still force exact NY opens, never arbitrary offsets.
  if (!(start < settle)) {
    start = nySessionOpenBefore(settle)
  }
  if (!(start < settle)) {
    // Pathological: fabricate previous 08:00 UTC day as last resort.
    settle = nextDeribitSettleMs(now)
    start = nySessionOpenBefore(settle)
  }

  return { startMs: start, endMs: settle }
}

/** Snap epoch ms to the nearest Deribit 08:00 UTC on/after the same UTC day. */
function snapToDeribitSettle(ms: number): number {
  const d = new Date(ms)
  const daySettle = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    DERIBIT_SETTLE_HOUR_UTC,
    0,
    0,
    0,
  )
  // Surface often pins settle − 1ms; snap up to the true 08:00 UTC.
  if (ms <= daySettle && daySettle - ms < 60_000) return daySettle
  if (ms > daySettle && ms - daySettle < 60_000) return daySettle
  return ms
}

/** Next Deribit daily settle strictly after `fromMs` (08:00 UTC). */
function nextDeribitSettleMs(fromMs: number): number {
  const d = new Date(fromMs)
  let settle = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    DERIBIT_SETTLE_HOUR_UTC,
    0,
    0,
    0,
  )
  if (settle <= fromMs) {
    settle += 24 * 3600_000
  }
  return settle
}

/**
 * Most recent 08:00 America/New_York strictly before `beforeMs`.
 * That is the left wall of the TRACE day that settles at the next 08:00 UTC.
 */
function nySessionOpenBefore(beforeMs: number): number {
  // Read the NY calendar date just before `beforeMs`, then 08:00 that NY day.
  const probe = beforeMs - 60_000
  const parts = zonedParts(probe, CHART_TZ)
  let open = zonedTimeToUtcMs(
    CHART_TZ,
    parts.year,
    parts.month,
    parts.day,
    NY_SESSION_OPEN_HOUR,
    0,
  )
  if (open >= beforeMs) {
    // Step back one NY calendar day.
    const prev = zonedParts(open - 12 * 3600_000, CHART_TZ)
    open = zonedTimeToUtcMs(
      CHART_TZ,
      prev.year,
      prev.month,
      prev.day,
      NY_SESSION_OPEN_HOUR,
      0,
    )
  }
  return open
}

/* ── America/New_York axis labels ─────────────────────────────────────────── */

function timeToUnixSec(time: Time): number | null {
  if (typeof time === 'number' && Number.isFinite(time)) return time
  if (time && typeof time === 'object' && 'timestamp' in time) {
    const t = Number((time as { timestamp: number }).timestamp)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** Crosshair time label — always America/New_York wall clock. */
function formatNyCrosshairTime(time: Time): string {
  const sec = timeToUnixSec(time)
  if (sec == null) return ''
  const ms = sec > 1e12 ? sec : sec * 1000
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHART_TZ,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms))
}

/** X-axis tick labels in America/New_York (keep ≤ 8 chars for LWC). */
function formatNyTickMark(
  time: Time,
  tickMarkType: TickMarkType,
  _locale: string,
  expiryScope: ForwardExpiryScope = '0dte',
): string | null {
  void _locale
  const sec = timeToUnixSec(time)
  if (sec == null) return null
  const ms = sec > 1e12 ? sec : sec * 1000
  const d = new Date(ms)

  if (expiryScope !== '0dte') {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: CHART_TZ,
      month: 'short',
      day: 'numeric',
    }).format(d)
  }

  if (tickMarkType === TickMarkType.Year) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: CHART_TZ,
      year: 'numeric',
    }).format(d)
  }
  if (tickMarkType === TickMarkType.Month) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: CHART_TZ,
      month: 'short',
    }).format(d)
  }
  if (
    tickMarkType === TickMarkType.DayOfMonth
    || tickMarkType === TickMarkType.Time
    || tickMarkType === TickMarkType.TimeWithSeconds
  ) {
    // Intraday TRACE: prefer HH:mm; on day boundaries show "Mon DD".
    const parts = zonedParts(ms, CHART_TZ)
    if (parts.hour === 0 && parts.minute === 0) {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: CHART_TZ,
        month: 'short',
        day: 'numeric',
      }).format(d)
    }
    return new Intl.DateTimeFormat('en-US', {
      timeZone: CHART_TZ,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d)
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHART_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d)
}

type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function zonedParts(ms: number, timeZone: string = CHART_TZ): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const bag: Record<string, string> = {}
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') bag[p.type] = p.value
  }
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
  }
}

/**
 * Convert a wall-clock civil time in `timeZone` to UTC epoch ms.
 * Iteratively corrects using the zone offset (handles EST/EDT).
 */
function zonedTimeToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  // Initial guess: treat the civil time as if it were UTC.
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  for (let i = 0; i < 5; i++) {
    const p = zonedParts(guess, timeZone)
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0)
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
    const delta = desired - asIfUtc
    if (Math.abs(delta) < 500) break
    guess += delta
  }
  return guess
}

/**
 * Clamp a visible logical range to the 0DTE session domain [0, maxTo].
 *
 * Preserves span when sliding off either wall; collapses to full session when
 * the user zooms out past the book. Returns null only for non-finite input.
 */
function clampSessionLogicalRange(
  range: { from: number; to: number },
  maxTo: number,
): { from: number; to: number } | null {
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return null
  if (!(maxTo > 0)) return { from: 0, to: Math.max(0, maxTo) }

  let from = range.from
  let to = range.to
  const span = to - from
  if (!(span > 0)) return { from: 0, to: maxTo }

  // Zoom-out ceiling: full open → settle (no empty flanks past the book).
  if (span > maxTo + 1e-6) {
    return { from: 0, to: maxTo }
  }

  // Left wall (session open / bar 0).
  if (from < 0) {
    to -= from
    from = 0
    if (to > maxTo) {
      to = maxTo
      from = Math.max(0, to - span)
    }
  }

  // Right wall (settle / last series point).
  if (to > maxTo) {
    const overshoot = to - maxTo
    from -= overshoot
    to = maxTo
    if (from < 0) {
      from = 0
      to = Math.min(maxTo, span)
    }
  }

  if (!(to > from)) return { from: 0, to: maxTo }
  return { from, to }
}

/**
 * Lock the time scale to the full 0DTE session series
 * (OHLC + residual whitespace through settle).
 */
function applySessionTimeWindow(
  handle: ChartHandle,
  nBars: number,
  lastGoodRangeRef?: { current: { from: number; to: number } | null },
) {
  if (nBars < 1) return
  // Full TRACE domain: bar 0 (session open) → last (settle). LWC computes
  // barSpacing to fill the pane — maxBarSpacing must be high enough or the
  // right side packs and the left stays black.
  const from = 0
  const to = Math.max(0, nBars - 1)

  try {
    handle.chart.timeScale().applyOptions({
      rightOffset: 0,
      fixLeftEdge: true,
      fixRightEdge: false,
      minBarSpacing: MIN_BAR_SPACING,
      maxBarSpacing: MAX_BAR_SPACING,
      shiftVisibleRangeOnNewBar: false,
      lockVisibleTimeRangeOnResize: true,
    })
  } catch {
    // ignore
  }

  try {
    handle.chart.timeScale().setVisibleLogicalRange({ from, to })
    if (lastGoodRangeRef) lastGoodRangeRef.current = { from, to }
  } catch {
    // ignore
  }

  // Second frame: LWC sometimes ignores the first range before layout.
  requestAnimationFrame(() => {
    try {
      handle.chart.timeScale().setVisibleLogicalRange({ from, to })
      if (lastGoodRangeRef) lastGoodRangeRef.current = { from, to }
    } catch {
      // ignore
    }
  })
}

/**
 * Series skeleton key — when this is stable, only the live bar OHLC changed
 * and we can `update()` instead of full `setData` (avoids pan/zoom flicker).
 */
function structureKeyFor(
  candles: OhlcCandle[],
  interval: CandleInterval,
  surface: GexForwardSurface | null | undefined,
  session: SessionBounds,
): string {
  // Key the *session grid*, not just live candles — open/settle define length.
  const step = candleIntervalMs[interval]
  const settle =
    surface?.settleMs && surface.settleMs > session.startMs
      ? surface.settleMs
      : session.endMs
  const startBucket = Math.floor(session.startMs / step)
  const settleBucket = Math.floor(settle / step)
  const lastLive = candles.length > 0 ? candles[candles.length - 1]!.t : 0
  // Live bar open (quantized) — new candle forms a structural change.
  const liveBucket = lastLive > 0 ? Math.floor(lastLive / step) : 0
  return `${interval}|${startBucket}|${settleBucket}|${candles.length}|${liveBucket}`
}

/**
 * Force a usable right price scale after setData. Prefer session candles so the
 * default view frames price action; surface walls only as cold-start fallback.
 */
function seedPriceScale(
  handle: ChartHandle,
  chartPrice: number | null | undefined,
  surface: GexForwardSurface | null | undefined,
  candles?: OhlcCandle[] | null,
  expiryScope: ForwardExpiryScope = '0dte',
) {
  try {
    const candleFit = resolveCandlePriceRange(
      candles,
      chartPrice ?? surface?.spot ?? null,
      minPriceHalfWindowPct(expiryScope),
    )
    const surfaceFit = resolveActiveSurfacePriceRange(surface)
    let min: number
    let max: number
    if (candleFit) {
      min = candleFit.minValue
      max = candleFit.maxValue
    } else if (surfaceFit) {
      min = surfaceFit.minValue
      max = surfaceFit.maxValue
    } else {
      const spot =
        chartPrice && chartPrice > 0
          ? chartPrice
          : surface?.spot && surface.spot > 0
            ? surface.spot
            : 0
      if (!(spot > 0)) return
      const pad = Math.max(spot * 0.03, 100)
      min = spot - pad
      max = spot + pad
    }
    if (!(max > min)) return
    const scale = handle.chart.priceScale('right')
    scale.applyOptions({
      autoScale: true,
      scaleMargins: { top: PRICE_EDGE_MARGIN, bottom: PRICE_EDGE_MARGIN },
    })
    // setVisibleRange only while not fighting a user manual scale — caller
    // gates this with autoFit. When autoScale is on LWC prefers provider, but
    // setting once kicks the first layout.
    try {
      scale.setAutoScale(true)
    } catch {
      // ignore
    }
    try {
      scale.setVisibleRange({ from: min, to: max })
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

/** Create or move the dashed last-price line without remove/recreate thrash. */
function syncPriceLine(handle: ChartHandle, price: number | null | undefined) {
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
 * After setData, put the user back on their zoom if still legal — never snap
 * to full session (that was the scroll-zoom "teleport" / off-scale glitch).
 */
function restoreLogicalRange(
  handle: ChartHandle,
  preserved: LogicalRange | null | undefined,
  nBars: number,
  lastGoodRangeRef: { current: { from: number; to: number } | null },
) {
  if (nBars < 2) return
  const maxTo = nBars - 1
  const src = preserved ?? lastGoodRangeRef.current
  if (!src || !(src.to > src.from)) {
    // Keep LWC's post-setData range; only record if legal.
    try {
      const cur = handle.chart.timeScale().getVisibleLogicalRange()
      if (cur && cur.to > cur.from) {
        lastGoodRangeRef.current = { from: cur.from, to: cur.to }
      }
    } catch {
      // ignore
    }
    return
  }

  const clamped = clampSessionLogicalRange(src, maxTo)
  if (!clamped) return
  const { from, to } = clamped

  // Exact restore — do not "nudge" to walls (that looked like live reposition).
  try {
    const cur = handle.chart.timeScale().getVisibleLogicalRange()
    if (
      cur
      && Math.abs(cur.from - from) < 1e-4
      && Math.abs(cur.to - to) < 1e-4
    ) {
      lastGoodRangeRef.current = { from, to }
      return
    }
    handle.chart.timeScale().setVisibleLogicalRange({ from, to })
    lastGoodRangeRef.current = { from, to }
  } catch {
    // ignore
  }
}

/**
 * Default Y domain from session candles, expanded to a desk-standard window.
 *
 * 1. Always include session candle H/L (price action is the anchor).
 * 2. Center on the candle mid.
 * 3. Expand half-span to at least ~±4.6% of spot so TRACE lobes have context
 *    (matches preferred desk frame ~60.2k–66.0k around ~63k, not a tight OHLC box).
 * 4. If the session already spans more than that, keep candle range + modest pad.
 */
function resolveCandlePriceRange(
  candles: OhlcCandle[] | null | undefined,
  spot?: number | null,
  minHalfWindowPct = CANDLE_MIN_HALF_WINDOW_PCT,
): { minValue: number; maxValue: number } | null {
  let lo = Infinity
  let hi = -Infinity
  if (candles && candles.length > 0) {
    for (const c of candles) {
      const high = Number(c.h)
      const low = Number(c.l)
      if (Number.isFinite(high) && high > hi) hi = high
      if (Number.isFinite(low) && low < lo) lo = low
    }
  }
  // If only open/close survived (bad HL), widen from those.
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = Infinity
    hi = -Infinity
    if (candles) {
      for (const c of candles) {
        for (const v of [c.o, c.c, c.h, c.l]) {
          const n = Number(v)
          if (!Number.isFinite(n)) continue
          if (n < lo) lo = n
          if (n > hi) hi = n
        }
      }
    }
  }

  const spotOk = spot != null && spot > 0 && Number.isFinite(spot)

  if (!(Number.isFinite(lo) && Number.isFinite(hi))) {
    if (!spotOk) return null
    const half = Math.max(spot! * minHalfWindowPct, 40)
    return { minValue: spot! - half, maxValue: spot! + half }
  }

  // Degenerate / single print — still apply min window around it.
  if (hi <= lo) {
    const mid = Number.isFinite(hi) ? hi : lo
    if (!(mid > 0)) {
      if (!spotOk) return null
      const half = Math.max(spot! * minHalfWindowPct, 40)
      return { minValue: spot! - half, maxValue: spot! + half }
    }
    const ref = spotOk ? spot! : mid
    const half = Math.max(ref * minHalfWindowPct, 40)
    return { minValue: mid - half, maxValue: mid + half }
  }

  const mid = (lo + hi) / 2
  const candleHalf = (hi - lo) / 2
  const ref = spotOk ? spot! : mid
  // Desk min window (~±4.6% of spot) so quiet sessions still show TRACE context.
  const minHalf = Math.max(ref * minHalfWindowPct, 40)
  // Prefer candle path + pad when the session is already wide (volatile day).
  const paddedCandleHalf = candleHalf * (1 + CANDLE_FIT_PAD)
  const half = Math.max(paddedCandleHalf, minHalf)

  return { minValue: mid - half, maxValue: mid + half }
}

function minPriceHalfWindowPct(expiryScope: ForwardExpiryScope): number {
  return expiryScope === '0dte'
    ? CANDLE_MIN_HALF_WINDOW_PCT
    : TENOR_MIN_HALF_WINDOW_PCT
}

function forwardMetricTitle(metric: ForwardGreekMetric): string {
  if (metric === 'gamma') return 'GEX Surface'
  if (metric === 'delta') return 'DEX Surface'
  if (metric === 'delta_change') return 'DEX Change Surface'
  return `${metric.charAt(0).toUpperCase()}${metric.slice(1)} Surface`
}

/**
 * Fallback Y domain: active γ walls (+ small pad) when no candles are available.
 * Full surface.prices (~±8%) leaves huge dead air — use peak-|GEX| walls only.
 */
function resolveActiveSurfacePriceRange(
  surface: GexForwardSurface | null | undefined,
): { minValue: number; maxValue: number } | null {
  if (!surface?.prices?.length || !surface.values?.length) return null
  const prices = surface.prices
  const nP = prices.length
  const nT = surface.values.length
  if (nP < 2 || nT < 1) return null

  // Peak |GEX| across a few τ columns (live + mid residual + near settle).
  const colIdx = [
    0,
    Math.floor((nT - 1) * 0.35),
    Math.floor((nT - 1) * 0.7),
    nT - 1,
  ]
  let peak = 0
  for (const ci of colIdx) {
    const col = surface.values[ci]
    if (!col) continue
    for (let i = 0; i < Math.min(col.length, nP); i++) {
      const a = Math.abs(col[i] ?? 0)
      if (a > peak) peak = a
    }
  }
  if (!(peak > 0)) {
    const lo = prices[0]!
    const hi = prices[nP - 1]!
    return lo < hi ? { minValue: lo, maxValue: hi } : null
  }

  const thr = peak * 0.1
  let lo = Infinity
  let hi = -Infinity
  for (const ci of colIdx) {
    const col = surface.values[ci]
    if (!col) continue
    for (let i = 0; i < Math.min(col.length, nP); i++) {
      if (Math.abs(col[i] ?? 0) >= thr) {
        const p = prices[i]!
        if (p < lo) lo = p
        if (p > hi) hi = p
      }
    }
  }
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = prices[0]!
    hi = prices[nP - 1]!
  }

  const span = hi - lo
  const pad = Math.max(span * SURFACE_FIT_PAD, span * 0.015, 50)
  return { minValue: lo - pad, maxValue: hi + pad }
}

function formatSurfaceUnit(unit: string): string {
  if (unit === 'USD / 1% move') return '$ / 1%'
  if (unit === 'USD delta notional') return '$ delta'
  if (unit === 'USD hedge change') return '$ hedge'
  if (unit === 'USD delta / day') return '$Δ / day'
  if (unit === 'USD delta / vol point') return '$Δ / vol pt'
  return unit
}

function formatNyHoverTime(timeMs: number): string {
  return HOVER_TIME_FORMATTER.format(new Date(timeMs))
}

function formatPrice(price: number): string {
  return `$${Math.round(price).toLocaleString('en-US')}`
}

function paletteCssGradient(ramp: GammaStop[]): string {
  return `linear-gradient(90deg, ${ramp.map((stop) => {
    const pct = ((stop.t + 1) / 2) * 100
    return `rgb(${stop.c.r} ${stop.c.g} ${stop.c.b}) ${pct.toFixed(1)}%`
  }).join(', ')})`
}

function formatIvShift(shift: number): string {
  if (Math.abs(shift) < 1e-9) return '0'
  const amount = Number.isInteger(Math.abs(shift))
    ? Math.abs(shift).toFixed(0)
    : Math.abs(shift).toFixed(1)
  return shift > 0 ? `+${amount}` : `−${amount}`
}

function formatExpiryCardDate(expiry: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry)
  if (!match) return expiry || '—'
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12))
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function formatSettleTime(settleMs: number): string {
  if (!(settleMs > 0)) return 'settle —'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHART_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(settleMs))
}

function formatPositionRecovery(
  recovery: GexForwardSurface['meta']['positionRecovery'],
): string {
  if (recovery === 'direct_flow_positions') return 'direct positions'
  if (recovery === 'mixed') return 'mixed recovery'
  if (recovery === 'gex_inversion') return 'GEX-derived'
  return 'unavailable'
}

function formatSurfaceValue(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

function sampleForwardSurface(
  surface: GexForwardSurface,
  timeMs: number,
  price: number,
): number | null {
  const times = surface.times
  const prices = surface.prices
  if (
    times.length < 2
    || prices.length < 2
    || timeMs < times[0]!
    || timeMs > times[times.length - 1]!
    || price < prices[0]!
    || price > prices[prices.length - 1]!
  ) {
    return null
  }
  const ti = bracketNumber(times, timeMs)
  const pi = bracketNumber(prices, price)
  const a0 = surface.values[ti.lo]?.[pi.lo] ?? 0
  const a1 = surface.values[ti.lo]?.[pi.hi] ?? a0
  const b0 = surface.values[ti.hi]?.[pi.lo] ?? a0
  const b1 = surface.values[ti.hi]?.[pi.hi] ?? b0
  const low = a0 * (1 - pi.weight) + a1 * pi.weight
  const high = b0 * (1 - pi.weight) + b1 * pi.weight
  const value = low * (1 - ti.weight) + high * ti.weight
  return Number.isFinite(value) ? value : null
}

function bracketNumber(
  values: number[],
  target: number,
): { lo: number; hi: number; weight: number } {
  if (target <= values[0]!) return { lo: 0, hi: 0, weight: 0 }
  const last = values.length - 1
  if (target >= values[last]!) return { lo: last, hi: last, weight: 0 }
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (values[mid]! <= target) lo = mid
    else hi = mid
  }
  return {
    lo,
    hi,
    weight: (target - values[lo]!) / Math.max(1e-9, values[hi]! - values[lo]!),
  }
}

function readIsLightTheme(): boolean {
  const style = getComputedStyle(document.documentElement)
  return Boolean(
    document.documentElement.dataset.theme?.includes('light')
    || style.getPropertyValue('--terminal-is-light').trim() === '1'
  )
}
