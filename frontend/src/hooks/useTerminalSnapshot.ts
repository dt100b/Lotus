import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { getTerminalSnapshot, type TerminalSnapshot } from '@/data/mockTerminal'
import type { GexExpiry } from '@/api/mockGexData'
import { getLiveTerminalSnapshot } from '@/api/liveTerminal'
import { useCallback } from 'react'

const dataMode = import.meta.env.VITE_LOTUS_DATA_MODE === 'mock' ? 'mock' : 'live'

export function terminalSnapshotQueryKey(expiry: GexExpiry) {
  return ['terminal-snapshot', dataMode, expiry] as const
}

async function fetchTerminalSnapshot(expiry: GexExpiry): Promise<TerminalSnapshot> {
  if (dataMode === 'mock') {
    return getTerminalSnapshot(expiry)
  }

  return getLiveTerminalSnapshot(expiry)
}

export function useTerminalSnapshot(expiry: GexExpiry) {
  return useQuery({
    queryKey: terminalSnapshotQueryKey(expiry),
    queryFn: () => fetchTerminalSnapshot(expiry),
    refetchInterval: dataMode === 'live' ? 30_000 : false,
    staleTime: dataMode === 'live' ? 10_000 : 60_000,
    // Keep the previous expiry's snapshot on screen while the next one loads —
    // prevents full-shell unmount / black flash on expiry switches.
    placeholderData: keepPreviousData,
    // Soft failures: prefer last good data over a hard error state when possible.
    retry: dataMode === 'live' ? 1 : 0,
  })
}

/** Warm the React Query cache for listed expiries (dropdown open / hover). */
export function usePrefetchTerminalSnapshots() {
  const queryClient = useQueryClient()

  return useCallback(
    (expiries: GexExpiry[]) => {
      for (const expiry of expiries) {
        void queryClient.prefetchQuery({
          queryKey: terminalSnapshotQueryKey(expiry),
          queryFn: () => fetchTerminalSnapshot(expiry),
          staleTime: dataMode === 'live' ? 10_000 : 60_000,
        })
      }
    },
    [queryClient],
  )
}

export function getTerminalDataMode(): 'mock' | 'live' {
  return dataMode
}
