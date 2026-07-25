import { useEffect, useRef, useState } from 'react'
import {
  candleIntervalMs,
  fetchCandleSnapshot,
  mergeCandle,
  subscribeCandleStream,
  trimCandlesToWindow,
  type CandleConnectionStatus,
  type CandleInterval,
  type OhlcCandle,
} from '@/api/hyperliquidCandles'

export type UseHyperliquidCandlesOptions = {
  /** When false, tears down WS and skips fetches. Default true. */
  enabled?: boolean
  interval?: CandleInterval
  /**
   * Inclusive left edge of the chart time domain (ms).
   * Used for initial backfill and for trimming the buffer.
   */
  windowStartMs: number
  /** Inclusive right edge of the chart time domain (ms). */
  windowEndMs: number
}

export type UseHyperliquidCandlesResult = {
  candles: OhlcCandle[]
  /**
   * Interval the current `candles` buffer was built for.
   * Stays on the previous TF while a switch is loading so the chart can hold
   * the last paint instead of thrashing with mismatched bar spacing.
   */
  dataInterval: CandleInterval
  status: CandleConnectionStatus
  error: string | null
  /** True while historical backfill for the requested interval/window is in flight. */
  isLoading: boolean
  /** True when `dataInterval` lags the requested `interval` (TF switch in flight). */
  isStale: boolean
  lastUpdateMs: number | null
}

const emptyCandles: OhlcCandle[] = []

/**
 * Live Hyperliquid BTC perp OHLC for heatmap overlay.
 * Handles REST backfill, WebSocket updates, reconnect, and window changes.
 *
 * On timeframe switch: keeps the previous candle buffer painted until the new
 * interval's backfill lands (no empty-flash / double setData thrash).
 */
export function useHyperliquidCandles({
  enabled = true,
  interval = '15m',
  windowStartMs,
  windowEndMs,
}: UseHyperliquidCandlesOptions): UseHyperliquidCandlesResult {
  const [candles, setCandles] = useState<OhlcCandle[]>(emptyCandles)
  const [dataInterval, setDataInterval] = useState<CandleInterval>(interval)
  const [status, setStatus] = useState<CandleConnectionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [lastUpdateMs, setLastUpdateMs] = useState<number | null>(null)

  const candlesRef = useRef<OhlcCandle[]>(emptyCandles)
  const dataIntervalRef = useRef<CandleInterval>(interval)
  const windowStartRef = useRef(windowStartMs)
  const windowEndRef = useRef(windowEndMs)

  useEffect(() => {
    windowStartRef.current = windowStartMs
    windowEndRef.current = windowEndMs
  }, [windowStartMs, windowEndMs])

  // Stable key so tiny domain jitter from layout remeasure does not thrash backfill.
  // Quantize to 1 minute so ResizeObserver / asOf drift does not spam REST.
  const windowKey = `${interval}|${Math.floor(windowStartMs / 60_000)}|${Math.floor(windowEndMs / 60_000)}`

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    const abort = new AbortController()
    let wsHandle: { close: () => void } | null = null
    let rafId: number | null = null
    let pendingFlush = false
    const bootInterval = interval

    const applyTrim = (list: OhlcCandle[]) => {
      // Always keep through "now" so a stable history window still accepts live bars.
      const end = Math.max(windowEndRef.current, Date.now() + candleIntervalMs[bootInterval])
      return trimCandlesToWindow(list, windowStartRef.current, end)
    }

    const flushToState = () => {
      rafId = null
      pendingFlush = false
      if (cancelled) return
      // Ignore WS ticks that arrive for a previous interval after abort.
      if (dataIntervalRef.current !== bootInterval) return
      const trimmed = applyTrim(candlesRef.current)
      candlesRef.current = trimmed
      setCandles(trimmed)
      setLastUpdateMs(Date.now())
    }

    /** Coalesce high-frequency WS ticks into one paint per animation frame. */
    const scheduleFlush = () => {
      if (pendingFlush) return
      pendingFlush = true
      rafId = window.requestAnimationFrame(flushToState)
    }

    const setBufferedImmediate = (list: OhlcCandle[]) => {
      const trimmed = applyTrim(list)
      candlesRef.current = trimmed
      dataIntervalRef.current = bootInterval
      setCandles(trimmed)
      setDataInterval(bootInterval)
    }

    async function bootstrap() {
      setIsLoading(true)
      setError(null)
      setStatus('connecting')
      // Do NOT clear candles / dataInterval — hold last paint until new bars land.

      // Slight pad so the leftmost/rightmost candle is complete.
      const pad = candleIntervalMs[bootInterval]
      // Always backfill against wall-clock so a stale GEX asOf cannot request an empty range.
      const now = Date.now()
      const start = Math.min(windowStartRef.current, now) - pad
      const end = Math.max(windowEndRef.current, now) + pad

      try {
        const historical = await fetchCandleSnapshot(bootInterval, start, end, abort.signal)
        if (cancelled) return
        setBufferedImmediate(historical)
        setLastUpdateMs(Date.now())
        setIsLoading(false)
      } catch (err) {
        if (cancelled || abort.signal.aborted) return
        setIsLoading(false)
        const message = err instanceof Error ? err.message : String(err)
        // AbortError is expected on interval/window changes — ignore.
        if (/abort/i.test(message)) return
        setError(message)
        // Still open the WS — live ticks can populate even if backfill failed.
      }

      if (cancelled) return

      wsHandle = subscribeCandleStream(bootInterval, {
        onCandle: (candle) => {
          if (cancelled) return
          if (dataIntervalRef.current !== bootInterval) return
          candlesRef.current = mergeCandle(candlesRef.current, candle)
          setError(null)
          scheduleFlush()
        },
        onStatus: (next) => {
          if (!cancelled) setStatus(next)
        },
        onError: (err) => {
          if (!cancelled) setError(err.message)
        },
      })
    }

    void bootstrap()

    return () => {
      cancelled = true
      abort.abort()
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      wsHandle?.close()
      wsHandle = null
      // Keep last candles in React state across re-bootstrap to avoid flash-empty.
    }
  }, [enabled, interval, windowKey])

  // When the domain slides without a full re-bootstrap, keep the buffer trimmed.
  useEffect(() => {
    if (!enabled) return
    // Only trim against the interval the buffer was actually built for.
    const iv = dataIntervalRef.current
    const end = Math.max(windowEndMs, Date.now() + candleIntervalMs[iv])
    const trimmed = trimCandlesToWindow(candlesRef.current, windowStartMs, end)
    if (trimmed.length !== candlesRef.current.length) {
      candlesRef.current = trimmed
      setCandles(trimmed)
    }
  }, [enabled, windowStartMs, windowEndMs])

  // Clear visible state when the overlay is disabled (deferred to microtask-safe path via effect deps).
  useEffect(() => {
    if (enabled) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setCandles(emptyCandles)
      setDataInterval(interval)
      dataIntervalRef.current = interval
      setStatus('idle')
      setError(null)
      setIsLoading(false)
      setLastUpdateMs(null)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, interval])

  const isStale = enabled && dataInterval !== interval

  return {
    candles: enabled ? candles : emptyCandles,
    dataInterval: enabled ? dataInterval : interval,
    status: enabled ? status : 'idle',
    error: enabled ? error : null,
    isLoading: enabled ? isLoading : false,
    isStale: enabled ? isStale : false,
    lastUpdateMs: enabled ? lastUpdateMs : null,
  }
}
