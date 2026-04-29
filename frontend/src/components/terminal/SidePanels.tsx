import type { CSSProperties, ReactNode } from 'react'
import type { TerminalSnapshot } from '@/data/mockTerminal'
import { formatSignedPercent, formatStrike, formatUsd } from '@/lib/formatters'
import { useTerminalStore, type LevelVisibilityKey } from '@/store/terminalStore'
import { getSpotDistanceColor, levelColors } from '@/data/levelColors'

type SidePanelsProps = {
  snapshot: TerminalSnapshot
}

const spotProximityThresholdPercent = 0.5
const lotusPatternThresholdPercent = 0.25
const lotusSignatureThresholdPercent = 0.1

export function SidePanels({ snapshot }: SidePanelsProps) {
  const levelVisibility = useTerminalStore((state) => state.levelVisibility)
  const setLevelVisibility = useTerminalStore((state) => state.setLevelVisibility)
  const signatureRowId = getSignatureLevelRowId(snapshot)

  return (
    <aside className="terminal-panel terminal-rail grid h-full grid-rows-[auto_auto_minmax(0,1fr)] content-stretch items-stretch">
      <RailSection
        title="Price Sources"
      >
        <div className="grid gap-0">
          {snapshot.marketSources.map((source) => (
            <div
              key={source.name}
              className="grid grid-cols-[1fr_auto] items-center gap-4 px-1 py-2 text-[11px] transition-colors hover:bg-[var(--terminal-surface-2)]"
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
        title="Levels"
        action={<CopyLevelsButton />}
      >
        <div className="grid gap-2">
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
        </div>
      </RailSection>

      <GammaRegimePanel snapshot={snapshot} />
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
  title: string
  action?: ReactNode
  className?: string
  children: ReactNode
}

function RailSection({ title, action, className, children }: RailSectionProps) {
  return (
    <section className={`terminal-rail-section ${className ?? ''}`}>
      <div className="terminal-section-header">
        <h2 className="terminal-title whitespace-nowrap">{title}</h2>
        {action ? <div className="terminal-section-action">{action}</div> : null}
      </div>
      {children}
    </section>
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
  const markerColor = visible ? normalizeMarkerColor(color) : 'var(--terminal-subtle)'
  const commonStyle = {
    color: markerColor,
    '--marker-color': markerColor,
    opacity: visible ? 1 : 0.58,
    filter: visible ? 'drop-shadow(0 0 4px color-mix(in srgb, var(--marker-color) 52%, transparent)) drop-shadow(0 0 9px color-mix(in srgb, var(--marker-color) 22%, transparent))' : undefined,
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

function GammaRegimePanel({ snapshot }: SidePanelsProps) {
  const score = getRegimeScore(snapshot)
  const pointerAngle = scoreToAngle(score)
  const meter = { cx: 180, cy: 105, radius: 90, needleRadius: 78 }
  const pointerTip = polarPoint(meter.cx, meter.cy, meter.needleRadius, pointerAngle)
  const needleLeft = polarPoint(meter.cx, meter.cy, 5.5, pointerAngle - 92)
  const needleRight = polarPoint(meter.cx, meter.cy, 5.5, pointerAngle + 92)
  const needleTail = polarPoint(meter.cx, meter.cy, 13, pointerAngle + 180)
  const positive = score >= 0

  return (
    <RailSection title="Gamma Regime" className="flex min-h-0 flex-col pb-2">
      <div className="flex min-h-0 flex-1 items-center">
      <svg viewBox="0 0 360 206" className="block h-full min-h-[190px] w-full" role="img" aria-label="Gamma regime score">
        <defs>
          <linearGradient id="meter-green-segment" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#5f7f51" />
            <stop offset="100%" stopColor="var(--terminal-green-strong)" />
          </linearGradient>
          <linearGradient id="meter-red-segment" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--terminal-red-strong)" />
            <stop offset="100%" stopColor="#7a3035" />
          </linearGradient>
          <radialGradient id="meter-hub-gradient" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#e4e8df" />
            <stop offset="46%" stopColor="var(--terminal-muted)" />
            <stop offset="100%" stopColor="var(--terminal-bg-soft)" />
          </radialGradient>
        </defs>

        <path
          d={describeArc(meter.cx, meter.cy, meter.radius, 180, 360)}
          fill="none"
          stroke="var(--terminal-surface-3)"
          strokeWidth="24"
          strokeLinecap="round"
        />
        {Array.from({ length: 42 }, (_, index) => {
          const start = 183 + index * 4.2
          const end = start + 2.8
          const normalized = (start + end) / 2
          const stroke = normalized < 270 ? 'url(#meter-red-segment)' : 'url(#meter-green-segment)'

          return (
            <path
              key={start}
              d={describeArc(meter.cx, meter.cy, meter.radius, start, end)}
              fill="none"
              stroke={stroke}
              strokeWidth="18"
              strokeLinecap="butt"
              strokeOpacity="0.9"
            />
          )
        })}
        <path
          d={describeArc(meter.cx, meter.cy, meter.radius - 15, 180, 360)}
          fill="none"
          stroke="var(--terminal-border-strong)"
          strokeWidth="3"
          strokeOpacity="0.5"
          strokeLinecap="round"
        />
        {Array.from({ length: 41 }, (_, index) => -1 + index * 0.05).map((tick) => {
          const angle = scoreToAngle(tick)
          const isMajor = Math.abs(Math.round(tick * 20)) % 10 === 0
          const isMid = Math.abs(Math.round(tick * 20)) % 5 === 0
          const outer = polarPoint(meter.cx, meter.cy, meter.radius + (isMajor ? 18 : isMid ? 15 : 12), angle)
          const inner = polarPoint(meter.cx, meter.cy, meter.radius + 5, angle)

          return (
            <line
              key={tick}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke={tick === 0 ? 'var(--terminal-text)' : 'var(--terminal-muted)'}
              strokeOpacity={tick === 0 ? 0.72 : isMajor ? 0.45 : isMid ? 0.3 : 0.16}
              strokeWidth={tick === 0 ? 1.8 : isMajor ? 1.1 : 0.65}
            />
          )
        })}

        <polygon
          points={`${pointerTip.x},${pointerTip.y} ${needleRight.x},${needleRight.y} ${needleTail.x},${needleTail.y} ${needleLeft.x},${needleLeft.y}`}
          fill={positive ? 'var(--terminal-heading)' : 'var(--terminal-red-strong)'}
          fillOpacity="0.9"
        />
        <line
          x1={meter.cx}
          y1={meter.cy}
          x2={pointerTip.x}
          y2={pointerTip.y}
          stroke="rgba(255,255,255,0.42)"
          strokeWidth="0.8"
        />
        <circle cx={meter.cx} cy={meter.cy} r="10" fill="var(--terminal-bg-soft)" stroke="var(--terminal-border-strong)" strokeWidth="1.4" />
        <circle cx={meter.cx} cy={meter.cy} r="4.6" fill="url(#meter-hub-gradient)" />

        <text x="44" y="112" textAnchor="middle" fill="var(--terminal-text)" fontSize="12">
          -1
        </text>
        <text x="316" y="112" textAnchor="middle" fill="var(--terminal-text)" fontSize="12">
          +1
        </text>
        <text x="180" y="22" textAnchor="middle" fill="var(--terminal-text)" fontSize="11">
          0
        </text>
        <text x="180" y="166" textAnchor="middle" fill={positive ? 'var(--terminal-green-strong)' : 'var(--terminal-red-strong)'} fontSize="22" fontWeight="700">
          {formatRegimeScore(score)}
        </text>
        <text x="180" y="186" textAnchor="middle" fill={positive ? 'var(--terminal-green-strong)' : 'var(--terminal-red-strong)'} fontSize="11" letterSpacing="1.5">
          {positive ? 'LONG GAMMA' : 'SHORT GAMMA'}
        </text>
      </svg>
      </div>
    </RailSection>
  )
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

function scoreToAngle(score: number) {
  return 180 + ((score + 1) / 2) * 180
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function polarPoint(cx: number, cy: number, radius: number, angle: number) {
  const radians = (angle * Math.PI) / 180

  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  }
}

function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number) {
  const start = polarPoint(cx, cy, radius, startAngle)
  const end = polarPoint(cx, cy, radius, endAngle)
  const largeArcFlag = Math.abs(endAngle - startAngle) <= 180 ? 0 : 1

  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`
}
