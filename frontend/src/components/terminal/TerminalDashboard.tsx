import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PanelFillOption } from '@/components/terminal/EmptyPanelSlot'
import { defaultHeatmapDataWindowPct } from '@/components/terminal/gexModes'
import {
  addBlankPanel,
  createDefaultWorkspace,
  maxWorkspacePanels,
  removePanel,
  updateCell,
  type WorkspaceLayout,
} from '@/components/terminal/paneModel'
import { PaneWorkspace } from '@/components/terminal/PaneWorkspace'
import { PerfHud } from '@/components/terminal/PerfHud'
import { SidePanels } from '@/components/terminal/SidePanels'
import { TopBar, type ConnectionStatus } from '@/components/terminal/TopBar'
import { WorkspacePaneCell } from '@/components/terminal/WorkspacePaneCell'
import { buildExpirySelectOptions } from '@/api/deribitExpiries'
import type { GexExpiry } from '@/api/mockGexData'
import { normalizeLiveExpiry } from '@/api/liveTerminal'
import { getTerminalDataMode, usePrefetchTerminalSnapshots, useTerminalSnapshot } from '@/hooks/useTerminalSnapshot'
import { useTerminalStore } from '@/store/terminalStore'

export function TerminalDashboard() {
  const expiry = useTerminalStore((state) => state.expiry)
  const setExpiry = useTerminalStore((state) => state.setExpiry)
  const dataMode = getTerminalDataMode()

  const [workspace, setWorkspace] = useState<WorkspaceLayout>(() => createDefaultWorkspace())

  // Always keep ALL warm so expiry filters can fall back without a blank desk.
  const { data: allExpirySnapshot } = useTerminalSnapshot('ALL')

  const {
    data: snapshot,
    isPending,
    isFetching,
    isError,
    error,
    isPlaceholderData,
  } = useTerminalSnapshot(expiry)
  const prefetchSnapshots = usePrefetchTerminalSnapshots()

  // Live mode must only list expiries that exist in the book — never the mock
  // Deribit calendar (19JUL26), which 404s against the Phase 5 API.
  const listedExpiries = useMemo(() => {
    const fromSelected = snapshot?.expiries
    if (fromSelected?.length) return fromSelected
    const fromAll = allExpirySnapshot?.expiries
    if (fromAll?.length) return fromAll
    return [] as GexExpiry[]
  }, [snapshot, allExpirySnapshot])

  const frontExpiry: GexExpiry = listedExpiries[0] ?? 'ALL'
  const expiryOptions = useMemo(
    () => buildExpirySelectOptions(listedExpiries).map((option) => ({
      value: option.value as GexExpiry,
      label: option.label,
      shortLabel: option.shortLabel,
    })),
    [listedExpiries],
  )

  useEffect(() => {
    if (listedExpiries.length === 0) return
    prefetchSnapshots(['ALL', ...listedExpiries])
  }, [listedExpiries, prefetchSnapshots])

  // Drop rolled-off / unknown global expiry once the live book is known.
  useEffect(() => {
    if (dataMode !== 'live') return
    if (listedExpiries.length === 0) return
    if (expiry === 'ALL') return
    const normalized = normalizeLiveExpiry(expiry)
    const known = listedExpiries.some((item) => normalizeLiveExpiry(item) === normalized)
    if (!known) {
      setExpiry('ALL')
    }
  }, [dataMode, expiry, listedExpiries, setExpiry])

  const [statusClockMs, setStatusClockMs] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setStatusClockMs(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const connectionStatus = useMemo((): ConnectionStatus => {
    if (isError && !snapshot) return 'offline'
    if (isFetching || isPlaceholderData) return 'refreshing'
    if (getTerminalDataMode() === 'mock') return 'mock'
    if (snapshot?.asOfUtc) {
      const asOfMs = Date.parse(snapshot.asOfUtc)
      if (Number.isFinite(asOfMs) && statusClockMs - asOfMs > 120_000) return 'stale'
    }
    return 'live'
  }, [isError, isFetching, isPlaceholderData, snapshot, statusClockMs])

  const handleAddPanel = useCallback(() => {
    setWorkspace((prev) => addBlankPanel(prev))
  }, [])

  /**
   * Close / remove a panel slot and reflow to the optimal grid.
   * Blank panels only appear via Add Panel (right-click to fill).
   */
  const removeCell = useCallback((row: number, col: number) => {
    setWorkspace((prev) => removePanel(prev, row, col))
  }, [])

  const fillCell = useCallback((row: number, col: number, option: PanelFillOption) => {
    if (option.kind === 'table') {
      setWorkspace((prev) => updateCell(prev, row, col, { open: true, kind: 'table' }))
      return
    }
    const mode = option.mode
    setWorkspace((prev) =>
      updateCell(prev, row, col, {
        open: true,
        kind: 'chart',
        mode,
        dataWindowMode: 'percent',
        dataWindowPct: mode === 'heatmap' ? defaultHeatmapDataWindowPct : 25,
      }),
    )
  }, [])

  const patchCell = useCallback(
    (row: number, col: number, patch: Parameters<typeof updateCell>[3]) => {
      setWorkspace((prev) => updateCell(prev, row, col, patch))
    },
    [],
  )

  if (isPending && !snapshot) {
    return <TerminalStateFrame title="Loading Lotus Data" detail="Fetching live GEX snapshot..." />
  }

  if (isError && !snapshot) {
    return (
      <TerminalStateFrame
        title="Live Snapshot Unavailable"
        detail={error instanceof Error ? error.message : 'Unable to load the backend terminal snapshot.'}
      />
    )
  }

  if (!snapshot || snapshot.gammaBars.length === 0) {
    return (
      <TerminalStateFrame
        title="No GEX Rows"
        detail="The latest backend snapshot did not contain renderable GEX data."
      />
    )
  }

  const softError =
    isError && snapshot
      ? error instanceof Error
        ? error.message
        : 'Snapshot refresh failed — showing last good data.'
      : null

  return (
    <div className="terminal-desk mx-auto flex h-screen w-full flex-col overflow-hidden bg-[var(--terminal-bg)]">
      <TopBar
        connectionStatus={connectionStatus}
        asOfUtc={snapshot.asOfUtc}
        onAddPanel={handleAddPanel}
        addPanelDisabled={workspace.cells.length >= maxWorkspacePanels}
      />
      {softError ? (
        <div
          className="shrink-0 border-b border-[var(--terminal-red)]/40 bg-[var(--terminal-red)]/10 px-3 py-1.5 text-[10px] text-[var(--terminal-red-strong)]"
          role="status"
        >
          {softError}
        </div>
      ) : null}
      <div
        className={`terminal-desk-body grid min-h-0 flex-1 overflow-hidden gap-x-3 gap-y-2 px-3 pb-3 pt-2 lg:grid-cols-[minmax(0,1fr)_406px] ${isPlaceholderData ? 'opacity-[0.97]' : ''}`}
      >
        <PaneWorkspace
          layout={workspace}
          onLayoutChange={setWorkspace}
          renderCell={({ row, col, cell, dragHandleProps, isDropTarget, isDragging }) => (
            <WorkspacePaneCell
              row={row}
              col={col}
              cell={cell}
              primarySnapshot={snapshot}
              frontExpiry={frontExpiry}
              expiryOptions={expiryOptions}
              dragHandleProps={dragHandleProps}
              isDropTarget={isDropTarget}
              isDragging={isDragging}
              onCellChange={(patch) => {
                patchCell(row, col, patch)
                if (row === 0 && col === 0 && patch.expiry) {
                  setExpiry(patch.expiry)
                }
              }}
              onClose={() => removeCell(row, col)}
              onRemove={() => removeCell(row, col)}
              onFill={(option) => fillCell(row, col, option)}
            />
          )}
        />
        <SidePanels
          snapshot={snapshot}
          allExpirySnapshot={allExpirySnapshot ?? snapshot}
        />
      </div>
      <PerfHud />
    </div>
  )
}

function TerminalStateFrame({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-[var(--terminal-bg)] px-4">
      <section className="terminal-frame flex min-h-[180px] w-full max-w-[520px] flex-col justify-center px-6 py-5">
        <div className="terminal-title mb-3">{title}</div>
        <div className="text-[11px] leading-5 text-[var(--terminal-muted)]">{detail}</div>
      </section>
    </div>
  )
}

export type { PanelFillOption }
