import { memo, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { WallSignificanceChart } from '@/components/terminal/WallSignificanceChart'
import { RegimePanel } from '@/components/terminal/RegimePanel'
import {
  getDisplaySpot,
  type AdvancedMetric,
  type ExpiryKind,
  type ExpiryPositioningEvent,
  type LevelItem,
  type TerminalSnapshot,
} from '@/data/mockTerminal'
import { formatMillions, formatSignedPercent, formatStrike, formatUsd } from '@/lib/formatters'
import { useTerminalStore } from '@/store/terminalStore'
import { getSpotDistanceColor, levelRoleCssVars } from '@/data/levelColors'
import { cn } from '@/lib/utils'

type SidePanelsProps = {
  snapshot: TerminalSnapshot
  allExpirySnapshot?: TerminalSnapshot
}

/** Side-rail desk tabs: REGIME · LEVELS · WALLS · OPEX */
type LevelPanelTab = 'regime' | 'levels' | 'walls' | 'expiry'

export const SidePanels = memo(function SidePanels({
  snapshot,
  allExpirySnapshot,
}: SidePanelsProps) {
  const [levelPanelTab, setLevelPanelTab] = useState<LevelPanelTab>('regime')
  const theme = useTerminalStore((state) => state.theme)

  // Book structure + regime always use the full surface so chart expiry filters do not mutate the desk.
  const bookSnapshot = allExpirySnapshot ?? snapshot

  return (
    <aside className="terminal-panel terminal-rail grid h-full grid-rows-[auto_minmax(0,1fr)] content-stretch items-stretch">
      <RailSection
        title="Price"
      >
        <div className="rail-price">
          {snapshot.marketSources.map((source) => (
            <div key={source.name} className="rail-price__row">
              <div className="rail-price__name">
                <SourceLogo sourceName={source.name} />
                <span className="truncate">{source.name}</span>
              </div>
              <div>
                <div className="rail-price__value">{formatUsd(source.value)}</div>
                <div className={getPriceSourceNoteClassName(source.note)}>{source.note}</div>
              </div>
            </div>
          ))}
        </div>
      </RailSection>

      <RailSection
        title={(
          <LevelPanelTabs
            activeTab={levelPanelTab}
            variant={theme === 'command' ? 'command' : 'clean'}
            onTabChange={setLevelPanelTab}
          />
        )}
        action={levelPanelTab === 'levels' ? <CopyLevelsButton /> : null}
        className="flex min-h-0 flex-col"
      >
        {levelPanelTab === 'regime' ? (
          <RegimePanel bookSnapshot={bookSnapshot} />
        ) : levelPanelTab === 'levels' ? (
          <LevelsDesk
            bookSnapshot={bookSnapshot}
            sessionLevels={snapshot.levels.zeroDte}
            // Reference HVL = front/active session expiry (not ALL aggregate).
            // Book HVL is an optional secondary row when present.
            reference={bookSnapshot.levels.reference}
          />
        ) : levelPanelTab === 'walls' ? (
          <WallSignificanceChart snapshot={bookSnapshot} />
        ) : (
          <ExpiryImpactPanel snapshot={snapshot} />
        )}
      </RailSection>
    </aside>
  )
})

type RailSectionProps = {
  title: ReactNode
  action?: ReactNode
  className?: string
  children: ReactNode
}

function RailSection({ title, action, className, children }: RailSectionProps) {
  return (
    <section className={`terminal-rail-section ${className ?? ''}`}>
      <div className="terminal-section-header">
        {typeof title === 'string' ? <h2 className="terminal-title whitespace-nowrap">{title}</h2> : title}
        {action ? <div className="terminal-section-action">{action}</div> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </section>
  )
}

function LevelPanelTabs({
  activeTab,
  variant,
  onTabChange,
}: {
  activeTab: LevelPanelTab
  variant: 'clean' | 'command'
  onTabChange: (tab: LevelPanelTab) => void
}) {
  const rootClassName = variant === 'command' ? 'terminal-command-tabs' : 'terminal-clean-tabs'
  const getTabClassName = (active: boolean) => {
    if (variant === 'command') {
      return active ? 'terminal-command-tab terminal-command-tab--active' : 'terminal-command-tab'
    }

    return active ? 'terminal-clean-tab terminal-clean-tab--active' : 'terminal-clean-tab'
  }

  return (
    <div
      aria-label="Side rail desk view"
      className={rootClassName}
      role="tablist"
    >
      <LevelPanelTabButton
        active={activeTab === 'regime'}
        className={getTabClassName(activeTab === 'regime')}
        label="Regime"
        onClick={() => onTabChange('regime')}
      />
      <LevelPanelTabButton
        active={activeTab === 'levels'}
        className={getTabClassName(activeTab === 'levels')}
        label="Levels"
        onClick={() => onTabChange('levels')}
      />
      <LevelPanelTabButton
        active={activeTab === 'walls'}
        className={getTabClassName(activeTab === 'walls')}
        label="Walls"
        onClick={() => onTabChange('walls')}
      />
      <LevelPanelTabButton
        active={activeTab === 'expiry'}
        className={getTabClassName(activeTab === 'expiry')}
        label="OPEX"
        onClick={() => onTabChange('expiry')}
      />
    </div>
  )
}

function LevelPanelTabButton({
  active,
  className,
  label,
  onClick,
}: {
  active: boolean
  className: string
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-selected={active}
      className={className}
      role="tab"
      type="button"
      onClick={onClick}
    >
      <span>{label}</span>
    </button>
  )
}

function CopyLevelsButton() {
  // Browser min-font floors block true 9px; scale from a safe 11px base (same pattern as heatmap chips).
  return (
    <button
      aria-label="Copy GEX levels"
      className="levels-copy-btn cursor-pointer border-0 bg-transparent p-0 text-[var(--terminal-subtle)] transition-colors duration-150 hover:text-[var(--terminal-heading)] focus-visible:outline-none focus-visible:text-[var(--terminal-heading)]"
      type="button"
    >
      <span className="levels-copy-btn__label">Copy</span>
    </button>
  )
}

/**
 * Levels instrument board for an intraday directional trader.
 *
 * Read-only structural desk — no chart overlay toggles.
 * Order: Key Levels → All → 0DTE → Weekly → Monthly → Quarterly.
 * All / 0DTE / tenors = Positive Gamma + Negative Gamma (flow net_gex extrema).
 * Key Levels = HVL (flow, per active/front expiry), Max Pain (OI), Expected Move (vol).
 * Optional Book HVL (ALL multi-expiry) is secondary when the API attaches it.
 * Regime lives on its own tab (Dealer Γ / Net GEX / d/w RV / DVOL / vol chips / IV−RV).
 * Structure/NY Session polarity is archived (see archived/RegimePolarityBlock.tsx).
 */
function LevelsDesk({
  bookSnapshot,
  sessionLevels,
  reference,
}: {
  bookSnapshot: TerminalSnapshot
  sessionLevels: LevelItem[]
  reference: AdvancedMetric[]
}) {
  // Key Levels: HVL (session), optional Book HVL, Max Pain, Expected Move.
  // HVL = cumulative flow-GEX zero-cross on this expiry within spot ±12%
  // (mass filter 1.5%). Not classic OI gamma flip.
  const contextMetrics = useMemo(
    () => reference.filter((metric) => (
      metric.label === 'HVL'
      || metric.label.includes('Book HVL')
      || metric.label.includes('Zero Gamma')
      || metric.label.includes('Gamma Flip')
      || metric.label.includes('Max Pain')
      || metric.label.includes('Expected Move')
    )),
    [reference],
  )

  // DIST % / nearest-to-spot: live Deribit index when present.
  const displaySpot = getDisplaySpot(bookSnapshot)
  const weekly = bookSnapshot.levels.weekly ?? []
  const monthly = bookSnapshot.levels.monthly ?? []
  const quarterly = bookSnapshot.levels.quarterly ?? []

  return (
    <div
      className="levels-desk flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden"
      aria-label="Levels desk"
    >
      <section className="shrink-0">
        <PanelGroupTitle title="Key Levels" />
        <ReferenceRows
          items={contextMetrics}
          spot={displaySpot}
        />
      </section>

      <section className="shrink-0">
        <PanelGroupTitle title="All" />
        <LevelRows
          group="all-expiry"
          items={bookSnapshot.levels.allExpiry}
          spot={displaySpot}
        />
      </section>

      <section className="shrink-0">
        <PanelGroupTitle title="0DTE" />
        <LevelRows
          group="0dte"
          items={sessionLevels}
          spot={displaySpot}
        />
      </section>

      {weekly.length > 0 ? (
        <section className="shrink-0">
          <PanelGroupTitle
            title="Weekly"
            scope={getLevelGroupScope(weekly)}
          />
          <LevelRows
            group="weekly"
            items={weekly}
            spot={displaySpot}
          />
        </section>
      ) : null}

      {monthly.length > 0 ? (
        <section className="shrink-0">
          <PanelGroupTitle
            title="Monthly"
            scope={getLevelGroupScope(monthly)}
          />
          <LevelRows
            group="monthly"
            items={monthly}
            spot={displaySpot}
          />
        </section>
      ) : null}

      {quarterly.length > 0 ? (
        <section className="shrink-0">
          <PanelGroupTitle
            title="Quarterly"
            scope={getLevelGroupScope(quarterly)}
          />
          <LevelRows
            group="quarterly"
            items={quarterly}
            spot={displaySpot}
          />
        </section>
      ) : null}
    </div>
  )
}

function PanelGroupTitle({ title, scope }: { title: string; scope?: string | null }) {
  return (
    <div className="levels-desk__group-title">
      <span className="levels-desk__group-title-text">{title}</span>
      {scope ? (
        <span className="levels-desk__group-title-scope">{scope}</span>
      ) : null}
      <span className="levels-desk__group-title-rule" aria-hidden />
    </div>
  )
}

function getLevelGroupScope(items: LevelItem[]) {
  const raw = items.find((item) => item.scopeLabel)?.scopeLabel
  if (!raw) return null
  return formatExpiryDisplay(raw)
}

function LevelRows({
  group,
  items,
  spot,
}: {
  group: LevelGammaGroup
  items: LevelItem[]
  spot: number
}) {
  const nearestLabel = useMemo(() => getNearestLevelLabel(items, spot), [items, spot])

  return (
    <div className="levels-board">
      {items.map((item) => {
        const distanceFromSpotPercent = item.distanceFromSpotPercent ?? getDistanceFromSpotPercent(item.strike, spot)
        const displayLabel = item.label.replace(/^0DTE\s+/i, '')
        const accent = getLevelRoleAccent(group, item.label)
        const roleMod = getLevelRoleModifier(item.label)
        const nearest = item.label === nearestLabel

        return (
          <div
            key={`${group}-${item.label}`}
            className={cn(
              'levels-board__row',
              roleMod,
              nearest && 'levels-board__row--nearest',
            )}
            style={{ '--level-role-accent': accent } as CSSProperties}
          >
            <div className="levels-board__label">
              <span className="truncate">{displayLabel}</span>
            </div>
            <div className="levels-board__value text-right">
              ${formatStrike(item.strike)}
            </div>
            <div
              className="levels-board__dist text-right"
              style={{ color: getSpotDistanceColor(distanceFromSpotPercent, { quiet: true }) }}
            >
              {distanceFromSpotPercent === undefined ? '—' : formatSignedPercent(distanceFromSpotPercent)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

type LevelGammaGroup = 'all-expiry' | '0dte' | 'weekly' | 'monthly' | 'quarterly'

function ReferenceRows({
  items,
  spot,
}: {
  items: AdvancedMetric[]
  spot: number
}) {
  const nearestLabel = useMemo(() => {
    let bestLabel: string | null = null
    let bestDistance = Number.POSITIVE_INFINITY

    for (const metric of items) {
      if (metric.label === 'Expected Move') continue
      const strike = parseLevelValue(metric.value)
      if (!Number.isFinite(strike)) continue
      const distance = Math.abs(strike - spot)
      if (distance < bestDistance) {
        bestDistance = distance
        bestLabel = metric.label
      }
    }

    return bestLabel
  }, [items, spot])

  return (
    <div className="levels-board">
      {items.map((metric) => {
        const expectedMoveRange = metric.label === 'Expected Move' ? splitExpectedMoveRange(metric.value) : null
        const accent = getReferenceRoleAccent(metric)
        const roleMod = getReferenceRoleModifier(metric)
        const distanceFromSpotPercent = getReferenceDistanceFromSpotPercent(metric, spot, expectedMoveRange)
        const distanceDisplay = distanceFromSpotPercent === undefined ? '—' : formatSignedPercent(distanceFromSpotPercent)
        const scopeTag = formatReferenceScopeTag(metric)
        const nearest = metric.label === nearestLabel

        return (
          <div
            key={metric.label}
            className={cn(
              'levels-board__row',
              roleMod,
              nearest && 'levels-board__row--nearest',
            )}
            style={{ '--level-role-accent': accent } as CSSProperties}
          >
            <div className="levels-board__label">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate leading-none">{formatReferenceLabel(metric.label)}</span>
                {scopeTag ? (
                  <span className="levels-board__label-scope shrink-0">
                    {scopeTag}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="levels-board__value text-right">
              {expectedMoveRange?.lower ?? metric.value}
            </div>
            <div
              className={cn(
                'levels-board__dist',
                expectedMoveRange ? 'text-left' : 'text-right',
              )}
              style={
                expectedMoveRange
                  ? undefined
                  : { color: getSpotDistanceColor(distanceFromSpotPercent, { quiet: true }) }
              }
            >
              {expectedMoveRange?.upper ?? distanceDisplay}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function getNearestLevelLabel(items: LevelItem[], spot: number) {
  let bestLabel: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const item of items) {
    if (!Number.isFinite(item.strike)) continue
    const distance = Math.abs(item.strike - spot)
    if (distance < bestDistance) {
      bestDistance = distance
      bestLabel = item.label
    }
  }

  return bestLabel
}

/** Role accent shared by Levels list markers (All / 0DTE / tenors use the same family). */
function getLevelRoleAccent(_group: LevelGammaGroup, label: string) {
  if (label.includes('Positive Gamma')) return levelRoleCssVars.positiveGamma
  if (label.includes('Negative Gamma')) return levelRoleCssVars.negativeGamma
  return 'var(--terminal-subtle)'
}

/** Row modifier for quiet role-tinted strike values (Polarity score language). */
function getLevelRoleModifier(label: string) {
  if (label.includes('Positive Gamma')) return 'levels-board__row--pos'
  if (label.includes('Negative Gamma')) return 'levels-board__row--neg'
  return undefined
}

function getReferenceRoleAccent(metric: AdvancedMetric) {
  if (metric.label.includes('Expected')) return levelRoleCssVars.expectedMove
  if (
    metric.label === 'HVL'
    || metric.label.includes('Book HVL')
    || metric.label.includes('Zero Gamma')
    || metric.label.includes('Flip')
    || metric.label === 'ZG'
  ) {
    return levelRoleCssVars.gammaFlip
  }
  if (metric.label.includes('Max Pain')) return levelRoleCssVars.maxPain
  return 'var(--terminal-muted)'
}

function getReferenceRoleModifier(metric: AdvancedMetric) {
  if (metric.label.includes('Expected')) return 'levels-board__row--move'
  if (
    metric.label === 'HVL'
    || metric.label.includes('Book HVL')
    || metric.label.includes('Zero Gamma')
    || metric.label.includes('Flip')
    || metric.label === 'ZG'
  ) {
    return 'levels-board__row--flip'
  }
  return undefined
}

function formatReferenceLabel(label: string) {
  if (label.includes('Expected')) return 'Expected Move'
  if (label.includes('Book HVL')) return 'Book HVL'
  // Legacy API labels → HVL
  if (
    label === 'HVL'
    || label.includes('Zero Gamma')
    || label.includes('Gamma Flip')
    || label === 'Flip'
    || label === 'ZG'
  ) {
    return label.includes('Book') ? 'Book HVL' : 'HVL'
  }
  return label
}

/** Compact scope tag beside the label — e.g. ALL or 16JUL26. No weight suffixes. */
function formatReferenceScopeTag(metric: AdvancedMetric) {
  // Expected Move is always the session 1σ band; the date tag collides with the long label.
  if (metric.label.includes('Expected')) {
    return null
  }

  // Book HVL / explicit book scope → ALL (multi-expiry sum).
  if (
    metric.label.includes('Book HVL')
    || metric.scope === 'book'
  ) {
    return 'ALL'
  }

  // Session HVL → show the active/front expiry tag (not forced ALL).
  const raw = metric.scopeLabel
  if (!raw || raw === 'ALL') return null

  return formatExpiryDisplay(raw)
}

function formatExpiryDisplay(expiry: string) {
  // Already Deribit-style (16JUL26)
  if (/^\d{1,2}[A-Z]{3}\d{2}$/.test(expiry)) {
    return expiry
  }

  // ISO date from backend (2026-07-16) → 16JUL26
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry)
  if (iso) {
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
    const day = String(Number(iso[3]))
    const month = months[Number(iso[2]) - 1] ?? iso[2]
    const year = iso[1].slice(-2)
    return `${day}${month}${year}`
  }

  return expiry
}

function getReferenceDistanceFromSpotPercent(
  metric: TerminalSnapshot['levels']['reference'][number],
  spot: number,
  expectedMoveRange: ReturnType<typeof splitExpectedMoveRange>,
) {
  if (expectedMoveRange) {
    const lower = parseLevelValue(expectedMoveRange.lower)
    const upper = parseLevelValue(expectedMoveRange.upper)

    if (Number.isFinite(lower) && Number.isFinite(upper)) {
      if (spot >= lower && spot <= upper) {
        return 0
      }

      return getDistanceFromSpotPercent(spot < lower ? lower : upper, spot)
    }
  }

  const strike = parseLevelValue(metric.value)

  return Number.isFinite(strike) ? getDistanceFromSpotPercent(strike, spot) : undefined
}

function parseLevelValue(value: string) {
  return Number(value.replace(/[^\d.-]/g, ''))
}

function getDistanceFromSpotPercent(strike: number, spot: number) {
  if (!Number.isFinite(strike) || !Number.isFinite(spot) || spot === 0) {
    return undefined
  }

  return ((strike - spot) / spot) * 100
}

function getPriceSourceNoteClassName(note: string) {
  const signedValue = note.match(/[+-]\s*\d+(?:\.\d+)?/)
  const baseClassName = 'rail-price__note'

  if (!signedValue) {
    return baseClassName
  }

  const value = Number(signedValue[0].replace(/\s/g, ''))
  if (!Number.isFinite(value) || value === 0) {
    return baseClassName
  }

  return value > 0
    ? `${baseClassName} rail-price__note--pos`
    : `${baseClassName} rail-price__note--neg`
}

function SourceLogo({ sourceName }: { sourceName: string }) {
  const isDeribit = sourceName.includes('Deribit')

  return (
    <span
      aria-hidden="true"
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
    >
      {isDeribit ? <DeribitLogo /> : <HyperliquidLogo />}
    </span>
  )
}

function DeribitLogo() {
  return (
    <svg
      viewBox="78 200 208 200"
      className="h-3.5 w-3.5"
      role="img"
      aria-label="Deribit"
      style={{ filter: 'drop-shadow(0 0 4px rgba(0, 207, 190, 0.5)) drop-shadow(0 0 9px rgba(0, 207, 190, 0.22))' }}
    >
      <path
        d="m220.2 233.4h-7.4v-33.3h-33.6v33.3h-33.6v-33.3h-33.5v33.3h-33.6v33.3h33.6v66.7h-33.6v33.3h33.6v33.3h33.6v-33.3h33.6v33.3h33.6v-33.3h5.9c36.6.4 66.6-30 67-66.1.4-36.3-29-66.8-65.6-67.2zm-.4 100h-74v-66.6h73.1c18.2-.3 33.3 14.3 33.6 32.5.2 18-14.4 33.8-32.7 34.1z"
        fill="#00cfbe"
      />
    </svg>
  )
}

function HyperliquidLogo() {
  return (
    <svg
      viewBox="0 0 144 144"
      className="h-3.5 w-3.5"
      role="img"
      aria-label="Hyperliquid"
      style={{ filter: 'drop-shadow(0 0 3px rgba(151, 252, 228, 0.28)) drop-shadow(0 0 6px rgba(151, 252, 228, 0.12))' }}
    >
      <path
        d="M144 71.6991C144 119.306 114.866 134.582 99.5156 120.98C86.8804 109.889 83.1211 86.4521 64.116 84.0456C39.9942 81.0113 37.9057 113.133 22.0334 113.133C3.5504 113.133 0 86.2428 0 72.4315C0 58.3063 3.96809 39.0542 19.736 39.0542C38.1146 39.0542 39.1588 66.5722 62.132 65.1073C85.0007 63.5379 85.4184 34.8689 100.247 22.6271C113.195 12.0593 144 23.4641 144 71.6991Z"
        fill="#97FCE4"
      />
    </svg>
  )
}

function splitExpectedMoveRange(value: string) {
  const rangeSeparator = value.indexOf('-$')

  if (rangeSeparator === -1) return null

  return {
    lower: value.slice(0, rangeSeparator),
    upper: value.slice(rangeSeparator),
  }
}

function formatWholePercent(value: number) {
  return `${Math.round(value)}%`
}


/**
 * OPEX rail — expiry structure / pin-risk view (not flow Levels/Regime).
 *
 * Does NOT crown a single "most important" expiry (that collapses to 0DTE via urgency).
 * Instead splits the book into:
 *  - Session front: nearest expiry driving today's tape (time + pin magnets)
 *  - Range anchor: largest structural book that still frames the range
 *  - Horizon: next few events by calendar, always keeping the range anchor visible
 *  - Session read: observational pin / release / bias compressed into words
 */
function ExpiryImpactPanel({ snapshot }: { snapshot: TerminalSnapshot }) {
  const events = snapshot.expiryEvents
  const desk = useMemo(() => buildOpexDesk(events), [events])

  if (!desk) {
    return (
      <div className="flex h-full min-h-[160px] items-center justify-center px-3 text-center text-[10px] leading-5 text-[var(--terminal-muted)]">
        No expiry positioning in the current snapshot
      </div>
    )
  }

  const { session, anchor, magnets, horizon, read } = desk
  const sessionCountdown = formatExpiryCountdown(session)

  return (
    <div className="opex-desk" aria-label="OPEX session desk">
      {/* ── Session front: what can pin/print the tape today ── */}
      <section className="shrink-0">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="opex-desk__section-title">Session</span>
            <ExpiryKindBadge kind={session.kind} />
          </div>
          <div className="opex-desk__countdown">
            {sessionCountdown.text}
            {sessionCountdown.showLeft ? (
              <span className="ml-1 text-[8.5px] font-semibold uppercase tracking-[0.06em] text-[var(--desk-label)]">
                left
              </span>
            ) : null}
          </div>
        </div>

        <div className="mb-2.5 flex items-baseline justify-between gap-2">
          <div className="opex-desk__expiry">{session.expiry}</div>
          <div className={getSessionModeClassName(read.sessionMode)}>{read.sessionMode}</div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <OpexStat
            label="Near Spot"
            value={formatWholePercent(session.nearSpotOpenInterestSharePercent)}
            hint="OI ≤2.5%"
            tone={session.nearSpotOpenInterestSharePercent >= 30 ? 'warn' : 'neutral'}
          />
          <OpexStat
            label="Book"
            value={formatCompactUsd(session.expiringNotionalUsd)}
            hint={`${formatWholePercent(session.openInterestSharePercent)} OI`}
          />
          <OpexStat
            label="|Γ| Near"
            value={formatMillions(session.nearSpotGammaExposureUsd)}
            hint="Σ|net GEX|"
            tone={session.nearSpotGammaExposureUsd > 0 ? 'accent' : 'neutral'}
          />
        </div>
      </section>

      {/* ── Magnets: strikes that can hold an intraday print ── */}
      <section className="shrink-0 border-t border-[var(--desk-rule)] pt-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="opex-desk__section-title">Magnets</span>
          <span className="opex-desk__meta">
            OI × proximity · {session.expiry}
          </span>
        </div>
        {magnets.length === 0 ? (
          <div className="opex-desk__body">No near-spot concentration</div>
        ) : (
          <div className="grid gap-1">
            <div className="grid grid-cols-[minmax(0,1fr)_52px_48px_44px] items-center gap-2 px-2">
              <div className="opex-desk__colhead">Strike</div>
              <div className="opex-desk__colhead text-right">GEX</div>
              <div className="opex-desk__colhead text-right">OI%</div>
              <div className="opex-desk__colhead text-right">Dist</div>
            </div>
            {magnets.map((strike) => (
              <div
                key={`${session.expiry}-${strike.strike}`}
                className="opex-desk__magnet"
              >
                <div className="opex-desk__magnet-strike min-w-0">
                  ${formatStrike(strike.strike)}
                </div>
                <div
                  className={cn(
                    'text-right text-[10px] font-semibold leading-none tabular-nums',
                    strike.gammaExposureUsd >= 0
                      ? 'opex-desk__magnet-gex--pos'
                      : 'opex-desk__magnet-gex--neg',
                  )}
                >
                  {formatMillions(strike.gammaExposureUsd)}
                </div>
                <div className="text-right text-[10px] font-semibold leading-none tabular-nums text-[var(--desk-value)]">
                  {formatWholePercent(strike.openInterestSharePercent)}
                </div>
                <div
                  className="text-right text-[10px] font-semibold leading-none tabular-nums"
                  style={{ color: getSpotDistanceColor(strike.distanceFromSpotPercent, { quiet: true }) }}
                >
                  {formatSignedPercent(strike.distanceFromSpotPercent)}
                </div>
              </div>
            ))}
            <div className="px-2 text-[8px] leading-none text-[var(--terminal-subtle)]">
              OI% = strike share of this expiry&apos;s OI
            </div>
          </div>
        )}
      </section>

      {/* ── Range anchor: structural book ≠ always 0DTE ── */}
      <section className="shrink-0 border-t border-[var(--desk-rule)] pt-2.5">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="opex-desk__section-title">Range Anchor</span>
          {anchor.sameAsSession ? (
            <span className="opex-desk__meta uppercase">same as session</span>
          ) : (
            <ExpiryKindBadge kind={anchor.event.kind} />
          )}
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <div className="opex-desk__expiry opex-desk__expiry--sm">{anchor.event.expiry}</div>
          <div className="text-[10px] font-semibold tabular-nums text-[var(--desk-value-soft)]">
            {formatExpiryTime(anchor.event)}
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <OpexStat
            label="OI Share"
            value={formatWholePercent(anchor.event.openInterestSharePercent)}
            hint="of listed book"
          />
          <OpexStat
            label="Notional"
            value={formatCompactUsd(anchor.event.expiringNotionalUsd)}
            hint="expiring size"
          />
        </div>
        <p className="opex-desk__body mt-2">{anchor.reason}</p>
      </section>

      {/* ── Horizon: calendar order, not importance score ── */}
      <section className="min-h-0 flex-1 border-t border-[var(--desk-rule)] pt-2.5">
        <div className="opex-desk__section-title mb-1.5">Horizon</div>
        <div className="grid gap-1">
          {horizon.map((row) => (
            <div
              key={row.event.expiry}
              className="grid grid-cols-[56px_minmax(0,1fr)_40px_36px] items-center gap-2 px-0.5 py-1"
            >
              <div className="text-[8.5px] font-semibold uppercase leading-none text-[var(--desk-label)]">
                {row.role}
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[11px] font-semibold leading-none tabular-nums text-[var(--desk-value)]">
                  {row.event.expiry}
                </span>
                <ExpiryKindBadge kind={row.event.kind} />
              </div>
              <div className="text-right text-[10px] font-semibold leading-none tabular-nums text-[var(--desk-value-soft)]">
                {formatExpiryTime(row.event)}
              </div>
              <div className="text-right text-[10px] font-semibold leading-none tabular-nums text-[var(--desk-label)]">
                {formatWholePercent(row.event.openInterestSharePercent)}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Expiry / pin-risk read (OI-aware; not Levels/Regime language) ── */}
      <section className="mt-auto shrink-0 border-t border-[var(--desk-rule)] pt-2.5">
        <div className="opex-desk__section-title mb-1.5">Session Read</div>
        <div className="grid grid-cols-3 gap-1.5">
          <OpexReadout label="Pin" value={read.magnet} tone={read.magnet} />
          <OpexReadout label="Release" value={read.release} tone={read.release} />
          <OpexReadout label="Bias" value={read.skew} tone={read.skewTone} />
        </div>
        <p className="opex-desk__body mt-2">{read.summary}</p>
      </section>
    </div>
  )
}

type OpexDesk = {
  session: ExpiryPositioningEvent
  anchor: {
    event: ExpiryPositioningEvent
    sameAsSession: boolean
    reason: string
  }
  magnets: ExpiryPositioningEvent['topStrikes']
  horizon: Array<{ event: ExpiryPositioningEvent; role: string }>
  read: {
    sessionMode: 'PIN ZONE' | 'TWO-WAY' | 'FLOW DAY'
    magnet: 'High' | 'Med' | 'Low'
    release: 'High' | 'Med' | 'Low'
    skew: 'Upside' | 'Downside' | 'Balanced'
    skewTone: 'High' | 'Med' | 'Low'
    summary: string
  }
}

function buildOpexDesk(events: ExpiryPositioningEvent[]): OpexDesk | null {
  if (events.length === 0) {
    return null
  }

  // Session front = soonest by clock. This is today's print risk, not "importance".
  const byTime = [...events].sort((a, b) => a.hoursToExpiry - b.hoursToExpiry)
  const session = byTime[0]

  // Range anchor = largest structural book. Prefer weekly+ size; never just urgency.
  const anchor = pickRangeAnchor(events, session)

  // Magnets: ranked by OI × proximity (GEX is displayed, not used for rank).
  const magnets = [...session.topStrikes]
    .map((strike) => ({
      strike,
      score: strike.openInterest / (1 + Math.abs(strike.distanceFromSpotPercent) * 1.35),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((row) => row.strike)

  // Horizon: next few by calendar, but never drop the range anchor when it sits further out.
  const horizon = buildHorizonRows(byTime, session, anchor.event)

  const read = buildSessionTradeRead(session, anchor.event, magnets)

  return { session, anchor, magnets, horizon, read }
}

/** Next few expiries by clock, always including the range anchor when distinct. */
function buildHorizonRows(
  byTime: ExpiryPositioningEvent[],
  session: ExpiryPositioningEvent,
  anchor: ExpiryPositioningEvent,
): OpexDesk['horizon'] {
  const maxRows = 4
  const picked: ExpiryPositioningEvent[] = []
  const seen = new Set<string>()

  const push = (event: ExpiryPositioningEvent) => {
    if (seen.has(event.expiry)) return
    seen.add(event.expiry)
    picked.push(event)
  }

  for (const event of byTime) {
    if (picked.length >= maxRows) break
    push(event)
  }

  // Ensure range anchor is visible even when it falls outside the next few dailies.
  if (!seen.has(anchor.expiry)) {
    if (picked.length < maxRows) {
      push(anchor)
    } else {
      // Prefer keeping session front; replace the furthest non-session row.
      const replaceIndex = [...picked]
        .map((event, index) => ({ event, index }))
        .reverse()
        .find((row) => row.event.expiry !== session.expiry)?.index
      if (replaceIndex !== undefined) {
        seen.delete(picked[replaceIndex].expiry)
        picked[replaceIndex] = anchor
        seen.add(anchor.expiry)
      } else {
        push(anchor)
      }
    }
  }

  return [...picked]
    .sort((a, b) => a.hoursToExpiry - b.hoursToExpiry)
    .map((event) => ({
      event,
      role: getHorizonRole(event, session, anchor),
    }))
}

function pickRangeAnchor(
  events: ExpiryPositioningEvent[],
  session: ExpiryPositioningEvent,
): OpexDesk['anchor'] {
  const structuralWeight = (event: ExpiryPositioningEvent) => {
    const kindBoost = event.kind === 'quarterly' ? 18
      : event.kind === 'monthly' ? 14
        : event.kind === 'weekly' ? 8
          : 0
    // Size + OI share dominate; urgency is intentionally ignored so 0DTE does not always win.
    return event.sizeScore * 0.55
      + event.openInterestSharePercent * 0.35
      + kindBoost
      + Math.min(event.daysToExpiry, 30) * 0.15
  }

  const ranked = [...events].sort((a, b) => structuralWeight(b) - structuralWeight(a))
  const best = ranked[0]
  const bestNonSession = ranked.find((event) => event.expiry !== session.expiry)
  const chosen = bestNonSession && structuralWeight(bestNonSession) >= structuralWeight(session) * 0.72
    ? bestNonSession
    : best

  const sameAsSession = chosen.expiry === session.expiry
  const reason = sameAsSession
    ? 'Front book also holds the largest share of listed OI — session and structure are the same print.'
    : chosen.kind === 'monthly' || chosen.kind === 'quarterly'
      ? 'Largest structural OI beyond the session front.'
      : 'Largest non-session book by size × OI share.'

  return { event: chosen, sameAsSession, reason }
}

function getHorizonRole(
  event: ExpiryPositioningEvent,
  session: ExpiryPositioningEvent,
  anchor: ExpiryPositioningEvent,
): string {
  if (event.expiry === session.expiry) return 'Front'
  if (event.expiry === anchor.expiry) return 'Anchor'
  if (event.kind === 'weekly') return 'Week'
  if (event.kind === 'monthly') return 'Month'
  if (event.kind === 'quarterly') return 'Qtr'
  return 'Next'
}

function buildSessionTradeRead(
  session: ExpiryPositioningEvent,
  anchor: ExpiryPositioningEvent,
  magnets: ExpiryPositioningEvent['topStrikes'],
): OpexDesk['read'] {
  // Pin intensity: near-spot OI share of this expiry (concentrationScore is the same field upstream).
  const nearSpotOiPct = session.nearSpotOpenInterestSharePercent
  const magnet: OpexDesk['read']['magnet'] = nearSpotOiPct >= 42
    ? 'High'
    : nearSpotOiPct >= 22
      ? 'Med'
      : 'Low'

  // Release risk: large book rolling off soon (post-expiry expansion), not pin itself.
  const releaseScore = session.sizeScore * 0.5
    + session.openInterestSharePercent * 0.25
    + (session.hoursToExpiry < 18 ? 25 : session.hoursToExpiry < 48 ? 12 : 0)
  const release: OpexDesk['read']['release'] = releaseScore >= 55
    ? 'High'
    : releaseScore >= 32
      ? 'Med'
      : 'Low'

  // Bias from magnet OI only (contracts above vs below spot). Do not mix GEX dollars into this.
  const aboveSpot = magnets.filter((s) => s.distanceFromSpotPercent >= 0)
  const belowSpot = magnets.filter((s) => s.distanceFromSpotPercent < 0)
  const upsideOi = sum(aboveSpot.map((s) => s.openInterest))
  const downsideOi = sum(belowSpot.map((s) => s.openInterest))

  let skew: OpexDesk['read']['skew'] = 'Balanced'
  let skewTone: OpexDesk['read']['skewTone'] = 'Low'
  if (upsideOi > downsideOi * 1.35) {
    skew = 'Upside'
    skewTone = 'Med'
  } else if (downsideOi > upsideOi * 1.35) {
    skew = 'Downside'
    skewTone = 'Med'
  }

  const sessionMode: OpexDesk['read']['sessionMode'] = magnet === 'High'
    ? 'PIN ZONE'
    : magnet === 'Med'
      ? 'TWO-WAY'
      : 'FLOW DAY'

  const magnetStrike = magnets[0]
  const magnetText = magnetStrike
    ? `$${formatStrike(magnetStrike.strike)} (${formatSignedPercent(magnetStrike.distanceFromSpotPercent)})`
    : null

  // Observational only — expiry / pin structure, no Levels/Regime role language.
  const pinPhrase = magnet === 'High'
    ? `Near-spot OI is heavy into ${session.expiry} (${formatWholePercent(nearSpotOiPct)})`
    : magnet === 'Med'
      ? `Near-spot OI is moderate into ${session.expiry} (${formatWholePercent(nearSpotOiPct)})`
      : `Near-spot OI is light into ${session.expiry} (${formatWholePercent(nearSpotOiPct)})`

  const magnetPhrase = magnetText
    ? `top magnet ${magnetText}`
    : 'no near-spot magnet'

  const releasePhrase = release === 'High'
    ? `${formatWholePercent(session.openInterestSharePercent)} OI rolls off in ${formatExpiryTime(session)}`
    : release === 'Med'
      ? `moderate roll-off size on ${session.expiry}`
      : `limited roll-off size on ${session.expiry}`

  const anchorPhrase = anchor.expiry === session.expiry
    ? 'session is also the range anchor'
    : `range anchor ${anchor.expiry} holds ${formatWholePercent(anchor.openInterestSharePercent)} OI`

  const skewPhrase = skew === 'Balanced'
    ? 'magnet OI bias balanced'
    : skew === 'Upside'
      ? 'magnet OI bias to the upside'
      : 'magnet OI bias to the downside'

  const summary = `${pinPhrase}; ${magnetPhrase}. ${releasePhrase}; ${anchorPhrase}; ${skewPhrase}.`

  return { sessionMode, magnet, release, skew, skewTone, summary }
}

function OpexStat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'warn' | 'accent'
}) {
  const valueClass = tone === 'warn'
    ? 'opex-desk__stat-value--warn'
    : tone === 'accent'
      ? 'opex-desk__stat-value--accent'
      : undefined

  return (
    <div className="opex-desk__stat">
      <div className="opex-desk__stat-label">{label}</div>
      <div className={cn('opex-desk__stat-value', valueClass)}>{value}</div>
      {hint ? <div className="opex-desk__stat-hint">{hint}</div> : null}
    </div>
  )
}

function OpexReadout({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'High' | 'Med' | 'Low'
}) {
  const toneClass = {
    High: 'opex-desk__stat-value--high',
    Med: 'opex-desk__stat-value--med',
    Low: 'opex-desk__stat-value--low',
  }[tone]

  return (
    <div className="opex-desk__stat">
      <div className="opex-desk__stat-label">{label}</div>
      <div className={cn('opex-desk__stat-value', toneClass)}>{value}</div>
    </div>
  )
}

function ExpiryKindBadge({ kind }: { kind: ExpiryKind }) {
  return (
    <span className={cn('opex-desk__badge', getExpiryKindBadgeClassName(kind))}>
      {kind}
    </span>
  )
}

function getExpiryKindBadgeClassName(kind: ExpiryKind) {
  if (kind === 'quarterly') return 'opex-desk__badge--quarterly'
  if (kind === 'monthly') return 'opex-desk__badge--monthly'
  if (kind === 'weekly') return 'opex-desk__badge--weekly'
  return undefined
}

function getSessionModeClassName(mode: OpexDesk['read']['sessionMode']) {
  if (mode === 'PIN ZONE') return 'opex-desk__mode opex-desk__mode--pin'
  if (mode === 'TWO-WAY') return 'opex-desk__mode opex-desk__mode--twoway'
  return 'opex-desk__mode opex-desk__mode--flow'
}

/**
 * Compact remaining time. Expired / zero hours show "0h" (never forced to "1h").
 * Sub-30m remaining shows "<1h" so the countdown does not round to zero while live.
 */
function formatExpiryTime(event: ExpiryPositioningEvent) {
  return formatExpiryCountdown(event).text
}

function formatExpiryCountdown(event: ExpiryPositioningEvent): { text: string; showLeft: boolean } {
  const hours = event.hoursToExpiry

  if (!Number.isFinite(hours) || hours <= 0) {
    return { text: '0h', showLeft: false }
  }

  if (hours < 36) {
    const rounded = Math.round(hours)
    if (rounded === 0) {
      return { text: '<1h', showLeft: true }
    }
    return { text: `${rounded}h`, showLeft: true }
  }

  const daysText = event.daysToExpiry < 10
    ? event.daysToExpiry.toFixed(1)
    : String(Math.round(event.daysToExpiry))
  return { text: `${daysText}d`, showLeft: true }
}

function formatCompactUsd(value: number) {
  if (Math.abs(value) >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`
  }

  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`
  }

  return formatUsd(value)
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

