import {
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { VolSurface } from '@/data/mockTerminal'
import { useContainerSize } from '@/hooks/useContainerSize'
import { buildTermCurvePaths, buildTermCurveScale, frontElevationEndSlot } from '@/data/termCurveGeometry'

type TermTenor = '7D' | '30D' | '60D' | 'Long'

type TermPoint = {
  tenor: TermTenor
  slotIndex: number
  targetDays: number
  value: number
  source: string
  sourceKind: 'constant' | 'dvol-fallback' | 'legacy-expiry'
  dteDays: number | null
  expiryTsMs: number | null
  method: string | null
  lowerExpiryTsMs: number | null
  lowerDteDays: number | null
  upperExpiryTsMs: number | null
  upperDteDays: number | null
}

type TermBenchmark = {
  value: number
  label: string
  source: string
}

type TermData = {
  points: TermPoint[]
  benchmark: TermBenchmark | null
}

type TermCoord = {
  point: TermPoint
  x: number
  y: number
  labelY: number
}

type ChartGeometry = {
  coords: TermCoord[]
  min: number
  max: number
  ticks: number[]
  path: string
  areaPath: string
  benchmarkY: number | null
  plotTop: number
  plotRight: number
  plotBottom: number
  plotLeft: number
  dataLeft: number
  dataRight: number
  axisLabelX: number
  tenorY: number
}

type RegimeTermStructureChartProps = {
  surface: VolSurface | undefined
  dvol: number | null
  showDvol: boolean
  className?: string
}

const FALLBACK_W = 400
const FALLBACK_H = 210

const TERM_SLOTS: ReadonlyArray<{
  tenor: TermTenor
  key: string
  targetDays: number
}> = [
  { tenor: '7D', key: '7d', targetDays: 7 },
  { tenor: '30D', key: '30d', targetDays: 30 },
  { tenor: '60D', key: '60d', targetDays: 60 },
  { tenor: 'Long', key: '180d', targetDays: 180 },
]

const EXPIRY_LONG = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})

/** Current and independently selectable historical constant-maturity curves. */
export function RegimeTermStructureChart({
  surface,
  dvol,
  showDvol,
  className,
}: RegimeTermStructureChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const descriptionId = useId()
  const paintId = useId().replace(/:/g, '')
  const [hoveredTenor, setHoveredTenor] = useState<TermTenor | null>(null)
  const [focusedTenor, setFocusedTenor] = useState<TermTenor | null>(null)
  const { width, height } = useContainerSize(hostRef, FALLBACK_W, FALLBACK_H, {
    minWidth: 120,
    minHeight: 100,
  })
  const { points, benchmark } = useMemo(() => buildTermData(surface, dvol), [dvol, surface])
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 3, 7, 14, 30])
  const [rewindOpen, setRewindOpen] = useState(false)
  const rewindId = useId()
  const snapshots = useMemo(() => (surface?.lookbacks ?? []).map(snapshot => ({
    ...snapshot, points: buildTermData({ tenors: snapshot.tenors }, null).points,
    label: `${snapshot.days}D AGO`, color: lookbackColor(snapshot.days),
  })).sort((a, b) => a.days - b.days), [surface?.lookbacks])
  const comparisons = useMemo(() => snapshots.filter(snapshot => selectedDays.includes(snapshot.days)), [snapshots, selectedDays])
  const toggleDay = (day: number) => setSelectedDays(days => days.includes(day) ? days.filter(d => d !== day) : [...days, day])
  const geometry = useMemo(
    () => buildGeometry(points, showDvol ? benchmark : null, width, height, comparisons.flatMap(row => row.points.map(point => point.value))),
    [benchmark, height, points, width, showDvol, comparisons],
  )

  if (points.length < 2 || !geometry) {
    return (
      <div ref={hostRef} className={className}>
        <div className="regime-vol__empty">Term curve unavailable</div>
      </div>
    )
  }

  const activeTenor = focusedTenor ?? hoveredTenor
  const activeCoord = activeTenor == null
    ? null
    : geometry.coords.find((coord) => coord.point.tenor === activeTenor) ?? null
  const activeQuote = surface?.tenors.find(row => row.tenor === TERM_SLOTS.find(slot => slot.tenor === activeTenor)?.key)
  const availableTenors = new Set(points.map((point) => point.tenor))
  const curveDescription = points.map((point) => `${point.tenor} ${point.value.toFixed(1)}%`).join(', ')
  const visibleBenchmark = showDvol ? benchmark : null
  const elevatedEndSlot = frontElevationEndSlot(points)
  const elevatedEnd = elevatedEndSlot == null ? null : geometry.coords.find((coord) => coord.point.slotIndex === elevatedEndSlot)!
  const elevatedStop = elevatedEnd == null ? 0 : (elevatedEnd.x - geometry.dataLeft) / (geometry.dataRight - geometry.dataLeft)
  const elevatedFade = Math.min(1, elevatedStop + .065)

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!(rect.width > 0) || !(rect.height > 0)) return
    const pointerX = ((event.clientX - rect.left) / rect.width) * width
    const pointerY = ((event.clientY - rect.top) / rect.height) * height
    const insidePlot = pointerX >= geometry.plotLeft
      && pointerX <= geometry.plotRight
      && pointerY >= geometry.plotTop
      && pointerY <= geometry.plotBottom
    if (!insidePlot) {
      setHoveredTenor((current) => current == null ? current : null)
      return
    }

    let nearest = geometry.coords[0]!
    let nearestDistance = Math.abs(pointerX - nearest.x)
    for (let index = 1; index < geometry.coords.length; index++) {
      const candidate = geometry.coords[index]!
      const distance = Math.abs(pointerX - candidate.x)
      if (distance < nearestDistance) {
        nearest = candidate
        nearestDistance = distance
      }
    }
    setHoveredTenor((current) => current === nearest.point.tenor ? current : nearest.point.tenor)
  }

  return (
    <div ref={hostRef} className={className}>
      <div className="term-lookbacks" role="group" aria-label="Historical curve lookbacks">
        <button type="button" className="term-lookbacks__trigger" aria-expanded={rewindOpen}
          aria-controls={rewindId} onClick={() => setRewindOpen(open => !open)}>
          REWIND <span className="term-lookbacks__chevron" aria-hidden="true" />
        </button>
        <div id={rewindId} className="term-lookbacks__days" data-open={rewindOpen} aria-hidden={!rewindOpen} inert={!rewindOpen}>
        {[...new Set([1, 3, 7, 14, 30, ...snapshots.map(row => row.days)])].sort((a, b) => a - b).map((day, index) => {
          const snapshot = snapshots.find(row => row.days === day)
          return <button key={day} type="button" disabled={!snapshot} aria-pressed={!!snapshot && selectedDays.includes(day)}
            aria-label={`${day} days ago${snapshot ? '' : ' — collecting history'}`} onClick={() => toggleDay(day)}
            style={{ color: snapshot && selectedDays.includes(day) ? lookbackColor(day) : undefined, transitionDelay: rewindOpen ? `${Math.min(index, 6) * 45}ms` : '0ms' }}>{day}D</button>
        })}
        </div>
      </div>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="regime-term-chart__svg"
        role="group"
        aria-label="ATM implied volatility term structure with historical comparisons"
        aria-describedby={descriptionId}
        shapeRendering="geometricPrecision"
        textRendering="geometricPrecision"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoveredTenor(null)}
      >
        <desc id={descriptionId}>
          {`Current ATM implied volatility curve: ${curveDescription}. Horizontal position is linear in calendar days; Long is exactly 180D.${visibleBenchmark ? ` ${visibleBenchmark.label} benchmark ${visibleBenchmark.value.toFixed(1)}%.` : ''}${elevatedEnd ? ` Red shading indicates 7D IV is higher than the consecutive tenors through ${elevatedEnd.point.tenor}.` : ''}`}
        </desc>
        <defs>
          <linearGradient id={`${paintId}-area`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="regime-term-chart__area-top" />
            <stop offset="65%" className="regime-term-chart__area-mid" />
            <stop offset="100%" className="regime-term-chart__area-bottom" />
          </linearGradient>
          <linearGradient id={`${paintId}-line`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" className="regime-term-chart__line-start" />
            <stop offset="100%" className="regime-term-chart__line-end" />
          </linearGradient>
          <pattern id={`${paintId}-dots`} width={6} height={6} patternUnits="userSpaceOnUse">
            <circle cx={3} cy={3} r={.65} className="regime-term-chart__texture-dot" />
          </pattern>
          <linearGradient id={`${paintId}-texture-fade`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" />
            <stop offset="75%" stopColor="white" stopOpacity={.12} />
            <stop offset="100%" stopColor="white" stopOpacity={0} />
          </linearGradient>
          <mask id={`${paintId}-texture-mask`} maskContentUnits="objectBoundingBox">
            <rect width={1} height={1} fill={`url(#${paintId}-texture-fade)`} />
          </mask>
          {elevatedEnd && <>
            <pattern id={`${paintId}-premium-dots`} width={6} height={6} patternUnits="userSpaceOnUse">
              <circle cx={3} cy={3} r={.65} className="regime-term-chart__texture-dot regime-term-chart__texture-dot--elevated" />
            </pattern>
            <linearGradient id={`${paintId}-premium`} gradientUnits="userSpaceOnUse" x1={geometry.dataLeft} y1={0} x2={geometry.dataRight} y2={0}>
              <stop offset="0%" className="regime-term-chart__premium-color" stopOpacity={.95} />
              <stop offset={`${Math.max(0, elevatedStop - .075) * 100}%`} className="regime-term-chart__premium-color" stopOpacity={.72} />
              <stop offset={`${elevatedStop * 100}%`} className="regime-term-chart__premium-color" stopOpacity={elevatedStop === 1 ? .65 : .5} />
              {elevatedStop < 1 && <stop offset={`${elevatedFade * 100}%`} className="regime-term-chart__premium-color" stopOpacity={0} />}
            </linearGradient>
            <linearGradient id={`${paintId}-premium-area`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="regime-term-chart__premium-color" stopOpacity={.2} />
              <stop offset="65%" className="regime-term-chart__premium-color" stopOpacity={.05} />
              <stop offset="100%" className="regime-term-chart__premium-color" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${paintId}-premium-mask`} gradientUnits="userSpaceOnUse" x1={geometry.dataLeft} y1={0} x2={geometry.dataRight} y2={0}>
              <stop offset="0%" stopColor="white" />
              <stop offset={`${Math.max(0, elevatedStop - .075) * 100}%`} stopColor="white" />
              <stop offset={`${elevatedStop * 100}%`} stopColor="white" stopOpacity={elevatedStop === 1 ? 1 : .65} />
              {elevatedStop < 1 && <stop offset={`${elevatedFade * 100}%`} stopColor="white" stopOpacity={0} />}
            </linearGradient>
            <mask id={`${paintId}-premium-extent`} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
              <rect width={width} height={height} fill={`url(#${paintId}-premium-mask)`} />
            </mask>
          </>}
        </defs>

        <path d={geometry.areaPath} fill={`url(#${paintId}-area)`} className="regime-term-chart__area" aria-hidden="true" />
        <path d={geometry.areaPath} fill={`url(#${paintId}-dots)`} mask={`url(#${paintId}-texture-mask)`}
          className="regime-term-chart__texture" aria-hidden="true" />
        {elevatedEnd && <path d={geometry.areaPath} fill={`url(#${paintId}-premium-area)`} mask={`url(#${paintId}-premium-extent)`}
          className="regime-term-chart__premium-area" aria-hidden="true" />}
        {elevatedEnd && <g mask={`url(#${paintId}-texture-mask)`} aria-hidden="true">
          <path d={geometry.areaPath} fill={`url(#${paintId}-premium-dots)`} mask={`url(#${paintId}-premium-extent)`}
            className="regime-term-chart__texture" />
        </g>}

        {geometry.ticks.map((tick) => {
          const y = valueToY(tick, geometry.min, geometry.max, geometry.plotTop, geometry.plotBottom)
          return (
            <g key={tick}>
              <line
                x1={geometry.plotLeft}
                x2={geometry.plotRight}
                y1={y}
                y2={y}
                className="regime-term-chart__grid"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={geometry.axisLabelX}
                y={y}
                textAnchor="middle"
                dominantBaseline="middle"
                className="regime-term-chart__axis-value"
              >
                {tick.toFixed(1)}%
              </text>
            </g>
          )
        })}

        <line
          x1={geometry.plotLeft}
          x2={geometry.plotRight}
          y1={geometry.plotBottom}
          y2={geometry.plotBottom}
          className="regime-term-chart__baseline"
          stroke="var(--desk-rule, rgba(140, 150, 165, 0.22))"
          vectorEffect="non-scaling-stroke"
        />

        {visibleBenchmark != null && geometry.benchmarkY != null ? (
          <g className="regime-term-chart__benchmark" aria-label={`${visibleBenchmark.label} ${visibleBenchmark.value.toFixed(1)} percent`}>
            <line
              x1={geometry.plotLeft}
              x2={geometry.plotRight}
              y1={geometry.benchmarkY}
              y2={geometry.benchmarkY}
              stroke="var(--regime-term-benchmark, #7f8998)"
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={geometry.plotRight - 3}
              y={geometry.benchmarkY - 4}
              textAnchor="end"
              className="regime-term-chart__benchmark-label"
              fill="var(--regime-term-benchmark, #7f8998)"
            >
              DVOL {visibleBenchmark.value.toFixed(1)}%
            </text>
          </g>
        ) : null}

        {comparisons.map(comparison => {
          const coords = comparison.points.map(point => ({ slotIndex: point.slotIndex,
            x: maturityToX(point.targetDays, geometry.dataLeft, geometry.dataRight),
            y: valueToY(point.value, geometry.min, geometry.max, geometry.plotTop, geometry.plotBottom),
          }))
          const path = buildTermCurvePaths(coords, geometry.plotBottom).path
          return <g key={comparison.days} className="term-comparison" aria-label={`${comparison.label} captured ${new Date(comparison.asOfMs).toISOString()}`}>
            <path d={path} fill="none" stroke={comparison.color} strokeWidth={1.15} strokeLinecap="round" opacity={.6} vectorEffect="non-scaling-stroke" />
          </g>
        })}
        <path
          d={geometry.path}
          className="regime-term-chart__curve-underlay"
          fill="none"
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          aria-hidden="true"
        />
        <path
          d={geometry.path}
          className="regime-term-chart__curve"
          fill="none"
          stroke={`url(#${paintId}-line)`}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {elevatedEnd && <path d={geometry.path} fill="none" stroke={`url(#${paintId}-premium)`} strokeWidth={1.8}
          strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
          className="regime-term-chart__premium-curve" aria-hidden="true" />}

        {TERM_SLOTS.map((slot, slotIndex) => {
          const x = maturityToX(slot.targetDays, geometry.dataLeft, geometry.dataRight)
          const available = availableTenors.has(slot.tenor)
          return (
            <g key={slot.tenor} aria-hidden="true">
              <line x1={x} x2={x} y1={geometry.plotBottom} y2={geometry.plotBottom + 4}
                className={`regime-term-chart__tenor-tick${available ? '' : ' regime-term-chart__tenor-tick--missing'}${elevatedEndSlot != null && slotIndex <= elevatedEndSlot ? ' regime-term-chart__tenor-tick--elevated' : ''}`}
                vectorEffect="non-scaling-stroke" />
              <text
              x={x}
              y={geometry.tenorY}
              textAnchor="middle"
              dominantBaseline="middle"
              className={`regime-term-chart__tenor${available ? '' : ' regime-term-chart__tenor--missing'}${activeTenor === slot.tenor ? ' regime-term-chart__tenor--active' : ''}`}
              aria-hidden="true"
            >
              {slot.tenor}
            </text>
            </g>
          )
        })}

        {geometry.coords.map((coord) => {
          return (
            <text
              key={`value-${coord.point.tenor}`}
              x={coord.x}
              y={coord.labelY}
              textAnchor="middle"
              dominantBaseline="middle"
              className={`regime-term-chart__point-value${activeTenor === coord.point.tenor ? ' regime-term-chart__point-value--active' : ''}`}
              aria-hidden="true"
            >
              {coord.point.value.toFixed(1)}%
            </text>
          )
        })}

        {geometry.coords.map((coord) => {
          const active = activeCoord?.point.tenor === coord.point.tenor
          const label = pointAccessibleLabel(coord.point)
          return (
            <g
              key={coord.point.tenor}
              className={`regime-term-chart__marker${active ? ' regime-term-chart__marker--active' : ''}${elevatedEndSlot != null && coord.point.slotIndex <= elevatedEndSlot ? ' regime-term-chart__marker--elevated' : ''}`}
              role="img"
              aria-label={label}
              tabIndex={0}
              onFocus={() => setFocusedTenor(coord.point.tenor)}
              onBlur={() => setFocusedTenor(null)}
              onPointerEnter={() => setHoveredTenor(coord.point.tenor)}
            >
              <circle
                cx={coord.x}
                cy={coord.y}
                r={7}
                className="regime-term-chart__marker-halo"
                pointerEvents="none"
              />
              <circle
                cx={coord.x}
                cy={coord.y}
                r={11}
                className="regime-term-chart__marker-hit"
                fill="transparent"
                stroke="none"
              />
              <circle
                cx={coord.x}
                cy={coord.y}
                r={active ? 3.1 : 2.5}
                className="regime-term-chart__marker-dot"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            </g>
          )
        })}

        {activeCoord != null ? (
          <g className="regime-term-chart__inspection" pointerEvents="none" aria-hidden="true">
            <line
              x1={activeCoord.x}
              x2={activeCoord.x}
              y1={geometry.plotTop}
              y2={geometry.plotBottom}
              className="regime-term-chart__guide"
              stroke="var(--regime-term-guide, rgba(167, 139, 212, 0.34))"
              strokeWidth={1}
              strokeDasharray="3 5"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ) : null}
      </svg>
      <div className="term-comparison-readout" role="group" aria-label="Visible historical curves">
        {comparisons.map(comparison => <span key={comparison.days} style={{ color: comparison.color }}>
          {comparison.label}
        </span>)}
      </div>
      <div className="regime-term-chart__readout" aria-live="polite" aria-atomic="true">
        {activeCoord != null ? <>
          <span>{activeCoord.point.targetDays.toFixed(2)}D · Constant maturity</span>
          <strong>{activeCoord.point.value.toFixed(2)}% ATM IV</strong>
          {activeQuote?.bidIvPercent != null && activeQuote.askIvPercent != null && <span>
            Estimated bid/ask {activeQuote.bidIvPercent.toFixed(2)}–{activeQuote.askIvPercent.toFixed(2)}%
          </span>}
          {activeQuote?.midIvPercent != null ? <span>Price-mid IV {activeQuote.midIvPercent.toFixed(2)}%</span>
            : activeQuote?.bidIvPercent != null ? <span>Price-mid IV unavailable</span> : null}
        </> : null}
      </div>
    </div>
  )
}

function buildTermData(surface: VolSurface | undefined, dvol: number | null): TermData {
  const points = TERM_SLOTS.flatMap((slot, index): TermPoint[] => {
    const row = surface?.tenors.find((r) => r.tenor === slot.key)
    if (row?.status !== 'ok' || row.calendarOk === false || row.atmIvPercent == null) return []
    return [{
      tenor: slot.tenor, slotIndex: index, targetDays: slot.targetDays,
      value: row.atmIvPercent, source: 'Forward ATM; local quote and ATM calendar checks',
      sourceKind: 'constant', dteDays: slot.targetDays, expiryTsMs: null,
      method: row.method ?? null, lowerExpiryTsMs: row.lowerExpiryTsMs ?? null, lowerDteDays: row.lowerDteDays ?? null,
      upperExpiryTsMs: row.upperExpiryTsMs ?? null, upperDteDays: row.upperDteDays ?? null,
    }]
  })
  const value = finiteVol(dvol)
  return { points, benchmark: value == null ? null : {
    value, label: 'DVOL benchmark', source: 'Option-strip index; distinct from ATM IV',
  } }
}

function buildGeometry(
  points: TermPoint[],
  benchmark: TermBenchmark | null,
  width: number,
  height: number,
  comparisonValues: number[] = [],
): ChartGeometry | null {
  if (points.length < 2) return null

  const compact = height < 170
  const plotLeft = 8
  const plotRight = Math.max(plotLeft + 1, width - 42)
  const plotTop = compact ? 16 : 24
  const plotBottom = Math.max(plotTop + 1, height - (comparisonValues.length ? 61 : 41))
  // Reserve the first value label's half-width and keep Long clear of the axis.
  const dataLeft = plotLeft + 22
  const dataRight = Math.max(dataLeft + 1, plotRight - 10)
  const axisLabelX = plotRight + (width - plotRight) / 2
  const tenorY = Math.min(height - 7, plotBottom + 15)
  const domainValues = [...points.map((point) => point.value), ...comparisonValues]
  if (benchmark != null) domainValues.push(benchmark.value)
  const { min, max, ticks } = buildTermCurveScale(domainValues, plotBottom - plotTop)
  const coords: TermCoord[] = points.map((point) => {
    const y = valueToY(point.value, min, max, plotTop, plotBottom)
    return {point,x:maturityToX(point.targetDays,dataLeft,dataRight),y,labelY:y + (y < plotTop + 21 ? 19 : -17)}
  })
  // Closely spaced front tenors can have nearly equal IV; stagger their labels,
  // keeping every dot and tenor tick on its actual maturity coordinate.
  for (let index=0;index<coords.length;index++) {
    const coord=coords[index]!
    const candidates=[coord.labelY,coord.y+19,coord.y-17,coord.y-31,coord.y+33,coord.y-10,coord.y+10]
    const labelWidth=coord.point.value.toFixed(1).length*6 + 12
    coord.labelY=candidates.find((y) => y>=plotTop+6 && y<=plotBottom-6 && coords.slice(0,index).every((previous) => {
      const previousWidth=previous.point.value.toFixed(1).length*6 + 12
      return Math.abs(coord.x-previous.x)>=(labelWidth+previousWidth)/2+3 || Math.abs(y-previous.labelY)>=14
    })) ?? coord.labelY
  }
  const { path, areaPath } = buildTermCurvePaths(
    coords.map((coord) => ({ x: coord.x, y: coord.y, slotIndex: coord.point.slotIndex })), plotBottom,
  )
  const benchmarkY = benchmark == null
    ? null
    : valueToY(benchmark.value, min, max, plotTop, plotBottom)

  return {
    coords,
    min,
    max,
    ticks,
    path,
    areaPath,
    benchmarkY,
    plotTop,
    plotRight,
    plotBottom,
    plotLeft,
    dataLeft,
    dataRight,
    axisLabelX,
    tenorY,
  }
}

function maturityToX(targetDays: number, plotLeft: number, plotRight: number): number {
  const plotWidth = plotRight - plotLeft
  const firstDays=TERM_SLOTS[0]!.targetDays
  const lastDays=TERM_SLOTS.at(-1)!.targetDays
  return plotLeft + ((targetDays-firstDays)/(lastDays-firstDays)) * plotWidth
}

function valueToY(
  value: number,
  min: number,
  max: number,
  plotTop: number,
  plotBottom: number,
): number {
  const plotHeight = plotBottom - plotTop
  if (!(max > min)) return plotTop + plotHeight / 2
  return plotTop + ((max - value) / (max - min)) * plotHeight
}

function pointAccessibleLabel(point: TermPoint): string {
  const maturity = point.sourceKind === 'constant'
    ? `exact constant maturity ${formatTargetDays(point.targetDays)}`
    : point.expiryTsMs == null
      ? `target maturity ${point.targetDays} days`
      : `expires ${EXPIRY_LONG.format(new Date(point.expiryTsMs))}`
  const bracket = sourceExpiryLabel(point, EXPIRY_LONG)
  const parts = [
    `${point.tenor} ATM implied volatility ${point.value.toFixed(2)} percent`,
    maturity,
    bracket == null ? null : `source expiries ${bracket}`,
    point.dteDays == null ? null : `${point.dteDays.toFixed(1)} days to expiry`,
    point.source,
  ]
  return parts.filter((part): part is string => part != null).join('. ')
}

function sourceExpiryLabel(
  point: TermPoint,
  formatter: Intl.DateTimeFormat,
): string | null {
  const lower = point.lowerExpiryTsMs
  const upper = point.upperExpiryTsMs
  if (lower == null || upper == null) return null
  const lowerLabel = formatter.format(new Date(lower))
  if (lower === upper) return lowerLabel
  return `${lowerLabel}–${formatter.format(new Date(upper))}`
}

function formatTargetDays(days: number): string {
  return `${days}D`
}

function finiteVol(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null
}


/** Age, not IV magnitude: cool recent observations warm through the month. */
function lookbackColor(days: number): string {
  const stops = [
    { day: 1, rgb: [111, 143, 234] },
    { day: 3, rgb: [74, 189, 174] },
    { day: 7, rgb: [199, 202, 105] },
    { day: 14, rgb: [226, 161, 87] },
    { day: 30, rgb: [220, 111, 114] },
    { day: 365, rgb: [174, 99, 139] },
  ]
  const upper = stops.findIndex(stop => stop.day >= days)
  const right = stops[upper < 0 ? stops.length - 1 : upper]!
  const left = stops[Math.max(0, upper - 1)]!
  const weight = upper <= 0 ? 1 : (days - left.day) / (right.day - left.day)
  return `rgb(${right.rgb.map((value, index) => Math.round(left.rgb[index]! + (value - left.rgb[index]!) * weight)).join(', ')})`
}
