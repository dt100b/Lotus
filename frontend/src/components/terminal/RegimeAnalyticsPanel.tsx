import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalSnapshot, VolSeriesPoint } from '@/data/mockTerminal'
import { RegimeTermStructureChart } from '@/components/terminal/RegimeTermStructureChart'
import { ListedExpiryIvChart } from '@/components/terminal/ListedExpiryIvChart'
import { hasListedIv, type ListedExpirySpacing } from '@/data/listedExpiryGeometry'
import { RegimeHistoryChart, type RegimeHistorySeries, type RegimeHistoryTone } from '@/components/terminal/RegimeHistoryChart'
import { VolCompareChart } from '@/components/terminal/VolCompareChart'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MINI_CHART_RANGE_LOOKBACK_SECONDS, MINI_CHART_RANGE_OPTIONS, type MiniChartRange } from '@/data/miniChartRange'
import { dailySpreadZ, pairSurfaceRv } from '@/lib/surfaceInspection'
import { useRetainedFrontExpiryIv } from '@/hooks/useRetainedFrontExpiryIv'
import { cn } from '@/lib/utils'

// Preserve chip navigation identities; reorganize the views and their contents.
export type RegimeAnalyticsFamily = 'volatility' | 'term' | 'skew' | 'rv'
const FAMILIES: Array<[RegimeAnalyticsFamily,string]> = [
  ['term','Implied'], ['volatility','VRP'], ['skew','Skew'], ['rv','Realized'],
]
const FAMILY_DETAILS: Record<RegimeAnalyticsFamily,{description:string;glyph:string}> = {
  term: {description:'ATM curves & history',glyph:'M2 14 C7 14 8 7 13 7 S19 3 22 3'},
  volatility: {description:'Implied versus realized',glyph:'M2 5 C8 5 8 12 14 12 S19 5 22 5 M2 13 C8 13 8 7 14 7 S19 12 22 12'},
  skew: {description:'Smile and tail premiums',glyph:'M2 3 C6 14 15 16 22 6'},
  rv: {description:'Parkinson volatility',glyph:'M2 10 L5 10 7 3 10 15 13 6 16 10 22 10'},
}
const TENORS = ['7d','30d','90d','180d']
const ATM_MATURITIES: Array<{tenor:string;label:string;tone:RegimeHistoryTone}> = [
  {tenor:'7d',label:'7D',tone:'skew-1w'}, {tenor:'30d',label:'30D',tone:'skew-1m'},
  {tenor:'60d',label:'60D',tone:'skew-3m'}, {tenor:'180d',label:'Long',tone:'skew-6m'},
]
const MATURITY_OPTIONS = TENORS.map((value) => ({value,label:value.toUpperCase(),description:`${Number.parseInt(value)} days`}))
const RANGE_OPTIONS = MINI_CHART_RANGE_OPTIONS.map(({value,label}) => ({value,label,
  description:value==='all' ? 'All history' : value==='1d' ? '24 hours' : `${MINI_CHART_RANGE_LOOKBACK_SECONDS[value]! / 86_400} days`,
}))
const EMPTY: VolSeriesPoint[] = []
type ImpliedMode = 'curve' | 'listed' | 'history' | 'benchmark'
type SpreadMode = 'compare' | 'spread' | 'zscore'
type WingMode = 'skew_25' | 'skew_10' | 'tail_gap'

export const RegimeAnalyticsPanel = memo(function RegimeAnalyticsPanel({bookSnapshot,family,onFamilyChange}: {
  bookSnapshot: TerminalSnapshot
  family: RegimeAnalyticsFamily
  onFamilyChange: (family: RegimeAnalyticsFamily) => void
}) {
  const surface = bookSnapshot.flowRegime?.skewSurface
  const atmCurve = bookSnapshot.flowRegime?.atmTermCurve
  const [clockMs,setClockMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()),10_000)
    return () => window.clearInterval(timer)
  },[])
  const listedRows = useRetainedFrontExpiryIv(atmCurve?.version === 'atm_term_curve.v1' ? atmCurve.listedExpiries : undefined)
  const vol = bookSnapshot.flowRegime?.volCompare ?? bookSnapshot.volCompare
  const familyPointerInteraction = useRef(false)
  const [impliedMode,setImpliedMode] = useState<ImpliedMode>('curve')
  const [listedSpacing,setListedSpacing] = useState<ListedExpirySpacing>('sqrt-dte')
  const [spreadMode,setSpreadMode] = useState<SpreadMode>('compare')
  const [wingMode,setWingMode] = useState<WingMode>('skew_25')
  const [tenor,setTenor] = useState('30d')
  const [benchmark,setBenchmark] = useState(false)
  const [rvVisible,setRvVisible] = useState([true,true,true])
  const [atmVisible,setAtmVisible] = useState(() => ATM_MATURITIES.map(() => true))
  const [ranges,setRanges] = useState<Record<RegimeAnalyticsFamily,MiniChartRange>>({term:'1w',volatility:'1w',skew:'1w',rv:'1w'})
  const versionOk = surface?.version === 'local_delta_skew.v1'
  const history = versionOk ? surface.history : undefined
  const atm30 = atmCurve?.version === 'atm_term_curve.v1' ? atmCurve.history?.atm?.['30d'] ?? EMPTY : EMPTY
  const rv30 = vol?.rvSeries ?? EMPTY
  const paired = useMemo(() => pairSurfaceRv(atm30,rv30),[atm30,rv30])
  const z = useMemo(() => dailySpreadZ(paired.spread,clockMs),[paired,clockMs])
  const dvol = vol?.dvolSeries ?? EMPTY
  const curve = family === 'term' && impliedMode === 'curve'
  const listed = family === 'term' && impliedMode === 'listed'
  const snapshotView = curve || listed
  const isBenchmark = family === 'term' && impliedMode === 'benchmark'
  const isAtmHistory = family === 'term' && impliedMode === 'history'
  const wing = history?.[wingMode]?.[tenor] ?? EMPTY
  const skewRow = surface?.tenors.find(row => row.tenor===tenor)
  const skewOverdue = surface?.captureDueMs != null && clockMs > surface.captureDueMs
  const skewCurrent = !skewOverdue && surface?.refreshState !== 'failed'
    ? wingMode==='skew_25' ? skewRow?.skew25Normalized : wingMode==='skew_10' ? skewRow?.skew10Normalized : skewRow?.tailGapVolPoints
    : null
  const atmOverdue = atmCurve?.captureDueMs != null && clockMs > atmCurve.captureDueMs
  const currentComparison = !atmOverdue ? atmCurve?.atmVsRv : undefined
  const atmSeries: RegimeHistorySeries[] = ATM_MATURITIES.map(({tenor,label,tone},index) => ({
    id:`atm-${tenor}`,label,data:atmCurve?.history?.atm?.[tenor] ?? EMPTY,tone,visible:atmVisible[index],
  }))
  const realized = [vol?.rv1Series ?? EMPTY,vol?.rv7Series ?? EMPTY,rv30]
  const plotted: RegimeHistorySeries[] = family === 'rv'
    ? realized.map((data,index) => ({id:`rv-${index}`,label:['24H','7D','30D'][index]!,data,
        tone: index === 0 ? 'rv-fast' : index === 1 ? 'rv-slow' : 'neutral', dashed:index===1,visible:rvVisible[index]}))
    : isAtmHistory ? atmSeries : [{id:'surface',label:`${tenor.toUpperCase()} put − call`,
        data:wing,tone:'skew-1m',
        valueMultiplier:family==='skew' && wingMode!=='tail_gap' ? 100 : 1}]
  let title = 'Term Structure'
  let current: string
  let source = 'Forward ATM · constant maturity · ACT/365'
  let empty: string
  let hasChart: boolean
  if (family==='term') {
    if (curve) {
      hasChart = (atmCurve?.tenors.filter((r) => ['7d', '30d', '60d', '180d'].includes(r.tenor) && r.status==='ok' && r.calendarOk!==false && r.atmIvPercent!=null).length ?? 0)>=2
      const front = atmCurve?.tenors.find((r) => r.tenor==='7d')?.atmIvPercent
      const long = atmCurve?.tenors.find((r) => r.tenor==='180d')?.atmIvPercent
      const spread = front != null && long != null ? long-front : null
      current = spread == null ? '' : `${spread > .5 ? 'Contango' : spread < -.5 ? 'Backwardation' : 'Flat'} · ${signed(spread)} pts`
      empty = 'Waiting for supported, current near-ATM quotes'
    } else if (listed) {
      const count = listedRows.filter(hasListedIv).length
      title='ATM IV by listed expiry'; current=`${count} supported expiries`; hasChart=count>0
      empty='Waiting for current, validated listed-expiry ATM quotes'
    } else if (isBenchmark) {
      title='DVOL'; current=percent(last(dvol)); hasChart=dvol.length>0
      source='Deribit option-strip index · distinct from ATM IV'; empty='DVOL history unavailable'
    } else {
      title='ATM IV By Tenor'; current=''; hasChart=atmSeries.some((item) => item.visible && item.data.length>0)
      empty=atmSeries.some((item) => item.data.length>0) ? 'Select an ATM maturity to display' : 'ATM history starts with retained local ATM captures'
    }
  } else if (family==='volatility') {
    title=spreadMode==='compare' ? '30D ATM IV / realized' : spreadMode==='spread' ? '30D ATM IV − RV' : 'Spread z-score · 60D baseline'
    current=spreadMode==='zscore' ? signed(last(z)) : spreadMode==='spread' ? `${signed(currentComparison?.spreadPercent)} vol pts` : `${percent(currentComparison?.atmIvPercent)} / ${percent(currentComparison?.rvPercent)}`
    hasChart=spreadMode==='compare' ? rv30.length>0 || atm30.length>0 : (spreadMode==='zscore' ? z : paired.spread).length>0
    source='Forward ATM − trailing Parkinson RV30 · descriptive spread'
    empty=spreadMode==='zscore' ? 'Needs 60 prior completed UTC days of matched spread history' : 'Waiting for matched, validated ATM and completed RV30 history'
  } else if (family==='skew') {
    title=wingMode==='tail_gap' ? `${tenor.toUpperCase()} tail − body skew` : `${tenor.toUpperCase()} ${wingMode==='skew_25' ? '25Δ' : '10Δ'} normalized skew`
    const value = skewCurrent
    current=value==null ? 'Current unavailable' : wingMode==='tail_gap' ? `${signed(value)} vol pts` : `${signed(value*100)}%`
    source=wingMode==='tail_gap' ? '10Δ risk reversal − 25Δ risk reversal · vol points' : '(Put IV − call IV) / ATM · positive = puts richer'
    hasChart=wing.length>0; empty='Waiting for validated wing coverage and history'
  } else {
    title='Parkinson realized volatility'; source='Deribit BTC-PERPETUAL · completed hourly ranges · 365-day year'
    hasChart=realized.some((data,index) => rvVisible[index] && data.length>0)
    current=realized.map((data,index) => rvVisible[index] && last(data)!=null ? `${['24H','7D','30D'][index]} ${percent(last(data))}` : '').filter(Boolean).join(' · ')
    empty='No complete hourly RV windows available'
  }
  const reasons = Array.from(new Set((snapshotView ? atmCurve : surface)?.tenors.flatMap((r) => r.reasons ?? []) ?? []))
  const displayedHistory = family==='skew' ? wing : family==='term' ? isBenchmark ? dvol : atmCurve?.history?.atm?.['30d'] ?? EMPTY
    : family==='volatility' ? spreadMode==='zscore' ? z : paired.spread : rv30
  const sampleAt = snapshotView || (family==='volatility' && spreadMode!=='zscore') ? atmCurve?.asOfMs
    : family==='skew' ? surface?.asOfMs : displayedHistory.at(-1)?.tsMs
  const sampleTime = sampleAt ? new Intl.DateTimeFormat('en-US', {
    timeZone:'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,
  }).format(sampleAt) : null
  const sourceFailure = reasons.includes('no_fittable_expiry') ? 'Waiting for fresh, two-sided quotes and strike coverage'
    : reasons.includes('atm_curve_stale') ? `ATM quotes expired · waiting for the refresh worker${sampleTime ? ` · Last refresh ${sampleTime} UTC` : ''}`
    : reasons.includes('surface_stale_or_legacy') ? 'Waiting for a current surface snapshot'
    : reasons.length ? snapshotView ? 'ATM quote coverage or calendar checks failed' : 'Source smile or calendar checks failed'
    : snapshotView ? !atmCurve ? 'Current ATM curve is not available yet' : null : !versionOk ? 'Updated surface data is not available yet' : null
  const modes: Array<[string,boolean,()=>void]> = family==='term'
    ? [['Curve',impliedMode==='curve',()=>setImpliedMode('curve')],['Listed expiries',impliedMode==='listed',()=>setImpliedMode('listed')],['ATM history',impliedMode==='history',()=>setImpliedMode('history')],['DVOL',impliedMode==='benchmark',()=>setImpliedMode('benchmark')]]
    : family==='volatility'
      ? [['Compare',spreadMode==='compare',()=>setSpreadMode('compare')],['Spread',spreadMode==='spread',()=>setSpreadMode('spread')],['Z-score',spreadMode==='zscore',()=>setSpreadMode('zscore')]]
      : family==='skew'
        ? [['25Δ body',wingMode==='skew_25',()=>setWingMode('skew_25')],['10Δ tail',wingMode==='skew_10',()=>setWingMode('skew_10')],['Tail gap',wingMode==='tail_gap',()=>setWingMode('tail_gap')]]
        : ['24H','7D','30D'].map((label,index) => [label,rvVisible[index]!,()=>setRvVisible((values) => {
            if (values[index] && values.filter(Boolean).length===1) return values
            return values.map((v,i) => i===index ? !v : v)
          })])
  return <section className={cn('regime-analytics',`regime-analytics--${family}`)} aria-label="Market volatility inspection">
    <header className="regime-analytics__head">
      <div className="regime-analytics__head-row regime-analytics__head-row--navigation">
        <Select value={family} onValueChange={(value) => onFamilyChange(value as RegimeAnalyticsFamily)}>
          <SelectTrigger className="regime-analytics__family-trigger" aria-label="Inspection view"
            onPointerDownCapture={() => { familyPointerInteraction.current=true }}
            onKeyDownCapture={() => { familyPointerInteraction.current=false }}>
            <SelectValue>{FAMILIES.find(([id]) => id===family)?.[1]}</SelectValue>
          </SelectTrigger>
          <SelectContent className="regime-analytics__family-menu" position="popper" align="start" sideOffset={6} collisionPadding={8}
            onPointerDownCapture={() => { familyPointerInteraction.current=true }}
            onPointerDownOutside={() => { familyPointerInteraction.current=true }}
            onKeyDownCapture={() => { familyPointerInteraction.current=false }}
            onCloseAutoFocus={(event) => {
              if (familyPointerInteraction.current) event.preventDefault()
            }}>
            {FAMILIES.map(([id,label]) => <SelectItem key={id} value={id} aria-label={label} aria-description={FAMILY_DETAILS[id].description}
              className={cn('regime-analytics__family-option',`regime-analytics__family-option--${id}`)}>
              <span className="regime-analytics__family-option-content">
                <svg viewBox="0 0 24 18" className="regime-analytics__family-glyph" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
                  <path d={FAMILY_DETAILS[id].glyph} />
                </svg>
                <span className="regime-analytics__family-copy">
                  <span className="regime-analytics__family-name">{label}</span>
                  <span className="regime-analytics__family-description" aria-hidden="true">{FAMILY_DETAILS[id].description}</span>
                </span>
              </span>
            </SelectItem>)}
          </SelectContent>
        </Select>
        <div className="regime-analytics__modes" role="group" aria-label="Chart contents">
          {modes.map(([label,active,onClick]) => <Mode key={label} label={label} active={active} onClick={onClick} />)}
        </div>
      </div>
      <div className="regime-analytics__head-row regime-analytics__head-row--secondary">
        <h2 className={cn('regime-analytics__title',curve && 'regime-analytics__title--curve')}><span className="regime-analytics__title-label">{title}</span>
          {current && <span className="regime-analytics__title-value">{current}</span>}</h2>
        <div className="regime-analytics__controls">
          {listed && <div className="regime-listed-spacing" role="group" aria-label="Expiry axis spacing">
            <button type="button" aria-pressed={listedSpacing==='expiry'} onClick={()=>setListedSpacing('expiry')}
              aria-description="Equally spaced listed expiries">Spaced</button>
            <button type="button" aria-pressed={listedSpacing==='sqrt-dte'} onClick={()=>setListedSpacing('sqrt-dte')}
              aria-label="Square root spacing" aria-description="Spacing by square root of days to expiry">√</button>
          </div>}
          {curve && <button type="button" className={cn('regime-analytics__overlay-toggle',benchmark && 'regime-analytics__overlay-toggle--active')}
            aria-label="DVOL overlay" aria-pressed={benchmark} onClick={() => setBenchmark(!benchmark)}>
            <span className="regime-analytics__overlay-swatch" aria-hidden="true" />DVOL
          </button>}
          {family==='skew' && <InspectionRangeSelect
            value={tenor} onChange={setTenor} label="Surface maturity" heading="Maturity" options={MATURITY_OPTIONS} tone={family} />}
          {!snapshotView && <InspectionRangeSelect value={ranges[family]} onChange={(r) => setRanges((v) => ({...v,[family]:r}))}
            label="Chart time range" heading="Timeframe" options={RANGE_OPTIONS} tone={family} />}
        </div>
      </div>
      {family!=='term' && <p className="regime-inspection__source">{source}{sampleTime && <> · Captured {sampleTime} UTC</>}</p>}
      {family==='skew' && <p className="regime-inspection__source" role="status">
        {skewCurrent == null
          ? `${skewOverdue ? 'Update overdue' : surface?.refreshState==='failed' ? 'Refresh failed' : skewReason(skewRow?.metricReasons?.[wingMode])}${wing.length ? ' · Retained history shown' : ''}`
          : `Scheduled snapshot${wingMode==='skew_25' && skewRow?.rr25VolPoints != null ? ` · Put − call ${signed(skewRow.rr25VolPoints)} vol pts` : ''}${wing.length===1 ? ' · First observation; history is accumulating' : ''}`}
      </p>}
      {family==='volatility' && spreadMode!=='zscore' && <p className="regime-inspection__source" role="status">
        {atmOverdue ? 'ATM update overdue · Retained history shown' : currentComparison?.spreadPercent == null ? 'Current matched comparison unavailable' : 'Scheduled ATM snapshot · Completed RV30'}
        {atm30.length ? ` · ATM history from ${new Date(atm30[0]!.tsMs).toISOString().slice(0,10)}` : ' · ATM history is accumulating'}
      </p>}
      {snapshotView && atmCurve?.captureDueMs != null && <p className="regime-inspection__source" role="status">
        Captured {sampleTime} UTC{clockMs > atmCurve.captureDueMs ? ' · Update overdue' : ' · Scheduled snapshot'}
      </p>}
      {isAtmHistory && <div className="regime-analytics__atm-maturities" role="group" aria-label="ATM maturities">
        {atmSeries.map((item,index) => <button key={item.id} type="button"
          className={cn('regime-analytics__atm-toggle',`regime-analytics__series-toggle--${item.tone}`)}
          aria-label={`${item.label} ATM IV`} aria-pressed={item.visible} disabled={item.data.length===0}
          aria-description={item.data.length===0 ? 'No validated history yet' : undefined}
          onClick={() => setAtmVisible((values) => values.map((value,i) => i===index ? !value : value))}>
          <i aria-hidden="true" />{item.label}
        </button>)}
      </div>}
    </header>
    <div className={cn('regime-analytics__chart',family==='volatility' && spreadMode==='compare' && 'regime-analytics__chart--dual')}>
      {hasChart ? curve ? <RegimeTermStructureChart className="regime-term-chart" surface={atmCurve} dvol={last(dvol)} showDvol={benchmark} />
        : listed ? <ListedExpiryIvChart rows={listedRows} spacing={listedSpacing} />
        : family==='volatility' || isBenchmark ? <VolCompareChart className="regime-vol__lwc" range={ranges[family]}
          mode={isBenchmark ? 'dvol' : spreadMode==='compare' ? 'iv_rv' : spreadMode==='spread' ? 'vrp' : 'vrp_z'}
          dvolSeries={isBenchmark ? dvol : atm30} rvSeries={rv30} spreadSeries={paired.spread}
          vrpSeries={paired.spread} vrpZSeries={z} showRv showSpread />
        : <RegimeHistoryChart className="regime-vol__lwc" series={plotted} range={ranges[family]}
          unit={family==='skew' ? wingMode==='tail_gap' ? 'vol-points' : 'normalized-percent' : 'vol-percent'} zeroGuide={family==='skew'} timeZone="UTC" />
        : <div className="regime-vol__empty" role="status"><span>{empty}</span>
          {family!=='rv' && !isBenchmark && !(isAtmHistory && atmSeries.some((item) => item.data.length>0)) && sourceFailure && <small>{sourceFailure}</small>}
        </div>}
    </div>
  </section>
})

function InspectionRangeSelect<T extends string>({value,onChange,label,heading,options,tone}: {
  value:T
  onChange:(value:T) => void
  label:string
  heading:string
  options:ReadonlyArray<{value:T;label:string;description:string}>
  tone:RegimeAnalyticsFamily
}) {
  const pointerInteraction = useRef(false)
  return <Select value={value} onValueChange={(next) => onChange(next as T)}>
    <SelectTrigger className="regime-analytics__range-trigger" aria-label={label}
      onPointerDownCapture={() => { pointerInteraction.current=true }}
      onKeyDownCapture={() => { pointerInteraction.current=false }}>
      <SelectValue>{options.find((option) => option.value===value)?.label}</SelectValue>
    </SelectTrigger>
    <SelectContent className={cn('regime-analytics__range-menu',`regime-analytics__range-menu--${tone}`)}
      position="popper" align="end" sideOffset={5} collisionPadding={8}
      onPointerDownCapture={() => { pointerInteraction.current=true }}
      onPointerDownOutside={() => { pointerInteraction.current=true }}
      onKeyDownCapture={() => { pointerInteraction.current=false }}
      onCloseAutoFocus={(event) => { if (pointerInteraction.current) event.preventDefault() }}>
      <div className="regime-analytics__range-heading" aria-hidden="true">{heading}</div>
      {options.map((option) => <SelectItem key={option.value} value={option.value} aria-label={option.label}
        aria-description={option.description} className="regime-analytics__range-option">
        <span className="regime-analytics__range-option-content">
          <span>{option.label}</span><span className="regime-analytics__range-description" aria-hidden="true">{option.description}</span>
        </span>
      </SelectItem>)}
    </SelectContent>
  </Select>
}

function Mode({label,active,onClick}: {label:string;active:boolean;onClick:()=>void}) {
  return <button type="button" className={cn('regime-analytics__mode',active && 'regime-analytics__mode--active')}
    aria-pressed={active} onClick={onClick}>{label}</button>
}
function last(series: VolSeriesPoint[]) { return series.length ? series[series.length-1]!.value : null }
function percent(value: number | null | undefined) { return value==null ? '—' : `${value.toFixed(1)}%` }
function signed(value: number | null | undefined) { return value==null ? '—' : `${value>0 ? '+' : ''}${value.toFixed(2)}` }
function skewReason(reasons: string[] | undefined) {
  if (!reasons?.length) return 'Waiting for a validated skew capture'
  if (reasons.some(r => r.includes('delta_not_bracketed'))) return 'Missing quotes bracketing the selected delta'
  if (reasons.some(r => r.includes('local_wing_price_checks'))) return 'Local wing price checks failed'
  if (reasons.includes('no_maturity_bracket')) return 'No listed expiries bracket this maturity'
  if (reasons.includes('normalization_atm_unavailable')) return 'ATM normalization unavailable'
  if (reasons.some(r => r.includes('asynchronous'))) return 'Source quotes are too far apart in time'
  return `Current unavailable · ${reasons.map(r => r.replaceAll('_',' ')).join(', ')}`
}
