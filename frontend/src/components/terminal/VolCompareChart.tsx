import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ITimeScaleApi,
  type LogicalRange,
  type Logical,
  type MouseEventParams,
  type Time,
  type TimeScaleOptions,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { VolSeriesPoint } from '@/data/mockTerminal'
import type { VolChartMode } from '@/lib/volCompareModes'
import { readVolChartColors, type VolChartColors } from '@/data/volChartTheme'
import { withAlpha } from '@/data/gexChartColors'
import {
  createDynamicMiniChartPriceFormat,
  resolveMiniChartAxisStep,
} from '@/data/miniChartAxis'
import { MiniChartTimeAxis } from '@/components/terminal/MiniChartTimeAxis'
import {
  MINI_CHART_LEFT_AIR_FRACTION,
  MINI_CHART_RANGE_LOOKBACK_SECONDS,
  MINI_CHART_RIGHT_AIR_FRACTION,
  padMiniChartRangeBounds,
  resolveMiniChartRangeBounds,
  type MiniChartRange,
  type MiniChartRangeBounds,
} from '@/data/miniChartRange'

/**
 * Regime vol chart (Lightweight Charts v5) — three modes:
 *   dvol   — DVOL only
 *   iv_rv  — dual pane: IV + RV lines, Δ baseline (collapsed height)
 *   vrp    — premium ribbon through 0
 *   vrp_z  — signed bar histogram + dim zero / ±1.5 / ±2 guides
 *
 * Colors are theme-aware (CSS tokens via readVolChartColors).
 * Host must be position:absolute; inset:0 inside a sized parent.
 */

type VolCompareChartProps = {
  mode: VolChartMode
  range: MiniChartRange
  dvolSeries: VolSeriesPoint[]
  rvSeries: VolSeriesPoint[]
  spreadSeries: VolSeriesPoint[]
  showRv?: boolean
  showSpread?: boolean
  showPrice?: boolean
  priceSeries?: VolSeriesPoint[]
  vrpSeries?: VolSeriesPoint[]
  vrpZSeries?: VolSeriesPoint[]
  className?: string
}

/** IV pane gets more room; Δ sub-pane is compact but tall enough for a few Y ticks. */
const VOL_STRETCH = 0.72
const SPREAD_STRETCH = 0.28
/**
 * Auto-view (initial fit + double-click) — relative to latest sample, not calendar pins.
 *   iv_rv / vrp — last ~7d (hourly path, matches the desk reference shot)
 *   vrp_z       — last ~20d (daily bars; ~11 Jul · 16 · 21 · 26 style window)
 *
 * Right air is shared with the other mini time-series charts so the latest
 * sample never lands flush against the Y-axis.
 */
const Z_SCALE_FLOOR = 3.0
const Z_SCALE_PAD = 0.18
const Z_ELEVATED_THRESHOLD = 1
const Z_EXTREME_THRESHOLD = 2
const Z_EXCEPTIONAL_THRESHOLD = 3
const Z_RIGHT_AIR_FRACTION = 0.065
const VOL_CHART_TIME_ZONE = 'America/New_York'
const BTC_PRICE_SCALE_ID = 'btc-price'
const ONE_DAY_VOL_AXIS_FLOOR = 0.2
const BTC_PAIRED_AXIS_FLOOR = 100
const VOL_PAIRED_AXIS_FLOOR = 0.05
const LONG_RANGE_VRP_AXIS_INTERVALS = 8

function padVolChartRangeBounds(
  bounds: MiniChartRangeBounds,
  mode: VolChartMode,
): MiniChartRangeBounds {
  return padMiniChartRangeBounds(
    bounds,
    mode === 'vrp'
      ? MINI_CHART_LEFT_AIR_FRACTION
      : mode === 'vrp_z'
        ? Z_RIGHT_AIR_FRACTION
      : MINI_CHART_RIGHT_AIR_FRACTION,
  )
}

function isLongVrpRange(range: MiniChartRange): boolean {
  return range === '3m' || range === '6m' || range === '1y' || range === 'all'
}
const PAIRED_AXIS_INTERVALS = 3
const PAIRED_AXIS_PADDING_RATIO = 0.12
const PAIRED_AXIS_MARGINS = { top: 0.12, bottom: 0.12 } as const

type PriceOverlayStage = 'hidden' | 'entering' | 'visible' | 'leaving'

type ChartHandle = {
  chart: IChartApi
  mode: VolChartMode
  colors: VolChartColors
  dvol: ISeriesApi<'Line'> | null
  rv: ISeriesApi<'Line'> | null
  price: ISeriesApi<'Line'> | null
  spread: ISeriesApi<'Baseline'> | null
  ribbon: ISeriesApi<'Baseline'> | null
  zHistogram: ISeriesApi<'Histogram'> | null
  rangeAnchor: ISeriesApi<'Line'>
  priceLines: IPriceLine[]
  priceVisible: boolean
  priceAnimationFrame: number
  priceAnimationStrength: number
  priceStage: PriceOverlayStage
  onPriceStageChange?: (stage: PriceOverlayStage) => void
  lastPriceData: PlotPoint[]
  axisSteps: {
    right: { current: number }
    left: { current: number }
    spread: { current: number }
  }
  lastDomain?: { fromSec: number; toSec: number; n: number }
  lastTimesSec?: number[]
}

type PlotPoint = { time: UTCTimestamp; value: number }

type NumericAxisRange = { from: number; to: number; step: number }

type PairedAxisRanges = {
  price: NumericAxisRange
  vol: NumericAxisRange
}

type CrosshairLabel = {
  kind: string
  text: string
  detail?: string
  top: number
  left: number
  pointTop: number
  pointLeft: number
  tone?: 'pos' | 'neg'
  regime?: ZScoreHeuristic['regime']
}

type FixedAxisLabel = {
  id: string
  side: 'left' | 'right'
  text: string
  top: number
}

type SeriesProps = {
  mode: VolChartMode
  range: MiniChartRange
  dvolSeries: VolSeriesPoint[]
  rvSeries: VolSeriesPoint[]
  spreadSeries: VolSeriesPoint[]
  showRv: boolean
  showSpread: boolean
  showPrice: boolean
  priceSeries: VolSeriesPoint[]
  vrpSeries: VolSeriesPoint[]
  vrpZSeries: VolSeriesPoint[]
}

export function VolCompareChart({
  mode,
  range,
  dvolSeries,
  rvSeries,
  spreadSeries,
  showRv = true,
  showSpread = true,
  showPrice = false,
  priceSeries = [],
  vrpSeries = [],
  vrpZSeries = [],
  className,
}: VolCompareChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<ChartHandle | null>(null)
  const fittedViewportKeyRef = useRef('')
  const propsRef = useRef<SeriesProps>({
    mode,
    range,
    dvolSeries,
    rvSeries,
    spreadSeries,
    showRv,
    showSpread,
    showPrice,
    priceSeries,
    vrpSeries,
    vrpZSeries,
  })
  const [error, setError] = useState<string | null>(null)
  const [crosshairLabels, setCrosshairLabels] = useState<CrosshairLabel[]>([])
  const [fixedAxisLabels, setFixedAxisLabels] = useState<FixedAxisLabel[]>([])
  const [priceOverlayStage, setPriceOverlayStage] = useState<PriceOverlayStage>('hidden')
  const [separatorTop, setSeparatorTop] = useState<number | null>(null)
  const rangeBounds = useMemo(() => {
    const groups = mode === 'dvol'
      ? [dvolSeries]
      : mode === 'iv_rv'
      ? [dvolSeries, rvSeries, spreadSeries]
      : mode === 'vrp'
        ? [vrpSeries]
        : [vrpZSeries]
    return resolveMiniChartRangeBounds(range, groups)
  }, [dvolSeries, mode, range, rvSeries, spreadSeries, vrpSeries, vrpZSeries])
  const viewportBounds = useMemo(
    () => rangeBounds ? padVolChartRangeBounds(rangeBounds, mode) : null,
    [mode, rangeBounds],
  )

  useEffect(() => {
    propsRef.current = {
      mode,
      range,
      dvolSeries,
      rvSeries,
      spreadSeries,
      showRv,
      showSpread,
      showPrice,
      priceSeries,
      vrpSeries,
      vrpZSeries,
    }
  }, [dvolSeries, mode, priceSeries, range, rvSeries, showPrice, showRv, showSpread, spreadSeries, vrpSeries, vrpZSeries])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let handle: ChartHandle | null = null
    let raf = 0
    let sepRaf = 0
    let hoverRaf = 0
    let pendingCrosshair: MouseEventParams | null = null
    let ro: ResizeObserver | null = null
    let themeObserver: MutationObserver | null = null
    queueMicrotask(() => {
      if (!disposed) setError(null)
    })

    const refreshSeparator = () => {
      if (disposed || !handle) return
      setSeparatorTop(computeSeparatorTop(handle, propsRef.current))
      setFixedAxisLabels(buildFixedAxisLabels(handle, propsRef.current))
    }
    const scheduleSeparator = () => {
      if (sepRaf) cancelAnimationFrame(sepRaf)
      sepRaf = requestAnimationFrame(refreshSeparator)
    }
    const clearCrosshair = () => {
      setCrosshairLabels((prev) => (prev.length === 0 ? prev : []))
    }

    const updateCrosshair = (param: MouseEventParams) => {
      if (disposed || !handle) return
      const p = propsRef.current
      if (
        !param.point
        || param.time === undefined
        || param.point.x < 0
        || param.point.y < 0
      ) {
        return
      }

      const hostOffsetX = host.offsetLeft
      const wrapperWidth = host.parentElement?.clientWidth || host.clientWidth || 1
      const hoverRightInset = p.mode === 'vrp_z' ? 110 : 74
      const left = Math.min(
        Math.max(12, hostOffsetX + param.point.x + 10),
        wrapperWidth - hoverRightInset,
      )
      const labels: CrosshairLabel[] = []
      const hoverMs = timeToEpochMs(param.time)
      const pointLeft = hostOffsetX + param.point.x

      if (p.mode === 'dvol' || p.mode === 'iv_rv') {
        if (handle.dvol) {
          const ivVal = readSeriesValue(handle.dvol, param)
            ?? interpolateSeriesValue(p.dvolSeries, hoverMs)
          if (ivVal != null) {
            const y = handle.dvol.priceToCoordinate(ivVal)
            if (y != null && Number.isFinite(y)) {
              labels.push({
                kind: 'iv',
                text: formatVol(ivVal),
                top: Math.max(8, y),
                left,
                pointTop: y,
                pointLeft,
              })
            }
          }
        }
        if (p.mode === 'iv_rv' && p.showRv && handle.rv) {
          const rvVal = readSeriesValue(handle.rv, param)
            ?? interpolateSeriesValue(p.rvSeries, hoverMs)
          if (rvVal != null) {
            const y = handle.rv.priceToCoordinate(rvVal)
            if (y != null && Number.isFinite(y)) {
              labels.push({
                kind: 'rv',
                text: formatVol(rvVal),
                top: Math.max(8, y),
                left,
                pointTop: y,
                pointLeft,
              })
            }
          }
        }
        if (p.mode === 'iv_rv' && p.showSpread && handle.spread) {
          const spVal = readSeriesValue(handle.spread, param)
            ?? interpolateSeriesValue(p.spreadSeries, hoverMs)
          if (spVal != null) {
            let paneOffset: number
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
                top: Math.max(8, y + paneOffset),
                left,
                pointTop: y + paneOffset,
                pointLeft,
                tone: spVal >= 0 ? 'pos' : 'neg',
              })
            }
          }
        }
        if (p.showPrice && handle.price) {
          const priceValue = readSeriesValue(handle.price, param)
            ?? interpolateSeriesValue(p.priceSeries, hoverMs)
          if (priceValue != null) {
            const y = handle.price.priceToCoordinate(priceValue)
            if (y != null && Number.isFinite(y)) {
              labels.push({
                kind: 'price',
                text: formatBtcPrice(priceValue),
                top: Math.max(8, y),
                left,
                pointTop: y,
                pointLeft,
              })
            }
          }
        }
      } else if (p.mode === 'vrp' || p.mode === 'vrp_z') {
        const raw = p.mode === 'vrp' ? p.vrpSeries : p.vrpZSeries
        const series = p.mode === 'vrp' ? handle.ribbon : handle.zHistogram
        if (!series) return
        const v = readSeriesValue(series, param)
          ?? interpolateSeriesValue(raw, hoverMs)
        if (v != null) {
          const y = series.priceToCoordinate(v)
          if (y != null && Number.isFinite(y)) {
            const zHeuristic = p.mode === 'vrp_z' ? describeZScore(v) : null
            labels.push({
              kind: p.mode === 'vrp' ? 'vrp' : 'z',
              text: p.mode === 'vrp' ? formatSpread(v) : formatZSigma(v),
              detail: zHeuristic?.label,
              regime: zHeuristic?.regime,
              top: Math.max(6, y),
              left,
              pointTop: y,
              pointLeft,
              tone: v >= 0 ? 'pos' : 'neg',
            })
          }
        }
      }

      setCrosshairLabels(labels)
    }

    const onCrosshair = (param: MouseEventParams) => {
      pendingCrosshair = param
      if (hoverRaf) return
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0
        const next = pendingCrosshair
        pendingCrosshair = null
        if (next) updateCrosshair(next)
      })
    }

    try {
      host.replaceChildren()
      const colors = readVolChartColors(host)
      const { w, h } = measure(host)
      const multiPane = mode === 'iv_rv'
      const chart = createChart(host, {
        width: w,
        height: h,
        localization: {
          locale: 'en-US',
          timeFormatter: formatVolCrosshairTime,
        },
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: colors.text,
          fontSize: 9,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          attributionLogo: false,
          ...(multiPane
            ? {
                panes: {
                  separatorColor: colors.separator,
                  separatorHoverColor: 'rgba(160, 168, 180, 0.32)',
                  enableResize: false,
                },
              }
            : {}),
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { visible: false },
        },
        crosshair: {
          mode: CrosshairMode.Magnet,
          vertLine: {
            color: colors.rule,
            width: 1,
            style: LineStyle.Dotted,
            labelVisible: true,
            labelBackgroundColor: colors.crosshairLabelBg,
          },
          horzLine: { visible: false, labelVisible: false },
        },
        rightPriceScale: {
          // All Y labels are rendered by the clean overlay. Keeping LWC's
          // native scale hidden prevents it from reserving a wide empty gutter.
          visible: false,
          borderVisible: false,
          scaleMargins: { top: 0.15, bottom: 0.14 },
          entireTextOnly: true,
          textColor: 'rgba(0, 0, 0, 0)',
        },
        leftPriceScale: {
          visible: false,
          borderVisible: false,
          scaleMargins: { top: 0.18, bottom: 0.18 },
          entireTextOnly: true,
          textColor: 'rgba(0, 0, 0, 0)',
        },
        timeScale: {
          // Keep the native strip mounted for Lightweight Charts' crosshair
          // date/time label. Static ticks remain custom-rendered below.
          visible: true,
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
          // VRP Z: pin left to first history bar so wheel zoom-out cannot open
          // empty space before the series start (still free to pan/zoom inside).
          fixLeftEdge: mode === 'vrp_z',
          fixRightEdge: false,
          rightOffset: 0,
          shiftVisibleRangeOnNewBar: false,
          lockVisibleTimeRangeOnResize: true,
          allowBoldLabels: false,
          ticksVisible: false,
          tickMarkMaxCharacterLength: 6,
          // Zoom-out floor (px/bar). Lower = more history visible.
          // VRP is ~365d hourly (~9k bars) — keep this small so wheel zoom can
          // open the full book on a narrow rail. Z is daily/sparse; tighter is fine.
          // IV/RV dual-pane sits in the middle.
          minBarSpacing:
            mode === 'vrp' ? 0.08 : multiPane ? 0.35 : 0.45,
        },
        handleScroll: false,
        handleScale: false,
      })

      handle = createModeSeries(chart, mode, colors)
      handle.onPriceStageChange = (stage) => {
        setPriceOverlayStage(stage)
        if (stage !== 'hidden' || propsRef.current.showPrice) return
        // Clearing the overlay changes Lightweight Charts' logical timeline.
        // Restore the requested calendar window after that removal settles.
        requestAnimationFrame(() => {
          if (disposed || !handle) return
          applyDefaultTimeView(
            handle.chart.timeScale(),
            handle.mode,
            handle.lastTimesSec ?? [],
            propsRef.current.range,
          )
          requestAnimationFrame(() => {
            if (disposed || !handle) return
            applyDefaultTimeView(
              handle.chart.timeScale(),
              handle.mode,
              handle.lastTimesSec ?? [],
              propsRef.current.range,
            )
          })
        })
      }
      handleRef.current = handle
      // TimeScaleOptions extends HorzScaleOptions with tickMarkFormatter
      chart.timeScale().applyOptions({
        tickMarkFormatter: () => '',
      } as DeepPartialTimeScale)
      applySeries(handle, propsRef.current, { fit: true })
      fittedViewportKeyRef.current = `${mode}|${propsRef.current.range}|${propsRef.current.showPrice}`
      scheduleSeparator()
      chart.subscribeCrosshairMove(onCrosshair)

      // Belt-and-suspenders: LWC wheel zoom can still overshoot left of bar 0
      // slightly even with fixLeftEdge. Soft-clamp from ≥ 0 and cap span to the
      // full history (+ right air) so zoom-out stops at “show all data”.
      let rangeClampLock = false
      const onLogicalRange = (range: LogicalRange | null) => {
        if (disposed || !handle || rangeClampLock) return
        if (handle.mode !== 'vrp_z') return
        if (range == null || !Number.isFinite(range.from) || !Number.isFinite(range.to)) {
          return
        }
        const times = handle.lastTimesSec
        if (!times || times.length === 0) return

        const lastIdx = times.length - 1
        const pad = padBarsForSeries(times, times.length)
        const maxSpan = lastIdx + pad + 0.05
        let from = Number(range.from)
        let to = Number(range.to)
        let span = to - from
        if (!(span > 0)) return

        let changed = false
        if (from < 0) {
          // Keep span; slide so history start is the left edge.
          to = to - from
          from = 0
          span = to - from
          changed = true
        }
        if (span > maxSpan) {
          // Fully zoomed out: [0, full book + right air]. Prefer pinning left.
          from = 0
          to = maxSpan
          changed = true
        }
        if (!changed) return

        rangeClampLock = true
        try {
          handle.chart.timeScale().setVisibleLogicalRange({
            from: from as Logical,
            to: to as Logical,
          })
        } catch {
          // ignore
        } finally {
          requestAnimationFrame(() => {
            rangeClampLock = false
          })
        }
      }
      if (mode === 'vrp_z') {
        chart.timeScale().subscribeVisibleLogicalRangeChange(onLogicalRange)
      }

      const onDblClick = (ev: MouseEvent) => {
        if (disposed || !handle) return
        ev.preventDefault()
        ev.stopPropagation()
        applyDefaultTimeView(
          handle.chart.timeScale(),
          handle.mode,
          handle.lastTimesSec ?? [],
          propsRef.current.range,
        )
      }
      host.addEventListener('dblclick', onDblClick)
      host.addEventListener('mouseleave', clearCrosshair)

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

      // Live theme flips — recolor series without full remount of data path.
      themeObserver = new MutationObserver(() => {
        if (disposed || !handle) return
        const next = readVolChartColors(host)
        handle.colors = next
        applyThemeColors(handle)
        if (handle.mode === 'vrp_z') {
          applySeries(handle, propsRef.current)
        }
        try {
          handle.chart.applyOptions({
            layout: { textColor: next.text },
            crosshair: {
              vertLine: {
                color: next.rule,
                labelBackgroundColor: next.crosshairLabelBg,
              },
            },
          })
        } catch {
          // ignore
        }
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'class'],
      })

      // Resize only on first frame — applySeries({ fit: true }) already set auto-view.
      raf = requestAnimationFrame(() => {
        syncSize()
        scheduleSeparator()
      })

      return () => {
        disposed = true
        if (raf) cancelAnimationFrame(raf)
        if (sepRaf) cancelAnimationFrame(sepRaf)
        if (hoverRaf) cancelAnimationFrame(hoverRaf)
        if (handle?.priceAnimationFrame) cancelAnimationFrame(handle.priceAnimationFrame)
        if (handle) handle.onPriceStageChange = undefined
        setPriceOverlayStage('hidden')
        ro?.disconnect()
        themeObserver?.disconnect()
        host.removeEventListener('dblclick', onDblClick)
        host.removeEventListener('mouseleave', clearCrosshair)
        try {
          handle?.chart.unsubscribeCrosshairMove(onCrosshair)
        } catch {
          // ignore
        }
        if (mode === 'vrp_z') {
          try {
            handle?.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onLogicalRange)
          } catch {
            // ignore
          }
        }
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
      queueMicrotask(() => {
        if (!disposed) setError(msg)
      })
      console.error('[VolCompareChart] create failed', err)
      return () => {
        disposed = true
      }
    }
  }, [mode])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle || handle.mode !== mode) return
    try {
      // Data polls: preserve pan/zoom. Never re-fit here (that was re-applying
      // a full-book range captured after a failed first fit).
      const viewportKey = `${mode}|${range}|${showPrice}`
      const shouldFitViewport = fittedViewportKeyRef.current !== viewportKey
      applySeries(handle, {
        mode,
        range,
        dvolSeries,
        rvSeries,
        spreadSeries,
        showRv,
        showSpread,
        showPrice,
        priceSeries,
        vrpSeries,
        vrpZSeries,
      }, { fit: shouldFitViewport })
      fittedViewportKeyRef.current = viewportKey
      requestAnimationFrame(() => {
        setSeparatorTop(computeSeparatorTop(handle, {
          mode,
          range,
          dvolSeries,
          rvSeries,
          spreadSeries,
          showRv,
          showSpread,
          showPrice,
          priceSeries,
          vrpSeries,
          vrpZSeries,
        }))
        setFixedAxisLabels(buildFixedAxisLabels(handle, {
          mode,
          range,
          dvolSeries,
          rvSeries,
          spreadSeries,
          showRv,
          showSpread,
          showPrice,
          priceSeries,
          vrpSeries,
          vrpZSeries,
        }))
      })
      const axisSettleTimer = window.setTimeout(() => {
        setFixedAxisLabels(buildFixedAxisLabels(handle, propsRef.current))
      }, 220)
      return () => window.clearTimeout(axisSettleTimer)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => setError(msg))
      console.error('[VolCompareChart] update failed', err)
    }
  }, [mode, range, dvolSeries, rvSeries, spreadSeries, showRv, showSpread, showPrice, priceSeries, vrpSeries, vrpZSeries])

  if (error) {
    return (
      <div className={className}>
        <div className="regime-vol__empty">
          Chart error
        </div>
      </div>
    )
  }

  const wrapperClassName = [
    className,
    'regime-vol__lwc-wrap',
    mode === 'vrp_z' && 'regime-vol__lwc-wrap--zscore',
    mode !== 'vrp_z' && 'regime-vol__lwc-wrap--custom-right',
    priceOverlayStage !== 'hidden' && 'regime-vol__lwc-wrap--price',
    `regime-vol__lwc-wrap--price-${priceOverlayStage}`,
  ].filter(Boolean).join(' ')

  return (
    <div className={wrapperClassName}>
      <div ref={hostRef} className="regime-vol__lwc-canvas" />

      {rangeBounds ? (
        <MiniChartTimeAxis
          bounds={rangeBounds}
          viewportBounds={viewportBounds ?? rangeBounds}
          className={[
            'regime-mini-time-axis regime-mini-time-axis--overlay',
            mode === 'vrp_z' && 'regime-mini-time-axis--native-right',
          ].filter(Boolean).join(' ')}
        />
      ) : null}

      {separatorTop != null ? (
        <div
          className="regime-vol__pane-sep"
          aria-hidden
          style={{ top: separatorTop }}
        />
      ) : null}

      <div className="regime-vol__fixed-axis-labels" aria-hidden>
        {fixedAxisLabels.map((label) => (
          <span
            key={label.id}
            className={`regime-vol__fixed-axis-label regime-vol__fixed-axis-label--${label.side}`}
            style={{ top: label.top }}
          >
            {label.text}
          </span>
        ))}
      </div>

      <div className="regime-vol__hover-labels" aria-hidden>
        {crosshairLabels.map((label) => (
          <Fragment key={label.kind}>
            <span
              className={[
                'regime-vol__hover-point',
                `regime-vol__hover-label--${label.kind}`,
                label.tone === 'pos' ? 'regime-vol__hover-label--pos' : null,
                label.tone === 'neg' ? 'regime-vol__hover-label--neg' : null,
                label.regime ? `regime-vol__hover-label--${label.regime}` : null,
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ top: label.pointTop, left: label.pointLeft }}
            />
            <span
              className={[
                'regime-vol__hover-label',
                `regime-vol__hover-label--${label.kind}`,
                label.tone === 'pos' ? 'regime-vol__hover-label--pos' : null,
                label.tone === 'neg' ? 'regime-vol__hover-label--neg' : null,
                label.regime ? `regime-vol__hover-label--${label.regime}` : null,
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ top: label.top, left: label.left }}
            >
              <span className="regime-vol__hover-value">{label.text}</span>
              {label.detail ? (
                <span className="regime-vol__hover-detail">{label.detail}</span>
              ) : null}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

/* ── series factory ───────────────────────────────────────────────────────── */

function createModeSeries(
  chart: IChartApi,
  mode: VolChartMode,
  colors: VolChartColors,
): ChartHandle {
  const axisSteps = {
    right: { current: mode === 'vrp' ? 1 : 0.5 },
    left: { current: 800 },
    spread: { current: 1 },
  }
  const rightPriceFloor = mode === 'dvol' || mode === 'vrp'
    ? ONE_DAY_VOL_AXIS_FLOOR
    : 0.5
  const rightPriceFormat = mode === 'vrp'
    ? createDynamicMiniChartPriceFormat(axisSteps.right, formatSignedAxis, rightPriceFloor)
    : createDynamicMiniChartPriceFormat(axisSteps.right, formatVolAxis, rightPriceFloor)
  const leftPriceFormat = createDynamicMiniChartPriceFormat(
    axisSteps.left,
    (price) => formatBtcAxis(price),
    BTC_PAIRED_AXIS_FLOOR,
  )
  const rangeAnchor = chart.addSeries(LineSeries, {
    priceScaleId: 'range-anchor',
    color: 'rgba(0, 0, 0, 0)',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    ...(mode === 'vrp_z' ? { priceFormat: zPriceFormat } : {}),
  })
  const base: ChartHandle = {
    chart,
    mode,
    colors,
    dvol: null,
    rv: null,
    price: null,
    spread: null,
    ribbon: null,
    zHistogram: null,
    rangeAnchor,
    priceLines: [],
    priceVisible: false,
    priceAnimationFrame: 0,
    priceAnimationStrength: 0,
    priceStage: 'hidden',
    lastPriceData: [],
    axisSteps,
  }

  if (mode === 'dvol' || mode === 'iv_rv') {
    base.dvol = chart.addSeries(
      LineSeries,
      {
        color: colors.iv,
        lineWidth: 1,
        lineType: LineType.Simple,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        crosshairMarkerBorderColor: colors.iv,
        crosshairMarkerBackgroundColor: colors.iv,
        priceFormat: rightPriceFormat,
      },
      0,
    )
    base.price = chart.addSeries(
      LineSeries,
      {
        color: colors.spot,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        lineType: LineType.Simple,
        priceScaleId: BTC_PRICE_SCALE_ID,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        crosshairMarkerBorderColor: colors.spot,
        crosshairMarkerBackgroundColor: colors.spot,
        priceFormat: leftPriceFormat,
        visible: false,
      },
      0,
    )
    try {
      chart.priceScale(BTC_PRICE_SCALE_ID, 0).applyOptions({
        autoScale: true,
        borderVisible: false,
        scaleMargins: { top: 0.18, bottom: 0.18 },
        entireTextOnly: true,
        textColor: 'rgba(0, 0, 0, 0)',
      })
    } catch {
      // The left scale can settle on the following data frame.
    }
    if (mode === 'dvol') return base

    base.rv = chart.addSeries(
      LineSeries,
      {
        color: colors.rv,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lineType: LineType.Simple,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        crosshairMarkerBorderColor: colors.rv,
        crosshairMarkerBackgroundColor: colors.rv,
        priceFormat: rightPriceFormat,
        visible: false,
      },
      0,
    )
    return base
  }

  if (mode === 'vrp_z') {
    base.zHistogram = chart.addSeries(HistogramSeries, {
      color: colors.zPosLine,
      base: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: zPriceFormat,
      autoscaleInfoProvider: zAutoscaleInfoProvider,
    })
  } else {
    // VRP retains its continuous premium ribbon through zero.
    base.ribbon = chart.addSeries(BaselineSeries, {
    baseValue: { type: 'price', price: 0 },
    topLineColor: colors.ribbonPosLine,
    topFillColor1: colors.ribbonPosFill1,
    topFillColor2: colors.ribbonPosFill2,
    bottomLineColor: colors.ribbonNegLine,
    bottomFillColor1: colors.ribbonNegFill1,
    bottomFillColor2: colors.ribbonNegFill2,
    lineWidth: 1,
    lineType: LineType.Simple,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    priceFormat: rightPriceFormat,
    })
  }

  try {
    chart.priceScale('right').applyOptions({
      borderVisible: false,
      scaleMargins: { top: 0.1, bottom: 0.1 },
      entireTextOnly: true,
      ticksVisible: true,
    })
  } catch {
    // ignore
  }
  return base
}

function applyThemeColors(handle: ChartHandle) {
  const c = handle.colors
  try {
    handle.dvol?.applyOptions({
      color: c.iv,
      crosshairMarkerBorderColor: c.iv,
      crosshairMarkerBackgroundColor: c.iv,
    })
    handle.rv?.applyOptions({
      color: c.rv,
      crosshairMarkerBorderColor: c.rv,
      crosshairMarkerBackgroundColor: c.rv,
    })
    handle.price?.applyOptions({
      color: c.spot,
      crosshairMarkerBorderColor: c.spot,
      crosshairMarkerBackgroundColor: c.spot,
    })
    handle.spread?.applyOptions({
      topLineColor: c.spreadPosLine,
      topFillColor1: c.spreadPosFill1,
      topFillColor2: c.spreadPosFill2,
      bottomLineColor: c.spreadNegLine,
      bottomFillColor1: c.spreadNegFill1,
      bottomFillColor2: c.spreadNegFill2,
    })
    if (handle.mode === 'vrp') {
      handle.ribbon?.applyOptions({
        topLineColor: c.ribbonPosLine,
        topFillColor1: c.ribbonPosFill1,
        topFillColor2: c.ribbonPosFill2,
        bottomLineColor: c.ribbonNegLine,
        bottomFillColor1: c.ribbonNegFill1,
        bottomFillColor2: c.ribbonNegFill2,
      })
    }
    if (handle.mode === 'vrp_z') {
      handle.zHistogram?.applyOptions({ color: c.zPosLine })
    }
  } catch {
    // ignore
  }
}

/**
 * Guides — dim zero on all modes; Z also has explicit ±1 / ±2 / ±3 bands.
 */
function ensureRibbonGuides(handle: ChartHandle) {
  const series = handle.mode === 'vrp_z' ? handle.zHistogram : handle.ribbon
  if (!series || handle.priceLines.length > 0) return
  try {
    const isZ = handle.mode === 'vrp_z'
    const c = handle.colors
    handle.priceLines.push(
      series.createPriceLine({
        price: 0,
        color: isZ ? c.zZero : c.zero,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: '',
      }),
    )
    if (isZ) {
      for (const price of [Z_ELEVATED_THRESHOLD, -Z_ELEVATED_THRESHOLD]) {
        handle.priceLines.push(
          series.createPriceLine({
            price,
            color: c.bandOuter,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
            title: '',
          }),
        )
      }
      for (const price of [Z_EXTREME_THRESHOLD, -Z_EXTREME_THRESHOLD]) {
        handle.priceLines.push(
          series.createPriceLine({
            price,
            color: c.bandInner,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
            title: '',
          }),
        )
      }
      for (const price of [Z_EXCEPTIONAL_THRESHOLD, -Z_EXCEPTIONAL_THRESHOLD]) {
        handle.priceLines.push(
          series.createPriceLine({
            price,
            color: c.bandOuter,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: false,
            title: '',
          }),
        )
      }
    }
  } catch {
    // optional
  }
}

/* ── series apply ─────────────────────────────────────────────────────────── */

function applySeries(
  handle: ChartHandle,
  props: SeriesProps,
  options?: { fit?: boolean },
) {
  const { chart } = handle
  const timeScale = chart.timeScale()
  const savedLogical = options?.fit ? null : captureLogicalRange(timeScale)
  const c = handle.colors
  const rangeGroups = props.mode === 'dvol'
    ? [props.dvolSeries]
    : props.mode === 'iv_rv'
      ? [props.dvolSeries, props.rvSeries, props.spreadSeries]
    : props.mode === 'vrp'
      ? [props.vrpSeries]
      : [props.vrpZSeries]
  const rangeBounds = resolveMiniChartRangeBounds(props.range, rangeGroups)
  const rangeGrid = rangeBounds
    ? buildVolTimeGrid(padVolChartRangeBounds(rangeBounds, props.mode))
    : []
  const firstGridTime = rangeGrid[0]
  const lastGridTime = rangeGrid[rangeGrid.length - 1]
  handle.rangeAnchor.setData(
    firstGridTime == null
      ? []
      : lastGridTime == null || lastGridTime === firstGridTime
        ? [{ time: firstGridTime }]
        : [{ time: firstGridTime }, { time: lastGridTime }],
  )

  let domainPoints: { time: Time; value: number }[] = []

  if (props.mode === 'dvol' || props.mode === 'iv_rv') {
    const dvolData = toLineData(props.dvolSeries, rangeBounds, rangeGrid)
    const rvData = props.mode === 'iv_rv' && props.showRv
      ? toLineData(props.rvSeries, rangeBounds, rangeGrid)
      : []
    handle.axisSteps.right.current = resolveMiniChartAxisStep(
      [...dvolData, ...rvData].map((point) => point.value),
      props.mode === 'dvol' && props.range === '1d'
        ? ONE_DAY_VOL_AXIS_FLOOR
        : props.mode === 'dvol' ? 1 : 0.5,
      5,
    )
    domainPoints = [...dvolData, ...rvData].sort((a,b)=>Number(a.time)-Number(b.time))
    handle.dvol?.setData(withLineGaps(dvolData))
    handle.dvol?.applyOptions({ pointMarkersVisible:dvolData.length===1, pointMarkersRadius:3 })

    const priceData = toLineData(props.priceSeries, rangeBounds, rangeGrid)
    handle.axisSteps.left.current = resolveMiniChartAxisStep(
      priceData.map((point) => point.value),
      props.range === '1d' ? BTC_PAIRED_AXIS_FLOOR : 800,
      props.range === '1d' ? PAIRED_AXIS_INTERVALS : 5,
    )
    const pairedAxisRanges = props.showPrice
      ? resolvePairedAxisRanges(
          [...dvolData, ...rvData].map((point) => point.value),
          priceData.map((point) => point.value),
        )
      : null
    if (pairedAxisRanges) {
      handle.axisSteps.right.current = pairedAxisRanges.vol.step
      handle.axisSteps.left.current = pairedAxisRanges.price.step
    }
    applyVolAxisRange(handle, pairedAxisRanges?.vol ?? null)
    transitionPriceSeries(
      handle,
      priceData,
      props.showPrice && priceData.length > 0,
      pairedAxisRanges?.price ?? null,
    )

    if (props.mode === 'iv_rv') {
      handle.rv?.setData(withLineGaps(rvData))
      handle.rv?.applyOptions({ visible: props.showRv && rvData.length > 0 })

      if (props.showSpread) {
        if (!handle.spread) {
          const spread = chart.addSeries(
            BaselineSeries,
            {
              baseValue: { type: 'price', price: 0 },
              topLineColor: c.spreadPosLine,
              topFillColor1: c.spreadPosFill1,
              topFillColor2: c.spreadPosFill2,
              bottomLineColor: c.spreadNegLine,
              bottomFillColor1: c.spreadNegFill1,
              bottomFillColor2: c.spreadNegFill2,
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
              crosshairMarkerVisible: false,
              priceFormat: createDynamicMiniChartPriceFormat(
                handle.axisSteps.spread,
                formatSignedAxis,
                1,
              ),
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
                scaleMargins: { top: 0.18, bottom: 0.16 },
                entireTextOnly: true,
                textColor: 'rgba(0, 0, 0, 0)',
                ticksVisible: false,
              })
            } catch {
              // ignore
            }
          }
        } else {
          const panes = chart.panes()
          if (panes[0]) panes[0].setStretchFactor(VOL_STRETCH)
          if (panes[1]) panes[1].setStretchFactor(SPREAD_STRETCH)
          handle.spread.applyOptions({
            topLineColor: c.spreadPosLine,
            topFillColor1: c.spreadPosFill1,
            topFillColor2: c.spreadPosFill2,
            bottomLineColor: c.spreadNegLine,
            bottomFillColor1: c.spreadNegFill1,
            bottomFillColor2: c.spreadNegFill2,
          })
        }
        const spreadData = toLineData(props.spreadSeries, rangeBounds, rangeGrid)
        handle.axisSteps.spread.current = resolveMiniChartAxisStep(
          spreadData.map((point) => point.value),
          1,
          5,
        )
        handle.spread.setData(withLineGaps(spreadData))
        try {
          const spreadScale = chart.panes()[1]?.priceScale('right')
          spreadScale?.setAutoScale(true)
          spreadScale?.applyOptions({
            scaleMargins: { top: 0.18, bottom: 0.16 },
          })
        } catch {
          // The spread pane can be between creation and its first layout pass.
        }
      } else if (handle.spread) {
        chart.removeSeries(handle.spread)
        handle.spread = null
        const panes = chart.panes()
        if (panes[0]) panes[0].setStretchFactor(1)
      }
    }
  } else if (props.mode === 'vrp' || props.mode === 'vrp_z') {
    const raw = props.mode === 'vrp' ? props.vrpSeries : props.vrpZSeries
    const data = toLineData(raw, rangeBounds, rangeGrid)
    domainPoints = data
    if (props.mode === 'vrp') {
      if (!handle.ribbon) throw new Error('ribbon series missing for VRP mode')
      handle.axisSteps.right.current = resolveMiniChartAxisStep(
        data.map((point) => point.value),
        props.range === '1d' ? ONE_DAY_VOL_AXIS_FLOOR : 1,
        isLongVrpRange(props.range) ? LONG_RANGE_VRP_AXIS_INTERVALS : 5,
      )
      handle.ribbon.setData(withLineGaps(data))
    } else {
      if (!handle.zHistogram) throw new Error('histogram series missing for Z-score mode')
      handle.zHistogram.setData(data.map((point) => ({
        ...point,
        color: zHistogramBarColor(point.value, c),
      })))
    }
    if (data.length > 0) ensureRibbonGuides(handle)
  }

  if (domainPoints.length === 0) return

  const timesSec = domainPoints
    .map((p) => (typeof p.time === 'number' ? p.time : NaN))
    .filter((t) => Number.isFinite(t) && t > 0)
  const first = timesSec[0] ?? 0
  const last = timesSec[timesSec.length - 1] ?? 0
  const prev = handle.lastDomain
  const domainExpanded =
    prev != null
    && (
      (first > 0 && prev.fromSec > 0 && first < prev.fromSec - 12 * 3600)
      || domainPoints.length > Math.max(8, Math.floor(prev.n * 1.4))
    )
  handle.lastDomain = { fromSec: first, toSec: last, n: domainPoints.length }
  handle.lastTimesSec = timesSec

  // If a prior failed fit left us on a near-full-book range, force desk default.
  const stuckFullBook =
    savedLogical != null
    && timesSec.length > 40
    && (savedLogical.to - savedLogical.from) > timesSec.length * 0.8

  if (options?.fit || !savedLogical || domainExpanded || stuckFullBook) {
    // Apply now + once next frame so logical indices settle after setData.
    // Safe to re-apply: pure index math is idempotent (no pad accumulation).
    applyDefaultTimeView(timeScale, props.mode, timesSec, props.range)
    requestAnimationFrame(() => {
      applyDefaultTimeView(timeScale, props.mode, timesSec, props.range)
    })
    return
  }
  try {
    timeScale.setVisibleLogicalRange(savedLogical)
  } catch {
    applyDefaultTimeView(timeScale, props.mode, timesSec, props.range)
  }
}

/**
 * Native LWC tick placement can drift away from a custom minMove after a live
 * mode change. These labels use the actual series coordinate transforms, so
 * BTC and comparison-vol scales stay deterministic at every panel height.
 */
function buildFixedAxisLabels(
  handle: ChartHandle,
  props: SeriesProps,
): FixedAxisLabel[] {
  if (props.mode === 'vrp_z') {
    if (!handle.zHistogram) return []
    const paneHeight = Math.max(1, handle.chart.panes()[0]?.getHeight() ?? 1)
    return [-2, 0, 2].flatMap((value) => {
      const coordinate = handle.zHistogram?.priceToCoordinate(value)
      if (coordinate == null || !Number.isFinite(coordinate)) return []
      if (coordinate < 7 || coordinate > paneHeight - 7) return []
      return [{
        id: `z-right-${value}`,
        side: 'right' as const,
        text: value === 0 ? '0' : `${value > 0 ? '+' : '−'}${Math.abs(value)}`,
        top: coordinate,
      }]
    })
  }

  if (props.mode === 'vrp') {
    if (!handle.ribbon) return []
    const bounds = resolveMiniChartRangeBounds(props.range, [props.vrpSeries])
    const grid = bounds
      ? buildVolTimeGrid(padVolChartRangeBounds(bounds, props.mode))
      : []
    const data = toLineData(props.vrpSeries, bounds, grid)
    const step = handle.axisSteps.right.current
    const paneHeight = Math.max(1, handle.chart.panes()[0]?.getHeight() ?? 1)
    return axisLabelsForSeries(
      handle.ribbon,
      data.map((point) => point.value),
      step,
      'right',
      paneHeight,
      (value) => formatSignedAxis(value, step),
      true,
      0,
      'vrp',
    )
  }

  if (props.mode !== 'dvol' && props.mode !== 'iv_rv') return []

  const rangeGroups = props.mode === 'dvol'
    ? [props.dvolSeries]
    : [props.dvolSeries, props.rvSeries, props.spreadSeries]
  const bounds = resolveMiniChartRangeBounds(props.range, rangeGroups)
  const grid = bounds ? buildVolTimeGrid(padMiniChartRangeBounds(bounds)) : []
  const dvolData = toLineData(props.dvolSeries, bounds, grid)
  const rvData = props.mode === 'iv_rv' && props.showRv
    ? toLineData(props.rvSeries, bounds, grid)
    : []
  const priceData = toLineData(props.priceSeries, bounds, grid)
  const priceValues = priceData.map((point) => point.value)
  const pairedAxisRanges = props.showPrice
    ? resolvePairedAxisRanges(
        [...dvolData, ...rvData].map((point) => point.value),
        priceValues,
      )
    : null
  const paneHeight = Math.max(1, handle.chart.panes()[0]?.getHeight() ?? 1)
  const labels: FixedAxisLabel[] = []

  if (handle.dvol) {
    const rightStep = pairedAxisRanges?.vol.step ?? handle.axisSteps.right.current
    const rawRightValues = pairedAxisRanges
      ? [pairedAxisRanges.vol.from, pairedAxisRanges.vol.to]
      : [...dvolData, ...rvData].map((point) => point.value)
    const rightValues = props.mode === 'dvol' && props.range === '1m' && !pairedAxisRanges
      ? extendAxisValuesToUpperTick(rawRightValues, rightStep)
      : rawRightValues
    labels.push(...axisLabelsForSeries(
      handle.dvol,
      rightValues,
      rightStep,
      'right',
      paneHeight,
      (value) => formatVolAxis(value, rightStep),
      props.mode === 'iv_rv' || props.range === '1d',
      0,
      'vol',
    ))
  }

  if (handle.priceVisible && handle.price) {
    const leftStep = pairedAxisRanges?.price.step ?? handle.axisSteps.left.current
    labels.push(...axisLabelsForSeries(
      handle.price,
      pairedAxisRanges
        ? [pairedAxisRanges.price.from, pairedAxisRanges.price.to]
        : priceValues,
      leftStep,
      'left',
      paneHeight,
      formatBtcAxis,
      true,
      0,
      'btc',
    ))
  }

  return labels
}

function extendAxisValuesToUpperTick(
  values: readonly number[],
  step: number,
): number[] {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0 || !Number.isFinite(step) || step <= 0) return [...values]
  const max = Math.max(...finite)
  const upperTick = Math.ceil((max - step * 1e-6) / step) * step
  return upperTick > max ? [...values, Number(upperTick.toFixed(8))] : [...values]
}

function axisLabelsForSeries(
  series: ISeriesApi<'Line'> | ISeriesApi<'Baseline'>,
  values: readonly number[],
  step: number,
  side: FixedAxisLabel['side'],
  paneHeight: number,
  formatter: (value: number) => string,
  includeOuterTicks: boolean,
  topOffset: number,
  idPrefix: string,
): FixedAxisLabel[] {
  const ticks = buildAxisTickValues(values, step, includeOuterTicks)
  const labels = ticks.flatMap((value) => {
    const coordinate = series.priceToCoordinate(value)
    if (coordinate == null || !Number.isFinite(coordinate)) return []
    if (coordinate < 7 || coordinate > paneHeight - 7) return []
    return [{
      id: `${idPrefix}-${side}-${value}`,
      side,
      text: formatter(value),
      top: coordinate + topOffset,
    } satisfies FixedAxisLabel]
  })
  labels.sort((a, b) => a.top - b.top)
  return labels.filter((label, index) => (
    index === 0 || label.top - labels[index - 1]!.top >= 15
  ))
}

function buildAxisTickValues(
  values: readonly number[],
  step: number,
  includeOuterTicks: boolean,
): number[] {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0 || !Number.isFinite(step) || step <= 0) return []
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  const epsilon = step * 1e-6
  const strictStart = Math.ceil((min - epsilon) / step) * step
  const strictEnd = Math.floor((max + epsilon) / step) * step
  const strictCount = Math.max(0, Math.floor((strictEnd - strictStart) / step) + 1)
  const expand = includeOuterTicks && strictCount < 4
  const start = expand ? Math.floor((min + epsilon) / step) * step : strictStart
  const end = expand ? Math.ceil((max - epsilon) / step) * step : strictEnd
  const ticks: number[] = []
  for (let value = start; value <= end + epsilon && ticks.length < 12; value += step) {
    ticks.push(Number(value.toFixed(8)))
  }
  return ticks
}

function transitionPriceSeries(
  handle: ChartHandle,
  nextData: PlotPoint[],
  shouldShow: boolean,
  visibleRange: NumericAxisRange | null,
) {
  const series = handle.price
  if (!series) return
  if (handle.priceAnimationFrame) {
    cancelAnimationFrame(handle.priceAnimationFrame)
    handle.priceAnimationFrame = 0
  }

  if (shouldShow) {
    handle.lastPriceData = nextData
    setPriceScaleRange(handle, nextData, visibleRange)
    series.applyOptions({ visible: true })
    if (handle.priceVisible && handle.priceAnimationStrength >= 0.999) {
      series.setData(nextData)
      setPriceStage(handle, 'visible')
      return
    }
    handle.priceVisible = true
    setPriceStage(handle, 'entering')
    animatePriceShape(handle, nextData, 1)
    return
  }

  if (!handle.priceVisible) {
    series.setData([])
    series.applyOptions({ visible: false })
    handle.priceAnimationStrength = 0
    setPriceStage(handle, 'hidden')
    return
  }
  const current = handle.lastPriceData
  if (current.length === 0) {
    series.setData([])
    series.applyOptions({ visible: false })
    handle.priceVisible = false
    handle.priceAnimationStrength = 0
    resetPriceScale(handle)
    setPriceStage(handle, 'hidden')
    return
  }
  setPriceStage(handle, 'leaving')
  animatePriceShape(handle, current, 0)
}

function animatePriceShape(
  handle: ChartHandle,
  data: PlotPoint[],
  targetStrength: 0 | 1,
) {
  const series = handle.price
  if (!series || data.length === 0) return
  const baseline = data.reduce((sum, point) => sum + point.value, 0) / data.length
  const startStrength = handle.priceAnimationStrength
  const distance = Math.abs(targetStrength - startStrength)
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const durationMs = reduceMotion ? 0 : Math.max(90, 210 * distance)
  const startedAt = performance.now()

  const paint = (now: number) => {
    const raw = durationMs === 0 ? 1 : Math.min(1, Math.max(0, (now - startedAt) / durationMs))
    const eased = raw * raw * (3 - 2 * raw)
    const strength = startStrength + (targetStrength - startStrength) * eased
    handle.priceAnimationStrength = strength
    series.setData(data.map((point) => ({
      time: point.time,
      value: baseline + (point.value - baseline) * strength,
    })))
    if (raw < 1) {
      handle.priceAnimationFrame = requestAnimationFrame(paint)
      return
    }
    handle.priceAnimationFrame = 0
    handle.priceAnimationStrength = targetStrength
    if (targetStrength === 1) {
      series.setData(data)
      setPriceStage(handle, 'visible')
    } else {
      series.setData([])
      series.applyOptions({ visible: false })
      handle.priceVisible = false
      resetPriceScale(handle)
      setPriceStage(handle, 'hidden')
    }
  }

  series.setData(data.map((point) => ({
    time: point.time,
    value: baseline + (point.value - baseline) * startStrength,
  })))
  handle.priceAnimationFrame = requestAnimationFrame(paint)
}

function setPriceScaleRange(
  handle: ChartHandle,
  data: PlotPoint[],
  visibleRange: NumericAxisRange | null,
) {
  const values = data.map((point) => point.value).filter(Number.isFinite)
  if (values.length === 0) return
  const min = Math.min(...values)
  const max = Math.max(...values)
  const padding = Math.max(200, (max - min) * 0.1)
  try {
    const scale = handle.chart.priceScale(BTC_PRICE_SCALE_ID, 0)
    scale.setVisibleRange({
      from: visibleRange?.from ?? min - padding,
      to: visibleRange?.to ?? max + padding,
    })
    scale.applyOptions({
      borderVisible: false,
      scaleMargins: visibleRange
        ? PAIRED_AXIS_MARGINS
        : { top: 0.18, bottom: 0.18 },
      entireTextOnly: true,
      textColor: 'rgba(0, 0, 0, 0)',
    })
  } catch {
    // The overlay scale can be between pane rebuild frames during a mode switch.
  }
}

function applyVolAxisRange(
  handle: ChartHandle,
  visibleRange: NumericAxisRange | null,
) {
  try {
    const scale = handle.chart.priceScale('right', 0)
    if (visibleRange) {
      scale.setVisibleRange(visibleRange)
      scale.applyOptions({
        scaleMargins: PAIRED_AXIS_MARGINS,
      })
      return
    }
    scale.setAutoScale(true)
    scale.applyOptions({ scaleMargins: { top: 0.15, bottom: 0.14 } })
  } catch {
    // The right scale can be between data and pane updates during a mode switch.
  }
}

function resolvePairedAxisRanges(
  volValues: readonly number[],
  priceValues: readonly number[],
): PairedAxisRanges | null {
  const finiteVol = volValues.filter(Number.isFinite)
  const finitePrice = priceValues.filter(Number.isFinite)
  if (finiteVol.length === 0 || finitePrice.length === 0) return null
  return {
    price: resolveIndependentPairedRange(
      finitePrice,
      BTC_PAIRED_AXIS_FLOOR,
      PAIRED_AXIS_INTERVALS,
    ),
    vol: resolveIndependentPairedRange(
      finiteVol,
      VOL_PAIRED_AXIS_FLOOR,
      PAIRED_AXIS_INTERVALS,
    ),
  }
}

function resolveIndependentPairedRange(
  values: readonly number[],
  floorStep: number,
  intervalCount: number,
): NumericAxisRange {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(floorStep, max - min)
  const paddedSpan = span * (1 + PAIRED_AXIS_PADDING_RATIO * 2)
  const step = niceAxisStep(paddedSpan / intervalCount, floorStep)
  const width = step * intervalCount
  const minimumStart = Math.ceil(((max - width) / step) - 1e-8) * step
  const maximumStart = Math.floor((min / step) + 1e-8) * step
  const centeredStart = Math.round((((min + max - width) / 2) / step)) * step
  const from = Math.min(maximumStart, Math.max(minimumStart, centeredStart))
  return {
    from: Number(from.toFixed(8)),
    to: Number((from + width).toFixed(8)),
    step,
  }
}

function niceAxisStep(rawStep: number, floorStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return floorStep
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalized = rawStep / magnitude
  const mantissas = [1, 1.25, 1.5, 2, 2.5, 4, 5, 8, 10]
  const mantissa = mantissas.find((candidate) => candidate >= normalized) ?? 10
  return Math.max(floorStep, mantissa * magnitude)
}

function resetPriceScale(handle: ChartHandle) {
  try {
    handle.chart.priceScale(BTC_PRICE_SCALE_ID, 0).setAutoScale(true)
  } catch {
    // The chart may have unmounted on the final collapse frame.
  }
}

function setPriceStage(handle: ChartHandle, stage: PriceOverlayStage) {
  if (handle.priceStage === stage) return
  handle.priceStage = stage
  handle.onPriceStageChange?.(stage)
}

/**
 * Default viewport — idempotent. Same double-click always lands on the same range.
 *
 *   iv_rv / vrp — last ~7d → latest + right air  (desk reference shot)
 *   vrp_z       — last ~45d → latest + right air (daily bars)
 *
 * Pure logical indices: from = first bar ≥ lookback start, to = lastIdx + pad.
 * Never call fitContent (full 365d book) and never add pad onto the *current*
 * visible range (that was accumulating on each double-click).
 */
function applyDefaultTimeView(
  timeScale: ITimeScaleApi<Time>,
  mode: VolChartMode,
  timesSec: number[],
  range: MiniChartRange,
) {
  if (timesSec.length === 0) return

  const dataFrom = timesSec[0]!
  const dataTo = timesSec[timesSec.length - 1]!
  const lastIdx = timesSec.length - 1

  void mode
  const lookbackSec = MINI_CHART_RANGE_LOOKBACK_SECONDS[range]
  const targetFromSec = lookbackSec == null ? dataFrom : dataTo - lookbackSec
  const visibleSpanSec = Math.max(1, dataTo - targetFromSec)
  const leftPadSec = Math.max(
    medianBarIntervalSec(timesSec),
    Math.round(visibleSpanSec * MINI_CHART_LEFT_AIR_FRACTION),
  )
  const rightAirFraction = mode === 'vrp'
    ? MINI_CHART_LEFT_AIR_FRACTION
    : mode === 'vrp_z'
      ? Z_RIGHT_AIR_FRACTION
    : MINI_CHART_RIGHT_AIR_FRACTION
  const rightPadSec = mode === 'vrp'
    ? leftPadSec
    : Math.round(visibleSpanSec * rightAirFraction)

  let fromIdx = indexAtOrAfter(timesSec, targetFromSec)
  if (fromIdx < 0 || fromIdx >= lastIdx) {
    // Preferred start past / at end of data — short recent window.
    fromIdx = Math.max(0, lastIdx - Math.min(48, lastIdx))
  }

  const visibleBars = Math.max(1, lastIdx - fromIdx + 1)
  const padBars = padBarsForSeries(timesSec, visibleBars, rightAirFraction)

  try {
    timeScale.applyOptions({
      rightOffset: 0,
      fixRightEdge: false,
      fixLeftEdge: false,
    } as DeepPartialTimeScale)
    timeScale.setVisibleRange({
      from: (targetFromSec - leftPadSec) as UTCTimestamp,
      to: (dataTo + rightPadSec) as UTCTimestamp,
    })
  } catch {
    try {
      timeScale.setVisibleLogicalRange({
        from: mode === 'vrp' ? fromIdx - padBars : fromIdx,
        to: lastIdx + padBars,
      })
    } catch {
      // Avoid fitContent (full book).
    }
  }
}

/**
 * First index with timesSec[i] >= targetSec, or 0 if all are later / empty.
 * Returns -1 only when the array is empty (caller already guards).
 */
function indexAtOrAfter(timesSec: number[], targetSec: number): number {
  if (timesSec.length === 0) return -1
  // Linear scan is fine — series are a few thousand points max.
  for (let i = 0; i < timesSec.length; i++) {
    if (timesSec[i]! >= targetSec) return i
  }
  return timesSec.length - 1
}

/**
 * Logical fallback for the shared right-air fraction. The normal path uses
 * elapsed time so sparse and dense series retain the same visual spacing.
 */
function padBarsForSeries(
  timesSec: number[],
  visibleBars = 0,
  rightAirFraction = MINI_CHART_RIGHT_AIR_FRACTION,
): number {
  void timesSec
  return Math.max(1, Math.round(visibleBars * rightAirFraction))
}

/** Cast helper — createChart typings expose HorzScaleOptions; formatter lives on TimeScaleOptions. */
type DeepPartialTimeScale = Partial<TimeScaleOptions>

const VOL_CROSSHAIR_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: VOL_CHART_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

type VolBusinessDay = { year: number; month: number; day: number }

function formatVolCrosshairTime(time: Time): string {
  const businessDay = timeToBusinessDay(time)
  if (businessDay) {
    const midday = Date.UTC(businessDay.year, businessDay.month - 1, businessDay.day, 12)
    return formatCrosshairDateTime(new Date(midday), false)
  }
  const ms = timeToEpochMs(time)
  return ms == null ? '' : formatCrosshairDateTime(new Date(ms), true)
}

function formatCrosshairDateTime(date: Date, includeTime: boolean): string {
  const parts: Record<string, string> = {}
  for (const part of VOL_CROSSHAIR_FORMATTER.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  const dateText = `${parts.weekday ?? ''} ${parts.day ?? ''} ${parts.month ?? ''} '${parts.year ?? ''}`
  return includeTime
    ? `${dateText}  ${parts.hour ?? '00'}:${parts.minute ?? '00'}`
    : dateText
}

function timeToBusinessDay(time: Time): VolBusinessDay | null {
  if (time && typeof time === 'object' && 'year' in time) {
    const bd = time as VolBusinessDay
    return {
      year: Number(bd.year),
      month: Number(bd.month),
      day: Number(bd.day),
    }
  }
  return null
}

function timeToEpochMs(time: Time): number | null {
  if (typeof time === 'number' && Number.isFinite(time)) {
    // UTCTimestamp is seconds
    return time * 1000
  }
  if (typeof time === 'string') {
    const t = Date.parse(time)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** Median step between consecutive sample times (seconds). */
function medianBarIntervalSec(timesSec: number[]): number {
  if (timesSec.length < 2) return 3600
  const steps: number[] = []
  for (let i = 1; i < timesSec.length; i++) {
    const d = timesSec[i]! - timesSec[i - 1]!
    if (d > 0 && Number.isFinite(d)) steps.push(d)
  }
  if (steps.length === 0) return 3600
  steps.sort((a, b) => a - b)
  return steps[Math.floor(steps.length / 2)]! || 3600
}

function captureLogicalRange(timeScale: ITimeScaleApi<Time>): LogicalRange | null {
  try {
    const range = timeScale.getVisibleLogicalRange()
    if (
      range == null
      || !Number.isFinite(range.from)
      || !Number.isFinite(range.to)
      || range.to <= range.from
    ) {
      return null
    }
    return { from: range.from, to: range.to }
  } catch {
    return null
  }
}

function computeSeparatorTop(handle: ChartHandle, props: SeriesProps): number | null {
  if (props.mode !== 'iv_rv' || !props.showSpread || !handle.spread) return null
  try {
    const h = handle.chart.panes()[0]?.getHeight()
    return typeof h === 'number' && Number.isFinite(h) ? h : null
  } catch {
    return null
  }
}

function readSeriesValue(
  series: ISeriesApi<'Line'> | ISeriesApi<'Baseline'> | ISeriesApi<'Histogram'>,
  param: MouseEventParams,
): number | null {
  const raw = param.seriesData.get(series)
  if (!raw || typeof raw !== 'object') return null
  const value = (raw as { value?: number; close?: number }).value
    ?? (raw as { close?: number }).close
  return value != null && Number.isFinite(value) ? value : null
}

function interpolateSeriesValue(
  series: readonly VolSeriesPoint[],
  targetMs: number | null,
): number | null {
  if (targetMs == null || series.length === 0) return null
  const pointMs = (point: VolSeriesPoint | undefined) => {
    const ts = point?.tsMs
    if (!Number.isFinite(ts)) return Number.NaN
    return ts! > 1e12 ? ts! : ts! * 1000
  }
  const firstMs = pointMs(series[0])
  const lastMs = pointMs(series[series.length - 1])
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || targetMs < firstMs || targetMs > lastMs) {
    return null
  }

  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (pointMs(series[mid]) < targetMs) lo = mid + 1
    else hi = mid
  }
  const right = series[lo]
  if (!right || !Number.isFinite(right.value)) return null
  const rightMs = pointMs(right)
  if (lo === 0 || rightMs === targetMs) return right.value
  if (right.gapBefore) return null
  const left = series[lo - 1]
  if (!left || !Number.isFinite(left.value)) return null
  const leftMs = pointMs(left)
  const spanMs = rightMs - leftMs
  if (!(spanMs > 0)) return right.value
  const mix = Math.max(0, Math.min(1, (targetMs - leftMs) / spanMs))
  return left.value + (right.value - left.value) * mix
}

function measure(el: HTMLElement): { w: number; h: number } {
  const rect = el.getBoundingClientRect()
  const w = Math.max(2, Math.floor(el.clientWidth || rect.width || 2))
  const h = Math.max(2, Math.floor(el.clientHeight || rect.height || 2))
  return { w, h }
}

/* ── formats ──────────────────────────────────────────────────────────────── */

function formatVolAxis(price: number, step: number): string {
  if (!Number.isFinite(price)) return ''
  return `${price.toFixed(axisDecimals(step))}%`
}

function formatSignedAxis(price: number, step: number): string {
  if (!Number.isFinite(price)) return ''
  if (Math.abs(price) < step * 0.05) return '0'
  const sign = price > 0 ? '+' : '−'
  return `${sign}${Math.abs(price).toFixed(axisDecimals(step))}`
}

function axisDecimals(step: number): number {
  return step < 1 || Math.abs(step - Math.round(step)) > 1e-6 ? 1 : 0
}

/** Whole-sigma ticks; autoscale has a ±3 floor and can expose larger outliers. */
const zPriceFormat = {
  type: 'custom' as const,
  minMove: 1,
  formatter: (price: number) => {
    if (!Number.isFinite(price)) return ''
    const r = Math.round(price)
    // Only whole standard-deviation steps.
    if (Math.abs(price - r) > 0.25) return ''
    if (Math.abs(r) > Z_EXCEPTIONAL_THRESHOLD) return ''
    if (r === 0) return '0'
    const sign = r > 0 ? '+' : '−'
    return `${sign}${Math.abs(r)}`
  },
}

function zHistogramBarColor(value: number, colors: VolChartColors): string {
  const magnitude = Math.min(Math.abs(value), Z_EXCEPTIONAL_THRESHOLD)
  const normalized = magnitude / Z_EXCEPTIONAL_THRESHOLD
  const eased = normalized * normalized * (3 - 2 * normalized)
  const alpha = 0.24 + 0.72 * eased
  const paletteColor = value >= 0 ? colors.hoverPos : colors.hoverNeg
  return withAlpha(paletteColor, alpha)
}

type ZScoreHeuristic = {
  label: string
  regime: 'typical' | 'elevated' | 'extreme' | 'exceptional'
}

function describeZScore(value: number): ZScoreHeuristic {
  const magnitude = Math.abs(value)
  if (magnitude < Z_ELEVATED_THRESHOLD) {
    return { label: 'TYPICAL', regime: 'typical' }
  }
  const direction = value >= 0 ? 'RICH' : 'CHEAP'
  if (magnitude < Z_EXTREME_THRESHOLD) {
    return { label: `ELEVATED · ${direction}`, regime: 'elevated' }
  }
  if (magnitude < Z_EXCEPTIONAL_THRESHOLD) {
    return { label: `EXTREME · ${direction}`, regime: 'extreme' }
  }
  return { label: `EXCEPTIONAL · ${direction}`, regime: 'exceptional' }
}

function zAutoscaleInfoProvider(
  original: () => { priceRange: { minValue: number; maxValue: number } | null } | null,
): { priceRange: { minValue: number; maxValue: number } } {
  const baseRange = original()?.priceRange
  const minValue = Math.min(-Z_SCALE_FLOOR, baseRange?.minValue ?? -Z_SCALE_FLOOR)
  const maxValue = Math.max(Z_SCALE_FLOOR, baseRange?.maxValue ?? Z_SCALE_FLOOR)
  const padding = Math.max(Z_SCALE_PAD, (maxValue - minValue) * 0.08)
  return {
    priceRange: {
      minValue: minValue - padding,
      maxValue: maxValue + padding,
    },
  }
}

function formatVol(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '—'
}

function formatSpread(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${Math.abs(value).toFixed(1)}`
}

function formatZSigma(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${Math.abs(value).toFixed(2)}σ`
}

function formatBtcPrice(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function formatBtcAxis(value: number): string {
  if (!Number.isFinite(value)) return ''
  return Math.round(value)
    .toLocaleString('en-US')
    .replace(',', ' ')
}

function toLineData(
  series: VolSeriesPoint[],
  bounds: MiniChartRangeBounds | null,
  grid: UTCTimestamp[],
): { time: UTCTimestamp; value: number; gapBefore?: boolean }[] {
  const raw: Array<{ time: number; value: number; gapBefore?: boolean }> = []
  for (const p of series) {
    if (!Number.isFinite(p.tsMs) || !Number.isFinite(p.value)) continue
    const ms = p.tsMs > 1e12 ? p.tsMs : p.tsMs * 1000
    const t = Math.floor(ms / 1000) as UTCTimestamp
    if (bounds && (ms < bounds.fromMs || ms > bounds.toMs)) continue
    raw.push({ time: Number(t), value: p.value, gapBefore:p.gapBefore })
  }
  raw.sort((a, b) => a.time - b.time)

  if (!bounds || grid.length < 2) {
    const byTime = new Map<number, number>()
    raw.forEach((point) => byTime.set(point.time, point.value))
    return Array.from(byTime.entries()).map(([time, value]) => ({
      time: time as UTCTimestamp,
      value,
    }))
  }

  const fromSec = Number(grid[0]!)
  const toSec = Number(grid[grid.length - 1]!)
  const spanSec = Math.max(1, toSec - fromSec)
  const bySlot = new Map<number, {value:number;gapBefore?:boolean}>()
  for (const point of raw) {
    const slot = Math.max(0, Math.min(
      grid.length - 1,
      Math.round(((point.time - fromSec) / spanSec) * (grid.length - 1)),
    ))
    bySlot.set(slot, {value:point.value,gapBefore:point.gapBefore || bySlot.get(slot)?.gapBefore})
  }
  return Array.from(bySlot.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([slot, point]) => ({ time: grid[slot]!, ...point }))
}

function withLineGaps(points: Array<{time:UTCTimestamp;value:number;gapBefore?:boolean}>) {
  return points.flatMap((point,index): Array<{time:UTCTimestamp;value:number}|{time:UTCTimestamp}> => {
    const prior=points[index-1]
    if (prior && point.gapBefore) {
      const time=Math.floor((Number(prior.time)+Number(point.time))/2) as UTCTimestamp
      if (time>prior.time && time<point.time) return [{time},point]
    }
    return [point]
  })
}

function buildVolTimeGrid(bounds: MiniChartRangeBounds): UTCTimestamp[] {
  const fromSec = Math.floor(bounds.fromMs / 1000)
  const toSec = Math.max(fromSec + 1, Math.ceil(bounds.toMs / 1000))
  const spanSec = toSec - fromSec
  const count = Math.max(2, Math.min(721, spanSec + 1))
  const times: UTCTimestamp[] = []
  let previous = -1
  for (let index = 0; index < count; index++) {
    const time = Math.round(fromSec + (index / (count - 1)) * spanSec)
    if (time === previous) continue
    times.push(time as UTCTimestamp)
    previous = time
  }
  return times
}
