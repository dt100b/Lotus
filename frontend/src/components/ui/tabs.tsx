/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

export const Tabs = TabsPrimitive.Root

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-[26px] overflow-hidden rounded-[var(--terminal-control-radius)] border border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]',
      className,
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex min-w-[58px] items-center justify-center border-r border-[var(--terminal-control-border)] px-3 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-text)] transition-colors duration-150 last:border-r-0 hover:bg-[var(--terminal-surface-2)] hover:text-[var(--terminal-heading)] data-[state=active]:border-[var(--terminal-active-border)] data-[state=active]:bg-[rgba(101,136,76,0.24)] data-[state=active]:text-[var(--terminal-green-strong)] data-[state=active]:shadow-[inset_0_0_0_1px_rgba(137,180,102,0.45)]',
      className,
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName
