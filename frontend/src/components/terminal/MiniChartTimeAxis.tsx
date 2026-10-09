import { useMemo, useRef } from 'react'
import { useContainerSize } from '@/hooks/useContainerSize'
import {
  buildMiniChartTimeTicks,
  MINI_CHART_TIME_ZONE,
  type MiniChartRangeBounds,
} from '@/data/miniChartRange'
import { cn } from '@/lib/utils'

type MiniChartTimeAxisProps = {
  bounds: MiniChartRangeBounds
  viewportBounds?: MiniChartRangeBounds
  timeZone?: string
  className?: string
}

/** Decorative companion axis for charts whose native time labels are hidden. */
export function MiniChartTimeAxis({
  bounds,
  viewportBounds = bounds,
  timeZone = MINI_CHART_TIME_ZONE,
  className,
}: MiniChartTimeAxisProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(hostRef, 420, 20, {
    minWidth: 1,
    minHeight: 1,
  })
  const tickCount = tickCountForWidth(width)
  const ticks = useMemo(
    () => positionTicksInViewport(
      buildMiniChartTimeTicks(bounds, tickCount, timeZone),
      viewportBounds,
    ),
    [bounds, tickCount, timeZone, viewportBounds],
  )

  return (
    <div
      ref={hostRef}
      className={cn(
        'relative h-5 w-full select-none overflow-hidden text-[8px] font-medium tracking-[0.02em] text-[var(--terminal-subtle)] tabular-nums',
        className,
      )}
      role="presentation"
      aria-hidden="true"
    >
      {ticks.map((tick, index) => (
        <span
          key={`${tick.tsMs}-${index}`}
          className="absolute bottom-0 whitespace-nowrap"
          style={{
            left: `${tick.positionPct}%`,
            transform:
              index === 0
                ? 'none'
                : index === ticks.length - 1
                  ? 'translateX(-100%)'
                  : 'translateX(-50%)',
          }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  )
}

function positionTicksInViewport(
  ticks: ReturnType<typeof buildMiniChartTimeTicks>,
  viewport: MiniChartRangeBounds,
) {
  const spanMs = viewport.toMs - viewport.fromMs
  if (!(spanMs > 0)) return ticks
  return ticks.map((tick) => ({
    ...tick,
    positionPct: Math.max(
      0,
      Math.min(100, ((tick.tsMs - viewport.fromMs) / spanMs) * 100),
    ),
  }))
}

function tickCountForWidth(width: number): 4 | 5 | 6 {
  if (width < 300) return 4
  if (width < 420) return 5
  return 6
}
