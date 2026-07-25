import { useEffect, useState, type RefObject } from 'react'

export type PaneChromeDensity = 'full' | 'compact' | 'minimal' | 'bare'

/**
 * Progressive chrome density from pane size.
 * full → all controls · compact → primary only · minimal → close only · bare → clean plot
 *
 * Thresholds are intentionally generous so title/toggles never pile up as panes compress.
 */
export function usePaneChrome(ref: RefObject<HTMLElement | null>): PaneChromeDensity {
  const [density, setDensity] = useState<PaneChromeDensity>('full')

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      // Bare first: plot-only surface when chrome would only clutter.
      if (w < 240 || h < 110) {
        setDensity('bare')
      } else if (w < 360 || h < 170) {
        setDensity('minimal')
      } else if (w < 520 || h < 240) {
        setDensity('compact')
      } else {
        setDensity('full')
      }
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return density
}
