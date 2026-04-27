import { useQuery } from '@tanstack/react-query'
import { getTerminalSnapshot } from '@/data/mockTerminal'
import type { GexExpiry } from '@/api/mockGexData'

export function useTerminalSnapshot(expiry: GexExpiry) {
  return useQuery({
    queryKey: ['terminal-snapshot', 'mock', expiry],
    queryFn: async () => getTerminalSnapshot(expiry),
  })
}
