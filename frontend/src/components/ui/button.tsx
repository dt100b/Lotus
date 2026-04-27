import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex h-10 items-center justify-center gap-2 rounded-[4px] border px-3 text-sm font-semibold uppercase tracking-[0.04em] transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#ff9b28] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'border-[#4b5556] bg-[#05090b] text-[#e8dcc9] shadow-[inset_0_0_18px_rgba(0,0,0,0.32)] hover:border-[#8a7560] hover:bg-[#0b1111] hover:text-[#ff9b28]',
        ghost:
          'border-transparent bg-transparent text-[#d4bd94] hover:border-[#445052] hover:bg-[#0b1111] hover:text-[#ffcf8c]',
        active:
          'border-[#6ea78a] bg-[#143c32] text-[#d7ffe3] shadow-[inset_0_0_20px_rgba(39,178,111,0.25),0_0_14px_rgba(39,178,111,0.12)]',
      },
      size: {
        default: 'h-10 px-3',
        icon: 'h-10 w-10 px-0',
        compact: 'h-7 px-2.5 text-xs',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'
