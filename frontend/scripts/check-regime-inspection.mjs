import assert from 'node:assert/strict'
import { pairSurfaceRv, dailySpreadZ, isSurfaceCurrent, isAtmCurveCurrent, isAtmCaptureValid, isScheduledCaptureValid } from '../src/lib/surfaceInspection.ts'
import { createDynamicMiniChartPriceFormat } from '../src/data/miniChartAxis.ts'

const hour=3_600_000, day=24*hour
assert(!isSurfaceCurrent('desk_vol_surface.v1',day,day),'Do not reuse the old surface')
assert(!isSurfaceCurrent('desk_vol_surface.v2',day,day+300_001),'Stale current levels must be withheld')
assert(!isSurfaceCurrent('desk_vol_surface.v2',undefined,day),'Unknown as-of is not fresh')
assert(isSurfaceCurrent('desk_vol_surface.v2',day,day+300_000),'Fresh v2 levels are available')
assert(isAtmCurveCurrent('atm_term_curve.v1',day,day+100_000,day+100_000))
assert(!isAtmCurveCurrent('atm_term_curve.v1',day,day+100_000,day+100_001),'Cached quote expiry cannot be renewed')
assert(!isAtmCurveCurrent('atm_term_curve.v1',day,undefined,day),'Require input freshness metadata')
assert(!isAtmCurveCurrent('desk_vol_surface.v2',day,day+300_000,day),'Keep the estimators versioned separately')
assert(isAtmCaptureValid('atm_term_curve.v1',day,day+300_000,true,day+600_000,day+660_000,day+540_000),'Captured values survive quote expiry')
assert(isAtmCaptureValid('atm_term_curve.v1',day,day+300_000,true,day+600_000,day+660_000,day+900_000),'Overdue captures remain observations, labelled separately')
assert(!isAtmCaptureValid('atm_term_curve.v1',day,day,true,day+600_000,day+660_000,day),'Expired inputs cannot become valid captures')
assert(!isAtmCaptureValid('atm_term_curve.v1',day,day+300_000,false,day+600_000,day+660_000,day),'Require explicit capture validation')
assert(!isAtmCaptureValid('atm_term_curve.v1',day,day+300_000,true,day+600_000,Infinity,day),'Reject invalid schedule metadata')
assert(isScheduledCaptureValid('local_delta_skew.v1','local_delta_skew.v1',day,day+300_000,true,day+600_000,day+660_000,day))
assert(!isScheduledCaptureValid('local_delta_skew.v1','desk_vol_surface.v2',day,day+300_000,true,day+600_000,day+660_000,day),'Do not relabel legacy skew')
const rv=[{tsMs:hour,value:30},{tsMs:3*hour,value:99}]
const paired=pairSurfaceRv([{tsMs:0,value:50},{tsMs:hour,value:50},{tsMs:2*hour+1,value:50}],rv)
assert.deepEqual(paired.spread,[{tsMs:hour,value:20}])
assert.equal(paired.rv[0].value,30,'Never use a future RV value')
const gap=pairSurfaceRv([{tsMs:hour,value:40},{tsMs:4*hour,value:41,gapBefore:true}],
  [{tsMs:hour,value:30},{tsMs:4*hour,value:31}])
assert(gap.spread[1].gapBefore,'Preserve missing IV hours in spread charts')
const daily=Array.from({length:61},(_,i)=>({tsMs:(i+1)*day,value:i%2 ? 10 : 20}))
assert.equal(dailySpreadZ(daily,63*day).length,1,'Require a full prior baseline')
assert.equal(dailySpreadZ(daily.slice(1),63*day).length,0,'Do not show a partial 60D baseline')
assert.equal(dailySpreadZ(daily,61*day).length,0,'Exclude incomplete current UTC day')
assert.equal(dailySpreadZ(daily.filter((_,i)=>i!==10),63*day).length,0,'Missing daily baseline cannot be compressed')
for (const step of [3,1.5,.2,.15,.05]) {
  const format=createDynamicMiniChartPriceFormat({current:step},String,step)
  assert(Number.isInteger(Math.log10(format.minMove)),'Native tick bases must use decimal powers')
}
console.log('Inspection history join and 60D baseline checks passed')
