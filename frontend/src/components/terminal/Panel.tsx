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
        <div className="mb-2 flex items-center gap-3">
          <h2 className="whitespace-nowrap text-[14px] uppercase tracking-[0.08em] text-[#e8ded0]">{title}</h2>
          <div className="terminal-divider h-px flex-1" />
        </div>
      ) : null}
      {children}
    </section>
  )
}
