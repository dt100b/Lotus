import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex h-[26px] items-center justify-center gap-2 rounded-[var(--terminal-control-radius)] border px-2.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--terminal-green)] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'border-[var(--terminal-control-border)] bg-[var(--terminal-bg-soft)] text-[var(--terminal-text)] shadow-[var(--terminal-control-inset)] hover:border-[var(--terminal-border-strong)] hover:bg-[var(--terminal-surface-2)] hover:text-[var(--terminal-heading)]',
        ghost:
          'border-transparent bg-transparent text-[var(--terminal-muted)] hover:border-[var(--terminal-border)] hover:bg-[var(--terminal-surface-2)] hover:text-[var(--terminal-heading)]',
        active:
          'border-[var(--terminal-active-border)] bg-[var(--terminal-active-bg)] text-[var(--terminal-green-strong)] shadow-[var(--terminal-active-shadow)]',
      },
      size: {
        default: 'h-[26px] px-2.5',
        icon: 'h-[26px] w-[26px] px-0',
        compact: 'h-[20px] px-1.5 text-[9px] tracking-[0.08em]',
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
