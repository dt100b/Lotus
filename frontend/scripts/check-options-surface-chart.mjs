/**
 * Behavioral tests for Options Surface density geometry, hover, and UI state.
 * Run: node --import ./frontend/scripts/ts-hooks.mjs ./frontend/scripts/check-options-surface-chart.mjs
 */
import {
  centralIntervals,
  describeDensityOverlays,
  hoverFromServedResult,
  intervalIsNested,
  liveDensityLayers,
  servedCdfIsAligned,
} from '../src/data/optionsSurfaceDensityGeometry.ts'
import { describeSurfaceUi } from '../src/data/optionsSurfacePresentation.ts'
import {
  ATM_IMPLIED_MOVE_LABEL,
  FORBIDDEN_DIRECTIONAL,
  FORBIDDEN_SURFACE_CLAIMS,
  LIVE_DISTRIBUTION_TITLE,
  REJECTED_CATEGORY_COPY,
  REJECTED_DENSITY_TITLE,
  SMILE_CHART_TITLE,
  SYNTHETIC_ATM_TOOLTIP,
  formatForwardQuality,
} from '../src/data/optionsSurfaceDisplay.ts'
import {
  mediumQualityForward,
  readyDensity,
  rejectedDensityUsableSmile,
  residualBudgetRejected,
  servedPassResearchFail,
  sparseRejectedSmile,
} from '../src/data/optionsSurfaceFixtures.ts'
import { isSyntheticSmileMark } from '../src/data/ivSignalSmileGeometry.ts'
import { getIvScannerSummaryReads } from '../src/data/ivSignalOutlook.ts'

let failed = 0
function assert(condition, message) {
  if (!condition) {
    console.error(`fail: ${message}`)
    failed += 1
  }
}

const quantiles = {
  p05: 56000,
  p25: 60000,
  p50: 62885,
  p75: 65000,
  p95: 69000,
}

const intervals = centralIntervals(quantiles)
assert(intervals.central90?.left === 56000 && intervals.central90?.right === 69000, 'P5–P95 creates the 90% fill')
assert(intervals.central50?.left === 60000 && intervals.central50?.right === 65000, 'P25–P75 creates the 50% fill')
assert(intervalIsNested(intervals.central50, intervals.central90), '50% fill is wholly contained within the 90% fill')

const liveLayers = liveDensityLayers({
  eligible: true,
  showCentral50: true,
  showCentral90: true,
  showForward: true,
})
assert(liveLayers.wings === false, 'legacy wings are off in live mode')
assert(liveLayers.sigma === false, 'ATM 1σ strikes are not default layers')
assert(liveLayers.mode === false, 'MODE is not a live layer')
assert(liveLayers.median === false, 'MED is not a live layer')

const overlays = describeDensityOverlays({
  eligible: true,
  layers: liveLayers,
  forward: 62885,
  quantiles,
  hasCurve: true,
})
assert(overlays.some((item) => item.kind === 'central90' && item.left === 56000 && item.right === 69000), '90% overlay maps p05–p95')
assert(overlays.some((item) => item.kind === 'central50' && item.left === 60000 && item.right === 65000), '50% overlay maps p25–p75')
assert(overlays.some((item) => item.kind === 'forward' && item.strike === 62885), 'forward line maps to forward.forwardusd')
assert(overlays.some((item) => item.kind === 'curve'), 'density curve is present when eligible')
assert(!overlays.some((item) => item.kind === 'wings'), 'wings rectangles are not rendered')
assert(!overlays.some((item) => item.kind === 'sigma'), '1σ dashed boundaries are not rendered')
assert(!overlays.some((item) => item.kind === 'mode'), 'MODE marker is not rendered')

const rejectedOverlays = describeDensityOverlays({
  eligible: false,
  layers: liveLayers,
  forward: 62885,
  quantiles,
  hasCurve: true,
})
assert(rejectedOverlays.length === 0, 'rejected density renders no overlays')

assert(servedCdfIsAligned([1, 2, 3], [0.1, 0.5, 0.9]), 'aligned served CDF is accepted')
assert(!servedCdfIsAligned([1, 2, 3], [0.1, 0.5]), 'misaligned CDF is rejected')
assert(!servedCdfIsAligned([1, 2, 3], null), 'missing CDF is rejected')

const hoverWithCdf = hoverFromServedResult({
  strike: 62000,
  density: 0.00004,
  cdf: 0.42,
  forward: 62885,
  quantiles,
})
assert(hoverWithCdf.cdf === 0.42, 'hover uses the served CDF value')
assert(hoverWithCdf.insideCentral50 === true, '62000 is inside central 50%')
assert(hoverWithCdf.versusForward === 'below', 'hover reports below forward')

const hoverWithoutCdf = hoverFromServedResult({
  strike: 70000,
  density: 0.00001,
  cdf: null,
  forward: 62885,
  quantiles,
})
assert(hoverWithoutCdf.cdf === null, 'hover omits CDF when the served field is absent')
assert(hoverWithoutCdf.insideCentral90 === false, '70000 is outside central 90%')

const accepted = describeSurfaceUi(readyDensity, false)
assert(accepted.showDensityChart === true, 'accepted density shows the chart')
assert(accepted.heroTitle === LIVE_DISTRIBUTION_TITLE, 'accepted hero is live/current')
assert(accepted.layers.wings === false && accepted.layers.sigma === false, 'accepted presentation does not enable wings/sigma')
assert(accepted.showMode === false && accepted.showMedian === false, 'customer-facing mode/median are absent')
assert(!/diagnostic|constrained_svi|pchip|residual|config/i.test(`${accepted.heroTitle} ${accepted.heroKicker} ${accepted.heroDetail}`), 'default hero does not foreground model internals')
assert(accepted.legend.find((line) => line.dimension === 'distribution')?.value === 'Available', 'accepted distribution status is Available')
assert(accepted.legend.find((line) => line.dimension === 'smile')?.value === 'Available', 'accepted smile status is Available')

const rejected = describeSurfaceUi(rejectedDensityUsableSmile, false)
assert(rejected.showDensityChart === false, 'rejected density hides the PDF')
assert(rejected.heroTitle === REJECTED_DENSITY_TITLE, 'rejected title is Distribution unavailable')
assert(rejected.rejectedExplanation === REJECTED_CATEGORY_COPY.hard_gate, 'hard-gate rejection uses the validation category')
assert(rejected.layers.central50 === false && rejected.layers.central90 === false, 'rejected density has no interval fills')

const sparse = describeSurfaceUi(sparseRejectedSmile, false)
assert(sparse.rejectedExplanation === REJECTED_CATEGORY_COPY.market_data, 'sparse market uses the coverage category')

const residual = describeSurfaceUi(residualBudgetRejected, false)
assert(residual.rejectedExplanation === REJECTED_CATEGORY_COPY.fit_quality, 'residual-budget rejection uses the fit-quality category')

const delayed = describeSurfaceUi(readyDensity, true)
assert(delayed.showDensityChart === false, 'refresh failure removes the prior PDF immediately')
assert(delayed.heroTitle !== REJECTED_DENSITY_TITLE, 'refresh failure does not use the rejected title')
assert(delayed.showCentralRanges === false, 'refresh failure withholds ranges')
assert(delayed.layers.central90 === false && delayed.layers.central50 === false, 'refresh failure has no stale interval fills')

const research = describeSurfaceUi(servedPassResearchFail, false)
assert(research.showDensityChart === true, 'research-only failure leaves served density visible')
assert(research.warningScope === 'research', 'research failure stays in the research warning scope')
assert(research.researchNotice?.includes('Research SVI'), 'research notice is preserved for Method & quality')

const medium = describeSurfaceUi(mediumQualityForward, false)
assert(medium.forwardLine?.includes('Medium quality'), `medium quality is not upgraded: ${medium.forwardLine}`)
assert(!medium.forwardLine?.includes('High quality'), 'medium quality must not become high')
assert(formatForwardQuality('low') === 'Low quality', 'low quality stays low')
assert(formatForwardQuality('unavailable') === 'Unavailable', 'missing quality is unavailable, not high')

assert(readyDensity.display.metricEligibility.mode.available === false, 'fixture mode is not customer-available')
assert(readyDensity.markers.peakStrike !== readyDensity.rnd.percentile50 || Number.isNaN(readyDensity.markers.peakStrike), 'peakStrike is not presented as p50 mode')
assert(Array.isArray(readyDensity.servedCdf) && readyDensity.servedCdf.length === readyDensity.density.length, 'accepted fixture exposes an aligned served CDF')
assert(rejectedDensityUsableSmile.servedCdf == null, 'rejected fixture has no served CDF')
assert(rejectedDensityUsableSmile.density.length === 0, 'rejected fixture has no density curve')

assert(isSyntheticSmileMark(readyDensity.smile.points.find((point) => point.synthetic)), 'synthetic ATM is classified distinctly')
assert(!isSyntheticSmileMark(readyDensity.smile.points.find((point) => point.optionSide === 'put')), 'raw put mark is not synthetic')

const reads = getIvScannerSummaryReads(readyDensity, false)
assert(reads.some((read) => read.label === ATM_IMPLIED_MOVE_LABEL), 'metrics include ATM implied 1σ move')
assert(reads.some((read) => read.label === 'Central 50% range'), 'metrics include central 50%')
assert(reads.some((read) => read.label === 'Central 90% range'), 'metrics include central 90%')
assert(!reads.some((read) => /mode/i.test(read.label)), 'metrics do not include MODE')

const acceptedCopy = `${accepted.heroTitle} ${accepted.heroDetail} ${accepted.chartTitle} ${accepted.chartSubtitle}`
for (const token of [...FORBIDDEN_DIRECTIONAL, ...FORBIDDEN_SURFACE_CLAIMS]) {
  if (token === 'forecast' && accepted.chartSubtitle.toLowerCase().includes('not a forecast')) continue
  assert(!acceptedCopy.toLowerCase().includes(token), `forbidden token leaked into accepted copy: ${token}`)
}

assert(SMILE_CHART_TITLE === 'Implied volatility smile', 'smile chart title')
assert(SYNTHETIC_ATM_TOOLTIP.includes('not a raw quote'), 'synthetic ATM tooltip')

if (failed) {
  console.error(`${failed} options-surface chart checks failed`)
  process.exit(1)
}
console.log('options-surface density geometry, eligibility, and state checks passed')
