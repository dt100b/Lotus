import { useState, type CSSProperties, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { WallSignificanceChart } from '@/components/terminal/WallSignificanceChart'
import type { ExpiryContribution, ExpiryKind, ExpiryPositioningEvent, RankingRow, TerminalSnapshot } from '@/data/mockTerminal'
import type { GexLevelSelection } from '@/components/terminal/RankingTable'
import { formatMillions, formatSignedPercent, formatStrike, formatUsd } from '@/lib/formatters'
import { useTerminalStore, type LevelVisibilityKey } from '@/store/terminalStore'
import { getSpotDistanceColor, levelColors } from '@/data/levelColors'

type SidePanelsProps = {
  snapshot: TerminalSnapshot
  allExpirySnapshot?: TerminalSnapshot
  zeroDteSnapshot?: TerminalSnapshot
  selectedLevel?: GexLevelSelection | null
  onCloseLevelInspector?: () => void
}

type LevelPanelTab = 'levels' | 'walls' | 'expiry'

const spotProximityThresholdPercent = 0.5
const lotusPatternThresholdPercent = 0.25
const lotusSignatureThresholdPercent = 0.1
const allLevelVisibilityKeys: LevelVisibilityKey[] = [
  'allExpiryHvl',
  'allExpiryCallResistance',
  'allExpiryPutSupport',
  'zeroDteHvl',
  'zeroDteCall',
  'zeroDtePut',
  'advancedZeroGamma',
  'advancedMaxPain',
  'advancedExpectedMove',
  'advancedGammaFlipZones',
]

export function SidePanels({
  snapshot,
  allExpirySnapshot,
  zeroDteSnapshot,
  selectedLevel,
  onCloseLevelInspector,
}: SidePanelsProps) {
  const [levelPanelTab, setLevelPanelTab] = useState<LevelPanelTab>('levels')
  const theme = useTerminalStore((state) => state.theme)
  const levelVisibility = useTerminalStore((state) => state.levelVisibility)
  const setLevelVisibility = useTerminalStore((state) => state.setLevelVisibility)
  const signatureRowId = getSignatureLevelRowId(snapshot)
  const allLevelsVisible = allLevelVisibilityKeys.every((level) => levelVisibility[level])
  const toggleAllLevels = () => {
    const nextVisible = !allLevelsVisible

    allLevelVisibilityKeys.forEach((level) => setLevelVisibility(level, nextVisible))
  }

  if (selectedLevel) {
    return (
      <LevelInspector
        snapshot={selectedLevel.scope === 'zeroDte' ? zeroDteSnapshot ?? snapshot : allExpirySnapshot ?? snapshot}
        selection={selectedLevel}
        onClose={onCloseLevelInspector ?? (() => undefined)}
      />
    )
  }

  return (
    <aside className="terminal-panel terminal-rail grid h-full grid-rows-[auto_minmax(0,1fr)] content-stretch items-stretch">
      <RailSection
        title="Price Sources"
      >
        <div className="grid gap-0">
          {snapshot.marketSources.map((source) => (
            <div
              key={source.name}
              className="grid grid-cols-[1fr_auto] items-center gap-4 px-1 py-2 text-[11px]"
            >
              <div className="flex items-center gap-3 text-[var(--terminal-muted)]">
                <SourceLogo sourceName={source.name} />
                <span>{source.name}</span>
              </div>
              <div className="text-right">
                <div className="terminal-value font-semibold text-[var(--terminal-heading)]">{formatUsd(source.value)}</div>
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
        action={levelPanelTab === 'levels' ? (
          <div className="flex items-center gap-1.5">
            <ToggleAllLevelsButton allVisible={allLevelsVisible} onToggle={toggleAllLevels} />
            <CopyLevelsButton />
          </div>
        ) : null}
        className="flex min-h-0 flex-col"
      >
        {levelPanelTab === 'levels' ? (
          <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
            <PanelGroupTitle title="All-Expiry Levels" />
            <LevelRows
              title="All-Expiry Levels"
              items={snapshot.levels.allExpiry}
              levelVisibility={levelVisibility}
              setLevelVisibility={setLevelVisibility}
              signatureRowId={signatureRowId}
              spot={snapshot.spot}
            />

            <PanelGroupTitle title="0DTE Levels" />
            <LevelRows
              title="0DTE Levels"
              items={snapshot.levels.zeroDte}
              levelVisibility={levelVisibility}
              setLevelVisibility={setLevelVisibility}
              signatureRowId={signatureRowId}
              spot={snapshot.spot}
            />

            <PanelGroupTitle title="Advanced" />
            <AdvancedRows
              items={snapshot.levels.advanced}
              levelVisibility={levelVisibility}
              signatureRowId={signatureRowId}
              setLevelVisibility={setLevelVisibility}
              spot={snapshot.spot}
            />
            <GammaRegimeExtension snapshot={snapshot} />
          </div>
        ) : levelPanelTab === 'walls' ? (
          <WallSignificanceChart snapshot={allExpirySnapshot ?? snapshot} />
        ) : (
          <ExpiryImpactPanel snapshot={snapshot} />
        )}
      </RailSection>
    </aside>
  )
}

type LevelPanelProps = {
  title: string
  items: TerminalSnapshot['levels']['allExpiry']
  levelVisibility: Record<LevelVisibilityKey, boolean>
  setLevelVisibility: (level: LevelVisibilityKey, visible: boolean) => void
  signatureRowId: string | null
  spot: number
}

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
      <div className="min-h-0 flex-1">{children}</div>
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
      aria-label="Levels rail view"
      className={rootClassName}
      role="tablist"
    >
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
        label="Expiry"
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

function LevelInspector({
  snapshot,
  selection,
  onClose,
}: {
  snapshot: TerminalSnapshot
  selection: GexLevelSelection
  onClose: () => void
}) {
  const row = getCurrentRankingRow(snapshot, selection) ?? selection.row
  const isZeroDteSelection = selection.scope === 'zeroDte'
  const sourceLabel = selection.scope === 'zeroDte' ? '0DTE GEX' : 'All-Expiry GEX'
  const gammaBar = snapshot.gammaBars.find((item) => item.strike === row.strike)
  const callGexUsd = gammaBar?.callGammaExposureUsd ?? row.callGammaExposureUsd
  const putGexUsd = gammaBar?.putGammaExposureUsd ?? row.putGammaExposureUsd
  const totalSideAbs = Math.abs(callGexUsd) + Math.abs(putGexUsd)
  const callShare = totalSideAbs === 0 ? 50 : (Math.abs(callGexUsd) / totalSideAbs) * 100
  const putShare = totalSideAbs === 0 ? 50 : 100 - callShare
  const expiryMix = getDisplayExpiryContributions(row, snapshot)
  const topContribution = expiryMix[0]
  const expiryTotalAbs = expiryMix.reduce((total, contribution) => total + Math.abs(contribution.gammaExposureUsd), 0)
  const topContributionShare = expiryTotalAbs === 0 || !topContribution
    ? 0
    : (Math.abs(topContribution.gammaExposureUsd) / expiryTotalAbs) * 100
  const profileAbsTotal = snapshot.gammaBars.reduce((total, item) => total + Math.abs(item.gammaExposureUsd), 0)
  const profileShare = profileAbsTotal === 0 ? 0 : (Math.abs(row.gammaExposureUsd) / profileAbsTotal) * 100
  const topTenOpenInterest = getTopTenOpenInterest(snapshot, selection.scope)
  const openInterestShare = topTenOpenInterest === 0 ? 0 : (row.openInterest / topTenOpenInterest) * 100
  const hedgeBias = row.gammaExposureUsd >= 0 ? 'Dampen' : 'Amplify'

  return (
    <aside className="terminal-panel terminal-rail grid h-full min-h-0">
      <section className="terminal-rail-section flex min-h-0 flex-col overflow-hidden">
        <div className="terminal-section-header">
          <div className="min-w-0">
            <h2 className="terminal-title whitespace-nowrap">Level Inspector</h2>
            <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.11em] text-[var(--terminal-muted)]">
              {sourceLabel}
            </div>
          </div>
          <button
            aria-label="Close level inspector"
            className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-[var(--terminal-control-radius)] border border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] text-[var(--terminal-muted)] transition-colors hover:border-[var(--terminal-border-strong)] hover:text-[var(--terminal-heading)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-border-strong)]"
            type="button"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid grid-cols-[1fr_auto] items-end gap-3 border-b border-[var(--terminal-rule)] pb-4">
            <div className="min-w-0">
              <div className="terminal-value text-[28px] font-semibold leading-none text-[var(--terminal-heading)]">
                ${formatStrike(row.strike)}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <InspectorBadge tone={row.gammaExposureUsd >= 0 ? 'green' : 'red'}>
                  {row.gammaExposureUsd >= 0 ? 'Positive GEX' : 'Negative GEX'}
                </InspectorBadge>
                <InspectorBadge tone={row.gammaExposureUsd >= 0 ? 'green' : 'red'}>{hedgeBias}</InspectorBadge>
                {!isZeroDteSelection ? (
                  <InspectorBadge tone={topContributionShare >= 70 ? 'amber' : 'muted'}>
                    {formatWholePercent(topContributionShare)} concentrated
                  </InspectorBadge>
                ) : null}
              </div>
            </div>
            <div className="text-right">
              <div className={row.gammaExposureUsd >= 0 ? 'terminal-value text-[17px] font-semibold text-[var(--terminal-green-strong)]' : 'terminal-value text-[17px] font-semibold text-[var(--terminal-red-strong)]'}>
                {formatMillions(row.gammaExposureUsd)}
              </div>
              <div className="mt-1 text-[8.5px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-muted)]">
                #{row.rank}
              </div>
            </div>
          </div>

          <InspectorSection title="7D GEX Trend">
            <HistoricalGexChart points={row.gexHistory} />
          </InspectorSection>

          <InspectorSection title="Composition">
            <div className="grid grid-cols-3 gap-2">
              <InspectorStat
                label="Spot Distance"
                value={formatSignedPercent(row.distanceFromSpotPercent)}
                tone="muted"
                valueStyle={{ color: getSpotDistanceColor(row.distanceFromSpotPercent) }}
              />
              <InspectorStat label="Profile Share" value={formatWholePercent(profileShare)} tone="muted" />
              <InspectorStat label="Top 10 OI" value={formatWholePercent(openInterestShare)} tone={getOpenInterestShareTone(openInterestShare)} />
            </div>
            <div className="mt-3 grid gap-2">
              <GexCompositionBar
                callGexUsd={callGexUsd}
                putGexUsd={putGexUsd}
                callShare={callShare}
                putShare={putShare}
              />
              <OpenInterestCompositionBar
                openInterest={row.openInterest}
                totalOpenInterest={topTenOpenInterest}
              />
            </div>
          </InspectorSection>

          {!isZeroDteSelection ? (
            <InspectorSection title="Expiry Mix">
              <div className="grid gap-2">
                {expiryMix.slice(0, 5).map((contribution) => (
                  <ExpiryMixRow
                    key={contribution.expiry}
                    contribution={contribution}
                    maxAbs={Math.max(...expiryMix.map((item) => Math.abs(item.gammaExposureUsd)))}
                  />
                ))}
              </div>
            </InspectorSection>
          ) : null}

          <InspectorSection title="Dealer Positioning">
            <DealerPositioning row={row} />
          </InspectorSection>
        </div>
      </section>
    </aside>
  )
}

function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-[var(--terminal-rule)] py-3.5 last:border-b-0">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[9px] font-semibold uppercase leading-none tracking-[0.14em] text-[var(--terminal-muted)]">
          {title}
        </h3>
        <span className="h-px flex-1 bg-[var(--terminal-rule)]" />
      </div>
      {children}
    </section>
  )
}

function InspectorBadge({ tone, children }: { tone: 'green' | 'red' | 'amber' | 'muted'; children: ReactNode }) {
  const toneClassName = {
    green: 'border-[rgba(148,201,112,0.36)] bg-[rgba(117,153,84,0.13)] text-[var(--terminal-green-strong)]',
    red: 'border-[rgba(238,95,102,0.36)] bg-[rgba(190,64,70,0.13)] text-[var(--terminal-red-strong)]',
    amber: 'border-[rgba(208,188,98,0.38)] bg-[rgba(208,188,98,0.11)] text-[var(--terminal-yellow)]',
    muted: 'border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] text-[var(--terminal-muted)]',
  }[tone]

  return (
    <span className={`rounded-[var(--terminal-control-radius)] border px-1.5 py-1 text-[8.5px] font-semibold uppercase leading-none tracking-[0.1em] ${toneClassName}`}>
      {children}
    </span>
  )
}

function InspectorStat({
  label,
  value,
  tone,
  valueStyle,
}: {
  label: string
  value: string
  tone: 'green' | 'red' | 'amber' | 'muted'
  valueStyle?: CSSProperties
}) {
  const toneClassName = {
    green: 'text-[var(--terminal-green-strong)]',
    red: 'text-[var(--terminal-red-strong)]',
    amber: 'text-[var(--terminal-yellow)]',
    muted: 'text-[var(--terminal-heading)]',
  }[tone]

  return (
    <div>
      <div className="mb-1 text-[8px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-muted)]">{label}</div>
      <div className={`terminal-value text-[10.5px] font-semibold ${toneClassName}`} style={valueStyle}>{value}</div>
    </div>
  )
}

function HistoricalGexChart({ points }: { points: RankingRow['gexHistory'] }) {
  const dimensions = { width: 360, height: 132, left: 42, right: 8, top: 10, bottom: 22 }
  const innerWidth = dimensions.width - dimensions.left - dimensions.right
  const innerHeight = dimensions.height - dimensions.top - dimensions.bottom
  const allValues = points.flatMap((point) => [point.netGexUsd, point.callGexUsd, point.putGexUsd])
  const maxAbs = Math.max(...allValues.map((value) => Math.abs(value)), 1)
  const x = (index: number) => dimensions.left + (index / Math.max(1, points.length - 1)) * innerWidth
  const y = (value: number) => dimensions.top + ((maxAbs - value) / (maxAbs * 2)) * innerHeight
  const pathFor = (key: 'netGexUsd' | 'callGexUsd' | 'putGexUsd') => points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(1)} ${y(point[key]).toFixed(1)}`)
    .join(' ')
  const zeroY = y(0)

  return (
    <div>
      <svg viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} className="h-[132px] w-full" role="img" aria-label="Seven day GEX trend">
        <line
          x1={dimensions.left}
          x2={dimensions.width - dimensions.right}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--terminal-border-strong)"
          strokeDasharray="4 5"
          strokeOpacity="0.6"
        />
        {[0.25, 0.5, 0.75].map((tick) => {
          const tickY = dimensions.top + tick * innerHeight

          return (
            <line
              key={tick}
              x1={dimensions.left}
              x2={dimensions.width - dimensions.right}
              y1={tickY}
              y2={tickY}
              stroke="var(--terminal-grid)"
            />
          )
        })}
        {points.map((point, index) => (
          <line
            key={point.label}
            x1={x(index)}
            x2={x(index)}
            y1={dimensions.top}
            y2={dimensions.height - dimensions.bottom}
            stroke="var(--terminal-grid)"
            strokeOpacity={index === points.length - 1 ? 0.55 : 0.32}
          />
        ))}
        <path d={pathFor('callGexUsd')} fill="none" stroke="var(--terminal-green-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d={pathFor('putGexUsd')} fill="none" stroke="var(--terminal-red-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d={pathFor('netGexUsd')} fill="none" stroke="var(--terminal-yellow)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((point, index) => (
          <circle
            key={`${point.label}-net`}
            cx={x(index)}
            cy={y(point.netGexUsd)}
            r={index === points.length - 1 ? 2.6 : 1.8}
            fill="var(--terminal-yellow)"
          />
        ))}
        <text x="2" y={y(maxAbs)} fill="var(--terminal-muted)" fontSize="9" dominantBaseline="middle">
          {formatMillions(maxAbs)}
        </text>
        <text x="2" y={zeroY} fill="var(--terminal-muted)" fontSize="9" dominantBaseline="middle">
          0
        </text>
        <text x="2" y={y(-maxAbs)} fill="var(--terminal-muted)" fontSize="9" dominantBaseline="middle">
          {formatMillions(-maxAbs)}
        </text>
        <text x={dimensions.left} y={dimensions.height - 4} fill="var(--terminal-muted)" fontSize="9">
          {points[0]?.label}
        </text>
        <text x={dimensions.width - dimensions.right} y={dimensions.height - 4} fill="var(--terminal-muted)" fontSize="9" textAnchor="end">
          {points.at(-1)?.label}
        </text>
      </svg>
      <div className="mt-2 flex items-center gap-4 text-[8.5px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-muted)]">
        <ChartLegendItem color="var(--terminal-yellow)" label="Net" />
        <ChartLegendItem color="var(--terminal-green-strong)" label="Call" />
        <ChartLegendItem color="var(--terminal-red-strong)" label="Put" />
      </div>
    </div>
  )
}

function ChartLegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-px w-4" style={{ background: color }} />
      {label}
    </span>
  )
}

function GexCompositionBar({
  callGexUsd,
  putGexUsd,
  callShare,
  putShare,
}: {
  callGexUsd: number
  putGexUsd: number
  callShare: number
  putShare: number
}) {
  const netGexUsd = callGexUsd + putGexUsd

  return (
    <div className="grid grid-cols-[78px_minmax(0,1fr)_64px] items-center gap-2 text-[10px]">
      <div className="font-semibold uppercase tracking-[0.08em] text-[var(--terminal-muted)]">GEX Split</div>
      <div
        className="flex h-1.5 overflow-hidden border border-[var(--terminal-border)] bg-[var(--terminal-bg-soft)]"
        title={`Call GEX ${formatMillions(callGexUsd)} / Put GEX ${formatMillions(putGexUsd)}`}
      >
        <div className="h-full bg-[var(--chart-positive)]" style={{ width: `${clamp(callShare, 2, 98)}%` }} />
        <div className="h-full bg-[var(--chart-negative)]" style={{ width: `${clamp(putShare, 2, 98)}%` }} />
      </div>
      <div className={netGexUsd >= 0 ? 'terminal-value text-right text-[var(--terminal-green-strong)]' : 'terminal-value text-right text-[var(--terminal-red-strong)]'}>
        {formatMillions(netGexUsd)}
      </div>
    </div>
  )
}

function OpenInterestCompositionBar({
  openInterest,
  totalOpenInterest,
}: {
  openInterest: number
  totalOpenInterest: number
}) {
  const share = totalOpenInterest === 0 ? 0 : (openInterest / totalOpenInterest) * 100

  return (
    <div className="grid grid-cols-[78px_minmax(0,1fr)_64px] items-center gap-2 text-[10px]">
      <div className="font-semibold uppercase tracking-[0.08em] text-[var(--terminal-muted)]">Open Int</div>
      <div
        className="flex h-1.5 overflow-hidden border border-[var(--terminal-border)] bg-[var(--terminal-bg-soft)]"
        title={`${formatOpenInterest(openInterest)} OI at this level / ${formatOpenInterest(totalOpenInterest)} Top 10 OI`}
      >
        <div className="h-full bg-[var(--terminal-blue)]" style={{ width: `${clamp(share, 2, 100)}%` }} />
      </div>
      <div className="terminal-value text-right text-[var(--terminal-heading)]">
        {formatOpenInterest(openInterest)}
      </div>
    </div>
  )
}

function ExpiryMixRow({ contribution, maxAbs }: { contribution: ExpiryContribution; maxAbs: number }) {
  const positive = contribution.gammaExposureUsd >= 0
  const width = maxAbs === 0 ? 0 : (Math.abs(contribution.gammaExposureUsd) / maxAbs) * 100

  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)_70px] items-center gap-2 text-[10px]">
      <div className="truncate font-semibold uppercase tracking-[0.08em] text-[var(--terminal-text)]">
        {formatExpiryLabel(contribution.expiry)}
      </div>
      <div className="h-1.5 border border-[var(--terminal-border)] bg-[var(--terminal-bg-soft)]">
        <div
          className={positive ? 'h-full bg-[var(--chart-positive)]' : 'h-full bg-[var(--chart-negative)]'}
          style={{ width: `${clamp(width, 4, 100)}%` }}
        />
      </div>
      <div className={positive ? 'terminal-value text-right text-[var(--terminal-green-strong)]' : 'terminal-value text-right text-[var(--terminal-red-strong)]'}>
        {formatMillions(contribution.gammaExposureUsd)}
      </div>
    </div>
  )
}

function DealerPositioning({ row }: { row: RankingRow }) {
  const positive = row.gammaExposureUsd >= 0
  const hedgeBias = positive ? 'Dampen' : 'Amplify'

  return (
    <div className="grid grid-cols-3 gap-2">
      <InspectorStat label="Hedge Bias" value={hedgeBias} tone={positive ? 'green' : 'red'} />
    </div>
  )
}

function ToggleAllLevelsButton({
  allVisible,
  onToggle,
}: {
  allVisible: boolean
  onToggle: () => void
}) {
  return (
    <button
      aria-label={allVisible ? 'Hide all GEX levels' : 'Show all GEX levels'}
      aria-pressed={allVisible}
      className="group flex h-4 w-6 cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-green)]"
      title={allVisible ? 'Hide all levels' : 'Show all levels'}
      type="button"
      onClick={onToggle}
    >
      <span
        aria-hidden="true"
        className={allVisible
          ? 'relative h-3.5 w-6 rounded-full border border-[var(--terminal-active-border)] bg-[var(--terminal-active-toggle-bg)] shadow-[var(--terminal-active-shadow)] transition-[background-color,border-color,box-shadow] duration-200'
          : 'relative h-3.5 w-6 rounded-full border border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] shadow-[var(--terminal-control-inset)] transition-[background-color,border-color,box-shadow] duration-200 group-hover:border-[var(--terminal-border-strong)]'}
      >
        <span
          className={allVisible
            ? 'absolute left-[11px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[var(--terminal-green-strong)] shadow-[0_0_7px_color-mix(in_srgb,var(--terminal-green-strong)_42%,transparent)] transition-[left,background-color,box-shadow] duration-200'
            : 'absolute left-[2px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[var(--terminal-subtle)] transition-[left,background-color,box-shadow] duration-200'}
        />
      </span>
    </button>
  )
}

function CopyLevelsButton() {
  return (
    <button
      aria-label="Copy GEX levels"
      className="flex h-4 min-w-10 cursor-pointer items-center justify-center rounded-[var(--terminal-control-radius)] border border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] px-1.5 text-[10px] font-semibold uppercase leading-none text-[var(--terminal-blue)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)] transition-[border-color,background-color,box-shadow,color,transform] duration-150 hover:border-[var(--terminal-blue)] hover:bg-[rgba(134,169,199,0.12)] hover:text-[var(--terminal-heading)] hover:ring-1 hover:ring-[rgba(134,169,199,0.34)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-blue)] active:translate-y-px"
      type="button"
    >
      <span className="inline-block origin-center scale-[0.72] tracking-[0.08em]">
        Copy
      </span>
    </button>
  )
}

function PanelGroupTitle({ title }: { title: string }) {
  return (
    <div className="mt-1 flex items-center gap-2 first:mt-0">
      <span className="text-[9.5px] font-semibold uppercase leading-none tracking-[0.14em] text-[var(--terminal-muted)]">{title}</span>
      <span className="h-px flex-1 bg-[var(--terminal-rule)]" />
    </div>
  )
}

function LevelRows({ title, items, levelVisibility, setLevelVisibility, signatureRowId, spot }: LevelPanelProps) {
  return (
    <div className="grid gap-0">
      {items.map((item) => {
        const visibilityKey = getLevelVisibilityKey(title, item.label)
        const visible = levelVisibility[visibilityKey]
        const rowId = getLevelRowId(title, item.label)
        const distanceFromSpotPercent = item.distanceFromSpotPercent ?? getDistanceFromSpotPercent(item.strike, spot)
        const proximityTier = getSpotProximityTier(distanceFromSpotPercent, rowId, signatureRowId)
        const markerColor = getLevelMarkerColor(title, item.label)
        const proximityStyle = getSpotProximityStyle(distanceFromSpotPercent, markerColor, proximityTier)

        return (
          <div
            key={item.label}
            className={getLevelRowClassName(Boolean(proximityStyle))}
            style={proximityStyle}
          >
            <LevelProximityFlow color={markerColor} tier={proximityTier} />
            <div className="relative z-10 flex items-center gap-3 px-1 py-1.5 text-[var(--terminal-text)]">
              <MetricMarkerButton
                color={markerColor}
                label={item.label}
                variant={getLevelMarkerVariant(item.label)}
                visible={visible}
                onToggle={() => setLevelVisibility(visibilityKey, !visible)}
              />
              {item.label}
            </div>
            <div className="terminal-value relative z-10 border-l border-[var(--terminal-rule)] px-3 py-1.5 text-right font-semibold text-[var(--terminal-heading)]">${formatStrike(item.strike)}</div>
            <div
              className="terminal-value relative z-10 px-1 py-1.5 text-right"
              style={{ color: getSpotDistanceColor(distanceFromSpotPercent) }}
              title="Percent from spot"
            >
              {distanceFromSpotPercent === undefined ? '-' : formatSignedPercent(distanceFromSpotPercent)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AdvancedRows({
  items,
  levelVisibility,
  signatureRowId,
  spot,
  setLevelVisibility,
}: {
  items: TerminalSnapshot['levels']['advanced']
  levelVisibility: Record<LevelVisibilityKey, boolean>
  signatureRowId: string | null
  setLevelVisibility: (level: LevelVisibilityKey, visible: boolean) => void
  spot: number
}) {
  return (
    <div className="grid gap-0">
      {items.map((metric) => {
        const expectedMoveRange = metric.label === 'Expected Move' ? splitExpectedMoveRange(metric.value) : null
        const visibilityKey = getAdvancedVisibilityKey(metric.label)
        const visible = levelVisibility[visibilityKey]
        const rowId = getAdvancedRowId(metric.label)
        const distanceFromSpotPercent = getAdvancedDistanceFromSpotPercent(metric, spot, expectedMoveRange)
        const proximityTier = getSpotProximityTier(distanceFromSpotPercent, rowId, signatureRowId)
        const markerColor = getAdvancedMarkerColor(metric)
        const proximityStyle = getSpotProximityStyle(distanceFromSpotPercent, markerColor, proximityTier)
        const distanceDisplay = distanceFromSpotPercent === undefined ? '-' : formatSignedPercent(distanceFromSpotPercent)

        return (
          <div
            key={metric.label}
            className={getLevelRowClassName(Boolean(proximityStyle))}
            style={proximityStyle}
          >
            <LevelProximityFlow color={markerColor} tier={proximityTier} />
            <div className="relative z-10 flex items-center gap-3 px-1 py-1.5 text-[var(--terminal-text)]">
              <MetricMarkerButton
                color={markerColor}
                label={metric.label}
                variant={getAdvancedMarkerVariant(metric.label)}
                visible={visible}
                onToggle={() => setLevelVisibility(visibilityKey, !visible)}
              />
              {metric.label}
            </div>
            <div className="terminal-value relative z-10 border-l border-[var(--terminal-rule)] px-3 py-1.5 text-right font-semibold text-[var(--terminal-heading)]">
              {expectedMoveRange?.lower ?? metric.value}
            </div>
            <div
              className={expectedMoveRange ? 'terminal-value relative z-10 -ml-3 px-0 py-1.5 text-left font-semibold text-[var(--terminal-heading)]' : 'terminal-value relative z-10 px-1 py-1.5 text-right'}
              style={expectedMoveRange ? undefined : { color: getSpotDistanceColor(distanceFromSpotPercent) }}
            >
              {expectedMoveRange?.upper ?? distanceDisplay}
            </div>
          </div>
        )
      })}
    </div>
  )
}

type SpotProximityTier = 'none' | 'near' | 'pattern' | 'signature'

function LevelProximityFlow({ color, tier }: { color: string, tier: SpotProximityTier }) {
  if (tier === 'none') {
    return null
  }

  const flowStyle = {
    '--level-flow-color': color,
  } as CSSProperties

  return <div aria-hidden="true" className={`level-proximity-flow level-proximity-flow--${tier}`} style={flowStyle} />
}

function getLevelRowClassName(highlighted: boolean) {
  const baseClassName = 'relative grid grid-cols-[170px_120px_minmax(54px,1fr)] items-center overflow-hidden border-b border-[var(--terminal-rule)] text-[11px] transition-[background-color,filter,box-shadow] last:border-b-0 hover:bg-[var(--terminal-surface-2)]'

  return highlighted ? `${baseClassName} hover:brightness-110` : baseClassName
}

function getSpotProximityStyle(
  distanceFromSpotPercent: number | undefined,
  color: string,
  tier: SpotProximityTier,
): CSSProperties | undefined {
  if (distanceFromSpotPercent === undefined || !Number.isFinite(distanceFromSpotPercent)) {
    return undefined
  }

  const distance = Math.abs(distanceFromSpotPercent)
  if (distance > spotProximityThresholdPercent) {
    return undefined
  }

  const intensity = 1 - distance / spotProximityThresholdPercent
  const edgeMix = 24 + intensity * 34
  const outlineMix = tier === 'signature' ? 18 : tier === 'pattern' ? 11 : 0

  return {
    boxShadow: [
      `inset 2px 0 0 color-mix(in srgb, ${color} ${edgeMix}%, transparent)`,
      outlineMix > 0 ? `inset 0 0 0 1px color-mix(in srgb, ${color} ${outlineMix}%, transparent)` : '',
    ].filter(Boolean).join(', '),
  }
}

function getSpotProximityTier(
  distanceFromSpotPercent: number | undefined,
  rowId: string,
  signatureRowId: string | null,
): SpotProximityTier {
  if (distanceFromSpotPercent === undefined || !Number.isFinite(distanceFromSpotPercent)) {
    return 'none'
  }

  const distance = Math.abs(distanceFromSpotPercent)
  if (rowId === signatureRowId && distance <= lotusSignatureThresholdPercent) {
    return 'signature'
  }

  if (distance <= lotusPatternThresholdPercent) {
    return 'pattern'
  }

  return distance <= spotProximityThresholdPercent ? 'near' : 'none'
}

function getAdvancedDistanceFromSpotPercent(
  metric: TerminalSnapshot['levels']['advanced'][number],
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

function getSignatureLevelRowId(snapshot: TerminalSnapshot) {
  const candidates: Array<{ rowId: string; distance: number }> = []
  const addCandidate = (rowId: string, distanceFromSpotPercent: number | undefined) => {
    if (distanceFromSpotPercent === undefined || !Number.isFinite(distanceFromSpotPercent)) {
      return
    }

    const distance = Math.abs(distanceFromSpotPercent)
    if (distance <= lotusSignatureThresholdPercent) {
      candidates.push({ rowId, distance })
    }
  }

  snapshot.levels.allExpiry.forEach((item) => {
    addCandidate(
      getLevelRowId('All-Expiry Levels', item.label),
      item.distanceFromSpotPercent ?? getDistanceFromSpotPercent(item.strike, snapshot.spot),
    )
  })
  snapshot.levels.zeroDte.forEach((item) => {
    addCandidate(
      getLevelRowId('0DTE Levels', item.label),
      item.distanceFromSpotPercent ?? getDistanceFromSpotPercent(item.strike, snapshot.spot),
    )
  })
  snapshot.levels.advanced.forEach((metric) => {
    const isRangeMetric = metric.label === 'Expected Move' && splitExpectedMoveRange(metric.value)
    if (isRangeMetric) {
      return
    }

    addCandidate(
      getAdvancedRowId(metric.label),
      getAdvancedDistanceFromSpotPercent(metric, snapshot.spot, null),
    )
  })

  return candidates.sort((a, b) => a.distance - b.distance)[0]?.rowId ?? null
}

function getLevelRowId(title: string, label: string) {
  return `${title}:${label}`
}

function getAdvancedRowId(label: string) {
  return `Advanced:${label}`
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
  const baseClassName = 'text-[10px]'

  if (!signedValue) {
    return `${baseClassName} text-[var(--terminal-muted)]`
  }

  const value = Number(signedValue[0].replace(/\s/g, ''))
  if (!Number.isFinite(value) || value === 0) {
    return `${baseClassName} text-[var(--terminal-muted)]`
  }

  return value > 0
    ? `${baseClassName} text-[var(--terminal-green-strong)]`
    : `${baseClassName} text-[var(--terminal-red-strong)]`
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
      style={{ filter: 'drop-shadow(0 0 4px rgba(151, 252, 228, 0.5)) drop-shadow(0 0 9px rgba(151, 252, 228, 0.22))' }}
    >
      <path
        d="M144 71.6991C144 119.306 114.866 134.582 99.5156 120.98C86.8804 109.889 83.1211 86.4521 64.116 84.0456C39.9942 81.0113 37.9057 113.133 22.0334 113.133C3.5504 113.133 0 86.2428 0 72.4315C0 58.3063 3.96809 39.0542 19.736 39.0542C38.1146 39.0542 39.1588 66.5722 62.132 65.1073C85.0007 63.5379 85.4184 34.8689 100.247 22.6271C113.195 12.0593 144 23.4641 144 71.6991Z"
        fill="#97FCE4"
      />
    </svg>
  )
}

type MarkerVariant = 'diamond' | 'chevronUp' | 'chevronDown' | 'crosshair' | 'slash' | 'bracket' | 'flipZone'

function MetricMarkerButton({
  color,
  label,
  onToggle,
  variant,
  visible,
}: {
  color: string
  label: string
  onToggle: () => void
  variant: MarkerVariant
  visible: boolean
}) {
  return (
    <button
      aria-label={`${visible ? 'Hide' : 'Show'} ${label} level`}
      aria-pressed={visible}
      className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-[2px] transition-colors hover:bg-[var(--terminal-surface-3)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-border-strong)]"
      type="button"
      onClick={onToggle}
    >
      <MetricMarker color={color} variant={variant} visible={visible} />
    </button>
  )
}

function MetricMarker({ color, variant, visible = true }: { color: string; variant: MarkerVariant; visible?: boolean }) {
  const activeMarkerColor = normalizeMarkerColor(color)
  const markerColor = visible ? activeMarkerColor : 'var(--terminal-subtle)'
  const commonStyle = {
    color: markerColor,
    '--marker-color': markerColor,
    '--marker-glow-color': activeMarkerColor,
    opacity: visible ? 1 : 0.34,
    filter: visible
      ? 'drop-shadow(0 0 4px color-mix(in srgb, var(--marker-glow-color) 52%, transparent)) drop-shadow(0 0 9px color-mix(in srgb, var(--marker-glow-color) 22%, transparent))'
      : 'drop-shadow(0 0 0 color-mix(in srgb, var(--marker-glow-color) 0%, transparent)) drop-shadow(0 0 0 color-mix(in srgb, var(--marker-glow-color) 0%, transparent))',
    transform: visible ? 'scale(1)' : 'scale(0.82)',
    transition: 'color 160ms ease, opacity 170ms ease, filter 320ms ease-out, transform 190ms ease-out',
  } as CSSProperties

  if (variant === 'diamond') {
    return (
      <span
        aria-hidden="true"
        className="flex h-4 w-4 shrink-0 items-center justify-center"
        style={commonStyle}
      >
        <span className="h-2.5 w-2.5 rotate-45 border border-[var(--marker-color)] bg-[color-mix(in_srgb,var(--marker-color)_18%,transparent)]" />
      </span>
    )
  }

  if (variant === 'chevronUp' || variant === 'chevronDown') {
    return (
      <span
        aria-hidden="true"
        className="relative h-4 w-4 shrink-0 text-[var(--marker-color)]"
        style={commonStyle}
      >
        <span
          className={
            variant === 'chevronUp'
              ? 'absolute left-1/2 top-[4px] h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-l-2 border-t-2 border-current'
              : 'absolute left-1/2 top-[1px] h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-b-2 border-r-2 border-current'
          }
        />
      </span>
    )
  }

  if (variant === 'crosshair') {
    return (
      <span aria-hidden="true" className="relative h-4 w-4 shrink-0" style={commonStyle}>
        <span className="absolute left-1/2 top-[2px] h-3 w-px -translate-x-1/2 bg-[var(--marker-color)] opacity-80" />
        <span className="absolute left-[2px] top-1/2 h-px w-3 -translate-y-1/2 bg-[var(--marker-color)] opacity-80" />
        <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-[var(--marker-color)] bg-[var(--terminal-surface)]" />
      </span>
    )
  }

  if (variant === 'slash') {
    return (
      <span aria-hidden="true" className="relative h-4 w-4 shrink-0" style={commonStyle}>
        <span className="absolute left-1/2 top-1/2 h-[2px] w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-[var(--marker-color)]" />
      </span>
    )
  }

  if (variant === 'flipZone') {
    return (
      <span aria-hidden="true" className="relative h-4 w-4 shrink-0" style={commonStyle}>
        <span className="absolute left-[2px] top-[4px] h-2 w-2 rotate-45 border-l-2 border-b-2 border-[var(--marker-color)]" />
        <span className="absolute right-[2px] top-[4px] h-2 w-2 rotate-45 border-r-2 border-t-2 border-[var(--marker-color)] opacity-75" />
      </span>
    )
  }

  return (
    <span aria-hidden="true" className="relative h-4 w-4 shrink-0" style={commonStyle}>
      <span className="absolute left-[3px] top-[4px] h-2.5 w-[3px] rounded-px bg-[var(--marker-color)]" />
      <span className="absolute right-[3px] top-[4px] h-2.5 w-[3px] rounded-px bg-[var(--marker-color)] opacity-60" />
      <span className="absolute left-[5px] top-[4px] h-[3px] w-1.5 bg-[var(--marker-color)] opacity-70" />
    </span>
  )
}

function getLevelMarkerColor(title: string, label: string) {
  const isZeroDte = title.includes('0DTE')
  if (isZeroDte && label.includes('Call')) return levelColors.zeroDteCall
  if (isZeroDte && label.includes('Put')) return levelColors.zeroDtePut
  if (label.includes('Call')) return 'var(--terminal-green-strong)'
  if (label.includes('Put')) return 'var(--terminal-red-strong)'
  if (isZeroDte) return 'var(--terminal-blue)'

  return 'var(--terminal-yellow)'
}

function getLevelVisibilityKey(title: string, label: string): LevelVisibilityKey {
  const isZeroDte = title.includes('0DTE')

  if (isZeroDte) {
    if (label.includes('HVL')) return 'zeroDteHvl'
    if (label.includes('Call')) return 'zeroDteCall'
    if (label.includes('Put')) return 'zeroDtePut'

    return 'zeroDteHvl'
  }

  if (label.includes('HVL')) return 'allExpiryHvl'
  if (label.includes('Call')) return 'allExpiryCallResistance'
  if (label.includes('Put')) return 'allExpiryPutSupport'

  return 'allExpiryHvl'
}

function getAdvancedVisibilityKey(label: string): LevelVisibilityKey {
  if (label.includes('Zero')) return 'advancedZeroGamma'
  if (label.includes('Pain')) return 'advancedMaxPain'
  if (label.includes('Expected')) return 'advancedExpectedMove'

  return 'advancedGammaFlipZones'
}

function normalizeMarkerColor(color: string) {
  if (color === '#42e66f' || color === '#39d85f') return 'var(--terminal-green-strong)'
  if (color === '#ff4b43' || color === '#ff3f37') return 'var(--terminal-red-strong)'
  if (color === '#62b8ff') return 'var(--terminal-blue)'
  if (color === '#f5b946') return 'var(--terminal-yellow)'

  return color
}

function getLevelMarkerVariant(label: string): MarkerVariant {
  if (label.includes('HVL')) return 'diamond'
  if (label.includes('Call')) return 'chevronUp'
  if (label.includes('Put')) return 'chevronDown'

  return 'diamond'
}

function getAdvancedMarkerVariant(label: string): MarkerVariant {
  if (label.includes('Zero')) return 'crosshair'
  if (label.includes('Pain')) return 'slash'
  if (label.includes('Expected')) return 'bracket'

  return 'flipZone'
}

function getAdvancedMarkerColor(metric: TerminalSnapshot['levels']['advanced'][number]) {
  if (metric.label.includes('Zero')) return levelColors.zeroGamma
  if (metric.label.includes('Expected')) return levelColors.expectedMove
  if (metric.label.includes('Gamma Flip')) return levelColors.gammaFlip

  return metric.color
}

function splitExpectedMoveRange(value: string) {
  const rangeSeparator = value.indexOf('-$')

  if (rangeSeparator === -1) return null

  return {
    lower: value.slice(0, rangeSeparator),
    upper: value.slice(rangeSeparator),
  }
}

function getCurrentRankingRow(snapshot: TerminalSnapshot, selection: GexLevelSelection) {
  const rows = selection.scope === 'zeroDte' ? snapshot.rankings.zeroDte : snapshot.rankings.allExpiry

  return rows.find((row) => row.strike === selection.row.strike)
}

function getTopTenOpenInterest(snapshot: TerminalSnapshot, scope: GexLevelSelection['scope']) {
  const rows = scope === 'zeroDte' ? snapshot.rankings.zeroDte : snapshot.rankings.allExpiry

  return rows.reduce((total, row) => total + row.openInterest, 0)
}

function getDisplayExpiryContributions(row: RankingRow, snapshot: TerminalSnapshot): ExpiryContribution[] {
  if (row.expiryContributions.length > 0) {
    return row.expiryContributions
  }

  return [{
    expiry: snapshot.expiry,
    gammaExposureUsd: row.gammaExposureUsd,
    callGammaExposureUsd: row.callGammaExposureUsd,
    putGammaExposureUsd: row.putGammaExposureUsd,
    openInterest: row.openInterest,
    callOpenInterest: row.callOpenInterest,
    putOpenInterest: row.putOpenInterest,
  }]
}

function formatWholePercent(value: number) {
  return `${Math.round(value)}%`
}

function formatExpiryLabel(expiry: ExpiryContribution['expiry']) {
  return expiry === 'ALL' ? 'All' : expiry
}

function formatOpenInterest(value: number) {
  return Math.round(value).toLocaleString('en-US')
}

function getOpenInterestShareTone(share: number): 'green' | 'red' | 'amber' | 'muted' {
  if (share >= 18) return 'green'
  if (share >= 12) return 'amber'

  return 'muted'
}

function GammaRegimeExtension({ snapshot }: { snapshot: TerminalSnapshot }) {
  const context = getRegimeContext(snapshot)
  const score = context.score
  const positive = score >= 0
  const regimeLabel = positive ? 'Long Gamma' : 'Short Gamma'
  const regimeToneClassName = positive ? 'text-[var(--terminal-green-strong)]' : 'text-[var(--terminal-red-strong)]'
  const spotDistanceDirection = context.flipDistance >= 0 ? 'above flip' : 'below flip'

  return (
    <section className="mt-1 border-t border-[var(--terminal-rule)] pt-2.5" aria-label="Gamma regime corridor">
      <div className="grid grid-cols-[1fr_auto] items-start gap-3">
        <div className="min-w-0">
          <PanelGroupTitle title="Gamma Regime" />
          <div className={`mt-1.5 text-[16px] font-semibold uppercase leading-none tracking-normal ${regimeToneClassName}`}>
            {regimeLabel}
          </div>
          <div className="terminal-value mt-1.5 text-[9.5px] text-[var(--terminal-muted)]">
            {formatSignedUsd(context.flipDistance)} / {formatSignedPercent(context.flipDistancePercent)} {spotDistanceDirection}
          </div>
        </div>
        <div className="text-right">
          <div className={`terminal-value text-[16px] font-semibold leading-none ${regimeToneClassName}`}>
            {formatRegimeScore(score)}
          </div>
          <div className="mt-1 text-[8px] font-semibold uppercase text-[var(--terminal-muted)]">
            Score
          </div>
        </div>
      </div>

      <div className="mt-4 px-1">
        <div className="mb-1.5 grid grid-cols-[1fr_auto_1fr] items-end gap-2 text-[8px] font-semibold uppercase text-[var(--terminal-muted)]">
          <span>Short Γ</span>
          <span>Flip</span>
          <span className="text-right">Long Γ</span>
        </div>
        <div className="relative h-[50px]">
          <div className="absolute left-0 right-0 top-4 h-2 overflow-hidden rounded-[2px] border border-[var(--terminal-border-strong)] bg-[var(--terminal-bg-soft)] shadow-[var(--terminal-control-inset)]">
            <div
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-[color-mix(in_srgb,var(--terminal-red-strong)_82%,transparent)] to-[color-mix(in_srgb,var(--terminal-yellow)_78%,transparent)]"
              style={{ width: `${context.flipPosition}%` }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-gradient-to-r from-[color-mix(in_srgb,var(--terminal-yellow)_78%,transparent)] to-[color-mix(in_srgb,var(--terminal-green-strong)_86%,transparent)]"
              style={{ width: `${100 - context.flipPosition}%` }}
            />
          </div>

          <div
            className="absolute top-0.5 h-9 w-px bg-[var(--terminal-yellow)] opacity-80"
            style={{ left: `${context.flipPosition}%` }}
          >
            <span className="absolute left-1/2 top-[34px] h-1.5 w-1.5 -translate-x-1/2 rotate-45 border border-[var(--terminal-yellow)] bg-[var(--terminal-bg-soft)]" />
          </div>
          <div
            className="absolute top-0 h-11 w-px bg-[var(--terminal-heading)] shadow-[0_0_9px_rgba(228,232,223,0.4)]"
            style={{ left: `${context.spotPosition}%` }}
          >
            <span className="absolute left-1/2 top-[-1px] h-2 w-2 -translate-x-1/2 rotate-45 bg-[var(--terminal-heading)]" />
            <span className="absolute left-1/2 top-[45px] -translate-x-1/2 whitespace-nowrap text-[8px] font-semibold uppercase leading-none text-[var(--terminal-heading)]">
              Spot
            </span>
          </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-[var(--terminal-rule)] pt-2 text-[9px]">
        <RegimeMiniStat label="Put Support" value={context.putSupport} tone="red" />
        <RegimeMiniStat label="Gamma Flip" value={context.flipPoint} tone="amber" />
        <RegimeMiniStat label="Call Resist" value={context.callResistance} tone="green" align="right" />
      </div>
    </section>
  )
}

function RegimeMiniStat({
  label,
  value,
  tone,
  align = 'left',
}: {
  label: string
  value: number | undefined
  tone: 'red' | 'amber' | 'green'
  align?: 'left' | 'right'
}) {
  const toneClassName = {
    red: 'text-[var(--terminal-red-strong)]',
    amber: 'text-[var(--terminal-yellow)]',
    green: 'text-[var(--terminal-green-strong)]',
  }[tone]

  return (
    <div className={align === 'right' ? 'text-right' : ''}>
      <div className="mb-1 text-[8px] font-semibold uppercase text-[var(--terminal-muted)]">{label}</div>
      <div className={`terminal-value text-[10.5px] font-semibold ${toneClassName}`}>
        {value === undefined ? 'N/A' : formatUsd(value)}
      </div>
    </div>
  )
}

function ExpiryImpactPanel({ snapshot }: { snapshot: TerminalSnapshot }) {
  const events = snapshot.expiryEvents
  const topEvent = events[0]
  const nextByKind = getNextExpiryEventsByKind(events)
  const leaderboard = events.slice(0, 4)

  if (!topEvent) {
    return (
      <div className="flex min-h-[190px] items-center justify-center text-[10px] text-[var(--terminal-muted)]">
        No expiry data available
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden pr-1" aria-label="Expiry positioning impact">
      <div className="mb-2.5 grid grid-cols-[1fr_auto] items-start gap-3 border-b border-[var(--terminal-rule)] pb-2.5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <ExpiryKindBadge kind={topEvent.kind} />
            <div className="terminal-value truncate text-[16px] font-semibold leading-none text-[var(--terminal-heading)]">
              {topEvent.expiry}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <ExpiryMetric label="Notional" value={formatCompactUsd(topEvent.expiringNotionalUsd)} />
            <ExpiryMetric label="Near Spot" value={formatWholePercent(topEvent.nearSpotOpenInterestSharePercent)} />
            <ExpiryMetric label="Time" value={formatExpiryTime(topEvent)} align="right" />
          </div>
        </div>
        <div className="text-right">
          <div className={`terminal-value text-[18px] font-semibold leading-none ${getImportanceToneClassName(topEvent.importanceScore)}`}>
            {formatImportanceScore(topEvent.importanceScore)}
          </div>
          <div className="mt-1 text-[8.5px] font-semibold uppercase text-[var(--terminal-muted)]">
            Impact
          </div>
        </div>
      </div>

      <div className="mb-2.5 grid grid-cols-3 gap-1.5">
        <ExpiryDriverBar label="Size" value={topEvent.sizeScore} weight="40%" />
        <ExpiryDriverBar label="Pin" value={topEvent.concentrationScore} weight="35%" />
        <ExpiryDriverBar label="Urgency" value={topEvent.urgencyScore} weight="25%" />
      </div>

      <div className="mb-2.5 grid grid-cols-4 gap-1.5">
        {nextByKind.map((event) => (
          <div
            key={event.kind}
            className="min-w-0 border border-[var(--terminal-border)] bg-[var(--terminal-bg-soft)] px-1.5 py-1"
          >
            <div className="mb-1 text-[7.5px] font-semibold uppercase text-[var(--terminal-muted)]">{event.kind}</div>
            <div className="terminal-value truncate text-[9.5px] text-[var(--terminal-heading)]">{event.expiry}</div>
            <div className={`terminal-value mt-1 text-[9.5px] ${getImportanceToneClassName(event.importanceScore)}`}>
              {formatImportanceScore(event.importanceScore)}
            </div>
          </div>
        ))}
      </div>

      <div className="mb-1.5 grid gap-1">
        <div className="grid grid-cols-[52px_1fr_52px_42px] px-1 text-[8px] font-semibold uppercase text-[var(--terminal-muted)]">
          <span>Expiry</span>
          <span>Drivers</span>
          <span className="text-right">Share</span>
          <span className="text-right">Score</span>
        </div>
        {leaderboard.map((event) => (
          <div
            key={event.expiry}
            className="grid grid-cols-[52px_1fr_52px_42px] items-center gap-2 border-t border-[var(--terminal-rule)] px-1 py-1 text-[9px]"
          >
            <div className="min-w-0">
              <div className="terminal-value truncate text-[var(--terminal-heading)]">{event.expiry}</div>
              <div className="mt-0.5 text-[7.5px] uppercase text-[var(--terminal-muted)]">{event.kind}</div>
            </div>
            <div className="min-w-0">
              <ExpiryCompositeBar event={event} />
              <div className="mt-1 truncate text-[8px] text-[var(--terminal-muted)]">
                {event.topStrikes.slice(0, 2).map((strike) => `$${formatStrike(strike.strike)}`).join(' / ')}
              </div>
            </div>
            <div className="terminal-value text-right text-[9px] text-[var(--terminal-text)]">
              {formatWholePercent(event.openInterestSharePercent)}
            </div>
            <div className={`terminal-value text-right text-[10px] font-semibold ${getImportanceToneClassName(event.importanceScore)}`}>
              {formatImportanceScore(event.importanceScore)}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 border-t border-[var(--terminal-rule)] pt-1.5">
        <div className="mb-1.5 grid grid-cols-[1fr_auto_auto] gap-2 px-1 text-[8px] font-semibold uppercase text-[var(--terminal-muted)]">
          <span>Top Strikes</span>
          <span>OI</span>
          <span>Dist</span>
        </div>
        {topEvent.topStrikes.slice(0, 3).map((strike) => (
          <div
            key={`${topEvent.expiry}-${strike.strike}`}
            className="grid grid-cols-[1fr_44px_44px] items-center gap-2 px-1 py-0.5 text-[9px]"
          >
            <div className="min-w-0">
              <div className="terminal-value text-[var(--terminal-heading)]">${formatStrike(strike.strike)}</div>
              <div className={strike.gammaExposureUsd >= 0 ? 'terminal-value mt-0.5 text-[8px] text-[var(--terminal-green-strong)]' : 'terminal-value mt-0.5 text-[8px] text-[var(--terminal-red-strong)]'}>
                {formatMillions(strike.gammaExposureUsd)}
              </div>
            </div>
            <div className="terminal-value text-right text-[9px] text-[var(--terminal-text)]">
              {formatWholePercent(strike.openInterestSharePercent)}
            </div>
            <div className={getSpotDistanceColor(strike.distanceFromSpotPercent)}>
              <div className="terminal-value text-right text-[9px]">
                {formatSignedPercent(strike.distanceFromSpotPercent)}
              </div>
            </div>
          </div>
        ))}
      </div>

      <ExpiryRegimeChangeStrip event={topEvent} />
    </div>
  )
}

function ExpiryRegimeChangeStrip({ event }: { event: ExpiryPositioningEvent }) {
  const pinRisk = getExpiryRiskLabel(event.concentrationScore, [18, 10])
  const resetRisk = getExpiryRiskLabel(event.importanceScore, [66, 48])
  const compression = getExpiryRiskLabel(event.urgencyScore, [86, 62])

  return (
    <div className="mt-auto border-t border-[var(--terminal-rule)] pt-1.5">
      <div className="mb-1.5 text-[8px] font-semibold uppercase text-[var(--terminal-muted)]">
        Positioning Read
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <ExpiryReadout label="Pin Risk" value={pinRisk} tone={pinRisk} />
        <ExpiryReadout label="Post Expiry" value={resetRisk} tone={resetRisk} />
        <ExpiryReadout label="Compression" value={compression} tone={compression} />
      </div>
    </div>
  )
}

function ExpiryReadout({
  label,
  value,
  tone,
}: {
  label: string
  value: 'High' | 'Med' | 'Low'
  tone: 'High' | 'Med' | 'Low'
}) {
  const toneClassName = {
    High: 'text-[var(--terminal-red-strong)]',
    Med: 'text-[var(--terminal-yellow)]',
    Low: 'text-[var(--terminal-muted)]',
  }[tone]

  return (
    <div className="min-w-0 border border-[var(--terminal-border)] bg-[var(--terminal-bg-soft)] px-1.5 py-1">
      <div className="mb-1 truncate text-[7.5px] font-semibold uppercase text-[var(--terminal-muted)]">{label}</div>
      <div className={`terminal-value text-[10px] font-semibold ${toneClassName}`}>{value}</div>
    </div>
  )
}

function ExpiryMetric({
  label,
  value,
  align = 'left',
}: {
  label: string
  value: string
  align?: 'left' | 'right'
}) {
  return (
    <div className={align === 'right' ? 'text-right' : ''}>
      <div className="mb-1 text-[7.5px] font-semibold uppercase text-[var(--terminal-muted)]">{label}</div>
      <div className="terminal-value text-[9.5px] font-semibold text-[var(--terminal-heading)]">{value}</div>
    </div>
  )
}

function ExpiryDriverBar({ label, value, weight }: { label: string; value: number; weight: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-1 text-[7.5px] font-semibold uppercase text-[var(--terminal-muted)]">
        <span>{label}</span>
        <span>{weight}</span>
      </div>
      <div className="h-1.5 border border-[var(--terminal-border)] bg-[var(--terminal-bg-soft)]">
        <div
          className="h-full bg-[var(--terminal-blue)]"
          style={{ width: `${clamp(value, 0, 100)}%` }}
        />
      </div>
    </div>
  )
}

function ExpiryCompositeBar({ event }: { event: ExpiryPositioningEvent }) {
  const sizeWidth = clamp(event.sizeScore * 0.4, 0, 40)
  const pinWidth = clamp(event.concentrationScore * 0.35, 0, 35)
  const urgencyWidth = clamp(event.urgencyScore * 0.25, 0, 25)

  return (
    <div className="flex h-1.5 overflow-hidden border border-[var(--terminal-border)] bg-[var(--terminal-bg-soft)]">
      <span className="h-full bg-[var(--terminal-blue)]" style={{ width: `${sizeWidth}%` }} />
      <span className="h-full bg-[var(--terminal-yellow)]" style={{ width: `${pinWidth}%` }} />
      <span className="h-full bg-[var(--terminal-green-strong)]" style={{ width: `${urgencyWidth}%` }} />
    </div>
  )
}

function ExpiryKindBadge({ kind }: { kind: ExpiryKind }) {
  return (
    <span className={`shrink-0 border px-1.5 py-0.5 text-[7.5px] font-semibold uppercase leading-none ${getExpiryKindBadgeClassName(kind)}`}>
      {kind}
    </span>
  )
}

function getNextExpiryEventsByKind(events: ExpiryPositioningEvent[]) {
  const kinds: ExpiryKind[] = ['daily', 'weekly', 'monthly', 'quarterly']

  return kinds
    .map((kind) => events
      .filter((event) => event.kind === kind)
      .sort((a, b) => a.daysToExpiry - b.daysToExpiry)[0])
    .filter((event): event is ExpiryPositioningEvent => Boolean(event))
}

function getExpiryKindBadgeClassName(kind: ExpiryKind) {
  if (kind === 'quarterly') {
    return 'border-[var(--terminal-yellow)] text-[var(--terminal-yellow)] bg-[color-mix(in_srgb,var(--terminal-yellow)_10%,transparent)]'
  }

  if (kind === 'monthly') {
    return 'border-[var(--terminal-blue)] text-[var(--terminal-blue)] bg-[color-mix(in_srgb,var(--terminal-blue)_10%,transparent)]'
  }

  if (kind === 'weekly') {
    return 'border-[var(--terminal-green)] text-[var(--terminal-green-strong)] bg-[var(--terminal-green-soft)]'
  }

  return 'border-[var(--terminal-border-strong)] text-[var(--terminal-muted)] bg-[var(--terminal-bg-soft)]'
}

function getImportanceToneClassName(score: number) {
  if (score >= 70) return 'text-[var(--terminal-red-strong)]'
  if (score >= 52) return 'text-[var(--terminal-yellow)]'
  if (score >= 36) return 'text-[var(--terminal-green-strong)]'

  return 'text-[var(--terminal-muted)]'
}

function getExpiryRiskLabel(value: number, thresholds: [number, number]): 'High' | 'Med' | 'Low' {
  if (value >= thresholds[0]) return 'High'
  if (value >= thresholds[1]) return 'Med'

  return 'Low'
}

function formatImportanceScore(score: number) {
  return Math.round(score).toString()
}

function formatExpiryTime(event: ExpiryPositioningEvent) {
  if (event.hoursToExpiry < 36) {
    return `${Math.max(1, Math.round(event.hoursToExpiry))}h`
  }

  return `${event.daysToExpiry < 10 ? event.daysToExpiry.toFixed(1) : Math.round(event.daysToExpiry)}d`
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

function getRegimeContext(snapshot: TerminalSnapshot) {
  const score = getRegimeScore(snapshot)
  const flipPoint = getAdvancedLevelValue(snapshot, 'Gamma Flip Zones') ?? getAdvancedLevelValue(snapshot, 'Zero Gamma')
  const putSupport = getLevelStrike(snapshot, 'Put Support')
  const callResistance = getLevelStrike(snapshot, 'Call Resistance')
  const corridorValues = [putSupport, flipPoint, callResistance, snapshot.spot].filter((value): value is number => value !== undefined)
  const corridorMin = corridorValues.length > 0 ? Math.min(...corridorValues) : snapshot.spot
  const corridorMax = corridorValues.length > 0 ? Math.max(...corridorValues) : snapshot.spot
  const corridorRange = corridorMax - corridorMin
  const positionFor = (value: number | undefined) => {
    if (value === undefined || corridorRange === 0) return 50

    return clamp(((value - corridorMin) / corridorRange) * 100, 0, 100)
  }
  const fallbackFlipPoint = flipPoint ?? snapshot.spot
  const flipDistance = snapshot.spot - fallbackFlipPoint
  const flipDistancePercent = fallbackFlipPoint === 0 ? 0 : (flipDistance / fallbackFlipPoint) * 100

  return {
    score,
    flipPoint,
    putSupport,
    callResistance,
    flipDistance,
    flipDistancePercent,
    flipPosition: positionFor(flipPoint),
    spotPosition: positionFor(snapshot.spot),
  }
}

function getRegimeScore(snapshot: TerminalSnapshot) {
  const flipPoint = getAdvancedLevelValue(snapshot, 'Gamma Flip Zones') ?? getAdvancedLevelValue(snapshot, 'Zero Gamma')
  const maxVolatility = getLevelStrike(snapshot, 'Put Support')
  const maxStability = getLevelStrike(snapshot, 'Call Resistance')

  if (flipPoint === undefined || maxVolatility === undefined || maxStability === undefined) {
    return 0
  }

  const regimeRange = Math.abs(maxStability - maxVolatility)
  if (regimeRange === 0) return 0

  return clamp((snapshot.spot - flipPoint) / regimeRange, -1, 1)
}

function getAdvancedLevelValue(snapshot: TerminalSnapshot, label: string) {
  const metric = snapshot.levels.advanced.find((item) => item.label === label)
  if (!metric) return undefined

  const parsed = Number(metric.value.replace(/[^\d.-]/g, ''))

  return Number.isFinite(parsed) ? parsed : undefined
}

function getLevelStrike(snapshot: TerminalSnapshot, label: string) {
  return snapshot.levels.allExpiry.find((item) => item.label === label)?.strike
}

function formatRegimeScore(score: number) {
  return `${score >= 0 ? '+' : ''}${score.toFixed(2)}`
}

function formatSignedUsd(value: number) {
  const sign = value >= 0 ? '+' : '-'

  return `${sign}${formatUsd(Math.abs(value))}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
