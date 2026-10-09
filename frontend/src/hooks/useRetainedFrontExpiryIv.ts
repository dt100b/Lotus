import { useState } from 'react'
import type { VolSurfaceListedExpiry } from '@/data/mockTerminal'
import { retainFrontExpiryIv } from '@/data/listedExpiryRetention'

const EMPTY: VolSurfaceListedExpiry[] = []

/** Keep display continuity even while the listed chart is on another tab. */
export function useRetainedFrontExpiryIv(input: VolSurfaceListedExpiry[] = EMPTY) {
  const [cached, setCached] = useState(() => ({ input, ...retainFrontExpiryIv(input, null) }))
  if (cached.input !== input) {
    const next = { input, ...retainFrontExpiryIv(input, cached.front) }
    setCached(next)
    return next.rows
  }
  return cached.rows
}
