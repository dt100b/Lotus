import { useQuery } from '@tanstack/react-query'
import {
  fetchIvSignalScan,
  resolveIvSignalScanParameters,
  type IvSignalScan,
  type IvSignalScanParameters,
} from '@/api/ivSignalScanner'
import { normalizeLiveExpiry } from '@/api/liveTerminal'
import { getTerminalDataMode } from '@/hooks/useTerminalSnapshot'

export type UseIvSignalScanOptions = {
  expiry: string
  parameters?: Partial<IvSignalScanParameters>
  enabled?: boolean
}

export const DEFAULT_IV_SIGNAL_REFRESH_MS = 10 * 60 * 1_000

export function resolveIvSignalRefreshMs(scan?: IvSignalScan) {
  const recommendedSeconds = scan?.eligibility.recommendedRefreshSeconds ?? 600
  return Math.max(60, recommendedSeconds) * 1_000
}

export function ivSignalScanQueryKey(
  expiry: string,
  parameters: Partial<IvSignalScanParameters> = {},
) {
  return [
    'iv-signal-scan',
    getTerminalDataMode(),
    normalizeLiveExpiry(expiry),
    resolveIvSignalScanParameters(parameters),
  ] as const
}

export function useIvSignalScan({
  expiry,
  parameters,
  enabled = true,
}: UseIvSignalScanOptions) {
  const dataMode = getTerminalDataMode()
  const normalizedExpiry = normalizeLiveExpiry(expiry)
  const resolvedParameters = resolveIvSignalScanParameters(parameters)

  return useQuery<IvSignalScan>({
    queryKey: ivSignalScanQueryKey(normalizedExpiry, resolvedParameters),
    enabled: enabled && /^\d{4}-\d{2}-\d{2}$/.test(normalizedExpiry),
    queryFn: ({ signal }) => fetchIvSignalScan({
      expiry: normalizedExpiry,
      ...resolvedParameters,
      signal,
    }),
    placeholderData: undefined,
    // Deribit remains continuously streamed server-side. The UI samples the
    // computed surface on the server-recommended cadence.
    refetchInterval: dataMode === 'live'
      ? (query) => resolveIvSignalRefreshMs(query.state.data)
      : false,
    staleTime: (query) => dataMode === 'live'
      ? resolveIvSignalRefreshMs(query.state.data)
      : DEFAULT_IV_SIGNAL_REFRESH_MS,
    retry: 1,
  })
}
