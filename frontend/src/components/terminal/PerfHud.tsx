import { useFpsMeter } from '@/hooks/useFpsMeter'
import { isPerfEnabled } from '@/lib/perf'

/** Corner FPS HUD — only when perf mode is enabled. */
export function PerfHud() {
  const enabled = isPerfEnabled()
  const { active, fps, frameMs } = useFpsMeter(enabled)

  if (!active) return null

  const color =
    fps >= 55
      ? 'var(--terminal-green-strong)'
      : fps >= 40
        ? 'var(--terminal-heading)'
        : 'var(--terminal-red-strong)'

  return (
    <div
      className="pointer-events-none fixed bottom-2 left-2 z-[100] rounded border border-[var(--terminal-border)] bg-[var(--terminal-surface)]/90 px-2 py-1 font-mono text-[10px] tabular-nums shadow-lg backdrop-blur-sm"
      aria-hidden
    >
      <span style={{ color }}>{fps || '—'} fps</span>
      <span className="ml-2 text-[var(--terminal-muted)]">{frameMs.toFixed(1)} ms</span>
    </div>
  )
}
