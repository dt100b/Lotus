import { useEffect } from 'react'
import { TerminalDashboard } from '@/components/terminal/TerminalDashboard'
import { useTerminalStore } from '@/store/terminalStore'

function App() {
  const theme = useTerminalStore((state) => state.theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <main className="min-h-screen bg-[var(--terminal-bg)] text-[var(--terminal-text)]">
      <TerminalDashboard />
    </main>
  )
}

export default App
