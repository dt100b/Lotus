import type { IvSignalScan } from '@/api/ivSignalScanner'

export type QuoteStatus = 'accepted' | 'degraded' | 'rejected'
export type SmileStatus = 'accepted' | 'degraded' | 'rejected' | 'research'
export type DensityStatus = 'accepted' | 'degraded' | 'rejected' | 'unavailable'
export type SurfaceDisplayStatus = 'ready' | 'degraded' | 'rejected' | 'unavailable'

export type MetricEligibility = {
  available: boolean
  reasonCode: string | null
  reason: string | null
}

export type WarningScope = 'served' | 'research' | 'none'
export type FitterGrade = 'production' | 'diagnostic' | 'research'

export type SurfaceDisplayState = {
  quoteStatus: QuoteStatus
  smileStatus: SmileStatus
  densityStatus: DensityStatus
  surfaceDisplayStatus: SurfaceDisplayStatus
  reasonCodes: string[]
  humanReadableReason: string
  diagnosticDetail: string
  failedChecks: string[]
  metricEligibility: Record<string, MetricEligibility>
  servedFitterName: string
  servedFitterGrade: FitterGrade
  researchFitterName: string | null
  researchFailedChecks: string[]
  researchHumanReason: string | null
  customerWarningScope: WarningScope
}

export type DensityDiagnostic = {
  label: string
  isValidDistribution: false
  strikesUsd: number[]
  rawDensity: number[]
}

export const DIAGNOSTIC_DENSITY_LABEL = 'Diagnostic only — not a valid probability distribution'

export const REJECTED_DENSITY_TITLE = 'Risk-neutral distribution unavailable'

export const REJECTED_DENSITY_BODY =
  'The fitted smile did not meet distribution-validity checks for this expiry. Probability ranges and percentiles are withheld.'

export const DIAGNOSTIC_DISTRIBUTION_TITLE = 'Market-implied distribution — diagnostic fit'

export const DIAGNOSTIC_ANALYTICS_CAPTION = 'Market-implied analytics — diagnostic fit'

export const DIAGNOSTIC_SMILE_CAPTION =
  'Diagnostic interpolant; not promoted to an arbitrage-controlled surface.'

export const DIAGNOSTIC_MOVE_LABEL = 'Diagnostic smile-implied 1σ move'

export const SERVED_PCHIP_CAPTION = 'Served diagnostic interpolant: tv_pchip'

export const RESEARCH_CONVEXITY_NOTICE =
  'Research SVI candidate failed convexity diagnostics; it is not used for the displayed surface.'

export const SERVED_CONVEXITY_REASON =
  'Distribution unavailable: fitted call prices were not convex across the observed strike range.'

export function emptyEligibility(reason = 'Unavailable'): MetricEligibility {
  return { available: false, reasonCode: null, reason }
}

export function metricOf(
  scan: Pick<IvSignalScan, 'display'>,
  name: string,
): MetricEligibility {
  return scan.display.metricEligibility[name] ?? emptyEligibility()
}

export function densityIsRejected(scan: Pick<IvSignalScan, 'display'>): boolean {
  return scan.display.densityStatus === 'rejected' || scan.display.densityStatus === 'unavailable'
}

export function densityAnalyticsEligible(scan: Pick<IvSignalScan, 'display'>): boolean {
  if (densityIsRejected(scan)) return false
  const chart = scan.display.metricEligibility.density_chart
  if (chart) return chart.available
  return scan.display.densityStatus === 'accepted' || scan.display.densityStatus === 'degraded'
}

export function smileIsDiagnostic(scan: Pick<IvSignalScan, 'display'>): boolean {
  return scan.display.smileStatus === 'degraded'
    || scan.display.smileStatus === 'research'
    || scan.display.smileStatus === 'rejected'
}

export function formatCoverage(scan: Pick<IvSignalScan, 'selection' | 'coverage'>): string {
  const accepted = scan.selection.selectedMarketStrikes
  const below = scan.coverage.lowerStrikes
  const above = scan.coverage.upperStrikes
  const gap = scan.coverage.centerLogGap
  const gapText = gap == null ? 'center gap n/a' : `center gap ${gap.toFixed(3)} k`
  return `${accepted} accepted observation${accepted === 1 ? '' : 's'} · ${below} below / ${above} above forward · ${gapText}`
}

export function unavailableValue(eligibility: MetricEligibility): { value: string; detail: string } {
  return {
    value: 'Unavailable',
    detail: eligibility.reason || 'Unavailable',
  }
}

export function statusLabel(status: string): string {
  if (status === 'research') return 'Research'
  if (status === 'degraded') return 'Degraded'
  if (status === 'rejected' || status === 'unavailable') return 'Rejected'
  if (status === 'ready' || status === 'accepted') return 'Accepted'
  return status
}

export const FORBIDDEN_DIRECTIONAL = [
  'long',
  'short',
  'bullish',
  'bearish',
  'forecast',
  'verdict',
  'buy',
  'sell',
]
