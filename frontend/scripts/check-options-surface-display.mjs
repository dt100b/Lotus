/**
 * Fixture assertions for rejected/degraded options-surface display states.
 * Run: node frontend/scripts/check-options-surface-display.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outlook = readFileSync(resolve(root, 'src/data/ivSignalOutlook.ts'), 'utf8')
const display = readFileSync(resolve(root, 'src/data/optionsSurfaceDisplay.ts'), 'utf8')
const quick = readFileSync(resolve(root, 'src/components/terminal/IvSignalScannerQuickView.tsx'), 'utf8')
const density = readFileSync(resolve(root, 'src/components/terminal/IvSignalDensityChart.tsx'), 'utf8')
const fixtures = readFileSync(resolve(root, 'src/data/optionsSurfaceFixtures.ts'), 'utf8')
const presentation = readFileSync(resolve(root, 'src/data/optionsSurfacePresentation.ts'), 'utf8')

const mustInclude = [
  [display, 'Distribution unavailable'],
  [display, 'Ranges and percentile estimates are withheld for this expiry.'],
  [display, 'Diagnostic only — not a valid probability distribution'],
  [display, 'Diagnostic interpolant; not promoted to an arbitrage-controlled surface.'],
  [display, 'Market-implied distribution — diagnostic fit'],
  [display, 'Diagnostic smile-implied 1σ move'],
  [display, 'Served diagnostic interpolant: tv_pchip'],
  [display, 'Served constrained smile — diagnostic candidate'],
  [display, 'Research SVI candidate failed convexity diagnostics'],
  [display, 'Distribution unavailable: fitted call prices were not convex'],
  [display, 'Live options-implied distribution'],
  [display, 'ATM implied 1σ move'],
  [display, 'Insufficient market coverage'],
  [display, 'The market quotes could not support a reliable fitted distribution'],
  [outlook, 'ATM_IMPLIED_MOVE_LABEL'],
  [outlook, 'describeSurfaceUi'],
  [quick, 'View diagnostic details'],
  [quick, 'Method & quality'],
  [display, 'Market-data / coverage failure'],
  [display, 'Fit-quality failure'],
  [display, 'Hard no-arbitrage / numerical failure'],
  [quick, 'REJECTED_DENSITY_TITLE'],
  [quick, 'SurfaceStatusLegend'],
  [quick, 'Research diagnostics'],
  [density, "mode = 'probability'"],
  [density, 'Diagnostic residual — not a probability'],
  [density, 'layers.central90'],
  [density, 'layers.central50'],
  [presentation, 'showMode: false'],
  [fixtures, 'rejectedDensityUsableSmile'],
  [fixtures, 'readyDensity'],
  [fixtures, 'degradedDensity'],
  [fixtures, 'sparseRejectedSmile'],
  [fixtures, 'unavailableForward'],
  [fixtures, 'servedPassResearchFail'],
  [fixtures, 'servedFailResearchPass'],
  [fixtures, 'servedFailResearchFail'],
  [fixtures, 'servedPassNoResearch'],
  [fixtures, 'residualBudgetRejected'],
  [fixtures, 'mediumQualityForward'],
]

const mustNotInclude = [
  [outlook, 'quality ${quality.toLowerCase()}'],
  [outlook, 'liquid strike'],
  [quick, 'Waiting on quote quality'],
  [quick, 'DEFAULT_DENSITY_LAYERS'],
  [density, 'buildCumulative'],
  [quick, '<em>Mode</em>'],
]

const forbidden = [/\bbullish\b/, /\bbearish\b/, /\blong\/short\b/, /\bprice forecast\b/]

let failed = 0
for (const [source, needle] of mustInclude) {
  if (!source.includes(needle)) {
    console.error(`missing: ${needle}`)
    failed += 1
  }
}
for (const [source, needle] of mustNotInclude) {
  if (source.includes(needle)) {
    console.error(`forbidden leftover: ${needle}`)
    failed += 1
  }
}
for (const file of [outlook, display, quick, presentation]) {
  const lower = file.toLowerCase()
  for (const token of forbidden) {
    if (token.test(lower) && !lower.includes('not a') && !lower.includes('not a directional')) {
      console.error(`directional token ${token}`)
      failed += 1
    }
  }
}
if (failed) {
  process.exit(1)
}
console.log('options-surface display copy and fixture checks passed')
