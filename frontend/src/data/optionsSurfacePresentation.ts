import type { IvSignalScan } from '../api/ivSignalScanner'
import {
  ATM_IMPLIED_MOVE_LABEL,
  DENSITY_CHART_SUBTITLE,
  DENSITY_CHART_TITLE,
  DIAGNOSTIC_ANALYTICS_CAPTION,
  DIAGNOSTIC_DISTRIBUTION_TITLE,
  LIVE_DISTRIBUTION_TITLE,
  REJECTED_DENSITY_BODY,
  REJECTED_DENSITY_TITLE,
  RESEARCH_CONVEXITY_NOTICE,
  SERVED_CONSTRAINED_SMILE_CAPTION,
  SERVED_PCHIP_CAPTION,
  densityAnalyticsEligible,
  densityIsRejected,
  formatCoverage,
  formatForwardQuality,
  formatLiveForwardSource,
  metricOf,
  rejectedDensityExplanation,
} from './optionsSurfaceDisplay'
import {
  emptyDensityLayers,
  liveDensityLayers,
  type DensityLayerFlags,
} from './optionsSurfaceDensityGeometry'

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

export type SurfaceLegendLine = {
  dimension: 'forward' | 'smile' | 'distribution'
  label: string
  value: string
}

export type SurfacePresentation = {
  chartTitle: string
  chartSubtitle: string
  heroKicker: string
  heroTitle: string
  heroKeyPhrase: string | null
  heroDetail: string
  forwardLine: string | null
  showLiveFreshness: boolean
  showDensityChart: boolean
  showMedian: boolean
  showMode: boolean
  showCentralRanges: boolean
  showCentral50: boolean
  showCentral90: boolean
  layers: DensityLayerFlags
  customerNotice: string | null
  researchNotice: string | null
  warningScope: 'served' | 'research' | 'none'
  rejectedExplanation: string | null
  legend: SurfaceLegendLine[]
}

export function describeSurfaceUi(
  scan: Pick<IvSignalScan, 'display' | 'rnd' | 'expiry' | 'selection' | 'smile'> & Partial<Pick<IvSignalScan, 'freshness' | 'asOf' | 'underlying'>>,
  refreshFailed = false,
): SurfacePresentation {
  const eligible = !refreshFailed && densityAnalyticsEligible(scan)
  const rejected = !refreshFailed && densityIsRejected(scan)
  const source = formatLiveForwardSource(scan.selection.forwardSource)
  const quality = formatForwardQuality(scan.selection.forwardSourceQuality)
  const expiry = formatExpiryShort(scan.expiry)
  const scope = scan.display.customerWarningScope
  const servedConvexity = scan.display.reasonCodes.includes('call_not_convex_in_strike')
  const customerNotice = customerFacingNotice(scan, refreshFailed, rejected, servedConvexity)
  const researchNotice = researchFacingNotice(scan, rejected)
  const showCentral50 = eligible && metricOf(scan, 'central_range_50').available
  const showCentral90 = eligible && metricOf(scan, 'central_range_90').available
  const showForward = Number.isFinite(scan.rnd.forward)
  const updated = formatUpdatedAge({
    asOf: scan.asOf ?? '',
    freshness: scan.freshness ?? { snapshotAgeSeconds: 0, thresholdSeconds: 180, isFresh: false },
  })
  const forwardLine = showForward
    ? `Forward ${formatUsd(scan.rnd.forward)} · ${source} · ${quality}`
    : null

  let chartTitle = DENSITY_CHART_TITLE
  let chartSubtitle = DENSITY_CHART_SUBTITLE
  let heroKicker: string = scan.underlying || 'BTC'
  let heroTitle = LIVE_DISTRIBUTION_TITLE
  let heroKeyPhrase: string | null = null
  let heroDetail = `${scan.underlying || 'BTC'} · ${expiry} · ${updated}`
  let rejectedExplanation: string | null = null

  if (refreshFailed) {
    chartTitle = LIVE_DISTRIBUTION_TITLE
    chartSubtitle = 'Live options data is delayed'
    heroKicker = 'Options-implied forward'
    heroTitle = 'Surface delayed'
    heroDetail = `Expiry ${expiry} · live book not current`
  } else if (rejected) {
    chartTitle = REJECTED_DENSITY_TITLE
    chartSubtitle = REJECTED_DENSITY_BODY
    heroKicker = REJECTED_DENSITY_TITLE
    heroTitle = REJECTED_DENSITY_TITLE
    rejectedExplanation = rejectedDensityExplanation(scan)
    heroDetail = rejectedExplanation
  }

  return {
    chartTitle,
    chartSubtitle,
    heroKicker,
    heroTitle,
    heroKeyPhrase,
    heroDetail,
    forwardLine,
    showLiveFreshness: !refreshFailed && scan.freshness?.isFresh === true && Boolean(scan.asOf),
    showDensityChart: eligible,
    showMedian: false,
    showMode: false,
    showCentralRanges: showCentral50 || showCentral90,
    showCentral50,
    showCentral90,
    layers: eligible
      ? liveDensityLayers({
        eligible,
        showCentral50,
        showCentral90,
        showForward,
      })
      : emptyDensityLayers(),
    customerNotice,
    researchNotice,
    warningScope: refreshFailed ? 'served' : scope,
    rejectedExplanation,
    legend: buildLegend(scan, eligible, rejected, refreshFailed, source, quality),
  }
}

function customerFacingNotice(
  scan: Pick<IvSignalScan, 'display'>,
  refreshFailed: boolean,
  rejected: boolean,
  servedConvexity: boolean,
): string | null {
  if (refreshFailed) return 'Live options data is delayed.'
  if (rejected || servedConvexity) {
    if (rejected) return rejectedDensityExplanation(scan)
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
  refreshFailed: boolean,
  source: string,
  quality: string,
): SurfaceLegendLine[] {
  const smileAvailable = scan.display.smileStatus !== 'rejected'
  let distributionValue = 'Available'
  let smileValue = smileAvailable ? 'Available' : 'Unavailable'
  let forwardValue = `${source} · ${quality}`
  if (refreshFailed) {
    forwardValue = 'Delayed'
    smileValue = 'Delayed'
    distributionValue = 'Delayed'
  } else if (rejected) {
    distributionValue = 'Unavailable'
  } else if (!eligible) {
    distributionValue = 'Unavailable'
  }
  return [
    { dimension: 'forward', label: 'Forward', value: forwardValue },
    { dimension: 'smile', label: 'Smile', value: smileValue },
    { dimension: 'distribution', label: 'Distribution', value: distributionValue },
  ]
}

export function servedFitterCaption(scan: Pick<IvSignalScan, 'display'>): string {
  if (scan.display.servedFitterName === 'constrained_svi') return SERVED_CONSTRAINED_SMILE_CAPTION
  if (scan.display.servedFitterName === 'tv_pchip') return SERVED_PCHIP_CAPTION
  return `Served ${scan.display.servedFitterGrade} smile: ${scan.display.servedFitterName}`
}

export function coverageCaption(scan: Pick<IvSignalScan, 'selection' | 'coverage'>): string {
  return formatCoverage(scan)
}

export function methodQualityRows(
  scan: Pick<IvSignalScan, 'display' | 'selection' | 'coverage' | 'smile'>,
): Array<{ label: string; value: string }> {
  const residual = scan.display.residualBudgetOk
  const residualLabel = residual == null ? 'n/a' : residual ? 'inside budget' : 'exceeded budget'
  const gates = scan.display.failedChecks.length
    ? scan.display.failedChecks.join(' · ')
    : scan.display.densityStatus === 'accepted' || scan.display.densityStatus === 'degraded'
      ? 'all serving checks passed'
      : 'no density served'
  const configId = [scan.display.configVersion, scan.display.configHash].filter(Boolean).join(' / ') || 'n/a'
  const rows = [
    { label: 'Served smile', value: servedFitterCaption(scan) },
    { label: 'Fitter grade', value: scan.display.servedFitterGrade || 'diagnostic' },
    { label: 'Residual-budget result', value: residualLabel },
    { label: 'Quote coverage', value: formatCoverage(scan) },
    { label: 'Serving-gate summary', value: gates },
    { label: 'Model / config', value: configId },
    {
      label: 'Selected candidate',
      value: `${scan.display.servedFitterName} · ${scan.display.servedFitterGrade} · ${scan.display.servingMode}`,
    },
  ]
  if (scan.display.researchHumanReason || scan.display.researchFailedChecks.length) {
    rows.push({
      label: 'Research comparison',
      value: scan.display.researchHumanReason || scan.display.researchFailedChecks.join(' · '),
    })
  }
  if (scan.display.diagnosticDetail) {
    rows.push({ label: 'Developer detail', value: scan.display.diagnosticDetail })
  }
  return rows
}

export function metricCardLabel(kind: 'move' | 'rr' | 'bf' | 'range50' | 'range90'): string {
  if (kind === 'move') return ATM_IMPLIED_MOVE_LABEL
  if (kind === 'rr') return 'RR25'
  if (kind === 'bf') return 'BF25'
  if (kind === 'range50') return 'Central 50% range'
  return 'Central 90% range'
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function formatUpdatedAge(scan: Pick<IvSignalScan, 'asOf' | 'freshness'>): string {
  const asOfMs = Date.parse(scan.asOf)
  const ageSeconds = Number.isFinite(asOfMs)
    ? Math.max(0, (Date.now() - asOfMs) / 1000)
    : scan.freshness.snapshotAgeSeconds
  if (ageSeconds < 15) return 'Updated just now'
  if (ageSeconds < 60) return `Updated ${Math.max(1, Math.round(ageSeconds))}s ago`
  if (ageSeconds < 3600) return `Updated ${Math.max(1, Math.round(ageSeconds / 60))}m ago`
  if (ageSeconds < 86_400) return `Updated ${Math.max(1, Math.round(ageSeconds / 3600))}h ago`
  return `Updated ${Math.max(1, Math.round(ageSeconds / 86_400))}d ago`
}

export { DIAGNOSTIC_DISTRIBUTION_TITLE, DIAGNOSTIC_ANALYTICS_CAPTION }
