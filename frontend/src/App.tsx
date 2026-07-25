import { useEffect } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { TerminalDashboard } from '@/components/terminal/TerminalDashboard'
import { useTerminalStore } from '@/store/terminalStore'

function App() {
  const theme = useTerminalStore((state) => state.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <ErrorBoundary>
      <main className="terminal-desk min-h-screen bg-[var(--terminal-bg)] text-[var(--desk-value,var(--terminal-text))]">
        <TerminalDashboard />
      </main>
    </ErrorBoundary>
  )
}

export default App
