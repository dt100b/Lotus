import assert from 'node:assert/strict'
import {buildTermCurvePaths,buildTermCurveScale,frontElevationEndSlot} from '../src/data/termCurveGeometry.ts'

const screenshotScale=buildTermCurveScale([35,36.3,37.3,37.86],240)
assert(screenshotScale.max-screenshotScale.min<=4,'Ordinary curves should use most of the plot height')
assert.deepEqual(screenshotScale.ticks,[38,37,36,35])
for(const values of [[38,38,38,38],[38,38.01,38.02,38.03],[.1,.2,.3,.4],[35,36.3,37.3,37.86,55],[100,101,102,103]]) {
  for(const height of [60,120,240,600]) {
    const {min,max,ticks}=buildTermCurveScale(values,height)
    assert(min>=0 && min<=Math.min(...values) && max>=Math.max(...values),'Every tenor and visible benchmark stays within the scale')
    assert(max-min>=2,'Nearly flat curves must not magnify hundredths into a large slope')
    assert(ticks.length>=2 && ticks.length<=5,'Tick density should remain readable')
    assert(ticks.every(tick=>tick>=min && tick<=max))
  }
}
console.log('Term scale uses clean ticks, fits tenors and benchmarks, and keeps flat curves honest')

// Check rendered cubic segments against observations, including local extrema.
for(const ys of [[4,2,1,0],[0,4,1,3],[2,2,2,2],[0,1,1,4]]) {
  const points=ys.map((y,i)=>({x:[0,46,106,346][i],y,slotIndex:i}))
  const {path}=buildTermCurvePaths(points,10)
  const commands=path.match(/[MLCZ][^MLCZ]*/g)
  let previous=points[0]
  let segment=0
  for(const command of commands) {
    if(command[0]!=='C')continue
    const [x1,y1,x2,y2,x3,y3]=command.slice(1).split(',').map(Number)
    const next=points[++segment]
    assert.equal(x3,next.x)
    assert.equal(y3,next.y)
    for(let step=0;step<=200;step++) {
      const t=step/200,s=1-t
      const x=s**3*previous.x+3*s*s*t*x1+3*s*t*t*x2+t**3*x3
      const y=s**3*previous.y+3*s*s*t*y1+3*s*t*t*y2+t**3*y3
      assert(x>=previous.x-1e-6 && x<=next.x+1e-6)
      assert(y>=Math.min(previous.y,next.y)-1e-6 && y<=Math.max(previous.y,next.y)+1e-6)
    }
    previous=next
  }
  assert.equal(segment,3)
}
const gap=buildTermCurvePaths([{x:0,y:2,slotIndex:0},{x:200,y:1,slotIndex:2},{x:300,y:0,slotIndex:3}],10)
assert.equal((gap.path.match(/M/g)||[]).length,2)
assert.equal((gap.areaPath.match(/M/g)||[]).length,1)
assert.equal((gap.areaPath.match(/Z/g)||[]).length,1)
console.log('Smooth curve passes through tenor values without overshoot; line and shading preserve gaps')
const curve=(values)=>values.flatMap((value,slotIndex)=>value==null?[]:[{slotIndex,value}])
assert.equal(frontElevationEndSlot(curve([32,35,36,38])),null)
assert.equal(frontElevationEndSlot(curve([40,40,39,38])),null)
assert.equal(frontElevationEndSlot(curve([42,39,43,44])),1)
assert.equal(frontElevationEndSlot(curve([42,39,40,44])),2)
assert.equal(frontElevationEndSlot(curve([44,41,40,39])),3)
assert.equal(frontElevationEndSlot(curve([42,39,43,38])),1)
assert.equal(frontElevationEndSlot(curve([42,null,39,38])),null)
assert.equal(frontElevationEndSlot(curve([42,39,null,38])),1)
assert.equal(frontElevationEndSlot(curve([null,39,38,37])),null)
assert.equal(frontElevationEndSlot(curve([NaN,39,38,37])),null)
console.log('Front premium expands through lower consecutive tenors and stops at equality, a higher tenor, or missing data')
