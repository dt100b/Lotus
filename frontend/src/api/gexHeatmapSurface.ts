/**
 * GEX heatmap surface — historical net GEX by strike over time.
 * Source: GET /api/v1/gex-heatmap-surface (gex_window_history).
 */

export type GexHeatmapCell = {
  strike: number
  netGex: number
}

export type GexHeatmapSample = {
  tsMs: number
  spot: number
  netGex: number
  cells: GexHeatmapCell[]
}

export type GexHeatmapSurface = {
  asOfMs: number
  version: string
  sampleCount: number
  samples: GexHeatmapSample[]
  meta: {
    retentionMs: number
    methodology: string
    note: string
    version: string
  }
}

type BackendCell = {
  strike: number
  net_gex: number
}

type BackendSample = {
  ts_ms: number
  spot: number
  net_gex: number
  cells: BackendCell[]
}

type BackendSurface = {
  as_of_ms: number
  version: string
  sample_count: number
  samples: BackendSample[]
  meta: {
    retention_ms: number
    methodology: string
    note: string
    version: string
  }
}

const apiBaseUrl =
  import.meta.env.VITE_LOTUS_API_BASE_URL
  ?? (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')

export type FetchGexHeatmapSurfaceOptions = {
  fromMs?: number
  toMs?: number
  maxSamples?: number
  signal?: AbortSignal
}

export async function fetchGexHeatmapSurface(
  options: FetchGexHeatmapSurfaceOptions = {},
): Promise<GexHeatmapSurface> {
  const params = new URLSearchParams()
  if (options.fromMs != null) params.set('from_ms', String(Math.floor(options.fromMs)))
  if (options.toMs != null) params.set('to_ms', String(Math.floor(options.toMs)))
  if (options.maxSamples != null) params.set('max_samples', String(options.maxSamples))

  const qs = params.toString()
  const url = `${apiBaseUrl}/api/v1/gex-heatmap-surface${qs ? `?${qs}` : ''}`
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  })
  if (!res.ok) {
    throw new Error(`gex-heatmap-surface ${res.status}: ${res.statusText}`)
  }
  const raw = (await res.json()) as BackendSurface
  return mapSurface(raw)
}

export function emptyGexHeatmapSurface(): GexHeatmapSurface {
  return {
    asOfMs: 0,
    version: 'gex_window_history.v1',
    sampleCount: 0,
    samples: [],
    meta: {
      retentionMs: 26 * 3600 * 1000,
      methodology: '',
      note: '',
      version: 'gex_window_history.v1',
    },
  }
}

/**
 * Offline / mock: synthesize a short temporal surface from a live strike profile.
 * Used only when VITE_LOTUS_DATA_MODE=mock — does not invent multi-hour history in live mode.
 */
export function synthesizeSurfaceFromProfile(
  gammaBars: Array<{
    strike: number
    gammaExposureUsd?: number
    netGammaExposureUsd?: number
  }>,
  spot: number,
  nowMs: number = Date.now(),
  hours = 12,
  stepMin = 15,
): GexHeatmapSurface {
  const cells: GexHeatmapCell[] = gammaBars
    .map((row) => {
      const net = row.netGammaExposureUsd ?? row.gammaExposureUsd ?? 0
      return { strike: row.strike, netGex: net }
    })
    .filter((c) => Number.isFinite(c.strike) && Number.isFinite(c.netGex) && Math.abs(c.netGex) > 0)
    .sort((a, b) => a.strike - b.strike)

  if (cells.length === 0) return emptyGexHeatmapSurface()

  const stepMs = stepMin * 60_000
  const spanMs = hours * 3600_000
  const samples: GexHeatmapSample[] = []
  // Mild temporal modulation so mock mode still exercises continuous surface paint
  // (intensity + slight strike-local phase) without inventing fake walls.
  for (let t = nowMs - spanMs; t <= nowMs; t += stepMs) {
    const u = (t - (nowMs - spanMs)) / Math.max(spanMs, 1)
    const scale = 0.68 + 0.32 * u
    const phase = Math.sin(u * Math.PI * 2) * 0.08
    samples.push({
      tsMs: Math.floor(t),
      spot,
      netGex: cells.reduce((s, c) => s + c.netGex, 0) * scale,
      cells: cells.map((c, i) => {
        const local = 1 + phase * Math.sin((i / Math.max(cells.length - 1, 1)) * Math.PI)
        return { strike: c.strike, netGex: c.netGex * scale * local }
      }),
    })
  }

  return {
    asOfMs: nowMs,
    version: 'mock.gex_window_history.v1',
    sampleCount: samples.length,
    samples,
    meta: {
      retentionMs: spanMs,
      methodology: 'mock synthetic surface from live gamma bars',
      note: 'Mock mode only — not production history',
      version: 'mock.gex_window_history.v1',
    },
  }
}

function mapSurface(raw: BackendSurface): GexHeatmapSurface {
  const samples = (raw.samples ?? []).map((s) => ({
    tsMs: Number(s.ts_ms),
    spot: Number(s.spot),
    netGex: Number(s.net_gex),
    cells: (s.cells ?? [])
      .map((c) => ({
        strike: Number(c.strike),
        netGex: Number(c.net_gex),
      }))
      .filter((c) => Number.isFinite(c.strike) && Number.isFinite(c.netGex)),
  }))

  return {
    asOfMs: Number(raw.as_of_ms) || (samples.at(-1)?.tsMs ?? 0),
    version: raw.version || 'gex_window_history.v1',
    sampleCount: Number(raw.sample_count) || samples.length,
    samples,
    meta: {
      retentionMs: Number(raw.meta?.retention_ms) || 26 * 3600 * 1000,
      methodology: raw.meta?.methodology ?? '',
      note: raw.meta?.note ?? '',
      version: raw.meta?.version ?? raw.version ?? 'gex_window_history.v1',
    },
  }
}
