import { useId, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { VolSurfaceListedExpiry } from '@/data/mockTerminal'
import { buildListedExpiryGeometry, hasListedIv, listedExpiryRows, type ListedExpirySpacing } from '@/data/listedExpiryGeometry'
import { useContainerSize } from '@/hooks/useContainerSize'

const DATE = new Intl.DateTimeFormat('en-US',{timeZone:'UTC',day:'numeric',month:'short'})
const FULL_DATE = new Intl.DateTimeFormat('en-US',{timeZone:'UTC',day:'numeric',month:'short',year:'numeric'})
const dte = (days:number) => `${days<2 ? days.toFixed(1) : Math.round(days)}d`

/** Actual listed ATM observations, with selectable expiry/time spacing. */
export function ListedExpiryIvChart({rows:input=[],spacing='sqrt-dte'}:{rows?: VolSurfaceListedExpiry[];spacing?: ListedExpirySpacing}) {
  const hostRef=useRef<HTMLDivElement>(null)
  const paintId=useId().replace(/:/g,'')
  const [hovered,setHovered]=useState<number | null>(null)
  const [focused,setFocused]=useState<number | null>(null)
  const {width,height}=useContainerSize(hostRef,400,250,{minWidth:120,minHeight:160})
  const rows=useMemo(()=>listedExpiryRows(input),[input])
  const g=useMemo(()=>buildListedExpiryGeometry(rows,width,height,spacing),[rows,width,height,spacing])
  const active=g.coords.find(coord=>coord.row.expiryTsMs===(focused ?? hovered))
  const move=(event:PointerEvent<SVGSVGElement>)=>{
    const rect=event.currentTarget.getBoundingClientRect()
    const x=(event.clientX-rect.left)/rect.width*width
    const y=(event.clientY-rect.top)/rect.height*height
    if(x<g.plotLeft-10 || x>g.plotRight+10 || y<g.plotTop-15 || y>g.plotBottom+45) {
      setHovered(null);return
    }
    const nearest=g.coords.reduce<typeof g.coords[number] | null>((best,coord)=>
      !best || Math.abs(coord.x-x)<Math.abs(best.x-x) ? coord : best,null)
    setHovered(nearest?.row.expiryTsMs ?? null)
  }
  return <div ref={hostRef} className="regime-listed-chart">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="regime-listed-chart__svg"
      role="group" aria-label="ATM IV by listed expiry, BTC" onPointerMove={move} onPointerLeave={()=>setHovered(null)}>
      <desc>Validated forward ATM mark IV at each actual Deribit listed expiry. {spacing==='expiry' ? 'Listed expiries are equally spaced; horizontal distance does not represent elapsed time.' : 'Horizontal position uses square root of days to expiry.'}
        Straight lines connect observations. Unsupported or expired quotes break the line. Select a marker to inspect its expiry and value.</desc>
      <defs>
        <linearGradient id={`${paintId}-fill`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--terminal-yellow)" stopOpacity={.09}/>
          <stop offset="100%" stopColor="var(--terminal-yellow)" stopOpacity={0}/>
        </linearGradient>
      </defs>
      {g.ticks.map(tick=>{
        const y=g.plotTop+(g.max-tick)/(g.max-g.min)*(g.plotBottom-g.plotTop)
        return <g key={tick} aria-hidden="true">
          <line x1={g.plotLeft-12} x2={g.plotRight+8} y1={y} y2={y} className="regime-term-chart__grid"/>
          <text x={width-7} y={y} textAnchor="end" dominantBaseline="middle" className="regime-term-chart__axis-value">{tick.toFixed(tick%1===0?0:1)}%</text>
        </g>
      })}
      <path d={g.areaPath} fill={`url(#${paintId}-fill)`} aria-hidden="true"/>
      <path d={g.path} className="regime-listed-chart__line" fill="none" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
      <line x1={g.plotLeft-12} x2={g.plotRight+8} y1={g.plotBottom} y2={g.plotBottom} className="regime-term-chart__baseline" stroke="var(--desk-rule)"/>
      {active && <line x1={active.x} x2={active.x} y1={g.plotTop} y2={g.plotBottom} className="regime-listed-chart__guide" strokeDasharray="2 4"/>}
      {g.coords.map(coord=>{
        const {row,x,y,labelY,axisLane}=coord
        const selected=active?.row.expiryTsMs===row.expiryTsMs
        const value=hasListedIv(row) ? `${row.atmIvPercent!.toFixed(1)}%` : 'Unavailable'
        return <g key={row.expiryTsMs}>
          <line x1={x} x2={x} y1={g.plotBottom} y2={g.plotBottom+4} className="regime-listed-chart__tick"/>
          {axisLane!=null && <text x={x} y={g.plotBottom+16} textAnchor="middle" className="regime-listed-chart__date" aria-hidden="true">
            <tspan x={x}>{DATE.format(row.expiryTsMs)}</tspan>
            <tspan x={x} dy={11} className="regime-listed-chart__dte">{dte(row.dteDays)}</tspan>
          </text>}
          {y!=null && labelY!=null && <text x={x} y={labelY} textAnchor="middle" dominantBaseline="middle"
            className="regime-term-chart__point-value regime-listed-chart__value" aria-hidden="true">{value}</text>}
          <g role="img" tabIndex={0} className={`regime-listed-chart__marker${selected?' regime-listed-chart__marker--active':''}`}
            aria-label={`${FULL_DATE.format(row.expiryTsMs)}, ${row.dteDays.toFixed(2)} days to expiry, ATM IV ${value}${row.lowerStrike!=null && row.upperStrike!=null ? `, forward bracket strikes ${row.lowerStrike} and ${row.upperStrike}` : ''}${!hasListedIv(row) ? `, ${row.reasons.join(', ')}` : ''}`}
            onFocus={()=>setFocused(row.expiryTsMs)} onBlur={()=>setFocused(null)} onPointerEnter={()=>setHovered(row.expiryTsMs)}>
            <circle cx={x} cy={y ?? g.plotBottom} r={10} fill="transparent"/>
            <circle cx={x} cy={y ?? g.plotBottom} r={selected?3.5:2.5} className={y==null?'regime-listed-chart__missing':'regime-listed-chart__dot'}/>
          </g>
        </g>
      })}
    </svg>
    <div className="regime-listed-chart__readout" aria-live="polite" aria-atomic="true">
      {active && <><span>{FULL_DATE.format(active.row.expiryTsMs)} · {active.row.dteDays.toFixed(2)}D</span>
        <strong>{hasListedIv(active.row) ? `${active.row.atmIvPercent!.toFixed(2)}% ATM IV` : 'ATM unavailable'}</strong></>}
    </div>
  </div>
}
