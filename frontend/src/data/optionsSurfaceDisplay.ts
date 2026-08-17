import type { IvSignalScan } from '../api/ivSignalScanner'

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
export type FitterGrade = 'production' | 'diagnostic' | 'diagnostic_candidate' | 'research'
export type ServingMode = 'diagnostic_candidate' | 'shadow_compare' | 'disabled'
export type PrimaryFailureCategory = 'none' | 'market_data' | 'fit_quality' | 'hard_gate'

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
  servingMode: ServingMode
  configVersion: string | null
  configHash: string | null
  primaryFailureCategory: PrimaryFailureCategory | null
  residualBudgetOk: boolean | null
}

export type DensityDiagnostic = {
  label: string
  isValidDistribution: false
  strikesUsd: number[]
  rawDensity: number[]
}

export const DIAGNOSTIC_DENSITY_LABEL = 'Diagnostic only — not a valid probability distribution'

export const REJECTED_DENSITY_TITLE = 'Distribution unavailable'

export const REJECTED_DENSITY_BODY =
  'Ranges and percentile estimates are withheld for this expiry.'

export const REJECTED_DENSITY_SUPPORTING = REJECTED_DENSITY_BODY

export const REJECTED_CATEGORY_COPY: Record<Exclude<PrimaryFailureCategory, 'none'>, string> = {
  market_data: 'Insufficient market coverage',
  fit_quality: 'The market quotes could not support a reliable fitted distribution',
  hard_gate: 'Distribution validation failed',
}

export const LIVE_DISTRIBUTION_TITLE = 'Live options-implied distribution'

export const DENSITY_CHART_TITLE = 'Options-implied terminal-price distribution'

export const DENSITY_CHART_SUBTITLE =
  'Risk-neutral market-implied probabilities, not a forecast'

export const CENTRAL_RANGE_TOOLTIP =
  'Risk-neutral market-implied interval; not a forecast range'

export const ATM_IMPLIED_MOVE_LABEL = 'ATM implied 1σ move'

export const SMILE_CHART_TITLE = 'Implied volatility smile'

export const SMILE_CHART_SUBTITLE = 'Observed option IVs and fitted market smile'

export const SYNTHETIC_ATM_TOOLTIP = 'Synthetic ATM reference — not a raw quote'

export const DIAGNOSTIC_DISTRIBUTION_TITLE = 'Market-implied distribution — diagnostic fit'

export const DIAGNOSTIC_ANALYTICS_CAPTION = 'Market-implied analytics — diagnostic fit'

export const DIAGNOSTIC_SMILE_CAPTION =
  'Diagnostic interpolant; not promoted to an arbitrage-controlled surface.'

export const DIAGNOSTIC_MOVE_LABEL = 'Diagnostic smile-implied 1σ move'

export const SERVED_PCHIP_CAPTION = 'Served diagnostic interpolant: tv_pchip'

export const SERVED_CONSTRAINED_SMILE_CAPTION = 'Served constrained smile — diagnostic candidate'

export const FAILURE_CATEGORY_LABEL: Record<PrimaryFailureCategory, string> = {
  none: 'No serving failure',
  market_data: 'Market-data / coverage failure',
  fit_quality: 'Fit-quality failure',
  hard_gate: 'Hard no-arbitrage / numerical failure',
}

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

export const FORBIDDEN_SURFACE_CLAIMS = [
  'arbitrage-free',
  'arbitrage-controlled',
  'production-grade',
  'fair value',
  'confidence interval',
  'price forecast',
]

export type ForwardSourceQuality = 'high' | 'medium' | 'low' | 'unavailable'

export function rejectedDensityExplanation(
  scan: Pick<IvSignalScan, 'display'>,
): string {
  const category = scan.display.primaryFailureCategory
  if (category && category !== 'none' && REJECTED_CATEGORY_COPY[category]) {
    return REJECTED_CATEGORY_COPY[category]
  }
  const codes = scan.display.reasonCodes
  if (codes.includes('insufficient_or_sparse_observations') || codes.includes('sparse_quotes')) {
    return REJECTED_CATEGORY_COPY.market_data
  }
  if (codes.includes('residual_budget_exceeded')) {
    return REJECTED_CATEGORY_COPY.fit_quality
  }
  if (
    codes.includes('call_not_convex_in_strike')
    || codes.includes('call_not_decreasing_in_strike')
    || codes.includes('cdf_not_monotone')
    || codes.includes('negative_density_mass')
  ) {
    return REJECTED_CATEGORY_COPY.hard_gate
  }
  return scan.display.humanReadableReason || REJECTED_CATEGORY_COPY.hard_gate
}

export function formatForwardQuality(quality: ForwardSourceQuality | string | null | undefined): string {
  if (quality === 'high') return 'High quality'
  if (quality === 'medium') return 'Medium quality'
  if (quality === 'low') return 'Low quality'
  return 'Unavailable'
}

export function formatLiveForwardSource(
  source: IvSignalScan['selection']['forwardSource'],
): string {
  if (source === 'matching_future') return 'Listed future'
  if (source === 'inverse_put_call_parity' || source === 'parity_pairs') return 'Inverse parity'
  if (source === 'venue_underlying_price' || source === 'underlying_price') return 'Venue underlying'
  if (source === 'spot_fallback') return 'Spot fallback'
  return 'Forward source unknown'
}
