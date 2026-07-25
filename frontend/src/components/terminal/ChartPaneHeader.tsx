import {
  startTransition,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { PanelCloseButton } from '@/components/terminal/PanelCloseButton'
import type { PaneDragHandleProps } from '@/components/terminal/PaneWorkspace'
import type { GexExpiry } from '@/api/mockGexData'
import { usePrefetchTerminalSnapshots } from '@/hooks/useTerminalSnapshot'
import { cn } from '@/lib/utils'

export type HeaderDensity = 'full' | 'mid' | 'tight'

/**
 * Progressive chrome from header width:
 *  full  — single-row desk chrome
 *  mid   — tighter padding, optional wrap
 *  tight — hide title text, compact segments, short expiry values
 */
export function useHeaderDensity(ref: RefObject<HTMLElement | null>): HeaderDensity {
  const [density, setDensity] = useState<HeaderDensity>('full')

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = () => {
      const w = el.clientWidth
      if (w < 420) setDensity('tight')
      else if (w < 620) setDensity('mid')
      else setDensity('full')
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return density
}

/**
 * Shared desk header for every chart mode.
 *
 * Primary row: title + left (view modes) | right (expiry / actions)
 * Toolbar row: always present so Strike / Bands / Table headers
 * share the same height (Heatmap fills it with TF + GEX; others reserve
 * the band so side-by-side panes align). Mode tools go here (TF, GEX, etc.).
 */
export function ChartPaneHeader({
  title,
  left,
  right,
  toolbar,
  className,
}: {
  title: string
  left?: ReactNode
  right?: ReactNode
  /** Second-row tools (TF, GEX opacity, etc.). Empty still reserves height. */
  toolbar?: ReactNode
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const density = useHeaderDensity(rootRef)

  return (
    <div
      ref={rootRef}
      className={cn(
        'chart-pane-header',
        'chart-pane-header--has-toolbar',
        density === 'mid' && 'chart-pane-header--mid',
        density === 'tight' && 'chart-pane-header--tight',
        className,
      )}
      data-density={density}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="chart-pane-header__row">
        <div className="chart-pane-header__left">
          <span className="chart-pane-header__title" title={title}>
            {title}
          </span>
          {left}
        </div>
        {right ? <div className="chart-pane-header__right">{right}</div> : null}
      </div>
      <div
        className={cn(
          'chart-pane-header__toolbar',
          !toolbar && 'chart-pane-header__toolbar--empty',
        )}
        aria-hidden={!toolbar || undefined}
      >
        {toolbar ?? null}
      </div>
    </div>
  )
}

/** Segmented pill group (TF, chart mode, etc.). */
export function ChartSegmentGroup({
  children,
  label,
  className,
  pending = false,
}: {
  children: ReactNode
  label?: string
  className?: string
  pending?: boolean
}) {
  return (
    <div
      className={cn(
        'chart-pane-header__segments',
        pending && 'chart-pane-header__segments--pending',
        className,
      )}
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  )
}

export function ChartSegmentButton({
  active,
  children,
  shortLabel,
  onClick,
  disabled,
  className,
  'aria-busy': ariaBusy,
}: {
  active?: boolean
  children: ReactNode
  /** Shown under --tight density via CSS [data-short] swap. */
  shortLabel?: string
  onClick?: () => void
  disabled?: boolean
  className?: string
  'aria-busy'?: boolean
}) {
  return (
    <button
      type="button"
      className={cn(
        'chart-pane-header__segment',
        active && 'chart-pane-header__segment--active',
        shortLabel && 'chart-pane-header__segment--has-short',
        className,
      )}
      aria-pressed={active}
      aria-busy={ariaBusy}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="chart-pane-header__segment-full">{children}</span>
      {shortLabel ? (
        <span className="chart-pane-header__segment-short" aria-hidden>
          {shortLabel}
        </span>
      ) : null}
    </button>
  )
}

/** Quiet expiry control — no amber flash on open. Density-aware labels. */
export type ExpiryOption = {
  value: GexExpiry
  label: string
  shortLabel?: string
}

export function ChartExpirySelect({
  expiry,
  expiryOptions,
  onExpiryChange,
  className,
}: {
  expiry: GexExpiry
  expiryOptions: ExpiryOption[]
  onExpiryChange: (expiry: GexExpiry) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const prefetch = usePrefetchTerminalSnapshots()

  const active = expiryOptions.find((o) => o.value === expiry)
  const fullLabel = active?.label ?? (expiry === 'ALL' ? 'ALL' : String(expiry))
  const shortLabel = active?.shortLabel ?? shortExpiryFallback(expiry, fullLabel)

  useLayoutEffect(() => {
    if (!open || !rootRef.current) {
      setMenuPos(null)
      return
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const menuW = Math.max(128, rect.width)
      const menuH = menuRef.current?.offsetHeight ?? 220
      const left = Math.min(
        Math.max(6, rect.right - menuW),
        window.innerWidth - menuW - 6,
      )
      const below = rect.bottom + 4
      const top =
        below + menuH > window.innerHeight - 6
          ? Math.max(6, rect.top - menuH - 4)
          : below
      setMenuPos({ top, left, width: menuW })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, expiryOptions.length])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      className={cn('chart-pane-header__expiry-wrap', className)}
    >
      <button
        type="button"
        className={cn(
          'chart-pane-header__expiry-btn',
          open && 'chart-pane-header__expiry-btn--open',
        )}
        aria-label={`GEX expiry: ${fullLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        title={fullLabel}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen((value) => {
            const next = !value
            if (next) prefetch(expiryOptions.map((o) => o.value))
            return next
          })
        }}
      >
        <span className="chart-pane-header__expiry-value chart-pane-header__expiry-value--full">
          {fullLabel}
        </span>
        <span className="chart-pane-header__expiry-value chart-pane-header__expiry-value--short" aria-hidden>
          {shortLabel}
        </span>
        <span className="chart-pane-header__expiry-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              role="listbox"
              aria-label="GEX expiry"
              className="chart-pane-header__expiry-menu"
              style={{ top: menuPos.top, left: menuPos.left, minWidth: menuPos.width }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {expiryOptions.map((option) => {
                const selected = option.value === expiry
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={cn(
                      'chart-pane-header__expiry-option',
                      selected && 'chart-pane-header__expiry-option--active',
                    )}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setOpen(false)
                      if (option.value === expiry) return
                      startTransition(() => onExpiryChange(option.value))
                    }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

/** Drag grip + close cluster for pane chrome. */
export function ChartPaneActions({
  dragHandleProps,
  onClose,
}: {
  dragHandleProps?: PaneDragHandleProps
  onClose?: () => void
}) {
  if (!dragHandleProps && !onClose) return null
  return (
    <div className="chart-pane-header__actions">
      {dragHandleProps ? <PaneDragHandle dragHandleProps={dragHandleProps} /> : null}
      {onClose ? <PanelCloseButton onClose={onClose} /> : null}
    </div>
  )
}

export function PaneDragHandle({ dragHandleProps }: { dragHandleProps?: PaneDragHandleProps }) {
  if (!dragHandleProps) return null
  return (
    <div
      className="pane-drag-handle"
      aria-label="Drag to reposition panel"
      {...dragHandleProps}
    >
      <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden className="opacity-70">
        <circle cx="3" cy="3" r="1.1" fill="currentColor" />
        <circle cx="7" cy="3" r="1.1" fill="currentColor" />
        <circle cx="3" cy="7" r="1.1" fill="currentColor" />
        <circle cx="7" cy="7" r="1.1" fill="currentColor" />
        <circle cx="3" cy="11" r="1.1" fill="currentColor" />
        <circle cx="7" cy="11" r="1.1" fill="currentColor" />
      </svg>
    </div>
  )
}

function shortExpiryFallback(expiry: GexExpiry, fullLabel: string): string {
  if (expiry === 'ALL') return 'ALL'
  if (fullLabel === '0DTE') return '0DTE'
  // Prefer the raw Deribit code when the full label is a long tenor string.
  if (expiry !== 'ALL' && fullLabel.length > 10) return String(expiry)
  if (fullLabel.length <= 10) return fullLabel
  return String(expiry).slice(0, 8)
}
