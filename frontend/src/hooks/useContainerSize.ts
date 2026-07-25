import { useEffect, useRef, useState, type RefObject } from 'react'

export type ContainerSize = {
  width: number
  height: number
}

/**
 * rAF-throttled ResizeObserver for chart containers.
 * Uses clientWidth/clientHeight so absolute canvases cannot feed a growth loop.
 */
export function useContainerSize(
  ref: RefObject<HTMLElement | null>,
  fallbackWidth: number,
  fallbackHeight: number,
  options?: {
    /** Floor for measured width (profile charts historically used a min width). */
    minWidth?: number
    minHeight?: number
  },
): ContainerSize {
  const minWidth = options?.minWidth ?? 1
  const minHeight = options?.minHeight ?? 1
  const [size, setSize] = useState<ContainerSize>({
    width: Math.max(minWidth, fallbackWidth),
    height: Math.max(minHeight, fallbackHeight),
  })
  const rafRef = useRef(0)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const measure = () => {
      rafRef.current = 0
      const nextWidth = Math.max(
        minWidth,
        Math.floor(element.clientWidth || element.getBoundingClientRect().width || 1),
      )
      const nextHeight = Math.max(
        minHeight,
        Math.floor(element.clientHeight || element.getBoundingClientRect().height || 1),
      )

      setSize((prev) => {
        if (prev.width === nextWidth && prev.height === nextHeight) {
          return prev
        }
        return { width: nextWidth, height: nextHeight }
      })
    }

    const schedule = () => {
      if (rafRef.current) return
      rafRef.current = window.requestAnimationFrame(measure)
    }

    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(element)

    return () => {
      observer.disconnect()
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [ref, minWidth, minHeight])

  return size
}
