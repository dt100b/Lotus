export const defaultTerminalThemeId = 'graphite'

/**
 * Active terminal themes (Settings menu).
 * Archived: daybreak, blueprint, neon — see `archivedTerminalThemes` below
 * and CSS blocks retained in `index.css` for reference only.
 */
export const terminalThemes = [
  {
    id: 'graphite',
    label: 'Graphite',
    swatches: ['#07080b', '#66dfbd', '#ff7387'],
  },
  {
    id: 'ember',
    label: 'Ember',
    swatches: ['#090806', '#d4a24a', '#ff7166'],
  },
  {
    id: 'original',
    label: 'Original',
    swatches: ['#050606', '#94c970', '#ee5f66'],
  },
  {
    id: 'paper',
    label: 'Paper Lab',
    swatches: ['#f7f3e8', '#1f4f6d', '#c44a3d'],
  },
  {
    id: 'command',
    label: 'Command Deck',
    swatches: ['#020504', '#5cffbc', '#ff4f79'],
  },
] as const

/**
 * Archived themes — not shown in Settings.
 * CSS token blocks remain in index.css under comments for easy restore.
 */
export const archivedTerminalThemes = [
  {
    id: 'daybreak',
    label: 'Daybreak',
    swatches: ['#f2efe6', '#237a5d', '#b43f56'],
    archivedAt: '2026-07-25',
    reason: 'Settings cull — keep Original / Graphite / Ember / Paper Lab / Command Deck only',
  },
  {
    id: 'blueprint',
    label: 'Blueprint Lab',
    swatches: ['#071323', '#66dcff', '#f2c14e'],
    archivedAt: '2026-07-25',
    reason: 'Settings cull — keep Original / Graphite / Ember / Paper Lab / Command Deck only',
  },
  {
    id: 'neon',
    label: 'Neon Arcade',
    swatches: ['#05020b', '#21f7ff', '#ff3df2'],
    archivedAt: '2026-07-25',
    reason: 'Settings cull — keep Original / Graphite / Ember / Paper Lab / Command Deck only',
  },
] as const

export type TerminalThemeId = (typeof terminalThemes)[number]['id']

const terminalThemeIds = new Set<string>(terminalThemes.map((theme) => theme.id))
const terminalThemeStorageKey = 'lotus-terminal-theme'

export function isTerminalThemeId(value: string | null): value is TerminalThemeId {
  return value !== null && terminalThemeIds.has(value)
}

export function getStoredTerminalThemeId(): TerminalThemeId {
  if (typeof window === 'undefined') {
    return defaultTerminalThemeId
  }

  try {
    const storedTheme = window.localStorage.getItem(terminalThemeStorageKey)

    return isTerminalThemeId(storedTheme) ? storedTheme : defaultTerminalThemeId
  } catch {
    return defaultTerminalThemeId
  }
}

export function persistTerminalThemeId(theme: TerminalThemeId) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(terminalThemeStorageKey, theme)
  } catch {
    // Ignore storage errors so the theme control still works in-memory.
  }
}
