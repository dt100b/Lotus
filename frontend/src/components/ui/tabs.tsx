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
      'inline-flex h-10 overflow-hidden rounded-[4px] border border-[#4b5556] bg-[#05090b] shadow-[inset_0_0_18px_rgba(0,0,0,0.34)]',
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
      'inline-flex min-w-[74px] items-center justify-center border-r border-[#394447] px-4 text-[15px] text-[#d8d4ca] transition-all duration-150 last:border-r-0 hover:bg-[#0b1111] hover:text-[#ffcf8c] data-[state=active]:border-[#658a78] data-[state=active]:bg-[#153d34] data-[state=active]:text-[#d8ffe3] data-[state=active]:shadow-[inset_0_0_18px_rgba(39,178,111,0.22)]',
      className,
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName
