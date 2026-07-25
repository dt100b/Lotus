import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

type PanelCloseButtonProps = {
  label?: string
  onClose: () => void
}

/** Compact close control for dashboard panes. */
export function PanelCloseButton({ label = 'Close panel', onClose }: PanelCloseButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-5 min-h-5 max-h-5 w-5 min-w-5 max-w-5 shrink-0 border-transparent bg-transparent px-0 text-[var(--desk-label)] hover:bg-[var(--terminal-surface-2)] hover:text-[var(--desk-value)]"
      aria-label={label}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <X className="h-[11px] w-[11px]" />
    </Button>
  )
}
