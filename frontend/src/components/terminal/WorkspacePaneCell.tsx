import { useMemo, useRef } from 'react'
import {
  ChartExpirySelect,
  ChartPaneActions,
  ChartPaneHeader,
  ChartSegmentButton,
  ChartSegmentGroup,
  PaneDragHandle,
} from '@/components/terminal/ChartPaneHeader'
import { EmptyPanelSlot, type PanelFillOption } from '@/components/terminal/EmptyPanelSlot'
import { GammaHeatmapChart } from '@/components/terminal/GammaHeatmapChart'
import { GexProfileChart } from '@/components/terminal/GexProfileChart'
import { PanelCloseButton } from '@/components/terminal/PanelCloseButton'
import type { PaneDragHandleProps } from '@/components/terminal/PaneWorkspace'
import { RankingTable } from '@/components/terminal/RankingTable'
import {
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
import { cn } from '@/lib/utils'

/** (strike − spot) / spot × 100 — same convention as Levels / rankings. */
function percentFromSpot(strike: number, spot: number): number {
  if (!(spot > 0) || !Number.isFinite(strike)) return 0
  return ((strike - spot) / spot) * 100
}

const defaultAutoDataWindowPct = 25
const lowerChartMinHeight = 100

/** Unified view switcher — chart modes + rankings table. */
type PaneViewId = GexModeOption | 'table'

const paneViewOptions: Array<{ id: PaneViewId; label: string }> = [
  ...gexModes.map((mode) => ({ id: mode as PaneViewId, label: gexModeLabels[mode] })),
  { id: 'table', label: 'Table' },
]

/** Compact labels when the pane header is tight (split layouts). */
const paneViewShortLabels: Record<PaneViewId, string> = {
  net: 'Strike',
  heatmap: 'Bands',
  table: 'Tbl',
}

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

  const effectiveExpiry = isKnownExpiry(cell.expiry, expiryOptions.map((o) => o.value))
    ? cell.expiry
    : 'ALL'
  const { data: paneSnapshot } = useTerminalSnapshot(effectiveExpiry)
  const snapshot = paneSnapshot ?? primarySnapshot
  // NET GEX strike/profile spot line: live Deribit index (fallback: GEX spot).
  // Bar heights remain snapshot gammaBars — not revalued at live index.
  // Reference (Max Pain / Expected Move) feeds bands-chart strike overlay lines.
  const gexChartSnapshot = useMemo(
    () => ({
      spot: getDisplaySpot(snapshot),
      gammaBars: snapshot.gammaBars,
      reference: snapshot.levels.reference,
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
    ? 'table'
    : (normalizeExposureMode(cell.mode) as ExposureMode)

  const handleViewChange = (view: PaneViewId) => {
    if (view === 'table') {
      onCellChange({ open: true, kind: 'table' })
      return
    }
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
    onCellChange({
      open: true,
      kind: 'chart',
      mode: view,
    })
  }

  const viewSegments = (
    <ChartSegmentGroup label="Panel view">
      {paneViewOptions.map((option) => (
        <ChartSegmentButton
          key={option.id}
          active={activeView === option.id}
          shortLabel={paneViewShortLabels[option.id]}
          onClick={() => handleViewChange(option.id)}
        >
          {option.label}
        </ChartSegmentButton>
      ))}
    </ChartSegmentGroup>
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
          left={viewSegments}
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
  const dataWindow =
    cell.dataWindowMode === 'full' ? defaultAutoDataWindowPct : cell.dataWindowPct

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
          headerLeft={viewSegments}
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
            title={getGexChartTitle(mode)}
            left={viewSegments}
            right={headerRight}
          />
        )}
        minHeight={lowerChartMinHeight}
      />
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
