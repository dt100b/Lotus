import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type PanelProps = {
  title?: string
  titleAccessory?: ReactNode
  className?: string
  children: ReactNode
}

export function Panel({ title, titleAccessory, className, children }: PanelProps) {
  return (
    <section className={cn('terminal-panel relative', className)}>
      {title ? (
        <div className={cn('flex items-center gap-2', children ? 'mb-2' : '')}>
          <h2 className="terminal-title whitespace-nowrap">{title}</h2>
          {titleAccessory ? (
            <div className="ml-auto flex items-center">{titleAccessory}</div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}
