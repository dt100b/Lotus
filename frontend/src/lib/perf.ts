/**
 * Lightweight performance helpers for the Lotus terminal.
 * Enable with `?perf=1` or `localStorage.lotusPerf = '1'`.
 */

const PERF_MARK_PREFIX = 'lotus:'

export function isPerfEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.localStorage?.getItem('lotusPerf') === '1') return true
    if (new URLSearchParams(window.location.search).get('perf') === '1') return true
  } catch {
    // localStorage / URL may be unavailable
  }
  return false
}

export function perfMark(name: string) {
  if (!isPerfEnabled() || typeof performance === 'undefined') return
  try {
    performance.mark(`${PERF_MARK_PREFIX}${name}`)
  } catch {
    // ignore
  }
}

export function perfMeasure(name: string, startMark: string, endMark?: string) {
  if (!isPerfEnabled() || typeof performance === 'undefined') return
  try {
    const start = `${PERF_MARK_PREFIX}${startMark}`
    const end = endMark ? `${PERF_MARK_PREFIX}${endMark}` : undefined
    if (end) {
      performance.measure(`${PERF_MARK_PREFIX}${name}`, start, end)
    } else {
      performance.measure(`${PERF_MARK_PREFIX}${name}`, start)
    }
    const entries = performance.getEntriesByName(`${PERF_MARK_PREFIX}${name}`, 'measure')
    const last = entries[entries.length - 1]
    if (last && import.meta.env.DEV) {
      console.debug(`[lotus-perf] ${name}: ${last.duration.toFixed(2)}ms`)
    }
  } catch {
    // marks may be missing
  }
}

/** Timed block; returns duration ms when perf is enabled. */
export function perfTime<T>(name: string, fn: () => T): T {
  if (!isPerfEnabled()) return fn()
  const t0 = performance.now()
  const result = fn()
  const ms = performance.now() - t0
  if (import.meta.env.DEV) {
    console.debug(`[lotus-perf] ${name}: ${ms.toFixed(2)}ms`)
  }
  return result
}

export type FpsSample = {
  fps: number
  frameMs: number
}

/**
 * rAF FPS sampler. Call start() once; read latest via getSample().
 * Only intended for DEV / ?perf=1 HUD.
 */
export function createFpsMeter() {
  let rafId = 0
  let lastTs = 0
  let frames = 0
  let windowStart = 0
  let fps = 0
  let frameMs = 0
  let running = false

  const tick = (ts: number) => {
    if (!running) return
    if (!windowStart) {
      windowStart = ts
      lastTs = ts
    }
    frames += 1
    frameMs = ts - lastTs
    lastTs = ts
    const elapsed = ts - windowStart
    if (elapsed >= 500) {
      fps = Math.round((frames * 1000) / elapsed)
      frames = 0
      windowStart = ts
    }
    rafId = window.requestAnimationFrame(tick)
  }

  return {
    start() {
      if (running) return
      running = true
      lastTs = 0
      frames = 0
      windowStart = 0
      rafId = window.requestAnimationFrame(tick)
    },
    stop() {
      running = false
      if (rafId) {
        window.cancelAnimationFrame(rafId)
        rafId = 0
      }
    },
    getSample(): FpsSample {
      return { fps, frameMs }
    },
  }
}
