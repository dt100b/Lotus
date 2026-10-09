import { useMemo, useRef, useState } from 'react'
import {
  ChartExpirySelect,
  ChartPaneActions,
  ChartPaneHeader,
  ChartViewSelect,
  PaneDragHandle,
} from '@/components/terminal/ChartPaneHeader'
import { EmptyPanelSlot, type PanelFillOption } from '@/components/terminal/EmptyPanelSlot'
import { ForwardGammaSurfaceChart } from '@/components/terminal/ForwardGammaSurfaceChart'
import { GammaHeatmapChart } from '@/components/terminal/GammaHeatmapChart'
import { GexProfileChart } from '@/components/terminal/GexProfileChart'
import { PanelCloseButton } from '@/components/terminal/PanelCloseButton'
import type { PaneDragHandleProps } from '@/components/terminal/PaneWorkspace'
import { RankingTable } from '@/components/terminal/RankingTable'
import {
  defaultForwardDataWindowPct,
  defaultHeatmapDataWindowPct,
  getGexChartTitle,
  gexModeLabels,
  gexModes,
  normalizeExposureMode,
  type ChartRenderMode,
  type GexModeOption,
} from '@/components/terminal/gexModes'
import type { PaneCellState } from '@/components/terminal/paneModel'
import type { GexExpiry } from '@/api/mockGexData'
import { useTerminalSnapshot } from '@/hooks/useTerminalSnapshot'
import type { ExposureMode } from '@/store/terminalStore'
import { getDisplaySpot, type RankingRow, type TerminalSnapshot } from '@/data/mockTerminal'
import {
  defaultGexStrikeSettings,
  type GexStrikeMetric,
  type GexStrikeSettings,
} from '@/data/gexStrikeSettings'
import { defaultForwardPaletteIds } from '@/data/forwardGreekPalettes'
import { cn } from '@/lib/utils'

/** (strike − spot) / spot × 100 — same convention as Levels / rankings. */
function percentFromSpot(strike: number, spot: number): number {
  if (!(spot > 0) || !Number.isFinite(strike)) return 0
  return ((strike - spot) / spot) * 100
}

const defaultAutoDataWindowPct = 25
const lowerChartMinHeight = 100

/** Unified chart view switcher. Rankings are no longer a selectable pane. */
type PaneViewId = GexModeOption

const paneViewOptions: Array<{ id: PaneViewId; label: string }> = [
  ...gexModes.map((mode) => ({ id: mode as PaneViewId, label: gexModeLabels[mode] })),
]

type WorkspacePaneCellProps = {
  row: number
  col: number
  cell: PaneCellState
  primarySnapshot: TerminalSnapshot
  frontExpiry: GexExpiry
  expiryOptions: Array<{ value: GexExpiry; label: string; shortLabel?: string }>
  onCellChange: (patch: Partial<PaneCellState>) => void
  onClose: () => void
  onRemove: () => void
  onFill: (option: PanelFillOption) => void
  dragHandleProps?: PaneDragHandleProps
  isDropTarget?: boolean
  isDragging?: boolean
}

export function WorkspacePaneCell({
  row,
  col,
  cell,
  primarySnapshot,
  frontExpiry: _frontExpiry,
  expiryOptions,
  onCellChange,
  onClose,
  onRemove,
  onFill,
  dragHandleProps,
  isDropTarget = false,
  isDragging = false,
}: WorkspacePaneCellProps) {
  void _frontExpiry
  const rootRef = useRef<HTMLDivElement>(null)
  const [strikeSettingsOpen, setStrikeSettingsOpen] = useState(false)
  const [strikeSettings, setStrikeSettings] = useState<GexStrikeSettings>(defaultGexStrikeSettings)

  const effectiveExpiry = isKnownExpiry(cell.expiry, expiryOptions.map((o) => o.value))
    ? cell.expiry
    : 'ALL'
  const { data: paneSnapshot } = useTerminalSnapshot(effectiveExpiry)
  const snapshot = paneSnapshot ?? primarySnapshot
  // NET GEX strike/profile spot line: live Deribit index (fallback: GEX spot).
  // Bar heights remain snapshot gammaBars — not revalued at live index.
  // Reference (Max Pain / Expected Move / Flip) feeds bands-chart overlay lines.
  const gexChartSnapshot = useMemo(
    () => ({
      spot: getDisplaySpot(snapshot),
      gammaBars: snapshot.gammaBars,
      reference: snapshot.levels.reference,
      gammaFlip: snapshot.gammaFlip,
      gammaFlipStatus: snapshot.gammaFlipStatus,
    }),
    [snapshot],
  )

  const shellClass = cn(
    'h-full min-h-0 min-w-0',
    isDragging && 'opacity-45',
    isDropTarget && 'ring-1 ring-inset ring-[var(--terminal-active-border)]',
  )

  if (!cell.open) {
    return (
      <div ref={rootRef} className={shellClass}>
        <EmptyPanelSlot
          onFill={onFill}
          onRemove={onRemove}
          dragHandleProps={dragHandleProps}
        />
      </div>
    )
  }

  const activeView: PaneViewId = cell.kind === 'table'
    ? 'net'
    : (normalizeExposureMode(cell.mode) as ExposureMode)

  const handleViewChange = (view: PaneViewId) => {
    if (view === 'heatmap') {
      onCellChange({
        open: true,
        kind: 'chart',
        mode: 'heatmap',
        dataWindowMode: 'percent',
        dataWindowPct: defaultHeatmapDataWindowPct,
      })
      return
    }
    if (view === 'forward') {
      onCellChange({
        open: true,
        kind: 'chart',
        mode: 'forward',
        forwardExpiryScope: '0dte',
        forwardMetric: 'gamma',
        dataWindowMode: 'percent',
        dataWindowPct: defaultForwardDataWindowPct,
      })
      return
    }
    onCellChange({
      open: true,
      kind: 'chart',
      mode: view,
      dataWindowMode: 'full',
    })
  }

  const viewControl = (
    <ChartViewSelect
      value={activeView}
      options={paneViewOptions}
      onValueChange={handleViewChange}
    />
  )

  const headerRight = (
    <>
      {expiryOptions.length > 0 ? (
        <ChartExpirySelect
          expiry={effectiveExpiry}
          expiryOptions={expiryOptions}
          onExpiryChange={(expiry) => onCellChange({ expiry })}
        />
      ) : null}
      <ChartPaneActions dragHandleProps={dragHandleProps} onClose={onClose} />
    </>
  )

  if (cell.kind === 'table') {
    return (
      <div ref={rootRef} className={cn(shellClass, 'terminal-frame flex flex-col overflow-hidden')}>
        <ChartPaneHeader
          title="RANKINGS"
          left={viewControl}
          right={headerRight}
        />
        <div className="min-h-0 flex-1 overflow-hidden px-1.5 pb-1.5 pt-1">
          <RankingPane
            scope={`pane-${row}-${col}`}
            snapshot={snapshot}
            expiry={effectiveExpiry}
          />
        </div>
      </div>
    )
  }

  const mode = normalizeExposureMode(cell.mode) as ExposureMode
  // Strike is a virtualized full-surface ladder. Percentage windows remain a
  // camera/data control for Price and Surface modes only.
  const dataWindow = mode === 'net'
    ? 'full'
    : cell.dataWindowMode === 'full'
      ? defaultAutoDataWindowPct
      : cell.dataWindowPct

  const handleDataWindowPctChange = (pct: number) => {
    onCellChange({ dataWindowMode: 'percent', dataWindowPct: pct })
  }

  if (mode === 'heatmap') {
    return (
      <div ref={rootRef} className={cn(shellClass, 'terminal-frame overflow-hidden')}>
        <GammaHeatmapChart
          snapshot={gexChartSnapshot}
          dataWindowPct={dataWindow}
          expiry={effectiveExpiry}
          expiryOptions={expiryOptions}
          onExpiryChange={(next) => onCellChange({ expiry: next })}
          headerLeft={viewControl}
          dragHandleProps={dragHandleProps}
          onClose={onClose}
          minHeight={lowerChartMinHeight}
        />
      </div>
    )
  }

  if (mode === 'forward') {
    return (
      <div ref={rootRef} className={cn(shellClass, 'terminal-frame overflow-hidden')}>
        <ForwardGammaSurfaceChart
          snapshot={gexChartSnapshot}
          dataWindowPct={dataWindow}
          metric={cell.forwardMetric ?? 'gamma'}
          onMetricChange={(next) => onCellChange({ forwardMetric: next })}
          expiryScope={cell.forwardExpiryScope ?? '0dte'}
          onExpiryScopeChange={(next) => onCellChange({ forwardExpiryScope: next })}
          headerLeft={viewControl}
          dragHandleProps={dragHandleProps}
          onClose={onClose}
          minHeight={lowerChartMinHeight}
        />
      </div>
    )
  }

  return (
    <div ref={rootRef} className={cn(shellClass, 'terminal-frame overflow-hidden')}>
      <GexProfileChart
        snapshot={gexChartSnapshot}
        mode={mode as ChartRenderMode}
        dataWindowPct={dataWindow}
        onDataWindowPctChange={handleDataWindowPctChange}
        header={(
          <ChartPaneHeader
            title={strikeSettings.metric === 'delta' ? 'DEX Strike' : getGexChartTitle(mode)}
            left={viewControl}
            right={headerRight}
            toolbar={(
              <StrikeHeaderToolbar
                metric={strikeSettings.metric}
                onMetricChange={(metric) => setStrikeSettings((current) => ({
                  ...current,
                  metric,
                  paletteId: defaultForwardPaletteIds[metric],
                }))}
                settingsOpen={strikeSettingsOpen}
                onSettingsOpenChange={setStrikeSettingsOpen}
              />
            )}
          />
        )}
        minHeight={lowerChartMinHeight}
        strikeSettings={strikeSettings}
        strikeSettingsOpen={strikeSettingsOpen}
        onStrikeSettingsChange={setStrikeSettings}
        strikeSeriesKey={String(effectiveExpiry)}
      />
    </div>
  )
}

function StrikeHeaderToolbar({
  metric,
  onMetricChange,
  settingsOpen,
  onSettingsOpenChange,
}: {
  metric: GexStrikeMetric
  onMetricChange: (metric: GexStrikeMetric) => void
  settingsOpen: boolean
  onSettingsOpenChange: (open: boolean) => void
}) {
  return (
    <div className="forward-surface-controls__primary gex-strike-header__toolbar">
      <span className="forward-surface-controls__eyebrow">Greek</span>
      <div className="forward-surface-segments" role="group" aria-label="Strike metric">
        {([
          { value: 'gamma', label: 'Gamma' },
          { value: 'delta', label: 'Delta' },
        ] as const).map((option) => (
          <button
            key={option.value}
            type="button"
            className={cn(
              'forward-surface-segment gex-strike-header__metric',
              metric === option.value && 'forward-surface-segment--active',
            )}
            aria-pressed={metric === option.value}
            onClick={() => onMetricChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={cn(
          'forward-surface-settings-btn',
          settingsOpen && 'forward-surface-settings-btn--active',
        )}
        aria-expanded={settingsOpen}
        onClick={() => onSettingsOpenChange(!settingsOpen)}
      >
        Settings <span aria-hidden>{settingsOpen ? '−' : '+'}</span>
      </button>
    </div>
  )
}

function RankingPane({
  scope,
  snapshot,
  expiry,
}: {
  scope: string
  snapshot: TerminalSnapshot
  expiry: GexExpiry
}) {
  const rows = getRankingRows(snapshot, expiry)
  // Header lives in ChartPaneHeader — body only, no nested Panel chrome.
  return (
    <RankingTable
      title=""
      scope={scope}
      rows={rows}
      className="ranking-table--embedded border-0 bg-transparent shadow-none"
    />
  )
}

function isKnownExpiry(expiry: GexExpiry, listed: GexExpiry[]) {
  return expiry === 'ALL' || listed.includes(expiry)
}

function getRankingRows(snapshot: TerminalSnapshot, expiry: GexExpiry): RankingRow[] {
  let rows: RankingRow[]
  if (expiry === 'ALL') {
    rows = snapshot.rankings.allExpiry
  } else if (snapshot.rankings.selectedExpiry.length > 0) {
    rows = snapshot.rankings.selectedExpiry
  } else {
    rows = snapshot.rankings.zeroDte
  }

  const displaySpot = getDisplaySpot(snapshot)
  return rows.map((row) => ({
    ...row,
    distanceFromSpotPercent: percentFromSpot(row.strike, displaySpot),
  }))
}

// Re-export for EmptyPanelSlot drag handle usage consistency
export { PaneDragHandle, PanelCloseButton }
