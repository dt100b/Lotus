import { useEffect, useRef, useState } from 'react'
import { gexModeLabels, gexModes, type GexModeOption } from '@/components/terminal/gexModes'
import type { PaneDragHandleProps } from '@/components/terminal/PaneWorkspace'
import { cn } from '@/lib/utils'

export type PanelFillOption = { kind: 'chart'; mode: GexModeOption; label: string }

const panelFillOptions: PanelFillOption[] = [
  ...gexModes.map((mode) => ({
    kind: 'chart' as const,
    mode,
    label: gexModeLabels[mode],
  })),
]

type EmptyPanelSlotProps = {
  onFill: (option: PanelFillOption) => void
  /** Remove this blank slot from the workspace (reflows grid). */
  onRemove?: () => void
  dragHandleProps?: PaneDragHandleProps
  className?: string
}

/**
 * Quiet reserved slot. Labels only on hover; right-click opens a compact fill menu.
 *
 * Fonts use CSS transform scale (not raw sub-10px sizes) — browsers clamp min font-size
 * so Tailwind text-[8px] never actually renders that small.
 */
export function EmptyPanelSlot({ onFill, onRemove, dragHandleProps, className }: EmptyPanelSlotProps) {
  const [hovered, setHovered] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  return (
    <section
      ref={rootRef}
      className={cn(
        'empty-pane relative flex h-full min-h-0 min-w-0 flex-col items-center justify-center overflow-hidden',
        'rounded-[var(--terminal-radius)] border border-dashed border-[var(--terminal-border)]/40',
        'bg-[color-mix(in_srgb,var(--terminal-bg)_92%,var(--terminal-surface))]',
        'transition-[border-color,background-color] duration-150',
        (hovered || menu) && 'border-[var(--terminal-border)]/80 bg-[var(--terminal-surface)]/30',
        className,
      )}
      aria-label="Empty panel — right-click to add a view"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        const menuW = 108
        // Strike + Price + 0DTE γ (+ optional Remove)
        const menuH = onRemove ? 178 : 158
        setMenu({
          x: Math.min(event.clientX, window.innerWidth - menuW - 6),
          y: Math.min(event.clientY, window.innerHeight - menuH - 6),
        })
      }}
    >
      {dragHandleProps ? (
        <div
          className="pane-drag-handle empty-pane__drag"
          aria-label="Drag to reposition panel"
          {...dragHandleProps}
        >
          <DragGlyph />
        </div>
      ) : null}

      <div
        className={cn(
          'pointer-events-none select-none text-center transition-opacity duration-150',
          hovered || menu ? 'opacity-100' : 'opacity-0',
        )}
      >
        <div className="empty-pane__label">Empty</div>
        <div className="empty-pane__hint">Right-click to add</div>
      </div>

      {menu ? (
        <div
          className="empty-pane-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="empty-pane-menu__heading">Add view</div>
          <div className="empty-pane-menu__rule" />
          {panelFillOptions.map((option) => {
            const key = option.mode
            return (
              <div key={key}>
                <button
                  type="button"
                  role="menuitem"
                  className="empty-pane-menu__item"
                  onClick={() => {
                    onFill(option)
                    setMenu(null)
                  }}
                >
                  <span className="empty-pane-menu__item-label">{option.label}</span>
                </button>
              </div>
            )
          })}
          {onRemove ? (
            <>
              <div className="empty-pane-menu__rule" />
              <button
                type="button"
                role="menuitem"
                className="empty-pane-menu__item empty-pane-menu__item--danger"
                onClick={() => {
                  onRemove()
                  setMenu(null)
                }}
              >
                <span className="empty-pane-menu__item-label">Remove</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function DragGlyph() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden className="opacity-70">
      <circle cx="3" cy="3" r="1.1" fill="currentColor" />
      <circle cx="7" cy="3" r="1.1" fill="currentColor" />
      <circle cx="3" cy="7" r="1.1" fill="currentColor" />
      <circle cx="7" cy="7" r="1.1" fill="currentColor" />
      <circle cx="3" cy="11" r="1.1" fill="currentColor" />
      <circle cx="7" cy="11" r="1.1" fill="currentColor" />
    </svg>
  )
}
