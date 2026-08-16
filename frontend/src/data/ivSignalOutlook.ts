import type { IvSignalScan } from '@/api/ivSignalScanner'
import {
  DIAGNOSTIC_MOVE_LABEL,
  densityAnalyticsEligible,
  densityIsRejected,
  formatCoverage,
  metricOf,
  smileIsDiagnostic,
  statusLabel,
  unavailableValue,
} from '@/data/optionsSurfaceDisplay'
import { describeSurfaceUi } from '@/data/optionsSurfacePresentation'

export type IvOutlookTone = 'neutral' | 'caution' | 'low' | 'high'

export type IvNamedRead = {
  label: string
  value: string
  detail: string
  tone: IvOutlookTone
  emphasis?: boolean
  title?: string
}

export function getIvScannerSummaryReads(
  scan: Pick<IvSignalScan, 'rnd' | 'expiry' | 'curveQuality' | 'coverage' | 'selection' | 'suppressionReasons' | 'smile' | 'display'>,
  refreshFailed: boolean,
): IvNamedRead[] {
  return [
    getSkewRead(scan, refreshFailed),
    getWingRichness(scan, refreshFailed),
    getFitQuality(scan, refreshFailed),
    getImpliedMoveRead(scan),
    getCentralRangeRead(scan, '50'),
    getCentralRangeRead(scan, '90'),
  ]
}

export function getSurfaceHeadline(
  scan: Pick<IvSignalScan, 'rnd' | 'expiry' | 'smile' | 'curveQuality' | 'suppressionReasons' | 'selection' | 'display'>,
  refreshFailed: boolean,
): { kicker: string; title: string; keyPhrase: string | null; detail: string; tone: IvOutlookTone } {
  const ui = describeSurfaceUi(scan, refreshFailed)
  const tone: IvOutlookTone = densityIsRejected(scan) || refreshFailed
    ? 'low'
    : scan.display.surfaceDisplayStatus === 'ready' ? 'high' : 'caution'
  return {
    kicker: ui.heroKicker,
    title: ui.heroTitle,
    keyPhrase: ui.heroKeyPhrase,
    detail: ui.heroDetail,
    tone,
  }
}

export function getSkewRead(
  scan: Pick<IvSignalScan, 'smile' | 'suppressionReasons' | 'display'>,
  refreshFailed: boolean,
): IvNamedRead {
  const eligibility = metricOf(scan, 'rr_25')
  if (refreshFailed) {
    return {
      label: '25-delta risk reversal',
      value: 'Unavailable',
      detail: 'Live book not current',
      tone: 'low',
      title: 'Call IV minus put IV at 25-delta, from the fitted smile. Descriptive skew, not a forecast.',
    }
  }
  if (!eligibility.available) {
    const missing = unavailableValue(eligibility)
    return {
      label: '25-delta risk reversal',
      value: missing.value,
      detail: missing.detail,
      tone: 'low',
      title: 'Call IV minus put IV at 25-delta, solved from the model delta equation. Shown only when both 25Δ roots lie inside observed coverage.',
    }
  }
  const rr = scan.smile.metrics.rr25
  if (rr == null || !Number.isFinite(rr)) {
    return {
      label: '25-delta risk reversal',
      value: 'Unavailable',
      detail: 'Unavailable — 25Δ roots did not solve inside observed smile coverage',
      tone: 'caution',
      title: 'Call IV minus put IV at 25-delta, solved from the model delta equation.',
    }
  }
  return {
    label: '25-delta risk reversal',
    value: formatSignedVol(rr),
    detail: smileIsDiagnostic(scan) ? 'Diagnostic smile · call 25Δ IV − put 25Δ IV' : 'Call 25Δ IV − put 25Δ IV',
    tone: 'neutral',
    title: 'Risk-neutral smile metric. Positive means 25Δ calls are richer than 25Δ puts.',
  }
}

export function getWingRichness(
  scan: Pick<IvSignalScan, 'smile' | 'suppressionReasons' | 'display'>,
  refreshFailed: boolean,
): IvNamedRead {
  const eligibility = metricOf(scan, 'bf_25')
  if (refreshFailed || !eligibility.available) {
    const missing = unavailableValue(eligibility)
    return {
      label: '25-delta butterfly',
      value: refreshFailed ? 'Unavailable' : missing.value,
      detail: refreshFailed ? 'Live book not current' : missing.detail,
      tone: 'caution',
      title: 'Average 25Δ IV minus ATM IV. Shown only when both 25Δ roots lie inside observed coverage.',
    }
  }
  const bf = scan.smile.metrics.bf25
  if (bf == null || !Number.isFinite(bf)) {
    return {
      label: '25-delta butterfly',
      value: 'Unavailable',
      detail: 'Unavailable — 25Δ roots did not solve inside observed smile coverage',
      tone: 'caution',
      title: 'Average 25Δ IV minus ATM IV. Market-implied wing richness, not a directional tilt.',
    }
  }
  return {
    label: '25-delta butterfly',
    value: formatSignedVol(bf),
    detail: smileIsDiagnostic(scan) ? 'Diagnostic smile · 25Δ wing IV minus ATM IV' : '25Δ wing IV minus ATM IV',
    tone: 'neutral',
    title: 'Average of 25Δ call and put IV, minus ATM IV. A smile-shape statistic under the risk-neutral measure.',
  }
}

export function getFitQuality(
  scan: Pick<IvSignalScan, 'curveQuality' | 'coverage' | 'selection' | 'display'>,
  refreshFailed: boolean,
): IvNamedRead {
  if (refreshFailed) {
    return {
      label: 'Distribution status',
      value: 'Delayed',
      detail: 'Live book not current',
      tone: 'low',
      title: 'Distribution status is independent of listed-future forward quality.',
    }
  }
  const ui = describeSurfaceUi(scan as Pick<IvSignalScan, 'display' | 'rnd' | 'expiry' | 'selection' | 'smile'>, false)
  const distribution = ui.legend.find((line) => line.dimension === 'distribution')
  return {
    label: 'Distribution status',
    value: distribution?.value ?? statusLabel(scan.display.densityStatus),
    detail: `${scan.display.servedFitterName} · ${scan.display.servedFitterGrade} · not a forward-quality score`,
    tone: densityAnalyticsEligible(scan) ? 'caution' : 'low',
    title: 'Distribution status is independent of the listed-future forward. A failed smile or density does not mark the forward as low quality.',
  }
}

export function getImpliedMoveRead(scan: Pick<IvSignalScan, 'rnd' | 'expiry' | 'display'>): IvNamedRead {
  const eligibility = metricOf(scan, 'implied_move_1sd')
  if (!eligibility.available) {
    const missing = unavailableValue(eligibility)
    return {
      label: DIAGNOSTIC_MOVE_LABEL,
      value: missing.value,
      detail: missing.detail,
      tone: 'low',
      title: 'F × (e^{σ_ATM √T} − 1) from the fitted ATM IV. This is not a distribution range.',
    }
  }
  return {
    label: DIAGNOSTIC_MOVE_LABEL,
    value: formatExpectedMovePercent(scan.rnd),
    detail: `ATM IV · to ${formatExpiryShort(scan.expiry)} · not a distribution range`,
    tone: 'neutral',
    emphasis: true,
    title: 'F × (e^{σ_ATM √T} − 1) up and F × (1 − e^{−σ_ATM √T}) down. Market-implied from the diagnostic smile, not a density percentile.',
  }
}

export function getCentralRangeRead(
  scan: Pick<IvSignalScan, 'rnd' | 'display'>,
  band: '50' | '90',
): IvNamedRead {
  const eligibility = metricOf(scan, band === '50' ? 'central_range_50' : 'central_range_90')
  if (!eligibility.available || densityIsRejected(scan)) {
    const missing = unavailableValue(eligibility)
    return {
      label: band === '50' ? 'Market-implied central range' : 'Market-implied 90% range',
      value: missing.value,
      detail: missing.detail,
      tone: 'low',
      title: 'Quantiles of the validated risk-neutral terminal-price density. Withheld when the density is rejected.',
    }
  }
  if (band === '50') {
    return {
      label: 'Market-implied central range',
      value: formatCompactStrikeRange(scan.rnd.percentile25, scan.rnd.percentile75),
      detail: 'Risk-neutral 25th–75th percentile',
      tone: 'neutral',
      title: 'Quantiles of the validated risk-neutral terminal-price density. Withheld when the density is rejected.',
    }
  }
  return {
    label: 'Market-implied 90% range',
    value: formatCompactStrikeRange(scan.rnd.percentile05, scan.rnd.percentile95),
    detail: 'Risk-neutral 5th–95th percentile',
    tone: 'neutral',
    title: 'Q-measure tail range from the Breeden–Litzenberger density. Not a statistical confidence interval.',
  }
}

export function formatFitCoverage(
  scan: Pick<IvSignalScan, 'coverage' | 'selection'>,
): string {
  return formatCoverage(scan)
}

export function formatExpectedMovePercent(rnd: Pick<IvSignalScan['rnd'], 'expectedMoveUp' | 'expectedMoveDown' | 'forward'>): string {
  const dollars = (rnd.expectedMoveUp + rnd.expectedMoveDown) / 2
  const percent = rnd.forward > 0 ? (dollars / rnd.forward) * 100 : 0
  if (!(dollars > 0) || !Number.isFinite(percent)) return '—'
  return `±${percent.toFixed(1)}%`
}

export function formatExpiryShort(expiry: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry)
  if (!iso) return expiry
  const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export function formatExpiryLong(expiry: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry)
  if (!iso) return expiry
  const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

export function formatForwardSource(source: IvSignalScan['selection']['forwardSource']): string {
  if (source === 'matching_future') return 'listed-future forward'
  if (source === 'inverse_put_call_parity' || source === 'parity_pairs') return 'inverse-parity forward'
  if (source === 'venue_underlying_price' || source === 'underlying_price') return 'venue underlying'
  if (source === 'spot_fallback') return 'spot fallback (low quality)'
  return 'forward source unknown'
}

function formatSignedVol(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${Math.abs(value).toFixed(1)} vol`
}

function formatCompactStrikeRange(lower: number, upper: number): string {
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return '—'
  return `${formatCompactUsd(lower)}–${formatCompactUsd(upper)}`
}

function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`
  return `$${Math.round(value)}`
}
