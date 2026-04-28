import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type PanelProps = {
  title?: string
  className?: string
  children: ReactNode
}

export function Panel({ title, className, children }: PanelProps) {
  return (
    <section className={cn('terminal-panel relative', className)}>
      {title ? (
        <div className="mb-2 flex items-center">
          <h2 className="terminal-title whitespace-nowrap">{title}</h2>
        </div>
      ) : null}
      {children}
    </section>
  )
}
