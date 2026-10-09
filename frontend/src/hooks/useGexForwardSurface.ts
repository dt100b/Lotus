import { useQuery } from '@tanstack/react-query'
import {
  emptyGexForwardSurface,
  fetchGexForwardSurface,
  type GexForwardSurface,
  type ForwardExpiryScope,
  type ForwardGreekMetric,
} from '@/api/gexForwardSurface'
import { synthesizeForwardFromProfile } from '@/lib/forwardGammaSurface'
import { getTerminalDataMode } from '@/hooks/useTerminalSnapshot'

export type ForwardSurfaceSnapshot = {
  spot: number
  gammaBars: Array<{
    strike: number
    gammaExposureUsd?: number
    netGammaExposureUsd?: number
    callGammaExposureUsd?: number
    putGammaExposureUsd?: number
  }>
}

export type UseGexForwardSurfaceOptions = {
  /** Used only for mock synthesis. */
  snapshot?: ForwardSurfaceSnapshot
  enabled?: boolean
  nTimes?: number
  nPrices?: number
  priceWindowPct?: number
  metric?: ForwardGreekMetric
  ivShift?: number
  expiryScope?: ForwardExpiryScope
  /** Live poll interval. Surface only changes on chain materialize. */
  refetchIntervalMs?: number
}

export function gexForwardSurfaceQueryKey(
  nTimes?: number,
  nPrices?: number,
  priceWindowPct?: number,
  metric: ForwardGreekMetric = 'gamma',
  ivShift = 0,
  expiryScope: ForwardExpiryScope = '0dte',
) {
  return [
    'gex-forward-surface',
    getTerminalDataMode(),
    nTimes ?? 64,
    nPrices ?? 128,
    priceWindowPct ?? 8,
    metric,
    ivShift,
    expiryScope,
  ] as const
}

/**
 * Single-expiry forward Greek grid. Recomputes when the live chain snapshot updates
 * (poll); pan/zoom never hits the network.
 */
export function useGexForwardSurface({
  snapshot,
  enabled = true,
  nTimes = 64,
  nPrices = 128,
  priceWindowPct = 8,
  metric = 'gamma',
  ivShift = 0,
  expiryScope = '0dte',
  refetchIntervalMs = 30_000,
}: UseGexForwardSurfaceOptions = {}) {
  const dataMode = getTerminalDataMode()

  return useQuery<GexForwardSurface>({
    queryKey: gexForwardSurfaceQueryKey(
      nTimes,
      nPrices,
      priceWindowPct,
      metric,
      ivShift,
      expiryScope,
    ),
    enabled,
    queryFn: async ({ signal }) => {
      if (dataMode === 'mock') {
        // The local profile synthesizer only models Gamma. Never relabel its
        // output as another Greek: Delta and Delta Change must come from the
        // live forward-Greek API.
        if (metric !== 'gamma' || !snapshot || expiryScope !== '0dte') {
          return emptyGexForwardSurface(
            metric === 'gamma'
              ? `No ${expiryScope.toUpperCase()} mock expiry book`
              : `${metric.replace('_', ' ')} requires live forward-Greek data`,
            expiryScope,
            metric,
          )
        }
        return synthesizeForwardFromProfile(snapshot.gammaBars, snapshot.spot, {
          nTimes,
          nPrices,
          priceWindowPct,
        })
      }
      try {
        return await fetchGexForwardSurface({
          nTimes,
          nPrices,
          priceWindowPct,
          metric,
          ivShift,
          expiryScope,
          signal,
        })
      } catch (err) {
        // Only 0DTE can safely fall back to the front profile. Synthesizing a
        // longer tenor from that book would silently mislabel the expiry.
        if (
          metric === 'gamma'
          && expiryScope === '0dte'
          && snapshot?.gammaBars?.length
          && snapshot.spot > 0
        ) {
          console.warn(
            '[useGexForwardSurface] API failed; synthesizing from live profile',
            err,
          )
          return synthesizeForwardFromProfile(snapshot.gammaBars, snapshot.spot, {
            nTimes,
            nPrices,
            priceWindowPct,
          })
        }
        throw err
      }
    },
    refetchInterval: dataMode === 'live' ? refetchIntervalMs : false,
    staleTime: dataMode === 'live' ? 15_000 : 60_000,
    retry: dataMode === 'live' ? 1 : 0,
    placeholderData: (prev) => prev,
  })
}
