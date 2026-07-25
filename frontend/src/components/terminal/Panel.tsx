import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type PanelProps = {
  title?: string
  titleAccessory?: ReactNode
  className?: string
  children: ReactNode
}

export function Panel({ title, titleAccessory, className, children }: PanelProps) {
  const showHeader = Boolean(title || titleAccessory)
  return (
    <section className={cn('terminal-panel relative min-w-0 overflow-hidden', className)}>
      {showHeader ? (
        <div className={cn('flex min-w-0 items-center gap-1.5', children ? 'mb-2' : '')}>
          {title ? (
            <h2 className="terminal-title min-w-0 flex-1 truncate whitespace-nowrap">{title}</h2>
          ) : (
            <div className="min-w-0 flex-1" />
          )}
          {titleAccessory ? (
            <div className="ml-auto flex shrink-0 items-center">{titleAccessory}</div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}
