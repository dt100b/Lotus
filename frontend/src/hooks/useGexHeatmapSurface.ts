import { useQuery } from '@tanstack/react-query'
import {
  emptyGexHeatmapSurface,
  fetchGexHeatmapSurface,
  synthesizeSurfaceFromProfile,
  type GexHeatmapSurface,
} from '@/api/gexHeatmapSurface'
import { getTerminalDataMode } from '@/hooks/useTerminalSnapshot'

/** Minimal snapshot shape for mock surface synthesis. */
export type HeatmapSurfaceSnapshot = {
  spot: number
  gammaBars: Array<{
    strike: number
    gammaExposureUsd?: number
    netGammaExposureUsd?: number
  }>
}

export type UseGexHeatmapSurfaceOptions = {
  /** Live snapshot used only for mock synthesis / single-column fallback. */
  snapshot?: HeatmapSurfaceSnapshot
  enabled?: boolean
  maxSamples?: number
  /** Poll interval ms in live mode. Default 60s (history appends slower than terminal). */
  refetchIntervalMs?: number
}

export function gexHeatmapSurfaceQueryKey(maxSamples?: number) {
  return ['gex-heatmap-surface', getTerminalDataMode(), maxSamples ?? 'all'] as const
}

export function useGexHeatmapSurface({
  snapshot,
  enabled = true,
  maxSamples = 400,
  refetchIntervalMs = 60_000,
}: UseGexHeatmapSurfaceOptions = {}) {
  const dataMode = getTerminalDataMode()

  return useQuery({
    queryKey: gexHeatmapSurfaceQueryKey(maxSamples),
    enabled,
    queryFn: async ({ signal }): Promise<GexHeatmapSurface> => {
      if (dataMode === 'mock') {
        if (!snapshot) return emptyGexHeatmapSurface()
        return synthesizeSurfaceFromProfile(
          snapshot.gammaBars,
          snapshot.spot,
          Date.now(),
        )
      }
      return fetchGexHeatmapSurface({ maxSamples, signal })
    },
    refetchInterval: dataMode === 'live' ? refetchIntervalMs : false,
    staleTime: dataMode === 'live' ? 20_000 : 60_000,
    retry: dataMode === 'live' ? 1 : 0,
    // Keep previous surface while refetching to avoid flash-empty.
    placeholderData: (prev) => prev,
  })
}
