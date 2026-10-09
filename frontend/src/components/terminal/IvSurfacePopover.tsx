import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

type IvSurfacePopoverProps = {
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  align?: 'end' | 'start'
}

export function IvSurfacePopover({
  label,
  open,
  onOpenChange,
  children,
  align = 'end',
}: IvSurfacePopoverProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [onOpenChange, open])

  const onTriggerKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpenChange(true)
    }
  }

  return (
    <div ref={rootRef} className={cn('iv-surface-popover', open && 'is-open')}>
      <button
        type="button"
        className="iv-surface-popover__trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
        onKeyDown={onTriggerKey}
      >
        {label}
        <ChevronDown aria-hidden />
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          className={cn('iv-surface-popover__panel', align === 'start' && 'iv-surface-popover__panel--start')}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}
