import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { LayoutDivider, PaneResplitEdge } from '@/components/terminal/LayoutDividers'
import {
  type PaneCellState,
  type WorkspaceLayout,
  cellIndexAt,
  ensureTrackVisible,
  resizeTrackBoundary,
  restoreHalfTracks,
  rowCellCount,
  seedResplitTracks,
  snapTrackBoundary,
  swapCells,
} from '@/components/terminal/paneModel'
import { cn } from '@/lib/utils'

type LayoutUpdater = WorkspaceLayout | ((prev: WorkspaceLayout) => WorkspaceLayout)

type PaneWorkspaceProps = {
  layout: WorkspaceLayout
  /** Prefer functional updates — drag handlers depend on always-fresh state. */
  onLayoutChange: (updater: LayoutUpdater) => void
  renderCell: (args: {
    row: number
    col: number
    cell: PaneCellState
    dragHandleProps: PaneDragHandleProps
    isDropTarget: boolean
    isDragging: boolean
  }) => ReactNode
  className?: string
}

export type PaneDragHandleProps = {
  onPointerDown: (event: ReactPointerEvent) => void
  'data-pane-drag-handle': true
}

type DragState = {
  fromRow: number
  fromCol: number
  overRow: number
  overCol: number
  pointerId: number
  originX: number
  originY: number
  currentX: number
  currentY: number
  active: boolean
}

/**
 * Row-major workspace (simple & reliable):
 * - Horizontal dividers resize shared row heights for the whole deck.
 * - Vertical dividers resize columns *within that row only*.
 * - Last row may have fewer columns than `layout.cols`.
 * - Empty cells absorb on release past threshold; edge handles re-split.
 * - Panel drag-handle swaps pane contents (Bloomberg-style reorder).
 *
 * Drag always applies via functional `onLayoutChange(prev => …)` so deltas
 * accumulate correctly even when React has not re-rendered mid-gesture.
 */
export function PaneWorkspace({ layout, onLayoutChange, renderCell, className }: PaneWorkspaceProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Map<number, HTMLDivElement | null>>(new Map())
  const cellRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)

  const { rows, rowHeights, colWidthsByRow, cells } = layout

  const update = useCallback(
    (updater: (prev: WorkspaceLayout) => WorkspaceLayout) => {
      onLayoutChange(updater)
    },
    [onLayoutChange],
  )

  // ── Shared row height resize ───────────────────────────────────────────
  const handleRowResize = useCallback(
    (boundary: number, deltaY: number) => {
      const h = rootRef.current?.clientHeight ?? 0
      if (h <= 0) return
      const deltaPct = (deltaY / h) * 100
      update((prev) => {
        const topEmpty = rowIsEmpty(prev, boundary)
        const bottomEmpty = rowIsEmpty(prev, boundary + 1)
        return {
          ...prev,
          rowHeights: resizeTrackBoundary(prev.rowHeights, boundary, deltaPct, {
            maxTravel: topEmpty || bottomEmpty,
          }),
        }
      })
    },
    [update],
  )

  const snapRow = useCallback(
    (boundary: number) => {
      update((prev) => ({
        ...prev,
        rowHeights: snapTrackBoundary(
          prev.rowHeights,
          boundary,
          rowIsEmpty(prev, boundary),
          rowIsEmpty(prev, boundary + 1),
        ),
      }))
    },
    [update],
  )

  // ── Per-row column resize ──────────────────────────────────────────────
  const handleColResize = useCallback(
    (row: number, boundary: number, deltaX: number) => {
      const rowEl = rowRefs.current.get(row)
      const w = rowEl?.clientWidth ?? rootRef.current?.clientWidth ?? 0
      if (w <= 0) return
      const deltaPct = (deltaX / w) * 100
      update((prev) => {
        const widths = prev.colWidthsByRow[row] ?? []
        const leftEmpty = !prev.cells[cellIndexAt(prev, row, boundary)]?.open
        const rightEmpty = !prev.cells[cellIndexAt(prev, row, boundary + 1)]?.open
        const nextWidths = resizeTrackBoundary(widths, boundary, deltaPct, {
          maxTravel: leftEmpty || rightEmpty,
        })
        const nextColWidths = prev.colWidthsByRow.slice()
        nextColWidths[row] = nextWidths
        return { ...prev, colWidthsByRow: nextColWidths }
      })
    },
    [update],
  )

  const snapCol = useCallback(
    (row: number, boundary: number) => {
      update((prev) => {
        const widths = prev.colWidthsByRow[row] ?? []
        const leftEmpty = !prev.cells[cellIndexAt(prev, row, boundary)]?.open
        const rightEmpty = !prev.cells[cellIndexAt(prev, row, boundary + 1)]?.open
        const nextColWidths = prev.colWidthsByRow.slice()
        nextColWidths[row] = snapTrackBoundary(widths, boundary, leftEmpty, rightEmpty)
        return { ...prev, colWidthsByRow: nextColWidths }
      })
    },
    [update],
  )

  // ── Re-split helpers ───────────────────────────────────────────────────
  const beginRowResplit = useCallback(
    (boundary: number, growTop: boolean) => {
      update((prev) => ({
        ...prev,
        rowHeights: seedResplitTracks(prev.rowHeights, boundary, growTop),
      }))
    },
    [update],
  )

  const restoreRowResplit = useCallback(
    (boundary: number) => {
      update((prev) => ({
        ...prev,
        rowHeights: restoreHalfTracks(prev.rowHeights, boundary),
      }))
    },
    [update],
  )

  const beginColResplit = useCallback(
    (row: number, boundary: number, growLeft: boolean) => {
      update((prev) => {
        const nextColWidths = prev.colWidthsByRow.slice()
        nextColWidths[row] = seedResplitTracks(prev.colWidthsByRow[row] ?? [], boundary, growLeft)
        return { ...prev, colWidthsByRow: nextColWidths }
      })
    },
    [update],
  )

  const restoreColResplit = useCallback(
    (row: number, boundary: number) => {
      update((prev) => {
        const nextColWidths = prev.colWidthsByRow.slice()
        nextColWidths[row] = restoreHalfTracks(prev.colWidthsByRow[row] ?? [], boundary)
        return { ...prev, colWidthsByRow: nextColWidths }
      })
    },
    [update],
  )

  // ── Panel drag-to-swap ─────────────────────────────────────────────────
  const hitTestPane = useCallback((clientX: number, clientY: number): { row: number; col: number } | null => {
    const el = document.elementFromPoint(clientX, clientY)
    const pane = el?.closest?.('[data-pane-cell]') as HTMLElement | null
    if (!pane) return null
    const row = Number(pane.dataset.paneRow)
    const col = Number(pane.dataset.paneCol)
    if (!Number.isFinite(row) || !Number.isFinite(col)) return null
    return { row, col }
  }, [])

  const endPaneDrag = useCallback(
    (state: DragState) => {
      const target = { row: state.overRow, col: state.overCol }
      const source = { row: state.fromRow, col: state.fromCol }
      const moved =
        Math.hypot(state.currentX - state.originX, state.currentY - state.originY) > 6
      if (
        moved
        && state.active
        && (target.row !== source.row || target.col !== source.col)
      ) {
        update((prev) => swapCells(prev, source, target))
      }
      dragRef.current = null
      setDrag(null)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    },
    [update],
  )

  const beginPaneDrag = useCallback(
    (row: number, col: number, event: ReactPointerEvent) => {
      // Only primary button; ignore interactive controls inside the handle area.
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      if (target.closest('button, a, input, select, [role="combobox"], [role="menu"], [role="menuitem"]')) {
        return
      }
      event.preventDefault()
      event.stopPropagation()

      const next: DragState = {
        fromRow: row,
        fromCol: col,
        overRow: row,
        overCol: col,
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        active: false,
      }
      dragRef.current = next
      setDrag(next)
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'
    },
    [],
  )

  useEffect(() => {
    if (!drag) return

    const onMove = (event: PointerEvent) => {
      const current = dragRef.current
      if (!current || event.pointerId !== current.pointerId) return
      const dist = Math.hypot(event.clientX - current.originX, event.clientY - current.originY)
      const hit = hitTestPane(event.clientX, event.clientY)
      const next: DragState = {
        ...current,
        currentX: event.clientX,
        currentY: event.clientY,
        active: current.active || dist > 6,
        overRow: hit?.row ?? current.overRow,
        overCol: hit?.col ?? current.overCol,
      }
      dragRef.current = next
      setDrag(next)
    }

    const onUp = (event: PointerEvent) => {
      const current = dragRef.current
      if (!current || event.pointerId !== current.pointerId) return
      endPaneDrag({
        ...current,
        currentX: event.clientX,
        currentY: event.clientY,
      })
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag, endPaneDrag, hitTestPane])

  const makeDragHandleProps = useCallback(
    (row: number, col: number): PaneDragHandleProps => ({
      onPointerDown: (event) => beginPaneDrag(row, col, event),
      'data-pane-drag-handle': true,
    }),
    [beginPaneDrag],
  )

  return (
    <div
      ref={rootRef}
      className={cn(
        'pane-workspace flex h-full min-h-0 min-w-0 flex-col overflow-hidden',
        drag?.active && 'pane-workspace--dragging',
        className,
      )}
    >
      {Array.from({ length: rows }, (_, row) => {
        const height = rowHeights[row] ?? 0
        if (height <= 0.25) return null

        const widths = colWidthsByRow[row] ?? []
        const colsInRow = widths.length
        const showTopEdge =
          row > 0
          && (rowHeights[row - 1] ?? 0) <= 0.25
        const showBottomEdge =
          row < rows - 1
          && (rowHeights[row + 1] ?? 0) <= 0.25
        const showDividerAbove =
          row > 0
          && (rowHeights[row - 1] ?? 0) > 0.25

        return (
          <div key={`row-${row}`} className="contents">
            {showDividerAbove ? (
              <LayoutDivider
                orientation="horizontal"
                onDrag={(dy) => handleRowResize(row - 1, dy)}
                onDragEnd={() => snapRow(row - 1)}
                label={`Resize rows ${row} / ${row + 1}`}
              />
            ) : null}

            <div
              ref={(el) => {
                rowRefs.current.set(row, el)
              }}
              className="relative flex min-h-0 min-w-0 overflow-hidden"
              style={{ flex: `${Math.max(height, 0.01)} 1 0` }}
            >
              {showTopEdge ? (
                <PaneResplitEdge
                  side="top"
                  label="Restore row above"
                  onBeginDrag={() => beginRowResplit(row - 1, false)}
                  onClickRestore={() => restoreRowResplit(row - 1)}
                  onDrag={(dy) => handleRowResize(row - 1, dy)}
                  onDragEnd={() => snapRow(row - 1)}
                />
              ) : null}
              {showBottomEdge ? (
                <PaneResplitEdge
                  side="bottom"
                  label="Restore row below"
                  onBeginDrag={() => beginRowResplit(row, true)}
                  onClickRestore={() => restoreRowResplit(row)}
                  onDrag={(dy) => handleRowResize(row, dy)}
                  onDragEnd={() => snapRow(row)}
                />
              ) : null}

              {Array.from({ length: colsInRow }, (_, col) => {
                const width = widths[col] ?? 0
                if (width <= 0.25) return null

                const idx = cellIndexAt(layout, row, col)
                const cell = cells[idx]
                if (!cell) return null

                const showLeftEdge =
                  col > 0
                  && (widths[col - 1] ?? 0) <= 0.25
                const showRightEdge =
                  col < colsInRow - 1
                  && (widths[col + 1] ?? 0) <= 0.25
                const showColDividerLeft =
                  col > 0
                  && (widths[col - 1] ?? 0) > 0.25

                const isSource =
                  drag?.active
                  && drag.fromRow === row
                  && drag.fromCol === col
                const isDropTarget =
                  drag?.active
                  && drag.overRow === row
                  && drag.overCol === col
                  && !isSource

                return (
                  <div key={`cell-${row}-${col}`} className="contents">
                    {showColDividerLeft ? (
                      <LayoutDivider
                        orientation="vertical"
                        onDrag={(dx) => handleColResize(row, col - 1, dx)}
                        onDragEnd={() => snapCol(row, col - 1)}
                        label={`Resize columns in row ${row + 1}`}
                      />
                    ) : null}

                    <div
                      ref={(el) => {
                        cellRefs.current.set(`${row}-${col}`, el)
                      }}
                      data-pane-cell
                      data-pane-row={row}
                      data-pane-col={col}
                      className={cn(
                        'pane-workspace__cell relative flex min-h-0 min-w-0 flex-col overflow-hidden',
                        isSource && 'pane-workspace__cell--dragging',
                        isDropTarget && 'pane-workspace__cell--drop-target',
                      )}
                      style={{ flex: `${Math.max(width, 0.01)} 1 0` }}
                    >
                      {renderCell({
                        row,
                        col,
                        cell,
                        dragHandleProps: makeDragHandleProps(row, col),
                        isDropTarget: Boolean(isDropTarget),
                        isDragging: Boolean(isSource),
                      })}
                      {showLeftEdge ? (
                        <PaneResplitEdge
                          side="left"
                          label="Restore left pane"
                          onBeginDrag={() => beginColResplit(row, col - 1, false)}
                          onClickRestore={() => restoreColResplit(row, col - 1)}
                          onDrag={(dx) => handleColResize(row, col - 1, dx)}
                          onDragEnd={() => snapCol(row, col - 1)}
                        />
                      ) : null}
                      {showRightEdge ? (
                        <PaneResplitEdge
                          side="right"
                          label="Restore right pane"
                          onBeginDrag={() => beginColResplit(row, col, true)}
                          onClickRestore={() => restoreColResplit(row, col)}
                          onDrag={(dx) => handleColResize(row, col, dx)}
                          onDragEnd={() => snapCol(row, col)}
                        />
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {drag?.active ? (
        <div
          className="pane-workspace__drag-ghost pointer-events-none fixed z-[100]"
          style={{
            left: drag.currentX + 12,
            top: drag.currentY + 12,
          }}
          aria-hidden
        >
          Move panel
        </div>
      ) : null}
    </div>
  )
}

function rowIsEmpty(layout: WorkspaceLayout, row: number): boolean {
  if (row < 0 || row >= layout.rows) return false
  const count = rowCellCount(layout, row)
  for (let c = 0; c < count; c++) {
    if (layout.cells[cellIndexAt(layout, row, c)]?.open) return false
  }
  return true
}

/** Re-export for close handlers that need to rebalance tracks. */
export { ensureTrackVisible }
