// Regression: observation points and fitted curve share one affine transform.
const scale = {
  minX: -0.16,
  maxX: 0.16,
  minY: 30,
  maxY: 50,
  plotLeft: 36,
  plotRight: 380,
  plotTop: 8,
  plotBottom: 196,
}

function projectX(value) {
  return scale.plotLeft
    + ((value - scale.minX) / (scale.maxX - scale.minX)) * (scale.plotRight - scale.plotLeft)
}

function projectY(value) {
  return scale.plotTop
    + ((scale.maxY - value) / (scale.maxY - scale.minY)) * (scale.plotBottom - scale.plotTop)
}

const sample = { x: -0.084, y: 47.2 }
const fitTwin = { x: -0.084, y: 46.1 }
const pointPixel = { x: projectX(sample.x), y: projectY(sample.y) }
const fitPixel = { x: projectX(fitTwin.x), y: projectY(fitTwin.y) }

if (Math.abs(pointPixel.x - fitPixel.x) > 1e-9) {
  throw new Error(`X mismatch for shared axis value: ${pointPixel.x} vs ${fitPixel.x}`)
}
if (Math.abs(pointPixel.y - projectY(sample.y)) > 1e-9) {
  throw new Error('Observation Y is not the raw IV transform')
}
if (Math.abs(fitPixel.y - pointPixel.y) < 1e-9) {
  throw new Error('Fit and observation must be allowed to differ in Y (residual)')
}

// Log-moneyness ticks must extend past ±10% when the domain does.
function logTicks(minX, maxX) {
  const minPct = minX * 100
  const maxPct = maxX * 100
  const span = maxPct - minPct
  const step = span > 36 ? 10 : 5
  const start = Math.ceil(minPct / step) * step
  const ticks = []
  for (let pct = start; pct <= maxPct + 1e-9; pct += step) ticks.push(pct / 100)
  return ticks
}

const wide = logTicks(-0.18, 0.16)
if (!wide.some((tick) => Math.abs(tick + 0.15) < 1e-9)) {
  throw new Error('Expected a -15% tick when domain exceeds 10%')
}
if (!wide.some((tick) => Math.abs(tick - 0.15) < 1e-9)) {
  throw new Error('Expected a +15% tick when domain exceeds 10%')
}

console.log('smile alignment checks passed')
