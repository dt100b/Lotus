import {
  defaultForwardDataWindowPct,
  defaultHeatmapDataWindowPct,
  normalizeExposureMode,
} from '@/components/terminal/gexModes'
import type { GexExpiry } from '@/api/mockGexData'
import type { ForwardExpiryScope, ForwardGreekMetric } from '@/api/gexForwardSurface'
import type { DataWindowMode, ExposureMode } from '@/store/terminalStore'

/** Match GammaHeatmapChart default visible window (~72h of 30m) without importing the chart. */
const defaultHeatmapTimeWindowHours = 72

/** Hard cap so the desk stays usable. */
export const maxWorkspacePanels = 16

export type PaneKind = 'chart' | 'table'

export type PaneCellState = {
  open: boolean
  kind: PaneKind
  mode: ExposureMode
  expiry: GexExpiry
  /** Forward panes always select one semantic expiry cliff, never ALL. */
  forwardExpiryScope: ForwardExpiryScope
  /** Greek surface selected in this pane. */
  forwardMetric: ForwardGreekMetric
  dataWindowMode: DataWindowMode
  dataWindowPct: number
  timeWindowHours: number
}

/**
 * Row-major workspace geometry:
 * - Shared `rowHeights` — one horizontal divider per row boundary.
 * - Per-row `colWidthsByRow` — vertical dividers only resize that row.
 * - Last row may be shorter than `cols` (e.g. 5 panels → 2×3 with a 2-cell bottom row).
 */
export type WorkspaceLayout = {
  rows: number
  /** Max columns in any row (shape hint for optimal packing). */
  cols: number
  /** Shared row heights (sum ≈ 100). */
  rowHeights: number[]
  /** Column widths per row (each sums ≈ 100). Length = cells in that row. */
  colWidthsByRow: number[][]
  /** Row-major cells; length = sum of per-row column counts. */
  cells: PaneCellState[]
}

export const layoutSnapPcts = [33, 40, 50, 60, 67] as const
export const layoutSnapHard = 4.5
export const absorbEmptyPct = 86
export const resplitSeedPct = 92
export const minTrackPct = 14

const defaultAutoDataWindowPct = 25

/** Default desk: GEX strike | 0DTE Gamma surface | 0DTE Delta surface. */
export function createDefaultWorkspace(): WorkspaceLayout {
  return buildWorkspaceFromCells([
    cell({
      kind: 'chart',
      mode: 'net',
      expiry: 'ALL',
    }),
    cell({
      kind: 'chart',
      mode: 'forward',
      forwardExpiryScope: '0dte',
      forwardMetric: 'gamma',
      dataWindowPct: defaultForwardDataWindowPct,
    }),
    cell({
      kind: 'chart',
      mode: 'forward',
      forwardExpiryScope: '0dte',
      forwardMetric: 'delta',
      dataWindowPct: defaultForwardDataWindowPct,
    }),
  ])
}

/** Blank slot — right-click to pick a chart mode. */
export function createBlankCell(): PaneCellState {
  return cell({
    open: false,
    kind: 'chart',
    mode: 'heatmap',
    dataWindowPct: defaultHeatmapDataWindowPct,
  })
}

/**
 * Optimal landscape-first grid for N panels.
 * Prefers wider layouts (charts read better side-by-side on a terminal desk).
 */
export function optimalGrid(panelCount: number): { rows: number; cols: number } {
  const n = Math.max(1, Math.min(panelCount, maxWorkspacePanels))
  if (n === 1) return { rows: 1, cols: 1 }
  if (n === 2) return { rows: 1, cols: 2 }
  if (n === 3) return { rows: 1, cols: 3 }
  if (n === 4) return { rows: 2, cols: 2 }
  if (n <= 6) return { rows: 2, cols: 3 }
  if (n <= 8) return { rows: 2, cols: 4 }
  if (n <= 9) return { rows: 3, cols: 3 }
  if (n <= 12) return { rows: 3, cols: 4 }
  return { rows: 4, cols: 4 }
}

/**
 * Default row weights after add/remove reflow.
 * Equal tracks keep multi-panel desks predictable; users fine-tune with dividers.
 */
export function preferredRowHeights(rows: number): number[] {
  return equalTracks(rows)
}

/** Row lengths for N panels packed into `cols` columns (last row may be short). */
export function distributeRowLengths(panelCount: number, cols: number): number[] {
  const n = Math.max(1, panelCount)
  const c = Math.max(1, cols)
  const lengths: number[] = []
  let remaining = n
  while (remaining > 0) {
    const take = Math.min(c, remaining)
    lengths.push(take)
    remaining -= take
  }
  return lengths
}

/**
 * Rebuild workspace geometry around an ordered list of panel cells.
 * Always reflows to the optimal grid for the current count.
 */
export function buildWorkspaceFromCells(cellsIn: PaneCellState[]): WorkspaceLayout {
  const cells =
    cellsIn.length > 0
      ? cellsIn.map((c) => ({ ...c }))
      : [createBlankCell()]
  const n = cells.length
  const { cols } = optimalGrid(n)
  const lengths = distributeRowLengths(n, cols)
  const rows = lengths.length
  return {
    rows,
    cols,
    rowHeights: preferredRowHeights(rows),
    colWidthsByRow: lengths.map((len) => equalTracks(len)),
    cells,
  }
}

export function createWorkspace(
  rows: number,
  cols: number,
  seed?: Array<Partial<PaneCellState> | undefined>,
  options?: { rowHeights?: number[] },
): WorkspaceLayout {
  const cells: PaneCellState[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      cells.push(cell(seed?.[i] ?? defaultSeedForIndex(i, rows, cols)))
    }
  }
  const built = buildWorkspaceFromCells(cells)
  if (options?.rowHeights) {
    return { ...built, rowHeights: normalizeTracks(options.rowHeights) }
  }
  return built
}

/** Grow/shrink a full rectangular grid while preserving overlapping cell configs. */
export function resizeWorkspace(prev: WorkspaceLayout, rows: number, cols: number): WorkspaceLayout {
  if (prev.rows === rows && prev.cols === cols && isRectangular(prev)) return prev

  const cells: PaneCellState[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const prevIdx = tryCellIndex(prev, r, c)
      if (prevIdx >= 0 && prev.cells[prevIdx]) {
        cells.push({ ...prev.cells[prevIdx]! })
      } else {
        cells.push(cell(defaultSeedForIndex(r * cols + c, rows, cols)))
      }
    }
  }

  return {
    rows,
    cols,
    rowHeights: resizeTracks(prev.rowHeights, rows),
    colWidthsByRow: Array.from({ length: rows }, (_, r) => {
      const prevWidths = prev.colWidthsByRow[r] ?? prev.colWidthsByRow[0] ?? equalTracks(prev.cols)
      return resizeTracks(prevWidths, cols)
    }),
    cells,
  }
}

/** Append a blank panel and reflow to the optimal grid. */
export function addBlankPanel(layout: WorkspaceLayout): WorkspaceLayout {
  if (layout.cells.length >= maxWorkspacePanels) return layout
  return buildWorkspaceFromCells([...layout.cells, createBlankCell()])
}

/** Append a deliberately sized row without disturbing the rows above it. */
export function addWorkspaceRow(layout: WorkspaceLayout, requestedCols: number): WorkspaceLayout {
  const cols = Math.max(1, Math.min(4, Math.round(requestedCols)))
  const available = maxWorkspacePanels - layout.cells.length
  const nextCols = Math.min(cols, available)
  if (nextCols <= 0) return layout

  return {
    rows: layout.rows + 1,
    cols: Math.max(layout.cols, nextCols),
    rowHeights: equalTracks(layout.rows + 1),
    colWidthsByRow: [...layout.colWidthsByRow.map((row) => [...row]), equalTracks(nextCols)],
    cells: [
      ...layout.cells.map((panel) => ({ ...panel })),
      ...Array.from({ length: nextCols }, () => createBlankCell()),
    ],
  }
}

/** Remove a panel slot and reflow. Never drops below one panel. */
export function removePanel(layout: WorkspaceLayout, row: number, col: number): WorkspaceLayout {
  const idx = cellIndexAt(layout, row, col)
  if (idx < 0 || idx >= layout.cells.length) return layout
  if (layout.cells.length <= 1) {
    // Keep a single blank slot so the desk is never empty.
    return buildWorkspaceFromCells([createBlankCell()])
  }
  const next = layout.cells.filter((_, i) => i !== idx)
  return buildWorkspaceFromCells(next)
}

/** Clear a filled panel back to a blank slot (keeps position). */
export function clearPanel(layout: WorkspaceLayout, row: number, col: number): WorkspaceLayout {
  return updateCell(layout, row, col, {
    open: false,
    kind: 'chart',
    mode: 'heatmap',
    dataWindowPct: defaultHeatmapDataWindowPct,
  })
}

/** Swap two panel configurations (drag-and-drop reorder). */
export function swapCells(
  layout: WorkspaceLayout,
  a: { row: number; col: number },
  b: { row: number; col: number },
): WorkspaceLayout {
  const i = cellIndexAt(layout, a.row, a.col)
  const j = cellIndexAt(layout, b.row, b.col)
  if (i < 0 || j < 0 || i === j) return layout
  const cells = layout.cells.slice()
  const tmp = cells[i]!
  cells[i] = cells[j]!
  cells[j] = tmp
  return { ...layout, cells }
}

export function rowCellCount(layout: WorkspaceLayout, row: number): number {
  return layout.colWidthsByRow[row]?.length ?? 0
}

/** Flat index for (row, col) under variable row lengths. */
export function cellIndexAt(layout: WorkspaceLayout, row: number, col: number): number {
  if (row < 0 || col < 0 || row >= layout.rows) return -1
  const rowLen = rowCellCount(layout, row)
  if (col >= rowLen) return -1
  let idx = 0
  for (let r = 0; r < row; r++) {
    idx += rowCellCount(layout, r)
  }
  return idx + col
}

/** @deprecated Prefer cellIndexAt — kept for rectangular call sites. */
export function cellIndex(row: number, col: number, cols: number) {
  return row * cols + col
}

export function getCell(layout: WorkspaceLayout, row: number, col: number) {
  const idx = cellIndexAt(layout, row, col)
  return layout.cells[idx]!
}

export function updateCell(
  layout: WorkspaceLayout,
  row: number,
  col: number,
  patch: Partial<PaneCellState>,
): WorkspaceLayout {
  const idx = cellIndexAt(layout, row, col)
  if (idx < 0) return layout
  const next = layout.cells.slice()
  next[idx] = { ...next[idx]!, ...patch }
  return { ...layout, cells: next }
}

export function setCellOpen(
  layout: WorkspaceLayout,
  row: number,
  col: number,
  open: boolean,
): WorkspaceLayout {
  return updateCell(layout, row, col, { open })
}

export function equalTracks(n: number): number[] {
  if (n <= 0) return []
  if (n === 1) return [100]
  const base = Math.floor((100 / n) * 100) / 100
  const tracks = Array.from({ length: n }, () => base)
  tracks[n - 1] = Math.round((100 - base * (n - 1)) * 100) / 100
  return tracks
}

export function resizeTracks(prev: number[], nextLen: number): number[] {
  if (nextLen <= 0) return []
  if (nextLen === prev.length) return normalizeTracks(prev)
  if (nextLen === 1) return [100]
  if (nextLen < prev.length) {
    const head = prev.slice(0, nextLen - 1)
    const tail = prev.slice(nextLen - 1).reduce((a, b) => a + b, 0)
    return normalizeTracks([...head, tail])
  }
  const kept = normalizeTracks(prev)
  const extra = nextLen - prev.length
  const scale = (100 - extra * (100 / nextLen)) / 100
  const scaled = kept.map((t) => t * scale)
  const added = Array.from({ length: extra }, () => 100 / nextLen)
  return normalizeTracks([...scaled, ...added])
}

export function normalizeTracks(tracks: number[]): number[] {
  if (tracks.length === 0) return []
  if (tracks.length === 1) return [100]
  const sum = tracks.reduce((a, b) => a + b, 0)
  if (sum <= 0) return equalTracks(tracks.length)
  const scaled = tracks.map((t) => (t / sum) * 100)
  const head = scaled.slice(0, -1).map((t) => Math.round(t * 100) / 100)
  const last = Math.round((100 - head.reduce((a, b) => a + b, 0)) * 100) / 100
  return [...head, last]
}

export function clampPct(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function hardSnapLayoutPct(value: number, min: number, max: number) {
  const clamped = clampPct(value, min, max)
  let best = clamped
  let bestDist = Infinity
  for (const snap of layoutSnapPcts) {
    if (snap < min - 0.01 || snap > max + 0.01) continue
    const dist = Math.abs(clamped - snap)
    if (dist < bestDist && dist <= layoutSnapHard) {
      bestDist = dist
      best = snap
    }
  }
  return best
}

/**
 * Resize boundary between track `index` and `index+1` by deltaPct (positive grows left/top).
 * During drag keep a floor so dividers stay mounted; absorb to 0 happens on snap.
 */
export function resizeTrackBoundary(
  tracks: number[],
  index: number,
  deltaPct: number,
  options?: { minTrack?: number; maxTravel?: boolean },
): number[] {
  if (index < 0 || index >= tracks.length - 1) return tracks
  const minTrack = options?.minTrack ?? minTrackPct
  const next = tracks.slice()
  const left = next[index]!
  const right = next[index + 1]!
  const pair = left + right
  if (pair <= 0.01) return tracks
  const travelFloor = options?.maxTravel ? 1.5 : minTrack
  const lo = travelFloor
  const hi = pair - travelFloor
  if (hi <= lo) return tracks
  const newLeft = clampPct(left + deltaPct, lo, hi)
  next[index] = newLeft
  next[index + 1] = pair - newLeft
  return next
}

/** On release: absorb empty neighbor past threshold, else snap. */
export function snapTrackBoundary(
  tracks: number[],
  index: number,
  leftIsEmpty: boolean,
  rightIsEmpty: boolean,
): number[] {
  if (index < 0 || index >= tracks.length - 1) return tracks
  const left = tracks[index]!
  const right = tracks[index + 1]!
  const pair = left + right
  if (pair <= 0.01) return tracks

  if (rightIsEmpty && left >= (pair * absorbEmptyPct) / 100) {
    const next = tracks.slice()
    next[index] = pair
    next[index + 1] = 0
    return next
  }
  if (leftIsEmpty && right >= (pair * absorbEmptyPct) / 100) {
    const next = tracks.slice()
    next[index] = 0
    next[index + 1] = pair
    return next
  }
  if (left <= 0.25 || right <= 0.25) return tracks

  const leftPctOfPair = (left / pair) * 100
  const snapped = hardSnapLayoutPct(leftPctOfPair, minTrackPct, 100 - minTrackPct)
  const next = tracks.slice()
  next[index] = (snapped / 100) * pair
  next[index + 1] = pair - next[index]!
  return next
}

export function seedResplitTracks(tracks: number[], index: number, growLeft: boolean): number[] {
  if (index < 0 || index >= tracks.length - 1) return tracks
  const left = tracks[index]!
  const right = tracks[index + 1]!
  const pair = left + right
  if (pair <= 0) return equalTracks(tracks.length)
  const next = tracks.slice()
  if (growLeft) {
    next[index] = (resplitSeedPct / 100) * pair
    next[index + 1] = pair - next[index]!
  } else {
    next[index] = ((100 - resplitSeedPct) / 100) * pair
    next[index + 1] = pair - next[index]!
  }
  return next
}

export function restoreHalfTracks(tracks: number[], index: number): number[] {
  if (index < 0 || index >= tracks.length - 1) return tracks
  const left = tracks[index]!
  const right = tracks[index + 1]!
  const pair = left + right
  const next = tracks.slice()
  next[index] = pair / 2
  next[index + 1] = pair / 2
  return next
}

/** Ensure a track has visible share by taking from the largest sibling. */
export function ensureTrackVisible(tracks: number[], index: number, minShare = 12): number[] {
  if (index < 0 || index >= tracks.length) return tracks
  if ((tracks[index] ?? 0) >= minShare) return tracks
  let donor = -1
  let donorSize = -1
  for (let i = 0; i < tracks.length; i++) {
    if (i === index) continue
    if ((tracks[i] ?? 0) > donorSize) {
      donorSize = tracks[i] ?? 0
      donor = i
    }
  }
  if (donor < 0 || donorSize < minShare * 2) return tracks
  const next = tracks.slice()
  const give = Math.min(donorSize / 2, minShare)
  next[donor] = donorSize - give
  next[index] = (next[index] ?? 0) + give
  return next
}

function isRectangular(layout: WorkspaceLayout): boolean {
  return layout.colWidthsByRow.every((w) => w.length === layout.cols)
    && layout.cells.length === layout.rows * layout.cols
}

function tryCellIndex(layout: WorkspaceLayout, row: number, col: number): number {
  return cellIndexAt(layout, row, col)
}

function cell(partial: Partial<PaneCellState> = {}): PaneCellState {
  const mode = normalizeExposureMode(partial.mode ?? 'net') as ExposureMode
  return {
    open: partial.open ?? true,
    kind: partial.kind ?? 'chart',
    mode,
    expiry: partial.expiry ?? 'ALL',
    forwardExpiryScope: partial.forwardExpiryScope ?? '0dte',
    forwardMetric: partial.forwardMetric ?? 'gamma',
    dataWindowMode: partial.dataWindowMode ?? (mode === 'net' ? 'full' : 'percent'),
    dataWindowPct:
      partial.dataWindowPct
      ?? (mode === 'heatmap'
        ? defaultHeatmapDataWindowPct
        : mode === 'forward'
          ? defaultForwardDataWindowPct
          : defaultAutoDataWindowPct),
    timeWindowHours: partial.timeWindowHours ?? defaultHeatmapTimeWindowHours,
  }
}

function defaultSeedForIndex(index: number, rows: number, cols: number): Partial<PaneCellState> {
  const seeds: Array<Partial<PaneCellState>> = [
    { kind: 'chart', mode: 'net' },
    { kind: 'chart', mode: 'heatmap', dataWindowPct: defaultHeatmapDataWindowPct },
    { kind: 'chart', mode: 'forward', dataWindowPct: defaultForwardDataWindowPct },
    { kind: 'chart', mode: 'net' },
    { kind: 'chart', mode: 'heatmap', dataWindowPct: defaultHeatmapDataWindowPct },
    { kind: 'chart', mode: 'forward', dataWindowPct: defaultForwardDataWindowPct },
  ]
  if (index < seeds.length) return seeds[index]!
  const modes: ExposureMode[] = ['net', 'heatmap', 'forward']
  const mode = modes[index % modes.length]!
  return {
    kind: 'chart',
    mode,
    dataWindowPct:
      mode === 'heatmap'
        ? defaultHeatmapDataWindowPct
        : mode === 'forward'
          ? defaultForwardDataWindowPct
          : defaultAutoDataWindowPct,
    open: index < rows * cols,
  }
}
