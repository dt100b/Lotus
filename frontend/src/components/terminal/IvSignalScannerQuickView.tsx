import { useId, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  RefreshCw,
} from 'lucide-react'
import type { IvSignalScan } from '@/api/ivSignalScanner'
import {
  IvSignalDensityChart,
  type IvSignalDensityLayers,
} from '@/components/terminal/IvSignalDensityChart'
import { IvSignalSmileChart, type SmileAxis } from '@/components/terminal/IvSignalSmileChart'
import { smileUnavailableCopy } from '@/data/ivSignalSmileCopy'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { isIvScannerDiagnosticsEnabled } from '@/data/ivScannerDiagnostics'
import {
  buildIvScannerExpiryOptions,
  findTrueZeroDteCandidate,
  type IvScannerExpiryOption,
} from '@/data/ivScannerExpiries'
import {
  formatExpiryLong,
  formatExpiryShort,
  formatForwardSource,
  getIvScannerSummaryReads,
  getSurfaceHeadline,
  type IvNamedRead,
} from '@/data/ivSignalOutlook'
import {
  DIAGNOSTIC_DENSITY_LABEL,
  DIAGNOSTIC_SMILE_CAPTION,
  REJECTED_DENSITY_BODY,
  REJECTED_DENSITY_TITLE,
  densityIsRejected,
  formatCoverage,
  smileIsDiagnostic,
  statusLabel,
} from '@/data/optionsSurfaceDisplay'
import { useIvSignalScan } from '@/hooks/useIvSignalScan'
import { cn } from '@/lib/utils'

type IvSignalScannerQuickViewProps = {
  expiries: string[]
  asOf: string
  enabled?: boolean
}

const DEFAULT_DENSITY_LAYERS: IvSignalDensityLayers = {
  forward: true,
  band: true,
  wings: true,
  sigma: true,
}

export function IvSignalScannerQuickView({
  expiries,
  asOf,
  enabled = true,
}: IvSignalScannerQuickViewProps) {
  const diagnosticsEnabled = isIvScannerDiagnosticsEnabled()
  const [requestedExpiry, setRequestedExpiry] = useState(() => (
    buildIvScannerExpiryOptions(expiries, asOf, false)[0]?.value ?? ''
  ))
  const zeroDteCandidate = useMemo(
    () => findTrueZeroDteCandidate(expiries, asOf),
    [asOf, expiries],
  )
  const zeroDteQuery = useIvSignalScan({
    expiry: zeroDteCandidate ?? '',
    enabled: enabled && Boolean(zeroDteCandidate),
  })
  const includeZeroDte = Boolean(
    zeroDteQuery.data?.eligibility.zeroDteEligible && !zeroDteQuery.isError,
  )
  const expiryOptions = useMemo(
    () => buildIvScannerExpiryOptions(expiries, asOf, includeZeroDte),
    [asOf, expiries, includeZeroDte],
  )
  const selectedExpiry = expiryOptions.some((option) => option.value === requestedExpiry)
    ? requestedExpiry
    : expiryOptions[0]?.value ?? ''

  const scanQuery = useIvSignalScan({
    expiry: selectedExpiry,
    enabled: enabled && selectedExpiry.length > 0,
  })
  const scan = scanQuery.data?.expiry === selectedExpiry ? scanQuery.data : undefined

  return (
    <section className="iv-signal-scanner" aria-label="Options surface">
      {scanQuery.isError && !scan ? (
        <ScannerError
          onRetry={() => void scanQuery.refetch()}
        />
      ) : scan ? (
        <ScannerResult
          key={selectedExpiry}
          scan={scan}
          refreshFailed={scanQuery.isError}
          diagnosticsEnabled={diagnosticsEnabled}
          expiryOptions={expiryOptions}
          selectedExpiry={selectedExpiry}
          onExpiryChange={setRequestedExpiry}
        />
      ) : selectedExpiry ? (
        <ScannerRefreshing
          expiryOptions={expiryOptions}
          selectedExpiry={selectedExpiry}
          onExpiryChange={setRequestedExpiry}
        />
      ) : (
        <ScannerLoading hasExpiry={false} />
      )}
    </section>
  )
}

function ScannerResult({
  scan,
  refreshFailed,
  diagnosticsEnabled,
  expiryOptions,
  selectedExpiry,
  onExpiryChange,
}: {
  scan: IvSignalScan
  refreshFailed: boolean
  diagnosticsEnabled: boolean
  expiryOptions: IvScannerExpiryOption[]
  selectedExpiry: string
  onExpiryChange: (expiry: string) => void
}) {
  const [smileAxis, setSmileAxis] = useState<SmileAxis>('delta')
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const reads = getIvScannerSummaryReads(scan, refreshFailed)
  const interpretive = reads.slice(0, 3)
  const ranges = reads.slice(3)
  const headline = getSurfaceHeadline(scan, refreshFailed)
  const notice = getUserNotice(scan, refreshFailed)
  const updatedLabel = formatUpdatedLabel(scan, refreshFailed)

  return (
    <div className="iv-signal-scanner__result">
      <SurfaceHero
        headline={headline}
        expiryOptions={expiryOptions}
        selectedExpiry={selectedExpiry}
        onExpiryChange={onExpiryChange}
      />

      <RejectedOrReadyDensity scan={scan} />

      <section className="iv-signal-chart-panel" aria-label="Implied volatility smile">
        <header className="iv-signal-chart-panel__head">
          <div>
            <h3 title="Accepted mark IVs versus the fitted total-variance smile. Extrapolated wings are not shown as observations.">
              {smileIsDiagnostic(scan) ? 'Diagnostic volatility smile' : 'Implied volatility smile'}
            </h3>
            <span
              className="iv-signal-smile-metrics"
              title="25-delta risk reversal and butterfly from numerically solved model deltas. Both require in-coverage 25Δ roots."
            >
              {smileIsDiagnostic(scan) ? `${DIAGNOSTIC_SMILE_CAPTION} · ` : ''}
              {formatSmileMetrics(scan)}
            </span>
          </div>
          {scan.smile.metrics.deltaAxisAvailable ? (
            <div className="iv-signal-smile-switch" role="tablist" aria-label="Smile axis">
              <button
                type="button"
                role="tab"
                aria-selected={smileAxis === 'delta'}
                className={cn(smileAxis === 'delta' && 'is-active')}
                onClick={() => setSmileAxis('delta')}
              >
                Delta
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={smileAxis === 'logMoneyness'}
                className={cn(smileAxis === 'logMoneyness' && 'is-active')}
                onClick={() => setSmileAxis('logMoneyness')}
              >
                Log-moneyness
              </button>
            </div>
          ) : null}
        </header>
        <div className="iv-signal-chart-panel__chart">
          {scan.smile.fit.length >= 2 && scan.smile.points.length >= 2 ? (
            <IvSignalSmileChart
              scan={scan}
              axis={scan.smile.metrics.deltaAxisAvailable ? smileAxis : 'logMoneyness'}
            />
          ) : (
            <div className="iv-signal-smile__empty">
              {smileUnavailableCopy(scan, refreshFailed)}
            </div>
          )}
        </div>
      </section>

      <SurfaceBrief interpretive={interpretive} ranges={ranges} />

      {diagnosticsEnabled ? (
        <ScannerDiagnostics
          scan={scan}
          open={diagnosticsOpen}
          onToggle={() => setDiagnosticsOpen((open) => !open)}
        />
      ) : null}

      <footer className="iv-signal-scanner__foot">
        <span>{updatedLabel}</span>
      </footer>

      {notice ? (
        <div
          className={cn(
            'iv-signal-scanner__warning',
            (refreshFailed || scan.suppressionReasons.length > 0) && 'iv-signal-scanner__warning--blocked',
          )}
          role="status"
        >
          <AlertTriangle aria-hidden />
          <span>{notice}</span>
        </div>
      ) : null}
    </div>
  )
}

function RejectedOrReadyDensity({ scan }: { scan: IvSignalScan }) {
  const [showDiagnostic, setShowDiagnostic] = useState(false)
  const rejected = densityIsRejected(scan)
  if (!rejected) {
    return (
      <section className="iv-signal-chart-panel" aria-label="Risk-neutral terminal-price distribution">
        <header className="iv-signal-chart-panel__head">
          <div>
            <h3 title="Risk-neutral terminal-price density from Black-76 calls. Q-measure, not a physical forecast.">
              Risk-neutral terminal-price distribution
            </h3>
            <span>
              {formatExpiryLabel(scan.expiry)} · {formatTenorShort(scan.timeToExpiryYears)}
            </span>
          </div>
          <div className="iv-surface-inline-stats" aria-label="Distribution statistics">
            <span>
              <em title="Options-implied forward used for OTM, smile, and density.">Fwd</em>
              <strong>{formatStrike(scan.rnd.forward)}</strong>
            </span>
            <span>
              <em>Med</em>
              <strong>{formatStrike(scan.rnd.percentile50)}</strong>
            </span>
            <span>
              <em>Mode</em>
              <strong>{formatStrike(scan.markers.peakStrike)}</strong>
            </span>
          </div>
        </header>
        <div className="iv-signal-chart-panel__chart">
          <IvSignalDensityChart scan={scan} layers={DEFAULT_DENSITY_LAYERS} />
        </div>
      </section>
    )
  }

  return (
    <section className="iv-signal-chart-panel iv-signal-chart-panel--unavailable" aria-label={REJECTED_DENSITY_TITLE}>
      <header className="iv-signal-chart-panel__head">
        <div>
          <h3 title="The density is withheld because it failed validation. This is not a usable probability distribution.">
            {REJECTED_DENSITY_TITLE}
          </h3>
          <span>Selected expiry {formatExpiryLabel(scan.expiry)} · {formatTenorShort(scan.timeToExpiryYears)}</span>
        </div>
        <div className="iv-surface-inline-stats" aria-label="Selected forward">
          <span>
            <em title="Options-implied forward used for OTM, smile, and density. Source and quality are shown separately from quote or density status.">Fwd</em>
            <strong>{formatStrike(scan.rnd.forward)}</strong>
          </span>
        </div>
      </header>
      <div className="iv-signal-density-empty">
        <p>{REJECTED_DENSITY_BODY}</p>
        <dl className="iv-signal-density-empty__facts">
          <div>
            <dt>Options-implied forward</dt>
            <dd>
              {formatStrike(scan.rnd.forward)} · {formatForwardSource(scan.selection.forwardSource)} · quality {scan.selection.forwardSource === 'spot_fallback' ? 'low' : 'high'}
            </dd>
          </div>
          <div>
            <dt>Failed checks</dt>
            <dd>{scan.display.failedChecks.length ? scan.display.failedChecks.join(' · ') : scan.display.humanReadableReason}</dd>
          </div>
          <div>
            <dt>Quote coverage</dt>
            <dd>{formatCoverage(scan)}</dd>
          </div>
          <div>
            <dt>Smile status</dt>
            <dd>{statusLabel(scan.display.smileStatus)} · {scan.display.smileStatus === 'degraded' || scan.display.smileStatus === 'research' ? DIAGNOSTIC_SMILE_CAPTION : 'Observed coverage only'}</dd>
          </div>
        </dl>
        {scan.diagnosticDensity ? (
          <div className="iv-signal-density-empty__actions">
            <button
              type="button"
              className="iv-signal-density-empty__toggle"
              aria-expanded={showDiagnostic}
              onClick={() => setShowDiagnostic((open) => !open)}
            >
              {showDiagnostic ? 'Hide diagnostic details' : 'View diagnostic details'}
            </button>
          </div>
        ) : null}
      </div>
      {showDiagnostic && scan.diagnosticDensity ? (
        <div className="iv-signal-chart-panel__chart iv-signal-chart-panel__chart--diagnostic">
          <p className="iv-signal-diagnostic-banner" role="note">{DIAGNOSTIC_DENSITY_LABEL}</p>
          <IvSignalDensityChart scan={scan} layers={{ forward: true, band: false, wings: false, sigma: false }} mode="diagnostic" />
        </div>
      ) : null}
    </section>
  )
}

function ScannerDiagnostics({
  scan,
  open,
  onToggle,
}: {
  scan: IvSignalScan
  open: boolean
  onToggle: () => void
}) {
  return (
    <section className={cn('iv-signal-legacy', open && 'iv-signal-legacy--open')} aria-label="Surface diagnostics">
      <button
        type="button"
        className="iv-signal-legacy__toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>Surface diagnostics</span>
        <em>Quote coverage, forward source, and density validation</em>
        <ChevronDown aria-hidden />
      </button>
      {open ? (
        <div className="iv-signal-details">
          <DetailRow label="Forward source" value={`${scan.selection.forwardSource} · quality ${scan.selection.forwardSource === 'spot_fallback' ? 'low' : 'high'} · ${scan.selection.forwardPairCount} parity pairs`} />
          <DetailRow label="Quote / smile / density" value={`${scan.display.quoteStatus} · ${scan.display.smileStatus} · ${scan.display.densityStatus}`} />
          <DetailRow label="Quote coverage" value={formatCoverage(scan)} />
          <DetailRow label="Failed checks" value={scan.display.failedChecks.join(' · ') || 'none'} />
          <DetailRow label="Developer detail" value={scan.display.diagnosticDetail || 'n/a'} />
          <DetailRow
            label="Rejected quotes"
            value={`zero bid ${scan.selection.rejectedZeroBidRows} · spread ${scan.selection.rejectedWideSpreadRows} · stale ${scan.selection.rejectedStaleQuoteRows}`}
          />
        </div>
      ) : null}
    </section>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="iv-signal-details__row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function SurfaceHero({
  headline,
  expiryOptions,
  selectedExpiry,
  onExpiryChange,
}: {
  headline: ReturnType<typeof getSurfaceHeadline>
  expiryOptions: IvScannerExpiryOption[]
  selectedExpiry: string
  onExpiryChange: (expiry: string) => void
}) {
  const grainId = useId().replace(/:/g, '')

  return (
    <header className="iv-surface-hero" aria-label="Options-implied surface">
      <div className="iv-surface-hero__bloom" aria-hidden />
      <svg
        className="iv-surface-hero__contours"
        viewBox="0 0 900 260"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <g className="iv-surface-hero__contours-soft" fill="none" strokeLinecap="round">
          <path d="M540,-22 C650,32 615,78 744,101 C852,120 826,175 935,196" />
          <path d="M610,-26 C720,22 687,66 800,82 C877,94 874,134 940,151" />
          <path d="M454,17 C537,55 534,137 661,154 C772,169 788,222 914,251" />
          <path d="M500,-8 C580,48 628,88 718,118 C808,146 846,188 930,228" />
          <path d="M428,8 C512,42 548,118 640,148 C742,176 802,210 918,248" />
        </g>
        <g className="iv-surface-hero__contours-edge" fill="none" strokeLinecap="round">
          <path d="M470,-10 C590,36 546,103 694,122 C814,137 810,193 920,218" />
          <path d="M575,-18 C668,18 702,72 776,92 C860,114 888,158 942,176" />
        </g>
      </svg>
      <svg className="iv-surface-hero__grain" aria-hidden="true">
        <filter id={`${grainId}-grain`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="4" stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${grainId}-grain)`} />
      </svg>
      <div className="iv-surface-hero__rail">
        <span className="iv-surface-hero__kicker">{headline.kicker}</span>
        <ExpirySelect
          options={expiryOptions}
          value={selectedExpiry}
          onChange={onExpiryChange}
        />
      </div>
      <div className="iv-surface-hero__copy">
        <strong className="iv-surface-hero__title">
          <span className="iv-surface-hero__lead">{headline.title}</span>
          {headline.keyPhrase ? (
            <span className="iv-surface-hero__key">{headline.keyPhrase}</span>
          ) : null}
        </strong>
        <em className="iv-surface-hero__detail">{headline.detail}</em>
      </div>
      <div className="iv-surface-hero__dissolve" aria-hidden />
    </header>
  )
}

function SurfaceBrief({
  interpretive,
  ranges,
}: {
  interpretive: IvNamedRead[]
  ranges: IvNamedRead[]
}) {
  return (
    <section className="iv-surface-brief" aria-label="Options surface brief">
      <div className="iv-surface-brief__grid" aria-label="Interpretive reads">
        {interpretive.map((read) => (
          <ReadCard key={read.label} read={read} />
        ))}
      </div>
      <div className="iv-surface-brief__grid iv-surface-brief__grid--facts" aria-label="Range facts">
        {ranges.map((read) => (
          <ReadCard key={read.label} read={read} />
        ))}
      </div>
    </section>
  )
}

function ExpirySelect({
  options,
  value,
  onChange,
}: {
  options: IvScannerExpiryOption[]
  value: string
  onChange: (expiry: string) => void
}) {
  if (options.length === 0) return <strong className="iv-surface-brief__empty">No suitable contracts</strong>
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="iv-surface-brief__expiry normal-case tracking-normal" aria-label="Options surface expiry">
        <span>Expiry · {formatExpiryLong(value)}</span>
      </SelectTrigger>
      <SelectContent className="iv-signal-scanner__expiry-menu" position="popper" sideOffset={3}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className="iv-signal-scanner__expiry-option normal-case tracking-normal"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ReadCard({ read }: { read: IvNamedRead }) {
  return (
    <div
      className={cn('iv-signal-read', read.emphasis && 'iv-signal-read--emphasis')}
      title={read.title}
    >
      <span>{read.label}</span>
      <strong>{read.value}</strong>
      <em>{read.detail}</em>
    </div>
  )
}

function ScannerError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="iv-signal-scanner__state iv-signal-scanner__state--error" role="alert">
      <AlertTriangle aria-hidden />
      <strong>Surface unavailable</strong>
      <p>Live options pricing is temporarily unavailable. The panel will keep trying in the background.</p>
      <button type="button" onClick={onRetry}>Try again</button>
    </div>
  )
}

function ScannerLoading({ hasExpiry }: { hasExpiry: boolean }) {
  return (
    <div className="iv-signal-scanner__state" role="status">
      <RefreshCw className={hasExpiry ? 'iv-signal-scanner__spin' : undefined} aria-hidden />
      <strong>{hasExpiry ? 'Building the options surface' : 'No suitable contract'}</strong>
      <p>{hasExpiry ? 'Reading the latest market-implied distribution.' : 'No supported weekly or monthly expiry is currently available.'}</p>
    </div>
  )
}

function ScannerRefreshing({
  expiryOptions,
  selectedExpiry,
  onExpiryChange,
}: {
  expiryOptions: IvScannerExpiryOption[]
  selectedExpiry: string
  onExpiryChange: (expiry: string) => void
}) {
  return (
    <div className="iv-signal-scanner__result iv-signal-scanner__result--skeleton" role="status" aria-live="polite">
      <header className="iv-surface-hero">
        <div className="iv-surface-hero__bloom" aria-hidden />
        <div className="iv-surface-hero__rail">
          <span className="iv-surface-hero__kicker">Options-implied surface</span>
          <ExpirySelect options={expiryOptions} value={selectedExpiry} onChange={onExpiryChange} />
        </div>
        <div className="iv-surface-hero__copy">
          <strong className="iv-surface-hero__title">
            <span className="iv-surface-hero__lead">Reading the live book</span>
          </strong>
          <em className="iv-surface-hero__detail">Loading the selected expiry</em>
        </div>
        <div className="iv-surface-hero__dissolve" aria-hidden />
      </header>
      <section className="iv-signal-chart-panel">
        <header className="iv-signal-chart-panel__head">
          <div>
            <h3>Risk-neutral terminal-price distribution</h3>
            <span>Loading selected expiry</span>
          </div>
        </header>
        <div className="iv-signal-chart-panel__chart iv-signal-skeleton-block" />
      </section>
      <section className="iv-signal-chart-panel">
        <header className="iv-signal-chart-panel__head">
          <div>
            <h3>Implied volatility smile</h3>
          </div>
        </header>
        <div className="iv-signal-chart-panel__chart iv-signal-skeleton-block" />
      </section>
      <div className="iv-signal-scanner__foot">Updating selected expiry</div>
    </div>
  )
}

function getUserNotice(scan: IvSignalScan, refreshFailed: boolean) {
  if (refreshFailed) return 'Live options data is delayed. Surface quality is shown as degraded.'
  if (scan.display.humanReadableReason && (
    scan.display.surfaceDisplayStatus === 'rejected'
    || scan.display.surfaceDisplayStatus === 'unavailable'
    || densityIsRejected(scan)
  )) {
    return scan.display.humanReadableReason
  }
  if (scan.display.surfaceDisplayStatus === 'degraded') {
    return scan.display.humanReadableReason || 'Surface quality is degraded. Treat displayed metrics as diagnostic.'
  }
  return null
}

function formatStrike(value: number) {
  return Number.isFinite(value) ? `$${Math.round(value).toLocaleString('en-US')}` : '—'
}

function formatTenorShort(years: number) {
  const hours = Math.max(0, years * 365 * 24)
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}H`
  return `${(hours / 24).toFixed(hours < 240 ? 1 : 0)}D`
}

function formatUpdatedLabel(scan: IvSignalScan, refreshFailed: boolean) {
  if (refreshFailed) return 'Update delayed'
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

function formatExpiryLabel(expiry: string) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry)
  if (!iso) return expiry
  return formatExpiryShort(expiry)
}

function formatSmileMetrics(scan: IvSignalScan) {
  const rrOk = scan.display.metricEligibility.rr_25?.available
  const bfOk = scan.display.metricEligibility.bf_25?.available
  const rr = rrOk ? formatVolPoints(scan.smile.metrics.rr25) : 'unavailable'
  const bf = bfOk ? formatVolPoints(scan.smile.metrics.bf25) : 'unavailable'
  return `RR25 ${rr} · BF25 ${bf}`
}

function formatVolPoints(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${Math.abs(value).toFixed(1)} vol`
}
