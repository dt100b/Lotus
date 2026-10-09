import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { GexHoverCard, type GexHoverSide } from '@/components/terminal/GexHoverCard'
import { useContainerSize } from '@/hooks/useContainerSize'
import { formatGexAxisTick, formatStrike } from '@/lib/formatters'
import { buildLadderAxisScale } from '@/lib/gexChartDomain'
import {
  forwardGreekPalettes,
  resolveForwardGreekPalette,
  type ForwardGreekPalette,
} from '@/data/forwardGreekPalettes'
import type {
  GexStrikeSettings,
  GexStrikeSideRows,
} from '@/data/gexStrikeSettings'
import { useTerminalStore } from '@/store/terminalStore'
import { cn } from '@/lib/utils'

export type GexStrikeDatum = {
  strike: number
  netGexUsd: number
  callGexUsd: number
  putGexUsd: number
  displayGexUsd: number
  positiveGexUsd: number
  negativeGexUsd: number
  openInterest: number
}

type GexStrikeLadderChartProps = {
  data: GexStrikeDatum[]
  spot: number
  title: string
  header?: ReactNode
  titleAccessory?: ReactNode
  minHeight: number
  useOtcPalette: boolean
  settings: GexStrikeSettings
  settingsOpen: boolean
  onSettingsChange?: (settings: GexStrikeSettings) => void
  seriesKey: string
}

type HoveredStrike = {
  datum: GexStrikeDatum
  xPct: number
  yPct: number
  side: GexHoverSide
  announce: boolean
}

type DomainLock = {
  strikeKey: string
  maxAbs: number
}

type IncreaseFrame = {
  rows: GexStrikeDatum[]
  strikeKey: string
  fromByStrike: Map<number, number>
}

type NetGexChangeFrame = {
  rows: GexStrikeDatum[]
  strikeKey: string
  gexDeltaByStrike: Map<number, number>
}

type PreviousNetGexValue = {
  netGexUsd: number
}

type ContextMenuState = { x: number; y: number }

type LadderRange = 'full' | 5 | 10 | 20

const ladderRangeOptions: LadderRange[] = ['full', 5, 10, 20]

const denseRowHeight = 22
const maxRowHeight = 46
const maxFilteredRowHeight = 64
const ladderChromeHeight = 50
const overscanRows = 6

/**
 * Quanted-style strike ladder: a virtualized DOM table with a signed bar lane.
 *
 * Every valid strike supplied by the selected snapshot is retained. The fixed
 * row pitch and virtual scroll viewport provide density without deleting quiet
 * wing strikes or forcing the entire surface into one compressed SVG canvas.
 */
export const GexStrikeLadderChart = memo(function GexStrikeLadderChart({
  data,
  spot,
  title,
  header,
  titleAccessory,
  minHeight,
  useOtcPalette,
  settings,
  settingsOpen,
  onSettingsChange,
  seriesKey,
}: GexStrikeLadderChartProps) {
  const focusOwnerId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Per-strike high-water mark for candlestick-style wicks (session peak extent). */
  const peakExtentsRef = useRef<Map<number, number>>(new Map())
  const peakStrikeKeyRef = useRef('')
  /** Previous refresh print used to split newly-added GEX into a softer segment. */
  const previousExtentsRef = useRef<Map<number, number>>(new Map())
  const previousStrikeKeyRef = useRef('')
  const increaseFrameRef = useRef<IncreaseFrame | null>(null)
  const previousNetGexValuesRef = useRef<Map<number, PreviousNetGexValue>>(new Map())
  const previousNetGexStrikeKeyRef = useRef('')
  const netGexChangeFrameRef = useRef<NetGexChangeFrame | null>(null)
  const centeredStrikeKeyRef = useRef('')
  /** Suppress row click after a vertical drag-scroll gesture. */
  const suppressRowClickRef = useRef(false)
  const hoverRafRef = useRef<number | null>(null)
  const pendingHoverRef = useRef<HoveredStrike | null>(null)
  const dragScrollRef = useRef<{
    pointerId: number
    startY: number
    startScroll: number
    dragging: boolean
  } | null>(null)
  const [domainLock, setDomainLock] = useState<DomainLock>({ strikeKey: '', maxAbs: 1 })
  const [hovered, setHovered] = useState<HoveredStrike | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [range, setRange] = useState<LadderRange>('full')
  const [autoFitOn, setAutoFitOn] = useState(true)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const exposureLabel = strikeExposureLabel(settings.metric)
  const greekLabel = settings.metric === 'delta' ? 'delta' : 'gamma'
  const activePalette = resolveForwardGreekPalette(settings.metric, settings.paletteId)
  const paletteColors = useMemo(() => strikePaletteColors(activePalette), [activePalette])
  const sideRowLabels = getSideRowLabels(settings.sideRows, exposureLabel)
  const activeFocus = useTerminalStore((state) => state.gexActiveStrike)
  const markedFocuses = useTerminalStore((state) => state.gexMarkedStrikes)
  const setActiveFocus = useTerminalStore((state) => state.setGexActiveStrike)
  const setMarkedFocuses = useTerminalStore((state) => state.setGexMarkedStrikes)
  const toggleMarkedFocus = useTerminalStore((state) => state.toggleGexMarkedStrike)
  const setSharedHoveredStrike = useTerminalStore((state) => state.setGexHoveredStrike)
  const activeStrike = activeFocus?.strike ?? null
  const markedStrikeSet = useMemo(
    () => new Set(markedFocuses.map((focus) => focus.strike)),
    [markedFocuses],
  )

  const allRows = useMemo(() => prepareAllRows(data), [data])
  const rows = useMemo(
    () => selectLadderRange(allRows, spot, range),
    [allRows, range, spot],
  )
  const { height: plotHeight } = useContainerSize(
    plotRef,
    520,
    516,
    { minWidth: 1, minHeight: 1 },
  )
  const availableRowHeight = Math.max(1, plotHeight - ladderChromeHeight)
  const resolvedRowHeight = clamp(
    Math.floor(availableRowHeight / Math.max(rows.length, 1)),
    denseRowHeight,
    range === 'full' ? maxRowHeight : maxFilteredRowHeight,
  )
  const strikeKey = useMemo(
    () => `${seriesKey}|${settings.metric}|${rows.map((row) => row.strike).join(',')}`,
    [rows, seriesKey, settings.metric],
  )
  const allStrikeKey = useMemo(
    () => `${seriesKey}|${settings.metric}|${allRows.map((row) => row.strike).join(',')}`,
    [allRows, seriesKey, settings.metric],
  )
  /**
   * Display peaks are read before the stored map is advanced so a shrink
   * (e.g. -3M → -2.5M) still renders the prior extreme as a wick this frame.
   */
  const peakByStrike = syncPeakExtents(
    peakExtentsRef.current,
    peakStrikeKeyRef,
    rows,
    strikeKey,
  )
  const increaseFromByStrike = syncIncreaseExtents(
    previousExtentsRef.current,
    previousStrikeKeyRef,
    increaseFrameRef,
    rows,
    strikeKey,
  )
  const netGexChanges = syncNetGexChanges(
    previousNetGexValuesRef.current,
    previousNetGexStrikeKeyRef,
    netGexChangeFrameRef,
    allRows,
    allStrikeKey,
  )
  const getItemKey = useCallback(
    (index: number) => rows[index]?.strike ?? index,
    [rows],
  )
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => resolvedRowHeight,
    getItemKey,
    overscan: overscanRows,
  })

  const nextDomainMax = useMemo(() => {
    let peakAbs = 0
    for (const row of rows) {
      peakAbs = Math.max(peakAbs, Math.abs(row.displayGexUsd))
      const peak = peakByStrike.get(row.strike)
      if (peak != null) peakAbs = Math.max(peakAbs, Math.abs(peak))
    }
    return buildLadderAxisScale(peakAbs).maxAbs
  }, [peakByStrike, rows])
  const maxAbs = domainLock.strikeKey === strikeKey
    ? Math.max(domainLock.maxAbs, nextDomainMax)
    : nextDomainMax
  // Always five equal steps on the locked half-width (no thinning → no uneven gaps).
  const axisTicks = useMemo(() => {
    const half = maxAbs / 2
    return [-maxAbs, -half, 0, half, maxAbs]
  }, [maxAbs])
  /** Ranked key strikes: 1 = largest |GEX|, 2 = second, 3 = third (for fade tiers). */
  const wallRankByStrike = useMemo((): Map<number, 1 | 2 | 3> => {
    const ranks = new Map<number, 1 | 2 | 3>()
    if (allRows.length === 0) return ranks
    const peak = Math.max(1, ...allRows.map((row) => Math.abs(row.displayGexUsd)))
    const ranked = [...allRows]
      .filter((row) => Math.abs(row.displayGexUsd) >= peak * 0.42)
      .sort((a, b) => Math.abs(b.displayGexUsd) - Math.abs(a.displayGexUsd))
      .slice(0, 3)
    for (let index = 0; index < ranked.length; index += 1) {
      const row = ranked[index]
      if (row) ranks.set(row.strike, (index + 1) as 1 | 2 | 3)
    }
    return ranks
  }, [allRows])
  const sideRowMaxima = getSideRowMaxima(
    rows,
    settings.sideRows,
    netGexChanges.gexDeltaByStrike,
  )

  const spotRow = useMemo(() => strikeToRowIndex(rows, spot), [rows, spot])
  const spotOffset = spotRow == null
    ? null
    : spotRow * resolvedRowHeight + resolvedRowHeight / 2
  const virtualRows = rowVirtualizer.getVirtualItems()
  const cardDatum = hovered?.datum ?? null

  const clearHover = useCallback(() => {
    if (hoverRafRef.current != null) {
      window.cancelAnimationFrame(hoverRafRef.current)
      hoverRafRef.current = null
    }
    pendingHoverRef.current = null
    setHovered(null)
    setSharedHoveredStrike(null)
  }, [setSharedHoveredStrike])

  const centerRowIndex = useCallback((index: number) => {
    const viewport = scrollRef.current
    if (!viewport) {
      rowVirtualizer.scrollToIndex(index, { align: 'center' })
      return
    }
    const target = index * resolvedRowHeight
      + resolvedRowHeight / 2
      - viewport.clientHeight / 2
    const maxScroll = Math.max(0, rowVirtualizer.getTotalSize() - viewport.clientHeight)
    viewport.scrollTop = clamp(target, 0, maxScroll)
  }, [resolvedRowHeight, rowVirtualizer])

  useEffect(() => {
    rowVirtualizer.measure()
  }, [resolvedRowHeight, rowVirtualizer])

  useEffect(() => {
    setDomainLock((current) => ({
      strikeKey,
      maxAbs: current.strikeKey === strikeKey
        ? Math.max(current.maxAbs, nextDomainMax)
        : nextDomainMax,
    }))
  }, [nextDomainMax, strikeKey])

  useEffect(() => {
    if (rows.length === 0) {
      setActiveIndex(0)
      clearHover()
      if (allRows.length === 0) {
        if (activeFocus?.ownerId === focusOwnerId) setActiveFocus(null)
        setMarkedFocuses(markedFocuses.filter((focus) => focus.ownerId !== focusOwnerId))
      }
      centeredStrikeKeyRef.current = ''
      return
    }

    setActiveIndex((current) => clamp(current, 0, rows.length - 1))
    const datumByStrike = new Map(allRows.map((row) => [row.strike, row]))
    if (activeFocus?.ownerId === focusOwnerId) {
      const refreshed = datumByStrike.get(activeFocus.strike)
      setActiveFocus(refreshed
        ? focusFromDatum(refreshed, paletteColors, focusOwnerId)
        : null)
    }
    setMarkedFocuses(markedFocuses.flatMap((focus) => {
      if (focus.ownerId !== focusOwnerId) return [focus]
      const refreshed = datumByStrike.get(focus.strike)
      return refreshed ? [focusFromDatum(refreshed, paletteColors, focusOwnerId)] : []
    }))

    if (!autoFitOn || centeredStrikeKeyRef.current === strikeKey) return
    const targetIndex = nearestStrikeIndex(rows, spot)
    const raf = window.requestAnimationFrame(() => {
      centerRowIndex(targetIndex)
      centeredStrikeKeyRef.current = strikeKey
      setActiveIndex(targetIndex)
    })
    return () => window.cancelAnimationFrame(raf)
  }, [
    activeFocus,
    allRows,
    autoFitOn,
    centerRowIndex,
    clearHover,
    focusOwnerId,
    markedFocuses,
    paletteColors,
    rowVirtualizer,
    rows,
    setActiveFocus,
    setMarkedFocuses,
    spot,
    strikeKey,
  ])

  useEffect(() => () => {
    if (hoverRafRef.current != null) window.cancelAnimationFrame(hoverRafRef.current)
    setSharedHoveredStrike(null)
  }, [setSharedHoveredStrike])

  const updateHover = useCallback((
    datum: GexStrikeDatum,
    clientX: number,
    clientY: number,
    announce = false,
  ) => {
    const rect = plotRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    const xPct = clamp(((clientX - rect.left) / rect.width) * 100, 7, 93)
    const yPct = clamp(((clientY - rect.top) / rect.height) * 100, 11, 89)
    const nextHover: HoveredStrike = {
      datum,
      xPct,
      yPct,
      side: xPct > 61 ? 'left' : 'right',
      announce,
    }
    pendingHoverRef.current = nextHover
    if (hoverRafRef.current != null) return
    hoverRafRef.current = window.requestAnimationFrame(() => {
      hoverRafRef.current = null
      const pending = pendingHoverRef.current
      pendingHoverRef.current = null
      if (!pending) return
      setHovered(pending)
      setSharedHoveredStrike(focusFromDatum(pending.datum, paletteColors, focusOwnerId))
    })
  }, [focusOwnerId, paletteColors, setSharedHoveredStrike])

  const focusRow = useCallback((index: number) => {
    const next = clamp(index, 0, Math.max(0, rows.length - 1))
    setAutoFitOn(false)
    setActiveIndex(next)
    rowVirtualizer.scrollToIndex(next, { align: 'auto' })
    window.requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-gex-index="${next}"]`)
        ?.focus({ preventScroll: true })
    })
  }, [rowVirtualizer, rows.length])

  const handleRowKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
    datum: GexStrikeDatum,
  ) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusRow(index - 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusRow(index + 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusRow(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusRow(rows.length - 1)
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault()
      const pageRows = Math.max(
        1,
        Math.floor((scrollRef.current?.clientHeight ?? 220) / resolvedRowHeight) - 1,
      )
      focusRow(index + (event.key === 'PageUp' ? -pageRows : pageRows))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const focus = focusFromDatum(datum, paletteColors, focusOwnerId)
      clearHover()
      if (event.shiftKey) {
        toggleMarkedFocus(focus)
        return
      }
      setActiveFocus(activeStrike === datum.strike ? null : focus)
    } else if (event.key === 'Escape') {
      setActiveFocus(null)
      clearHover()
    }
  }, [
    activeStrike,
    clearHover,
    focusRow,
    focusOwnerId,
    paletteColors,
    resolvedRowHeight,
    rows.length,
    setActiveFocus,
    toggleMarkedFocus,
  ])

  const fitView = useCallback(() => {
    if (rows.length === 0) return
    const index = nearestStrikeIndex(rows, spot)
    setAutoFitOn(true)
    setActiveIndex(index)
    window.requestAnimationFrame(() => {
      centerRowIndex(index)
      centeredStrikeKeyRef.current = strikeKey
    })
  }, [centerRowIndex, rows, spot, strikeKey])

  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])

  const onAutoFitFromMenu = useCallback(() => {
    setCtxMenu(null)
    fitView()
  }, [fitView])

  useEffect(() => {
    if (!ctxMenu) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeCtxMenu()
    }
    const onDown = (event: MouseEvent) => {
      if (event.button === 2) return
      closeCtxMenu()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [closeCtxMenu, ctxMenu])

  /** Click-drag vertically anywhere on the ladder to scroll (in addition to wheel). */
  const handleDragScrollPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const viewport = scrollRef.current
    if (!viewport) return

    dragScrollRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScroll: viewport.scrollTop,
      dragging: false,
    }

    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragScrollRef.current
      if (!drag || moveEvent.pointerId !== drag.pointerId) return
      const dy = moveEvent.clientY - drag.startY
      if (!drag.dragging && Math.abs(dy) >= 4) {
        drag.dragging = true
        setAutoFitOn(false)
        suppressRowClickRef.current = true
        viewport.classList.add('is-drag-scrolling')
        clearHover()
      }
      if (drag.dragging) {
        viewport.scrollTop = drag.startScroll - dy
        moveEvent.preventDefault()
      }
    }

    const onUp = (upEvent: PointerEvent) => {
      const drag = dragScrollRef.current
      if (!drag || upEvent.pointerId !== drag.pointerId) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      viewport.classList.remove('is-drag-scrolling')
      const wasDragging = drag.dragging
      dragScrollRef.current = null
      if (wasDragging) {
        // Clear suppress after the synthetic click from the button, if any.
        window.setTimeout(() => {
          suppressRowClickRef.current = false
        }, 0)
      }
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [clearHover])

  return (
    <div
      ref={rootRef}
      className={cn(
        'gex-strike-ladder-root relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden',
        useOtcPalette && 'gex-palette-otc',
      )}
      style={{
        ...(header ? null : { minHeight: Math.min(minHeight, 120) }),
        ...strikePaletteStyle(activePalette),
      }}
    >
      {header ?? (
        <div className="gex-strike-ladder__fallback-header">
          <div className="min-w-0 flex-1 overflow-hidden pr-1">
            <div className="terminal-title truncate tracking-[0.12em]">{title}</div>
            <div className="terminal-meta mt-0.5 truncate tracking-[0.1em] opacity-80">
              STRIKE (Y) · NET {exposureLabel} (X)
            </div>
          </div>
          {titleAccessory ? <div className="ml-auto min-w-0">{titleAccessory}</div> : null}
        </div>
      )}

      {settingsOpen ? (
        <StrikeSettingsPanel settings={settings} onSettingsChange={onSettingsChange} />
      ) : null}

      <div
        ref={plotRef}
        className={cn(
          'gex-strike-ladder',
          settings.sideRows == null && 'gex-strike-ladder--hide-side-rows',
          !settings.gradientBars && 'gex-strike-ladder--flat-bars',
          !settings.showHorizontalGrid && 'gex-strike-ladder--hide-grid',
        )}
        onDoubleClick={fitView}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          const rect = plotRef.current?.getBoundingClientRect()
          if (!rect) return
          const menuW = 148
          const menuH = 40
          const x = Math.min(
            Math.max(4, event.clientX - rect.left),
            Math.max(4, rect.width - menuW - 4),
          )
          const y = Math.min(
            Math.max(4, event.clientY - rect.top),
            Math.max(4, rect.height - menuH - 4),
          )
          setCtxMenu({ x, y })
        }}
      >
        <div className="gex-strike-ladder__columns" aria-hidden>
          <span className="gex-strike-ladder__column gex-strike-ladder__column--strike">Strike</span>
          <span className="gex-strike-ladder__column gex-strike-ladder__column--put">
            {sideRowLabels.left}
          </span>
          <span className="gex-strike-ladder__column gex-strike-ladder__column--plot">
            <strong>Net {exposureLabel}</strong>
          </span>
          <span className="gex-strike-ladder__column gex-strike-ladder__column--call">
            {sideRowLabels.right}
          </span>
        </div>

        {rows.length > 0 ? (
          <div
            ref={scrollRef}
            className="gex-strike-ladder__viewport"
            role="listbox"
            aria-multiselectable="true"
            aria-label={`Net ${greekLabel} exposure by strike. All ${rows.length} available strikes. Click selects a strike. Shift-click or press Shift while highlighted to toggle a persistent marker.`}
            onPointerDown={handleDragScrollPointerDown}
            onWheel={() => setAutoFitOn(false)}
            onPointerLeave={() => {
              if (!dragScrollRef.current?.dragging) clearHover()
            }}
          >
            <div
              className="gex-strike-ladder__surface"
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                '--gex-row-height': `${resolvedRowHeight}px`,
              } as CSSProperties}
            >
              {virtualRows.map((virtualRow) => {
                const datum = rows[virtualRow.index]
                if (!datum) return null
                const currentValue = datum.displayGexUsd
                const peakValue = peakByStrike.get(datum.strike) ?? currentValue
                const magnitude = clamp(Math.abs(currentValue) / Math.max(maxAbs, 1), 0, 1)
                const widthPct = magnitude * 50
                const peakWidthPct = clamp(Math.abs(peakValue) / Math.max(maxAbs, 1), 0, 1) * 50
                const meterValue = Math.abs(peakValue) >= Math.abs(currentValue) ? peakValue : currentValue
                const meterWidthPct = Math.max(peakWidthPct, widthPct)
                const positive = meterValue >= 0
                const netPositive = datum.netGexUsd >= 0
                // Empty rounded cap when the live print is below the session peak.
                const partial = Math.abs(peakValue) > Math.abs(currentValue) + maxAbs * 1e-6
                  && Math.abs(peakValue) > 0
                const fillPctOfMeter = meterWidthPct > 0
                  ? clamp((widthPct / meterWidthPct) * 100, 0, 100)
                  : 0
                const increaseFromValue = increaseFromByStrike.get(datum.strike)
                const increaseFromWidthPct = increaseFromValue == null
                  ? null
                  : clamp(Math.abs(increaseFromValue) / Math.max(maxAbs, 1), 0, 1) * 50
                const increaseStartPctOfMeter = increaseFromWidthPct != null && meterWidthPct > 0
                  ? clamp((increaseFromWidthPct / meterWidthPct) * 100, 0, fillPctOfMeter)
                  : null
                const baseFillPctOfMeter = increaseStartPctOfMeter ?? fillPctOfMeter
                const increaseWidthPctOfMeter = increaseStartPctOfMeter == null
                  ? 0
                  : Math.max(0, fillPctOfMeter - increaseStartPctOfMeter)
                const increased = increaseWidthPctOfMeter > 0
                const wallRank = wallRankByStrike.get(datum.strike)
                const wall = wallRank != null
                const active = activeStrike === datum.strike
                const marked = markedStrikeSet.has(datum.strike)
                const selected = active || marked
                const hasMeter = meterWidthPct > 0 && (Math.abs(currentValue) > 0 || partial)
                const meterHeight = strikeBarHeight(settings.barWidthPct, resolvedRowHeight)
                const gexDelta = netGexChanges.gexDeltaByStrike.get(datum.strike) ?? 0
                const sideRowValues = getSideRowValues(
                  settings.sideRows,
                  datum,
                  gexDelta,
                )

                return (
                  <button
                    key={virtualRow.key}
                    id={`gex-strike-row-${datum.strike}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-posinset={virtualRow.index + 1}
                    aria-setsize={rows.length}
                    aria-label={`${formatStrike(datum.strike)} strike, Net ${exposureLabel} ${formatCompactGex(datum.netGexUsd)}${formatSideRowAria(sideRowLabels, sideRowValues)}`}
                    data-gex-index={virtualRow.index}
                    tabIndex={activeIndex === virtualRow.index ? 0 : -1}
                    className={cn(
                      'gex-strike-ladder__row',
                      wall && 'gex-strike-ladder__row--wall',
                      wall && `gex-strike-ladder__row--wall-${wallRank}`,
                      wall && positive && 'gex-strike-ladder__row--wall-pos',
                      wall && !positive && 'gex-strike-ladder__row--wall-neg',
                      selected && 'gex-strike-ladder__row--active',
                      selected && netPositive && 'gex-strike-ladder__row--selected-pos',
                      selected && !netPositive && 'gex-strike-ladder__row--selected-neg',
                    )}
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translate3d(0, ${virtualRow.start}px, 0)`,
                    }}
                    onPointerMove={(event: ReactPointerEvent<HTMLButtonElement>) => {
                      if (dragScrollRef.current?.dragging) return
                      updateHover(datum, event.clientX, event.clientY)
                    }}
                    onFocus={(event) => {
                      setActiveIndex(virtualRow.index)
                      const rect = event.currentTarget.getBoundingClientRect()
                      updateHover(datum, rect.left + rect.width * 0.58, rect.top + rect.height / 2, true)
                    }}
                    onBlur={clearHover}
                    onClick={(event) => {
                      if (suppressRowClickRef.current || dragScrollRef.current?.dragging) {
                        event.preventDefault()
                        return
                      }
                      const focus = focusFromDatum(datum, paletteColors, focusOwnerId)
                      if (event.shiftKey) {
                        toggleMarkedFocus(focus)
                      } else {
                        setActiveFocus(activeStrike === datum.strike ? null : focus)
                      }
                      clearHover()
                    }}
                    onKeyDown={(event) => handleRowKeyDown(event, virtualRow.index, datum)}
                  >
                    <span className="gex-strike-ladder__cell gex-strike-ladder__cell--strike">
                      {formatStrike(datum.strike)}
                    </span>
                    <span className={cn(
                      'gex-strike-ladder__cell gex-strike-ladder__cell--put',
                      toneClass(sideRowValues.left),
                    )} style={settings.sideRowGradient
                      ? sideRowGradientStyle(sideRowValues.left, sideRowMaxima.left, 'left')
                      : undefined}>
                      {formatSideRowValue(settings.sideRows, sideRowValues.left)}
                    </span>
                    <span className="gex-strike-ladder__cell gex-strike-ladder__cell--plot">
                      {hasMeter ? (
                        <span
                          className={cn(
                            'gex-strike-ladder__meter',
                            positive
                              ? 'gex-strike-ladder__meter--positive'
                              : 'gex-strike-ladder__meter--negative',
                            partial && 'gex-strike-ladder__meter--partial',
                            increased && 'gex-strike-ladder__meter--increased',
                          )}
                          style={{
                            ...barPosition(meterValue, meterWidthPct),
                            height: `${meterHeight}px`,
                          }}
                          aria-hidden
                        >
                          {/* Full peak silhouette — rounded tip; empty when print is below peak. */}
                          <span className="gex-strike-ladder__meter-shell" />
                          {/* Existing live fill. A refresh increase is appended separately. */}
                          {baseFillPctOfMeter > 0 ? (
                            <span
                              className="gex-strike-ladder__meter-fill"
                              style={{ width: `${baseFillPctOfMeter}%` }}
                            />
                          ) : null}
                          {increased ? (
                            <span
                              className="gex-strike-ladder__meter-increase"
                              style={increaseSegmentPosition(
                                positive,
                                increaseStartPctOfMeter ?? 0,
                                increaseWidthPctOfMeter,
                              )}
                            />
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                    <span className={cn(
                      'gex-strike-ladder__cell gex-strike-ladder__cell--call',
                      toneClass(sideRowValues.right),
                    )} style={settings.sideRowGradient
                      ? sideRowGradientStyle(sideRowValues.right, sideRowMaxima.right, 'right')
                      : undefined}>
                      {formatSideRowValue(settings.sideRows, sideRowValues.right)}
                    </span>
                  </button>
                )
              })}

              {spotOffset != null ? (
                <>
                  {/* Line under put/call values and bars; label stacked above. */}
                  <div
                    className="gex-strike-ladder__spot-line"
                    style={{ top: `${spotOffset}px` }}
                    aria-hidden
                  />
                  <div
                    className="gex-strike-ladder__spot-label"
                    style={{ top: `${spotOffset}px` }}
                    aria-hidden
                  >
                    <span>{formatStrike(spot)}</span>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="gex-strike-ladder__empty">No {exposureLabel} strikes available</div>
        )}

        <div className="gex-strike-ladder__axis">
          <label
            className="gex-strike-ladder__axis-status"
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <select
              aria-label="Strike range"
              value={String(range)}
              onChange={(event) => setRange(parseLadderRange(event.target.value))}
            >
              {ladderRangeOptions.map((option) => (
                <option key={option} value={String(option)}>
                  {formatLadderRangeOption(option, allRows, spot)}
                </option>
              ))}
            </select>
          </label>
          <span className="gex-strike-ladder__axis-put" aria-hidden />
          <span className="gex-strike-ladder__axis-plot" aria-hidden>
            {axisTicks.map((tick, index) => {
              // Five equal slots inset from both edges so ±max labels aren't flush.
              const leftPct = ladderAxisLabelLeftPct(index, axisTicks.length)
              return (
                <i
                  key={`gex-axis-${index}-${tick}`}
                  className={cn(
                    'gex-strike-ladder__axis-tick',
                    tick === 0 && 'gex-strike-ladder__axis-tick--zero',
                  )}
                  style={{ left: `${leftPct}%` }}
                >
                  {formatGexAxisTick(tick)}
                </i>
              )
            })}
          </span>
          <span className="gex-strike-ladder__axis-call" aria-hidden />
        </div>

        {ctxMenu ? (
          <div
            className="heatmap-chart-ctx"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            role="menu"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className={cn(
                'heatmap-chart-ctx__item',
                autoFitOn && 'heatmap-chart-ctx__item--active',
              )}
              onClick={onAutoFitFromMenu}
              aria-checked={autoFitOn}
            >
              <span className="heatmap-chart-ctx__glyph" aria-hidden>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path
                    d="M1.5 3.25V1.5H3.25M6.75 1.5H8.5V3.25M8.5 6.75V8.5H6.75M3.25 8.5H1.5V6.75"
                    stroke="currentColor"
                    strokeWidth="1.15"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="heatmap-chart-ctx__label">Auto fit</span>
            </button>
          </div>
        ) : null}

        {cardDatum && hovered ? (
          <GexHoverCard
            className="gex-strike-ladder__readout"
            variant="compact"
            announce={activeStrike != null || hovered.announce}
            side={hovered.side}
            xPct={hovered.xPct}
            yPct={hovered.yPct}
            model={{
              strike: cardDatum.strike,
              netGexUsd: cardDatum.netGexUsd,
              callGexUsd: cardDatum.callGexUsd,
              putGexUsd: cardDatum.putGexUsd,
              exposureLabel,
            }}
          />
        ) : null}
      </div>
    </div>
  )
})

type StrikePaletteColors = {
  negativeStrong: string
  negativeMid: string
  negativeSoft: string
  positiveSoft: string
  positiveMid: string
  positiveStrong: string
}

function StrikeSettingsPanel({
  settings,
  onSettingsChange,
}: {
  settings: GexStrikeSettings
  onSettingsChange?: (settings: GexStrikeSettings) => void
}) {
  const exposureLabel = strikeExposureLabel(settings.metric)
  return (
    <div className="forward-surface-controls gex-strike-settings">
      <div className="forward-surface-controls__settings">
        <span className="forward-surface-controls__eyebrow">Theme</span>
        <div className="forward-surface-palettes" role="group" aria-label={`Strike ${exposureLabel} themes`}>
          {forwardGreekPalettes[settings.metric].map((palette) => (
            <button
              key={palette.id}
              type="button"
              className={cn(
                'forward-surface-palette',
                settings.paletteId === palette.id && 'forward-surface-palette--active',
              )}
              aria-label={palette.label}
              aria-pressed={settings.paletteId === palette.id}
              onClick={() => onSettingsChange?.({ ...settings, paletteId: palette.id })}
            >
              <span style={{ background: strikePaletteGradient(palette) }} />
              <small>{palette.label}</small>
            </button>
          ))}
        </div>

        <label className="forward-surface-range-control gex-strike-settings__bar-width">
          <span>Width</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={settings.barWidthPct}
            aria-label="Strike bar width"
            aria-valuetext={barWidthLabel(settings.barWidthPct)}
            onInput={(event) => onSettingsChange?.({
              ...settings,
              barWidthPct: Number(event.currentTarget.value),
            })}
          />
          <output>{barWidthLabel(settings.barWidthPct)}</output>
        </label>

        <span className="forward-surface-controls__eyebrow">Style</span>
        <div className="forward-surface-toggles" role="group" aria-label="Strike chart style">
          <StrikeSettingsToggle
            label="Gradient"
            enabled={settings.gradientBars}
            onToggle={() => onSettingsChange?.({
              ...settings,
              gradientBars: !settings.gradientBars,
            })}
          />
          <StrikeSettingsToggle
            label="Side heat"
            enabled={settings.sideRowGradient}
            onToggle={() => onSettingsChange?.({
              ...settings,
              sideRowGradient: !settings.sideRowGradient,
            })}
          />
          <StrikeSettingsToggle
            label="Grid"
            enabled={settings.showHorizontalGrid}
            onToggle={() => onSettingsChange?.({
              ...settings,
              showHorizontalGrid: !settings.showHorizontalGrid,
            })}
          />
        </div>

        <span className="forward-surface-controls__eyebrow">Side rows</span>
        <label className="gex-strike-settings__side-row-select">
          <span className="sr-only">Strike side rows</span>
          <select
            aria-label="Strike side rows"
            value={settings.sideRows ?? 'none'}
            onChange={(event) => {
              onSettingsChange?.({
                ...settings,
                sideRows: parseStrikeSideRows(event.currentTarget.value),
              })
              event.currentTarget.blur()
            }}
          >
            <option value="positiveNegativeGex">Pos / Neg {exposureLabel}</option>
            <option value="putCallGex">Put / Call {exposureLabel}</option>
            <option value="netExposureChange">Net {exposureLabel} Change</option>
            <option value="none">None</option>
          </select>
          <span aria-hidden>▾</span>
        </label>
      </div>
    </div>
  )
}

function StrikeSettingsToggle({
  label,
  enabled,
  onToggle,
}: {
  label: string
  enabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'forward-surface-toggle',
        enabled && 'forward-surface-toggle--active',
      )}
      aria-pressed={enabled}
      onClick={onToggle}
    >
      {label}
    </button>
  )
}

function parseStrikeSideRows(value: string): GexStrikeSideRows | null {
  if (value === 'putCallGex') return value
  if (value === 'positiveNegativeGex') return value
  if (value === 'netExposureChange') return value
  return null
}

function strikePaletteColors(palette: ForwardGreekPalette): StrikePaletteColors {
  const [negativeStrong, negativeMid, negativeSoft, , positiveSoft, positiveMid, positiveStrong] = palette.ramp
  return {
    negativeStrong: rgb(negativeStrong?.c),
    negativeMid: rgb(negativeMid?.c),
    negativeSoft: rgb(negativeSoft?.c),
    positiveSoft: rgb(positiveSoft?.c),
    positiveMid: rgb(positiveMid?.c),
    positiveStrong: rgb(positiveStrong?.c),
  }
}

function strikePaletteStyle(palette: ForwardGreekPalette): CSSProperties {
  const colors = strikePaletteColors(palette)
  return {
    '--chart-negative-edge': colors.negativeStrong,
    '--chart-negative': colors.negativeMid,
    '--chart-positive-edge': colors.positiveStrong,
    '--chart-positive': colors.positiveMid,
    '--gex-negative-fill': `linear-gradient(90deg, ${colors.negativeStrong}, ${colors.negativeMid} 58%, ${colors.negativeSoft})`,
    '--gex-positive-fill': `linear-gradient(90deg, ${colors.positiveSoft}, ${colors.positiveMid} 42%, ${colors.positiveStrong})`,
  } as CSSProperties
}

function strikePaletteGradient(palette: ForwardGreekPalette): string {
  return `linear-gradient(90deg, ${palette.ramp.map((stop) => {
    const pct = ((stop.t + 1) / 2) * 100
    return `${rgb(stop.c)} ${pct.toFixed(1)}%`
  }).join(', ')})`
}

function rgb(color?: { r: number; g: number; b: number }): string {
  return color ? `rgb(${color.r}, ${color.g}, ${color.b})` : 'rgb(128, 128, 128)'
}

function barWidthLabel(value: number): string {
  return `${Math.round(value)}%`
}

function strikeBarHeight(value: number, rowHeight: number): number {
  const normalized = clamp(Number.isFinite(value) ? value : 50, 0, 100)
  if (normalized <= 50) return 2 + (normalized / 50) * 6
  return 8 + ((normalized - 50) / 50) * Math.max(0, rowHeight - 10)
}

function focusFromDatum(
  datum: GexStrikeDatum,
  colors: StrikePaletteColors,
  ownerId: string,
) {
  return {
    strike: datum.strike,
    netGexUsd: datum.netGexUsd,
    ownerId,
    positiveColor: colors.positiveStrong,
    negativeColor: colors.negativeStrong,
  }
}

/**
 * Maintain a signed high-water mark per strike so wicks survive refreshes.
 * Example: -3M → -2.5M keeps the display peak at -3M while the body is -2.5M.
 * Stored peaks only expand, reset on sign flip, or clear on a new strike set.
 */
function syncPeakExtents(
  peaks: Map<number, number>,
  peakStrikeKeyRef: { current: string },
  rows: GexStrikeDatum[],
  strikeKey: string,
): Map<number, number> {
  if (peakStrikeKeyRef.current !== strikeKey) {
    peaks.clear()
    peakStrikeKeyRef.current = strikeKey
  }

  const displayPeaks = new Map<number, number>()
  const live = new Set<number>()

  for (const row of rows) {
    live.add(row.strike)
    const current = row.displayGexUsd
    const stored = peaks.get(row.strike)
    const hasStored = stored != null && Number.isFinite(stored)
    const signFlipped = hasStored
      && current !== 0
      && stored !== 0
      && Math.sign(stored) !== Math.sign(current)

    // On sign flip, drop the opposite-side peak immediately so a stale wick
    // cannot linger until the next unrelated re-render.
    const displayPeak = !hasStored || signFlipped ? current : stored
    displayPeaks.set(row.strike, displayPeak)

    if (!hasStored) {
      peaks.set(row.strike, current)
      continue
    }
    if (current === 0) {
      // Keep the prior extreme as a pure wick while the body is flat.
      continue
    }
    if (stored === 0 || signFlipped) {
      peaks.set(row.strike, current)
      continue
    }
    if (Math.abs(current) >= Math.abs(stored)) {
      peaks.set(row.strike, current)
    }
  }

  for (const strike of peaks.keys()) {
    if (!live.has(strike)) peaks.delete(strike)
  }

  return displayPeaks
}

/**
 * Capture magnitude added since the immediately preceding data refresh.
 * The result is cached for the lifetime of the current `rows` value so local
 * hover/focus renders do not consume the comparison before it can be drawn.
 */
function syncIncreaseExtents(
  previous: Map<number, number>,
  previousStrikeKeyRef: { current: string },
  frameRef: { current: IncreaseFrame | null },
  rows: GexStrikeDatum[],
  strikeKey: string,
): Map<number, number> {
  const cached = frameRef.current
  if (cached?.rows === rows && cached.strikeKey === strikeKey) {
    return cached.fromByStrike
  }

  const strikeSetChanged = previousStrikeKeyRef.current !== strikeKey
  if (strikeSetChanged) {
    previous.clear()
    previousStrikeKeyRef.current = strikeKey
  }

  const fromByStrike = new Map<number, number>()
  const live = new Set<number>()

  for (const row of rows) {
    live.add(row.strike)
    const current = row.displayGexUsd
    const prior = previous.get(row.strike)
    const sameDirection = prior != null
      && current !== 0
      && prior !== 0
      && Math.sign(current) === Math.sign(prior)

    if (
      !strikeSetChanged
      && prior != null
      && Number.isFinite(prior)
      && (sameDirection || prior === 0)
      && Math.abs(current) > Math.abs(prior)
    ) {
      fromByStrike.set(row.strike, prior)
    }

    previous.set(row.strike, current)
  }

  for (const strike of previous.keys()) {
    if (!live.has(strike)) previous.delete(strike)
  }

  frameRef.current = { rows, strikeKey, fromByStrike }
  return fromByStrike
}

/** Signed per-strike changes between consecutive live snapshot refreshes. */
function syncNetGexChanges(
  previous: Map<number, PreviousNetGexValue>,
  previousStrikeKeyRef: { current: string },
  frameRef: { current: NetGexChangeFrame | null },
  rows: GexStrikeDatum[],
  strikeKey: string,
): NetGexChangeFrame {
  const cached = frameRef.current
  if (cached?.rows === rows && cached.strikeKey === strikeKey) return cached

  const surfaceChanged = previousStrikeKeyRef.current !== strikeKey
  if (surfaceChanged) {
    previous.clear()
    previousStrikeKeyRef.current = strikeKey
  }

  const gexDeltaByStrike = new Map<number, number>()
  const live = new Set<number>()

  for (const row of rows) {
    live.add(row.strike)
    const prior = previous.get(row.strike)
    gexDeltaByStrike.set(
      row.strike,
      prior && !surfaceChanged ? row.netGexUsd - prior.netGexUsd : 0,
    )
    previous.set(row.strike, {
      netGexUsd: row.netGexUsd,
    })
  }

  for (const strike of previous.keys()) {
    if (!live.has(strike)) previous.delete(strike)
  }

  const frame = { rows, strikeKey, gexDeltaByStrike }
  frameRef.current = frame
  return frame
}

/** Retain every valid row in the selected expiry surface; never trim by mass. */
function prepareAllRows(data: GexStrikeDatum[]): GexStrikeDatum[] {
  const byStrike = new Map<number, GexStrikeDatum>()
  for (const row of data) {
    if (!(row.strike > 0) || !Number.isFinite(row.strike) || !Number.isFinite(row.displayGexUsd)) {
      continue
    }
    byStrike.set(row.strike, row)
  }
  return [...byStrike.values()].sort((a, b) => b.strike - a.strike)
}

function selectLadderRange(
  rows: GexStrikeDatum[],
  spot: number,
  range: LadderRange,
): GexStrikeDatum[] {
  if (range === 'full' || rows.length === 0 || !(spot > 0)) return rows
  const selected = rows.filter((row) => Math.abs(((row.strike - spot) / spot) * 100) <= range)
  if (selected.length > 0) return selected
  return [rows[nearestStrikeIndex(rows, spot)]!]
}

function parseLadderRange(value: string): LadderRange {
  if (value === '5') return 5
  if (value === '10') return 10
  if (value === '20') return 20
  return 'full'
}

function formatLadderRangeOption(
  range: LadderRange,
  rows: GexStrikeDatum[],
  spot: number,
): string {
  if (range === 'full') return `Full · ${rows.length}`
  return `±${range}% · ${selectLadderRange(rows, spot, range).length}`
}

function barPosition(value: number, widthPct: number): CSSProperties {
  return value >= 0
    ? { left: '50%', width: `${widthPct}%` }
    : { right: '50%', width: `${widthPct}%` }
}

function increaseSegmentPosition(
  positive: boolean,
  startPct: number,
  widthPct: number,
): CSSProperties {
  return positive
    ? { left: `${startPct}%`, width: `${widthPct}%` }
    : { right: `${startPct}%`, width: `${widthPct}%` }
}

function toneClass(value: number) {
  if (value > 0) return 'gex-strike-ladder__cell--positive'
  if (value < 0) return 'gex-strike-ladder__cell--negative'
  return 'gex-strike-ladder__cell--zero'
}

type SideRowLabels = { left: string; right: string }
type SideRowValues = { left: number; right: number }

function getSideRowMaxima(
  rows: GexStrikeDatum[],
  sideRows: GexStrikeSideRows | null,
  gexDeltaByStrike: Map<number, number>,
): SideRowValues {
  let left = 0
  let right = 0
  for (const datum of rows) {
    const values = getSideRowValues(
      sideRows,
      datum,
      gexDeltaByStrike.get(datum.strike) ?? 0,
    )
    left = Math.max(left, Math.abs(values.left))
    right = Math.max(right, Math.abs(values.right))
  }
  return { left, right }
}

function sideRowGradientStyle(
  value: number,
  maxMagnitude: number,
  side: 'left' | 'right',
): CSSProperties | undefined {
  if (!Number.isFinite(value) || value === 0 || !(maxMagnitude > 0)) return undefined
  // A square-root scale keeps quieter strikes legible without letting them
  // compete with the largest cell on either side of the ladder.
  const intensity = Math.sqrt(clamp(Math.abs(value) / maxMagnitude, 0, 1))
  const color = value < 0 ? 'var(--chart-negative-edge)' : 'var(--chart-positive-edge)'
  const tint = `color-mix(in srgb, ${color} ${(4 + intensity * 30).toFixed(1)}%, transparent)`
  return {
    background: side === 'left'
      ? `linear-gradient(90deg, transparent 0%, ${tint} 100%)`
      : `linear-gradient(90deg, ${tint} 0%, transparent 100%)`,
  }
}

function strikeExposureLabel(metric: GexStrikeSettings['metric']): 'GEX' | 'DEX' {
  return metric === 'delta' ? 'DEX' : 'GEX'
}

function getSideRowLabels(
  sideRows: GexStrikeSideRows | null,
  exposureLabel: 'GEX' | 'DEX',
): SideRowLabels {
  if (sideRows === 'putCallGex') {
    return { left: `Put ${exposureLabel}`, right: `Call ${exposureLabel}` }
  }
  if (sideRows === 'positiveNegativeGex') {
    return { left: `Neg ${exposureLabel}`, right: `Pos ${exposureLabel}` }
  }
  if (sideRows === 'netExposureChange') {
    return { left: `Neg Δ${exposureLabel}`, right: `Pos Δ${exposureLabel}` }
  }
  return { left: '', right: '' }
}

function getSideRowValues(
  sideRows: GexStrikeSideRows | null,
  datum: GexStrikeDatum,
  gexDelta: number,
): SideRowValues {
  if (sideRows === 'putCallGex') {
    return { left: datum.putGexUsd, right: datum.callGexUsd }
  }
  if (sideRows === 'positiveNegativeGex') {
    return { left: Math.min(datum.negativeGexUsd, 0), right: Math.max(datum.positiveGexUsd, 0) }
  }
  if (sideRows === 'netExposureChange') {
    return { left: Math.min(gexDelta, 0), right: Math.max(gexDelta, 0) }
  }
  return { left: 0, right: 0 }
}

function formatSideRowValue(sideRows: GexStrikeSideRows | null, value: number): string {
  if (sideRows == null) return ''
  return formatCompactGex(value)
}

function formatSideRowAria(labels: SideRowLabels, values: SideRowValues): string {
  if (!labels.left || !labels.right) return ''
  return `, ${labels.left} ${formatCompactGex(values.left)}, ${labels.right} ${formatCompactGex(values.right)}`
}

function formatCompactGex(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.5) return '0'
  const sign = value > 0 ? '+' : '-'
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000_000) {
    return `${sign}${trimFixed(absolute / 1_000_000_000, 2)}B`
  }
  if (absolute >= 1_000_000) {
    return `${sign}${trimFixed(absolute / 1_000_000, absolute >= 10_000_000 ? 1 : 2)}M`
  }
  if (absolute >= 1_000) {
    return `${sign}${trimFixed(absolute / 1_000, absolute >= 100_000 ? 0 : 1)}K`
  }
  return `${sign}${Math.round(absolute)}`
}

function trimFixed(value: number, digits: number): string {
  const fixed = value.toFixed(digits)
  return digits === 0 ? fixed : fixed.replace(/\.?0+$/, '')
}

function nearestStrikeIndex(rows: GexStrikeDatum[], strike: number): number {
  if (rows.length === 0 || !Number.isFinite(strike)) return Math.floor(rows.length / 2)
  let best = 0
  let distance = Math.abs(rows[0]!.strike - strike)
  for (let index = 1; index < rows.length; index += 1) {
    const nextDistance = Math.abs(rows[index]!.strike - strike)
    if (nextDistance < distance) {
      best = index
      distance = nextDistance
    }
  }
  return best
}

/** Interpolate the live index between descending categorical strike rows. */
function strikeToRowIndex(rows: GexStrikeDatum[], strike: number): number | null {
  if (rows.length === 0 || !(strike > 0) || !Number.isFinite(strike)) return null
  if (rows.length === 1) return Math.abs(rows[0]!.strike - strike) < 1e-9 ? 0 : null
  if (strike > rows[0]!.strike || strike < rows[rows.length - 1]!.strike) return null

  for (let index = 0; index < rows.length - 1; index += 1) {
    const upper = rows[index]!.strike
    const lower = rows[index + 1]!.strike
    if (strike <= upper && strike >= lower) {
      if (upper === lower) return index
      return index + (upper - strike) / (upper - lower)
    }
  }
  return null
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Even label slots across the plot with mirrored edge inset.
 * Bars still map 0→100% of the lane; labels sit slightly inside so ±max
 * (e.g. ±$10M) aren't crushed against the put/call column borders.
 */
const LADDER_AXIS_EDGE_INSET = 0.09

function ladderAxisLabelLeftPct(index: number, count: number): number {
  const last = Math.max(count - 1, 1)
  const t = index / last
  const inset = LADDER_AXIS_EDGE_INSET
  return (inset + t * (1 - 2 * inset)) * 100
}
