import type { IvSignalScan } from '@/api/ivSignalScanner'
import {
  densityIsRejected,
  formatCoverage,
  metricOf,
  smileIsDiagnostic,
  statusLabel,
  unavailableValue,
} from '@/data/optionsSurfaceDisplay'

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
  const expiry = formatExpiryShort(scan.expiry)
  const move = formatExpectedMovePercent(scan.rnd)
  const source = formatForwardSource(scan.selection.forwardSource)
  const forwardQuality = scan.selection.forwardSource === 'spot_fallback' ? 'forward quality low' : 'forward quality high'
  if (refreshFailed) {
    return {
      kicker: 'Options-implied forward',
      title: 'Surface delayed',
      keyPhrase: null,
      detail: `Expiry ${expiry} · ${source} · live book not current`,
      tone: 'low',
    }
  }
  if (scan.display.surfaceDisplayStatus === 'unavailable') {
    return {
      kicker: 'Options-implied forward',
      title: 'Surface unavailable',
      keyPhrase: null,
      detail: `Expiry ${expiry} · ${scan.display.humanReadableReason}`,
      tone: 'low',
    }
  }
  if (scan.display.surfaceDisplayStatus === 'rejected' || densityIsRejected(scan)) {
    return {
      kicker: 'Options-implied forward',
      title: 'Surface not accepted',
      keyPhrase: null,
      detail: `Expiry ${expiry} · ${source} · ${forwardQuality} · distribution withheld`,
      tone: 'low',
    }
  }
  if (scan.display.densityStatus === 'degraded') {
    return {
      kicker: 'Risk-neutral terminal-price distribution',
      title: 'Density not validated',
      keyPhrase: null,
      detail: `Expiry ${expiry} · ${source} · headline percentiles shown as degraded`,
      tone: 'low',
    }
  }
  return {
    kicker: 'Risk-neutral terminal-price distribution',
    title: `${move} implied move`,
    keyPhrase: source,
    detail: `To ${expiry} · market-implied central 50% ${formatCompactStrikeRange(scan.rnd.percentile25, scan.rnd.percentile75)}`,
    tone: scan.display.surfaceDisplayStatus === 'ready' ? 'high' : 'caution',
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
      label: 'Surface status',
      value: 'Delayed',
      detail: 'Live book not current',
      tone: 'low',
      title: 'Quote, smile, and distribution status are shown separately. They are not one fit grade.',
    }
  }
  return {
    label: 'Surface status',
    value: `${statusLabel(scan.display.quoteStatus)} / ${statusLabel(scan.display.smileStatus)} / ${statusLabel(scan.display.densityStatus)}`,
    detail: `Data · smile · distribution · ${formatCoverage(scan)}`,
    tone: scan.display.densityStatus === 'accepted' ? 'caution' : 'low',
    title: 'Data quality, smile-fit status, and distribution status are separate. A diagnostic smile can exist while the density is rejected.',
  }
}

export function getImpliedMoveRead(scan: Pick<IvSignalScan, 'rnd' | 'expiry' | 'display'>): IvNamedRead {
  const eligibility = metricOf(scan, 'implied_move_1sd')
  if (!eligibility.available) {
    const missing = unavailableValue(eligibility)
    return {
      label: 'Diagnostic smile-implied move',
      value: missing.value,
      detail: missing.detail,
      tone: 'low',
      title: 'F × (e^{σ_ATM √T} − 1) from the fitted ATM IV. This is not a distribution range.',
    }
  }
  return {
    label: 'Diagnostic smile-implied move',
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
