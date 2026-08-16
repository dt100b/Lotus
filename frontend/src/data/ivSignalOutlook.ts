import type { IvSignalScan } from '@/api/ivSignalScanner'

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
  scan: Pick<IvSignalScan, 'rnd' | 'expiry' | 'curveQuality' | 'coverage' | 'selection' | 'suppressionReasons' | 'smile'>,
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
  scan: Pick<IvSignalScan, 'rnd' | 'expiry' | 'smile' | 'curveQuality' | 'suppressionReasons' | 'selection'>,
  refreshFailed: boolean,
): { kicker: string; title: string; keyPhrase: string | null; detail: string; tone: IvOutlookTone } {
  const expiry = formatExpiryShort(scan.expiry)
  const move = formatExpectedMovePercent(scan.rnd)
  const quality = scan.curveQuality.level
  const source = formatForwardSource(scan.selection.forwardSource)
  if (refreshFailed || scan.suppressionReasons.includes('surface_rejected')) {
    return {
      kicker: 'Options-implied forward',
      title: 'Surface not accepted',
      keyPhrase: null,
      detail: `Expiry ${expiry} · quality ${quality.toLowerCase()} · ${source}`,
      tone: 'low',
    }
  }
  if (quality === 'LOW') {
    return {
      kicker: 'Risk-neutral terminal-price distribution',
      title: 'Density not validated',
      keyPhrase: null,
      detail: `Expiry ${expiry} · headline percentiles withheld`,
      tone: 'low',
    }
  }
  return {
    kicker: 'Risk-neutral terminal-price distribution',
    title: `${move} implied move`,
    keyPhrase: source,
    detail: `To ${expiry} · market-implied central 50% ${formatCompactStrikeRange(scan.rnd.percentile25, scan.rnd.percentile75)}`,
    tone: quality === 'HIGH' ? 'high' : 'caution',
  }
}

export function getSkewRead(
  scan: Pick<IvSignalScan, 'smile' | 'suppressionReasons'>,
  refreshFailed: boolean,
): IvNamedRead {
  const rr = scan.smile.metrics.rr25
  if (refreshFailed || scan.suppressionReasons.includes('surface_rejected')) {
    return {
      label: '25-delta risk reversal',
      value: 'Unavailable',
      detail: 'Waiting on quote quality',
      tone: 'low',
      title: 'Call IV minus put IV at 25-delta, from the fitted smile. Descriptive skew, not a forecast.',
    }
  }
  if (rr == null || !Number.isFinite(rr)) {
    return {
      label: '25-delta risk reversal',
      value: 'Unavailable',
      detail: '25Δ not solved',
      tone: 'caution',
      title: 'Call IV minus put IV at 25-delta, solved from the model delta equation.',
    }
  }
  return {
    label: '25-delta risk reversal',
    value: formatSignedVol(rr),
    detail: 'Call 25Δ IV − put 25Δ IV',
    tone: 'neutral',
    title: 'Risk-neutral smile metric. Positive means 25Δ calls are richer than 25Δ puts.',
  }
}

export function getWingRichness(
  scan: Pick<IvSignalScan, 'smile' | 'suppressionReasons'>,
  refreshFailed: boolean,
): IvNamedRead {
  const bf = scan.smile.metrics.bf25
  if (refreshFailed || bf == null || !Number.isFinite(bf)) {
    return {
      label: '25-delta butterfly',
      value: 'Unavailable',
      detail: 'Wing richness vs ATM',
      tone: 'caution',
      title: 'Average 25Δ IV minus ATM IV. Market-implied wing richness, not a directional tilt.',
    }
  }
  return {
    label: '25-delta butterfly',
    value: formatSignedVol(bf),
    detail: '25Δ wing IV minus ATM IV',
    tone: 'neutral',
    title: 'Average of 25Δ call and put IV, minus ATM IV. A smile-shape statistic under the risk-neutral measure.',
  }
}

export function getFitQuality(
  scan: Pick<IvSignalScan, 'curveQuality' | 'coverage' | 'selection'>,
  refreshFailed: boolean,
): IvNamedRead {
  if (refreshFailed) {
    return {
      label: 'Surface fit quality',
      value: 'Delayed',
      detail: 'Live book not current',
      tone: 'low',
      title: 'Combined quote coverage and model-validation status.',
    }
  }
  const level = scan.curveQuality.level
  return {
    label: 'Surface fit quality',
    value: level === 'HIGH' ? 'Accepted' : level === 'CAUTION' ? 'Degraded' : 'Rejected',
    detail: formatFitCoverage(scan),
    tone: level === 'HIGH' ? 'high' : level === 'CAUTION' ? 'caution' : 'low',
    title: 'Diagnostic grade until butterfly/calendar gates promote the fitter. Rejected densities do not publish percentiles.',
  }
}

export function getImpliedMoveRead(scan: Pick<IvSignalScan, 'rnd' | 'expiry'>): IvNamedRead {
  return {
    label: '1-standard-deviation implied move',
    value: formatExpectedMovePercent(scan.rnd),
    detail: `To ${formatExpiryShort(scan.expiry)} expiry`,
    tone: 'neutral',
    emphasis: true,
    title: 'F × (e^{σ_ATM √T} − 1) up and F × (1 − e^{−σ_ATM √T}) down. Market-implied, not a price forecast.',
  }
}

export function getCentralRangeRead(
  scan: Pick<IvSignalScan, 'rnd'>,
  band: '50' | '90',
): IvNamedRead {
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
  const strikes = scan.selection.selectedMarketStrikes
  return `${strikes} liquid strike${strikes === 1 ? '' : 's'} · ${scan.coverage.lowerStrikes}/${scan.coverage.upperStrikes} around forward`
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
