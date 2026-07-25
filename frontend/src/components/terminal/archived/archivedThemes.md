# Archived terminal themes

**Archived:** 2026-07-25  
**Reason:** Settings cull — keep a tight set of desk themes that mesh with themed chart headers.

## Active (Settings)

Order in Settings (default first):

| ID | Label |
|----|--------|
| `graphite` | Graphite (default) |
| `ember` | Ember |
| `original` | Original |
| `paper` | Paper Lab |
| `command` | Command Deck |

## Archived (not in Settings)

| ID | Label | Notes |
|----|--------|--------|
| `daybreak` | Daybreak | Light green-red desk |
| `blueprint` | Blueprint Lab | Cyan grid / gold accent |
| `neon` | Neon Arcade | Magenta / cyan arcade |

## Restore

1. Re-add the theme object to `terminalThemes` in `frontend/src/data/terminalThemes.ts`
2. Remove it from `archivedTerminalThemes`
3. CSS blocks for archived themes remain in `frontend/src/index.css` as commented sections (or live `html[data-theme=…]` rules if still present)

## Chart header accent contract

Each active theme sets:

- `--chart-header-accent` — title + active segment fill
- `--chart-header-accent-soft` — lighter mix for fills
- `--chart-header-accent-ink` — text/icon on filled amber/green pills

Ember keeps the Bloomberg-style amber (`#d4a24a`) as the reference look.
