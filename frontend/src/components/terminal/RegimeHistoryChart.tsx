import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
  type TimeScaleOptions,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts'
import { MiniChartTimeAxis } from '@/components/terminal/MiniChartTimeAxis'
import type { VolSeriesPoint } from '@/data/mockTerminal'
import {
  createDynamicMiniChartPriceFormat,
  resolveMiniChartAxisStep,
  type MiniChartAxisStepRef,
} from '@/data/miniChartAxis'
import { readVolChartColors, type VolChartColors } from '@/data/volChartTheme'
import {
  padMiniChartRangeBounds,
  resolveMiniChartRangeBounds,
  type MiniChartRange,
  type MiniChartRangeBounds,
} from '@/data/miniChartRange'
import { cn } from '@/lib/utils'

export type RegimeHistoryTone =
  | 'rv-fast'
  | 'rv-slow'
  | 'skew-1w'
  | 'skew-1m'
  | 'skew-3m'
  | 'skew-6m'
  | 'neutral'

export type RegimeHistorySeries = {
  id: string
  label: string
  data: VolSeriesPoint[]
  tone: RegimeHistoryTone
  dashed?: boolean
  visible?: boolean
  /** Convert stored decimals to the displayed scale, e.g. normalized skew ×100. */
  valueMultiplier?: number
}

type RegimeHistoryChartProps = {
  series: RegimeHistorySeries[]
  unit: 'vol-percent' | 'normalized-percent' | 'vol-points'
  range: MiniChartRange
  /** Optional fixed viewport; used by UTC-session charts instead of latest-point lookback. */
  fixedBounds?: MiniChartRangeBounds | null
  timeZone?: string
  zeroGuide?: boolean
  className?: string
}

type HistoryHandle = {
  chart: IChartApi
  series: Map<string, ISeriesApi<'Line'>>
  rangeAnchor: ISeriesApi<'Line'>
  axisStep: MiniChartAxisStepRef
}

type HistoryHoverLabel = {
  id: string
  text: string
  tone: RegimeHistoryTone
  top: number
  left: number
  pointTop: number
  pointLeft: number
}

type HistoryAxisLabel = {
  id: string
  text: string
  top: number
}

const HISTORY_CHART_TIME_ZONE = 'America/New_York'

/** Fixed-range, theme-aware history chart shared by skew and RV analytics. */
export function RegimeHistoryChart({
  series,
  unit,
  range,
  fixedBounds,
  timeZone = HISTORY_CHART_TIME_ZONE,
  zeroGuide = false,
  className,
}: RegimeHistoryChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<HistoryHandle | null>(null)
  const seriesRef = useRef(series)
  const [hoverLabels, setHoverLabels] = useState<HistoryHoverLabel[]>([])
  const [axisLabels, setAxisLabels] = useState<HistoryAxisLabel[]>([])
  const definitionKey = useMemo(
    () => series.map((item) => `${item.id}:${item.tone}:${item.dashed ? 1 : 0}`).join('|'),
    [series],
  )
  const resolvedBounds = useMemo(
    () => resolveMiniChartRangeBounds(range, series.map((item) => item.data)),
    [range, series],
  )
  const bounds = fixedBounds === undefined ? resolvedBounds : fixedBounds
  const boundsRef = useRef(bounds)
  const viewportBounds = useMemo(
    () => bounds ? padMiniChartRangeBounds(bounds) : null,
    [bounds],
  )
  const visibilityKey = useMemo(
    () => series.map((item) => `${item.id}:${item.visible === false ? 0 : 1}`).join('|'),
    [series],
  )
  const axisStepValue = useMemo(() => resolveMiniChartAxisStep(
    series.flatMap((item) => {
      if (item.visible === false) return []
      const multiplier = item.valueMultiplier ?? 1
      return item.data.flatMap((point) => {
        const tsMs = point.tsMs > 1e12 ? point.tsMs : point.tsMs * 1000
        if (!Number.isFinite(point.value)) return []
        if (bounds && (tsMs < bounds.fromMs || tsMs > bounds.toMs)) return []
        return [point.value * multiplier]
      })
    }),
    historyAxisFloorStep(unit),
    5,
  ), [bounds, series, unit])

  useEffect(() => {
    seriesRef.current = series
  }, [series])

  useEffect(() => {
    boundsRef.current = bounds
  }, [bounds])

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    wrapper.classList.remove('regime-history-chart--updating')
    void wrapper.offsetWidth
    wrapper.classList.add('regime-history-chart--updating')
    const timer = window.setTimeout(() => {
      wrapper.classList.remove('regime-history-chart--updating')
    }, 190)
    return () => window.clearTimeout(timer)
  }, [bounds?.fromMs, bounds?.toMs, range, visibilityKey])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let resizeFrame = 0
    let hoverFrame = 0
    let pendingCrosshair: MouseEventParams | null = null
    const colors = readVolChartColors(host)
    const chart = createChart(host, {
      width: Math.max(2, host.clientWidth),
      height: Math.max(2, host.clientHeight),
      localization: {
        locale: 'en-US',
        timeFormatter: (time: Time) => formatHistoryCrosshairTime(time, timeZone),
      },
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: colors.text,
        fontSize: 9,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        attributionLogo: false,
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
        visible: false,
        borderVisible: false,
        scaleMargins: { top: 0.16, bottom: 0.16 },
        entireTextOnly: true,
        textColor: 'rgba(0, 0, 0, 0)',
      },
      timeScale: {
        visible: true,
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 0,
        shiftVisibleRangeOnNewBar: false,
        lockVisibleTimeRangeOnResize: true,
        minBarSpacing: 0.3,
        allowBoldLabels: false,
        ticksVisible: false,
        tickMarkMaxCharacterLength: 6,
      },
      handleScroll: false,
      handleScale: false,
    })

    const chartSeries = new Map<string, ISeriesApi<'Line'>>()
    const axisStep: MiniChartAxisStepRef = { current: axisStepValue }
    const historyPriceFormat = createDynamicMiniChartPriceFormat(
      axisStep,
      unit === 'normalized-percent' ? formatSignedAxisPercent : unit === 'vol-points' ? formatAxisPoints : formatAxisPercent,
      axisStepValue,
    )
    const definitions = definitionKey
      ? definitionKey.split('|').map((value) => {
          const [id, tone, dashed] = value.split(':')
          return {
            id: id!,
            tone: tone as RegimeHistoryTone,
            dashed: dashed === '1',
          }
        })
      : []

    for (const item of definitions) {
      const line = chart.addSeries(LineSeries, {
        color: colorForTone(colors, item.tone),
        lineWidth: 1,
        lineStyle: item.dashed ? LineStyle.Dashed : LineStyle.Solid,
        lineType: LineType.Simple,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 2,
        crosshairMarkerBorderWidth: 0,
        priceFormat: historyPriceFormat,
      })
      chartSeries.set(item.id, line)
    }

    // A regular whitespace grid makes the horizontal scale truly chronological
    // even when the underlying history is sparse or only recently started.
    const rangeAnchor = chart.addSeries(LineSeries, {
      priceScaleId: 'range-anchor',
      color: 'rgba(0, 0, 0, 0)',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })

    if (zeroGuide) {
      const guideSeries = chart.addSeries(LineSeries, {
        color: 'rgba(0, 0, 0, 0)',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      })
      guideSeries.createPriceLine({
        price: 0,
        color: colors.zero,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: '',
      })
    }

    handleRef.current = { chart, series: chartSeries, rangeAnchor, axisStep }
    chart.timeScale().applyOptions({
      tickMarkFormatter: () => '',
    } as Partial<TimeScaleOptions>)

    const clearCrosshair = () => {
      setHoverLabels((current) => current.length === 0 ? current : [])
    }
    const updateCrosshair = (param: MouseEventParams) => {
      if (
        disposed
        || !param.point
        || param.time === undefined
        || param.point.x < 0
        || param.point.y < 0
      ) {
        clearCrosshair()
        return
      }

      const hoverMs = historyTimeToEpochMs(param.time)
      const pointLeft = param.point.x
      const labelLeft = Math.min(
        Math.max(12, pointLeft + 10),
        Math.max(12, host.clientWidth - 72),
      )
      const labels: HistoryHoverLabel[] = []
      for (const item of seriesRef.current) {
        if (item.visible === false) continue
        const line = chartSeries.get(item.id)
        if (!line) continue
        const multiplier = item.valueMultiplier ?? 1
        const value = readHistorySeriesValue(line, param)
          ?? multiplyFinite(interpolateHistoryValue(item.data, hoverMs), multiplier)
        if (value == null) continue
        const y = line.priceToCoordinate(value)
        if (y == null || !Number.isFinite(y)) continue
        labels.push({
          id: item.id,
          text: unit === 'normalized-percent'
            ? formatSignedHoverPercent(value)
            : unit === 'vol-points' ? `${value.toFixed(2)} pts` : formatHoverPercent(value),
          tone: item.tone,
          top: Math.max(8, Math.min(host.clientHeight - 18, y)),
          left: labelLeft,
          pointTop: y,
          pointLeft,
        })
      }
      setHoverLabels(spreadHistoryHoverLabels(labels, host.clientHeight))
    }
    const onCrosshair = (param: MouseEventParams) => {
      pendingCrosshair = param
      if (hoverFrame) return
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0
        const next = pendingCrosshair
        pendingCrosshair = null
        if (next) updateCrosshair(next)
      })
    }
    chart.subscribeCrosshairMove(onCrosshair)
    host.addEventListener('mouseleave', clearCrosshair)

    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (disposed) return
        chart.resize(Math.max(2, host.clientWidth), Math.max(2, host.clientHeight), true)
        requestAnimationFrame(() => {
          if (disposed || !handleRef.current) return
          setAxisLabels(buildHistoryAxisLabels(
            handleRef.current,
            seriesRef.current,
            boundsRef.current,
            unit,
          ))
        })
      })
    })
    resizeObserver.observe(host)

    return () => {
      disposed = true
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      if (hoverFrame) cancelAnimationFrame(hoverFrame)
      resizeObserver.disconnect()
      host.removeEventListener('mouseleave', clearCrosshair)
      try {
        chart.unsubscribeCrosshairMove(onCrosshair)
      } catch {
        // Chart may already be disposed during a rapid panel switch.
      }
      handleRef.current = null
      chart.remove()
      host.replaceChildren()
    }
  }, [axisStepValue, definitionKey, timeZone, unit, zeroGuide])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    applyHistoryData(handle, series, bounds, unit)
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (handleRef.current !== handle) return
        setAxisLabels(buildHistoryAxisLabels(handle, series, bounds, unit))
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [bounds, series, unit])

  return (
    <div ref={wrapperRef} className={cn('regime-history-chart', className)}>
      <div
        ref={hostRef}
        className="regime-history-chart__canvas"
      />
      {bounds ? (
        <MiniChartTimeAxis
          bounds={bounds}
          viewportBounds={viewportBounds ?? bounds}
          timeZone={timeZone}
          className="regime-mini-time-axis regime-mini-time-axis--overlay regime-history-chart__time-axis"
        />
      ) : null}
      <div className="regime-vol__fixed-axis-labels" aria-hidden>
        {axisLabels.map((label) => (
          <span
            key={label.id}
            className="regime-vol__fixed-axis-label regime-vol__fixed-axis-label--right"
            style={{ top: label.top }}
          >
            {label.text}
          </span>
        ))}
      </div>
      <div className="regime-vol__hover-labels" aria-hidden>
        {hoverLabels.map((label) => (
          <Fragment key={label.id}>
            <span
              className={`regime-vol__hover-point regime-history-chart__hover--${label.tone}`}
              style={{ top: label.pointTop, left: label.pointLeft }}
            />
            <span
              className={`regime-vol__hover-label regime-history-chart__hover--${label.tone}`}
              style={{ top: label.top, left: label.left }}
            >
              {label.text}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

function applyHistoryData(
  handle: HistoryHandle,
  series: RegimeHistorySeries[],
  bounds: MiniChartRangeBounds | null,
  unit: RegimeHistoryChartProps['unit'],
) {
  const viewBounds = bounds ? padMiniChartRangeBounds(bounds) : null
  const grid = viewBounds ? buildTimeGrid(viewBounds) : []
  handle.rangeAnchor.setData(grid.map((time) => ({ time })))

  const prepared = series.map((item) => ({
    item,
    data: cleanSeries(item.data, item.valueMultiplier ?? 1, bounds, grid),
  }))
  const visibleValues = prepared.flatMap(({ item, data }) => (
    item.visible === false
      ? []
      : data.flatMap((point) => ('value' in point ? [point.value] : []))
  ))
  handle.axisStep.current = resolveMiniChartAxisStep(
    visibleValues,
    historyAxisFloorStep(unit),
    5,
  )

  for (const { item, data } of prepared) {
    const line = handle.series.get(item.id)
    if (!line) continue
    line.setData(data)
    line.applyOptions({ visible: item.visible !== false, pointMarkersVisible: item.data.length === 1, pointMarkersRadius: 3 })
  }

  try {
    handle.chart.priceScale('right').applyOptions({ autoScale: true })
    requestAnimationFrame(() => {
      try {
        handle.chart.priceScale('right').applyOptions({ autoScale: true })
      } catch {
        // Chart may have unmounted before the settle frame.
      }
    })
  } catch {
    // Preserve the prior scale if the chart is between resize frames.
  }

  if (!bounds) return
  const from = Math.floor((viewBounds?.fromMs ?? bounds.fromMs) / 1000)
  const to = Math.max(from + 1, Math.ceil((viewBounds?.toMs ?? bounds.toMs) / 1000))
  try {
    handle.chart.timeScale().setVisibleRange({
      from: from as UTCTimestamp,
      to: to as UTCTimestamp,
    })
  } catch {
    // Keep the previous fixed viewport if Lightweight Charts rejects a transient range.
  }
}

function formatSignedAxisPercent(price: number, step: number): string {
  if (!Number.isFinite(price)) return ''
  const sign = price === 0 ? '' : price > 0 ? '+' : '−'
  return `${sign}${Math.abs(price).toFixed(axisDecimals(step))}%`
}

function formatAxisPercent(price: number, step: number): string {
  return Number.isFinite(price) ? `${price.toFixed(axisDecimals(step))}%` : ''
}

function formatAxisPoints(price: number, step: number): string {
  return Number.isFinite(price) ? `${price.toFixed(axisDecimals(step))} pts` : ''
}

function axisDecimals(step: number): number {
  return step < 1 || Math.abs(step - Math.round(step)) > 1e-6 ? 1 : 0
}

function cleanSeries(
  data: VolSeriesPoint[],
  multiplier: number,
  bounds: MiniChartRangeBounds | null,
  grid: UTCTimestamp[],
): Array<LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>> {
  const points: Array<{ sec: number; value: number; gapBefore?: boolean }> = []
  for (const point of data) {
    if (!Number.isFinite(point.tsMs) || !Number.isFinite(point.value)) continue
    const sec = Math.floor(point.tsMs / 1000)
    if (sec <= 0) continue
    if (bounds && (point.tsMs < bounds.fromMs || point.tsMs > bounds.toMs)) continue
    points.push({ sec, value: point.value * multiplier, gapBefore:point.gapBefore })
  }
  points.sort((a, b) => a.sec - b.sec)

  if (!bounds || grid.length < 2) {
    const byTime = new Map<number, number>()
    for (const point of points) byTime.set(point.sec, point.value)
    return Array.from(byTime.entries()).map(([time, value]) => ({
      time: time as UTCTimestamp,
      value,
    }))
  }

  const fromSec = Number(grid[0]!)
  const toSec = Number(grid[grid.length - 1]!)
  const spanSec = Math.max(1, toSec - fromSec)
  const bySlot = new Map<number, { time: UTCTimestamp; value: number; rawSec: number; gapBefore?: boolean }>()
  for (const point of points) {
    const slot = Math.max(0, Math.min(
      grid.length - 1,
      Math.round(((point.sec - fromSec) / spanSec) * (grid.length - 1)),
    ))
    bySlot.set(slot, { time: grid[slot]!, value: point.value, rawSec: point.sec, gapBefore:point.gapBefore || bySlot.get(slot)?.gapBefore })
  }

  const rows = Array.from(bySlot.entries()).sort((a, b) => a[0] - b[0])
  const rawSteps = rows
    .slice(1)
    .map(([, row], index) => row.rawSec - rows[index]![1].rawSec)
    .filter((step) => step > 0)
    .sort((a, b) => a - b)
  const medianStep = rawSteps.length > 0 ? rawSteps[Math.floor(rawSteps.length / 2)]! : 0
  const gridStep = spanSec / Math.max(1, grid.length - 1)
  const gapThreshold = Math.max(gridStep * 4, medianStep * 3, 900)
  const out: Array<LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>> = []
  rows.forEach(([, row], index) => {
    const previous = index > 0 ? rows[index - 1] : null
    if (previous && (row.gapBefore || row.rawSec - previous[1].rawSec > gapThreshold)) {
      const middle = Math.floor((Number(previous[1].time)+Number(row.time))/2) as UTCTimestamp
      if (middle > previous[1].time && middle < row.time) out.push({ time: middle })
    }
    out.push({ time: row.time, value: row.value })
  })
  return out
}

function buildTimeGrid(bounds: MiniChartRangeBounds): UTCTimestamp[] {
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

function colorForTone(colors: VolChartColors, tone: RegimeHistoryTone): string {
  switch (tone) {
    case 'rv-fast':
      return colors.rvFast
    case 'rv-slow':
      return colors.rvSlow
    case 'skew-1w':
      return colors.skew1w
    case 'skew-1m':
      return colors.skew1m
    case 'skew-3m':
      return colors.skew3m
    case 'skew-6m':
      return colors.skew6m
    case 'neutral':
      return colors.zPosLine
  }
}

const HISTORY_CROSSHAIR_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function historyCrosshairFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = HISTORY_CROSSHAIR_FORMATTERS.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  HISTORY_CROSSHAIR_FORMATTERS.set(timeZone, formatter)
  return formatter
}

function formatHistoryCrosshairTime(time: Time, timeZone: string): string {
  const ms = historyTimeToEpochMs(time)
  if (ms == null) return ''
  const parts: Record<string, string> = {}
  for (const part of historyCrosshairFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return `${parts.weekday ?? ''} ${parts.day ?? ''} ${parts.month ?? ''} '${parts.year ?? ''}  ${parts.hour ?? '00'}:${parts.minute ?? '00'}`
}

function historyTimeToEpochMs(time: Time): number | null {
  if (typeof time === 'number' && Number.isFinite(time)) return time * 1000
  if (typeof time === 'string') {
    const parsed = Date.parse(time)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (time && typeof time === 'object' && 'year' in time) {
    return Date.UTC(Number(time.year), Number(time.month) - 1, Number(time.day), 12)
  }
  return null
}

function readHistorySeriesValue(
  series: ISeriesApi<'Line'>,
  param: MouseEventParams,
): number | null {
  const raw = param.seriesData.get(series)
  if (!raw || typeof raw !== 'object') return null
  const value = (raw as { value?: number }).value
  return value != null && Number.isFinite(value) ? value : null
}

function interpolateHistoryValue(
  series: readonly VolSeriesPoint[],
  targetMs: number | null,
): number | null {
  if (targetMs == null || series.length === 0) return null
  const pointMs = (point: VolSeriesPoint | undefined) => {
    if (!point || !Number.isFinite(point.tsMs)) return Number.NaN
    return point.tsMs > 1e12 ? point.tsMs : point.tsMs * 1000
  }
  const firstMs = pointMs(series[0])
  const lastMs = pointMs(series[series.length - 1])
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || targetMs < firstMs || targetMs > lastMs) {
    return null
  }
  let low = 0
  let high = series.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (pointMs(series[middle]) < targetMs) low = middle + 1
    else high = middle
  }
  const right = series[low]
  if (!right || !Number.isFinite(right.value)) return null
  const rightMs = pointMs(right)
  if (low === 0 || rightMs === targetMs) return right.value
  if (right.gapBefore) return null
  const left = series[low - 1]
  if (!left || !Number.isFinite(left.value)) return null
  const leftMs = pointMs(left)
  const spanMs = rightMs - leftMs
  if (!(spanMs > 0)) return right.value
  const ratio = Math.max(0, Math.min(1, (targetMs - leftMs) / spanMs))
  return left.value + (right.value - left.value) * ratio
}

function multiplyFinite(value: number | null, multiplier: number): number | null {
  return value != null && Number.isFinite(value) ? value * multiplier : null
}

function formatSignedHoverPercent(value: number): string {
  const sign = value === 0 ? '' : value > 0 ? '+' : '−'
  return `${sign}${Math.abs(value).toFixed(1)}%`
}

function formatHoverPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

function buildHistoryAxisLabels(
  handle: HistoryHandle,
  series: RegimeHistorySeries[],
  bounds: MiniChartRangeBounds | null,
  unit: RegimeHistoryChartProps['unit'],
): HistoryAxisLabel[] {
  const visibleValues: number[] = []
  let coordinateSeries: ISeriesApi<'Line'> | null = null
  for (const item of series) {
    if (item.visible === false) continue
    coordinateSeries ??= handle.series.get(item.id) ?? null
    const multiplier = item.valueMultiplier ?? 1
    for (const point of item.data) {
      const tsMs = point.tsMs > 1e12 ? point.tsMs : point.tsMs * 1000
      if (!Number.isFinite(point.value)) continue
      if (bounds && (tsMs < bounds.fromMs || tsMs > bounds.toMs)) continue
      visibleValues.push(point.value * multiplier)
    }
  }
  if (!coordinateSeries || visibleValues.length === 0) return []

  const step = resolveMiniChartAxisStep(visibleValues, historyAxisFloorStep(unit), 5)
  const min = Math.min(...visibleValues)
  const max = Math.max(...visibleValues)
  const firstTick = Math.floor(min / step) * step
  const lastTick = Math.ceil(max / step) * step
  const paneHeight = Math.max(1, handle.chart.panes()[0]?.getHeight() ?? 1)
  const labels: HistoryAxisLabel[] = []
  for (let value = firstTick; value <= lastTick + step * 0.25; value += step) {
    const coordinate = coordinateSeries.priceToCoordinate(value)
    if (coordinate == null || !Number.isFinite(coordinate)) continue
    if (coordinate < 7 || coordinate > paneHeight - 7) continue
    labels.push({
      id: `history-axis-${value.toFixed(6)}`,
      text: unit === 'normalized-percent'
        ? formatSignedAxisPercent(value, step)
        : unit === 'vol-points' ? formatAxisPoints(value,step) : formatAxisPercent(value, step),
      top: coordinate,
    })
  }
  return labels
}

function historyAxisFloorStep(unit: RegimeHistoryChartProps['unit']): number {
  // Normalized skew reads best on whole percentage-point ticks. Rolling RV can
  // move by only a few tenths intraday, so retain enough precision to show a
  // useful scale when the 7D line is the only visible series.
  return unit === 'normalized-percent' ? 1 : 0.1
}

function spreadHistoryHoverLabels(
  labels: HistoryHoverLabel[],
  chartHeight: number,
): HistoryHoverLabel[] {
  if (labels.length < 2) return labels
  const minTop = 8
  const maxTop = Math.max(minTop, chartHeight - 18)
  const minGap = 11
  const sorted = labels
    .map((label) => ({ ...label, top: Math.max(minTop, Math.min(maxTop, label.top)) }))
    .sort((left, right) => left.pointTop - right.pointTop)

  for (let index = 1; index < sorted.length; index++) {
    sorted[index]!.top = Math.max(sorted[index]!.top, sorted[index - 1]!.top + minGap)
  }
  const overflow = sorted[sorted.length - 1]!.top - maxTop
  if (overflow > 0) {
    for (const label of sorted) label.top -= overflow
  }
  for (let index = sorted.length - 2; index >= 0; index--) {
    sorted[index]!.top = Math.min(sorted[index]!.top, sorted[index + 1]!.top - minGap)
  }
  const underflow = minTop - sorted[0]!.top
  if (underflow > 0) {
    for (const label of sorted) label.top += underflow
  }
  return sorted
}
