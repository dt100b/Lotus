import type { VolSurfaceListedExpiry } from './mockTerminal'
import { buildTermCurveScale } from './termCurveGeometry'

export type ListedExpirySpacing = 'expiry' | 'sqrt-dte'

export function listedExpiryRows(rows: readonly VolSurfaceListedExpiry[] = []) {
  return rows.filter((row) => Number.isFinite(row.expiryTsMs) && row.expiryTsMs > 0
    && Number.isFinite(row.dteDays) && row.dteDays >= 0)
    .sort((a,b) => a.expiryTsMs-b.expiryTsMs)
}

export function hasListedIv(row: VolSurfaceListedExpiry): boolean {
  return row.status === 'ok' && row.atmIvPercent != null && Number.isFinite(row.atmIvPercent) && row.atmIvPercent > 0
}

export function buildListedExpiryGeometry(rows: readonly VolSurfaceListedExpiry[], width: number, height: number, spacing: ListedExpirySpacing = 'sqrt-dte') {
  const plotLeft = 30
  const plotRight = Math.max(plotLeft+1,width-43)
  const plotTop = 30
  const plotBottom = Math.max(plotTop+1,height-62)
  const {min,max,ticks} = buildTermCurveScale(rows.filter(hasListedIv).map(row=>row.atmIvPercent!),plotBottom-plotTop,36)
  const first = Math.sqrt(rows[0]?.dteDays ?? 0)
  const last = Math.sqrt(rows.at(-1)?.dteDays ?? 1)
  const coords = rows.map((row,slotIndex) => {
    const position = spacing === 'expiry'
      ? rows.length>1 ? slotIndex/(rows.length-1) : .5
      : last>first ? (Math.sqrt(row.dteDays)-first)/(last-first) : .5
    const x = plotLeft+position*(plotRight-plotLeft)
    const value = hasListedIv(row) ? row.atmIvPercent! : null
    const y = value == null ? null : plotTop+(max-value)/(max-min)*(plotBottom-plotTop)
    return {row,slotIndex,x,y,labelY:y == null ? null : y-14,axisLane:null as number | null}
  })
  const labels: Array<{x:number;y:number}> = []
  for (const coord of coords) {
    if (coord.y == null) continue
    const candidates=[coord.y-14,coord.y+15,coord.y-29,coord.y+30,coord.y-44,coord.y+45]
    const labelY=candidates.find(y=>y>=9 && y<=plotBottom-8
      && labels.every(previous=>Math.abs(coord.x-previous.x)>=36 || Math.abs(y-previous.y)>=13)
      && coords.every(other=>other.y==null || Math.abs(coord.x-other.x)>=22 || Math.abs(y-other.y)>=9))
    // Extremely dense layouts retain every marker; selection always reveals its value.
    coord.labelY=labelY ?? null
    if(labelY != null)labels.push({x:coord.x,y:labelY})
  }
  // Horizontal dates with DTE underneath; omit labels that would crowd each other.
  // Preserve both endpoints and the lowest-IV expiry, including the front dip.
  const low=coords.filter(coord=>coord.y!=null).reduce<typeof coords[number] | null>((best,coord)=>
    !best || coord.y!>best.y! ? coord : best,null)
  const priorities=[...new Set([coords[0],coords.at(-1),low,...coords].filter(coord=>coord!=null))]
  const axes: number[] = []
  for (const coord of priorities) {
    if(axes.every(x=>Math.abs(x-coord.x)>=36)) {
      coord.axisLane=0
      axes.push(coord.x)
    }
  }
  const segments: Array<Array<typeof coords[number]>> = []
  for(const coord of coords) {
    if(coord.y==null)continue
    const segment=segments.at(-1)
    if(!segment || coord.slotIndex-segment.at(-1)!.slotIndex>1)segments.push([coord])
    else segment.push(coord)
  }
  const line=(segment:typeof coords)=>segment.map((coord,index)=>`${index===0?'M':'L'} ${coord.x} ${coord.y}`).join(' ')
  const path=segments.map(line).join(' ')
  const areaPath=segments.filter(segment=>segment.length>1).map(segment=>
    `${line(segment)} L ${segment.at(-1)!.x} ${plotBottom} L ${segment[0]!.x} ${plotBottom} Z`,
  ).join(' ')
  return {coords,plotLeft,plotRight,plotTop,plotBottom,min,max,ticks,path,areaPath}
}
