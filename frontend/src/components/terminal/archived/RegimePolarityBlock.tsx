/**
 * ARCHIVED — Structure vs NY Session polarity
 * ("Cumulative book vs flow since NY open")
 *
 * Not mounted on the live Regime desk. Kept for a possible future re-enable.
 *
 * Why archived (2026-07-22):
 *   Desk hierarchy simplified — vol chips + IV/RV chart own the secondary zone;
 *   horizon polarity meters were decided out of the default REGIME surface.
 *
 * What this was:
 *   Two diverging meters (Structure / NY Session) driven by
 *   flow_regime.horizon.full_score + session_score (display only).
 *   Fallback for structure when horizon missing: dealer-Γ style
 *   netGex / sum(|gammaBars|) clamp to [-1, 1].
 *
 * Backend / payload still live (do not strip):
 *   - flow_regime.horizon in API + mockTerminal
 *   - liveTerminal.ts mapping (fullScore, sessionScore, …)
 *
 * Re-enable sketch:
 *   1. Import RegimePolarityBlock (or re-inline) into RegimePanel
 *   2. Mount after vol chips, before VolCompareZone:
 *        <RegimePolarityBlock structure={…} session={…} />
 *   3. Wire scores via getRegimePolarityScores(bookSnapshot) below
 *   4. Restore .regime-polarity* rules in index.css (still present, marked ARCHIVED)
 *   5. Revisit chart min-height — polarity used to sit between chips and IV/RV
 *
 * CSS class names (dormant in index.css):
 *   .regime-polarity, .regime-polarity__caption, .regime-polarity__scores,
 *   .regime-polarity__label, .regime-polarity__meter, .regime-polarity__score,
 *   .regime-polarity__row
 *   CSS vars on .regime-panel: --regime-polarity-long/short(+-text)/label
 */
import { cn } from '@/lib/utils'
import type { TerminalSnapshot } from '@/data/mockTerminal'

export type RegimePolarityScores = {
  structure: number | null
  session: number | null
}

/**
 * Full-book structure score vs session-since-08:00 NY score.
 * Reuses flow_regime.horizon payload only — no scoring math changes.
 */
export function getRegimePolarityScores(
  bookSnapshot: TerminalSnapshot,
): RegimePolarityScores {
  const horizon = bookSnapshot.flowRegime?.horizon
  const dealerFallback = getDealerGammaPolarityFallback(bookSnapshot)
  const structure =
    horizon?.fullScore ?? (Number.isFinite(dealerFallback) ? dealerFallback : null)
  const session = horizon?.sessionScore ?? null
  return { structure, session }
}

/** Presentation fallback only — same formula as Regime Dealer Γ score. */
function getDealerGammaPolarityFallback(snapshot: TerminalSnapshot) {
  const netGexUsd = snapshot.bookStats?.netGexUsd ?? snapshot.totalNetGexUsd
  const totalAbsGexUsd = snapshot.gammaBars.reduce((total, row) => {
    const value = row.gammaExposureUsd
    return total + (Number.isFinite(value) ? Math.abs(value) : 0)
  }, 0)

  if (!(totalAbsGexUsd > 0) || !Number.isFinite(netGexUsd)) {
    return 0
  }

  return clamp(netGexUsd / totalAbsGexUsd, -1, 1)
}

export function RegimePolarityBlock({
  structure,
  session,
}: {
  structure: number | null
  session: number | null
}) {
  return (
    <div
      className="regime-polarity shrink-0 border-t border-[var(--desk-rule)]"
      role="group"
      aria-label="Structure versus NY session polarity"
    >
      <p className="regime-polarity__caption">Cumulative book vs flow since NY open</p>
      <div className="regime-polarity__scores" role="list">
        <RegimePolarityRow label="Structure" score={structure} peer={session} />
        <RegimePolarityRow label="NY Session" score={session} peer={structure} />
      </div>
    </div>
  )
}

/** Shared-scale diverging meter — muted gamma red/green. */
function RegimePolarityRow({
  label,
  score,
  peer,
}: {
  label: string
  score: number | null
  peer: number | null
}) {
  const maxAbs = Math.max(
    0.35,
    score !== null && Number.isFinite(score) ? Math.abs(score) : 0,
    peer !== null && Number.isFinite(peer) ? Math.abs(peer) : 0,
  )
  const widthPct =
    score === null || !Number.isFinite(score)
      ? 0
      : clamp((Math.abs(score) / maxAbs) * 100, score === 0 ? 0 : 8, 100)
  const barColor =
    score !== null && score > 0
      ? 'var(--regime-polarity-long)'
      : score !== null && score < 0
        ? 'var(--regime-polarity-short)'
        : 'var(--terminal-rule)'
  const valueClass =
    score === null
      ? 'text-[var(--terminal-muted)]'
      : score > 0.12
        ? 'text-[var(--regime-polarity-long-text)]'
        : score < -0.12
          ? 'text-[var(--regime-polarity-short-text)]'
          : 'text-[var(--terminal-muted)]'

  return (
    <div
      className="regime-polarity__row grid grid-cols-[78px_minmax(0,1fr)_44px] items-center gap-x-2.5"
      role="listitem"
    >
      <span className="regime-polarity__label">{label}</span>
      <div
        className="regime-polarity__meter relative flex min-w-0 items-stretch overflow-hidden rounded-[1px] bg-[var(--terminal-rule)]/35"
        aria-hidden
      >
        <div className="relative flex min-w-0 flex-1 items-center justify-end">
          {score !== null && score < 0 ? (
            <div
              className="h-full rounded-[1px]"
              style={{ width: `${widthPct}%`, background: barColor }}
            />
          ) : null}
        </div>
        <div className="w-px shrink-0 self-stretch bg-[color-mix(in_srgb,var(--terminal-heading)_22%,transparent)]" />
        <div className="relative flex min-w-0 flex-1 items-center justify-start">
          {score !== null && score > 0 ? (
            <div
              className="h-full rounded-[1px]"
              style={{ width: `${widthPct}%`, background: barColor }}
            />
          ) : null}
        </div>
      </div>
      <span
        className={cn(
          'regime-polarity__score text-right font-semibold tabular-nums',
          valueClass,
        )}
      >
        {score === null ? '—' : formatPolarityScore(score)}
      </span>
    </div>
  )
}

function formatPolarityScore(score: number) {
  return `${score >= 0 ? '+' : ''}${score.toFixed(2)}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
