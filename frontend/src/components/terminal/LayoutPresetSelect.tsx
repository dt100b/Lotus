import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export type LayoutPresetId =
  | '1x1'
  | '1x2'
  | '2x1'
  | '2x2'
  | '2x3'
  | '3x2'
  | '3x3'
  | '4x2'
  | '4x4'

export const layoutPresets: Array<{ id: LayoutPresetId; label: string; rows: number; cols: number }> = [
  { id: '1x1', label: '1×1', rows: 1, cols: 1 },
  { id: '1x2', label: '1×2', rows: 1, cols: 2 },
  { id: '2x1', label: '2×1', rows: 2, cols: 1 },
  { id: '2x2', label: '2×2', rows: 2, cols: 2 },
  { id: '2x3', label: '2×3', rows: 2, cols: 3 },
  { id: '3x2', label: '3×2', rows: 3, cols: 2 },
  { id: '3x3', label: '3×3', rows: 3, cols: 3 },
  { id: '4x2', label: '4×2', rows: 4, cols: 2 },
  { id: '4x4', label: '4×4', rows: 4, cols: 4 },
]

export const defaultLayoutPresetId: LayoutPresetId = '1x1'

type LayoutPresetSelectProps = {
  value: LayoutPresetId
  onValueChange: (value: LayoutPresetId) => void
}

/** Compact top-bar control — trigger shows a grid glyph, not "2×2" text. */
export function LayoutPresetSelect({ value, onValueChange }: LayoutPresetSelectProps) {
  const active = layoutPresets.find((p) => p.id === value) ?? layoutPresets[3]!

  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as LayoutPresetId)}>
      <SelectTrigger
        aria-label={`Workspace layout ${active.label}`}
        className="h-[26px] w-[36px] min-w-[36px] max-w-[36px] justify-center gap-0.5 px-1 [&_svg.lucide-chevron-down]:h-2.5 [&_svg.lucide-chevron-down]:w-2.5"
      >
        {/* Visual: grid glyph only. SelectValue kept for a11y / Radix, visually hidden. */}
        <LayoutGridGlyph rows={active.rows} cols={active.cols} size={11} />
        <span className="sr-only">
          <SelectValue placeholder={active.label} />
        </span>
      </SelectTrigger>
      <SelectContent className="min-w-[120px]">
        {layoutPresets.map((preset) => (
          <SelectItem
            key={preset.id}
            value={preset.id}
            className="py-1.5 pl-7 pr-2 text-[9px] font-semibold uppercase tracking-[0.08em] [&_svg]:h-3 [&_svg]:w-3"
          >
            <span className="flex items-center gap-2">
              <LayoutGridGlyph rows={preset.rows} cols={preset.cols} size={13} />
              <span className="text-[var(--terminal-muted)]">{preset.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Tiny rows×cols grid mark — reads as a layout icon, not a number. */
function LayoutGridGlyph({
  rows,
  cols,
  size = 11,
  className,
}: {
  rows: number
  cols: number
  size?: number
  className?: string
}) {
  // Keep visual mass stable as density grows (4×4 still fits the same box).
  const gap = rows >= 4 || cols >= 4 ? 0.75 : 1

  return (
    <span
      aria-hidden
      className={cn('inline-grid shrink-0 text-[var(--terminal-muted)]', className)}
      style={{
        width: size,
        height: size,
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gap,
      }}
    >
      {Array.from({ length: rows * cols }, (_, i) => (
        <span
          key={i}
          className="rounded-[0.5px] bg-current opacity-75"
        />
      ))}
    </span>
  )
}
