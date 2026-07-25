# Archived: Profile chart mode

**Archived:** 2026-07-25  
**Reason:** Cull desk tab strip — Strike (net histogram) is the primary GEX-by-strike view. Continuous Baseline profile remains useful for a future re-enable but should not compete with Strike / Bands / Table.

## What was archived

| Mode id | Tab label | Chart |
|---------|-----------|--------|
| `profile` | Profile | `ProfileLwcChart` (BaselineSeries + light MA) in `GexProfileChart.tsx` |

## Active modes (tab selection)

| Mode id | Tab label |
|---------|-----------|
| `net` | Strike |
| `heatmap` | Bands |
| `table` | Table |

## Behavior while archived

- `gexModes` no longer includes `profile`.
- `normalizeExposureMode('profile')` → `'net'`.
- Existing workspaces / stores that still hold `mode: 'profile'` open as Strike.
- `ProfileLwcChart` + `applyProfileData` remain in `GexProfileChart.tsx` for a quick restore.

## Restore

1. Add `'profile'` back to `gexModes` and `chartRenderModes` in `gexModes.ts`.
2. Labels: `profile: 'Profile'` in `gexModeLabels`; short label `Prof` in `WorkspacePaneCell`.
3. Stop mapping `profile` → `net` in `normalizeExposureMode` (keep title helper).
4. Re-add seed cells in `paneModel.ts` if desired.
5. `GexProfileChart` already routes `mode === 'profile'` to `ProfileLwcChart`.
