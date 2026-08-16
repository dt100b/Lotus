/**
 * Frontend serving-gate presentation checks.
 * Run: node frontend/scripts/check-options-surface-serving.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const presentation = readFileSync(resolve(root, 'src/data/optionsSurfacePresentation.ts'), 'utf8')
const display = readFileSync(resolve(root, 'src/data/optionsSurfaceDisplay.ts'), 'utf8')
const fixtures = readFileSync(resolve(root, 'src/data/optionsSurfaceFixtures.ts'), 'utf8')
const quick = readFileSync(resolve(root, 'src/components/terminal/IvSignalScannerQuickView.tsx'), 'utf8')
const outlook = readFileSync(resolve(root, 'src/data/ivSignalOutlook.ts'), 'utf8')

let failed = 0
function requireIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    console.error(`missing in ${label}: ${needle}`)
    failed += 1
  }
}

requireIncludes(presentation, "chartTitle", 'presentation')
requireIncludes(presentation, "warningScope", 'presentation')
requireIncludes(presentation, "researchNotice", 'presentation')
requireIncludes(display, 'Market-implied distribution — diagnostic fit', 'display')
requireIncludes(display, 'Risk-neutral distribution unavailable', 'display')
requireIncludes(display, 'Research SVI candidate failed convexity diagnostics', 'display')
requireIncludes(presentation, 'DIAGNOSTIC_DISTRIBUTION_TITLE', 'presentation')
requireIncludes(presentation, 'REJECTED_DENSITY_TITLE', 'presentation')
requireIncludes(presentation, 'RESEARCH_CONVEXITY_NOTICE', 'presentation')
requireIncludes(presentation, 'unavailable · call-price convexity failed', 'presentation')
requireIncludes(display, 'densityAnalyticsEligible', 'display')
requireIncludes(quick, 'describeSurfaceUi', 'quickview')
requireIncludes(quick, 'iv-signal-scanner__warning--research', 'quickview')
requireIncludes(quick, 'servedFitterCaption', 'quickview')
requireIncludes(quick, 'metricOf(scan, \'median\')', 'quickview')
requireIncludes(outlook, 'not a forward-quality score', 'outlook')
requireIncludes(outlook, 'Distribution status is independent of the listed-future forward', 'outlook')

const combinations = [
  ['servedPassResearchFail', "customerWarningScope: 'research'"],
  ['servedFailResearchPass', "customerWarningScope: 'served'"],
  ['servedFailResearchFail', "customerWarningScope: 'served'"],
  ['servedPassNoResearch', "customerWarningScope: 'none'"],
]
for (const [name, scope] of combinations) {
  requireIncludes(fixtures, `export const ${name}`, 'fixtures')
  requireIncludes(fixtures, scope, `${name} scope`)
}

requireIncludes(fixtures, 'Research SVI candidate failed convexity diagnostics', 'fixtures')
requireIncludes(fixtures, 'Distribution unavailable: fitted call prices were not convex', 'fixtures')
if (quick.includes('Risk-neutral terminal-price distribution') && !quick.includes('REJECTED_DENSITY_TITLE')) {
  console.error('rejected density still uses a generic distribution title')
  failed += 1
}
if (outlook.toLowerCase().includes('arbitrage-controlled surface') || presentation.toLowerCase().includes('production-grade surface')) {
  console.error('production-grade or arbitrage-controlled copy leaked into customer presentation')
  failed += 1
}

if (failed) process.exit(1)
console.log('options-surface serving-gate presentation checks passed')
