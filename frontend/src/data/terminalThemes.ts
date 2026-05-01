export const defaultTerminalThemeId = 'graphite'

export const terminalThemes = [
  {
    id: 'original',
    label: 'Original',
    swatches: ['#050606', '#94c970', '#ee5f66'],
  },
  {
    id: 'graphite',
    label: 'Graphite',
    swatches: ['#07080b', '#66dfbd', '#ff7387'],
  },
  {
    id: 'ember',
    label: 'Ember',
    swatches: ['#090806', '#70e4ce', '#ff7166'],
  },
  {
    id: 'daybreak',
    label: 'Daybreak',
    swatches: ['#f2efe6', '#237a5d', '#b43f56'],
  },
  {
    id: 'blueprint',
    label: 'Blueprint Lab',
    swatches: ['#071323', '#66dcff', '#f2c14e'],
  },
  {
    id: 'command',
    label: 'Command Deck',
    swatches: ['#020504', '#5cffbc', '#ff4f79'],
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
