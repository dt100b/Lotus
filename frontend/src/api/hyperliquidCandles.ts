/**
 * Hyperliquid BTC perp candle feed (REST backfill + WebSocket live).
 * Presentation-layer only — does not touch GEX methodology.
 *
 * REST:  POST https://api.hyperliquid.xyz/info  { type: "candleSnapshot", req: {...} }
 * WS:    wss://api.hyperliquid.xyz/ws            { method: "subscribe", subscription: { type: "candle", ... } }
 */

/**
 * HL-supported intervals used by the desk chart.
 * API also has 3m/2h/8h/12h/3d/1w/1M — omitted for a compact strip.
 */
export type CandleInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d'

export type OhlcCandle = {
  /** Candle open time (ms, UTC). */
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
  /** True while the current interval bucket is still open. */
  isClosed: boolean
}

export const candleIntervals: readonly CandleInterval[] = [
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
] as const

export const candleIntervalMs: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

export const candleIntervalLabels: Record<CandleInterval, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1D',
}

/**
 * Hyperliquid returns at most ~5000 candles per snapshot request and does not
 * expose older bars beyond that window. Request the full available depth.
 */
export const HL_MAX_CANDLES = 5_000

/** Wall-clock span covering the full HL-available history for an interval. */
export function maxHistoryMsForInterval(interval: CandleInterval): number {
  return HL_MAX_CANDLES * candleIntervalMs[interval]
}

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info'
const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws'
const BTC_COIN = 'BTC'

/** Hyperliquid candleSnapshot row (array form) or object form. */
type HlCandleRow =
  | [number, string, string, string, string, string, number?]
  | {
      t: number
      o: string | number
      h: string | number
      l: string | number
      c: string | number
      v?: string | number
      n?: number
    }

export function isCandleInterval(value: string | null | undefined): value is CandleInterval {
  return value !== null && value !== undefined && (candleIntervals as readonly string[]).includes(value)
}

export function floorToInterval(ms: number, interval: CandleInterval): number {
  const step = candleIntervalMs[interval]
  return Math.floor(ms / step) * step
}

/** Stay under HL’s ~5k soft-cap per request; page older windows if needed. */
const maxCandlesPerRequest = 4_500

/**
 * Fetch historical OHLC for [startMs, endMs].
 * HL exposes at most ~5000 most-recent candles per interval; we still page in
 * case a range is wider (empty older pages are fine). Prefer
 * {@link maxHistoryMsForInterval} as the lookback so one request usually
 * returns the full available book.
 */
export async function fetchCandleSnapshot(
  interval: CandleInterval,
  startMs: number,
  endMs: number,
  signal?: AbortSignal,
): Promise<OhlcCandle[]> {
  const start = Math.floor(startMs)
  const end = Math.floor(endMs)
  if (!(end > start)) return []

  const step = candleIntervalMs[interval]
  // Clamp to HL’s available depth so we don’t spam empty older windows.
  const maxSpan = maxHistoryMsForInterval(interval)
  const clampedStart = Math.max(start, end - maxSpan - step)
  const maxSpanMs = maxCandlesPerRequest * step
  const chunks: OhlcCandle[] = []

  for (let cursor = clampedStart; cursor < end; cursor += maxSpanMs) {
    if (signal?.aborted) break
    const chunkEnd = Math.min(end, cursor + maxSpanMs)
    const part = await fetchCandleSnapshotChunk(interval, cursor, chunkEnd, signal)
    if (part.length > 0) chunks.push(...part)
  }

  chunks.sort((a, b) => a.t - b.t)
  return dedupeCandles(chunks)
}

async function fetchCandleSnapshotChunk(
  interval: CandleInterval,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<OhlcCandle[]> {
  const body = {
    type: 'candleSnapshot',
    req: {
      coin: BTC_COIN,
      interval,
      startTime: start,
      endTime: end,
    },
  }

  const response = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Hyperliquid candleSnapshot failed: ${response.status}`)
  }

  const payload = (await response.json()) as unknown
  if (!Array.isArray(payload)) {
    throw new Error('Hyperliquid candleSnapshot: unexpected payload shape')
  }

  const now = Date.now()
  const candles: OhlcCandle[] = []

  for (const row of payload as HlCandleRow[]) {
    const parsed = parseHlCandle(row, interval, now)
    if (parsed) candles.push(parsed)
  }

  return candles
}

function isHlCandleRow(value: unknown): value is HlCandleRow {
  if (Array.isArray(value) && value.length >= 5) return true
  if (value && typeof value === 'object' && 't' in value && 'o' in value && 'c' in value) return true
  return false
}

function parseHlCandle(row: HlCandleRow, interval: CandleInterval, nowMs: number): OhlcCandle | null {
  let t: number
  let o: number
  let h: number
  let l: number
  let c: number
  let v: number

  if (Array.isArray(row)) {
    // Documented array form: [t, o, h, l, c, v, n?]
    t = Number(row[0])
    o = Number(row[1])
    h = Number(row[2])
    l = Number(row[3])
    c = Number(row[4])
    v = Number(row[5] ?? 0)
  } else if (row && typeof row === 'object') {
    t = Number(row.t)
    o = Number(row.o)
    h = Number(row.h)
    l = Number(row.l)
    c = Number(row.c)
    v = Number(row.v ?? 0)
  } else {
    return null
  }

  if (![t, o, h, l, c].every((n) => Number.isFinite(n))) return null
  // HL timestamps are ms; guard against accidental seconds.
  if (t < 1e12) t *= 1000

  const open = floorToInterval(t, interval)
  const step = candleIntervalMs[interval]
  const isClosed = nowMs >= open + step

  return { t: open, o, h, l, c, v: Number.isFinite(v) ? v : 0, isClosed }
}

export function dedupeCandles(candles: OhlcCandle[]): OhlcCandle[] {
  if (candles.length <= 1) return candles
  const byTime = new Map<number, OhlcCandle>()
  for (const candle of candles) {
    byTime.set(candle.t, candle)
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t)
}

export function mergeCandle(existing: OhlcCandle[], next: OhlcCandle): OhlcCandle[] {
  if (existing.length === 0) return [next]
  const last = existing[existing.length - 1]!
  if (next.t === last.t) {
    const copy = existing.slice(0, -1)
    copy.push(next)
    return copy
  }
  if (next.t > last.t) {
    return [...existing, next]
  }
  // Out-of-order update — replace by open time
  const idx = existing.findIndex((c) => c.t === next.t)
  if (idx >= 0) {
    const copy = existing.slice()
    copy[idx] = next
    return copy
  }
  return dedupeCandles([...existing, next])
}

export type CandleWsHandlers = {
  onCandle: (candle: OhlcCandle) => void
  onStatus: (status: CandleConnectionStatus) => void
  onError?: (error: Error) => void
}

export type CandleConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error'

export type CandleWsHandle = {
  close: () => void
}

/**
 * Subscribe to live Hyperliquid candle updates with exponential-backoff reconnect.
 */
export function subscribeCandleStream(
  interval: CandleInterval,
  handlers: CandleWsHandlers,
): CandleWsHandle {
  let ws: WebSocket | null = null
  let closed = false
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

  const clearTimers = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (pingTimer !== null) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  const scheduleReconnect = () => {
    if (closed) return
    clearTimers()
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt, 5))
    reconnectAttempt += 1
    handlers.onStatus(reconnectAttempt === 1 ? 'disconnected' : 'reconnecting')
    reconnectTimer = setTimeout(connect, delay)
  }

  const connect = () => {
    if (closed) return
    clearTimers()
    handlers.onStatus(reconnectAttempt > 0 ? 'reconnecting' : 'connecting')

    try {
      ws = new WebSocket(HL_WS_URL)
    } catch (err) {
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      if (closed) {
        ws?.close()
        return
      }
      reconnectAttempt = 0
      handlers.onStatus('connected')
      const sub = {
        method: 'subscribe',
        subscription: {
          type: 'candle',
          coin: BTC_COIN,
          interval,
        },
      }
      ws?.send(JSON.stringify(sub))

      // Keepalive — some intermediaries idle-timeout silent sockets.
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ method: 'ping' }))
          } catch {
            // ignore — onclose will reconnect
          }
        }
      }, 25_000)
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          channel?: string
          data?: unknown
        }

        if (msg.channel === 'pong' || msg.channel === 'subscriptionResponse') {
          return
        }

        if (msg.channel !== 'candle' || msg.data == null) {
          return
        }

        const now = Date.now()
        const rows: unknown[] = Array.isArray(msg.data) ? msg.data : [msg.data]
        for (const row of rows) {
          if (!isHlCandleRow(row)) continue
          const candle = parseHlCandle(row, interval, now)
          if (candle) handlers.onCandle(candle)
        }
      } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }

    ws.onerror = () => {
      handlers.onError?.(new Error('Hyperliquid candle WebSocket error'))
    }

    ws.onclose = () => {
      clearTimers()
      ws = null
      if (!closed) scheduleReconnect()
      else handlers.onStatus('disconnected')
    }
  }

  connect()

  return {
    close: () => {
      closed = true
      clearTimers()
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                method: 'unsubscribe',
                subscription: { type: 'candle', coin: BTC_COIN, interval },
              }),
            )
          }
        } catch {
          // ignore
        }
        try {
          ws.close()
        } catch {
          // ignore
        }
        ws = null
      }
      handlers.onStatus('disconnected')
    },
  }
}

/** Trim candles to a time window with a small buffer for forming buckets. */
export function trimCandlesToWindow(
  candles: OhlcCandle[],
  windowStartMs: number,
  windowEndMs: number,
  interval: CandleInterval = '1h',
): OhlcCandle[] {
  if (candles.length === 0) return candles
  const pad = candleIntervalMs[interval]
  const lo = windowStartMs - pad
  const hi = windowEndMs + pad
  return candles.filter((c) => c.t >= lo && c.t <= hi)
}
