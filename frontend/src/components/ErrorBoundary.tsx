import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
}

type State = {
  error: Error | null
}

/**
 * Catches render crashes so the terminal does not stay on a permanent black screen
 * after a bad HMR/runtime error. Provides a hard reload path.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Lotus] UI crash', error, info.componentStack)
  }

  private handleReload = () => {
    window.location.reload()
  }

  private handleRetry = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) {
      return this.props.children
    }

    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-[var(--terminal-bg,#0b0d10)] px-4 text-[var(--terminal-text,#e8eaed)]">
        <section className="w-full max-w-[480px] rounded border border-[var(--terminal-border,#2a3038)] bg-[var(--terminal-surface,#12161c)] px-6 py-5 shadow-2xl">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--terminal-muted,#8b939e)]">
            Lotus terminal
          </div>
          <h1 className="mb-2 text-[16px] font-semibold tracking-wide text-[var(--terminal-heading,#f3f5f7)]">
            UI recovered from a crash
          </h1>
          <p className="mb-3 text-[11px] leading-5 text-[var(--terminal-muted,#8b939e)]">
            A render error blanked the dashboard (often a stale hot-reload state). Reload to restore the full terminal.
          </p>
          <pre className="mb-4 max-h-[120px] overflow-auto rounded border border-[var(--terminal-rule,#1e242c)] bg-black/30 p-2 text-[10px] leading-4 text-[var(--terminal-red-strong,#ff6b7a)]">
            {error.message}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded border border-[var(--terminal-active-border,#3d4a58)] bg-[var(--terminal-active-bg,#1a222c)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-heading,#f3f5f7)]"
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded border border-[var(--terminal-border,#2a3038)] bg-transparent px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--terminal-muted,#8b939e)]"
            >
              Try re-render
            </button>
          </div>
        </section>
      </div>
    )
  }
}
