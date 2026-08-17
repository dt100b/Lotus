import type { IvSignalScan } from '@/api/ivSignalScanner'
import {
  DIAGNOSTIC_ANALYTICS_CAPTION,
  DIAGNOSTIC_DISTRIBUTION_TITLE,
  DIAGNOSTIC_MOVE_LABEL,
  REJECTED_DENSITY_TITLE,
  RESEARCH_CONVEXITY_NOTICE,
  SERVED_CONVEXITY_REASON,
  SERVED_CONSTRAINED_SMILE_CAPTION,
  SERVED_PCHIP_CAPTION,
  densityAnalyticsEligible,
  densityIsRejected,
  formatCoverage,
  metricOf,
} from '@/data/optionsSurfaceDisplay'

function formatForwardSource(source: IvSignalScan['selection']['forwardSource']): string {
  if (source === 'matching_future') return 'listed-future forward'
  if (source === 'inverse_put_call_parity' || source === 'parity_pairs') return 'inverse-parity forward'
  if (source === 'venue_underlying_price' || source === 'underlying_price') return 'venue underlying'
  if (source === 'spot_fallback') return 'spot fallback (low quality)'
  return 'forward source unknown'
}

function formatExpiryShort(expiry: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry)
  if (!iso) return expiry
  const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatExpectedMovePercent(rnd: Pick<IvSignalScan['rnd'], 'expectedMoveUp' | 'expectedMoveDown' | 'forward'>): string {
  const dollars = (rnd.expectedMoveUp + rnd.expectedMoveDown) / 2
  const percent = rnd.forward > 0 ? (dollars / rnd.forward) * 100 : 0
  if (!(dollars > 0) || !Number.isFinite(percent)) return '—'
  return `±${percent.toFixed(1)}%`
}

export type SurfaceLegendLine = {
  dimension: 'forward' | 'smile' | 'distribution'
  label: string
  value: string
}

export type SurfacePresentation = {
  chartTitle: string
  heroKicker: string
  heroTitle: string
  heroKeyPhrase: string | null
  heroDetail: string
  showDensityChart: boolean
  showMedian: boolean
  showMode: boolean
  showCentralRanges: boolean
  customerNotice: string | null
  researchNotice: string | null
  warningScope: 'served' | 'research' | 'none'
  legend: SurfaceLegendLine[]
}

export function describeSurfaceUi(
  scan: Pick<IvSignalScan, 'display' | 'rnd' | 'expiry' | 'selection' | 'smile'>,
  refreshFailed = false,
): SurfacePresentation {
  const eligible = densityAnalyticsEligible(scan)
  const rejected = densityIsRejected(scan)
  const diagnostic = scan.display.servedFitterGrade === 'diagnostic'
    || scan.display.servedFitterGrade === 'diagnostic_candidate'
    || scan.display.servedFitterName === 'tv_pchip'
    || scan.display.servedFitterName === 'constrained_svi'
    || scan.display.smileStatus === 'degraded'
    || scan.display.smileStatus === 'research'
  const source = formatForwardSource(scan.selection.forwardSource)
  const forwardQuality = scan.selection.forwardSource === 'spot_fallback' ? 'low quality' : 'high quality'
  const expiry = formatExpiryShort(scan.expiry)
  const scope = scan.display.customerWarningScope
  const servedConvexity = scan.display.reasonCodes.includes('call_not_convex_in_strike')
  const customerNotice = customerFacingNotice(scan, refreshFailed, rejected, servedConvexity)
  const researchNotice = researchFacingNotice(scan, rejected)

  let chartTitle = DIAGNOSTIC_DISTRIBUTION_TITLE
  let heroKicker = DIAGNOSTIC_DISTRIBUTION_TITLE
  let heroTitle = `${DIAGNOSTIC_MOVE_LABEL} ${formatExpectedMovePercent(scan.rnd)}`
  let heroKeyPhrase: string | null = source
  let heroDetail = `To ${expiry}`
  if (eligible) {
    const lo = scan.rnd.percentile25
    const hi = scan.rnd.percentile75
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      heroDetail = `To ${expiry} · market-implied central 50% ${formatCompact(lo)}–${formatCompact(hi)}`
    }
  }
  if (refreshFailed) {
    chartTitle = REJECTED_DENSITY_TITLE
    heroKicker = 'Options-implied forward'
    heroTitle = 'Surface delayed'
    heroKeyPhrase = null
    heroDetail = `Expiry ${expiry} · ${source} · live book not current`
  } else if (rejected) {
    chartTitle = REJECTED_DENSITY_TITLE
    heroKicker = REJECTED_DENSITY_TITLE
    heroTitle = REJECTED_DENSITY_TITLE
    heroKeyPhrase = null
    heroDetail = `Expiry ${expiry} · ${source} · ${forwardQuality}`
    if (scan.display.humanReadableReason) {
      heroDetail = `${heroDetail} · ${scan.display.humanReadableReason}`
    }
  } else if (!diagnostic) {
    chartTitle = 'Market-implied distribution'
    heroKicker = 'Market-implied distribution'
    heroTitle = `${formatExpectedMovePercent(scan.rnd)} implied move`
  } else {
    heroKicker = DIAGNOSTIC_ANALYTICS_CAPTION
    chartTitle = DIAGNOSTIC_DISTRIBUTION_TITLE
  }

  return {
    chartTitle,
    heroKicker,
    heroTitle,
    heroKeyPhrase,
    heroDetail,
    showDensityChart: eligible,
    showMedian: eligible && metricOf(scan, 'median').available,
    showMode: eligible && metricOf(scan, 'mode').available,
    showCentralRanges: eligible && metricOf(scan, 'central_range_50').available,
    customerNotice,
    researchNotice,
    warningScope: refreshFailed ? 'served' : scope,
    legend: buildLegend(scan, eligible, rejected),
  }
}

function customerFacingNotice(
  scan: Pick<IvSignalScan, 'display'>,
  refreshFailed: boolean,
  rejected: boolean,
  servedConvexity: boolean,
): string | null {
  if (refreshFailed) return 'Live options data is delayed. Surface quality is shown as degraded.'
  if (rejected || servedConvexity) {
    if (servedConvexity) return SERVED_CONVEXITY_REASON
    return scan.display.humanReadableReason || REJECTED_DENSITY_TITLE
  }
  return null
}

function researchFacingNotice(
  scan: Pick<IvSignalScan, 'display'>,
  rejected: boolean,
): string | null {
  if (scan.display.researchHumanReason) return scan.display.researchHumanReason
  if (scan.display.researchFailedChecks.length) return scan.display.researchFailedChecks[0] ?? null
  if (!rejected && scan.display.customerWarningScope === 'research') return RESEARCH_CONVEXITY_NOTICE
  return null
}

function buildLegend(
  scan: Pick<IvSignalScan, 'display' | 'selection'>,
  eligible: boolean,
  rejected: boolean,
): SurfaceLegendLine[] {
  const source = formatForwardSource(scan.selection.forwardSource)
  const forwardQuality = scan.selection.forwardSource === 'spot_fallback' ? 'low quality' : 'high quality'
  const fitter = scan.display.servedFitterName || 'tv_pchip'
  const grade = scan.display.servedFitterGrade || 'diagnostic'
  const smileValue = fitter === 'tv_pchip'
    ? `${fitter} · ${grade}`
    : `${fitter} · ${grade}`
  let distributionValue = 'available · all serving checks passed'
  if (rejected) {
    if (scan.display.reasonCodes.includes('call_not_convex_in_strike')) {
      distributionValue = 'unavailable · call-price convexity failed'
    } else if (scan.display.reasonCodes.includes('call_not_decreasing_in_strike')) {
      distributionValue = 'unavailable · call-price monotonicity failed'
    } else {
      distributionValue = 'unavailable · distribution validation failed'
    }
  } else if (scan.display.densityStatus === 'degraded') {
    distributionValue = eligible
      ? 'available · diagnostic serving checks passed'
      : 'unavailable · distribution validation failed'
  }
  return [
    { dimension: 'forward', label: 'Forward', value: `${source.replace('listed-future forward', 'listed future')} · ${forwardQuality}` },
    { dimension: 'smile', label: 'Smile', value: smileValue },
    { dimension: 'distribution', label: 'Distribution', value: distributionValue },
  ]
}

export function servedFitterCaption(scan: Pick<IvSignalScan, 'display'>): string {
  if (scan.display.servedFitterName === 'constrained_svi') return SERVED_CONSTRAINED_SMILE_CAPTION
  if (scan.display.servedFitterName === 'tv_pchip') return SERVED_PCHIP_CAPTION
  return `Served ${scan.display.servedFitterGrade} interpolant: ${scan.display.servedFitterName}`
}

export function coverageCaption(scan: Pick<IvSignalScan, 'selection' | 'coverage'>): string {
  return formatCoverage(scan)
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`
  return `$${Math.round(value)}`
}
