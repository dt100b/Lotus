/**
 * Single-expiry forward Greek surface — pure τ projection (not historical heatmap).
 * Source: GET /api/v1/gex-forward-surface
 *
 * Contract:
 *   times   — future timestamps (epoch ms) from now → settle
 *   prices  — price grid (dense)
 *   values  — net GEX ($ per 1%) at [time][price]
 */

export type ForwardGreekMetric =
  | 'gamma'
  | 'delta'
  | 'delta_change'
  | 'charm'
  | 'vanna'

export type ForwardExpiryScope = '0dte' | 'eow' | 'eom'

export const forwardExpiryScopeOptions: Array<{
  value: ForwardExpiryScope
  label: string
  shortLabel: string
}> = [
  { value: '0dte', label: '0DTE', shortLabel: '0DTE' },
  { value: 'eow', label: 'EOW', shortLabel: 'EOW' },
  { value: 'eom', label: 'EOM', shortLabel: 'EOM' },
]

export function isForwardExpiryScope(value: unknown): value is ForwardExpiryScope {
  return value === '0dte' || value === 'eow' || value === 'eom'
}

export type GexForwardSurfaceMeta = {
  version: string
  methodology: string
  note: string
  legCount: number
  nTimes: number
  nPrices: number
  priceWindowPct: number | null
  tau0Years: number | null
  tau0Hours: number | null
  metric: ForwardGreekMetric
  unit: string
  ivShift: number
  referenceIv: number | null
  settlementStrike: number | null
  positioningSource: 'flow'
  positionRecovery: 'unavailable' | 'direct_flow_positions' | 'mixed' | 'gex_inversion'
  directPositionLegCount: number
  referenceGexCoverage: number
  expiryScope: ForwardExpiryScope
}

export type GexForwardSurface = {
  /** Epoch ms, ascending, now → settle. */
  times: number[]
  /** Price grid ascending. */
  prices: number[]
  /** values[ti][pi] net GEX $ / 1%. */
  values: number[][]
  spot: number
  settleMs: number
  asOfMs: number
  expiry: string
  meta: GexForwardSurfaceMeta
}

type BackendMeta = {
  version?: string
  methodology?: string
  note?: string
  leg_count?: number
  n_times?: number
  n_prices?: number
  price_window_pct?: number | null
  tau0_years?: number | null
  tau0_hours?: number | null
  metric?: ForwardGreekMetric
  unit?: string
  iv_shift?: number
  reference_iv?: number | null
  settlement_strike?: number | null
  positioning_source?: 'flow'
  position_recovery?: GexForwardSurfaceMeta['positionRecovery']
  direct_position_leg_count?: number
  reference_gex_coverage?: number
  expiry_scope?: ForwardExpiryScope
}

type BackendSurface = {
  times?: number[]
  prices?: number[]
  values?: number[][]
  spot?: number
  settle_ms?: number
  as_of_ms?: number
  expiry?: string
  meta?: BackendMeta
}

const apiBaseUrl =
  import.meta.env.VITE_LOTUS_API_BASE_URL
  ?? (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')

export type FetchGexForwardSurfaceOptions = {
  nTimes?: number
  nPrices?: number
  priceWindowPct?: number
  metric?: ForwardGreekMetric
  ivShift?: number
  expiryScope?: ForwardExpiryScope
  signal?: AbortSignal
}

export async function fetchGexForwardSurface(
  options: FetchGexForwardSurfaceOptions = {},
): Promise<GexForwardSurface> {
  const params = new URLSearchParams()
  if (options.nTimes != null) params.set('n_times', String(Math.floor(options.nTimes)))
  if (options.nPrices != null) params.set('n_prices', String(Math.floor(options.nPrices)))
  if (options.priceWindowPct != null) {
    params.set('price_window_pct', String(options.priceWindowPct))
  }
  if (options.metric != null) params.set('metric', options.metric)
  if (options.ivShift != null) params.set('iv_shift', String(options.ivShift))
  if (options.expiryScope != null) params.set('expiry_scope', options.expiryScope)

  const qs = params.toString()
  const url = `${apiBaseUrl}/api/v1/gex-forward-surface${qs ? `?${qs}` : ''}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  })
  if (!res.ok) {
    throw new Error(`gex-forward-surface ${res.status}: ${res.statusText}`)
  }
  const raw = (await res.json()) as BackendSurface
  return mapSurface(raw)
}

export function emptyGexForwardSurface(
  note = 'empty forward surface',
  expiryScope: ForwardExpiryScope = '0dte',
  metric: ForwardGreekMetric = 'gamma',
): GexForwardSurface {
  return {
    times: [],
    prices: [],
    values: [],
    spot: 0,
    settleMs: 0,
    asOfMs: 0,
    expiry: '',
    meta: {
      version: 'gex_forward_surface.v1',
      methodology: '',
      note,
      legCount: 0,
      nTimes: 0,
      nPrices: 0,
      priceWindowPct: null,
      tau0Years: null,
      tau0Hours: null,
      metric,
      unit: metric === 'delta'
        ? 'USD delta notional'
        : metric === 'delta_change'
          ? 'USD hedge change'
          : 'USD / 1% move',
      ivShift: 0,
      referenceIv: null,
      settlementStrike: null,
      positioningSource: 'flow',
      positionRecovery: 'unavailable',
      directPositionLegCount: 0,
      referenceGexCoverage: 0,
      expiryScope,
    },
  }
}

function mapSurface(raw: BackendSurface): GexForwardSurface {
  const times = (raw.times ?? [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t > 0)
  const prices = (raw.prices ?? [])
    .map((p) => Number(p))
    .filter((p) => Number.isFinite(p) && p > 0)
  const values = (raw.values ?? []).map((col) =>
    (col ?? []).map((v) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : 0
    }),
  )
  const meta = raw.meta ?? {}

  return {
    times,
    prices,
    values,
    spot: Number(raw.spot) || 0,
    settleMs: Number(raw.settle_ms) || 0,
    asOfMs: Number(raw.as_of_ms) || 0,
    expiry: String(raw.expiry ?? ''),
    meta: {
      version: meta.version || 'gex_forward_surface.v1',
      methodology: meta.methodology || '',
      note: meta.note || '',
      legCount: Number(meta.leg_count) || 0,
      nTimes: Number(meta.n_times) || times.length,
      nPrices: Number(meta.n_prices) || prices.length,
      priceWindowPct: finiteOrNull(meta.price_window_pct),
      tau0Years: finiteOrNull(meta.tau0_years),
      tau0Hours: finiteOrNull(meta.tau0_hours),
      metric: isForwardMetric(meta.metric) ? meta.metric : 'gamma',
      unit: String(meta.unit || 'USD / 1% move'),
      ivShift: Number(meta.iv_shift) || 0,
      referenceIv: finiteOrNull(meta.reference_iv),
      settlementStrike: finiteOrNull(meta.settlement_strike),
      positioningSource: 'flow',
      positionRecovery: isPositionRecovery(meta.position_recovery)
        ? meta.position_recovery
        : 'unavailable',
      directPositionLegCount: Math.max(0, Number(meta.direct_position_leg_count) || 0),
      referenceGexCoverage: clamp01(Number(meta.reference_gex_coverage) || 0),
      expiryScope: isForwardExpiryScope(meta.expiry_scope) ? meta.expiry_scope : '0dte',
    },
  }
}

function isPositionRecovery(
  value: unknown,
): value is GexForwardSurfaceMeta['positionRecovery'] {
  return value === 'unavailable'
    || value === 'direct_flow_positions'
    || value === 'mixed'
    || value === 'gex_inversion'
}

function isForwardMetric(value: unknown): value is ForwardGreekMetric {
  return value === 'gamma'
    || value === 'delta'
    || value === 'delta_change'
    || value === 'charm'
    || value === 'vanna'
}

function finiteOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}
