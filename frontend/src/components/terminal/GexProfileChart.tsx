import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChartEx,
  createOptionsChart,
  type ChartOptionsImpl,
  type DataItem,
  type HistogramData,
  type HorzScaleItemConverterToInternalObj,
  type IChartApiBase,
  type IHorzScaleBehavior,
  type InternalHorzScaleItem,
  type InternalHorzScaleItemKey,
  type IPriceLine,
  type ISeriesApi,
  type LocalizationOptions,
  type Logical,
  type LogicalRange,
  type MouseEventParams,
  type Mutable,
  type SeriesDataItemTypeMap,
  type SeriesType,
  type SingleValueData,
  type TickMark,
  type TickMarkWeightValue,
  type TimeMark,
  type TimeScalePoint,
} from 'lightweight-charts'
import { getGexChartTitle } from '@/components/terminal/gexModes'
import { GexHoverCard, type GexHoverSide } from '@/components/terminal/GexHoverCard'
import {
  magnitudeBarColor,
  readGexSeriesColors,
  type GexSeriesColors,
} from '@/data/gexChartColors'
import { formatAxisMillions, formatMillions, formatStrike } from '@/lib/formatters'
import { cn } from '@/lib/utils'

/**
 * Chart render modes.
 * UI tab strip only offers Strike (`net`) — see gexModes.ts.
 * Profile remains routable here for restore; split/abs are normalize-only.
 *
 * Strike (mode id `net`):
 *   LWC HistogramSeries — strike on X, Net GEX on Y (theme + magnitude color).
 * Profile (archived from tabs):
 *   LWC BaselineSeries with light display-only MA smooth — strike on X, Net GEX on Y.
 */
export type GexMode = 'net' | 'split' | 'abs' | 'profile'

export type GexSnapshot = {
  /** Live Deribit index when available (same as dashboard Index (Deribit)). */
  spot: number
  gammaBars: GexSourceRow[]
}

type GexSourceRow = {
  strike: number
  gammaExposureUsd: number
  callGammaExposureUsd?: number
  putGammaExposureUsd?: number
  netGammaExposureUsd?: number
}

export type GexColorPalette = 'production' | 'include_otc'

export type GexProfileChartProps = {
  snapshot: GexSnapshot
  mode: GexMode
  dataWindowPct: number | 'full'
  onDataWindowPctChange?: (pct: number) => void
  /** Full header bar (candlestick-style). Preferred over titleAccessory. */
  header?: ReactNode
  /** @deprecated Prefer `header` — kept for lightweight title-only embeds. */
  titleAccessory?: ReactNode
  titleOverride?: string
  minHeight?: number
  colorPalette?: GexColorPalette
}

type ChartDatum = {
  strike: number
  netGexUsd: number
  callGexUsd: number
  putGexUsd: number
  grossGexUsd: number
  displayGexUsd: number
}

type HoverState = {
  datum: ChartDatum
  xPct: number
  yPct: number
  side: GexHoverSide
}

/** Vertical spot overlay at live Deribit index (strike on X). */
type SpotOverlay = {
  pos: number
  visible: boolean
}

/** Top-N wall callout markers. */
type WallCallout = {
  strike: number
  netGexUsd: number
  x: number
  y: number
  side: 'above' | 'below'
}

type NetHandle = {
  chart: IChartApiBase<number>
  series: ISeriesApi<'Histogram', number>
  zeroLine: IPriceLine | null
  strikeKey: string
  windowKey: string
  /** Fingerprint of bar values/colors — skip setData when unchanged (kills refresh jitter). */
  dataSig: string
  /** Full X ladder including empty-flank axis anchors (whitespace strikes). */
  seriesStrikes: number[]
  /** Expand-only trim lock so live ticks don't grow/shrink the ladder. */
  trimLoStrike: number | null
  trimHiStrike: number | null
  /** True after first successful fit — live ticks must not re-home the camera. */
  hasInitialFit: boolean
  /** True after user pan/zoom — only dblclick / data-window change re-fits. */
  userAdjustedRange: boolean
  /** Guard so our own setVisibleRange does not mark userAdjusted. */
  programmaticRange: boolean
}

type ProfileHandle = {
  chart: IChartApiBase<number>
  series: ISeriesApi<'Baseline', number>
  zeroLine: IPriceLine | null
  strikeKey: string
  windowKey: string
  /** Fingerprint of series values — skip setData when unchanged. */
  dataSig: string
  /** Values currently in the series (for Y autoscale padding). */
  displayValues: number[]
  /** Full X ladder including empty-flank axis anchors (whitespace strikes). */
  seriesStrikes: number[]
  trimLoStrike: number | null
  trimHiStrike: number | null
  hasInitialFit: boolean
  userAdjustedRange: boolean
  programmaticRange: boolean
}

const defaultChartHeight = 516
const minChartWidth = 120
const TIME_SCALE_MIN_HEIGHT = 26
/**
 * Top-N wall callouts on the plot (strike + GEX chips).
 * Hidden for now — keep helper code for a quick re-enable.
 */
const SHOW_WALL_CALLOUTS = false
const WALL_CALLOUT_MAX = 3

export const GexProfileChart = memo(function GexProfileChart({
  snapshot,
  mode,
  dataWindowPct,
  onDataWindowPctChange,
  header,
  titleAccessory,
  titleOverride,
  minHeight = defaultChartHeight,
  colorPalette = 'production',
}: GexProfileChartProps) {
  const chartMode = normalizeRenderMode(mode)
  const chartTitle = titleOverride ?? getGexChartTitle(chartMode)
  const useOtcPalette = colorPalette === 'include_otc'
  const resolvedHeader = header ?? null

  const data = useMemo(
    () => prepareChartData(snapshot, chartMode),
    [snapshot, chartMode],
  )

  if (chartMode === 'net') {
    return (
      <NetStrikeLwcChart
        data={data}
        spot={snapshot.spot}
        dataWindowPct={dataWindowPct}
        onDataWindowPctChange={onDataWindowPctChange}
        title={chartTitle}
        header={resolvedHeader}
        titleAccessory={titleAccessory}
        minHeight={minHeight}
        useOtcPalette={useOtcPalette}
      />
    )
  }

  return (
    <ProfileLwcChart
      data={data}
      spot={snapshot.spot}
      dataWindowPct={dataWindowPct}
      onDataWindowPctChange={onDataWindowPctChange}
      title={chartTitle}
      header={resolvedHeader}
      titleAccessory={titleAccessory}
      minHeight={minHeight}
      useOtcPalette={useOtcPalette}
    />
  )
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Shared LWC options-chart chrome (strike on X, GEX on Y)
 * ═══════════════════════════════════════════════════════════════════════════ */

function markWithGreaterWeight(a: TimeMark, b: TimeMark): TimeMark {
  return a.weight > b.weight ? a : b
}

/**
 * Price-based horizontal scale tuned for BTC option strikes.
 * Mirrors Lightweight Charts' built-in HorzScaleBehaviorPrice with:
 *  - compact k-suffix tick labels
 *  - strike-friendly tick weights (500 / 1k / 2.5k / 5k / 10k)
 */
class StrikeHorzScaleBehavior implements IHorzScaleBehavior<number> {
  private _options!: ChartOptionsImpl<number>

  options(): ChartOptionsImpl<number> {
    return this._options
  }

  setOptions(options: ChartOptionsImpl<number>): void {
    this._options = options
  }

  preprocessData(_data: DataItem<number> | DataItem<number>[]): void {
    // no-op — strikes need no preprocessing
  }

  updateFormatter(options: LocalizationOptions<number>): void {
    if (!this._options) return
    this._options.localization = options
  }

  createConverterToInternalObj(
    _data: SeriesDataItemTypeMap<number>[SeriesType][],
  ): HorzScaleItemConverterToInternalObj<number> {
    return (price: number) => price as unknown as InternalHorzScaleItem
  }

  key(internalItem: InternalHorzScaleItem | number): InternalHorzScaleItemKey {
    return internalItem as InternalHorzScaleItemKey
  }

  cacheKey(internalItem: InternalHorzScaleItem): number {
    return internalItem as unknown as number
  }

  convertHorzItemToInternal(item: number): InternalHorzScaleItem {
    return item as unknown as InternalHorzScaleItem
  }

  formatHorzItem(item: InternalHorzScaleItem): string {
    return formatStrikeTick(item as unknown as number)
  }

  formatTickmark(
    item: TickMark,
    _localizationOptions: LocalizationOptions<number>,
  ): string {
    return formatStrikeTick(item.time as unknown as number)
  }

  maxTickMarkWeight(marks: TimeMark[]): TickMarkWeightValue {
    return marks.reduce(markWithGreaterWeight, marks[0]!).weight
  }

  fillWeightsForPoints(
    sortedTimePoints: readonly Mutable<TimeScalePoint>[],
    startIndex: number,
  ): void {
    // Integer-modulo weights (float equality was dropping many round strikes).
    // Keep 1k / 2k competitive so mid zooms still get a full ladder of labels
    // (not a single leftover tick like "58k").
    const strikeWeight = (price: number): number => {
      const p = Math.round(price)
      if (p % 25_000 === 0) return 20
      if (p % 10_000 === 0) return 18
      if (p % 5_000 === 0) return 16
      if (p % 2_500 === 0) return 12
      if (p % 2_000 === 0) return 11
      if (p % 1_000 === 0) return 10
      if (p % 500 === 0) return 6
      if (p % 250 === 0) return 3
      return 0
    }
    for (let index = startIndex; index < sortedTimePoints.length; index += 1) {
      sortedTimePoints[index]!.timeWeight = strikeWeight(
        sortedTimePoints[index]!.time as unknown as number,
      ) as TickMarkWeightValue
    }
  }
}

function createGexOptionsChart(
  container: HTMLElement,
  options: Parameters<typeof createOptionsChart>[1],
): IChartApiBase<number> {
  try {
    return createChartEx(container, new StrikeHorzScaleBehavior(), options)
  } catch {
    return createOptionsChart(container, options)
  }
}

function buildGexChartOptions(width: number, height: number, colors: GexSeriesColors) {
  return {
    width,
    height,
    autoSize: false,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: colors.text,
      fontSize: 11,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      attributionLogo: false,
    },
    localization: {
      precision: 0,
      priceFormatter: (price: number) => formatAxisMillions(price),
      timeFormatter: (strike: number) => formatStrikeTick(strike),
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { visible: false },
    },
    crosshair: {
      mode: CrosshairMode.Magnet,
      vertLine: {
        color: colors.crosshair,
        width: 1 as const,
        style: LineStyle.Dashed,
        labelVisible: true,
        labelBackgroundColor: colors.crosshairLabelBg,
      },
      horzLine: {
        color: colors.crosshair,
        width: 1 as const,
        style: LineStyle.Dashed,
        labelVisible: true,
        labelBackgroundColor: colors.crosshairLabelBg,
      },
    },
    rightPriceScale: {
      visible: true,
      borderVisible: false,
      entireTextOnly: true,
      // Modest pane margins; real Y headroom comes from autoscaleInfoProvider.
      scaleMargins: { top: 0.06, bottom: 0.06 },
      autoScale: true,
    },
    leftPriceScale: {
      visible: false,
      borderVisible: false,
    },
    timeScale: {
      visible: true,
      borderVisible: false,
      // Allow empty flanks past first/last strike so spot can sit centered.
      fixLeftEdge: false,
      fixRightEdge: false,
      minBarSpacing: 0.45,
      maxBarSpacing: 0,
      barSpacing: 6,
      rightOffset: 0,
      tickMarkMaxCharacterLength: 6,
      minimumHeight: TIME_SCALE_MIN_HEIGHT,
      ticksVisible: false,
      // false = weight-ranked labels at real strikes (uniform was leaving 0–1 ticks).
      uniformDistribution: false,
      shiftVisibleRangeOnNewBar: false,
      allowShiftVisibleRangeOnWhitespaceReplacement: false,
      lockVisibleTimeRangeOnResize: true,
      allowBoldLabels: true,
    },
    handleScroll: {
      mouseWheel: false,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
    handleScale: {
      axisPressedMouseMove: { time: true, price: true },
      // Custom wheel handler anchors zoom on spot — disable native wheel scale.
      mouseWheel: false,
      pinch: true,
      // Time axis: custom host dblclick runs spot-centered fitStrikeContent.
      axisDoubleClickReset: { time: false, price: true },
    },
    kineticScroll: {
      mouse: false,
      touch: false,
    },
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * STRIKE — LWC vertical histogram (strike X, Net GEX Y)
 * ═══════════════════════════════════════════════════════════════════════════ */

function NetStrikeLwcChart({
  data,
  spot,
  dataWindowPct,
  onDataWindowPctChange,
  title,
  header,
  titleAccessory,
  minHeight,
  useOtcPalette,
}: {
  data: ChartDatum[]
  spot: number
  dataWindowPct: number | 'full'
  onDataWindowPctChange?: (pct: number) => void
  title: string
  header?: ReactNode
  titleAccessory?: ReactNode
  minHeight: number
  useOtcPalette: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<NetHandle | null>(null)
  const dataRef = useRef(data)
  const spotRef = useRef(spot)
  const dataWindowPctRef = useRef(dataWindowPct)
  const colorsRef = useRef<GexSeriesColors>(readGexSeriesColors())

  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<HoverState | null>(null)
  const [spotOverlay, setSpotOverlay] = useState<SpotOverlay>({
    pos: 0,
    visible: false,
  })
  const [wallCallouts, setWallCallouts] = useState<WallCallout[]>([])

  useEffect(() => {
    dataRef.current = data
    spotRef.current = spot
    dataWindowPctRef.current = dataWindowPct
  }, [data, spot, dataWindowPct])

  useDataWindowWheelZoom(wrapRef, dataWindowPct, onDataWindowPctChange)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let raf = 0
    let spotRaf = 0
    let ro: ResizeObserver | null = null
    let handle: NetHandle | null = null
    let themeObserver: MutationObserver | null = null

    const colors = readGexSeriesColors(host)
    colorsRef.current = colors

    const refreshOverlays = () => {
      if (disposed || !handle) return
      const strikes = handle.seriesStrikes.length > 0
        ? handle.seriesStrikes
        : dataRef.current.map((d) => d.strike)
      const x = spotToCoordinate(handle.chart, strikes, spotRef.current)
      if (x == null || !Number.isFinite(x)) {
        setSpotOverlay((prev) => (prev.visible ? { pos: 0, visible: false } : prev))
      } else {
        setSpotOverlay((prev) => (
          prev.visible && Math.abs(prev.pos - x) < 0.5
            ? prev
            : { pos: x, visible: true }
        ))
      }
      if (SHOW_WALL_CALLOUTS) {
        setWallCallouts(computeWallCallouts(handle.chart, handle.series, dataRef.current))
      }
    }

    const scheduleOverlays = () => {
      if (spotRaf) cancelAnimationFrame(spotRaf)
      spotRaf = requestAnimationFrame(refreshOverlays)
    }

    const onCrosshair = (param: MouseEventParams<number>) => {
      if (disposed || !handle || !wrapRef.current) return
      if (!param.point || param.time === undefined || param.point.x < 0 || param.point.y < 0) {
        setHovered(null)
        return
      }
      const strike = typeof param.time === 'number' ? param.time : Number(param.time)
      if (!Number.isFinite(strike)) {
        setHovered(null)
        return
      }
      const datum = findNearestDatum(dataRef.current, strike)
      if (!datum) {
        setHovered(null)
        return
      }
      const rect = wrapRef.current.getBoundingClientRect()
      const w = Math.max(rect.width, 1)
      const h = Math.max(rect.height, 1)
      const xPct = (param.point.x / w) * 100
      const yPct = (param.point.y / h) * 100
      setHovered({
        datum,
        xPct,
        yPct,
        side: xPct > 62 ? 'left' : 'right',
      })
    }

    try {
      host.replaceChildren()
      const { w, h } = measure(host)

      const chart = createGexOptionsChart(host, buildGexChartOptions(w, h, colors))

      // Expand-only Y lock: live ticks can grow the scale, not shrink it (vertical jitter).
      let yRangeLock: { min: number; max: number } | null = null

      const series = chart.addSeries(HistogramSeries, {
        color: colors.positive,
        base: 0,
        priceLineVisible: false,
        lastValueVisible: false,
        autoscaleInfoProvider: (
          original: () => { priceRange: { minValue: number; maxValue: number } | null } | null,
        ) => {
          const base = original()
          if (!base?.priceRange) return base
          const min = Math.min(base.priceRange.minValue, 0)
          const max = Math.max(base.priceRange.maxValue, 0)
          const span = Math.max(max - min, 1)
          const pad = span * 0.28
          let minV = min - pad
          let maxV = max + pad
          if (yRangeLock) {
            minV = Math.min(yRangeLock.min, minV)
            maxV = Math.max(yRangeLock.max, maxV)
          }
          yRangeLock = { min: minV, max: maxV }
          return {
            priceRange: {
              minValue: minV,
              maxValue: maxV,
            },
          }
        },
        priceFormat: {
          type: 'custom',
          minMove: 1,
          formatter: (price: number) => formatAxisMillions(price),
        },
      })

      const zeroLine = series.createPriceLine({
        price: 0,
        color: colors.zero,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: false,
        title: '',
      })

      const nextHandle: NetHandle = {
        chart,
        series,
        zeroLine,
        strikeKey: '',
        windowKey: '',
        dataSig: '',
        seriesStrikes: [],
        trimLoStrike: null,
        trimHiStrike: null,
        hasInitialFit: false,
        userAdjustedRange: false,
        programmaticRange: false,
      }
      handle = nextHandle
      handleRef.current = nextHandle

      applyNetData(nextHandle, dataRef.current, {
        fit: true,
        spot: spotRef.current,
        dataWindowPct: dataWindowPctRef.current,
        colors: colorsRef.current,
      })
      try {
        chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: { top: 0.06, bottom: 0.06 } })
      } catch {
        // ignore
      }
      scheduleOverlays()

      chart.subscribeCrosshairMove(onCrosshair)
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (handle && !handle.programmaticRange) {
          handle.userAdjustedRange = true
        }
        scheduleOverlays()
      })

      const onDblClick = (ev: MouseEvent) => {
        const h = handle
        if (disposed || !h) return
        ev.preventDefault()
        h.userAdjustedRange = false
        yRangeLock = null // allow Y to re-fit to current data
        applyProgrammaticRange(h, () => {
          fitStrikeContent(
            h.chart,
            h.seriesStrikes,
            spotRef.current,
            dataWindowPctRef.current,
          )
        })
        try {
          chart.priceScale('right').applyOptions({ autoScale: true })
        } catch {
          // ignore
        }
        scheduleOverlays()
      }
      host.addEventListener('dblclick', onDblClick)

      const onWheelZoom = makeSpotAnchoredWheelHandler({
        getHandle: () => handle,
        getStrikes: () => handle?.seriesStrikes ?? [],
        getSpot: () => spotRef.current,
        onAfter: () => {
          if (handle) handle.userAdjustedRange = true
          scheduleOverlays()
        },
        disposed: () => disposed,
      })
      host.addEventListener('wheel', onWheelZoom, { passive: false })

      const syncSize = () => {
        if (disposed || !handle) return
        const next = measure(host)
        handle.chart.resize(next.w, next.h, true)
        scheduleOverlays()
      }

      ro = new ResizeObserver(() => {
        if (raf) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(syncSize)
      })
      ro.observe(host)

      // Re-read theme tokens when data-theme flips on <html>.
      themeObserver = new MutationObserver(() => {
        if (disposed || !handle) return
        const nextColors = readGexSeriesColors(host)
        colorsRef.current = nextColors
        try {
          handle.zeroLine?.applyOptions({ color: nextColors.zero })
          // Force bar color rewrite (dataSig skip would otherwise no-op).
          handle.dataSig = ''
          applyNetData(handle, dataRef.current, {
            spot: spotRef.current,
            dataWindowPct: dataWindowPctRef.current,
            colors: nextColors,
          })
          scheduleOverlays()
        } catch {
          // ignore
        }
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'class'],
      })

      raf = requestAnimationFrame(() => {
        syncSize()
        // Do not re-fit here — applyNetData(fit:true) already set the camera.
        scheduleOverlays()
      })

      queueMicrotask(() => {
        if (!disposed) setError(null)
      })

      return () => {
        disposed = true
        if (raf) cancelAnimationFrame(raf)
        if (spotRaf) cancelAnimationFrame(spotRaf)
        ro?.disconnect()
        themeObserver?.disconnect()
        host.removeEventListener('dblclick', onDblClick)
        host.removeEventListener('wheel', onWheelZoom)
        try {
          handle?.chart.unsubscribeCrosshairMove(onCrosshair)
          handle?.chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleOverlays)
        } catch {
          // ignore
        }
        handleRef.current = null
        try {
          handle?.chart.remove()
        } catch {
          // ignore
        }
        host.replaceChildren()
        queueMicrotask(() => {
          setSpotOverlay({ pos: 0, visible: false })
          setWallCallouts([])
          setHovered(null)
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => setError(msg))
      console.error('[GexProfileChart] strike chart create failed', err)
      return () => {
        disposed = true
      }
    }
  }, [])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    try {
      const colors = readGexSeriesColors(hostRef.current)
      colorsRef.current = colors
      applyNetData(handle, data, {
        spot,
        dataWindowPct,
        colors,
      })
      const x = spotToCoordinate(handle.chart, handle.seriesStrikes, spot)
      queueMicrotask(() => {
        if (x == null || !Number.isFinite(x)) {
          setSpotOverlay({ pos: 0, visible: false })
        } else {
          setSpotOverlay({ pos: x, visible: true })
        }
        if (SHOW_WALL_CALLOUTS) {
          setWallCallouts(computeWallCallouts(handle.chart, handle.series, data))
        }
        setHovered(null)
        setError(null)
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => setError(msg))
    }
  }, [data, spot, dataWindowPct])

  return (
    <div
      ref={wrapRef}
      className={cn(
        'relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden',
        useOtcPalette && 'gex-palette-otc',
      )}
      style={{ minHeight: Math.min(minHeight, 120) }}
    >
      {header ?? (
        <ChartTitleOverlay
          title={title}
          subtitle="STRIKE (X) · NET GEX (Y)"
          titleAccessory={titleAccessory}
        />
      )}

      <div className={cn('gex-lwc-wrap', !header && 'gex-lwc-wrap--overlay')}>
        <div
          ref={hostRef}
          className="gex-lwc-canvas"
          role="img"
          aria-label="BTC net gamma exposure by strike — vertical bars, strike on X axis, net GEX on Y axis"
        />

        {spotOverlay.visible ? (
          <div
            className="gex-lwc-spot gex-lwc-spot--vertical pointer-events-none absolute z-[4]"
            style={{ left: spotOverlay.pos, top: 0, bottom: 0 }}
            aria-hidden
          >
            <div className="gex-lwc-spot__glow" />
            <div className="gex-lwc-spot__line" />
            <div className="gex-lwc-spot__label gex-lwc-spot__label--axis">
              <span className="gex-lwc-spot__label-tick" />
              <span className="gex-lwc-spot__label-text">{formatStrike(spot)}</span>
            </div>
          </div>
        ) : null}

        {SHOW_WALL_CALLOUTS
          ? wallCallouts.map((wall) => (
          <div
            key={`wall-${wall.strike}`}
            className={cn(
              'gex-wall-callout pointer-events-none absolute z-[3]',
              wall.side === 'above' ? 'gex-wall-callout--above' : 'gex-wall-callout--below',
            )}
            style={{ left: wall.x, top: wall.y }}
            aria-hidden
          >
            <span className="gex-wall-callout__strike">{formatStrike(wall.strike)}</span>
            <span
              className={cn(
                'gex-wall-callout__val',
                wall.netGexUsd >= 0 ? 'gex-wall-callout__val--pos' : 'gex-wall-callout__val--neg',
              )}
            >
              {formatMillions(wall.netGexUsd)}
            </span>
          </div>
            ))
          : null}

        {error ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 px-3 text-center text-[10px] text-[var(--terminal-red-strong)]">
            Chart error: {error}
          </div>
        ) : null}

        {data.length === 0 && !error ? (
          <div className="pointer-events-none absolute inset-0 z-[3] flex items-center justify-center text-[10px] uppercase tracking-[0.12em] text-[var(--terminal-muted)]">
            No GEX data in window
          </div>
        ) : null}

        {hovered ? (
          <GexHoverCard
            side={hovered.side}
            xPct={hovered.xPct}
            yPct={hovered.yPct}
            model={{
              strike: hovered.datum.strike,
              netGexUsd: hovered.datum.netGexUsd,
              callGexUsd: hovered.datum.callGexUsd,
              putGexUsd: hovered.datum.putGexUsd,
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

function applyNetData(
  handle: NetHandle,
  data: ChartDatum[],
  options?: {
    fit?: boolean
    spot?: number
    dataWindowPct?: number | 'full'
    colors?: GexSeriesColors
  },
) {
  const sorted = [...data].sort((a, b) => a.strike - b.strike)
  // Drop dead high/low tail so axis does not run to 250k with no GEX.
  // Expand-only lock prevents live ticks from jittering the ladder edges.
  const deduped = trimGexLadder(dedupeByStrike(sorted), {
    loStrike: handle.trimLoStrike,
    hiStrike: handle.trimHiStrike,
  })
  if (deduped.length > 0) {
    handle.trimLoStrike = deduped[0]!.strike
    handle.trimHiStrike = deduped[deduped.length - 1]!.strike
  }

  const nextStrikeKey = deduped.map((d) => d.strike).join(',')
  const nextWindowKey = String(options?.dataWindowPct ?? 'full')
  const windowChanged = nextWindowKey !== handle.windowKey
  const ladderChanged = nextStrikeKey !== handle.strikeKey
  handle.strikeKey = nextStrikeKey
  handle.windowKey = nextWindowKey

  const colors = options?.colors ?? readGexSeriesColors()
  const maxAbs = Math.max(1, ...deduped.map((d) => Math.abs(d.displayGexUsd)))
  const realByStrike = new Map(deduped.map((d) => [d.strike, d]))

  // Reuse the X ladder when real strikes are unchanged — spot-driven anchors
  // must not rewrite indices on every live refresh (that was the horizontal jitter).
  let seriesStrikes = handle.seriesStrikes
  if (ladderChanged || seriesStrikes.length === 0) {
    seriesStrikes = extendStrikesWithAxisAnchors(
      deduped.map((d) => d.strike),
      options?.spot,
    )
    handle.seriesStrikes = seriesStrikes
  }

  const points: Array<HistogramData<number> | { time: number }> = seriesStrikes.map((strike) => {
    const d = realByStrike.get(strike)
    if (d) {
      return {
        time: strike,
        value: d.displayGexUsd,
        color: magnitudeBarColor(d.displayGexUsd, maxAbs, colors),
      }
    }
    return { time: strike }
  })

  // Coarse fingerprint: ignore sub-$1k noise / color churn so tiny ticks don't setData.
  const dataSig = `${Math.round(maxAbs / 100_000)}|${points
    .map((p) => {
      if (!('value' in p) || p.value == null) return `${p.time}:_`
      return `${p.time}:${Math.round((p.value as number) / 1_000)}`
    })
    .join('|')}`

  if (
    dataSig === handle.dataSig
    && !windowChanged
    && !ladderChanged
    && options?.fit !== true
  ) {
    return
  }
  handle.dataSig = dataSig

  const ts = handle.chart.timeScale()
  const prevLogical = ts.getVisibleLogicalRange()
  const prevTimeRange = ts.getVisibleRange()

  handle.series.setData(points as HistogramData<number>[])

  // Camera policy:
  //  - data-window change → re-home
  //  - first fit only (until user pans/zooms)
  //  - live GEX refreshes → restore prior camera (never re-fit)
  if (windowChanged) {
    handle.userAdjustedRange = false
    applyProgrammaticRange(handle, () => {
      fitStrikeContent(handle.chart, seriesStrikes, options?.spot, options?.dataWindowPct)
    })
    handle.hasInitialFit = true
  } else if ((options?.fit === true || !handle.hasInitialFit) && !handle.userAdjustedRange) {
    applyProgrammaticRange(handle, () => {
      fitStrikeContent(handle.chart, seriesStrikes, options?.spot, options?.dataWindowPct)
    })
    handle.hasInitialFit = true
  } else if (ladderChanged) {
    // Ladder edges moved: re-apply price range (indices shifted).
    restoreVisibleStrikeRange(handle, prevTimeRange, prevLogical)
  } else {
    // Same ladder — restore logical range (stable across value-only setData).
    restoreVisibleStrikeRange(handle, prevTimeRange, prevLogical)
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PROFILE — BaselineSeries + light display MA (strike X, Net GEX Y)
 * ═══════════════════════════════════════════════════════════════════════════ */

function ProfileLwcChart({
  data,
  spot,
  dataWindowPct,
  onDataWindowPctChange,
  title,
  header,
  titleAccessory,
  minHeight,
  useOtcPalette,
}: {
  data: ChartDatum[]
  spot: number
  dataWindowPct: number | 'full'
  onDataWindowPctChange?: (pct: number) => void
  title: string
  header?: ReactNode
  titleAccessory?: ReactNode
  minHeight: number
  useOtcPalette: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<ProfileHandle | null>(null)
  const dataRef = useRef(data)
  const spotRef = useRef(spot)
  const dataWindowPctRef = useRef(dataWindowPct)
  const colorsRef = useRef<GexSeriesColors>(readGexSeriesColors())

  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<HoverState | null>(null)
  const [spotOverlay, setSpotOverlay] = useState<SpotOverlay>({
    pos: 0,
    visible: false,
  })
  const [wallCallouts, setWallCallouts] = useState<WallCallout[]>([])

  useEffect(() => {
    dataRef.current = data
    spotRef.current = spot
    dataWindowPctRef.current = dataWindowPct
  }, [data, spot, dataWindowPct])

  useDataWindowWheelZoom(wrapRef, dataWindowPct, onDataWindowPctChange)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let raf = 0
    let spotRaf = 0
    let ro: ResizeObserver | null = null
    let handle: ProfileHandle | null = null
    let themeObserver: MutationObserver | null = null

    const colors = readGexSeriesColors(host)
    colorsRef.current = colors

    const refreshOverlays = () => {
      if (disposed || !handle) return
      const strikes = handle.seriesStrikes.length > 0
        ? handle.seriesStrikes
        : dataRef.current.map((d) => d.strike)
      const x = spotToCoordinate(handle.chart, strikes, spotRef.current)
      if (x == null || !Number.isFinite(x)) {
        setSpotOverlay((prev) => (prev.visible ? { pos: 0, visible: false } : prev))
      } else {
        setSpotOverlay((prev) => (
          prev.visible && Math.abs(prev.pos - x) < 0.5
            ? prev
            : { pos: x, visible: true }
        ))
      }
      if (SHOW_WALL_CALLOUTS) {
        setWallCallouts(computeWallCallouts(handle.chart, handle.series, dataRef.current))
      }
    }

    const scheduleOverlays = () => {
      if (spotRaf) cancelAnimationFrame(spotRaf)
      spotRaf = requestAnimationFrame(refreshOverlays)
    }

    const onCrosshair = (param: MouseEventParams<number>) => {
      if (disposed || !handle || !wrapRef.current) return
      if (!param.point || param.time === undefined || param.point.x < 0 || param.point.y < 0) {
        setHovered(null)
        return
      }
      const strike = typeof param.time === 'number' ? param.time : Number(param.time)
      if (!Number.isFinite(strike)) {
        setHovered(null)
        return
      }
      const datum = findNearestDatum(dataRef.current, strike)
      if (!datum) {
        setHovered(null)
        return
      }
      const rect = wrapRef.current.getBoundingClientRect()
      const w = Math.max(rect.width, 1)
      const h = Math.max(rect.height, 1)
      const xPct = (param.point.x / w) * 100
      const yPct = (param.point.y / h) * 100
      setHovered({
        datum,
        xPct,
        yPct,
        side: xPct > 62 ? 'left' : 'right',
      })
    }

    try {
      host.replaceChildren()
      const { w, h } = measure(host)

      const chart = createGexOptionsChart(host, buildGexChartOptions(w, h, colors))

      // Mutable bag read by autoscaleInfoProvider (set before each setData).
      const displayValuesRef = { current: [] as number[] }
      // Expand-only Y lock (same as strike chart — kills vertical refresh jitter).
      let yRangeLock: { min: number; max: number } | null = null

      const series = chart.addSeries(BaselineSeries, {
        baseValue: { type: 'price', price: 0 },
        topLineColor: colors.positiveEdge,
        bottomLineColor: colors.negativeEdge,
        topFillColor1: colors.positiveSoft,
        topFillColor2: colors.positiveSofter,
        bottomFillColor1: colors.negativeSofter,
        bottomFillColor2: colors.negativeSoft,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 3,
        crosshairMarkerBorderWidth: 0,
        // Real Y buffer relative to the *visible* series range.
        // scaleMargins only inset the pane; this expands the price domain so a
        // trough at -1.8M / peak at +1.4M lands near -2.5M / +2.1M axis ends.
        autoscaleInfoProvider: (
          original: () => { priceRange: { minValue: number; maxValue: number } | null } | null,
        ) => {
          const base = original()
          let min = 0
          let max = 0
          if (base?.priceRange) {
            min = Math.min(base.priceRange.minValue, 0)
            max = Math.max(base.priceRange.maxValue, 0)
          } else {
            const vals = displayValuesRef.current
            if (vals.length === 0) return base
            for (const v of vals) {
              if (!Number.isFinite(v)) continue
              if (v < min) min = v
              if (v > max) max = v
            }
          }
          const span = Math.max(max - min, Math.abs(min), Math.abs(max), 1)
          const pad = span * 0.28
          let minV = min - pad
          let maxV = max + pad
          if (yRangeLock) {
            minV = Math.min(yRangeLock.min, minV)
            maxV = Math.max(yRangeLock.max, maxV)
          }
          yRangeLock = { min: minV, max: maxV }
          return {
            priceRange: {
              minValue: minV,
              maxValue: maxV,
            },
          }
        },
        priceFormat: {
          type: 'custom',
          minMove: 1,
          formatter: (price: number) => formatAxisMillions(price),
        },
      })

      const zeroLine = series.createPriceLine({
        price: 0,
        color: colors.zero,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: false,
        title: '',
      })

      const nextHandle: ProfileHandle = {
        chart,
        series,
        zeroLine,
        strikeKey: '',
        windowKey: '',
        dataSig: '',
        displayValues: [],
        seriesStrikes: [],
        trimLoStrike: null,
        trimHiStrike: null,
        hasInitialFit: false,
        userAdjustedRange: false,
        programmaticRange: false,
      }
      // Bridge handle.displayValues → provider ref
      const syncDisplayValues = (vals: number[]) => {
        nextHandle.displayValues = vals
        displayValuesRef.current = vals
      }
      handle = nextHandle
      handleRef.current = nextHandle

      applyProfileData(nextHandle, dataRef.current, {
        fit: true,
        spot: spotRef.current,
        dataWindowPct: dataWindowPctRef.current,
        syncDisplayValues,
      })
      // Ensure price scale re-reads padded range after first data.
      try {
        chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: { top: 0.06, bottom: 0.06 } })
      } catch {
        // ignore
      }
      scheduleOverlays()

      chart.subscribeCrosshairMove(onCrosshair)
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (handle && !handle.programmaticRange) {
          handle.userAdjustedRange = true
        }
        scheduleOverlays()
      })

      const onDblClick = (ev: MouseEvent) => {
        const h = handle
        if (disposed || !h) return
        ev.preventDefault()
        h.userAdjustedRange = false
        yRangeLock = null
        applyProgrammaticRange(h, () => {
          fitStrikeContent(
            h.chart,
            h.seriesStrikes,
            spotRef.current,
            dataWindowPctRef.current,
          )
        })
        try {
          chart.priceScale('right').applyOptions({ autoScale: true })
        } catch {
          // ignore
        }
        scheduleOverlays()
      }
      host.addEventListener('dblclick', onDblClick)

      const onWheelZoom = makeSpotAnchoredWheelHandler({
        getHandle: () => handle,
        getStrikes: () => handle?.seriesStrikes ?? [],
        getSpot: () => spotRef.current,
        onAfter: () => {
          if (handle) handle.userAdjustedRange = true
          scheduleOverlays()
        },
        disposed: () => disposed,
      })
      host.addEventListener('wheel', onWheelZoom, { passive: false })

      const syncSize = () => {
        if (disposed || !handle) return
        const next = measure(host)
        handle.chart.resize(next.w, next.h, true)
        scheduleOverlays()
      }

      ro = new ResizeObserver(() => {
        if (raf) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(syncSize)
      })
      ro.observe(host)

      themeObserver = new MutationObserver(() => {
        if (disposed || !handle) return
        const nextColors = readGexSeriesColors(host)
        colorsRef.current = nextColors
        try {
          handle.zeroLine?.applyOptions({ color: nextColors.zero })
          handle.series.applyOptions({
            topLineColor: nextColors.positiveEdge,
            bottomLineColor: nextColors.negativeEdge,
            topFillColor1: nextColors.positiveSoft,
            topFillColor2: nextColors.positiveSofter,
            bottomFillColor1: nextColors.negativeSofter,
            bottomFillColor2: nextColors.negativeSoft,
          })
          scheduleOverlays()
        } catch {
          // ignore
        }
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'class'],
      })

      raf = requestAnimationFrame(() => {
        syncSize()
        // Do not re-fit — applyProfileData(fit:true) already set the camera.
        scheduleOverlays()
      })

      queueMicrotask(() => {
        if (!disposed) setError(null)
      })

      return () => {
        disposed = true
        if (raf) cancelAnimationFrame(raf)
        if (spotRaf) cancelAnimationFrame(spotRaf)
        ro?.disconnect()
        themeObserver?.disconnect()
        host.removeEventListener('dblclick', onDblClick)
        host.removeEventListener('wheel', onWheelZoom)
        try {
          handle?.chart.unsubscribeCrosshairMove(onCrosshair)
          handle?.chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleOverlays)
        } catch {
          // ignore
        }
        handleRef.current = null
        try {
          handle?.chart.remove()
        } catch {
          // ignore
        }
        host.replaceChildren()
        queueMicrotask(() => {
          setSpotOverlay({ pos: 0, visible: false })
          setWallCallouts([])
          setHovered(null)
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => setError(msg))
      console.error('[GexProfileChart] profile create failed', err)
      return () => {
        disposed = true
      }
    }
  }, [])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    try {
      applyProfileData(handle, data, {
        spot,
        dataWindowPct,
        syncDisplayValues: (vals) => {
          handle.displayValues = vals
        },
      })
      // Nudge autoscale after data so padded range sticks (live ticks).
      try {
        handle.chart.priceScale('right').applyOptions({ autoScale: true })
      } catch {
        // ignore
      }
      const x = spotToCoordinate(handle.chart, handle.seriesStrikes, spot)
      queueMicrotask(() => {
        if (x == null || !Number.isFinite(x)) {
          setSpotOverlay({ pos: 0, visible: false })
        } else {
          setSpotOverlay({ pos: x, visible: true })
        }
        if (SHOW_WALL_CALLOUTS) {
          setWallCallouts(computeWallCallouts(handle.chart, handle.series, data))
        }
        setHovered(null)
        setError(null)
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => setError(msg))
    }
  }, [data, spot, dataWindowPct])

  return (
    <div
      ref={wrapRef}
      className={cn(
        'relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden',
        useOtcPalette && 'gex-palette-otc',
      )}
      style={{ minHeight: Math.min(minHeight, 120) }}
    >
      {header ?? (
        <ChartTitleOverlay
          title={title}
          subtitle="NET GEX PROFILE"
          titleAccessory={titleAccessory}
        />
      )}

      <div className={cn('gex-lwc-wrap', !header && 'gex-lwc-wrap--overlay')}>
        <div
          ref={hostRef}
          className="gex-lwc-canvas"
          role="img"
          aria-label="BTC net GEX profile by strike — strike on X axis"
        />

        {spotOverlay.visible ? (
          <div
            className="gex-lwc-spot gex-lwc-spot--vertical pointer-events-none absolute z-[4]"
            style={{ left: spotOverlay.pos, top: 0, bottom: 0 }}
            aria-hidden
          >
            <div className="gex-lwc-spot__glow" />
            <div className="gex-lwc-spot__line" />
            <div className="gex-lwc-spot__label gex-lwc-spot__label--axis">
              <span className="gex-lwc-spot__label-tick" />
              <span className="gex-lwc-spot__label-text">{formatStrike(spot)}</span>
            </div>
          </div>
        ) : null}

        {SHOW_WALL_CALLOUTS
          ? wallCallouts.map((wall) => (
          <div
            key={`wall-${wall.strike}`}
            className={cn(
              'gex-wall-callout pointer-events-none absolute z-[3]',
              wall.side === 'above' ? 'gex-wall-callout--above' : 'gex-wall-callout--below',
            )}
            style={{ left: wall.x, top: wall.y }}
            aria-hidden
          >
            <span className="gex-wall-callout__strike">{formatStrike(wall.strike)}</span>
            <span
              className={cn(
                'gex-wall-callout__val',
                wall.netGexUsd >= 0 ? 'gex-wall-callout__val--pos' : 'gex-wall-callout__val--neg',
              )}
            >
              {formatMillions(wall.netGexUsd)}
            </span>
          </div>
            ))
          : null}

        {error ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 px-3 text-center text-[10px] text-[var(--terminal-red-strong)]">
            Chart error: {error}
          </div>
        ) : null}

        {data.length === 0 && !error ? (
          <div className="pointer-events-none absolute inset-0 z-[3] flex items-center justify-center text-[10px] uppercase tracking-[0.12em] text-[var(--terminal-muted)]">
            No GEX data in window
          </div>
        ) : null}

        {hovered ? (
          <GexHoverCard
            side={hovered.side}
            xPct={hovered.xPct}
            yPct={hovered.yPct}
            model={{
              strike: hovered.datum.strike,
              netGexUsd: hovered.datum.netGexUsd,
              callGexUsd: hovered.datum.callGexUsd,
              putGexUsd: hovered.datum.putGexUsd,
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

function applyProfileData(
  handle: ProfileHandle,
  data: ChartDatum[],
  options?: {
    fit?: boolean
    spot?: number
    dataWindowPct?: number | 'full'
    syncDisplayValues?: (vals: number[]) => void
  },
) {
  const sorted = [...data].sort((a, b) => a.strike - b.strike)
  const deduped = trimGexLadder(dedupeByStrike(sorted), {
    loStrike: handle.trimLoStrike,
    hiStrike: handle.trimHiStrike,
  })
  if (deduped.length > 0) {
    handle.trimLoStrike = deduped[0]!.strike
    handle.trimHiStrike = deduped[deduped.length - 1]!.strike
  }

  const nextStrikeKey = deduped.map((d) => d.strike).join(',')
  const nextWindowKey = String(options?.dataWindowPct ?? 'full')
  const windowChanged = nextWindowKey !== handle.windowKey
  const ladderChanged = nextStrikeKey !== handle.strikeKey
  handle.strikeKey = nextStrikeKey
  handle.windowKey = nextWindowKey

  /*
   * Profile path hygiene (kills end-of-range “spaghetti”):
   *  1. Flatten micro-noise near zero so dense ladders don’t chatter.
   *  2. Very light 3-pt MA (radius 1) — enough to calm without inventing lobes.
   *  3. Strictly increasing strikes only (already deduped).
   * Tooltips still sample raw dataRef — display-only transform.
   */
  const raw = deduped.map((d) => d.netGexUsd)
  const maxAbs = Math.max(1, ...raw.map((v) => Math.abs(v)))
  // Kill wing chatter that BaselineSeries turns into end-of-range spaghetti.
  const noiseFloor = maxAbs * 0.02
  const cleaned = raw.map((v) => (Math.abs(v) < noiseFloor ? 0 : v))
  const smoothed = smoothDisplaySeries(cleaned, 1)

  // Collapse consecutive zeros to a single point — long zero runs make Baseline
  // fill paths self-intersect at the clip edge (the “squiggle” artifact).
  const realPoints: SingleValueData<number>[] = []
  const displayValues: number[] = []
  for (let i = 0; i < deduped.length; i += 1) {
    const v = smoothed[i] ?? cleaned[i] ?? 0
    if (!Number.isFinite(v)) continue
    const strike = deduped[i]!.strike
    if (!Number.isFinite(strike)) continue
    const prev = realPoints[realPoints.length - 1]
    if (prev && prev.time === strike) {
      prev.value = v
      displayValues[displayValues.length - 1] = v
      continue
    }
    // Skip redundant zeros in the middle of a zero run (keep first & last of run).
    if (v === 0 && prev && prev.value === 0) {
      const nextRaw = smoothed[i + 1] ?? cleaned[i + 1]
      if (nextRaw === 0 || (nextRaw != null && Math.abs(nextRaw) < noiseFloor)) {
        continue
      }
      prev.time = strike
      prev.value = 0
      displayValues[displayValues.length - 1] = 0
      continue
    }
    realPoints.push({ time: strike, value: v })
    displayValues.push(v)
  }

  // Axis anchors only outside the real segment — labels empty flanks without
  // breaking the continuous profile path with mid-ladder whitespace.
  const realStrikes = realPoints.map((p) => p.time as number)
  let seriesStrikes = handle.seriesStrikes
  if (ladderChanged || seriesStrikes.length === 0) {
    seriesStrikes = extendStrikesWithAxisAnchors(realStrikes, options?.spot)
    handle.seriesStrikes = seriesStrikes
  }
  const realByStrike = new Map(realPoints.map((p) => [p.time as number, p]))
  const points: Array<SingleValueData<number> | { time: number }> = seriesStrikes.map((strike) => {
    const real = realByStrike.get(strike)
    if (real) return real
    return { time: strike } // whitespace — tick only
  })

  const dataSig = points
    .map((p) => {
      if (!('value' in p) || p.value == null) return `${p.time}:_`
      return `${p.time}:${Math.round((p.value as number) / 1_000)}`
    })
    .join('|')

  if (
    dataSig === handle.dataSig
    && !windowChanged
    && !ladderChanged
    && options?.fit !== true
  ) {
    return
  }
  handle.dataSig = dataSig

  handle.displayValues = displayValues
  options?.syncDisplayValues?.(displayValues)

  const ts = handle.chart.timeScale()
  const prevLogical = ts.getVisibleLogicalRange()
  const prevTimeRange = ts.getVisibleRange()

  handle.series.setData(points as SingleValueData<number>[])

  // Y autoscale only — do not touch the X camera here.
  try {
    handle.series.priceScale().applyOptions({ autoScale: true })
  } catch {
    // ignore
  }

  if (windowChanged) {
    handle.userAdjustedRange = false
    applyProgrammaticRange(handle, () => {
      fitStrikeContent(handle.chart, seriesStrikes, options?.spot, options?.dataWindowPct)
    })
    handle.hasInitialFit = true
  } else if ((options?.fit === true || !handle.hasInitialFit) && !handle.userAdjustedRange) {
    applyProgrammaticRange(handle, () => {
      fitStrikeContent(handle.chart, seriesStrikes, options?.spot, options?.dataWindowPct)
    })
    handle.hasInitialFit = true
  } else {
    restoreVisibleStrikeRange(handle, prevTimeRange, prevLogical)
  }
}

/**
 * Crop leading/trailing near-zero GEX so the series (and axis) end where
 * inventory actually lives — e.g. stop around ~130k instead of empty 250k.
 *
 * When `lock` is set (prior live trim), expand-only: never shrink the ladder
 * on a refresh so edges don't flicker in and out.
 */
function trimGexLadder(
  data: ChartDatum[],
  lock?: { loStrike: number | null; hiStrike: number | null } | null,
): ChartDatum[] {
  if (data.length <= 2) return data
  const abs = data.map((d) => Math.abs(d.displayGexUsd || d.netGexUsd || 0))
  const peak = Math.max(1, ...abs)
  const floor = peak * 0.008 // 0.8% of peak — dead wings
  let lo = 0
  let hi = data.length - 1
  while (lo < hi && abs[lo]! < floor) lo += 1
  while (hi > lo && abs[hi]! < floor) hi -= 1
  // Keep a couple of buffer strikes so walls aren't flush to the frame edge.
  lo = Math.max(0, lo - 2)
  hi = Math.min(data.length - 1, hi + 2)

  const lockLo = lock?.loStrike
  const lockHi = lock?.hiStrike
  if (lockLo != null && lockHi != null && lockHi >= lockLo) {
    // Expand to cover the previous live window.
    while (lo > 0 && data[lo - 1]!.strike >= lockLo) lo -= 1
    while (hi < data.length - 1 && data[hi + 1]!.strike <= lockHi) hi += 1
    // If lock is outside current array (stale), clamp by finding nearest.
    for (let i = 0; i < data.length; i += 1) {
      if (data[i]!.strike <= lockLo) lo = Math.min(lo, i)
      if (data[i]!.strike >= lockHi) {
        hi = Math.max(hi, i)
        break
      }
    }
    // Also include any strike still within the locked span.
    for (let i = 0; i < data.length; i += 1) {
      const s = data[i]!.strike
      if (s >= lockLo && s <= lockHi) {
        lo = Math.min(lo, i)
        hi = Math.max(hi, i)
      }
    }
  }

  return data.slice(lo, hi + 1)
}

/**
 * Low-side axis anchors only (labels for empty flanks below first real strike).
 * Never extend past dataMax — that was producing phantom 150k–250k ticks.
 * High-side empty flanks for spot-centering are pure camera whitespace.
 */
function extendStrikesWithAxisAnchors(dataStrikes: number[], spot?: number): number[] {
  const sorted = dataStrikes
    .filter((s) => Number.isFinite(s) && s > 0)
    .slice()
    .sort((a, b) => a - b)
  if (sorted.length === 0) return []

  const dataMin = sorted[0]!
  const dataMax = sorted[sorted.length - 1]!

  // How far left of dataMin do we need labels for spot-centered full zoom-out?
  let lo = dataMin
  if (spot != null && spot > 0) {
    const half = Math.max(spot - dataMin, dataMax - spot, 1)
    lo = Math.min(lo, spot - half * 1.12)
  }
  lo = Math.max(5_000, lo)

  const span = Math.max(dataMax - lo, 1)
  let step = 5_000
  if (span > 200_000) step = 25_000
  else if (span > 100_000) step = 10_000
  else if (span > 50_000) step = 5_000
  else step = 2_500

  const set = new Set(sorted)
  const start = Math.floor(lo / step) * step
  for (let s = start; s < dataMin; s += step) {
    if (s >= 5_000) set.add(s)
  }
  if (dataMin >= 45_000) {
    for (const s of [20_000, 25_000, 30_000, 35_000, 40_000, 45_000, 50_000]) {
      if (s < dataMin && s >= lo - step) set.add(s)
    }
  }

  return [...set].sort((a, b) => a - b)
}

function applyProgrammaticRange(
  handle: { programmaticRange: boolean },
  fn: () => void,
) {
  handle.programmaticRange = true
  try {
    fn()
  } finally {
    // Defer clear so LWC range-change callbacks from this call are ignored.
    queueMicrotask(() => {
      handle.programmaticRange = false
    })
  }
}

function restoreVisibleStrikeRange(
  handle: { chart: IChartApiBase<number>; programmaticRange: boolean },
  prevTime: { from: number; to: number } | null,
  prevLogical?: { from: number | Logical; to: number | Logical } | null,
) {
  const ts = handle.chart.timeScale()

  const apply = () => {
    // Prefer logical range when the ladder is stable — avoids price-range
    // re-snaps that look like horizontal jitter after setData.
    if (prevLogical) {
      const from = Number(prevLogical.from)
      const to = Number(prevLogical.to)
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
        try {
          ts.setVisibleLogicalRange({ from: from as Logical, to: to as Logical })
          return true
        } catch {
          // fall through to time range
        }
      }
    }
    if (prevTime) {
      const from = Number(prevTime.from)
      const to = Number(prevTime.to)
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
        try {
          ts.setVisibleRange({ from, to })
          return true
        } catch {
          return false
        }
      }
    }
    return false
  }

  applyProgrammaticRange(handle, () => {
    apply()
  })

  // setData can reset the camera one frame later — re-apply only if it drifted.
  requestAnimationFrame(() => {
    const targetLogical = prevLogical
      ? { from: Number(prevLogical.from), to: Number(prevLogical.to) }
      : null
    if (!targetLogical || !(targetLogical.to > targetLogical.from)) return
    const now = ts.getVisibleLogicalRange()
    if (
      now
      && Math.abs(Number(now.from) - targetLogical.from) < 0.02
      && Math.abs(Number(now.to) - targetLogical.to) < 0.02
    ) {
      return
    }
    applyProgrammaticRange(handle, () => {
      apply()
    })
  })
}

/**
 * Mild triangular moving average for profile display.
 * Radius 1 ≈ 3-point window — calms chatter without overshooting walls.
 */
function smoothDisplaySeries(values: number[], radius = 1): number[] {
  if (values.length <= 2 || radius <= 0) return values.slice()
  const out = new Array<number>(values.length)
  for (let i = 0; i < values.length; i += 1) {
    let wSum = 0
    let vSum = 0
    for (let k = -radius; k <= radius; k += 1) {
      const j = i + k
      if (j < 0 || j >= values.length) continue
      const w = radius + 1 - Math.abs(k)
      wSum += w
      vSum += values[j]! * w
    }
    out[i] = wSum > 0 ? vSum / wSum : values[i]!
  }
  return out
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Shared geometry / interaction
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Fit / window the visible strike range with **spot centered** in the viewport.
 *
 * Empty flanks past first/last real strike are intentional so the live index
 * stays mid-pane even when the book is asymmetric around spot. Does not invent
 * GEX bars — only logical camera range.
 */
function fitStrikeContent(
  chart: IChartApiBase<number>,
  strikes?: number[],
  spot?: number,
  dataWindowPct?: number | 'full',
) {
  const rows = strikes ?? []
  if (rows.length === 0) {
    chart.timeScale().fitContent()
    return
  }

  const last = rows.length - 1
  const spotLogical =
    spot != null && spot > 0 ? strikeToLogical(rows, spot) : null

  if (spotLogical != null) {
    let halfSpan: number

    if (dataWindowPct != null && dataWindowPct !== 'full') {
      const windowPct = normalizeWindowPct(dataWindowPct)
      const lo = spot! * (1 - windowPct / 100)
      const hi = spot! * (1 + windowPct / 100)
      const loLog = strikeToLogical(rows, lo) ?? 0
      const hiLog = strikeToLogical(rows, hi) ?? last
      // Symmetric around spot so the index line sits dead-center.
      halfSpan = Math.max(
        Math.abs(spotLogical - loLog),
        Math.abs(hiLog - spotLogical),
        1,
      )
      halfSpan *= 1.03
    } else {
      // Full ladder + breathing room, still spot-centered.
      halfSpan = Math.max(spotLogical - 0, last - spotLogical, 1) * 1.12
    }

    halfSpan = Math.max(halfSpan, 1)
    chart.timeScale().setVisibleLogicalRange({
      from: (spotLogical - halfSpan) as Logical,
      to: (spotLogical + halfSpan) as Logical,
    })
    return
  }

  // No usable spot: fit the book with a light edge pad.
  chart.timeScale().fitContent()
  const range = chart.timeScale().getVisibleLogicalRange()
  if (!range || !Number.isFinite(Number(range.from)) || !Number.isFinite(Number(range.to))) return
  const span = Math.max(Number(range.to) - Number(range.from), 1)
  const pad = Math.max(0.4, Math.min(1.5, span * 0.02))
  chart.timeScale().setVisibleLogicalRange({
    from: (Number(range.from) - pad) as Logical,
    to: (Number(range.to) + pad) as Logical,
  })
}

/**
 * Soft clamp for pan/zoom.
 * Allows empty flanks so spot can stay centered; only limits span and keeps
 * some of the series in view when the user pans completely off-book.
 */
function clampLogicalRange(
  range: LogicalRange,
  n: number,
  spotLogical?: number | null,
): LogicalRange {
  if (n <= 0) return range
  let from = Number(range.from)
  let to = Number(range.to)
  let span = Math.max(to - from, 0.5)

  const last = n - 1
  const minSpan = 2
  const halfData =
    spotLogical != null
      ? Math.max(spotLogical - 0, last - spotLogical, 1)
      : Math.max(last / 2, 1)
  // Zoom-out ceiling: entire book + margin with room for a centered spot.
  const maxSpan = halfData * 2 * 1.25

  if (span > maxSpan) {
    const mid = spotLogical != null ? spotLogical : (from + to) / 2
    span = maxSpan
    from = mid - span / 2
    to = mid + span / 2
  } else if (span < minSpan) {
    const mid = spotLogical != null ? spotLogical : (from + to) / 2
    span = minSpan
    from = mid - span / 2
    to = mid + span / 2
  }

  // Keep at least a sliver of the series in view (do not hard-clamp edges to
  // [0, last] — that breaks spot-centered zoom on asymmetric books).
  if (to < 0) {
    to = Math.min(span * 0.12, last)
    from = to - span
  }
  if (from > last) {
    from = Math.max(last - span * 0.12, 0)
    to = from + span
  }

  return { from: from as Logical, to: to as Logical }
}

function spotToCoordinate(
  chart: IChartApiBase<number>,
  strikes: number[],
  spot: number,
): number | null {
  if (!(spot > 0) || !Number.isFinite(spot) || strikes.length === 0) return null

  const direct = chart.timeScale().timeToCoordinate(spot)
  if (direct != null && Number.isFinite(direct as number)) {
    return direct as number
  }

  let lo = 0
  let hi = strikes.length - 1
  if (spot <= strikes[0]!) {
    return toFiniteCoord(chart.timeScale().logicalToCoordinate(0 as Logical))
  }
  if (spot >= strikes[hi]!) {
    return toFiniteCoord(chart.timeScale().logicalToCoordinate(hi as Logical))
  }

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (strikes[mid]! <= spot) lo = mid
    else hi = mid
  }

  const s0 = strikes[lo]!
  const s1 = strikes[hi]!
  const x0 = chart.timeScale().logicalToCoordinate(lo as Logical)
  const x1 = chart.timeScale().logicalToCoordinate(hi as Logical)
  if (x0 == null || x1 == null || !Number.isFinite(x0 as number) || !Number.isFinite(x1 as number)) {
    return null
  }
  if (s1 === s0) return x0 as number
  const t = (spot - s0) / (s1 - s0)
  return (x0 as number) + t * ((x1 as number) - (x0 as number))
}

function toFiniteCoord(value: number | null): number | null {
  if (value == null || !Number.isFinite(value as number)) return null
  return value as number
}

/**
 * Wheel zoom that keeps the spot line dead-center in the viewport.
 * Shift+wheel is reserved for data-window % (handled separately).
 */
function makeSpotAnchoredWheelHandler(opts: {
  getHandle: () => { chart: IChartApiBase<number>; seriesStrikes?: number[] } | null
  getStrikes: () => number[]
  getSpot: () => number
  onAfter: () => void
  disposed: () => boolean
}) {
  return (event: WheelEvent) => {
    if (opts.disposed()) return
    if (event.shiftKey) return // data-window zoom owns shift+wheel
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, select, [role="dialog"]')) return

    const handle = opts.getHandle()
    const strikes = opts.getStrikes()
    if (!handle || strikes.length < 2) return

    event.preventDefault()
    event.stopPropagation()

    const ts = handle.chart.timeScale()
    const range = ts.getVisibleLogicalRange()
    if (!range || !Number.isFinite(Number(range.from)) || !Number.isFinite(Number(range.to))) return

    const from0 = Number(range.from)
    const to0 = Number(range.to)
    const span = to0 - from0
    if (!(span > 0)) return

    const spot = opts.getSpot()
    const spotLogical = strikeToLogical(strikes, spot)
    const n = strikes.length
    const last = n - 1
    const anchor = spotLogical ?? (from0 + to0) / 2
    // Cap zoom-out: entire book on both sides of spot + margin (empty flanks OK).
    const halfData = Math.max(anchor - 0, last - anchor, 1)
    const maxSpan = halfData * 2 * 1.25

    // Zoom factor — wheel down = zoom out
    const zoom = Math.exp(event.deltaY * 0.00135)
    const nextSpan = Math.max(2, Math.min(maxSpan, span * zoom))

    // Always re-center on spot (fallback: current viewport mid).
    const from = anchor - nextSpan * 0.5
    const to = from + nextSpan
    const clamped = clampLogicalRange(
      { from: from as Logical, to: to as Logical },
      n,
      spotLogical,
    )
    ts.setVisibleLogicalRange(clamped)
    opts.onAfter()
  }
}

/**
 * Map a strike price onto the series logical index.
 * Extrapolates past the first/last ladder points so empty flanks (and windows
 * that extend past the book) stay linear with bar spacing.
 */
function strikeToLogical(strikes: number[], strike: number): number | null {
  if (strikes.length === 0 || !Number.isFinite(strike)) return null
  const last = strikes.length - 1
  if (strikes.length === 1) {
    const only = strikes[0]!
    if (strike === only) return 0
    const step = Math.max(only * 0.01, 500)
    return (strike - only) / step
  }

  if (strike < strikes[0]!) {
    const step = Math.max(strikes[1]! - strikes[0]!, 1)
    return (strike - strikes[0]!) / step
  }
  if (strike > strikes[last]!) {
    const step = Math.max(strikes[last]! - strikes[last - 1]!, 1)
    return last + (strike - strikes[last]!) / step
  }

  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (strikes[mid]! <= strike) lo = mid
    else hi = mid
  }
  const s0 = strikes[lo]!
  const s1 = strikes[hi]!
  if (s1 === s0) return lo
  return lo + (strike - s0) / (s1 - s0)
}

/** Label top-N walls by |net GEX| when they clear a quiet threshold. */
function computeWallCallouts(
  chart: IChartApiBase<number>,
  series: { priceToCoordinate: (price: number) => number | null },
  data: ChartDatum[],
): WallCallout[] {
  if (data.length < 3) return []
  const ranked = [...data]
    .filter((d) => Number.isFinite(d.netGexUsd) && d.netGexUsd !== 0)
    .sort((a, b) => Math.abs(b.netGexUsd) - Math.abs(a.netGexUsd))
  if (ranked.length === 0) return []

  const maxAbs = Math.abs(ranked[0]!.netGexUsd)
  const floor = maxAbs * 0.42 // only meaningful walls
  const tops = ranked.filter((d) => Math.abs(d.netGexUsd) >= floor).slice(0, WALL_CALLOUT_MAX)

  const out: WallCallout[] = []
  for (const d of tops) {
    const x = chart.timeScale().timeToCoordinate(d.strike)
    const y = series.priceToCoordinate(d.netGexUsd)
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push({
      strike: d.strike,
      netGexUsd: d.netGexUsd,
      x: x as number,
      y: y as number,
      side: d.netGexUsd >= 0 ? 'above' : 'below',
    })
  }
  return out
}

function dedupeByStrike(data: ChartDatum[]): ChartDatum[] {
  if (data.length <= 1) return data
  const out: ChartDatum[] = []
  for (const row of data) {
    const prev = out[out.length - 1]
    if (prev && prev.strike === row.strike) {
      out[out.length - 1] = row
    } else {
      out.push(row)
    }
  }
  return out
}

function normalizeRenderMode(mode: GexMode): 'net' | 'profile' {
  if (mode === 'profile') return 'profile'
  return 'net'
}

function formatStrikeTick(strike: number): string {
  if (!Number.isFinite(strike)) return ''
  const rounded = Math.round(strike)
  if (Math.abs(rounded) >= 1000) {
    const k = rounded / 1000
    // Whole thousands: "65k"
    if (Math.abs(k - Math.round(k)) < 1e-6) return `${Math.round(k)}k`
    // Exact half-thousands: "62.5k"
    const half = Math.round(k * 2) / 2
    if (Math.abs(k - half) < 1e-6) {
      return Number.isInteger(half) ? `${half}k` : `${half.toFixed(1)}k`
    }
    // Do NOT snap to nearest 1k — colliding labels ("58k"×N) make LWC drop ticks
    // and leave a nearly empty axis with one leftover mark.
    return `${Math.round(k * 10) / 10}k`
  }
  return formatStrike(rounded)
}

function prepareChartData(
  snapshot: GexSnapshot,
  mode: 'net' | 'profile',
): ChartDatum[] {
  const sourceRows = snapshot.gammaBars
  const visibleRows = mode === 'profile' ? sourceRows : getReadableStrikeRows(sourceRows)
  return visibleRows
    .map((row) => toChartDatum(row))
    .sort((a, b) => a.strike - b.strike)
}

function getReadableStrikeRows(rows: GexSourceRow[]) {
  if (rows.length <= 48) return rows
  const halfStrikeRows = rows.filter((row) => row.strike % 500 === 0)
  if (halfStrikeRows.length >= 16) return halfStrikeRows
  const quarter = rows.filter((row) => row.strike % 250 === 0)
  return quarter.length > 0 ? quarter : rows
}

function normalizeWindowPct(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 18
}

function toChartDatum(row: GexSourceRow): ChartDatum {
  const call = row.callGammaExposureUsd ?? 0
  const put = row.putGammaExposureUsd ?? 0
  const net = row.netGammaExposureUsd ?? row.gammaExposureUsd ?? call + put
  const gross = Math.abs(call) + Math.abs(put)
  return {
    strike: row.strike,
    netGexUsd: net,
    callGexUsd: call,
    putGexUsd: put,
    grossGexUsd: gross,
    displayGexUsd: net,
  }
}

function findNearestDatum(data: ChartDatum[], strike: number): ChartDatum | null {
  if (data.length === 0) return null
  let best = data[0]!
  let bestDist = Math.abs(best.strike - strike)
  for (let i = 1; i < data.length; i += 1) {
    const dist = Math.abs(data[i]!.strike - strike)
    if (dist < bestDist) {
      best = data[i]!
      bestDist = dist
    }
  }
  return best
}

/**
 * Shift+wheel adjusts the ±% data window (parent state).
 * Plain wheel is handled by spot-anchored zoom on the chart host.
 */
function useDataWindowWheelZoom(
  containerRef: RefObject<HTMLDivElement | null>,
  dataWindowPct: number | 'full',
  onDataWindowPctChange?: (pct: number) => void,
) {
  const pctRef = useRef(dataWindowPct)
  const rafRef = useRef(0)
  const pendingRef = useRef<number | null>(null)

  useEffect(() => {
    pctRef.current = dataWindowPct
  }, [dataWindowPct])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !onDataWindowPctChange) return

    const onWheel = (event: WheelEvent) => {
      if (!event.shiftKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('button, input, select, [role="dialog"]')) return
      event.preventDefault()
      event.stopPropagation()
      const current = pctRef.current === 'full' ? 100 : normalizeWindowPct(pctRef.current)
      const next = clampProfileWindowPct(current + event.deltaY * 0.035)
      pendingRef.current = next
      if (rafRef.current) return
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0
        if (pendingRef.current === null) return
        const value = pendingRef.current
        pendingRef.current = null
        pctRef.current = value
        onDataWindowPctChange(value)
      })
    }

    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
    }
  }, [containerRef, onDataWindowPctChange])
}

function clampProfileWindowPct(value: number) {
  if (!Number.isFinite(value)) return 18
  return Math.min(100, Math.max(1, Math.round(value * 10) / 10))
}

function ChartTitleOverlay({
  subtitle,
  title,
  titleAccessory,
}: {
  subtitle?: string
  title: string
  titleAccessory?: ReactNode
}) {
  if (!title && !titleAccessory) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-9 min-w-0 items-center gap-2 px-2.5">
      {title ? (
        <div className="min-w-0 flex-1 overflow-hidden pr-1">
          <div className="terminal-title truncate tracking-[0.12em]">{title}</div>
          {subtitle ? (
            <div className="terminal-meta mt-0.5 truncate tracking-[0.1em] opacity-80">
              {subtitle}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      {titleAccessory ? (
        <div className="pointer-events-auto flex shrink-0 items-center self-center">
          {titleAccessory}
        </div>
      ) : null}
    </div>
  )
}

function measure(el: HTMLElement) {
  const w = Math.max(el.clientWidth || 0, minChartWidth)
  const h = Math.max(el.clientHeight || 0, 80)
  return { w, h }
}
