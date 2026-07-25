import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import {
  defaultHeatmapIntensity,
  getHeatmapPalettePreviewCss,
  heatmapPalettes,
  maxHeatmapIntensity,
  minHeatmapIntensity,
  type HeatmapPaletteId,
} from '@/data/heatmapPalettes'
import { useTerminalStore } from '@/store/terminalStore'
import { cn } from '@/lib/utils'

type HeatmapPaletteSelectProps = {
  value: HeatmapPaletteId
  onValueChange: (value: HeatmapPaletteId) => void
  className?: string
}

/**
 * Compact visual palette picker — gradient strips + TRACE intensity slider.
 * Menu is portaled to document.body so terminal-frame overflow:hidden cannot clip it.
 */
export function HeatmapPaletteSelect({
  value,
  onValueChange,
  className,
}: HeatmapPaletteSelectProps) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const active = heatmapPalettes.find((palette) => palette.id === value) ?? heatmapPalettes[0]!
  const intensity = useTerminalStore((state) => state.heatmapIntensity)
  const setHeatmapIntensity = useTerminalStore((state) => state.setHeatmapIntensity)

  useLayoutEffect(() => {
    if (!open || !rootRef.current) {
      setMenuPos(null)
      return
    }
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const menuW = 156
      const menuH = menuRef.current?.offsetHeight ?? 280
      const left = Math.min(
        Math.max(6, rect.right - menuW),
        window.innerWidth - menuW - 6,
      )
      const below = rect.bottom + 4
      const top = below + menuH > window.innerHeight - 6
        ? Math.max(6, rect.top - menuH - 4)
        : below
      setMenuPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

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
    <div ref={rootRef} className={cn('relative shrink-0', className)}>
      <button
        type="button"
        aria-label={`Heatmap color template: ${active.label}, intensity ${intensity}%`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          'chart-chrome-control inline-flex h-5 min-h-5 max-h-5 w-[68px] min-w-[68px] max-w-[68px] items-center gap-1 rounded-[var(--terminal-control-radius)] border border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] px-1.5 shadow-[var(--terminal-control-inset)] transition-colors',
          'hover:border-[var(--terminal-border-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-green)]',
          open && 'border-[var(--terminal-active-border)] bg-[var(--terminal-active-bg)]',
        )}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen((prev) => !prev)
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <HeatmapPaletteStrip paletteId={value} className="h-[9px] min-w-0 flex-1" />
        <ChevronDown className="h-2.5 w-2.5 shrink-0 text-[var(--terminal-muted)]" />
      </button>

      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              role="dialog"
              aria-label="Heatmap surface style"
              className="fixed z-[100] max-h-[min(420px,70vh)] w-[156px] overflow-y-auto overflow-x-hidden rounded-[var(--terminal-radius-sm)] border border-[var(--terminal-border-strong)] bg-[var(--terminal-surface)] p-1.5 shadow-2xl"
              style={{ top: menuPos.top, left: menuPos.left }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-1 px-1 text-[8px] font-semibold uppercase tracking-[0.12em] text-[var(--terminal-muted)]">
                Palette
              </div>
              <div role="listbox" aria-label="Heatmap color templates" className="grid gap-0.5">
                {heatmapPalettes.map((palette) => {
                  const selected = palette.id === value
                  return (
                    <button
                      key={palette.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-label={palette.label}
                      className={cn(
                        'flex w-full items-center justify-center rounded-[2px] px-2 py-1.5 transition-colors',
                        'hover:bg-[var(--terminal-surface-2)] focus:outline-none focus-visible:bg-[var(--terminal-surface-2)]',
                        selected && 'bg-[var(--terminal-active-bg)] ring-1 ring-inset ring-[var(--terminal-active-border)]',
                      )}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        onValueChange(palette.id)
                      }}
                    >
                      <HeatmapPaletteStrip paletteId={palette.id} className="h-[11px] w-[56px]" />
                    </button>
                  )
                })}
              </div>

              <div className="mt-1.5 border-t border-[var(--terminal-rule)] px-1 pt-1.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[8px] font-semibold uppercase tracking-[0.12em] text-[var(--terminal-muted)]">
                    Intensity
                  </span>
                  <span className="terminal-value text-[9px] font-semibold tabular-nums text-[var(--terminal-heading)]">
                    {intensity}%
                  </span>
                </div>
                <input
                  type="range"
                  min={minHeatmapIntensity}
                  max={maxHeatmapIntensity}
                  step={1}
                  value={intensity}
                  aria-label="Heatmap surface intensity"
                  className="heatmap-intensity-slider h-[14px] w-full cursor-pointer accent-[var(--terminal-heading)]"
                  onChange={(event) => {
                    setHeatmapIntensity(Number(event.target.value))
                  }}
                  onDoubleClick={() => setHeatmapIntensity(defaultHeatmapIntensity)}
                />
                <div className="mt-0.5 flex justify-between text-[7.5px] uppercase tracking-[0.08em] text-[var(--terminal-subtle)]">
                  <span>Soft</span>
                  <span>Full</span>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function HeatmapPaletteStrip({
  paletteId,
  className,
}: {
  paletteId: HeatmapPaletteId
  className?: string
}) {
  // Outer clips the fill flush to rounded ends; hairline lives outside the fill
  // so border anti-aliasing cannot bleed opposite ramp colors into the corners.
  return (
    <span
      aria-hidden
      className={cn(
        'relative block overflow-hidden rounded-[2px] ring-1 ring-inset ring-[color:var(--terminal-border)]',
        className,
      )}
    >
      <span
        className="absolute inset-0 block"
        style={{ backgroundImage: getHeatmapPalettePreviewCss(paletteId) }}
      />
    </span>
  )
}
