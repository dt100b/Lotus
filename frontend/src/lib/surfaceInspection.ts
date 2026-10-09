import type { VolSeriesPoint } from '@/data/mockTerminal'

export function isSurfaceCurrent(version: string | undefined, asOfMs: number | undefined, nowMs = Date.now()) {
  if (version !== 'desk_vol_surface.v2' || asOfMs == null || !Number.isFinite(asOfMs)) return false
  const age = nowMs-asOfMs
  return age >= -5_000 && age <= 300_000
}

export function isAtmCurveCurrent(version: string | undefined, asOfMs: number | undefined,
  validUntilMs: number | undefined, nowMs = Date.now()) {
  if (version !== 'atm_term_curve.v1' || asOfMs == null || validUntilMs == null
    || !Number.isFinite(asOfMs) || !Number.isFinite(validUntilMs)) return false
  const age = nowMs-asOfMs
  return age >= -5_000 && age <= 300_000 && nowMs <= validUntilMs
}

/** A captured observation stays valid as history after its input quotes expire. */
export function isAtmCaptureValid(version: string | undefined, asOfMs: number | undefined,
  validUntilMs: number | undefined, validated: boolean | undefined,
  nextCaptureMs: number | undefined, captureDueMs: number | undefined, nowMs = Date.now()) {
  return isScheduledCaptureValid('atm_term_curve.v1',version,asOfMs,validUntilMs,validated,nextCaptureMs,captureDueMs,nowMs)
}

export function isScheduledCaptureValid(expectedVersion: string, version: string | undefined, asOfMs: number | undefined,
  validUntilMs: number | undefined, validated: boolean | undefined,
  nextCaptureMs: number | undefined, captureDueMs: number | undefined, nowMs = Date.now()) {
  return version === expectedVersion && validated === true
    && asOfMs != null && validUntilMs != null && nextCaptureMs != null && captureDueMs != null
    && [asOfMs, validUntilMs, nextCaptureMs, captureDueMs].every(Number.isFinite)
    && asOfMs <= nowMs + 5_000 && validUntilMs > asOfMs
    && nextCaptureMs > asOfMs && nextCaptureMs-asOfMs <= 86_400_000
    && captureDueMs === nextCaptureMs+60_000
}

/** Backward as-of join: RV is stamped at completed-bar close. */
export function pairSurfaceRv(iv: VolSeriesPoint[], rv: VolSeriesPoint[]) {
  const source = [...rv].filter((p) => Number.isFinite(p.value)).sort((a,b) => a.tsMs-b.tsMs)
  const pairedIv: VolSeriesPoint[] = []
  const pairedRv: VolSeriesPoint[] = []
  const spread: VolSeriesPoint[] = []
  let index = -1
  let skipped = false
  for (const point of [...iv].sort((a,b) => a.tsMs-b.tsMs)) {
    while (index+1 < source.length && source[index+1]!.tsMs <= point.tsMs) index++
    const realized = source[index]
    if (!Number.isFinite(point.value) || !realized || point.tsMs-realized.tsMs > 3_600_000) { skipped=true; continue }
    pairedIv.push(point)
    pairedRv.push({ tsMs: point.tsMs, value: realized.value })
    const gap = spread.length>0 && (skipped || point.gapBefore)
    spread.push({ tsMs: point.tsMs, value: point.value-realized.value, ...(gap ? {gapBefore:true} : {}) })
    skipped=false
  }
  return { iv: pairedIv, rv: pairedRv, spread }
}

/** Full 60 completed UTC days; current observation is outside its baseline. */
export function dailySpreadZ(series: VolSeriesPoint[], nowMs: number): VolSeriesPoint[] {
  const dayMs = 86_400_000
  const today = Math.floor(nowMs/dayMs)
  const byDay = new Map<number,VolSeriesPoint>()
  for (const p of [...series].sort((a,b) => a.tsMs-b.tsMs)) {
    const day = Math.floor(p.tsMs/dayMs)
    if (day < today && Number.isFinite(p.value)) byDay.set(day,p)
  }
  const out: VolSeriesPoint[] = []
  for (const [day,point] of byDay) {
    const baseline = Array.from({length:60},(_,i) => byDay.get(day-60+i)?.value)
    if (baseline.some((v) => v == null)) continue
    const values = baseline as number[]
    const mean = values.reduce((a,b) => a+b,0)/60
    const sd = Math.sqrt(values.reduce((sum,v) => sum+(v-mean)**2,0)/59)
    if (sd > 1e-12) out.push({ tsMs:point.tsMs,value:(point.value-mean)/sd })
  }
  return out
}
