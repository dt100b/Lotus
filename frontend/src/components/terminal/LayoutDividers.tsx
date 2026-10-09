import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { cn } from '@/lib/utils'

type DividerProps = {
  orientation: 'horizontal' | 'vertical'
  onDrag: (deltaPx: number) => void
  /** Called when pointer is released — use for snap-to-grid. */
  onDragEnd?: () => void
  className?: string
  label?: string
  beforePct?: number
  afterPct?: number
  /** Double click returns the adjacent tracks to an even split. */
  onReset?: () => void
}

/**
 * Pointer-driven resize gutter between panes.
 * Horizontal = row split (deltaY); vertical = column split (deltaX).
 *
 * Uses rAF-coalesced deltas so resize stays smooth under high pointer rates.
 */
export function LayoutDivider({
  orientation,
  onDrag,
  onDragEnd,
  className,
  label,
  beforePct,
  afterPct,
  onReset,
}: DividerProps) {
  const dragging = useRef(false)
  const last = useRef(0)
  const pendingDelta = useRef(0)
  const rafId = useRef(0)
  const [active, setActive] = useState(false)

  const flushDelta = useCallback(() => {
    rafId.current = 0
    const d = pendingDelta.current
    pendingDelta.current = 0
    if (d !== 0) onDrag(d)
  }, [onDrag])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      dragging.current = true
      setActive(true)
      last.current = orientation === 'horizontal' ? event.clientY : event.clientX
      pendingDelta.current = 0
      event.currentTarget.setPointerCapture(event.pointerId)
      document.body.style.cursor = orientation === 'horizontal' ? 'row-resize' : 'col-resize'
      document.body.style.userSelect = 'none'
      document.documentElement.dataset.layoutResizing = orientation
    },
    [orientation],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      const next = orientation === 'horizontal' ? event.clientY : event.clientX
      const delta = next - last.current
      last.current = next
      if (delta === 0) return
      pendingDelta.current += delta
      if (!rafId.current) {
        rafId.current = window.requestAnimationFrame(flushDelta)
      }
    },
    [flushDelta, orientation],
  )

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      dragging.current = false
      setActive(false)
      if (rafId.current) {
        window.cancelAnimationFrame(rafId.current)
        rafId.current = 0
      }
      if (pendingDelta.current !== 0) {
        const d = pendingDelta.current
        pendingDelta.current = 0
        onDrag(d)
      }
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // already released
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      delete document.documentElement.dataset.layoutResizing
      onDragEnd?.()
    },
    [onDrag, onDragEnd],
  )

  const isH = orientation === 'horizontal'

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const negativeKey = isH ? 'ArrowUp' : 'ArrowLeft'
      const positiveKey = isH ? 'ArrowDown' : 'ArrowRight'
      if (event.key !== negativeKey && event.key !== positiveKey) return

      event.preventDefault()
      const step = event.shiftKey ? 24 : 8
      onDrag(event.key === negativeKey ? -step : step)
    },
    [isH, onDrag],
  )

  const splitLabel = beforePct !== undefined && afterPct !== undefined
    ? `${Math.round(beforePct)} / ${Math.round(afterPct)}`
    : undefined

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label ?? (isH ? 'Resize rows' : 'Resize columns')}
      aria-valuemin={14}
      aria-valuemax={86}
      aria-valuenow={beforePct !== undefined ? Math.round(beforePct) : undefined}
      aria-valuetext={splitLabel}
      tabIndex={0}
      className={cn(
        'layout-divider',
        isH ? 'layout-divider--horizontal' : 'layout-divider--vertical',
        active && 'layout-divider--active',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    >
      <span className="layout-divider__hit" />
      <span className="layout-divider__line" />
      <span className="layout-divider__grip" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {active && splitLabel ? (
        <output className="layout-divider__readout" aria-live="off">
          {Math.round(beforePct ?? 0)}<i />{Math.round(afterPct ?? 0)}
        </output>
      ) : null}
    </div>
  )
}

type ResplitEdgeProps = {
  side: 'left' | 'right' | 'top' | 'bottom'
  /** Open empty sibling near the edge so drag can continue smoothly. */
  onBeginDrag: () => void
  /** Click without drag restores a balanced 50/50 split. */
  onClickRestore: () => void
  onDrag: (deltaPx: number) => void
  onDragEnd?: () => void
  label?: string
}

/**
 * Thin edge handle on a flush (absorbed) pane.
 * Drag inward re-opens the empty sibling and continues as a resize;
 * click restores 50/50.
 */
export function PaneResplitEdge({
  side,
  onBeginDrag,
  onClickRestore,
  onDrag,
  onDragEnd,
  label,
}: ResplitEdgeProps) {
  const dragging = useRef(false)
  const began = useRef(false)
  const last = useRef(0)
  const pendingDelta = useRef(0)
  const rafId = useRef(0)
  const [active, setActive] = useState(false)
  const vertical = side === 'top' || side === 'bottom'

  const flushDelta = useCallback(() => {
    rafId.current = 0
    const d = pendingDelta.current
    pendingDelta.current = 0
    if (d !== 0) onDrag(d)
  }, [onDrag])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragging.current = true
      began.current = false
      setActive(true)
      last.current = vertical ? event.clientY : event.clientX
      pendingDelta.current = 0
      event.currentTarget.setPointerCapture(event.pointerId)
      document.body.style.cursor = vertical ? 'row-resize' : 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [vertical],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!dragging.current) return
      const next = vertical ? event.clientY : event.clientX
      const delta = next - last.current
      last.current = next
      if (delta === 0) return

      if (!began.current) {
        // Inward toward the empty sibling.
        const inward =
          side === 'right' ? delta > 0
            : side === 'left' ? delta < 0
              : side === 'bottom' ? delta > 0
                : delta < 0
        if (!inward && Math.abs(delta) < 2) return
        began.current = true
        onBeginDrag()
      }

      pendingDelta.current += delta
      if (!rafId.current) {
        rafId.current = window.requestAnimationFrame(flushDelta)
      }
    },
    [flushDelta, onBeginDrag, side, vertical],
  )

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!dragging.current) return
      dragging.current = false
      setActive(false)
      if (rafId.current) {
        window.cancelAnimationFrame(rafId.current)
        rafId.current = 0
      }
      if (pendingDelta.current !== 0) {
        const d = pendingDelta.current
        pendingDelta.current = 0
        onDrag(d)
      }
      if (!began.current) {
        onClickRestore()
      }
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // already released
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (began.current) onDragEnd?.()
    },
    [onClickRestore, onDrag, onDragEnd],
  )

  return (
    <button
      type="button"
      aria-label={label ?? 'Restore split pane'}
      className={cn(
        'absolute z-20 touch-none border-0 bg-transparent p-0 outline-none',
        vertical ? 'inset-x-0 h-2 cursor-row-resize' : 'inset-y-0 w-2 cursor-col-resize',
        side === 'right' && 'right-0',
        side === 'left' && 'left-0',
        side === 'top' && 'top-0',
        side === 'bottom' && 'bottom-0',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <span
        className={cn(
          'pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all',
          vertical ? 'h-[2px] w-10' : 'h-10 w-[2px]',
          active
            ? cn('bg-[var(--terminal-heading)] opacity-95', vertical ? 'w-14' : 'h-14')
            : 'bg-[var(--terminal-border)] opacity-0 hover:opacity-70',
        )}
      />
    </button>
  )
}
