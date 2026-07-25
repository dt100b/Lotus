import { useEffect, useState } from 'react'
import { createFpsMeter, isPerfEnabled } from '@/lib/perf'

/**
 * Dev/perf FPS sample. Only active when `?perf=1` or localStorage.lotusPerf=1.
 */
export function useFpsMeter(enabled?: boolean) {
  const active = enabled ?? isPerfEnabled()
  const [fps, setFps] = useState(0)
  const [frameMs, setFrameMs] = useState(0)

  useEffect(() => {
    if (!active) return

    const meter = createFpsMeter()
    meter.start()
    const id = window.setInterval(() => {
      const sample = meter.getSample()
      setFps(sample.fps)
      setFrameMs(sample.frameMs)
    }, 250)

    return () => {
      window.clearInterval(id)
      meter.stop()
    }
  }, [active])

  return { active, fps, frameMs }
}
